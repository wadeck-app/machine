import { describe, expect, it } from 'vitest';
import { generateSigningKeyPair, keyId } from './keys.js';
import { signDocument } from './signed.js';
import {
  ALIASES_DOMAIN,
  MAX_ALIASES,
  aliasConflicts,
  assertAliasesBody,
  canonicalSignedAliases,
  compareAliases,
  planAliasChange,
  signAliases,
  verifyAliases,
  type AliasEntry,
  type AliasesBody,
} from './aliases.js';

// Decision 116: the admin-signed `aliases` document: network-wide labels for machines. An alias is a human-read label, never a right.

const THINK = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const LAPTOP = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';
const GONE = '11111111-1111-4111-8111-111111111111';
const NOW = 1_800_000_000;

const machines = [
  { uuid: THINK, name: 'thinkcentre' },
  { uuid: LAPTOP, name: 'work-laptop' },
];

function setup(entries: AliasEntry[] = [{ alias: 'box', uuid: THINK }]) {
  const admin = generateSigningKeyPair();
  const body: AliasesBody = { v: 1, adminKeyId: keyId(admin.publicKey), serial: NOW, issuedAt: NOW, entries };
  return { admin, body };
}

describe('aliases body', () => {
  it('verifies a list signed by the pinned admin key', () => {
    const { admin, body } = setup();
    const signed = signAliases(body, admin.privateKeyPkcs8);
    expect(verifyAliases(signed, { adminPublicKey: admin.publicKey })).toEqual({ ok: true, body });
  });

  it('refuses a list changed after signing, one of another admin key and one signed under another domain', () => {
    const { admin, body } = setup();
    const signed = signAliases(body, admin.privateKeyPkcs8);
    const changed = { ...signed, body: { ...body, entries: [{ alias: 'box', uuid: LAPTOP }] } };
    expect(verifyAliases(changed, { adminPublicKey: admin.publicKey })).toMatchObject({ ok: false, reason: 'bad-signature' });
    const other = generateSigningKeyPair();
    expect(verifyAliases(signed, { adminPublicKey: other.publicKey })).toMatchObject({ ok: false, reason: 'wrong-admin-key' });
    const wrongDomain = { body, signature: signDocument('machine/notice-recipients/v1', body as never, admin.privateKeyPkcs8) };
    expect(verifyAliases(wrongDomain, { adminPublicKey: admin.publicKey })).toMatchObject({ ok: false, reason: 'bad-signature' });
    expect(ALIASES_DOMAIN).toBe('machine/aliases/v1');
  });

  it('refuses an unusable pinned key by name', () => {
    const { admin, body } = setup();
    expect(verifyAliases(signAliases(body, admin.privateKeyPkcs8), { adminPublicKey: 'not-a-key' })).toMatchObject({ ok: false, reason: 'invalid-admin-key' });
  });

  it('refuses a malformed body loudly, naming the field', () => {
    const { body } = setup();
    expect(() => assertAliasesBody({ ...body, extra: 1 })).toThrow(/aliases: unknown field "extra"/);
    expect(() => assertAliasesBody({ ...body, v: 2 })).toThrow(/unsupported version 2.*machine cli update/);
    expect(() => assertAliasesBody({ ...body, serial: 0 })).toThrow(/serial/);
    expect(() => assertAliasesBody({ ...body, entries: 'x' })).toThrow(/entries must be a list/);
    expect(() => assertAliasesBody({ ...body, entries: [{ alias: 'Box', uuid: THINK }] })).toThrow(/alias "Box".*lowercase/);
    expect(() => assertAliasesBody({ ...body, entries: [{ alias: 'box', uuid: 'nope' }] })).toThrow(/uuid/);
    expect(() => assertAliasesBody({ ...body, entries: [{ alias: 'box', uuid: THINK, more: 1 }] })).toThrow(/unknown field "more"/);
    expect(() => assertAliasesBody({ ...body, entries: [{ alias: 'b', uuid: THINK }, { alias: 'a', uuid: THINK }] })).toThrow(/sorted/);
    expect(() => assertAliasesBody({ ...body, entries: [{ alias: 'a', uuid: THINK }, { alias: 'a', uuid: LAPTOP }] })).toThrow(/duplicate alias "a"/);
    const many = Array.from({ length: MAX_ALIASES + 1 }, (_, i) => ({ alias: `a${String(i).padStart(3, '0')}`, uuid: THINK }));
    expect(() => assertAliasesBody({ ...body, entries: many })).toThrow(/too many aliases/);
  });

  it('accepts an empty list (every network alias removed) and several aliases of one machine', () => {
    const { body } = setup();
    expect(() => assertAliasesBody({ ...body, entries: [] })).not.toThrow();
    expect(() => assertAliasesBody({ ...body, entries: [{ alias: 'box', uuid: THINK }, { alias: 'tc', uuid: THINK }] })).not.toThrow();
  });

  it('keeps only { body, signature } of a stored list', () => {
    const { admin, body } = setup();
    const signed = signAliases(body, admin.privateKeyPkcs8);
    expect(canonicalSignedAliases({ ...signed, junk: 1 })).toEqual(signed);
    expect(() => canonicalSignedAliases({ body })).toThrow(/missing signature/);
  });

  it('replace-newer: a higher serial installs, the same and an older one do not', () => {
    const { admin, body } = setup();
    const at = (serial: number) => signAliases({ ...body, serial }, admin.privateKeyPkcs8);
    expect(compareAliases(undefined, at(5))).toBe('newer');
    expect(compareAliases(at(5), at(6))).toBe('newer');
    expect(compareAliases(at(5), at(5))).toBe('same');
    expect(compareAliases(at(5), at(4))).toBe('older');
  });
});

describe('planAliasChange', () => {
  const set = (alias: string, uuid: string, current: AliasEntry[] = [], revoked: string[] = []) => planAliasChange({ change: { action: 'set', alias, uuid }, current, machines, revoked });

  it('adds an alias to a trusted machine, entries sorted', () => {
    const r = set('box', THINK, [{ alias: 'zzz', uuid: LAPTOP }]);
    expect(r).toEqual({ ok: true, alias: 'box', entries: [{ alias: 'box', uuid: THINK }, { alias: 'zzz', uuid: LAPTOP }], changed: true, normalized: false });
  });

  it('the same alias on the same machine changes nothing', () => {
    expect(set('box', THINK, [{ alias: 'box', uuid: THINK }])).toMatchObject({ ok: true, changed: false });
  });

  it('normalizes a typed alias like a machine name, and says so', () => {
    expect(set('My Box', THINK)).toMatchObject({ ok: true, alias: 'my-box', normalized: true });
  });

  it('refuses an alias that has no letter or digit', () => {
    expect(set('---', THINK)).toMatchObject({ ok: false, reason: 'invalid-alias' });
  });

  it('refuses an alias equal to the name of a trusted machine, naming it', () => {
    const r = set('work-laptop', THINK);
    expect(r).toMatchObject({ ok: false, reason: 'name-taken' });
    if (!r.ok) expect(r.message).toMatch(/work-laptop.*0a1b2c3d/);
    // Even the machine's own name: it would add nothing.
    expect(set('thinkcentre', THINK)).toMatchObject({ ok: false, reason: 'name-taken' });
  });

  it('refuses an alias that only differs from a machine name by hyphens or case', () => {
    expect(set('work-lap-top', THINK)).toMatchObject({ ok: false, reason: 'lookalike' });
    expect(set('WorkLaptop', THINK)).toMatchObject({ ok: false, reason: 'lookalike' });
  });

  it('refuses an alias already pointing to another machine, and tells to remove it first', () => {
    const r = set('box', LAPTOP, [{ alias: 'box', uuid: THINK }]);
    expect(r).toMatchObject({ ok: false, reason: 'alias-taken' });
    if (!r.ok) expect(r.message).toMatch(/machine admin alias rm box/);
  });

  it('refuses an alias that only differs from another alias by hyphens', () => {
    expect(set('b-ox', LAPTOP, [{ alias: 'box', uuid: THINK }])).toMatchObject({ ok: false, reason: 'lookalike-alias' });
  });

  it('refuses a machine this one does not trust, and a revoked one', () => {
    expect(set('gone', GONE)).toMatchObject({ ok: false, reason: 'unknown-machine' });
    expect(set('box', THINK, [], [THINK])).toMatchObject({ ok: false, reason: 'revoked' });
  });

  it('refuses the list that would exceed the limit', () => {
    const full = Array.from({ length: MAX_ALIASES }, (_, i) => ({ alias: `a${String(i).padStart(3, '0')}`, uuid: THINK }));
    expect(set('box', THINK, full)).toMatchObject({ ok: false, reason: 'too-many' });
  });

  it('removes an alias, and refuses one that does not exist', () => {
    const current = [{ alias: 'box', uuid: THINK }, { alias: 'tc', uuid: THINK }];
    expect(planAliasChange({ change: { action: 'rm', alias: 'box' }, current, machines, revoked: [] })).toMatchObject({ ok: true, entries: [{ alias: 'tc', uuid: THINK }], changed: true });
    const r = planAliasChange({ change: { action: 'rm', alias: 'nope' }, current, machines, revoked: [] });
    expect(r).toMatchObject({ ok: false, reason: 'no-such-alias' });
    if (!r.ok) expect(r.message).toMatch(/box, tc/);
  });

  it('removing an alias of a revoked or gone machine is allowed (cleanup)', () => {
    expect(planAliasChange({ change: { action: 'rm', alias: 'old' }, current: [{ alias: 'old', uuid: GONE }], machines, revoked: [GONE] })).toMatchObject({ ok: true, entries: [] });
  });
});

describe('aliasConflicts', () => {
  it('lists every alias that a local alias and a network alias point at different machines, none otherwise', () => {
    expect(aliasConflicts({ box: LAPTOP, same: THINK, mine: THINK }, { box: THINK, same: THINK, other: LAPTOP })).toEqual([{ alias: 'box', local: LAPTOP, network: THINK }]);
    expect(aliasConflicts({}, { box: THINK })).toEqual([]);
  });
});
