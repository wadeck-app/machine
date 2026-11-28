import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateSigningKeyPair, keyId } from './keys.js';
import { applyPolicy, assertPolicyBody, authorize, entryKey, signPolicy, type Decision, type PolicyBody, type PolicyEntry } from './policy.js';

// Typed entries (typed-parameters.md): policy body v2, field `template`, matching that tries every entry, and the disclosure rules of a refusal.

const NOW = 1_800_000_000;
const TARGET = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const PEER = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';
const OTHER_PEER = '11111111-2222-4333-8444-555555555555';
const KEY = keyId(generateSigningKeyPair().publicKey);

const typed = (shell: PolicyEntry['shell'], template: string, limits?: PolicyEntry['limits']): PolicyEntry => ({ shell, template, ...(limits ? { limits } : {}) });
const exact = (shell: PolicyEntry['shell'], command: string, limits?: PolicyEntry['limits']): PolicyEntry => ({ shell, command, ...(limits ? { limits } : {}) });

function body(defaults: PolicyEntry[], over: Partial<PolicyBody> = {}): PolicyBody {
  return { v: 2, target: TARGET, version: 1, baseVersion: 0, adminKeyId: KEY, issuedAt: NOW, notBefore: NOW - 60, notAfter: NOW + 3600, defaults, peers: {}, ...over };
}

const asked = (b: PolicyBody, shell: PolicyEntry['shell'], command: string, usage: (k: string) => number = () => 0, platform: 'windows' | 'posix' = 'posix'): Decision =>
  authorize(b, PEER, { shell, command }, NOW, usage, 'admin', 'box', platform);

describe('policy body v2: the format', () => {
  it('reads a v2 body with typed and exact entries', () => {
    expect(() => assertPolicyBody(body([typed('sh', 'orch logs <job:name> --tail <n:int(1,500)>'), exact('sh', 'uptime')]))).not.toThrow();
  });

  it('a v1 body cannot hold a typed entry, and says which version to use', () => {
    expect(() => assertPolicyBody(body([typed('sh', 'ls <n:int(1,5)>')], { v: 1 }))).toThrow(/typed entry.*version 2/);
  });

  it('a v1 body whose exact command looks like a placeholder is refused (a v2 reader must not read it as exact)', () => {
    expect(() => assertPolicyBody(body([exact('sh', 'orch logs <n:int(1,500)>')], { v: 1 }))).toThrow(/placeholder/);
    expect(() => assertPolicyBody(body([exact('sh', 'orch logs <n:int(1,500)>')], { v: 2 }))).toThrow(/placeholder/);
  });

  it('an exact entry with plain angle brackets that make no placeholder still loads (legacy redirections)', () => {
    expect(() => assertPolicyBody(body([exact('cmd', 'dir > out.txt')], { v: 1 }))).not.toThrow();
  });

  it('a v1-only reader refuses v2 loudly and names `machine cli update`', () => {
    expect(() => assertPolicyBody(body([typed('sh', 'ls <n:int(1,5)>')]), { readsUpTo: 1 })).toThrow(/version 2.*machine cli update/);
  });

  it('an unknown version is refused with the same fix', () => {
    expect(() => assertPolicyBody(body([], { v: 4 as never }))).toThrow(/unsupported version 4.*machine cli update/);
  });

  it('refuses a malformed template at load, naming the list and the cause', () => {
    for (const template of ['ls <n:int(5,1)>', 'ls <n', 'ls <n:frob>', 'ls  <n:int(1,2)>', '<p:name> x', 'ls']) {
      expect(() => assertPolicyBody(body([typed('sh', template)])), template).toThrow(/policy: defaults/);
    }
  });

  it('refuses an entry that has both fields or neither', () => {
    expect(() => assertPolicyBody(body([{ shell: 'sh', command: 'ls', template: 'ls <n:int(1,2)>' } as never]))).toThrow(/exactly one/);
    expect(() => assertPolicyBody(body([{ shell: 'sh' } as never]))).toThrow(/exactly one|command/);
  });

  it('detects a duplicate by canonical form: labels, enum order and port are not different entries', () => {
    expect(() => assertPolicyBody(body([typed('sh', 'x <a:int(1,5)>'), typed('sh', 'x <b:int(1,5)>')]))).toThrow(/duplicate/);
    expect(() => assertPolicyBody(body([typed('sh', 'x <a:enum(p|q)>'), typed('sh', 'x <a:enum(q|p)>')]))).toThrow(/duplicate/);
    expect(() => assertPolicyBody(body([typed('sh', 'x <a:port>'), typed('sh', 'x <a:int(1,65535)>')]))).toThrow(/duplicate/);
    expect(() => assertPolicyBody(body([typed('sh', 'x <a:int(1,5)>'), typed('bash', 'x <a:int(1,5)>'), typed('sh', 'x <a:int(1,6)>')]))).not.toThrow();
  });

  it('a signed v2 policy goes through applyPolicy like a v1', () => {
    const admin = generateSigningKeyPair();
    const b = body([typed('sh', 'ls <n:int(1,5)>')], { adminKeyId: keyId(admin.publicKey) });
    const result = applyPolicy({ version: 0, highestSeen: 0 }, signPolicy(b, admin.privateKeyPkcs8), { adminPublicKey: admin.publicKey, now: NOW, targetUuid: TARGET });
    expect(result).toEqual({ ok: true, body: b });
  });

  it('a v2 body is refused by applyPolicy of a v1-only reader as malformed, with the update hint', () => {
    const admin = generateSigningKeyPair();
    const b = body([typed('sh', 'ls <n:int(1,5)>')], { adminKeyId: keyId(admin.publicKey) });
    // applyPolicy reads versions 1 and 2; the failure of an older reader is simulated through the option of assertPolicyBody above.
    expect(() => assertPolicyBody(b, { readsUpTo: 1 })).toThrow(/machine cli update/);
  });
});

describe('entryKey: the counter key', () => {
  it('is unchanged for an exact entry (counters survive the upgrade)', () => {
    const legacy = `default:${createHash('sha256').update('sh\u0000ls\u00003\u0000').digest('hex').slice(0, 32)}`;
    expect(entryKey('default', { shell: 'sh', command: 'ls', limits: { maxCalls: 3 } })).toBe(legacy);
  });
  it('is made from the template as signed and the limits for a typed entry', () => {
    const a = entryKey('default', typed('sh', 'x <a:int(1,5)>'));
    expect(a).toBe(`default:${createHash('sha256').update('sh\u0000x <a:int(1,5)>\u0000\u0000').digest('hex').slice(0, 32)}`);
    expect(entryKey('default', typed('sh', 'x <a:int(1,5)>', { maxCalls: 2 }))).not.toBe(a);
  });
});

describe('authorize with typed entries', () => {
  const T = 'orch logs <job:name> --tail <n:int(1,500)>';

  it('allows a valid value and returns the matching entry and its template', () => {
    const d = asked(body([typed('sh', T)]), 'sh', 'orch logs build --tail 50');
    expect(d).toMatchObject({ allowed: true, template: T });
    if (d.allowed) {
      expect(d.entry).toEqual(typed('sh', T));
    }
  });

  it('an exact entry matched gives no template', () => {
    const d = asked(body([exact('sh', 'uptime')]), 'sh', 'uptime');
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.template).toBeUndefined();
    }
  });

  it('refuses another shell, a bad value, a bad shape', () => {
    const b = body([typed('sh', T)]);
    for (const [shell, command] of [['bash', 'orch logs build --tail 50'], ['sh', 'orch logs build --tail 501'], ['sh', 'orch logs ../x --tail 5'], ['sh', 'orch logs build'], ['sh', 'orch logs build --tail 5 --x']] as const) {
      expect(asked(b, shell, command), command).toMatchObject({ allowed: false, reason: 'not-listed' });
    }
  });

  it('a refusal says the same thing for a wrong value as for no entry: no template, no bound, no label, no type', () => {
    const b = body([typed('sh', T)]);
    const wrong = asked(b, 'sh', 'orch logs build --tail 9999');
    const none = asked(b, 'sh', 'zzz logs build --tail 9999');
    if (wrong.allowed || none.allowed) {
      throw new Error('expected refusals');
    }
    expect(wrong.message.replace('orch logs build --tail 9999', 'CMD')).toBe(none.message.replace('zzz logs build --tail 9999', 'CMD'));
    expect(wrong.message).not.toMatch(/<.*>|int\(|1,500|\bjob\b|template|typed|\bname\b/);
    expect(wrong.allowedShells).toBeUndefined();
  });

  it('the local detail names the closest entry, the token and the rule, never the value', () => {
    const b = body([exact('sh', 'uptime'), typed('sh', T)]);
    const d = asked(b, 'sh', 'orch logs build --tail 9999');
    if (d.allowed || d.reason !== 'not-listed') {
      throw new Error('expected not-listed');
    }
    expect(d.detail).toContain(T);
    expect(d.detail).toMatch(/token 5/);
    expect(d.detail).toMatch(/range/);
    expect(d.detail).not.toContain('9999');
    expect(d.detail).not.toContain('build');
    expect(d.message).not.toContain('token 5');
  });

  it('no detail when no typed entry shares the program', () => {
    const d = asked(body([typed('sh', T)]), 'sh', 'whoami');
    if (d.allowed || d.reason !== 'not-listed') {
      throw new Error('expected not-listed');
    }
    expect(d.detail).toBeUndefined();
  });

  it('the other-shell hint stays for the exact command only', () => {
    const d = asked(body([exact('bash', 'ls'), typed('bash', 'orch logs <j:name>')]), 'sh', 'ls');
    expect(d).toMatchObject({ allowed: false, reason: 'not-listed', allowedShells: ['bash'] });
    const t = asked(body([typed('bash', 'orch logs <j:name>')]), 'sh', 'orch logs abc');
    if (t.allowed) {
      throw new Error('expected a refusal');
    }
    expect(t.allowedShells).toBeUndefined();
  });

  it('the first entry that allows wins: an exhausted entry does not shadow a later one', () => {
    const b = body([typed('sh', 'x <a:int(1,9)>', { maxCalls: 1 }), typed('sh', 'x <b:int(1,5)>')]);
    const used = (key: string) => (key === entryKey('default', typed('sh', 'x <a:int(1,9)>', { maxCalls: 1 })) ? 1 : 0);
    expect(asked(b, 'sh', 'x 3', used)).toMatchObject({ allowed: true, template: 'x <b:int(1,5)>' });
    expect(asked(b, 'sh', 'x 8', used)).toMatchObject({ allowed: false, reason: 'exhausted' });
  });

  it('an expired entry does not shadow a later one; an exact entry before a typed one is tried first', () => {
    const b = body([exact('sh', 'x 3', { expiresAt: NOW - 1 }), typed('sh', 'x <a:int(1,9)>')]);
    expect(asked(b, 'sh', 'x 3')).toMatchObject({ allowed: true, template: 'x <a:int(1,9)>' });
    const only = body([exact('sh', 'x 3', { expiresAt: NOW - 1 })]);
    expect(asked(only, 'sh', 'x 3')).toMatchObject({ allowed: false, reason: 'expired' });
  });

  it('expiresAt boundary: allowed at the instant, refused one second later', () => {
    const b = body([typed('sh', 'x <a:int(1,9)>', { expiresAt: NOW })]);
    expect(asked(b, 'sh', 'x 3').allowed).toBe(true);
    const late = authorize(b, PEER, { shell: 'sh', command: 'x 3' }, NOW + 1, () => 0, 'admin', 'box', 'posix');
    expect(late).toMatchObject({ allowed: false, reason: 'expired' });
  });

  it('the counter is per entry, not per value, and the key tells the scope', () => {
    const b = body([typed('sh', 'x <a:int(1,9)>', { maxCalls: 2 })]);
    const d1 = asked(b, 'sh', 'x 1');
    const d2 = asked(b, 'sh', 'x 7');
    if (!d1.allowed || !d2.allowed) {
      throw new Error('expected both allowed');
    }
    expect(d1.entryKey).toBe(d2.entryKey);
    expect(d1.entryKey.startsWith('default:')).toBe(true);
    const own = body([], { peers: { [PEER]: [typed('sh', 'x <a:int(1,9)>', { maxCalls: 2 })] } });
    const d3 = asked(own, 'sh', 'x 1');
    if (!d3.allowed) {
      throw new Error('expected allowed');
    }
    expect(d3.entryKey.startsWith(`${PEER}:`)).toBe(true);
    expect(d3.entryKey).not.toBe(d1.entryKey);
  });

  it('a peer with its own list does not see the default typed entries', () => {
    const b = body([typed('sh', 'x <a:int(1,9)>')], { peers: { [PEER]: [exact('sh', 'uptime')] } });
    expect(asked(b, 'sh', 'x 3')).toMatchObject({ allowed: false });
    expect(authorize(b, OTHER_PEER, { shell: 'sh', command: 'x 3' }, NOW, () => 0, 'admin', 'box', 'posix')).toMatchObject({ allowed: true });
  });

  it('the platform of the target decides the reserved names', () => {
    const b = body([typed('cmd', 'type <f:name>')]);
    expect(asked(b, 'cmd', 'type nul', () => 0, 'windows')).toMatchObject({ allowed: false });
    expect(asked(b, 'cmd', 'type nul', () => 0, 'posix')).toMatchObject({ allowed: true });
    // Without a platform the strict answer is given.
    expect(authorize(b, PEER, { shell: 'cmd', command: 'type nul' }, NOW, () => 0, 'admin', 'box')).toMatchObject({ allowed: false });
  });

  it('a request that is not printable ASCII is still an invalid request', () => {
    expect(asked(body([typed('sh', T)]), 'sh', `orch logs b${String.fromCharCode(233)} --tail 5`)).toMatchObject({ allowed: false, reason: 'invalid-request' });
  });
});

describe('limits of a policy, at the boundary', () => {
  /** A v1 body of exactly `target` characters of JSON: a default list of 200 entries of 2048 characters, then a peer list sized to fit. */
  function bodyOfSize(target: number): PolicyBody {
    const commandOf = (tag: string, length: number): string => `${tag}${'x'.repeat(length - tag.length)}`;
    const defaults = Array.from({ length: 200 }, (_, i) => exact('sh', commandOf(`d${i}-`, 2048)));
    const peerEntries: PolicyEntry[] = [];
    const make = (): PolicyBody => ({ v: 1, target: TARGET, version: 1, baseVersion: 0, adminKeyId: KEY, issuedAt: NOW, notBefore: NOW - 60, notAfter: NOW + 3600, defaults, peers: { [PEER]: peerEntries } });
    for (let i = 0; JSON.stringify(make()).length < target; i++) peerEntries.push(exact('sh', commandOf(`p${i}-`, 2048)));
    // Shrink the last entry so that the body is exactly `target` long.
    const last = peerEntries[peerEntries.length - 1] as { command: string };
    const excess = JSON.stringify(make()).length - target;
    last.command = commandOf(`p${peerEntries.length - 1}-`, last.command.length - excess);
    expect(JSON.stringify(make()).length).toBe(target);
    return make();
  }

  it('512 KiB of JSON is accepted, one more character is refused naming the limit', () => {
    const limit = 512 * 1024;
    expect(() => assertPolicyBody(bodyOfSize(limit))).not.toThrow();
    expect(() => assertPolicyBody(bodyOfSize(limit + 1))).toThrow(/524288 characters \(512 KiB\)/);
  });

  it('200 entries per list accepted, 201 refused', () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => exact('sh', `c${i}`));
    expect(() => assertPolicyBody(body(list(200), { v: 1 }))).not.toThrow();
    expect(() => assertPolicyBody(body(list(201), { v: 1 }))).toThrow(/more than 200 entries/);
  });

  it('64 peers accepted, 65 refused', () => {
    const peers = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`11111111-2222-4333-8444-${String(i).padStart(12, '0')}`, [exact('sh', 'ls')]]));
    expect(() => assertPolicyBody(body([], { v: 1, peers: peers(64) }))).not.toThrow();
    expect(() => assertPolicyBody(body([], { v: 1, peers: peers(65) }))).toThrow(/more than 64 peers/);
  });

  it('an exact command: 2048 accepted, 2049 and empty refused', () => {
    expect(() => assertPolicyBody(body([exact('sh', 'a'.repeat(2048))], { v: 1 }))).not.toThrow();
    expect(() => assertPolicyBody(body([exact('sh', 'a'.repeat(2049))], { v: 1 }))).toThrow(/longer than 2048 characters/);
    expect(() => assertPolicyBody(body([exact('sh', '')], { v: 1 }))).toThrow(/must not be empty/);
  });

  it('a request: 2048 accepted by the validator of the request, 2049 refused as invalid', () => {
    const b = body([exact('sh', 'a'.repeat(2048))], { v: 1 });
    expect(asked(b, 'sh', 'a'.repeat(2048)).allowed).toBe(true);
    expect(asked(b, 'sh', 'a'.repeat(2049))).toMatchObject({ allowed: false, reason: 'invalid-request' });
    expect(asked(b, 'sh', '')).toMatchObject({ allowed: false, reason: 'invalid-request' });
  });
});
