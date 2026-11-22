import { randomBytes } from 'node:crypto';
import { HoldTable, applyPolicy, generateSigningKeyPair, keyId, newRequest, signPolicy, signRequest, type Json, type PolicyBody } from '@wadeck-app/machine-core';
import { connectToPeer, type PeerSession } from '@wadeck-app/machine-transport';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApplyResult } from './documentApply.js';
import { startPeerListener, type PeerServiceDeps } from './peerService.js';

// The `deliver-document` frame on the peer service (decision 86): the admin machine hands a sealed document straight to its addressee.

const A = '1b4e28ba-2fa1-4d3b-a3f4-0123456789ab';
const B = '9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345';
const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';
const DOC = { body: { v: 2, kind: 'policy', to: B, id: 'abcdefghijklmnopqrstuv', issuedAt: 1, expiresAt: 2, payload: { sealed: 'zzz' } }, signature: 'sig' };

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length > 0) closers.pop()?.();
});

async function world(over: { apply?: ((document: unknown) => ApplyResult) | 'absent'; auditFails?: boolean; pollMs?: number } = {}) {
  const admin = generateSigningKeyPair();
  const a = generateSigningKeyPair();
  const b = generateSigningKeyPair();
  const secret = randomBytes(32);
  const audit: Array<Record<string, Json>> = [];
  const problems: string[] = [];
  const now = { value: 1_800_000_000 };
  const bodyOf = (command: string): PolicyBody => ({ v: 1, target: B, version: 1, baseVersion: 0, adminKeyId: keyId(admin.publicKey), issuedAt: now.value, notBefore: now.value - 10, notAfter: now.value + 100_000, defaults: [{ shell: SHELL as 'cmd', command }], peers: {} });
  const policies = ['echo other', 'echo not listed'].map((command) => {
    const applied = applyPolicy({ version: 0, highestSeen: 0 }, signPolicy(bodyOf(command), admin.privateKeyPkcs8), { adminPublicKey: admin.publicKey, now: now.value, targetUuid: B });
    if (!applied.ok) {
      throw new Error(applied.message);
    }
    return applied.body;
  });
  const state = { policy: policies[0] as PolicyBody, applied: [] as unknown[], ended: [] as Array<{ id: string; outcome: string }>, auditFails: over.auditFails === true };
  const table = new HoldTable();
  const defaultApply = (document: unknown): ApplyResult => {
    state.applied.push(document);
    return { status: 'installed', kind: 'policy', id: 'abcdefghijklmnopqrstuv' };
  };
  const apply = over.apply === 'absent' ? undefined : (over.apply ?? defaultApply);
  const deps: PeerServiceDeps = {
    self: { uuid: B, name: 'b', createdAt: '', identity: b },
    directory: { lookup: (key) => (key === a.publicKey ? { peerId: A, name: 'a', pairSecret: secret } : undefined) },
    policy: () => state.policy,
    usage: { count: () => 0, record: () => undefined },
    audit: {
      write: (e) => {
        if (state.auditFails && e['event'] === 'document-delivered') {
          throw new Error('disk full');
        }
        audit.push(e);
      },
    },
    now: () => now.value,
    run: async () => ({ exitCode: 0, stdout: 'ran', stderr: '', timedOut: false, truncated: false, outputNotUtf8: false, durationMs: 1 }),
    onProblem: (m) => void problems.push(m),
    holds: { table, pollMs: over.pollMs ?? 3, onEnded: (id, outcome) => void state.ended.push({ id, outcome }) },
    ...(apply === undefined ? {} : { documents: { apply } }),
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
  const holdOne = async () => {
    const session = await connect();
    const request = newRequest({ source: A, target: B, shell: SHELL as 'cmd', command: 'echo not listed', now: now.value });
    session.send({ type: 'run', request: signRequest(request, a.privateKeyPkcs8), waitSeconds: 60 });
    const answer = session.next();
    answer.catch(() => undefined);
    for (let i = 0; i < 200 && table.list().length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    if (table.list().length === 0) {
      throw new Error('the request was not held');
    }
    return { answer };
  };
  return { audit, problems, state, policies, exchange, holdOne, table };
}

const frame = { type: 'deliver-document', document: DOC };

describe('deliver-document (decision 86)', () => {
  it('applies the document through the shared applier and acknowledges it, audited with the sender and without the document', async () => {
    const w = await world();
    expect(await w.exchange(frame)).toEqual({ type: 'deliver-ack', id: 'abcdefghijklmnopqrstuv', outcome: 'installed', peerNow: 1_800_000_000 });
    expect(w.state.applied).toEqual([DOC]);
    const line = w.audit.find((e) => e['event'] === 'document-delivered');
    expect(line).toMatchObject({ source: A, kind: 'policy', id: 'abcdefghijklmnopqrstuv', outcome: 'installed' });
    expect(JSON.stringify(w.audit)).not.toContain('zzz');
  });

  it('acknowledges a document that was already in force as already-installed', async () => {
    const w = await world({ apply: () => ({ status: 'already-installed', kind: 'policy', id: 'abcdefghijklmnopqrstuv' }) });
    expect(await w.exchange(frame)).toMatchObject({ type: 'deliver-ack', outcome: 'already-installed' });
  });

  const refusals: Array<[ApplyResult, string, RegExp]> = [
    [{ status: 'refused', reason: 'install-refused', kind: 'policy', id: 'x', message: 'policy refused (rollback): older' }, 'install-refused', /rollback/],
    [{ status: 'refused', reason: 'wrong-recipient', kind: 'policy', id: 'x', message: 'addressed to another' }, 'wrong-recipient', /addressed/],
    [{ status: 'unverified', reason: 'bad-signature', kind: 'policy', id: 'x' }, 'unverified', /bad-signature/],
    [{ status: 'not-enrolled' }, 'not-enrolled', /admin key/],
    [{ status: 'blocked', reason: 'invalid-admin-key', message: 'the pinned key is broken' }, 'invalid-admin-key', /broken/],
    [{ status: 'deferred', reason: 'not-yet-valid', kind: 'policy', id: 'x', message: 'dated in the future' }, 'not-yet-valid', /future/],
    [{ status: 'waiting', reason: 'waiting-predecessor', kind: 'policy', id: 'x', message: 'version 1 is not installed', version: 2, baseVersion: 1 }, 'waiting-predecessor', /not installed/],
    [{ status: 'unopenable', kind: 'peer', id: 'x', message: 'cannot open the sealed pair secret' }, 'cannot-open', /sealed/],
    [{ status: 'error', kind: 'policy', id: 'x', message: 'disk full' }, 'cannot-apply', /disk full/],
  ];
  it.each(refusals)('answers a refusal with its reason and cause for %j', async (result, reason, message) => {
    const w = await world({ apply: () => result });
    expect(await w.exchange(frame)).toMatchObject({ type: 'refused', reason, message: expect.stringMatching(message) });
    expect(w.audit.find((e) => e['event'] === 'document-delivery-refused')).toMatchObject({ source: A, reason });
  });

  it('a refusal carries the clock of this machine (peerNow), in the answer and in the audit line, so the sender can measure the skew', async () => {
    const w = await world({ apply: () => ({ status: 'deferred', reason: 'not-yet-valid', kind: 'policy', id: 'x', message: 'dated in the future' }) });
    expect(await w.exchange(frame)).toMatchObject({ type: 'refused', reason: 'not-yet-valid', peerNow: 1_800_000_000 });
    expect(w.audit.find((e) => e['event'] === 'document-delivery-refused')).toMatchObject({ reason: 'not-yet-valid', now: 1_800_000_000 });
  });

  it('refuses a malformed frame as bad-deliver, and never calls the applier', async () => {
    const w = await world();
    expect(await w.exchange({ type: 'deliver-document', document: DOC, who: 'me' })).toMatchObject({ type: 'refused', reason: 'bad-deliver', message: expect.stringMatching(/unknown field/) });
    expect(await w.exchange({ type: 'deliver-document' })).toMatchObject({ type: 'refused', reason: 'bad-deliver' });
    expect(w.state.applied).toEqual([]);
  });

  it('is an unknown message without document support, as for an older build', async () => {
    const w = await world({ apply: 'absent' });
    expect(await w.exchange(frame)).toMatchObject({ type: 'refused', reason: 'unknown-message' });
  });

  it('limits a sender to 30 deliveries per minute and audits the excess once', async () => {
    const w = await world();
    let last: any;
    for (let i = 0; i < 35; i++) last = await w.exchange(frame);
    expect(last).toMatchObject({ type: 'refused', reason: 'rate-limited', message: expect.stringMatching(/30 per minute/) });
    expect(w.state.applied).toHaveLength(30);
    expect(w.audit.filter((e) => e['event'] === 'document-delivery-rate-limited')).toHaveLength(1);
  });

  it('an audit failure is answered as a refusal that names the fix (the admin then uses the inbox, where the document is found already installed)', async () => {
    const w = await world({ auditFails: true });
    expect(await w.exchange(frame)).toMatchObject({ type: 'refused', reason: 'audit-unavailable', message: expect.stringMatching(/audit log/) });
  });

  it('releases a held request at once after an installed document (no wait for the next poll)', async () => {
    const w = await world({
      pollMs: 60_000,
      apply: () => {
        w.state.policy = w.policies[1] as PolicyBody;
        return { status: 'installed', kind: 'policy', id: 'abcdefghijklmnopqrstuv' };
      },
    });
    const held = await w.holdOne();
    const started = Date.now();
    expect(await w.exchange(frame)).toMatchObject({ type: 'deliver-ack' });
    expect(await held.answer).toMatchObject({ type: 'result', stdout: 'ran' });
    expect(Date.now() - started).toBeLessThan(5000);
    // The end of the hold is told to whoever keeps the outcomes (the Requests page asks for it after an Allow).
    expect(w.state.ended).toHaveLength(1);
    expect(w.state.ended[0]?.outcome).toBe('allowed');
  });
});
