import { describe, expect, it } from 'vitest';
import { generateSigningKeyPair, keyId } from './keys.js';
import { MAX_REVOCATION_ENTRIES, applyRevocation, canonicalSignedRevocation, isRevoked, mergeRevocations, revocationDigest, signRevocation, verifyRevocation, type RevocationBody } from './revocation.js';

const A = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const B = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';

function setup() {
  const admin = generateSigningKeyPair();
  const body: RevocationBody = { v: 1, adminKeyId: keyId(admin.publicKey), issuedAt: 1_800_000_000, entries: [{ uuid: A, serial: 2 }] };
  return { admin, body };
}

describe('revocation', () => {
  it('verifies a list signed by the pinned admin key', () => {
    const { admin, body } = setup();
    const signed = signRevocation(body, admin.privateKeyPkcs8);
    expect(verifyRevocation(signed, { adminPublicKey: admin.publicKey })).toEqual({ ok: true, body });
  });

  it('rejects a list with an entry added or removed after signing', () => {
    const { admin, body } = setup();
    const signed = signRevocation(body, admin.privateKeyPkcs8);
    const removed = { ...signed, body: { ...signed.body, entries: [] } };
    expect(verifyRevocation(removed, { adminPublicKey: admin.publicKey })).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a list certified by another admin key', () => {
    const { body } = setup();
    const other = generateSigningKeyPair();
    const pinned = generateSigningKeyPair();
    const signed = signRevocation({ ...body, adminKeyId: keyId(other.publicKey) }, other.privateKeyPkcs8);
    expect(verifyRevocation(signed, { adminPublicKey: pinned.publicKey })).toMatchObject({ ok: false, reason: 'wrong-admin-key' });
  });

  it('refuses to sign duplicates or an unsorted list (one canonical form only)', () => {
    const { admin, body } = setup();
    expect(() => signRevocation({ ...body, entries: [{ uuid: A, serial: 1 }, { uuid: A, serial: 2 }] }, admin.privateKeyPkcs8)).toThrow(/duplicate/);
    const unsorted = [{ uuid: A, serial: 1 }, { uuid: B, serial: 1 }];
    expect(() => signRevocation({ ...body, entries: unsorted }, admin.privateKeyPkcs8)).toThrow(/sorted/);
  });

  it('revokes every registration of the machine up to the listed serial, not later ones', () => {
    const entries = [{ uuid: A, serial: 2 }];
    expect(isRevoked(entries, A, 1)).toBe(true);
    expect(isRevoked(entries, A, 2)).toBe(true);
    expect(isRevoked(entries, A, 3)).toBe(false);
    expect(isRevoked(entries, B, 1)).toBe(false);
  });

  it('merges by union and keeps the highest serial per machine; it never removes', () => {
    const merged = mergeRevocations([{ uuid: A, serial: 2 }], [{ uuid: B, serial: 1 }, { uuid: A, serial: 5 }], []);
    expect(merged).toEqual([{ uuid: B, serial: 1 }, { uuid: A, serial: 5 }].sort((x, y) => (x.uuid < y.uuid ? -1 : 1)));
    expect(isRevoked(merged, A, 5)).toBe(true);
    expect(isRevoked(merged, B, 1)).toBe(true);
  });

  it('applyRevocation merges a verified list into the local one and reports whether anything changed (review finding)', () => {
    const { admin, body } = setup();
    const signed = signRevocation(body, admin.privateKeyPkcs8);
    const first = applyRevocation([], signed, { adminPublicKey: admin.publicKey });
    expect(first).toEqual({ ok: true, entries: [{ uuid: A, serial: 2 }], changed: true });
    const again = applyRevocation(first.ok ? first.entries : [], signed, { adminPublicKey: admin.publicKey });
    expect(again).toMatchObject({ ok: true, changed: false });
  });

  it('applyRevocation keeps entries that an older signed list does not contain: a stale list never un-revokes', () => {
    const { admin, body } = setup();
    const old = signRevocation(body, admin.privateKeyPkcs8);
    const local = [{ uuid: A, serial: 2 }, { uuid: B, serial: 1 }].sort((x, y) => (x.uuid < y.uuid ? -1 : 1));
    const result = applyRevocation(local, old, { adminPublicKey: admin.publicKey });
    expect(result).toMatchObject({ ok: true, changed: false });
    if (result.ok) expect(result.entries).toEqual(local);
  });

  it('reports a broken pinned admin key as a result (review finding)', () => {
    const { admin, body } = setup();
    const signed = signRevocation(body, admin.privateKeyPkcs8);
    expect(verifyRevocation(signed, { adminPublicKey: 'garbage' })).toMatchObject({ ok: false, reason: 'invalid-admin-key' });
    expect(applyRevocation([], signed, { adminPublicKey: 'garbage' })).toMatchObject({ ok: false, reason: 'invalid-admin-key' });
  });

  it('has a digest that ignores the order of merging but changes with any entry', () => {
    const one = mergeRevocations([{ uuid: A, serial: 2 }], [{ uuid: B, serial: 1 }]);
    const two = mergeRevocations([{ uuid: B, serial: 1 }], [{ uuid: A, serial: 2 }]);
    expect(revocationDigest(one)).toBe(revocationDigest(two));
    expect(revocationDigest(one)).not.toBe(revocationDigest(mergeRevocations(one, [{ uuid: A, serial: 3 }])));
    expect(revocationDigest(one)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses to sign or read a list with more than the entry cap, so a stored or forwarded list stays bounded', () => {
    const { admin, body } = setup();
    const entries = Array.from({ length: MAX_REVOCATION_ENTRIES + 1 }, (_, i) => ({ uuid: `6f1c2d3e-4a5b-4c6d-8e7f-${i.toString(16).padStart(12, '0')}`, serial: 1 }));
    expect(() => signRevocation({ ...body, entries }, admin.privateKeyPkcs8)).toThrow(/at most 4096|too many/);
  });

  it('rebuilds the canonical { body, signature } and drops every other top-level field before a list is stored or forwarded', () => {
    const { admin, body } = setup();
    const signed = signRevocation(body, admin.privateKeyPkcs8);
    const dirty = { ...signed, extra: 'x'.repeat(1000), __proto_note: 1 };
    expect(canonicalSignedRevocation(dirty)).toEqual(signed);
    expect(Object.keys(canonicalSignedRevocation(dirty))).toEqual(['body', 'signature']);
    expect(() => canonicalSignedRevocation({ body: signed.body })).toThrow(/signature/);
    expect(() => canonicalSignedRevocation('nope')).toThrow(/object/);
  });
});
