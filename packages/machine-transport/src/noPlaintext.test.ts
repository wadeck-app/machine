import { randomBytes } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { generateSigningKeyPair } from '@wadeck-app/machine-core';
import { afterEach, describe, expect, it } from 'vitest';
import { mintCertificate } from './cert.js';
import { connectToPeer, listenForPeers, type PeerListener, type PeerSession } from './channel.js';

// Audit test (encryption-audit.md): nothing in clear is ever turned into a session, and nothing in clear is ever sent.
// Every client below is hand-driven (plain TCP, TLS 1.2, no client certificate) so that the real client cannot hide a difference.

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length > 0) closers.pop()?.();
});

const server = generateSigningKeyPair();
const registered = generateSigningKeyPair();
const secret = randomBytes(32);

interface Harness {
  listener: PeerListener;
  sessions: PeerSession[];
  rejections: string[];
}

async function start(): Promise<Harness> {
  const sessions: PeerSession[] = [];
  const rejections: string[] = [];
  const listener = await listenForPeers({
    identity: server,
    host: '127.0.0.1',
    port: 0,
    resolvePeer: (key) => (key === registered.publicKey ? { peerId: 'registered', pairSecret: secret } : undefined),
    onSession: (s) => {
      sessions.push(s);
      closers.push(() => s.close());
    },
    onRejected: (reason) => rejections.push(reason),
    handshakeTimeoutMs: 1500,
  });
  closers.push(() => listener.close());
  return { listener, sessions, rejections };
}

async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const frame = (body: string): Buffer => {
  const bytes = Buffer.from(body, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes]);
};

/** What the server sends back to a plain TCP client, until it closes the connection or `waitMs` passes. */
function plainExchange(port: number, send: Buffer | undefined, waitMs: number): Promise<{ received: Buffer; closed: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let closed = false;
    const socket = net.connect(port, '127.0.0.1', () => {
      if (send) socket.write(send);
    });
    closers.push(() => socket.destroy());
    socket.on('error', () => undefined);
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('close', () => {
      closed = true;
    });
    setTimeout(() => resolve({ received: Buffer.concat(chunks), closed }), waitMs);
  });
}

describe('the peer listener accepts nothing in clear', () => {
  it('a plain TCP client sending a well-formed machine frame (a run request) gets no session and no machine reply', async () => {
    const h = await start();
    const request = frame(JSON.stringify({ type: 'run', request: { body: { shell: 'cmd', command: 'whoami' } } }));
    const { received } = await plainExchange(h.listener.port, request, 600);
    expect(h.sessions).toHaveLength(0);
    // Whatever came back is not a machine frame: a TLS alert record starts with 0x15, never with a 4-byte length plus JSON.
    expect(received.toString('utf8')).not.toContain('"type"');
    await until(() => h.rejections.some((r) => /TLS handshake failed/.test(r)), 'handshake failure report');
  });

  it('a plain HTTP request gets no session and no HTTP answer', async () => {
    const h = await start();
    const { received } = await plainExchange(h.listener.port, Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n'), 600);
    expect(h.sessions).toHaveLength(0);
    expect(received.toString('latin1')).not.toMatch(/HTTP\/1/);
    await until(() => h.rejections.length >= 1, 'a refusal report');
  });

  it('a plain TCP client that sends nothing receives nothing (the listener never speaks first)', async () => {
    const h = await start();
    const { received } = await plainExchange(h.listener.port, undefined, 400);
    expect(received.length).toBe(0);
    expect(h.sessions).toHaveLength(0);
  });

  it('a TLS 1.2 client is refused at the handshake (no downgrade), with the cause reported', async () => {
    const h = await start();
    const { certificatePem, privateKeyPem } = mintCertificate(registered);
    const socket = tls.connect({ host: '127.0.0.1', port: h.listener.port, key: privateKeyPem, cert: certificatePem, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', rejectUnauthorized: false });
    closers.push(() => socket.destroy());
    const outcome = await new Promise<string>((resolve) => {
      socket.once('secureConnect', () => resolve('connected'));
      socket.once('error', () => resolve('failed'));
      socket.once('close', () => resolve('failed'));
    });
    expect(outcome).toBe('failed');
    expect(h.sessions).toHaveLength(0);
    await until(() => h.rejections.some((r) => /TLS handshake failed/.test(r)), 'handshake failure report');
  });

  it('a TLS 1.3 client without any certificate gets no session', async () => {
    const h = await start();
    const socket = tls.connect({ host: '127.0.0.1', port: h.listener.port, minVersion: 'TLSv1.3', rejectUnauthorized: false });
    socket.on('error', () => undefined);
    socket.on('data', () => undefined);
    closers.push(() => socket.destroy());
    const closed = new Promise<boolean>((resolve) => {
      socket.once('close', () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });
    expect(await closed).toBe(true);
    expect(h.sessions).toHaveLength(0);
    await until(() => h.rejections.some((r) => /certificate/.test(r)), 'certificate refusal report');
  });

  it('a TLS 1.3 client with a REGISTERED key but no pair secret proof gets no session, even when it sends a machine frame', async () => {
    const h = await start();
    const { certificatePem, privateKeyPem } = mintCertificate(registered);
    const socket = tls.connect({ host: '127.0.0.1', port: h.listener.port, key: privateKeyPem, cert: certificatePem, minVersion: 'TLSv1.3', rejectUnauthorized: false });
    socket.on('error', () => undefined);
    socket.on('data', () => undefined);
    closers.push(() => socket.destroy());
    await new Promise((r) => socket.once('secureConnect', r));
    // 33 bytes or more where the proof is expected: a frame, not a proof.
    socket.write(frame(JSON.stringify({ type: 'run', request: { body: { shell: 'cmd', command: 'whoami' } } })));
    await until(() => h.rejections.some((r) => /pair secret proof/.test(r)), 'proof refusal report');
    expect(h.sessions).toHaveLength(0);
  });
});

describe('the peer client sends nothing in clear', () => {
  it('towards a plain TCP server: the first bytes are a TLS 1.3 ClientHello record, no frame, no secret', async () => {
    const seen: Buffer[] = [];
    const plain = net.createServer((socket) => {
      socket.on('error', () => undefined);
      socket.on('data', (c: Buffer) => seen.push(c));
    });
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve));
    closers.push(() => plain.close());
    const port = (plain.address() as net.AddressInfo).port;
    await expect(
      connectToPeer({ identity: registered, host: '127.0.0.1', port, expectedPeerPublicKey: server.publicKey, pairSecret: secret, handshakeTimeoutMs: 500 }),
    ).rejects.toThrow();
    const bytes = Buffer.concat(seen);
    // TLS record: handshake (0x16), legacy version 0x03 0x01 or 0x03 0x03, then a ClientHello (0x01).
    expect(bytes[0]).toBe(0x16);
    expect(bytes[1]).toBe(0x03);
    expect(bytes[5]).toBe(0x01);
    expect(bytes.includes(secret)).toBe(false);
    expect(bytes.toString('latin1')).not.toContain('"type"');
  });

  it('towards a TLS 1.2-only server: refused, never a retry in a weaker version', async () => {
    const { certificatePem, privateKeyPem } = mintCertificate(server);
    const old = tls.createServer({ key: privateKeyPem, cert: certificatePem, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', requestCert: true, rejectUnauthorized: false }, (s) => s.on('error', () => undefined));
    old.on('tlsClientError', () => undefined);
    await new Promise<void>((resolve) => old.listen(0, '127.0.0.1', resolve));
    closers.push(() => old.close());
    const port = (old.address() as net.AddressInfo).port;
    await expect(
      connectToPeer({ identity: registered, host: '127.0.0.1', port, expectedPeerPublicKey: server.publicKey, pairSecret: secret, handshakeTimeoutMs: 1500 }),
    ).rejects.toThrow();
  });
});
