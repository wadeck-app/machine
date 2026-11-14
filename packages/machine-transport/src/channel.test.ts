import { randomBytes } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { createHmac } from 'node:crypto';
import { mintCertificate } from './cert.js';
import { generateSigningKeyPair, type SigningKeyPair } from '@wadeck-app/machine-core';
import { afterEach, describe, expect, it } from 'vitest';
import { connectToPeer, listenForPeers, type PeerListener, type PeerSession } from './channel.js';

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length > 0) closers.pop()?.();
});

interface Harness {
  server: SigningKeyPair;
  client: SigningKeyPair;
  secret: Buffer;
  listener: PeerListener;
  sessions: PeerSession[];
  rejections: string[];
}

async function start(
  options: {
    serverSecret?: Buffer;
    knownClient?: boolean;
    maxPending?: number;
    handshakeTimeoutMs?: number;
    maxFrameBytes?: number;
    resolveThrowsOnce?: boolean;
  } = {},
): Promise<Harness> {
  let thrown = false;
  const server = generateSigningKeyPair();
  const client = generateSigningKeyPair();
  const secret = randomBytes(32);
  const sessions: PeerSession[] = [];
  const rejections: string[] = [];
  const listener = await listenForPeers({
    identity: server,
    host: '127.0.0.1',
    port: 0,
    resolvePeer: (publicKey) => {
      if (options.resolveThrowsOnce && !thrown) {
        thrown = true;
        throw new Error('registry unreadable');
      }
      return options.knownClient === false || publicKey !== client.publicKey ? undefined : { peerId: 'client-1', pairSecret: options.serverSecret ?? secret };
    },
    onSession: (session) => {
      sessions.push(session);
      closers.push(() => session.close());
    },
    onRejected: (reason) => rejections.push(reason),
    ...(options.maxPending !== undefined ? { maxPending: options.maxPending } : {}),
    ...(options.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: options.handshakeTimeoutMs } : {}),
    ...(options.maxFrameBytes !== undefined ? { maxFrameBytes: options.maxFrameBytes } : {}),
  });
  closers.push(() => listener.close());
  return { server, client, secret, listener, sessions, rejections };
}

function connect(h: Harness, overrides: { expectedPeerPublicKey?: string; pairSecret?: Buffer; maxFrameBytes?: number } = {}): Promise<PeerSession> {
  return connectToPeer({
    identity: h.client,
    host: '127.0.0.1',
    port: h.listener.port,
    expectedPeerPublicKey: overrides.expectedPeerPublicKey ?? h.server.publicKey,
    pairSecret: overrides.pairSecret ?? h.secret,
    ...(overrides.maxFrameBytes !== undefined ? { maxFrameBytes: overrides.maxFrameBytes } : {}),
  });
}

// A hand-driven peer, to send what the real client never would.
async function rawClient(h: Harness): Promise<tls.TLSSocket> {
  const { certificatePem, privateKeyPem } = mintCertificate(h.client);
  const socket = tls.connect({ host: '127.0.0.1', port: h.listener.port, key: privateKeyPem, cert: certificatePem, minVersion: 'TLSv1.3', rejectUnauthorized: false });
  socket.on('error', () => undefined);
  socket.on('data', () => undefined);
  closers.push(() => socket.destroy());
  await new Promise((r) => socket.once('secureConnect', r));
  return socket;
}

function sendProof(socket: tls.TLSSocket, secret: Buffer): void {
  const exported = socket.exportKeyingMaterial(32, 'EXPORTER-machine-pair-proof', Buffer.from('client'));
  socket.write(Buffer.concat([Buffer.from([1]), createHmac('sha256', secret).update(exported).digest()]));
}

function frame(body: Buffer, declared = body.length): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(declared);
  return Buffer.concat([header, body]);
}

async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('peer channel', () => {
  it('connects, identifies both ends by key and exchanges messages both ways', async () => {
    const h = await start();
    const client = await connect(h);
    closers.push(() => client.close());
    await until(() => h.sessions.length === 1, 'server session');
    const serverSide = h.sessions[0] as PeerSession;
    expect(client.peerPublicKey).toBe(h.server.publicKey);
    expect(serverSide.peerPublicKey).toBe(h.client.publicKey);
    expect(serverSide.peerId).toBe('client-1');
    client.send({ kind: 'ping', n: 1 });
    expect(await serverSide.next()).toEqual({ kind: 'ping', n: 1 });
    serverSide.send({ kind: 'pong' });
    expect(await client.next()).toEqual({ kind: 'pong' });
  });

  it('refuses a server whose key is not the pinned one, naming both keys', async () => {
    const h = await start();
    const other = generateSigningKeyPair();
    await expect(connect(h, { expectedPeerPublicKey: other.publicKey })).rejects.toThrow(/pinned/);
    expect(h.sessions).toHaveLength(0);
  });

  it('refuses a client whose key is not registered, and tells the server why', async () => {
    const h = await start({ knownClient: false });
    await expect(connect(h)).rejects.toThrow(/closed|rejected/);
    await until(() => h.rejections.length === 1, 'rejection report');
    expect(h.rejections[0]).toMatch(/not registered/);
    expect(h.sessions).toHaveLength(0);
  });

  it('refuses a peer that does not know the pair secret', async () => {
    const h = await start({ serverSecret: randomBytes(32) });
    await expect(connect(h)).rejects.toThrow(/pair secret/);
    await until(() => h.rejections.length === 1, 'rejection report');
    expect(h.rejections[0]).toMatch(/pair secret/);
    expect(h.sessions).toHaveLength(0);
  });

  it('closes the session when a frame exceeds the size limit', async () => {
    const h = await start({ maxFrameBytes: 1024 });
    const client = await connect(h, { maxFrameBytes: 1024 * 1024 });
    closers.push(() => client.close());
    await until(() => h.sessions.length === 1, 'server session');
    const serverSide = h.sessions[0] as PeerSession;
    client.send({ blob: 'x'.repeat(4096) });
    await expect(serverSide.next()).rejects.toThrow(/frame limit/);
  });

  it('refuses to send a frame above its own limit', async () => {
    const h = await start();
    const client = await connect(h, { maxFrameBytes: 256 });
    closers.push(() => client.close());
    expect(() => client.send({ blob: 'x'.repeat(1000) })).toThrow(/frame limit/);
  });

  it('drops connections beyond the pre-authentication cap', async () => {
    const h = await start({ maxPending: 2, handshakeTimeoutMs: 30_000 });
    const idle: net.Socket[] = [];
    for (let i = 0; i < 2; i++) {
      const s = net.connect(h.listener.port, '127.0.0.1');
      s.on('error', () => undefined);
      idle.push(s);
      closers.push(() => s.destroy());
    }
    await new Promise((r) => setTimeout(r, 100));
    const third = net.connect(h.listener.port, '127.0.0.1');
    third.on('error', () => undefined);
    closers.push(() => third.destroy());
    const closed = await new Promise<boolean>((resolve) => {
      third.on('close', () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });
    expect(closed).toBe(true);
    await until(() => h.rejections.some((r) => /too many/.test(r)), 'cap report');
  });

  it('drops a connection that does not finish authenticating in time', async () => {
    const h = await start({ handshakeTimeoutMs: 200 });
    const idle = net.connect(h.listener.port, '127.0.0.1');
    idle.on('error', () => undefined);
    closers.push(() => idle.destroy());
    const closed = await new Promise<boolean>((resolve) => {
      idle.on('close', () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });
    expect(closed).toBe(true);
    await until(() => h.rejections.some((r) => /timed out/.test(r)), 'timeout report');
  });

  it('survives a registry lookup that throws, reports it and keeps serving', async () => {
    const h = await start({ resolveThrowsOnce: true });
    await expect(connect(h)).rejects.toThrow();
    await until(() => h.rejections.length === 1, 'rejection report');
    expect(h.rejections[0]).toMatch(/internal error.*registry unreadable/);
    const client = await connect(h);
    closers.push(() => client.close());
    await until(() => h.sessions.length === 1, 'server session after the failed lookup');
  });

  it('drops a peer that floods bytes before authenticating', async () => {
    const h = await start();
    const socket = await rawClient(h);
    const closed = new Promise<boolean>((resolve) => {
      socket.on('close', () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });
    socket.write(Buffer.alloc(200_000));
    expect(await closed).toBe(true);
    await until(() => h.rejections.some((r) => /more than/.test(r)), 'flood report');
  });

  it('refuses an empty frame with a message naming the framing', async () => {
    const h = await start();
    const socket = await rawClient(h);
    sendProof(socket, h.secret);
    await until(() => h.sessions.length === 1, 'server session');
    socket.write(frame(Buffer.alloc(0)));
    await expect((h.sessions[0] as PeerSession).next()).rejects.toThrow(/empty frame/);
  });

  it('refuses a frame that is not JSON with a message naming the cause', async () => {
    const h = await start();
    const socket = await rawClient(h);
    sendProof(socket, h.secret);
    await until(() => h.sessions.length === 1, 'server session');
    socket.write(frame(Buffer.from('abc')));
    await expect((h.sessions[0] as PeerSession).next()).rejects.toThrow(/not valid JSON/);
  });

  it('still delivers a frame the peer sent right before closing', async () => {
    const h = await start();
    const socket = await rawClient(h);
    sendProof(socket, h.secret);
    await until(() => h.sessions.length === 1, 'server session');
    socket.end(frame(Buffer.from('{"last":true}')));
    expect(await (h.sessions[0] as PeerSession).next()).toEqual({ last: true });
  });

  // The revocation hello travels as the first application frame, possibly in the same flight as the proof: it must neither be lost nor count against the 1 KiB pre-authentication buffer.
  it('delivers a first frame that arrives in the same write as the proof, and frames above the pre-auth 1 KiB once authenticated', async () => {
    const h = await start();
    const socket = await rawClient(h);
    const exported = socket.exportKeyingMaterial(32, 'EXPORTER-machine-pair-proof', Buffer.from('client'));
    const proof = Buffer.concat([Buffer.from([1]), createHmac('sha256', h.secret).update(exported).digest()]);
    socket.write(Buffer.concat([proof, frame(Buffer.from('{"type":"hello"}'))]));
    await until(() => h.sessions.length === 1, 'server session');
    expect(await (h.sessions[0] as PeerSession).next()).toEqual({ type: 'hello' });

    const h2 = await start();
    const socket2 = await rawClient(h2);
    sendProof(socket2, h2.secret);
    await until(() => h2.sessions.length === 1, 'server session');
    socket2.write(frame(Buffer.from(`{"pad":"${'x'.repeat(4000)}"}`)));
    expect(await (h2.sessions[0] as PeerSession).next()).toMatchObject({ pad: expect.any(String) });
  });

  it('closing the listener also ends live sessions', async () => {
    const h = await start();
    const client = await connect(h);
    closers.push(() => client.close());
    await until(() => h.sessions.length === 1, 'server session');
    h.listener.close();
    await expect((h.sessions[0] as PeerSession).next()).rejects.toThrow();
    await expect(client.next()).rejects.toThrow();
  });

  it('frees a pre-authentication slot once the connection is gone', async () => {
    const h = await start({ maxPending: 1, handshakeTimeoutMs: 200 });
    const first = net.connect(h.listener.port, '127.0.0.1');
    first.on('error', () => undefined);
    await new Promise((r) => first.on('close', r));
    const client = await connect(h);
    closers.push(() => client.close());
    await until(() => h.sessions.length === 1, 'server session after slot freed');
  });
});
