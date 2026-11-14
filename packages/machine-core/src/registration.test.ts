import { describe, expect, it } from 'vitest';
import type { Json } from './canonical.js';
import { generateSigningKeyPair, keyId } from './keys.js';
import { signDocument } from './signed.js';
import { signRegistration, verifyRegistration, type RegistrationBody } from './registration.js';

const NOW = 1_800_000_000;

function setup() {
  const admin = generateSigningKeyPair();
  const machine = generateSigningKeyPair();
  const body: RegistrationBody = {
    v: 1,
    uuid: '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f',
    name: 'desktop',
    identityPublicKey: machine.publicKey,
    serial: 1,
    validFrom: NOW - 60,
    validTo: NOW + 86_400,
    adminKeyId: keyId(admin.publicKey),
  };
  return { admin, machine, body };
}

describe('registration records', () => {
  it('accepts a record signed by the pinned admin key inside its validity window', () => {
    const { admin, body } = setup();
    const signed = signRegistration(body, admin.privateKeyPkcs8);
    const result = verifyRegistration(signed, { adminPublicKey: admin.publicKey, now: NOW });
    expect(result).toEqual({ ok: true, body });
  });

  it('rejects a tampered body', () => {
    const { admin, body } = setup();
    const signed = signRegistration(body, admin.privateKeyPkcs8);
    const tampered = { ...signed, body: { ...signed.body, name: 'evil' } };
    const result = verifyRegistration(tampered, { adminPublicKey: admin.publicKey, now: NOW });
    expect(result).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a record signed by another admin key and says which key it expects', () => {
    const { body } = setup();
    const other = generateSigningKeyPair();
    const pinned = generateSigningKeyPair();
    const signed = signRegistration({ ...body, adminKeyId: keyId(other.publicKey) }, other.privateKeyPkcs8);
    const result = verifyRegistration(signed, { adminPublicKey: pinned.publicKey, now: NOW });
    expect(result).toMatchObject({ ok: false, reason: 'wrong-admin-key' });
    if (!result.ok) expect(result.message).toContain(keyId(pinned.publicKey));
  });

  it('rejects a record that is not valid yet and one that expired, with the dates', () => {
    const { admin, body } = setup();
    const early = signRegistration({ ...body, validFrom: NOW + 1000 }, admin.privateKeyPkcs8);
    const late = signRegistration({ ...body, validTo: NOW - 1 }, admin.privateKeyPkcs8);
    expect(verifyRegistration(early, { adminPublicKey: admin.publicKey, now: NOW })).toMatchObject({ ok: false, reason: 'not-yet-valid' });
    const expired = verifyRegistration(late, { adminPublicKey: admin.publicKey, now: NOW });
    expect(expired).toMatchObject({ ok: false, reason: 'expired' });
    if (!expired.ok) expect(expired.message).toMatch(/expired/);
  });

  it('tolerates a configured clock skew on validFrom only', () => {
    const { admin, body } = setup();
    const signed = signRegistration({ ...body, validFrom: NOW + 100 }, admin.privateKeyPkcs8);
    expect(verifyRegistration(signed, { adminPublicKey: admin.publicKey, now: NOW, skewSeconds: 120 }).ok).toBe(true);
    expect(verifyRegistration(signed, { adminPublicKey: admin.publicKey, now: NOW, skewSeconds: 10 }).ok).toBe(false);
  });

  it('rejects a revoked serial', () => {
    const { admin, body } = setup();
    const signed = signRegistration(body, admin.privateKeyPkcs8);
    const result = verifyRegistration(signed, {
      adminPublicKey: admin.publicKey,
      now: NOW,
      isRevoked: (uuid, serial) => uuid === body.uuid && serial === body.serial,
    });
    expect(result).toMatchObject({ ok: false, reason: 'revoked' });
  });

  it('refuses to sign a malformed body (extra key, bad uuid, bad name, window reversed)', () => {
    const { admin, body } = setup();
    expect(() => signRegistration({ ...body, extra: 1 } as never, admin.privateKeyPkcs8)).toThrow(/unknown field.*extra/);
    expect(() => signRegistration({ ...body, uuid: 'nope' }, admin.privateKeyPkcs8)).toThrow(/uuid/);
    expect(() => signRegistration({ ...body, name: 'has space' }, admin.privateKeyPkcs8)).toThrow(/name/);
    expect(() => signRegistration({ ...body, validTo: body.validFrom }, admin.privateKeyPkcs8)).toThrow(/validTo/);
  });

  it('reports a malformed received record instead of throwing', () => {
    const { admin } = setup();
    expect(verifyRegistration({ nonsense: true } as never, { adminPublicKey: admin.publicKey, now: NOW })).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('does not accept a signature made for another document type (domain separation)', () => {
    const { admin, body } = setup();
    // The very same body, signed by the right admin key but under another document type, must not pass as a registration.
    const signatureForAPolicy = signDocument('machine/policy/v1', body as unknown as Json, admin.privateKeyPkcs8);
    const result = verifyRegistration({ body, signature: signatureForAPolicy }, { adminPublicKey: admin.publicKey, now: NOW });
    expect(result).toMatchObject({ ok: false, reason: 'bad-signature' });
  });
});
