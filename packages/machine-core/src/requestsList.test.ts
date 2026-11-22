import { describe, expect, it } from 'vitest';
import { generateSigningKeyPair } from './keys.js';
import { REQUESTS_LIST_DOMAIN, REQUESTS_LIST_MAX_GROUPS, REQUESTS_LIST_MAX_WAITING, buildRequestsListAnswer, newRequestsList, parseRequestsListAnswer, signRequestsList, verifyRequestsList } from './requestsList.js';
import { signDocument } from './signed.js';
import type { PendingGroup, WaitingRequest } from './requests.js';

const ADMIN_MACHINE = '1b4e28ba-2fa1-4d3b-a3f4-0123456789ab';
const TARGET = '9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345';
const NOW = 1_800_000_000;

function setup() {
  const admin = generateSigningKeyPair();
  const body = newRequestsList({ source: ADMIN_MACHINE, target: TARGET, limit: 50, now: NOW });
  return { admin, body, signed: signRequestsList(body, admin.privateKeyPkcs8) };
}
const ctx = (adminPublicKey: string, over: Partial<{ now: number; selfUuid: string; peerUuid: string }> = {}) => ({ adminPublicKey, selfUuid: TARGET, peerUuid: ADMIN_MACHINE, now: NOW + 1, ...over });

describe('requests-list request (signed by the admin key)', () => {
  it('has a fresh id and nonce and a short lifetime', () => {
    const a = newRequestsList({ source: ADMIN_MACHINE, target: TARGET, limit: 10, now: NOW });
    const b = newRequestsList({ source: ADMIN_MACHINE, target: TARGET, limit: 10, now: NOW });
    expect(a.id).not.toBe(b.id);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.expiresAt - a.issuedAt).toBeLessThanOrEqual(60);
  });

  it('is accepted when signed by the admin key, for this target, from the machine that sent it', () => {
    const { admin, signed } = setup();
    expect(verifyRequestsList(signed, ctx(admin.publicKey))).toMatchObject({ ok: true, body: { limit: 50 } });
  });

  it('is refused when signed by another key (a peer without the admin key)', () => {
    const { signed } = setup();
    expect(verifyRequestsList(signed, ctx(generateSigningKeyPair().publicKey))).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('is refused when addressed to another machine', () => {
    const { admin, signed } = setup();
    expect(verifyRequestsList(signed, ctx(admin.publicKey, { selfUuid: '2c5d1e2f-3a4b-4c6d-8e7f-abcdef012345' }))).toMatchObject({ ok: false, reason: 'wrong-target' });
  });

  it('is refused on a connection of another machine than the one named in the request', () => {
    const { admin, signed } = setup();
    expect(verifyRequestsList(signed, ctx(admin.publicKey, { peerUuid: '3c5d1e2f-3a4b-4c6d-8e7f-abcdef012345' }))).toMatchObject({ ok: false, reason: 'source-mismatch' });
  });

  it('is refused when expired or dated in the future, with the clock hint', () => {
    const { admin, signed } = setup();
    expect(verifyRequestsList(signed, ctx(admin.publicKey, { now: NOW + 500 }))).toMatchObject({ ok: false, reason: 'expired' });
    expect(verifyRequestsList(signed, ctx(admin.publicKey, { now: NOW - 500 }))).toMatchObject({ ok: false, reason: 'not-yet-valid' });
  });

  it('is refused when it lives longer than 60 seconds', () => {
    const { admin, body } = setup();
    const long = { ...body, expiresAt: body.issuedAt + 600 };
    expect(verifyRequestsList({ body: long, signature: signDocument(REQUESTS_LIST_DOMAIN, long as never, admin.privateKeyPkcs8) }, ctx(admin.publicKey))).toMatchObject({ ok: false, reason: 'lifetime-too-long' });
  });

  it('is refused when the limit is not a whole number from 1 to the maximum', () => {
    const { admin, body } = setup();
    for (const limit of [0, -1, REQUESTS_LIST_MAX_GROUPS + 1]) {
      const bad = { ...body, limit };
      expect(verifyRequestsList({ body: bad, signature: signDocument(REQUESTS_LIST_DOMAIN, bad as never, admin.privateKeyPkcs8) }, ctx(admin.publicKey))).toMatchObject({ ok: false, reason: 'malformed' });
    }
  });

  it('is refused with an extra field, a missing one, or garbage', () => {
    const { admin, body } = setup();
    const extra = { ...body, command: 'rm -rf /' };
    expect(verifyRequestsList({ body: extra, signature: signDocument(REQUESTS_LIST_DOMAIN, extra as never, admin.privateKeyPkcs8) }, ctx(admin.publicKey))).toMatchObject({ ok: false, reason: 'malformed' });
    expect(verifyRequestsList({ body: { v: 1 }, signature: 'x' }, ctx(admin.publicKey))).toMatchObject({ ok: false, reason: 'malformed' });
    expect(verifyRequestsList('nope', ctx(admin.publicKey))).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('does not verify under the domain of a command request or a policy (domain separation)', () => {
    const { admin, body } = setup();
    const other = { body, signature: signDocument('machine/request/v1', body as never, admin.privateKeyPkcs8) };
    expect(verifyRequestsList(other, ctx(admin.publicKey))).toMatchObject({ ok: false, reason: 'bad-signature' });
  });
});

const group = (i: number, command = `cmd${i}`): PendingGroup => ({ peer: ADMIN_MACHINE, peerName: 'laptop', shell: 'sh', command, count: 1, firstSeen: NOW, lastSeen: NOW + i, reason: 'not-listed' });
const held = (n: number, command = `held${n}`): WaitingRequest => ({ id: `0000000${n}-0000-4000-8000-000000000000`, peer: ADMIN_MACHINE, peerName: 'laptop', shell: 'sh', command, since: NOW - 5, deadline: NOW + 595 });
const data = (pending: PendingGroup[], over = {}) => ({ id: 'a1b2c3d4-0000-4000-8000-000000000000', machine: { uuid: TARGET, name: 'target' }, policyMode: 'admin' as const, now: NOW, chain: { ok: true } as const, pendingTotal: pending.length, allowedNow: 0, waiting: [] as WaitingRequest[], pending, ...over });

describe('requests-list answer', () => {
  it('carries only the pending groups and the machine, read-only data', () => {
    const answer = buildRequestsListAnswer(data([group(1)]), 1_048_576);
    expect(Object.keys(answer).sort()).toEqual(['allowedNow', 'chain', 'id', 'machine', 'now', 'pending', 'pendingTotal', 'policyMode', 'truncated', 'type', 'waiting']);
    expect(answer).toMatchObject({ type: 'requests-list', truncated: false });
  });

  it('never sends the detail of a broken chain, only its line', () => {
    const answer = buildRequestsListAnswer(data([], { chain: { ok: false, line: 8, message: 'secret path C:\\x' } as never }), 1_048_576);
    expect(answer.chain).toEqual({ ok: false, line: 8 });
  });

  it('drops the oldest groups until the frame fits under the cap, and says it truncated', () => {
    const big = Array.from({ length: 100 }, (_, i) => group(i, `${'x'.repeat(2000)}${i}`));
    const answer = buildRequestsListAnswer(data(big), 50_000);
    expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThanOrEqual(50_000);
    expect(answer.truncated).toBe(true);
    expect(answer.pending.length).toBeLessThan(100);
    expect(answer.pendingTotal).toBe(100);
    // The groups kept are the first ones: the list is newest first.
    expect(answer.pending[0]?.command.endsWith('0')).toBe(true);
  });

  it('carries the held requests (id, command, shell, peer, deadline) and keeps them when groups are dropped for size', () => {
    const big = Array.from({ length: 100 }, (_, i) => group(i, `${'x'.repeat(2000)}${i}`));
    const answer = buildRequestsListAnswer(data(big, { waiting: [held(1), held(2)] }), 50_000);
    expect(answer.truncated).toBe(true);
    expect(answer.waiting.map((w) => w.command)).toEqual(['held1', 'held2']);
  });

  it('refuses a cap too small for even the empty answer', () => {
    expect(() => buildRequestsListAnswer(data([]), 10)).toThrow(/frame/);
  });
});

describe('parseRequestsListAnswer (what the admin machine reads from a peer: untrusted)', () => {
  const valid = () => JSON.parse(JSON.stringify(buildRequestsListAnswer(data([group(1)]), 1_048_576))) as Record<string, unknown>;

  it('accepts a well-formed answer for the request id', () => {
    const r = parseRequestsListAnswer(valid(), 'a1b2c3d4-0000-4000-8000-000000000000');
    expect(r).toMatchObject({ ok: true, answer: { machine: { name: 'target' }, pending: [{ command: 'cmd1' }] } });
  });

  it('refuses an answer for another request id', () => {
    expect(parseRequestsListAnswer(valid(), 'ffffffff-0000-4000-8000-000000000000')).toMatchObject({ ok: false });
  });

  it('refuses a wrong shape with the reason, and more groups than the maximum', () => {
    expect(parseRequestsListAnswer({ ...valid(), pending: 'x' }, 'a1b2c3d4-0000-4000-8000-000000000000')).toMatchObject({ ok: false });
    const many = valid();
    many['pending'] = Array.from({ length: REQUESTS_LIST_MAX_GROUPS + 1 }, (_, i) => group(i));
    expect(parseRequestsListAnswer(many, 'a1b2c3d4-0000-4000-8000-000000000000')).toMatchObject({ ok: false });
  });

  it('reads the ask of a held request, and refuses a peer whose ask is not one (an incompatible version, said loudly)', () => {
    const v = valid();
    v['waiting'] = [{ ...held(1), peerName: 'laptop', ask: { for: 'permanent', why: 'rerun' } }];
    const r = parseRequestsListAnswer(v, 'a1b2c3d4-0000-4000-8000-000000000000');
    expect(r.ok && r.answer.waiting[0]?.ask).toEqual({ for: 'permanent', why: 'rerun' });
    v['waiting'] = [{ ...held(1), peerName: 'laptop', ask: { times: -1 } }];
    expect(parseRequestsListAnswer(v, 'a1b2c3d4-0000-4000-8000-000000000000')).toMatchObject({ ok: false });
  });

  it('reads the held requests, with every text reduced to bounded printable ASCII', () => {
    const v = valid();
    v['waiting'] = [{ ...held(1, 'ls[2J'), peerName: 'laptop' }];
    const r = parseRequestsListAnswer(v, 'a1b2c3d4-0000-4000-8000-000000000000');
    expect(r.ok && r.answer.waiting).toEqual([{ ...held(1, 'ls?[2J'), peerName: 'la?ptop' }]);
  });

  it('reads an older peer answer (no waiting field) as no held request', () => {
    const v = valid();
    delete v['waiting'];
    const r = parseRequestsListAnswer(v, 'a1b2c3d4-0000-4000-8000-000000000000');
    expect(r.ok && r.answer.waiting).toEqual([]);
  });

  it('reads the serial of the notice-recipients list the peer holds: a number, null (no list), or absent (older build)', () => {
    const id = 'a1b2c3d4-0000-4000-8000-000000000000';
    const withSerial = parseRequestsListAnswer({ ...valid(), noticeRecipientsSerial: 1234 }, id);
    expect(withSerial.ok && withSerial.answer.noticeRecipientsSerial).toBe(1234);
    const none = parseRequestsListAnswer({ ...valid(), noticeRecipientsSerial: null }, id);
    expect(none.ok && none.answer.noticeRecipientsSerial).toBeNull();
    const older = parseRequestsListAnswer(valid(), id);
    expect(older.ok && 'noticeRecipientsSerial' in older.answer).toBe(false);
    expect(parseRequestsListAnswer({ ...valid(), noticeRecipientsSerial: 'x' }, id)).toMatchObject({ ok: false });
    expect(parseRequestsListAnswer({ ...valid(), noticeRecipientsSerial: -1 }, id)).toMatchObject({ ok: false });
  });

  it('the answer a machine builds carries its list serial when it has one to tell', () => {
    const built = JSON.parse(JSON.stringify(buildRequestsListAnswer({ ...data([]), noticeRecipientsSerial: 77 }, 1_048_576))) as Record<string, unknown>;
    expect(built['noticeRecipientsSerial']).toBe(77);
  });

  it('refuses a malformed held request and more of them than a machine can hold', () => {
    const id = 'a1b2c3d4-0000-4000-8000-000000000000';
    const v = valid();
    v['waiting'] = [{ ...held(1), deadline: 'soon' }];
    expect(parseRequestsListAnswer(v, id)).toMatchObject({ ok: false });
    v['waiting'] = [{ ...held(1), id: 'not-a-uuid' }];
    expect(parseRequestsListAnswer(v, id)).toMatchObject({ ok: false });
    v['waiting'] = Array.from({ length: REQUESTS_LIST_MAX_WAITING + 1 }, (_, i) => held(i % 9));
    expect(parseRequestsListAnswer(v, id)).toMatchObject({ ok: false });
  });

  it('turns control characters into ?: a peer cannot send an escape sequence to the terminal', () => {
    const v = valid();
    (v['pending'] as PendingGroup[])[0] = group(1, 'ls\u001b[2J');
    const r = parseRequestsListAnswer(v, 'a1b2c3d4-0000-4000-8000-000000000000');
    expect(r.ok && r.answer.pending[0]?.command).toBe('ls?[2J');
  });
});
