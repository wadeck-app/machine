import { describe, expect, it } from 'vitest';
import { assertPolicyBody, authorize, entryKey, renewalNote, type PolicyBody, type PolicyEntry } from './policy.js';
import { nextPolicyBody } from './policyEdit.js';

// Renewal of an exhausted or expired entry (hold-for-approval.md, "Renewal"): the refusal says WHICH entry would be renewed, the Allow replaces that
// entry in one policy, and the counter of a replaced entry starts again while the counter of an untouched entry is kept.

const NOW = 1_800_000_000;
const TARGET = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const PEER = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';
const ctx = { target: TARGET, adminKeyId: 'a'.repeat(32), now: NOW };

const body = (defaults: PolicyEntry[], peers: Record<string, PolicyEntry[]> = {}): PolicyBody => ({
  v: 1,
  target: TARGET,
  version: 3,
  baseVersion: 2,
  adminKeyId: 'a'.repeat(32),
  issuedAt: NOW,
  notBefore: NOW - 60,
  notAfter: NOW + 3600,
  defaults,
  peers,
});

describe('authorize: the refusal of an exhausted or expired entry names the entry to renew', () => {
  it('exhausted: the shell, the text, the limit and the calls used', () => {
    const entry: PolicyEntry = { shell: 'sh', command: 'orch stop', limits: { maxCalls: 1 } };
    const used = (k: string): number => (k === entryKey('default', entry) ? 1 : 0);
    const d = authorize(body([entry]), PEER, { shell: 'sh', command: 'orch stop' }, NOW, used);
    expect(d).toMatchObject({ allowed: false, reason: 'exhausted', renewal: { reason: 'exhausted', entry: 'orch stop', typed: false, own: false, maxCalls: 1, used: 1 } });
    if (d.allowed || d.renewal === undefined) {
      throw new Error('expected a renewal');
    }
    expect(renewalNote(d.renewal)).toBe('entry used 1 of 1 call(s)');
  });

  it('expired: the instant, and the template of a typed entry', () => {
    const entry: PolicyEntry = { shell: 'sh', template: 'orch logs <j:name>', limits: { expiresAt: NOW - 5 } };
    const p = { ...body([entry]), v: 2 as const };
    const d = authorize(p, PEER, { shell: 'sh', command: 'orch logs abc' }, NOW, () => 0);
    expect(d).toMatchObject({ allowed: false, reason: 'expired', renewal: { reason: 'expired', entry: 'orch logs <j:name>', typed: true, own: false, expiresAt: NOW - 5 } });
    if (d.allowed || d.renewal === undefined) {
      throw new Error('expected a renewal');
    }
    expect(renewalNote(d.renewal)).toBe(`expired at ${new Date((NOW - 5) * 1000).toISOString()}`);
  });

  it('own list: says so (the renewal edits that list)', () => {
    const entry: PolicyEntry = { shell: 'sh', command: 'x', limits: { expiresAt: NOW - 1 } };
    const d = authorize(body([], { [PEER]: [entry] }), PEER, { shell: 'sh', command: 'x' }, NOW, () => 0);
    expect(d).toMatchObject({ reason: 'expired', renewal: { own: true } });
  });

  it('not-listed carries no renewal', () => {
    const d = authorize(body([]), PEER, { shell: 'sh', command: 'x' }, NOW, () => 0);
    expect(d).toMatchObject({ allowed: false, reason: 'not-listed' });
    expect((d as { renewal?: unknown }).renewal).toBeUndefined();
  });
});

describe('the counter of a renewed entry', () => {
  const base = { shell: 'sh' as const, command: 'orch stop' };

  it('the generation (limits.renewals) is part of the key: a replaced entry starts at 0, an untouched one keeps its key', () => {
    const plain = entryKey('default', { ...base, limits: { maxCalls: 1 } });
    expect(entryKey('default', { ...base, limits: { maxCalls: 1 } })).toBe(plain);
    expect(entryKey('default', { ...base, limits: { maxCalls: 1, renewals: 1 } })).not.toBe(plain);
    expect(entryKey('default', { ...base, limits: { maxCalls: 1, renewals: 2 } })).not.toBe(entryKey('default', { ...base, limits: { maxCalls: 1, renewals: 1 } }));
  });

  it('the policy reader accepts renewals as a positive integer and refuses anything else', () => {
    const ok = { ...body([{ shell: 'sh', command: 'x', limits: { maxCalls: 1, renewals: 1 } }]), v: 2 as const };
    expect(() => assertPolicyBody(ok)).not.toThrow();
    const bad = { ...ok, defaults: [{ shell: 'sh', command: 'x', limits: { maxCalls: 1, renewals: 0 } }] };
    expect(() => assertPolicyBody(bad)).toThrow(/renewals must be a positive integer/);
  });

  it('an older reader (version 1) refuses a body that carries renewals: the body is version 2', () => {
    const v1 = body([{ shell: 'sh', command: 'x', limits: { maxCalls: 1, renewals: 1 } }]);
    expect(() => assertPolicyBody(v1)).toThrow(/renewals need version 2/);
  });
});

describe('nextPolicyBody with renew: the Allow of a renewal replaces the entry in one policy', () => {
  const exhausted: PolicyEntry = { shell: 'sh', command: 'orch stop', limits: { maxCalls: 1 } };

  it('same limits: the entry is replaced (not "already allowed"), the generation is 1, the body is version 2, one entry only', () => {
    const r = nextPolicyBody(body([exhausted]), ctx, { kind: 'allow', renew: true, entry: { shell: 'sh', command: 'orch stop', limits: { maxCalls: 1 } } });
    expect(r.changed).toBe(true);
    if (!r.changed) {
      return;
    }
    expect(r.body.defaults).toEqual([{ shell: 'sh', command: 'orch stop', limits: { maxCalls: 1, renewals: 1 } }]);
    expect(r.body.v).toBe(2);
    expect(r.added).toEqual([]);
    expect(r.renewed).toEqual([{ before: exhausted, after: r.body.defaults[0] }]);
    expect(() => assertPolicyBody(r.body)).not.toThrow();
    // The counter restarts: the old key was used up, the new one is at 0.
    expect(entryKey('default', r.body.defaults[0] as PolicyEntry)).not.toBe(entryKey('default', exhausted));
  });

  it('a second renewal bumps the generation again', () => {
    const first = nextPolicyBody(body([exhausted]), ctx, { kind: 'allow', renew: true, entry: exhausted });
    if (!first.changed) {
      throw new Error('expected a change');
    }
    const second = nextPolicyBody(first.body, ctx, { kind: 'allow', renew: true, entry: exhausted });
    if (!second.changed) {
      throw new Error('expected a change');
    }
    expect(second.body.defaults).toEqual([{ shell: 'sh', command: 'orch stop', limits: { maxCalls: 1, renewals: 2 } }]);
  });

  it('other limits chosen in the dialog: replaced with those limits, still ONE entry for the shell and the text', () => {
    const r = nextPolicyBody(body([exhausted, { shell: 'sh', command: 'uptime' }]), ctx, { kind: 'allow', renew: true, entry: { shell: 'sh', command: 'orch stop', limits: { maxCalls: 5 } } });
    if (!r.changed) {
      throw new Error('expected a change');
    }
    expect(r.body.defaults.filter((e) => e.shell === 'sh' && e.command === 'orch stop')).toHaveLength(1);
    expect(r.body.defaults[0]).toEqual({ shell: 'sh', command: 'orch stop', limits: { maxCalls: 5, renewals: 1 } });
    expect(r.body.defaults[1]).toEqual({ shell: 'sh', command: 'uptime' });
  });

  it('a permanent renewal drops the limits (and with them the counter)', () => {
    const r = nextPolicyBody(body([exhausted]), ctx, { kind: 'allow', renew: true, entry: { shell: 'sh', command: 'orch stop' } });
    if (!r.changed) {
      throw new Error('expected a change');
    }
    expect(r.body.defaults).toEqual([{ shell: 'sh', command: 'orch stop' }]);
  });

  it('a typed entry is replaced by its template', () => {
    const typed: PolicyEntry = { shell: 'sh', template: 'orch logs <j:name>', limits: { expiresAt: NOW - 5 } };
    const r = nextPolicyBody({ ...body([typed]), v: 2 }, ctx, { kind: 'allow', renew: true, entry: { shell: 'sh', template: 'orch logs <j:name>', limits: { expiresAt: NOW + 3600 } } });
    if (!r.changed) {
      throw new Error('expected a change');
    }
    expect(r.body.defaults).toEqual([{ shell: 'sh', template: 'orch logs <j:name>', limits: { expiresAt: NOW + 3600, renewals: 1 } }]);
  });

  it('own list of the peer: that list is edited, the default list is untouched', () => {
    const r = nextPolicyBody(body([{ shell: 'sh', command: 'uptime' }], { [PEER]: [exhausted] }), ctx, { kind: 'allow', renew: true, peer: PEER, entry: exhausted });
    if (!r.changed) {
      throw new Error('expected a change');
    }
    expect(r.body.defaults).toEqual([{ shell: 'sh', command: 'uptime' }]);
    expect(r.body.peers[PEER]).toEqual([{ shell: 'sh', command: 'orch stop', limits: { maxCalls: 1, renewals: 1 } }]);
  });

  it('renew of an entry that is not there is a plain add (nothing to replace)', () => {
    const r = nextPolicyBody(body([]), ctx, { kind: 'allow', renew: true, entry: exhausted });
    if (!r.changed) {
      throw new Error('expected a change');
    }
    expect(r.body.defaults).toEqual([exhausted]);
    expect(r.added).toEqual([exhausted]);
  });

  it('without renew, the same limits are still "already-allowed" and other limits still replace (the CLI without --renew)', () => {
    expect(nextPolicyBody(body([exhausted]), ctx, { kind: 'allow', entry: exhausted })).toEqual({ changed: false, reason: 'already-allowed' });
    const r = nextPolicyBody(body([exhausted]), ctx, { kind: 'allow', entry: { shell: 'sh', command: 'orch stop', limits: { maxCalls: 3 } } });
    if (!r.changed) {
      throw new Error('expected a change');
    }
    expect(r.body.defaults).toEqual([{ shell: 'sh', command: 'orch stop', limits: { maxCalls: 3 } }]);
  });
});
