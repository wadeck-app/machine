import { randomBytes } from 'node:crypto';
import { HoldTable, applyPolicy, generateSigningKeyPair, keyId, newRequest, signPolicy, signRequest, type Json, type PolicyBody } from '@wadeck-app/machine-core';
import { connectToPeer, type PeerSession } from '@wadeck-app/machine-transport';
import { afterEach, describe, expect, it } from 'vitest';
import { startPeerListener, type PeerServiceDeps } from './peerService.js';

// The `request-deny` frame on the peer service (decision 85): a machine of the notice-recipients list of this target refuses a request it holds.

const A = '1b4e28ba-2fa1-4d3b-a3f4-0123456789ab';
const B = '9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345';
const OTHER = '5e5d1e2f-3a4b-4c6d-8e7f-abcdef012345';
const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length > 0) closers.pop()?.();
});

type Recipients = () => string[] | undefined;

async function world(over: { remoteDeny?: Recipients | 'absent'; auditFails?: boolean } = {}) {
  const admin = generateSigningKeyPair();
  const a = generateSigningKeyPair();
  const b = generateSigningKeyPair();
  const secret = randomBytes(32);
  const audit: Array<Record<string, Json>> = [];
  const problems: string[] = [];
  const now = { value: 1_800_000_000 };
  const body: PolicyBody = { v: 1, target: B, version: 1, baseVersion: 0, adminKeyId: keyId(admin.publicKey), issuedAt: now.value, notBefore: now.value - 10, notAfter: now.value + 100_000, defaults: [{ shell: SHELL as 'cmd', command: 'echo listed' }], peers: {} };
  const applied = applyPolicy({ version: 0, highestSeen: 0 }, signPolicy(body, admin.privateKeyPkcs8), { adminPublicKey: admin.publicKey, now: now.value, targetUuid: B });
  if (!applied.ok) {
    throw new Error(applied.message);
  }
  const table = new HoldTable();
  const holdChanges: number[] = [];
  const state = { auditFails: over.auditFails === true };
  const deps: PeerServiceDeps = {
    self: { uuid: B, name: 'b', createdAt: '', identity: b },
    directory: { lookup: (key) => (key === a.publicKey ? { peerId: A, name: 'a', pairSecret: secret } : undefined) },
    policy: () => applied.body,
    usage: { count: () => 0, record: () => undefined },
    audit: {
      write: (e) => {
        if (state.auditFails && e['event'] === 'request-denied-remotely') {
          throw new Error('disk full');
        }
        audit.push(e);
      },
    },
    now: () => now.value,
    run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, truncated: false, outputNotUtf8: false, durationMs: 1 }),
    onProblem: (m) => void problems.push(m),
    holds: { table, pollMs: 3, onChange: () => void holdChanges.push(table.list().length) },
    ...(over.remoteDeny === 'absent' ? {} : { remoteDeny: { recipients: over.remoteDeny ?? (() => [A]) } }),
  };
  const listener = await startPeerListener(deps, { host: '127.0.0.1', port: 0 });
  closers.push(() => listener.close());
  const connect = async (): Promise<PeerSession> => {
    const s = await connectToPeer({ identity: a, host: '127.0.0.1', port: listener.port, expectedPeerPublicKey: b.publicKey, pairSecret: secret });
    closers.push(() => s.close());
    return s;
  };
  const exchange = async (frame: unknown): Promise<any> => {
    const s = await connect();
    s.send(frame);
    return await s.next();
  };
  /** A caller whose request is held; resolves with the request id and the promise of its final answer. */
  const holdOne = async (command = 'echo not listed') => {
    const session = await connect();
    const request = newRequest({ source: A, target: B, shell: SHELL as 'cmd', command, now: now.value });
    session.send({ type: 'run', request: signRequest(request, a.privateKeyPkcs8), waitSeconds: 60 });
    const answer = session.next();
    // A hold still open when the test ends is closed by the teardown: that rejection is not a failure.
    answer.catch(() => undefined);
    for (let i = 0; i < 200 && table.list().length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    if (table.list().length === 0) {
      throw new Error('the request was not held');
    }
    return { id: request.id, answer };
  };
  return { audit, problems, now, state, exchange, holdOne, table, holdChanges };
}

describe('request-deny: a notice recipient refuses a held request (decision 85)', () => {
  it('denies the held request, the caller gets refused denied with the reason, the sender gets deny-ack, and the audit names who denied', async () => {
    const w = await world();
    const held = await w.holdOne();
    const ack = await w.exchange({ type: 'request-deny', id: held.id, reason: 'not now' });
    expect(ack).toEqual({ type: 'deny-ack', id: held.id });
    const refused = await held.answer;
    expect(refused).toMatchObject({ type: 'refused', reason: 'denied', message: expect.stringContaining('not now') });
    const line = w.audit.find((e) => e['event'] === 'request-denied-remotely');
    expect(line).toMatchObject({ source: A, by: A, byName: 'a', id: held.id, note: 'not now' });
  });

  it('tells the daemon when a hold starts and when it ends (the inbox poll speeds up and slows down)', async () => {
    const w = await world();
    const held = await w.holdOne();
    expect(w.holdChanges).toEqual([1]);
    await w.exchange({ type: 'request-deny', id: held.id });
    await held.answer;
    expect(w.holdChanges).toEqual([1, 0]);
  });

  it('accepts the 8-character id that `machine requests` prints', async () => {
    const w = await world();
    const held = await w.holdOne();
    expect(await w.exchange({ type: 'request-deny', id: held.id.slice(0, 8) })).toEqual({ type: 'deny-ack', id: held.id });
  });

  it('refuses a sender that is not in the notice-recipients list, with the fix, and the request stays held', async () => {
    const w = await world({ remoteDeny: () => [OTHER] });
    const held = await w.holdOne();
    const answer = await w.exchange({ type: 'request-deny', id: held.id });
    expect(answer).toMatchObject({ type: 'refused', reason: 'not-a-recipient', message: expect.stringMatching(/notify-to/) });
    expect(w.table.list()).toHaveLength(1);
    expect(w.audit.find((e) => e['event'] === 'request-denied-remotely')).toBeUndefined();
  });

  it('refuses when this machine holds no recipients list, naming the command that sends it', async () => {
    const w = await world({ remoteDeny: () => undefined });
    const held = await w.holdOne();
    const answer = await w.exchange({ type: 'request-deny', id: held.id });
    expect(answer).toMatchObject({ type: 'refused', reason: 'not-a-recipient', message: expect.stringMatching(/admin distribute/) });
    expect(w.table.list()).toHaveLength(1);
  });

  it('refuses a damaged list loudly instead of guessing', async () => {
    const w = await world({
      remoteDeny: () => {
        throw new Error('notice-recipients.json cannot be used');
      },
    });
    const held = await w.holdOne();
    expect(await w.exchange({ type: 'request-deny', id: held.id })).toMatchObject({ type: 'refused', reason: 'recipients-unreadable', message: expect.stringMatching(/notice-recipients\.json/) });
    expect(w.table.list()).toHaveLength(1);
  });

  it('answers not-held for an id nothing waits under (answered, expired, never existed)', async () => {
    const w = await world();
    expect(await w.exchange({ type: 'request-deny', id: '3f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f' })).toMatchObject({ type: 'refused', reason: 'not-held', message: expect.stringMatching(/machine requests/) });
  });

  it('a second deny of the same request is harmless (replay): the hold is gone', async () => {
    const w = await world();
    const held = await w.holdOne();
    const frame = { type: 'request-deny', id: held.id };
    expect(await w.exchange(frame)).toMatchObject({ type: 'deny-ack' });
    await held.answer;
    expect(await w.exchange(frame)).toMatchObject({ type: 'refused', reason: 'not-held' });
  });

  it('refuses a bad reason and a malformed frame', async () => {
    const w = await world();
    const held = await w.holdOne();
    expect(await w.exchange({ type: 'request-deny', id: held.id, reason: 'café' })).toMatchObject({ type: 'refused', reason: 'bad-deny' });
    expect(await w.exchange({ type: 'request-deny', id: held.id, who: 'me' })).toMatchObject({ type: 'refused', reason: 'bad-deny' });
    expect(w.table.list()).toHaveLength(1);
  });

  it('denies nothing when the audit log cannot record who denied', async () => {
    const w = await world({ auditFails: true });
    const held = await w.holdOne();
    expect(await w.exchange({ type: 'request-deny', id: held.id })).toMatchObject({ type: 'refused', reason: 'audit-unavailable' });
    expect(w.table.list()).toHaveLength(1);
  });

  it('an older or unconfigured target answers unknown-message (the sender tells the owner to update)', async () => {
    const w = await world({ remoteDeny: 'absent' });
    expect(await w.exchange({ type: 'request-deny', id: '3f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f' })).toMatchObject({ type: 'refused', reason: 'unknown-message' });
  });
});
