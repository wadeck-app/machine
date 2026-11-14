import { createHmac, timingSafeEqual } from 'node:crypto';
import tls from 'node:tls';
import type { SigningKeyPair } from '@wadeck-app/machine-core';
import { mintCertificate, publicKeyOfCertificate } from './cert.js';

// Peer channel: mutual TLS 1.3, each end pinned to an expected Ed25519 identity key (decision 47), then a proof that
// both ends know the pair secret, bound to this TLS session through the exporter so it cannot be relayed to another one.
// Frames: 4-byte big-endian length + UTF-8 JSON. This layer knows nothing about policy or registrations.

export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
export const DEFAULT_MAX_PENDING = 16;
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

const PROOF_VERSION = 1;
const PROOF_LABEL = 'EXPORTER-machine-pair-proof';
const PROOF_BYTES = 33;
const PAIR_SECRET_BYTES = 32;

type Role = 'client' | 'server';

function proofFor(socket: tls.TLSSocket, pairSecret: Buffer, role: Role): Buffer {
  const exported = socket.exportKeyingMaterial(32, PROOF_LABEL, Buffer.from(role));
  return Buffer.concat([Buffer.from([PROOF_VERSION]), createHmac('sha256', pairSecret).update(exported).digest()]);
}

function assertPairSecret(pairSecret: Buffer): void {
  if (pairSecret.length !== PAIR_SECRET_BYTES) {
    throw new Error(`pair secret must be ${PAIR_SECRET_BYTES} bytes, got ${pairSecret.length}: re-run the pairing from the admin console`);
  }
}

/** Sequential reader over a socket: wait for exactly n bytes, fail on close or error. */
class ByteStream {
  private buffer: Buffer = Buffer.alloc(0);
  private pending: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | undefined;
  private failure: Error | undefined;

  constructor(socket: tls.TLSSocket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.flush();
    });
    socket.on('close', () => this.fail(new Error('connection closed')));
    socket.on('error', (e) => this.fail(e));
  }

  take(n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (this.failure) return reject(this.failure);
      this.pending = { n, resolve, reject };
      this.flush();
    });
  }

  fail(error: Error): void {
    this.failure ??= error;
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(this.failure);
  }

  private flush(): void {
    const pending = this.pending;
    if (!pending || this.buffer.length < pending.n) return;
    this.pending = undefined;
    const out = this.buffer.subarray(0, pending.n);
    this.buffer = this.buffer.subarray(pending.n);
    pending.resolve(out);
  }
}

export interface PeerSession {
  /** Raw Ed25519 public key (base64url) the peer proved to own during the TLS handshake. */
  readonly peerPublicKey: string;
  /** Caller-supplied identifier of the peer (server side) or the public key (client side). */
  readonly peerId: string;
  send(message: unknown): void;
  /** Next received message. Rejects when the connection closes or the peer breaks the frame limit. */
  next(): Promise<unknown>;
  close(): void;
}

class Session implements PeerSession {
  private readonly queue: unknown[] = [];
  private readonly waiters: Array<{ resolve: (m: unknown) => void; reject: (e: Error) => void }> = [];
  private failure: Error | undefined;

  constructor(
    private readonly socket: tls.TLSSocket,
    private readonly stream: ByteStream,
    readonly peerPublicKey: string,
    readonly peerId: string,
    private readonly maxFrameBytes: number,
  ) {
    void this.readLoop();
  }

  send(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    if (body.length > this.maxFrameBytes) {
      throw new Error(`frame limit exceeded: ${body.length} bytes to send, limit is ${this.maxFrameBytes}`);
    }
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    this.socket.write(Buffer.concat([header, body]));
  }

  next(): Promise<unknown> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  close(): void {
    this.socket.destroy();
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.socket.destroy();
    for (const w of this.waiters.splice(0)) w.reject(this.failure);
  }

  private async readLoop(): Promise<void> {
    try {
      for (;;) {
        const header = await this.stream.take(4);
        const length = header.readUInt32BE(0);
        if (length > this.maxFrameBytes) {
          throw new Error(`frame limit exceeded: peer announced ${length} bytes, limit is ${this.maxFrameBytes}; connection dropped`);
        }
        const body = await this.stream.take(length);
        const message: unknown = JSON.parse(body.toString('utf8'));
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(message);
        else this.queue.push(message);
      }
    } catch (e) {
      this.fail(e instanceof Error ? e : new Error(String(e)));
    }
  }
}

function peerKeyOf(socket: tls.TLSSocket): string {
  const cert = socket.getPeerCertificate(true) as { raw?: Buffer } | undefined;
  if (!cert?.raw) throw new Error('peer sent no certificate');
  return publicKeyOfCertificate(cert.raw);
}

async function exchangeProofs(socket: tls.TLSSocket, stream: ByteStream, pairSecret: Buffer, role: Role): Promise<boolean> {
  const other: Role = role === 'client' ? 'server' : 'client';
  socket.write(proofFor(socket, pairSecret, role));
  const theirs = await stream.take(PROOF_BYTES);
  const expected = proofFor(socket, pairSecret, other);
  return theirs[0] === PROOF_VERSION && timingSafeEqual(theirs, expected);
}

export interface ListenOptions {
  identity: SigningKeyPair;
  host: string;
  port: number;
  /** Look the peer up by the key it presented. Return undefined for a key that is not registered. */
  resolvePeer: (peerPublicKey: string) => { peerId: string; pairSecret: Buffer } | undefined;
  onSession: (session: PeerSession) => void;
  /** Every refused connection is reported here with its cause: nothing is dropped silently. */
  onRejected: (reason: string) => void;
  maxPending?: number;
  handshakeTimeoutMs?: number;
  maxFrameBytes?: number;
}

export interface PeerListener {
  readonly port: number;
  close(): void;
}

export function listenForPeers(options: ListenOptions): Promise<PeerListener> {
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  const timeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const { certificatePem, privateKeyPem } = mintCertificate(options.identity);
  const server = tls.createServer({
    key: privateKeyPem,
    cert: certificatePem,
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
    requestCert: true,
    // Trust comes from pinning against registrations (checked below), not from a certificate authority.
    rejectUnauthorized: false,
  });
  // Connections that have not finished authenticating, keyed by remote endpoint: the raw socket and the TLS socket share it.
  const pending = new Map<string, { release: () => void }>();
  const keyOfSocket = (s: { remoteAddress?: string; remotePort?: number }) => `${s.remoteAddress ?? '?'}:${s.remotePort ?? '?'}`;

  server.on('connection', (raw) => {
    const key = keyOfSocket(raw);
    if (pending.size >= maxPending) {
      options.onRejected(`too many unauthenticated connections (limit ${maxPending}): dropped ${key}`);
      raw.destroy();
      return;
    }
    const timer = setTimeout(() => {
      options.onRejected(`authentication timed out after ${timeoutMs} ms: dropped ${key}`);
      raw.destroy();
    }, timeoutMs);
    const release = () => {
      clearTimeout(timer);
      pending.delete(key);
    };
    pending.set(key, { release });
    raw.on('close', release);
    raw.on('error', () => undefined);
  });

  server.on('tlsClientError', (e, socket) => {
    options.onRejected(`TLS handshake failed from ${keyOfSocket(socket)}: ${e.message}`);
  });

  server.on('secureConnection', (socket) => {
    const key = keyOfSocket(socket);
    const stream = new ByteStream(socket);
    socket.on('error', () => undefined);
    const reject = (reason: string) => {
      options.onRejected(`${reason} (from ${key})`);
      socket.destroy();
    };
    void (async () => {
      let peerPublicKey: string;
      try {
        peerPublicKey = peerKeyOf(socket);
      } catch (e) {
        return reject(`unusable peer certificate: ${(e as Error).message}`);
      }
      const peer = options.resolvePeer(peerPublicKey);
      if (!peer) return reject(`peer key ${peerPublicKey} is not registered on this machine`);
      try {
        assertPairSecret(peer.pairSecret);
        if (!(await exchangeProofs(socket, stream, peer.pairSecret, 'server'))) {
          return reject(`peer ${peer.peerId} failed the pair secret proof`);
        }
      } catch (e) {
        return reject(`peer ${peer.peerId} dropped during authentication: ${(e as Error).message}`);
      }
      pending.get(key)?.release();
      options.onSession(new Session(socket, stream, peerPublicKey, peer.peerId, maxFrameBytes));
    })();
  });

  return new Promise((resolve, reject) => {
    server.once('error', (e) =>
      reject(new Error(`cannot listen on ${options.host}:${options.port}: ${e.message}. Free the port or choose another one in the machine configuration`)),
    );
    server.listen(options.port, options.host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('listener has no TCP address'));
      resolve({ port: address.port, close: () => server.close() });
    });
  });
}

export interface ConnectOptions {
  identity: SigningKeyPair;
  host: string;
  port: number;
  /** Key from the admin-signed registration of the machine we mean to reach. Anything else is refused. */
  expectedPeerPublicKey: string;
  pairSecret: Buffer;
  handshakeTimeoutMs?: number;
  maxFrameBytes?: number;
}

export function connectToPeer(options: ConnectOptions): Promise<PeerSession> {
  assertPairSecret(options.pairSecret);
  const timeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const { certificatePem, privateKeyPem } = mintCertificate(options.identity);
  const where = `${options.host}:${options.port}`;

  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: options.host,
      port: options.port,
      key: privateKeyPem,
      cert: certificatePem,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      // Pinning replaces certificate authority validation, see the server side.
      rejectUnauthorized: false,
    });
    const stream = new ByteStream(socket);
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail(`no answer from ${where} within ${timeoutMs} ms: check that the peer machine is running and reachable`), timeoutMs);
    socket.on('error', (e) => fail(`cannot reach ${where}: ${e.message}`));

    socket.once('secureConnect', () => {
      void (async () => {
        let presented: string;
        try {
          presented = peerKeyOf(socket);
        } catch (e) {
          return fail(`${where} presented an unusable certificate: ${(e as Error).message}`);
        }
        if (presented !== options.expectedPeerPublicKey) {
          return fail(`${where} presented key ${presented} but the pinned registration says ${options.expectedPeerPublicKey}: refusing to talk to an unregistered machine`);
        }
        let ok: boolean;
        try {
          ok = await exchangeProofs(socket, stream, options.pairSecret, 'client');
        } catch (e) {
          return fail(`${where} closed the connection during authentication (${(e as Error).message}): this machine is probably not registered there or the pair secret differs; check the peer log`);
        }
        if (!ok) return fail(`${where} failed the pair secret proof: the pair secret differs, re-run the pairing from the admin console`);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(new Session(socket, stream, presented, presented, maxFrameBytes));
      })();
    });
  });
}
