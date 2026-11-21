import { describe, expect, it } from 'vitest';
import { buildDocument, documentId, verifyDocument } from './document.js';
import { generateSigningKeyPair, keyId } from './keys.js';
import {
  MAX_NOTICE_RECIPIENTS,
  NOTICE_RECIPIENTS_DOMAIN,
  assertNoticeRecipientsBody,
  compareNoticeRecipients,
  signNoticeRecipients,
  verifyNoticeRecipients,
  type NoticeRecipientsBody,
} from './noticeRecipients.js';
import { signDocument } from './signed.js';

const A = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const B = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';
const TO = '11111111-1111-4111-8111-111111111111';
const NOW = 1_800_000_000;

function setup() {
  const admin = generateSigningKeyPair();
  const body: NoticeRecipientsBody = { v: 1, adminKeyId: keyId(admin.publicKey), serial: NOW, issuedAt: NOW, recipients: [B, A].sort() };
  return { admin, body };
}

describe('notice-recipients body', () => {
  it('verifies a list signed by the pinned admin key', () => {
    const { admin, body } = setup();
    const signed = signNoticeRecipients(body, admin.privateKeyPkcs8);
    expect(verifyNoticeRecipients(signed, { adminPublicKey: admin.publicKey })).toEqual({ ok: true, body });
  });

  it('refuses a list changed after signing, a list of another admin key and a signature of another domain', () => {
    const { admin, body } = setup();
    const signed = signNoticeRecipients(body, admin.privateKeyPkcs8);
    const added = { ...signed, body: { ...body, recipients: [...body.recipients, TO].sort() } };
    expect(verifyNoticeRecipients(added, { adminPublicKey: admin.publicKey })).toMatchObject({ ok: false, reason: 'bad-signature' });
    const other = generateSigningKeyPair();
    expect(verifyNoticeRecipients(signed, { adminPublicKey: other.publicKey })).toMatchObject({ ok: false, reason: 'wrong-admin-key' });
    const wrongDomain = { body, signature: signDocument('machine/revocation/v1', body as never, admin.privateKeyPkcs8) };
    expect(verifyNoticeRecipients(wrongDomain, { adminPublicKey: admin.publicKey })).toMatchObject({ ok: false, reason: 'bad-signature' });
    expect(NOTICE_RECIPIENTS_DOMAIN).toBe('machine/notice-recipients/v1');
  });

  it('refuses malformed bodies with the cause', () => {
    const { body } = setup();
    const bad = (patch: Record<string, unknown>) => () => assertNoticeRecipientsBody({ ...body, ...patch });
    expect(bad({ recipients: [A, A] })).toThrow(/duplicate/);
    expect(bad({ recipients: [B, A].sort().reverse() })).toThrow(/sorted/);
    expect(bad({ recipients: ['nope'] })).toThrow(/UUID/);
    expect(bad({ serial: 0 })).toThrow(/serial/);
    expect(bad({ extra: 1 })).toThrow(/unknown field "extra"/);
    expect(bad({ v: 2 })).toThrow(/unsupported version/);
    const many = Array.from({ length: MAX_NOTICE_RECIPIENTS + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(bad({ recipients: many })).toThrow(/at most 8/);
  });

  it('an empty list is valid: nobody is notified', () => {
    const { admin, body } = setup();
    const signed = signNoticeRecipients({ ...body, recipients: [] }, admin.privateKeyPkcs8);
    expect(verifyNoticeRecipients(signed, { adminPublicKey: admin.publicKey }).ok).toBe(true);
  });

  it('compares by serial: newer replaces, equal or older does not', () => {
    const { admin, body } = setup();
    const at = (serial: number) => signNoticeRecipients({ ...body, serial }, admin.privateKeyPkcs8);
    expect(compareNoticeRecipients(undefined, at(5))).toBe('newer');
    expect(compareNoticeRecipients(at(5), at(6))).toBe('newer');
    expect(compareNoticeRecipients(at(5), at(5))).toBe('same');
    expect(compareNoticeRecipients(at(5), at(4))).toBe('older');
  });
});

describe('notice-recipients document (sealed envelope v2)', () => {
  it('is sealed to the addressee, opens only there and is verified against the admin key', () => {
    const { admin, body } = setup();
    const target = generateSigningKeyPair();
    const signed = signNoticeRecipients(body, admin.privateKeyPkcs8);
    const id = documentId(`v2:notice-recipients:${TO}:${signed.body.serial}:${signed.signature}`);
    const doc = buildDocument(
      { kind: 'notice-recipients', to: TO, id, issuedAt: NOW, expiresAt: NOW + 3600, payload: signed as never, recipientIdentityPublicKey: target.publicKey },
      admin.privateKeyPkcs8,
    );
    expect(JSON.stringify(doc)).not.toContain(A);
    const ctx = { adminPublicKey: admin.publicKey, selfUuid: TO, now: NOW, identityPrivateKeyPkcs8: target.privateKeyPkcs8 };
    const verified = verifyDocument(doc, ctx);
    expect(verified).toMatchObject({ ok: true, kind: 'notice-recipients' });
    expect(verified).toMatchObject({ noticeRecipients: signed });
    const stranger = generateSigningKeyPair();
    expect(verifyDocument(doc, { ...ctx, identityPrivateKeyPkcs8: stranger.privateKeyPkcs8 })).toMatchObject({ ok: false, reason: 'cannot-open' });
  });

  it('refuses a document whose inner list is signed by another key', () => {
    const { admin, body } = setup();
    const other = generateSigningKeyPair();
    const target = generateSigningKeyPair();
    const forged = signNoticeRecipients({ ...body, adminKeyId: keyId(other.publicKey) }, other.privateKeyPkcs8);
    const doc = buildDocument(
      { kind: 'notice-recipients', to: TO, id: documentId('x'), issuedAt: NOW, expiresAt: NOW + 3600, payload: forged as never, recipientIdentityPublicKey: target.publicKey },
      admin.privateKeyPkcs8,
    );
    const verified = verifyDocument(doc, { adminPublicKey: admin.publicKey, selfUuid: TO, now: NOW, identityPrivateKeyPkcs8: target.privateKeyPkcs8 });
    expect(verified).toMatchObject({ ok: false, reason: 'invalid-payload' });
  });
});
