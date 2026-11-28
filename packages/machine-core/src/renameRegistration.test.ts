import { describe, expect, it } from 'vitest';
import { generateSigningKeyPair, keyId } from './keys.js';
import { isRevoked } from './revocation.js';
import { signRegistration, verifyRegistration, type RegistrationBody } from './registration.js';
import { buildRenamedRegistration, registrationReplaces, type RenameRegistrationInput } from './renameRegistration.js';

// Decision 114 (rename): the admin re-issues the registration of a machine (same uuid, same identity key, new name, serial + 1).

const NOW = 1_800_000_000;
const MAC = '14695579-c70a-44ea-9831-5284c05ea5a2';
const LAPTOP = '22222222-2222-4222-8222-222222222222';
const DESKTOP = '33333333-3333-4333-8333-333333333333';

function setup() {
  const admin = generateSigningKeyPair();
  const mac = generateSigningKeyPair();
  const current: RegistrationBody = {
    v: 1,
    uuid: MAC,
    name: 'macbook-pro-de-wadeck',
    identityPublicKey: mac.publicKey,
    serial: 1_799_000_000,
    validFrom: 1_799_000_000,
    validTo: 1_799_000_000 + 365 * 86_400,
    adminKeyId: keyId(admin.publicKey),
  };
  const input = (over: Partial<RenameRegistrationInput> = {}): RenameRegistrationInput => ({
    uuid: MAC,
    current,
    newName: 'mac-m2',
    machines: [
      { uuid: MAC, name: 'macbook-pro-de-wadeck' },
      { uuid: LAPTOP, name: 'laptop' },
      { uuid: DESKTOP, name: 'desktop' },
    ],
    aliases: {},
    revokedUpTo: undefined,
    now: NOW,
    ...over,
  });
  return { admin, mac, current, input };
}

describe('buildRenamedRegistration', () => {
  it('keeps uuid, identity key and admin key, takes the new name, serial + 1, validFrom now and the SAME validTo', () => {
    const { input, current } = setup();
    const r = buildRenamedRegistration(input());
    expect(r).toEqual({ ok: true, body: { ...current, name: 'mac-m2', serial: current.serial + 1, validFrom: NOW } });
  });

  it('the body is accepted by the admin signature path and verifies against the pinned key', () => {
    const { admin, input } = setup();
    const r = buildRenamedRegistration(input());
    if (!r.ok) throw new Error(r.message);
    const signed = signRegistration(r.body, admin.privateKeyPkcs8);
    expect(verifyRegistration(signed, { adminPublicKey: admin.publicKey, now: NOW })).toMatchObject({ ok: true });
  });

  it('refuses an unknown uuid, naming the uuid and the way to list the machines', () => {
    const { input } = setup();
    const r = buildRenamedRegistration(input({ current: undefined }));
    expect(r).toMatchObject({ ok: false, reason: 'unknown-machine' });
    expect((r as { message: string }).message).toContain(MAC);
    expect((r as { message: string }).message).toMatch(/machine status|machine list/);
  });

  it('refuses a revoked machine (its newest registration is covered by a revocation)', () => {
    const { input, current } = setup();
    const r = buildRenamedRegistration(input({ revokedUpTo: current.serial }));
    expect(r).toMatchObject({ ok: false, reason: 'revoked' });
    expect((r as { message: string }).message).toMatch(/revoked/);
    expect((r as { message: string }).message).toMatch(/machine admin approve/);
  });

  it('refuses a registration that has already expired: renaming is not a renewal', () => {
    const { input, current } = setup();
    const r = buildRenamedRegistration(input({ now: current.validTo + 1 }));
    expect(r).toMatchObject({ ok: false, reason: 'expired' });
    expect((r as { message: string }).message).toMatch(/machine admin approve/);
  });

  it('refuses the same name', () => {
    const { input } = setup();
    expect(buildRenamedRegistration(input({ newName: 'macbook-pro-de-wadeck' }))).toMatchObject({ ok: false, reason: 'same-name' });
  });

  it.each([
    ['Mac-M2', /lowercase/],
    ['mac m2', /letters, digits and hyphens/],
    ['', /1 to 32/],
    ['-mac', /start with a letter or a digit/],
    ['dead-beef', /hexadecimal/],
  ])('refuses the invalid name %j with the rule that failed', (name, rule) => {
    const { input } = setup();
    const r = buildRenamedRegistration(input({ newName: name }));
    expect(r).toMatchObject({ ok: false, reason: 'invalid-name' });
    expect((r as { message: string }).message).toMatch(rule);
  });

  it('refuses a name already used by another trusted machine, naming it and its uuid', () => {
    const { input } = setup();
    const r = buildRenamedRegistration(input({ newName: 'laptop' }));
    expect(r).toMatchObject({ ok: false, reason: 'name-taken' });
    expect((r as { message: string }).message).toContain(LAPTOP.slice(0, 8));
  });

  it('refuses a name that another machine only differs from by hyphens (lookalike)', () => {
    const { input } = setup();
    const r = buildRenamedRegistration(input({ machines: [...setup().input().machines, { uuid: '44444444-4444-4444-8444-444444444444', name: 'mac-m2' }], newName: 'macm2' }));
    expect(r).toMatchObject({ ok: false, reason: 'lookalike' });
    expect((r as { message: string }).message).toContain('mac-m2');
  });

  it('refuses a name that is a local alias of ANOTHER machine (the alias wins over names, the reference would change meaning)', () => {
    const { input } = setup();
    const r = buildRenamedRegistration(input({ aliases: { 'mac-m2': LAPTOP } }));
    expect(r).toMatchObject({ ok: false, reason: 'alias-conflict' });
    expect((r as { message: string }).message).toMatch(/machine alias/);
  });

  it('accepts a name that is already a local alias of the SAME machine', () => {
    const { input } = setup();
    expect(buildRenamedRegistration(input({ aliases: { 'mac-m2': MAC } }))).toMatchObject({ ok: true });
  });

  it('its own old name is not a conflict for the new one (a case-only difference cannot exist: names are lowercase)', () => {
    const { input } = setup();
    expect(buildRenamedRegistration(input({ newName: 'macbook' }))).toMatchObject({ ok: true });
  });
});

describe('registrationReplaces: same uuid, same identity key, higher serial replaces', () => {
  it('nothing stored: add', () => {
    const { current } = setup();
    expect(registrationReplaces(undefined, current)).toEqual({ ok: true, action: 'add' });
  });

  it('a higher serial with the same key replaces', () => {
    const { current } = setup();
    expect(registrationReplaces(current, { ...current, name: 'mac-m2', serial: current.serial + 1 })).toEqual({ ok: true, action: 'replace' });
  });

  it('the same or a lower serial is not newer', () => {
    const { current } = setup();
    expect(registrationReplaces(current, current)).toMatchObject({ ok: false, reason: 'not-newer' });
    expect(registrationReplaces(current, { ...current, serial: current.serial - 1 })).toMatchObject({ ok: false, reason: 'not-newer' });
  });

  it('a DIFFERENT identity key for the same uuid is refused even with a higher serial, naming both key ids', () => {
    const { current } = setup();
    const other = generateSigningKeyPair();
    const r = registrationReplaces(current, { ...current, identityPublicKey: other.publicKey, serial: current.serial + 1 });
    expect(r).toMatchObject({ ok: false, reason: 'key-changed' });
    expect((r as { message: string }).message).toContain(keyId(current.identityPublicKey));
    expect((r as { message: string }).message).toContain(keyId(other.publicKey));
    expect((r as { message: string }).message).toMatch(/machine admin approve/);
  });

  it('another uuid is not a replacement', () => {
    const { current } = setup();
    expect(registrationReplaces(current, { ...current, uuid: LAPTOP, serial: current.serial + 1 })).toMatchObject({ ok: false, reason: 'other-machine' });
  });
});

describe('a revocation by serial still revokes OLDER serials only', () => {
  it('a revocation of the old serial does not revoke the renamed registration (and the newer one revokes both)', () => {
    const { admin, input, current } = setup();
    const r = buildRenamedRegistration(input());
    if (!r.ok) throw new Error(r.message);
    const signed = signRegistration(r.body, admin.privateKeyPkcs8);
    const oldRevoked = [{ uuid: MAC, serial: current.serial }];
    expect(isRevoked(oldRevoked, MAC, current.serial)).toBe(true);
    expect(verifyRegistration(signed, { adminPublicKey: admin.publicKey, now: NOW, isRevoked: (u, s) => isRevoked(oldRevoked, u, s) })).toMatchObject({ ok: true });
    const newRevoked = [{ uuid: MAC, serial: r.body.serial }];
    expect(isRevoked(newRevoked, MAC, current.serial)).toBe(true);
    expect(verifyRegistration(signed, { adminPublicKey: admin.publicKey, now: NOW, isRevoked: (u, s) => isRevoked(newRevoked, u, s) })).toMatchObject({ ok: false, reason: 'revoked' });
  });
});
