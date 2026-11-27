import { randomBytes, randomUUID } from 'node:crypto';
import {
  applyPolicy,
  applyRevocation,
  generateSigningKeyPair,
  isRevoked,
  keyId,
  revocationDigest,
  signPolicy,
  signRevocation,
  type Json,
  type PolicyBody,
  type RevocationEntry,
  type SignedRevocation,
} from '@wadeck-app/machine-core';
import { connectToPeer, type PeerSession } from '@wadeck-app/machine-transport';
import { afterEach, describe, expect, it } from 'vitest';
import { startPeerListener, runOnPeer, type PeerServiceDeps, type ServicedPeerListener } from './peerService.js';
import { catchUpRevocations, type RevocationSyncDeps } from './revocationSync.js';

const A = '1b4e28ba-2fa1-4d3b-a3f4-0123456789ab';
const B = '9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345';
const X = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const Y = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';
const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';
const NOW = 1_800_000_000;

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length > 0) closers.pop()?.();
});

/** In-memory twin of the file based revocation state of network.ts: verify, merge grow-only, keep every distinct signed list. */
class MemoryRevocations implements RevocationSyncDeps {
  entries: RevocationEntry[] = [];
  lists: SignedRevocation[] = [];
  installs: SignedRevocation[] = [];
  stateError: Error | undefined;
  readonly seenVersions: Array<{ peer: string; version: number; digest: string }> = [];
  constructor(private readonly adminPublicKey: string) {}
  state() {
    if (this.stateError) throw this.stateError;
    return { digest: revocationDigest(this.entries), version: Math.max(0, ...this.lists.map((l) => l.body.issuedAt)), lists: this.lists };
  }
  install(signed: SignedRevocation) {
    const applied = applyRevocation(this.entries, signed, { adminPublicKey: this.adminPublicKey });
    if (!applied.ok) throw new Error(`revocation refused (${applied.reason}): ${applied.message}`);
    this.entries = applied.entries;
    if (!this.lists.some((l) => l.signature === signed.signature)) this.lists = [...this.lists, signed];
    this.installs.push(signed);
    return { changed: applied.changed };
  }
  seen(peerUuid: string, announced: { version: number; digest: string }) {
    this.seenVersions.push({ peer: peerUuid, ...announced });
  }
}

class MemoryAudit {
  readonly entries: Array<Record<string, Json>> = [];
  write(entry: Record<string, Json>): void {
    this.entries.push(entry);
  }
  events(): string[] {
    return this.entries.map((e) => String(e.event));
  }
}

interface World {
  admin: ReturnType<typeof generateSigningKeyPair>;
  a: ReturnType<typeof generateSigningKeyPair>;
  server: MemoryRevocations;
  client: MemoryRevocations;
  audit: MemoryAudit;
  problems: string[];
  clock: { value: number };
  listener: ServicedPeerListener;
  sign: (entries: RevocationEntry[], issuedAt: number, key?: ReturnType<typeof generateSigningKeyPair>) => SignedRevocation;
  connect: (maxFrameBytes?: number) => Promise<PeerSession>;
  catchUp: (session: PeerSession) => ReturnType<typeof catchUpRevocations>;
  ranCommands: string[];
}

async function world(over: { maxFrameBytes?: number; noRevocation?: boolean } = {}): Promise<World> {
  const admin = generateSigningKeyPair();
  const a = generateSigningKeyPair();
  const b = generateSigningKeyPair();
  const secret = randomBytes(32);
  const server = new MemoryRevocations(admin.publicKey);
  const client = new MemoryRevocations(admin.publicKey);
  const audit = new MemoryAudit();
  const problems: string[] = [];
  const ranCommands: string[] = [];
  const clock = { value: NOW };
  const policyBody: PolicyBody = {
    v: 1,
    target: B,
    version: 1,
    baseVersion: 0,
    adminKeyId: keyId(admin.publicKey),
    issuedAt: NOW,
    notBefore: NOW - 10,
    notAfter: NOW + 100_000,
    defaults: [{ shell: SHELL, command: 'echo hello' }],
    peers: {},
  };
  const applied = applyPolicy({ version: 0, highestSeen: 0 }, signPolicy(policyBody, admin.privateKeyPkcs8), { adminPublicKey: admin.publicKey, now: NOW, targetUuid: B });
  if (!applied.ok) throw new Error(applied.message);
  const serverLookup = (key: string) => (key === a.publicKey && !isRevoked(server.entries, A, 1) ? { peerId: A, name: 'a', pairSecret: secret } : undefined);
  const deps: PeerServiceDeps = {
    self: { uuid: B, name: 'b', createdAt: '', identity: b },
    directory: { lookup: serverLookup as PeerServiceDeps['directory']['lookup'] },
    policy: () => applied.body,
    usage: { count: () => 0, record: () => undefined },
    audit,
    now: () => clock.value,
    run: async (o) => {
      ranCommands.push(o.command);
      return { exitCode: 0, stdout: 'out', stderr: '', timedOut: false, truncated: false, outputNotUtf8: false, durationMs: 1 };
    },
    onProblem: (m) => problems.push(m),
    ...(over.noRevocation ? {} : { revocation: server }),
    ...(over.maxFrameBytes !== undefined ? { maxFrameBytes: over.maxFrameBytes } : {}),
  };
  const listener = await startPeerListener(deps, { host: '127.0.0.1', port: 0 });
  closers.push(() => listener.close());
  return {
    admin,
    a,
    server,
    client,
    audit,
    problems,
    clock,
    listener,
    ranCommands,
    sign: (entries, issuedAt, key = admin) => signRevocation({ v: 1, adminKeyId: keyId(key.publicKey), issuedAt, entries: [...entries].sort((p, q) => (p.uuid < q.uuid ? -1 : 1)) }, key.privateKeyPkcs8),
    connect: async (maxFrameBytes) => {
      const s = await connectToPeer({ identity: a, host: '127.0.0.1', port: listener.port, expectedPeerPublicKey: b.publicKey, pairSecret: secret, ...(maxFrameBytes !== undefined ? { maxFrameBytes } : {}) });
      closers.push(() => s.close());
      return s;
    },
    catchUp: (session) => catchUpRevocations(session, { state: () => client.state(), install: (s) => client.install(s), seen: (p, v) => client.seen(p, v), peerId: B, peerLabel: 'b', peerTrusted: () => !isRevoked(client.entries, B, 1) }),
  };
}

function hello(state: { digest: string; version: number }) {
  return { type: 'hello', revocationDigest: state.digest, revocationVersion: state.version };
}

async function run(w: World, session: PeerSession, command = 'echo hello') {
  return runOnPeer(session, { identity: w.a, source: A, target: B, shell: SHELL as 'cmd', command, now: NOW });
}

const manyEntries = () => Array.from({ length: 12 }, () => ({ uuid: randomUUID(), serial: 1 }));

describe('revocation catch-up, server side (raw frames)', () => {
  it('answers a hello with its digest and version and, when the digests differ, sends ALL its signed lists next', async () => {
    const w = await world();
    const l1 = w.sign([{ uuid: X, serial: 5 }], NOW);
    const l2 = w.sign([{ uuid: Y, serial: 1 }], NOW + 5);
    w.server.install(l1);
    w.server.install(l2);
    const s = await w.connect();
    s.send(hello(w.client.state()));
    expect(await s.next()).toEqual({ type: 'hello', revocationDigest: w.server.state().digest, revocationVersion: NOW + 5, revocationsFollow: true });
    expect(await s.next()).toEqual({ type: 'revocations', lists: [l1, l2] });
  });

  it('sends no list when the digests are equal, and keeps the session for requests', async () => {
    const w = await world();
    const list = w.sign([{ uuid: X, serial: 5 }], NOW);
    w.server.install(list);
    w.client.install(list);
    const s = await w.connect();
    s.send(hello(w.client.state()));
    expect(await s.next()).toMatchObject({ type: 'hello', revocationsFollow: false });
    expect(await run(w, s)).toMatchObject({ type: 'result' });
    expect(w.audit.events()).toEqual(['accepted', 'completed']);
  });

  it('sends its lists even when the peer announces a HIGHER version, as long as the digests differ (the version does not decide)', async () => {
    const w = await world();
    w.server.install(w.sign([{ uuid: X, serial: 5 }], NOW));
    const s = await w.connect();
    s.send({ type: 'hello', revocationDigest: 'f'.repeat(64), revocationVersion: NOW + 9999 });
    expect(await s.next()).toMatchObject({ type: 'hello', revocationsFollow: true });
    expect(await s.next()).toMatchObject({ type: 'revocations' });
  });

  it('records the version and the digest the peer announced', async () => {
    const w = await world();
    const s = await w.connect();
    s.send({ type: 'hello', revocationDigest: 'f'.repeat(64), revocationVersion: 1234 });
    await s.next();
    expect(w.server.seenVersions).toEqual([{ peer: A, version: 1234, digest: 'f'.repeat(64) }]);
  });

  it('installs the lists of the peer BEFORE the request that follows and audits ONE summary line', async () => {
    const w = await world();
    const l1 = w.sign([{ uuid: X, serial: 5 }], NOW + 50);
    const l2 = w.sign([{ uuid: Y, serial: 2 }], NOW + 51);
    w.client.install(l1);
    w.client.install(l2);
    const s = await w.connect();
    s.send(hello(w.client.state()));
    await s.next();
    s.send({ type: 'revocations', lists: [l1, l2] });
    expect(await run(w, s)).toMatchObject({ type: 'result' });
    expect(w.server.entries).toHaveLength(2);
    expect(w.audit.events()).toEqual(['revocation-catchup', 'accepted', 'completed']);
    expect(w.audit.entries[0]).toMatchObject({ source: A, lists: 2, accepted: 2, refused: 0, changed: true });
  });

  it('drops a list signed by another key, audits it, installs nothing and keeps the session (the peer itself is not revoked)', async () => {
    const w = await world();
    const forged = w.sign([{ uuid: X, serial: 5 }], NOW + 50, generateSigningKeyPair());
    const s = await w.connect();
    s.send(hello(w.client.state()));
    await s.next();
    s.send({ type: 'revocations', lists: [forged] });
    expect(await run(w, s)).toMatchObject({ type: 'result' });
    expect(w.server.entries).toEqual([]);
    expect(w.audit.events()).toEqual(['revocation-catchup-refused', 'accepted', 'completed']);
    expect(String(w.audit.entries[0]?.message)).toMatch(/certified by admin key|wrong-admin-key/);
  });

  it('keeps the valid list of a frame that also carries a forged one', async () => {
    const w = await world();
    const good = w.sign([{ uuid: X, serial: 5 }], NOW + 50);
    const forged = w.sign([{ uuid: Y, serial: 5 }], NOW + 51, generateSigningKeyPair());
    const s = await w.connect();
    s.send(hello(w.client.state()));
    await s.next();
    s.send({ type: 'revocations', lists: [forged, good] });
    expect(await run(w, s)).toMatchObject({ type: 'result' });
    expect(w.server.entries).toEqual([{ uuid: X, serial: 5 }]);
    expect(w.audit.entries[0]).toMatchObject({ event: 'revocation-catchup', accepted: 1, refused: 1 });
  });

  it('drops a list whose body was altered after signing', async () => {
    const w = await world();
    const list = w.sign([{ uuid: X, serial: 5 }], NOW + 50);
    const altered = { ...list, body: { ...list.body, entries: [{ uuid: Y, serial: 9 }] } };
    const s = await w.connect();
    s.send(hello(w.client.state()));
    await s.next();
    s.send({ type: 'revocations', lists: [altered] });
    expect(await run(w, s)).toMatchObject({ type: 'result' });
    expect(w.server.entries).toEqual([]);
    expect(w.audit.events()[0]).toBe('revocation-catchup-refused');
  });

  it('MERGES a validly signed list that is older than the one it holds (a revocation is never lost to its date)', async () => {
    const w = await world();
    w.server.install(w.sign([{ uuid: X, serial: 5 }], NOW + 100));
    const older = w.sign([{ uuid: Y, serial: 2 }], NOW + 10);
    const s = await w.connect();
    s.send(hello(w.client.state()));
    await s.next();
    await s.next();
    s.send({ type: 'revocations', lists: [older] });
    expect(await run(w, s)).toMatchObject({ type: 'result' });
    expect(w.server.entries.map((e) => e.uuid).sort()).toEqual([X, Y].sort());
  });

  it('refuses a list dated more than a day in the future, audits it and says why', async () => {
    const w = await world();
    const future = w.sign([{ uuid: X, serial: 5 }], NOW + 2 * 86_400);
    const s = await w.connect();
    s.send(hello(w.client.state()));
    await s.next();
    s.send({ type: 'revocations', lists: [future] });
    expect(await run(w, s)).toMatchObject({ type: 'result' });
    expect(w.server.entries).toEqual([]);
    expect(w.audit.entries[0]).toMatchObject({ event: 'revocation-catchup-refused', reason: 'future' });
    expect(String(w.audit.entries[0]?.message)).toMatch(/future/);
  });

  it('refuses a revocations frame whose lists is not a bounded array', async () => {
    const w = await world();
    const s = await w.connect();
    s.send(hello(w.client.state()));
    await s.next();
    s.send({ type: 'revocations', lists: 'nope' });
    expect(await run(w, s)).toMatchObject({ type: 'result' });
    expect(w.audit.entries[0]).toMatchObject({ event: 'revocation-catchup-refused', reason: 'rejected' });
    const s2 = await w.connect();
    s2.send(hello(w.client.state()));
    await s2.next();
    s2.send({ type: 'revocations', lists: Array.from({ length: 33 }, () => ({})) });
    await run(w, s2);
    expect(w.audit.entries.filter((e) => e.event === 'revocation-catchup-refused')).toHaveLength(2);
  });

  it('closes the session and audits it when the installed lists revoke the peer itself', async () => {
    const w = await world();
    const list = w.sign([{ uuid: A, serial: 1 }], NOW + 50);
    const s = await w.connect();
    s.send(hello(w.client.state()));
    await s.next();
    s.send({ type: 'revocations', lists: [list] });
    await expect(run(w, s)).rejects.toThrow();
    expect(w.audit.events()).toEqual(['revocation-catchup', 'session-closed']);
    expect(w.audit.entries[1]).toMatchObject({ reason: 'peer-revoked' });
    expect(w.ranCommands).toEqual([]);
  });

  it('refuses a revocations frame before any hello, a second hello and a second list', async () => {
    const w = await world();
    const list = w.sign([{ uuid: X, serial: 5 }], NOW + 50);
    const s = await w.connect();
    s.send({ type: 'revocations', lists: [list] });
    expect(await s.next()).toMatchObject({ type: 'refused', reason: 'revocations-before-hello' });
    s.send(hello(w.client.state()));
    await s.next();
    s.send(hello(w.client.state()));
    expect(await s.next()).toMatchObject({ type: 'refused', reason: 'duplicate-hello' });
    s.send({ type: 'revocations', lists: [list] });
    s.send({ type: 'revocations', lists: [list] });
    expect(await s.next()).toMatchObject({ type: 'refused', reason: 'duplicate-revocations' });
    expect(w.server.entries).toEqual([{ uuid: X, serial: 5 }]);
  });

  it('refuses a malformed hello with its cause', async () => {
    const w = await world();
    const s = await w.connect();
    s.send({ type: 'hello', revocationDigest: 'nope', revocationVersion: 1 });
    expect(await s.next()).toMatchObject({ type: 'refused', reason: 'bad-hello' });
  });

  it('serves a peer that never says hello (older build) and audits the absence once per peer per process', async () => {
    const w = await world();
    const s1 = await w.connect();
    expect(await run(w, s1)).toMatchObject({ type: 'result' });
    expect(await run(w, s1)).toMatchObject({ type: 'result' });
    const s2 = await w.connect();
    expect(await run(w, s2)).toMatchObject({ type: 'result' });
    expect(w.audit.events().filter((e) => e === 'revocation-hello-missing')).toHaveLength(1);
    expect(w.audit.entries.find((e) => e.event === 'revocation-hello-missing')).toMatchObject({ source: A });
  });

  it('closes a session whose peer sends an oversize frame (frame cap), and audits the session error', async () => {
    const w = await world({ maxFrameBytes: 700 });
    const big = w.sign(manyEntries(), NOW + 50);
    const s = await w.connect(1024 * 1024);
    s.send(hello(w.client.state()));
    await s.next();
    s.send({ type: 'revocations', lists: [big] });
    await expect(s.next()).rejects.toThrow();
    expect(w.server.entries).toEqual([]);
    expect(w.audit.events()).toContain('session-error');
  });

  it('says so with a FIXED message (no local detail) when its lists do not fit the frame cap', async () => {
    const w = await world({ maxFrameBytes: 700 });
    w.server.install(w.sign(manyEntries(), NOW + 50));
    const s = await w.connect();
    s.send(hello(w.client.state()));
    expect(await s.next()).toMatchObject({ type: 'hello', revocationsFollow: true });
    const frame = (await s.next()) as { type: string; unavailable: string };
    expect(frame.type).toBe('revocations');
    expect(frame.unavailable).toBe('the revocation lists of this machine do not fit its frame limit');
    expect(w.audit.entries.find((e) => e.event === 'revocation-catchup-unavailable')).toBeDefined();
  });

  it('never sends local error text to the peer when its own revocation state cannot be read', async () => {
    const w = await world();
    w.server.stateError = new Error('EACCES C:\\Users\\secret\\machine\\revocation-lists.json');
    const s = await w.connect();
    s.send(hello({ digest: 'a'.repeat(64), version: 0 }));
    const answer = (await s.next()) as { reason: string; message: string };
    expect(answer.reason).toBe('revocation-state-unavailable');
    expect(JSON.stringify(answer)).not.toMatch(/secret|EACCES|\.json/);
    expect(w.problems.join('\n')).toMatch(/EACCES/);
  });

  it('treats a hello as unknown on a service built without revocation support (old behaviour kept)', async () => {
    const w = await world({ noRevocation: true });
    const s = await w.connect();
    s.send(hello(w.client.state()));
    expect(await s.next()).toMatchObject({ type: 'refused', reason: 'unknown-message' });
  });

  it('limits a peer to 30 catch-up exchanges per minute, answers the rest with a short refusal and audits it once per minute', async () => {
    const w = await world();
    for (let i = 0; i < 30; i++) {
      const s = await w.connect();
      s.send(hello(w.client.state()));
      expect(await s.next()).toMatchObject({ type: 'hello' });
    }
    for (let i = 0; i < 2; i++) {
      const s = await w.connect();
      s.send(hello(w.client.state()));
      expect(await s.next()).toMatchObject({ type: 'refused', reason: 'rate-limited' });
    }
    expect(w.audit.events().filter((e) => e === 'revocation-catchup-rate-limited')).toHaveLength(1);
    // A minute later the peer may exchange again, and the next burst is audited again.
    w.clock.value += 61;
    const later = await w.connect();
    later.send(hello(w.client.state()));
    expect(await later.next()).toMatchObject({ type: 'hello' });
  });
});

describe('open sessions of a peer that becomes revoked', () => {
  it('closes every open session of that peer when another session installs the lists that revoke it', async () => {
    const w = await world();
    const idle = await w.connect();
    const other = await w.connect();
    other.send(hello(w.client.state()));
    await other.next();
    other.send({ type: 'revocations', lists: [w.sign([{ uuid: A, serial: 1 }], NOW + 50)] });
    await expect(idle.next()).rejects.toThrow();
    await expect(other.next()).rejects.toThrow();
    expect(w.audit.entries.filter((e) => e.event === 'session-closed' && e.reason === 'peer-revoked')).toHaveLength(2);
  });

  it('refuses the next request of a session whose peer was revoked meanwhile (installed elsewhere), then closes it', async () => {
    const w = await world();
    const s = await w.connect();
    expect(await run(w, s)).toMatchObject({ type: 'result' });
    // For example the inbox of the daemon, or `machine admin revoke` seen through the network reload.
    w.server.install(w.sign([{ uuid: A, serial: 1 }], NOW + 50));
    expect(await run(w, s)).toMatchObject({ type: 'refused', reason: 'peer-revoked' });
    await expect(s.next()).rejects.toThrow();
    expect(w.ranCommands).toHaveLength(1);
    expect(w.audit.events()).toContain('session-closed');
  });

  it('closes the open sessions of revoked peers when told that an install happened (revalidate)', async () => {
    const w = await world();
    const s = await w.connect();
    s.send(hello(w.client.state()));
    await s.next();
    w.server.install(w.sign([{ uuid: A, serial: 1 }], NOW + 50));
    w.listener.revalidate();
    await expect(s.next()).rejects.toThrow();
    expect(w.audit.entries.find((e) => e.event === 'session-closed')).toMatchObject({ reason: 'peer-revoked', source: A });
  });
});

describe('revocation catch-up, client side', () => {
  it('machine C missed the revocation of D: the peer that has it hands it over and C installs it', async () => {
    const w = await world();
    const list = w.sign([{ uuid: X, serial: 5 }], NOW + 50);
    w.server.install(list);
    const s = await w.connect();
    const report = await w.catchUp(s);
    expect(report).toMatchObject({ peerSupportsCatchUp: true, installed: true, sent: false, warnings: [] });
    expect(w.client.entries).toEqual([{ uuid: X, serial: 5 }]);
    expect(w.client.seenVersions).toEqual([{ peer: B, version: NOW + 50, digest: w.server.state().digest }]);
    expect(await run(w, s)).toMatchObject({ type: 'result' });
  });

  it('reports how long the hello took to be answered and whether both sides already held the same lists (machine ping)', async () => {
    const w = await world();
    const same = await w.catchUp(await w.connect());
    expect(same.helloRoundTripMs).toBeGreaterThanOrEqual(0);
    expect(same.helloRoundTripMs).toBeLessThan(5000);
    expect(same.inSync).toBe(true);
    expect(same.peerDigest).toBe(w.server.state().digest);

    w.server.install(w.sign([{ uuid: X, serial: 5 }], NOW + 50));
    const behind = await w.catchUp(await w.connect());
    expect(behind.inSync).toBe(false);
  });

  it('sends its own lists to a peer that is behind', async () => {
    const w = await world();
    w.client.install(w.sign([{ uuid: X, serial: 5 }], NOW + 50));
    const s = await w.connect();
    const report = await w.catchUp(s);
    expect(report).toMatchObject({ peerSupportsCatchUp: true, installed: false, sent: true });
    expect(await run(w, s)).toMatchObject({ type: 'result' });
    expect(w.server.entries).toEqual([{ uuid: X, serial: 5 }]);
  });

  it('two admin machines that each signed a list the other lacks converge in ONE handshake, each side sending once', async () => {
    const w = await world();
    const mine = w.sign([{ uuid: X, serial: 5 }], NOW + 50);
    const theirs = w.sign([{ uuid: Y, serial: 2 }], NOW + 50);
    w.client.install(mine);
    w.server.install(theirs);
    const s = await w.connect();
    const report = await w.catchUp(s);
    expect(report).toMatchObject({ installed: true, sent: true });
    expect(await run(w, s)).toMatchObject({ type: 'result' });
    expect(w.client.state().digest).toBe(w.server.state().digest);
    expect(w.client.entries).toHaveLength(2);
    // No progress loop: the server installed exactly the one list the client sent, the client exactly the one it received.
    expect(w.server.installs.map((l) => l.signature)).toEqual([theirs.signature, mine.signature]);
    expect(w.client.installs.map((l) => l.signature)).toEqual([mine.signature, theirs.signature]);
  });

  it('exchanges nothing when both hold the same revocations', async () => {
    const w = await world();
    const list = w.sign([{ uuid: X, serial: 5 }], NOW + 50);
    w.client.install(list);
    w.server.install(list);
    const report = await w.catchUp(await w.connect());
    expect(report).toMatchObject({ installed: false, sent: false });
    expect(w.server.installs).toHaveLength(1);
    expect(w.client.installs).toHaveLength(1);
  });

  it('does not install a forged list handed over by the peer and says so', async () => {
    const w = await world();
    w.server.lists = [w.sign([{ uuid: X, serial: 5 }], NOW + 50, generateSigningKeyPair())];
    w.server.entries = [{ uuid: X, serial: 5 }];
    const report = await w.catchUp(await w.connect());
    expect(report.installed).toBe(false);
    expect(report.warnings.join('\n')).toMatch(/revocation refused/);
    expect(w.client.entries).toEqual([]);
  });

  it('serves as before against a peer that does not know the hello (older build) and says it cannot catch up', async () => {
    const w = await world({ noRevocation: true });
    const s = await w.connect();
    const report = await w.catchUp(s);
    expect(report).toMatchObject({ peerSupportsCatchUp: false, installed: false, sent: false });
    expect(await run(w, s)).toMatchObject({ type: 'result' });
  });

  it('reports a peer whose lists do not fit the frame cap as a warning, not a failure', async () => {
    const w = await world({ maxFrameBytes: 700 });
    w.server.install(w.sign(manyEntries(), NOW + 50));
    const report = await w.catchUp(await w.connect());
    expect(report.installed).toBe(false);
    expect(report.warnings.join('\n')).toMatch(/frame limit/);
  });

  it('reports a rate-limited exchange as a warning and still serves the request', async () => {
    const w = await world();
    for (let i = 0; i < 30; i++) {
      const s = await w.connect();
      s.send(hello(w.client.state()));
      await s.next();
    }
    const s = await w.connect();
    const report = await w.catchUp(s);
    expect(report.warnings.join('\n')).toMatch(/too many revocation exchanges/);
    expect(await run(w, s)).toMatchObject({ type: 'result' });
  });

  it('refuses to go on when the lists the peer handed over revoke the peer itself', async () => {
    const w = await world();
    w.server.install(w.sign([{ uuid: B, serial: 1 }], NOW + 50));
    await expect(w.catchUp(await w.connect())).rejects.toThrow(/b.*revoked/);
  });
});
