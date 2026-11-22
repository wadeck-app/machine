import { describe, expect, it } from 'vitest';
import { assertPolicyBody, type PolicyBody, type PolicyEntry } from './policy.js';
import { entryFromText, nextPolicyBody, nextPolicyBodyMany, POLICY_MAX_ENTRIES_PER_LIST } from './policyEdit.js';

// Several entries in ONE policy (inline mode of the Requests page: the owner selects several held requests and signs once).

const TARGET = '11111111-1111-4111-8111-111111111111';
const ctx = { target: TARGET, adminKeyId: 'a'.repeat(32), now: 1_800_000_000 };
const exact = (command: string, limits?: PolicyEntry['limits']): PolicyEntry => ({ shell: 'sh', command, ...(limits ? { limits } : {}) });

const current = (over: Partial<PolicyBody> = {}): PolicyBody => ({
  v: 1,
  target: TARGET,
  version: 3,
  baseVersion: 2,
  adminKeyId: 'a'.repeat(32),
  issuedAt: 1_700_000_000,
  notBefore: 1_700_000_000,
  notAfter: 1_700_600_000,
  defaults: [{ shell: 'sh', command: 'uptime' }],
  peers: {},
  ...over,
});

describe('nextPolicyBodyMany: one policy version carrying several entries', () => {
  it('adds all entries in ONE version (current + 1, edited from the current one), in order, and the body is valid', () => {
    const r = nextPolicyBodyMany(current(), ctx, [exact('echo a'), exact('echo b'), exact('echo c')]);
    expect(r.changed).toBe(true);
    if (!r.changed) {
      return;
    }
    expect(r.body).toMatchObject({ version: 4, baseVersion: 3, issuedAt: ctx.now, notBefore: ctx.now });
    expect(r.body.defaults.map((e) => e.command)).toEqual(['uptime', 'echo a', 'echo b', 'echo c']);
    expect(r.added).toHaveLength(3);
    expect(() => assertPolicyBody(r.body)).not.toThrow();
  });

  it('from no policy: version 1 edited from 0', () => {
    const r = nextPolicyBodyMany(undefined, ctx, [exact('echo a'), exact('echo b')]);
    expect(r.changed && r.body).toMatchObject({ version: 1, baseVersion: 0 });
  });

  it('one entry gives exactly what nextPolicyBody gives', () => {
    const one = nextPolicyBodyMany(current(), ctx, [exact('echo a', { maxCalls: 1 })]);
    const single = nextPolicyBody(current(), ctx, { kind: 'allow', entry: exact('echo a', { maxCalls: 1 }) });
    expect(one.changed && single.changed && one.body).toEqual(single.changed && single.body);
  });

  it('two selected requests with the same text and shell are ONE entry; an entry already allowed is skipped, not an error', () => {
    const r = nextPolicyBodyMany(current(), ctx, [exact('echo a'), exact('echo a'), exact('uptime')]);
    expect(r.changed).toBe(true);
    if (!r.changed) {
      return;
    }
    expect(r.body.defaults.map((e) => e.command)).toEqual(['uptime', 'echo a']);
    expect(r.skipped.map((e) => e.command)).toEqual(['echo a', 'uptime']);
  });

  it('nothing to sign when every entry is already allowed', () => {
    expect(nextPolicyBodyMany(current(), ctx, [exact('uptime')])).toEqual({ changed: false, reason: 'already-allowed' });
  });

  it('an entry with other limits renews the existing one (reported as renewed)', () => {
    const r = nextPolicyBodyMany(current({ defaults: [exact('uptime', { maxCalls: 1 })] }), ctx, [exact('uptime', { maxCalls: 5 }), exact('echo a')]);
    expect(r.changed).toBe(true);
    if (!r.changed) {
      return;
    }
    expect(r.renewed).toHaveLength(1);
    expect(r.body.defaults).toEqual([exact('uptime', { maxCalls: 5 }), exact('echo a')]);
  });

  it('typed entries make the policy version 2, exact only stays version 1', () => {
    const typed = nextPolicyBodyMany(current(), ctx, [exact('echo a'), entryFromText('orch logs <j:name>', 'sh')]);
    expect(typed.changed && typed.body.v).toBe(2);
    const plain = nextPolicyBodyMany(current(), ctx, [exact('echo a')]);
    expect(plain.changed && plain.body.v).toBe(1);
  });

  it('an entry refused by the typed grammar throws and nothing is built: the others are not signed either', () => {
    const bad: PolicyEntry = { shell: 'sh', command: 'echo <oops>' };
    expect(() => nextPolicyBodyMany(current(), ctx, [exact('echo a'), bad])).toThrow(/angle bracket/);
  });

  it('refuses more entries than a list can hold, with the numbers and the fix', () => {
    const full = current({ defaults: Array.from({ length: POLICY_MAX_ENTRIES_PER_LIST - 1 }, (_, i) => exact(`echo ${i}`)) });
    expect(() => nextPolicyBodyMany(full, ctx, [exact('echo x'), exact('echo y')])).toThrow(new RegExp(`at most ${POLICY_MAX_ENTRIES_PER_LIST}.*allow fewer`));
    expect(nextPolicyBodyMany(full, ctx, [exact('echo x')]).changed).toBe(true);
  });

  it('refuses a policy written for another machine', () => {
    expect(() => nextPolicyBodyMany(current({ target: '99999999-9999-4999-8999-999999999999' }), ctx, [exact('echo a')])).toThrow(/another machine/);
  });

  it('is empty-safe: no entries is an error naming the cause', () => {
    expect(() => nextPolicyBodyMany(current(), ctx, [])).toThrow(/at least one entry/);
  });
});
