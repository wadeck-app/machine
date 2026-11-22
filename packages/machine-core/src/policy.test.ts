import { describe, expect, it } from 'vitest';
import { NOT_YET_VALID_LEEWAY_SECONDS } from './clockSkew.js';
import { generateSigningKeyPair, keyId } from './keys.js';
import { applyPolicy, authorize, commandTextProblem, entryKey, signPolicy, type PolicyBody, type PolicyEntry } from './policy.js';

const NOW = 1_800_000_000;
const TARGET = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const PEER = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';
const OTHER_PEER = '11111111-2222-4333-8444-555555555555';

function setup(overrides: Partial<PolicyBody> = {}) {
  const admin = generateSigningKeyPair();
  const body: PolicyBody = {
    v: 1,
    target: TARGET,
    version: 1,
    baseVersion: 0,
    adminKeyId: keyId(admin.publicKey),
    issuedAt: NOW,
    notBefore: NOW - 60,
    notAfter: NOW + 3600,
    defaults: [{ shell: 'cmd', command: 'ipconfig' }],
    peers: {},
    ...overrides,
  };
  return { admin, body };
}

const ctx = (admin: { publicKey: string }, extra = {}) => ({ adminPublicKey: admin.publicKey, now: NOW, targetUuid: TARGET, ...extra });

describe('applyPolicy (compare-and-set, decision 27)', () => {
  it('applies a first policy based on version 0', () => {
    const { admin, body } = setup();
    const result = applyPolicy({ version: 0, highestSeen: 0 }, signPolicy(body, admin.privateKeyPkcs8), ctx(admin));
    expect(result).toEqual({ ok: true, body });
  });

  it('refuses a policy edited from an older version, with a reload message', () => {
    const { admin, body } = setup({ version: 3, baseVersion: 2 });
    const result = applyPolicy({ version: 4, highestSeen: 4 }, signPolicy(body, admin.privateKeyPkcs8), ctx(admin));
    expect(result).toMatchObject({ ok: false, reason: 'stale-base' });
    if (!result.ok) expect(result.message).toMatch(/policy changed, reload.*version 4.*version 2/);
  });

  it('refuses a rollback even when the base matches (the highest version ever seen is kept apart)', () => {
    const { admin, body } = setup({ version: 2, baseVersion: 1 });
    // Local store was wiped to version 1, but the separate record knows version 5 was applied once.
    const result = applyPolicy({ version: 1, highestSeen: 5 }, signPolicy(body, admin.privateKeyPkcs8), ctx(admin));
    expect(result).toMatchObject({ ok: false, reason: 'rollback' });
  });

  it('refuses a policy written for another machine', () => {
    const { admin, body } = setup({ target: OTHER_PEER });
    const result = applyPolicy({ version: 0, highestSeen: 0 }, signPolicy(body, admin.privateKeyPkcs8), ctx(admin));
    expect(result).toMatchObject({ ok: false, reason: 'wrong-target' });
  });

  it('refuses a policy outside its application window', () => {
    const early = setup({ notBefore: NOW + NOT_YET_VALID_LEEWAY_SECONDS + 1 });
    const late = setup({ notAfter: NOW - 1 });
    expect(applyPolicy({ version: 0, highestSeen: 0 }, signPolicy(early.body, early.admin.privateKeyPkcs8), ctx(early.admin))).toMatchObject({ ok: false, reason: 'not-yet-valid' });
    expect(applyPolicy({ version: 0, highestSeen: 0 }, signPolicy(late.body, late.admin.privateKeyPkcs8), ctx(late.admin))).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('accepts a policy up to the leeway before its notBefore (a clock a little behind), and refuses one second more', () => {
    const edge = setup({ notBefore: NOW + NOT_YET_VALID_LEEWAY_SECONDS });
    const over = setup({ notBefore: NOW + NOT_YET_VALID_LEEWAY_SECONDS + 1 });
    expect(applyPolicy({ version: 0, highestSeen: 0 }, signPolicy(edge.body, edge.admin.privateKeyPkcs8), ctx(edge.admin))).toMatchObject({ ok: true });
    const refused = applyPolicy({ version: 0, highestSeen: 0 }, signPolicy(over.body, over.admin.privateKeyPkcs8), ctx(over.admin));
    expect(refused).toMatchObject({ ok: false, reason: 'not-yet-valid' });
    // The message says by how much and names the fix, not just "check the clocks".
    if (!refused.ok) expect(refused.message).toMatch(/2 min 1 s.*time sync/);
  });

  it('the leeway does not touch the expiry side, nor the compare-and-set rules', () => {
    const expired = setup({ notAfter: NOW - 1 });
    expect(applyPolicy({ version: 0, highestSeen: 0 }, signPolicy(expired.body, expired.admin.privateKeyPkcs8), ctx(expired.admin))).toMatchObject({ ok: false, reason: 'expired' });
    const early = setup({ notBefore: NOW + NOT_YET_VALID_LEEWAY_SECONDS, version: 3, baseVersion: 2 });
    expect(applyPolicy({ version: 4, highestSeen: 4 }, signPolicy(early.body, early.admin.privateKeyPkcs8), ctx(early.admin))).toMatchObject({ ok: false, reason: 'stale-base' });
  });

  it('refuses a tampered policy and a policy signed by another admin key', () => {
    const { admin, body } = setup();
    const signed = signPolicy(body, admin.privateKeyPkcs8);
    const tampered = { ...signed, body: { ...signed.body, defaults: [{ shell: 'cmd' as const, command: 'del *' }] } };
    expect(applyPolicy({ version: 0, highestSeen: 0 }, tampered, ctx(admin))).toMatchObject({ ok: false, reason: 'bad-signature' });
    const other = generateSigningKeyPair();
    expect(applyPolicy({ version: 0, highestSeen: 0 }, signed, ctx(other))).toMatchObject({ ok: false, reason: 'wrong-admin-key' });
  });

  it('refuses to sign a body whose version is not base + 1', () => {
    const { admin, body } = setup({ version: 3, baseVersion: 1 });
    expect(() => signPolicy(body, admin.privateKeyPkcs8)).toThrow(/version must be baseVersion \+ 1/);
  });
});

describe('policy entries (strict exact commands, T-15)', () => {
  const bad = (entry: unknown) => {
    const { admin, body } = setup({ defaults: [entry as PolicyEntry] });
    return () => signPolicy(body, admin.privateKeyPkcs8);
  };

  it('refuses control characters, non-ASCII, empty and oversized commands', () => {
    expect(bad({ shell: 'cmd', command: 'dir\r\ndel x' })).toThrow(/printable ASCII/);
    expect(bad({ shell: 'cmd', command: 'echo é' })).toThrow(/printable ASCII/);
    expect(bad({ shell: 'cmd', command: '' })).toThrow(/command/);
    expect(bad({ shell: 'cmd', command: 'a'.repeat(2049) })).toThrow(/2048/);
  });

  it('refuses an unknown shell, unknown fields and bad limits', () => {
    expect(bad({ shell: 'fish', command: 'ls' })).toThrow(/shell/);
    expect(bad({ shell: 'cmd', command: 'dir', extra: 1 })).toThrow(/unknown field.*extra/);
    expect(bad({ shell: 'cmd', command: 'dir', limits: { maxCalls: 0 } })).toThrow(/maxCalls/);
    expect(bad({ shell: 'cmd', command: 'dir', limits: { expiresAt: 1.5 } })).toThrow(/expiresAt/);
  });

  it('refuses the same entry twice in one list', () => {
    const { admin, body } = setup({ defaults: [{ shell: 'cmd', command: 'dir' }, { shell: 'cmd', command: 'dir' }] });
    expect(() => signPolicy(body, admin.privateKeyPkcs8)).toThrow(/duplicate/);
  });
});

describe('authorize', () => {
  const policy = (extra: Partial<PolicyBody> = {}) => setup(extra).body;
  const unused = () => 0;

  it('allows an exact entry of the default list', () => {
    const decision = authorize(policy(), PEER, { shell: 'cmd', command: 'ipconfig' }, NOW, unused);
    expect(decision).toMatchObject({ allowed: true });
  });

  it('denies anything not listed, with the exact string and the fix', () => {
    const decision = authorize(policy(), PEER, { shell: 'cmd', command: 'ipconfig /all' }, NOW, unused);
    expect(decision).toMatchObject({ allowed: false, reason: 'not-listed' });
    if (!decision.allowed) expect(decision.message).toContain('ipconfig /all');
  });

  it('names the other shell when the SAME command is listed under it (the refusal reveals only what the caller already sent)', () => {
    const p = policy({ defaults: [{ shell: 'sh', command: 'ls' }, { shell: 'bash', command: 'ls' }, { shell: 'sh', command: 'uptime' }] });
    const decision = authorize(p, PEER, { shell: 'cmd', command: 'ls' }, NOW, unused, 'admin', 'thinkcentre');
    expect(decision).toMatchObject({ allowed: false, reason: 'not-listed', allowedShells: ['sh', 'bash'] });
    if (decision.allowed) throw new Error('expected a refusal');
    expect(decision.message).toBe('"ls" is allowed with shell sh or bash, not with cmd: run machine run thinkcentre --shell sh -- ls (or: machine peer connect thinkcentre --shell sh to make it the default)');
    // Never another command of the list.
    expect(decision.message).not.toContain('uptime');
  });

  it('quotes a command with spaces in the hint, and says <machine> when the name is unknown', () => {
    const p = policy({ defaults: [{ shell: 'sh', command: 'ls -la' }] });
    const decision = authorize(p, PEER, { shell: 'cmd', command: 'ls -la' }, NOW, unused);
    if (decision.allowed) throw new Error('expected a refusal');
    expect(decision.message).toContain('run machine run <machine> --shell sh -- "ls -la"');
  });

  it('gives no hint when the command is listed nowhere, or only in the list another peer uses', () => {
    const p = policy({ defaults: [{ shell: 'sh', command: 'ls' }], peers: { [PEER]: [{ shell: 'sh', command: 'pwd' }] } });
    const none = authorize(p, PEER, { shell: 'cmd', command: 'ls' }, NOW, unused, 'admin', 'thinkcentre');
    if (none.allowed) throw new Error('expected a refusal');
    expect(none).not.toHaveProperty('allowedShells');
    expect(none.message).toContain('must add this exact string to the peer list');
    expect(none.message).not.toContain('is allowed with shell');
  });

  it('does not normalize: case, trailing space and another shell all miss', () => {
    for (const request of [{ shell: 'cmd' as const, command: 'IPCONFIG' }, { shell: 'cmd' as const, command: 'ipconfig ' }, { shell: 'ps' as const, command: 'ipconfig' }]) {
      expect(authorize(policy(), PEER, request, NOW, unused)).toMatchObject({ allowed: false, reason: 'not-listed' });
    }
  });

  it('refuses a request with control or non-ASCII characters before matching', () => {
    expect(authorize(policy(), PEER, { shell: 'cmd', command: 'ipconfig\u0000' }, NOW, unused)).toMatchObject({ allowed: false, reason: 'invalid-request' });
    expect(authorize(policy(), PEER, { shell: 'cmd', command: 'ipconfıg' }, NOW, unused)).toMatchObject({ allowed: false, reason: 'invalid-request' });
  });

  it('lets a per-peer list REPLACE the default for that peer only', () => {
    const p = policy({ peers: { [PEER]: [{ shell: 'ps', command: 'ls' }] } });
    expect(authorize(p, PEER, { shell: 'cmd', command: 'ipconfig' }, NOW, unused)).toMatchObject({ allowed: false, reason: 'not-listed' });
    expect(authorize(p, PEER, { shell: 'ps', command: 'ls' }, NOW, unused)).toMatchObject({ allowed: true });
    expect(authorize(p, OTHER_PEER, { shell: 'cmd', command: 'ipconfig' }, NOW, unused)).toMatchObject({ allowed: true });
  });

  it('an empty per-peer list blocks that peer completely', () => {
    const p = policy({ peers: { [PEER]: [] } });
    expect(authorize(p, PEER, { shell: 'cmd', command: 'ipconfig' }, NOW, unused)).toMatchObject({ allowed: false });
  });

  it('enforces the expiry of an entry', () => {
    const p = policy({ defaults: [{ shell: 'cmd', command: 'ipconfig', limits: { expiresAt: NOW + 10 } }] });
    expect(authorize(p, PEER, { shell: 'cmd', command: 'ipconfig' }, NOW + 10, unused)).toMatchObject({ allowed: true });
    expect(authorize(p, PEER, { shell: 'cmd', command: 'ipconfig' }, NOW + 11, unused)).toMatchObject({ allowed: false, reason: 'expired' });
  });

  it('enforces the maximum number of calls using the usage reader', () => {
    const p = policy({ defaults: [{ shell: 'cmd', command: 'ipconfig', limits: { maxCalls: 2 } }] });
    const key = entryKey('default', { shell: 'cmd', command: 'ipconfig', limits: { maxCalls: 2 } });
    expect(authorize(p, PEER, { shell: 'cmd', command: 'ipconfig' }, NOW, k => (k === key ? 1 : 0))).toMatchObject({ allowed: true, entryKey: key });
    expect(authorize(p, PEER, { shell: 'cmd', command: 'ipconfig' }, NOW, k => (k === key ? 2 : 0))).toMatchObject({ allowed: false, reason: 'exhausted' });
  });

  it('keeps default counters apart from per-peer counters', () => {
    expect(entryKey('default', { shell: 'cmd', command: 'x' })).not.toBe(entryKey(PEER, { shell: 'cmd', command: 'x' }));
  });
});

describe('policy edge cases (review findings)', () => {
  it('reports a broken pinned admin key as a result', () => {
    const { admin, body } = setup();
    const signed = signPolicy(body, admin.privateKeyPkcs8);
    expect(applyPolicy({ version: 0, highestSeen: 0 }, signed, { adminPublicKey: 'garbage', now: NOW, targetUuid: TARGET })).toMatchObject({ ok: false, reason: 'invalid-admin-key' });
  });

  it('refuses an undefined limits field at validation time, not later in the signature layer', () => {
    const first = setup({ defaults: [{ shell: 'cmd', command: 'dir', limits: undefined }] });
    expect(() => signPolicy(first.body, first.admin.privateKeyPkcs8)).toThrow(/limits.*omitted/);
    const second = setup({ defaults: [{ shell: 'cmd', command: 'dir', limits: { maxCalls: undefined, expiresAt: NOW + 5 } }] });
    expect(() => signPolicy(second.body, second.admin.privateKeyPkcs8)).toThrow(/maxCalls.*omitted/);
  });

  it('starts a fresh counter when the admin changes the limits of an entry (renewal) and keeps it when nothing changes', () => {
    const base = { shell: 'cmd' as const, command: 'ipconfig' };
    const same = entryKey('default', { ...base, limits: { maxCalls: 3 } });
    expect(entryKey('default', { ...base, limits: { maxCalls: 3 } })).toBe(same);
    expect(entryKey('default', { ...base, limits: { maxCalls: 10 } })).not.toBe(same);
    expect(entryKey('default', { ...base, limits: { maxCalls: 3, expiresAt: NOW + 5 } })).not.toBe(same);
    expect(entryKey('default', base)).not.toBe(same);
  });

  it('renewing a limit really lets the command run again', () => {
    const withLimits = (limits: { maxCalls: number }) => setup({ defaults: [{ shell: 'cmd', command: 'ipconfig', limits }] }).body;
    const exhausted = withLimits({ maxCalls: 3 });
    const usedUnderOldKey = (k: string) => (k === entryKey('default', exhausted.defaults[0] as PolicyEntry) ? 3 : 0);
    expect(authorize(exhausted, PEER, { shell: 'cmd', command: 'ipconfig' }, NOW, usedUnderOldKey)).toMatchObject({ allowed: false, reason: 'exhausted' });
    expect(authorize(withLimits({ maxCalls: 10 }), PEER, { shell: 'cmd', command: 'ipconfig' }, NOW, usedUnderOldKey)).toMatchObject({ allowed: true });
  });
});

describe('commandTextProblem (shared by the policy and the launcher)', () => {
  it('accepts a plain command', () => {
    expect(commandTextProblem('ipconfig /all')).toBeUndefined();
  });
  it.each([
    ['', /empty/],
    ['x'.repeat(2049), /longer than 2048/],
    ['echo a\necho b', /printable ASCII/],
    ['echo café', /printable ASCII/],
    ['echo \u0000', /printable ASCII/],
  ])('refuses %j', (text, message) => {
    expect(commandTextProblem(text)).toMatch(message);
  });
});
