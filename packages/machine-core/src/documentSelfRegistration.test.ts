import { describe, expect, it } from 'vitest';
import type { Json } from './canonical.js';
import { buildDocument, documentId, verifyDocument } from './document.js';
import { generateSigningKeyPair, keyId } from './keys.js';
import { signRegistration, type RegistrationBody } from './registration.js';

// Decision 114: a machine learns its own new name through a `self-registration` document (a `peer` document about the addressee is refused: a machine is never its own peer).

const NOW = 1_800_000_000;
const SELF = '14695579-c70a-44ea-9831-5284c05ea5a2';
const OTHER = '22222222-2222-4222-8222-222222222222';

function setup() {
  const admin = generateSigningKeyPair();
  const machine = generateSigningKeyPair();
  const body = (over: Partial<RegistrationBody> = {}): RegistrationBody => ({
    v: 1,
    uuid: SELF,
    name: 'mac-m2',
    identityPublicKey: machine.publicKey,
    serial: 7,
    validFrom: NOW - 10,
    validTo: NOW + 86_400,
    adminKeyId: keyId(admin.publicKey),
    ...over,
  });
  const document = (registration: unknown, to = SELF) =>
    buildDocument(
      { kind: 'self-registration', to, id: documentId('self-registration:test'), issuedAt: NOW - 10, expiresAt: NOW + 1000, payload: { registration } as unknown as Json, recipientIdentityPublicKey: machine.publicKey },
      admin.privateKeyPkcs8,
    );
  const ctx = (over: Record<string, unknown> = {}) => ({ adminPublicKey: admin.publicKey, selfUuid: SELF, now: NOW, identityPrivateKeyPkcs8: machine.privateKeyPkcs8, ...over });
  return { admin, machine, body, document, ctx };
}

describe('self-registration documents', () => {
  it('the addressee opens one and gets its own signed registration', () => {
    const { admin, body, document, ctx } = setup();
    const signed = signRegistration(body(), admin.privateKeyPkcs8);
    const verified = verifyDocument(document(signed), ctx());
    expect(verified).toMatchObject({ ok: true, kind: 'self-registration', registration: { uuid: SELF, name: 'mac-m2', serial: 7 }, signedRegistration: signed });
  });

  it('the name travels sealed: the relay reads the type tag and the size, never the name', () => {
    const { admin, body, document } = setup();
    const doc = document(signRegistration(body(), admin.privateKeyPkcs8));
    expect(JSON.stringify(doc)).not.toContain('mac-m2');
    expect(doc.body.kind).toBe('self-registration');
  });

  it('refuses a registration of ANOTHER machine inside a document for this one', () => {
    const { admin, body, document, ctx } = setup();
    const verified = verifyDocument(document(signRegistration(body({ uuid: OTHER }), admin.privateKeyPkcs8)), ctx());
    expect(verified).toMatchObject({ ok: false, reason: 'invalid-payload' });
    expect((verified as { message: string }).message).toContain(OTHER);
  });

  it('refuses a registration that the pinned admin key did not sign', () => {
    const { body, document, ctx } = setup();
    const stranger = generateSigningKeyPair();
    const verified = verifyDocument(document(signRegistration(body(), stranger.privateKeyPkcs8)), ctx());
    expect(verified).toMatchObject({ ok: false });
    expect((verified as { reason: string }).reason).toMatch(/invalid-payload|wrong-admin-key|bad-signature/);
  });

  it('refuses an expired registration', () => {
    const { admin, body, document, ctx } = setup();
    const verified = verifyDocument(document(signRegistration(body({ validFrom: NOW - 200_000, validTo: NOW - 100_000 }), admin.privateKeyPkcs8)), ctx());
    expect(verified).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('refuses a payload with another shape (extra field, missing registration) before sealing it', () => {
    const { admin, body, machine } = setup();
    const signed = signRegistration(body(), admin.privateKeyPkcs8);
    const build = (payload: unknown) =>
      buildDocument({ kind: 'self-registration', to: SELF, id: documentId('x'), issuedAt: NOW - 10, expiresAt: NOW + 1000, payload: payload as Json, recipientIdentityPublicKey: machine.publicKey }, admin.privateKeyPkcs8);
    expect(() => build({ registration: signed, sealedPairSecret: 'AAAA' })).toThrow(/unknown field "sealedPairSecret"/);
    expect(() => build({})).toThrow(/missing field "registration"/);
  });

  it('a document of this kind addressed to another machine is refused as wrong-recipient', () => {
    const { admin, body, document, ctx } = setup();
    const verified = verifyDocument(document(signRegistration(body(), admin.privateKeyPkcs8), OTHER), ctx());
    expect(verified).toMatchObject({ ok: false, reason: 'wrong-recipient' });
  });
});
