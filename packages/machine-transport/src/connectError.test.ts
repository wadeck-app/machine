import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { generateSigningKeyPair } from '@wadeck-app/machine-core';
import { afterEach, describe, expect, it } from 'vitest';
import { classifySocketError, connectToPeer, ConnectError, listenForPeers, type PeerListener } from './channel.js';

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length > 0) closers.pop()?.();
});

const server = generateSigningKeyPair();
const client = generateSigningKeyPair();
const secret = randomBytes(32);

async function listener(resolvePeer: (key: string) => { peerId: string; pairSecret: Buffer } | undefined): Promise<PeerListener> {
  const l = await listenForPeers({ identity: server, host: '127.0.0.1', port: 0, resolvePeer, onSession: (s) => closers.push(() => s.close()), onRejected: () => undefined });
  closers.push(() => l.close());
  return l;
}

const attempt = (port: number, over: { expected?: string; pairSecret?: Buffer; timeoutMs?: number } = {}) =>
  connectToPeer({ identity: client, host: '127.0.0.1', port, expectedPeerPublicKey: over.expected ?? server.publicKey, pairSecret: over.pairSecret ?? secret, handshakeTimeoutMs: over.timeoutMs ?? 2000 });

async function failureOf(promise: Promise<unknown>): Promise<ConnectError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(ConnectError);
    return e as ConnectError;
  }
  throw new Error('the connection was expected to fail');
}

describe('typed connection failures (a wake must never fire on an authentication failure)', () => {
  it('nothing listens: unreachable, with the system code, same message as before', async () => {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const e = await failureOf(attempt(port));
    expect(e.kind).toBe('unreachable');
    expect(e.code).toBe('ECONNREFUSED');
    expect(e.message).toMatch(/^cannot reach 127\.0\.0\.1:\d+: /);
  });

  it('a host that accepts and never answers: timeout', async () => {
    const mute = net.createServer((socket) => {
      socket.on('error', () => undefined);
      closers.push(() => socket.destroy());
    });
    await new Promise<void>((resolve) => mute.listen(0, '127.0.0.1', resolve));
    closers.push(() => mute.close());
    const e = await failureOf(attempt((mute.address() as net.AddressInfo).port, { timeoutMs: 200 }));
    expect(e.kind).toBe('timeout');
    expect(e.message).toMatch(/no answer from .* within 200 ms/);
  });

  it('another key answers: pin-mismatch', async () => {
    const l = await listener(() => undefined);
    const e = await failureOf(attempt(l.port, { expected: generateSigningKeyPair().publicKey }));
    expect(e.kind).toBe('pin-mismatch');
    expect(e.message).toMatch(/pinned/);
  });

  it('this machine is not registered there: auth-closed', async () => {
    const l = await listener(() => undefined);
    const e = await failureOf(attempt(l.port));
    expect(e.kind).toBe('auth-closed');
  });

  it('the pair secret differs: an authentication kind, never unreachable', async () => {
    const l = await listener((key) => (key === client.publicKey ? { peerId: 'c', pairSecret: randomBytes(32) } : undefined));
    const e = await failureOf(attempt(l.port));
    expect(['auth-closed', 'pair-proof']).toContain(e.kind);
    expect(e.message).toMatch(/pair secret/);
  });

  it('something that is not the machine channel answers: protocol', async () => {
    const plain = net.createServer((socket) => {
      socket.on('error', () => undefined);
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve));
    closers.push(() => plain.close());
    const e = await failureOf(attempt((plain.address() as net.AddressInfo).port));
    expect(e.kind).toBe('protocol');
  });
});

describe('classifySocketError', () => {
  it.each([
    ['ECONNREFUSED', 'unreachable'],
    ['EHOSTUNREACH', 'unreachable'],
    ['ENETUNREACH', 'unreachable'],
    ['ENETDOWN', 'unreachable'],
    ['EADDRNOTAVAIL', 'unreachable'],
    ['ETIMEDOUT', 'timeout'],
    ['ENOTFOUND', 'unresolved'],
    ['EAI_AGAIN', 'unresolved'],
    ['ECONNRESET', 'protocol'],
    ['EPROTO', 'protocol'],
    ['ERR_SSL_WRONG_VERSION_NUMBER', 'protocol'],
    [undefined, 'unknown'],
    ['EWHATEVER', 'unknown'],
  ])('%s -> %s', (code, kind) => {
    expect(classifySocketError(code)).toBe(kind);
  });
});
