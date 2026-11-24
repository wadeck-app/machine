import { describe, expect, it } from 'vitest';
import { assertPolicyBody, type PolicyBody, type PolicyEntry } from './policy.js';
import { nextPolicyBody, nextPolicyBodyRemoveMany, nextPolicyBodyRenewMany, type EntryRef } from './policyEdit.js';

// Several entries of the lists of a policy removed, or given a new lifetime, in ONE version (the Allowed page: select rows, act once, sign once).

const TARGET = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const ctx = { target: TARGET, adminKeyId: 'a'.repeat(32), now: 1_800_000_000 };
const exact = (command: string, limits?: PolicyEntry['limits']): PolicyEntry => ({ shell: 'sh', command, ...(limits ? { limits } : {}) });
const ref = (index: number, text: string, peer?: string, shell: EntryRef['shell'] = 'sh'): EntryRef => ({ index, shell, text, ...(peer === undefined ? {} : { peer }) });

const current = (over: Partial<PolicyBody> = {}): PolicyBody => ({
  v: 1,
  target: TARGET,
  version: 3,
  baseVersion: 2,
  adminKeyId: 'a'.repeat(32),
  issuedAt: 1_700_000_000,
  notBefore: 1_700_000_000,
  notAfter: 1_700_600_000,
  defaults: [exact('a'), exact('b'), exact('c'), exact('d')],
  peers: { [PEER]: [exact('p1'), exact('p2', { maxCalls: 3 })] },
  ...over,
});

const messageOf = (run: () => unknown): string => {
  try {
    run();
  } catch (e) {
    return (e as Error).message;
  }
  return '';
};

describe('nextPolicyBodyRemoveMany', () => {
  it('removes several entries of the default list in ONE version, the indexes being those of the list as it was read (no shift between them)', () => {
    const r = nextPolicyBodyRemoveMany(current(), ctx, [ref(1, 'a'), ref(3, 'c')]);
    expect(r.body).toMatchObject({ version: 4, baseVersion: 3, issuedAt: ctx.now, notBefore: ctx.now });
    expect(r.body.defaults.map((e) => e.command)).toEqual(['b', 'd']);
    expect(r.removed.map((e) => e.command)).toEqual(['a', 'c']);
    expect(r.body.peers[PEER]).toEqual(current().peers[PEER]);
    expect(() => assertPolicyBody(r.body)).not.toThrow();
  });

  it('removes from several lists at once: the default list and the own list of a peer', () => {
    const r = nextPolicyBodyRemoveMany(current(), ctx, [ref(2, 'b'), ref(2, 'p2', PEER)]);
    expect(r.body.defaults.map((e) => e.command)).toEqual(['a', 'c', 'd']);
    expect(r.body.peers[PEER]?.map((e) => e.command)).toEqual(['p1']);
  });

  it('one removal gives exactly what nextPolicyBody gives', () => {
    const many = nextPolicyBodyRemoveMany(current(), ctx, [ref(2, 'b')]);
    const single = nextPolicyBody(current(), ctx, { kind: 'remove', index: 2 });
    expect(single.changed && many.body).toEqual(single.changed && single.body);
  });

  it('the same entry named twice is removed once', () => {
    const r = nextPolicyBodyRemoveMany(current(), ctx, [ref(2, 'b'), ref(2, 'b')]);
    expect(r.body.defaults.map((e) => e.command)).toEqual(['a', 'c', 'd']);
    expect(r.removed).toHaveLength(1);
  });

  it('removing the last entry of an own list leaves an EMPTY own list (the peer then runs nothing: the default list does not apply to it)', () => {
    const r = nextPolicyBodyRemoveMany(current(), ctx, [ref(1, 'p1', PEER), ref(2, 'p2', PEER)]);
    expect(r.body.peers[PEER]).toEqual([]);
    expect(r.emptiedPeerLists).toEqual([PEER]);
    expect(() => assertPolicyBody(r.body)).not.toThrow();
  });

  it('removing every default entry says so', () => {
    const r = nextPolicyBodyRemoveMany(current(), ctx, [ref(1, 'a'), ref(2, 'b'), ref(3, 'c'), ref(4, 'd')]);
    expect(r.body.defaults).toEqual([]);
    expect(r.emptiedDefaults).toBe(true);
  });

  it('refuses a list that moved since it was read: the entry at the index is not the one named, nothing is built, the message names the fix', () => {
    const message = messageOf(() => nextPolicyBodyRemoveMany(current(), ctx, [ref(2, 'zzz')]));
    expect(message).toMatch(/#2/);
    expect(message).toMatch(/zzz/);
    expect(message).toMatch(/changed since it was read/);
    expect(message).toMatch(/Refresh the page/);
  });

  it('refuses a shell that differs, an index out of the list, a peer without an own list, and an empty selection', () => {
    expect(messageOf(() => nextPolicyBodyRemoveMany(current(), ctx, [ref(1, 'a', undefined, 'cmd')]))).toMatch(/changed since it was read/);
    expect(messageOf(() => nextPolicyBodyRemoveMany(current(), ctx, [ref(9, 'a')]))).toMatch(/has 4 entries/);
    expect(messageOf(() => nextPolicyBodyRemoveMany(current(), ctx, [ref(1, 'a', '33333333-3333-4333-8333-333333333333')]))).toMatch(/no list of its own/);
    expect(messageOf(() => nextPolicyBodyRemoveMany(current(), ctx, []))).toMatch(/at least one entry/);
  });

  it('refuses a policy written for another machine and no policy at all', () => {
    expect(messageOf(() => nextPolicyBodyRemoveMany(current({ target: PEER }), ctx, [ref(1, 'a')]))).toMatch(/another machine/);
    expect(messageOf(() => nextPolicyBodyRemoveMany(undefined, ctx, [ref(1, 'a')]))).toMatch(/no policy/);
  });
});

describe('nextPolicyBodyRenewMany', () => {
  it('gives several entries a new lifetime in ONE version: the limits are replaced, the generation goes up (the counter starts again), the body is v2', () => {
    const base = current({ defaults: [exact('a', { maxCalls: 2 }), exact('b'), exact('c', { expiresAt: 1_800_000_500, renewals: 2 })] });
    const r = nextPolicyBodyRenewMany(base, ctx, [ref(1, 'a'), ref(3, 'c')], { maxCalls: 5 });
    expect(r.body).toMatchObject({ v: 2, version: 4, baseVersion: 3 });
    expect(r.body.defaults[0]).toEqual({ shell: 'sh', command: 'a', limits: { maxCalls: 5, renewals: 1 } });
    expect(r.body.defaults[1]).toEqual(exact('b'));
    expect(r.body.defaults[2]).toEqual({ shell: 'sh', command: 'c', limits: { maxCalls: 5, renewals: 3 } });
    expect(r.renewed.map((x) => x.before.command)).toEqual(['a', 'c']);
    expect(() => assertPolicyBody(r.body)).not.toThrow();
  });

  it('a permanent entry becomes limited, a limited one becomes permanent (no limits key at all)', () => {
    const base = current({ defaults: [exact('a'), exact('b', { maxCalls: 2 })] });
    const limited = nextPolicyBodyRenewMany(base, ctx, [ref(1, 'a')], { expiresAt: 1_800_003_600 });
    expect(limited.body.defaults[0]).toEqual({ shell: 'sh', command: 'a', limits: { expiresAt: 1_800_003_600, renewals: 1 } });
    const permanent = nextPolicyBodyRenewMany(base, ctx, [ref(2, 'b')], undefined);
    expect(permanent.body.defaults[1]).toEqual(exact('b'));
  });

  it('works in the own list of a peer and keeps the other lists byte for byte', () => {
    const r = nextPolicyBodyRenewMany(current(), ctx, [ref(2, 'p2', PEER)], { maxCalls: 9 });
    expect(r.body.peers[PEER]?.[1]).toEqual({ shell: 'sh', command: 'p2', limits: { maxCalls: 9, renewals: 1 } });
    expect(r.body.defaults).toEqual(current().defaults);
  });

  it('keeps a typed entry typed (the template is kept as signed)', () => {
    const typed: PolicyEntry = { shell: 'sh', template: 'orch logs <j:name>' };
    const r = nextPolicyBodyRenewMany(current({ defaults: [typed] }), ctx, [ref(1, 'orch logs <j:name>')], { maxCalls: 1 });
    expect(r.body.defaults[0]).toEqual({ shell: 'sh', template: 'orch logs <j:name>', limits: { maxCalls: 1, renewals: 1 } });
  });

  it('one renewal gives exactly what nextPolicyBody renew gives', () => {
    const base = current({ defaults: [exact('a', { maxCalls: 2 })] });
    const many = nextPolicyBodyRenewMany(base, ctx, [ref(1, 'a')], { maxCalls: 7 });
    const single = nextPolicyBody(base, ctx, { kind: 'allow', renew: true, entry: exact('a', { maxCalls: 7 }) });
    expect(single.changed && many.body).toEqual(single.changed && single.body);
  });

  it('refuses a moved list and an empty selection, with the fix', () => {
    expect(messageOf(() => nextPolicyBodyRenewMany(current(), ctx, [ref(1, 'nope')], { maxCalls: 1 }))).toMatch(/Refresh the page/);
    expect(messageOf(() => nextPolicyBodyRenewMany(current(), ctx, [], { maxCalls: 1 }))).toMatch(/at least one entry/);
  });
});
