import { randomBytes } from 'node:crypto';
import { generateSigningKeyPair, newRequestsList, signRequestsList, type Json, type PendingGroup } from '@wadeck-app/machine-core';
import { connectToPeer } from '@wadeck-app/machine-transport';
import { afterEach, describe, expect, it } from 'vitest';
import { startPeerListener, type PeerServiceDeps } from './peerService.js';
import { listRequestsOnPeer } from './requestsRemote.js';

const A = '1b4e28ba-2fa1-4d3b-a3f4-0123456789ab';
const B = '9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345';
const NOW = 1_800_000_000;

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length > 0) closers.pop()?.();
});

const group = (i: number, command = `cmd${i}`): PendingGroup => ({ peer: A, peerName: 'a', shell: 'sh', command, count: 2, firstSeen: NOW - 100, lastSeen: NOW - i, reason: 'not-listed' });

async function world(over: { requests?: boolean; noAdmin?: boolean; groups?: PendingGroup[]; maxFrameBytes?: number; failAudit?: boolean } = {}) {
  const admin = generateSigningKeyPair();
  const a = generateSigningKeyPair();
  const b = generateSigningKeyPair();
  const secret = randomBytes(32);
  const entries: Array<Record<string, Json>> = [];
  const listed: number[] = [];
  const now = { value: NOW };
  const deps: PeerServiceDeps = {
    self: { uuid: B, name: 'target', createdAt: '', identity: b },
    directory: { lookup: (key) => (key === a.publicKey ? { peerId: A, name: 'a', pairSecret: secret } : undefined) },
    policy: () => undefined,
    usage: { count: () => 0, record: () => undefined },
    audit: {
      write: (e) => {
        if (over.failAudit && e['event'] === 'requests-list') throw new Error('disk full');
        entries.push(e);
      },
    },
    now: () => now.value,
    onProblem: () => undefined,
    ...(over.maxFrameBytes !== undefined ? { maxFrameBytes: over.maxFrameBytes } : {}),
    ...(over.requests === false
      ? {}
      : {
          requests: {
            adminPublicKey: () => (over.noAdmin ? undefined : admin.publicKey),
            list: (limit: number) => {
              listed.push(limit);
              const pending = over.groups ?? [group(1), group(2)];
              return { machine: { uuid: B, name: 'target' }, policyMode: 'admin' as const, chain: { ok: true as const }, pendingTotal: pending.length, allowedNow: 0, pending: pending.slice(0, limit) };
            },
          },
        }),
  };
  const listener = await startPeerListener(deps, { host: '127.0.0.1', port: 0 });
  closers.push(() => listener.close());
  const connect = async () => {
    const s = await connectToPeer({ identity: a, host: '127.0.0.1', port: listener.port, expectedPeerPublicKey: b.publicKey, pairSecret: secret });
    closers.push(() => s.close());
    return s;
  };
  return { admin, a, entries, listed, now, connect };
}

const input = (w: Awaited<ReturnType<typeof world>>, over: Partial<Parameters<typeof listRequestsOnPeer>[1]> = {}) => ({ adminPrivateKeyPkcs8: w.admin.privateKeyPkcs8, source: A, target: B, limit: 100, now: NOW, ...over });

describe('requests-list on the peer service', () => {
  it('answers the admin with the pending groups, and audits the exchange without the commands', async () => {
    const w = await world();
    const r = await listRequestsOnPeer(await w.connect(), input(w, { limit: 10 }));
    expect(r).toMatchObject({ ok: true, answer: { machine: { name: 'target' }, policyMode: 'admin', pendingTotal: 2, truncated: false } });
    if (r.ok) expect(r.answer.pending.map((g) => g.command)).toEqual(['cmd1', 'cmd2']);
    expect(w.listed).toEqual([10]);
    const audit = w.entries.find((e) => e['event'] === 'requests-list');
    expect(audit).toMatchObject({ source: A, limit: 10 });
    expect(JSON.stringify(w.entries)).not.toContain('cmd1');
  });

  it('refuses a request not signed by the admin key (a registered peer cannot read the others), audits the refusal, sends no data', async () => {
    const w = await world();
    const impostor = generateSigningKeyPair();
    const r = await listRequestsOnPeer(await w.connect(), input(w, { adminPrivateKeyPkcs8: impostor.privateKeyPkcs8 }));
    expect(r).toMatchObject({ ok: false, reason: 'bad-signature' });
    expect(w.listed).toEqual([]);
    expect(w.entries.map((e) => e['event'])).toEqual(['refused']);
  });

  it('refuses a request addressed to another machine', async () => {
    const w = await world();
    const r = await listRequestsOnPeer(await w.connect(), input(w, { target: '2c5d1e2f-3a4b-4c6d-8e7f-abcdef012345' }));
    expect(r).toMatchObject({ ok: false, reason: 'wrong-target' });
  });

  it('refuses a request that names another machine than the connection', async () => {
    const w = await world();
    const r = await listRequestsOnPeer(await w.connect(), input(w, { source: '3c5d1e2f-3a4b-4c6d-8e7f-abcdef012345' }));
    expect(r).toMatchObject({ ok: false, reason: 'source-mismatch' });
  });

  it('refuses the same signed request twice (replay)', async () => {
    const w = await world();
    const session = await w.connect();
    const signed = signRequestsList(newRequestsList({ source: A, target: B, limit: 5, now: NOW }), w.admin.privateKeyPkcs8);
    session.send({ type: 'requests-list', request: signed });
    expect(await session.next()).toMatchObject({ type: 'requests-list' });
    session.send({ type: 'requests-list', request: signed });
    expect(await session.next()).toMatchObject({ type: 'refused', reason: 'replay' });
  });

  it('refuses a request issued before the daemon started', async () => {
    const w = await world();
    const r = await listRequestsOnPeer(await w.connect(), input(w, { now: NOW - 20 }));
    expect(r).toMatchObject({ ok: false, reason: 'predates-start' });
  });

  it('limits a peer to 6 lists per minute and audits the limit once', async () => {
    const w = await world();
    const session = await w.connect();
    const results = [];
    for (let i = 0; i < 8; i++) results.push(await listRequestsOnPeer(session, input(w)));
    expect(results.filter((r) => r.ok)).toHaveLength(6);
    expect(results[6]).toMatchObject({ ok: false, reason: 'rate-limited' });
    expect(w.entries.filter((e) => e['event'] === 'requests-list-rate-limited')).toHaveLength(1);
  });

  it('says so when no admin key is pinned on the target', async () => {
    const w = await world({ noAdmin: true });
    const r = await listRequestsOnPeer(await w.connect(), input(w));
    expect(r).toMatchObject({ ok: false, reason: 'no-admin' });
  });

  it('shows an older build as "peer too old" with the fix', async () => {
    const w = await world({ requests: false });
    const r = await listRequestsOnPeer(await w.connect(), input(w));
    expect(r).toMatchObject({ ok: false, reason: 'peer-too-old' });
    if (!r.ok) expect(r.message).toMatch(/machine cli update/);
  });

  it('sends nothing when the audit cannot be written (no audit, no disclosure)', async () => {
    const w = await world({ failAudit: true });
    const r = await listRequestsOnPeer(await w.connect(), input(w));
    expect(r).toMatchObject({ ok: false, reason: 'audit-unavailable' });
    expect(w.listed).toEqual([]);
  });

  it('cuts the list to the frame cap and says it was truncated', async () => {
    const groups = Array.from({ length: 100 }, (_, i) => group(i, `${'x'.repeat(1500)}${i}`));
    const w = await world({ groups, maxFrameBytes: 60_000 });
    const r = await listRequestsOnPeer(await w.connect(), input(w));
    expect(r).toMatchObject({ ok: true, answer: { truncated: true, pendingTotal: 100 } });
    if (r.ok) expect(r.answer.pending.length).toBeLessThan(100);
  });
});
