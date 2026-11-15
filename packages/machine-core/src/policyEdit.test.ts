import { describe, expect, it } from 'vitest';
import { assertPolicyBody, type PolicyBody } from './policy.js';
import { nextPolicyBody } from './policyEdit.js';

const TARGET = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const ctx = { target: TARGET, adminKeyId: 'a'.repeat(32), now: 1_800_000_000 };

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

describe('nextPolicyBody: the next signed version of a policy, built from the current one (decision 54)', () => {
  it('without a current policy the first version is 1, edited from 0, and valid', () => {
    const r = nextPolicyBody(undefined, ctx, { kind: 'allow', entry: { shell: 'sh', command: 'echo hi' } });
    expect(r.changed).toBe(true);
    if (!r.changed) return;
    expect(r.body).toMatchObject({ v: 1, target: TARGET, version: 1, baseVersion: 0, adminKeyId: ctx.adminKeyId, issuedAt: ctx.now, notBefore: ctx.now, defaults: [{ shell: 'sh', command: 'echo hi' }], peers: {} });
    expect(r.body.notAfter).toBeGreaterThan(ctx.now);
    expect(() => assertPolicyBody(r.body)).not.toThrow();
    expect(r.added).toEqual([{ shell: 'sh', command: 'echo hi' }]);
    expect(r.removed).toEqual([]);
  });

  it('with a current policy: version + 1, base = the current version, existing entries kept, new entry last', () => {
    const r = nextPolicyBody(current(), ctx, { kind: 'allow', entry: { shell: 'ps', command: 'Get-Date' } });
    expect(r.changed).toBe(true);
    if (!r.changed) return;
    expect(r.body.version).toBe(4);
    expect(r.body.baseVersion).toBe(3);
    expect(r.body.defaults).toEqual([
      { shell: 'sh', command: 'uptime' },
      { shell: 'ps', command: 'Get-Date' },
    ]);
    expect(() => assertPolicyBody(r.body)).not.toThrow();
  });

  it('allowing what is already allowed changes nothing (no new version)', () => {
    expect(nextPolicyBody(current(), ctx, { kind: 'allow', entry: { shell: 'sh', command: 'uptime' } })).toEqual({ changed: false, reason: 'already-allowed' });
  });

  it('the same command in another shell is another entry', () => {
    const r = nextPolicyBody(current(), ctx, { kind: 'allow', entry: { shell: 'bash', command: 'uptime' } });
    expect(r.changed).toBe(true);
  });

  it('removes an entry by command (every shell) or by shell and command, and says what went', () => {
    const base = current({ defaults: [{ shell: 'sh', command: 'uptime' }, { shell: 'bash', command: 'uptime' }, { shell: 'sh', command: 'df' }] });
    const all = nextPolicyBody(base, ctx, { kind: 'remove', command: 'uptime' });
    expect(all.changed && all.body.defaults).toEqual([{ shell: 'sh', command: 'df' }]);
    expect(all.changed && all.removed).toHaveLength(2);
    const one = nextPolicyBody(base, ctx, { kind: 'remove', command: 'uptime', shell: 'bash' });
    expect(one.changed && one.body.defaults).toEqual([{ shell: 'sh', command: 'uptime' }, { shell: 'sh', command: 'df' }]);
  });

  it('removing what is not allowed changes nothing', () => {
    expect(nextPolicyBody(current(), ctx, { kind: 'remove', command: 'nope' })).toEqual({ changed: false, reason: 'not-allowed' });
    expect(nextPolicyBody(undefined, ctx, { kind: 'remove', command: 'nope' })).toEqual({ changed: false, reason: 'not-allowed' });
  });

  it('per-peer lists are kept untouched and reported: the change does not apply to those peers', () => {
    const base = current({ peers: { [PEER]: [{ shell: 'sh', command: 'ls' }] } });
    const r = nextPolicyBody(base, ctx, { kind: 'allow', entry: { shell: 'sh', command: 'df' } });
    expect(r.changed).toBe(true);
    if (!r.changed) return;
    expect(r.body.peers).toEqual({ [PEER]: [{ shell: 'sh', command: 'ls' }] });
    expect(r.peersWithOwnList).toEqual([PEER]);
  });

  it('limits of kept entries are kept, and the input is never mutated', () => {
    const base = current({ defaults: [{ shell: 'sh', command: 'uptime', limits: { maxCalls: 5 } }] });
    const copy = JSON.parse(JSON.stringify(base)) as PolicyBody;
    const r = nextPolicyBody(base, ctx, { kind: 'allow', entry: { shell: 'sh', command: 'df' } });
    expect(r.changed && r.body.defaults[0]).toEqual({ shell: 'sh', command: 'uptime', limits: { maxCalls: 5 } });
    expect(base).toEqual(copy);
  });

  it('refuses a current policy written for another machine', () => {
    expect(() => nextPolicyBody(current({ target: PEER }), ctx, { kind: 'allow', entry: { shell: 'sh', command: 'df' } })).toThrow(/another machine/);
  });
});
