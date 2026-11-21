import {
  documentId as coreDocumentId,
  keyId as coreKeyId,
  signNoticeRecipients as coreSign,
  verifyInboxDocument as coreVerifyDocument,
  verifyNoticeRecipients as coreVerify,
  type SignedNoticeRecipients,
} from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { newPair, uuid, webKeyFrom } from '../test-support/kit.js';
import { assertNoticeRecipientsBody, nextNoticeRecipientsBody, sealedNoticeRecipientsDocument, signNoticeRecipients } from './noticeRecipients.js';

// The page signs the list of notice recipients (request-notices.md) like the CLI does: same body, same domain, same document. machine-core is the reference.

const NOW = 1_800_000_000;

async function setup() {
  const admin = newPair();
  return { admin, key: await webKeyFrom(admin), adminKeyId: coreKeyId(admin.publicKey) };
}

describe('the list of notice recipients signed in the browser', () => {
  it('is the very signature machine-core makes (Ed25519 is deterministic) and verifies with the core verifier', async () => {
    const s = await setup();
    const body = nextNoticeRecipientsBody({ adminKeyId: s.adminKeyId, now: NOW, current: null, recipients: [uuid(), uuid()] });
    const web = await signNoticeRecipients(body, s.key);
    expect(web).toEqual(coreSign(body, s.admin.privateKeyPkcs8));
    expect(coreVerify(web as unknown as SignedNoticeRecipients, { adminPublicKey: s.admin.publicKey })).toMatchObject({ ok: true });
  });

  it('serial: the clock, or one above the previous list when that is later; recipients sorted and unique', async () => {
    const s = await setup();
    const a = uuid();
    const b = uuid();
    const first = nextNoticeRecipientsBody({ adminKeyId: s.adminKeyId, now: NOW, current: null, recipients: [b, a, b] });
    expect(first.serial).toBe(NOW);
    expect(first.recipients).toEqual([a, b].sort());
    const signed = await signNoticeRecipients(first, s.key);
    expect(nextNoticeRecipientsBody({ adminKeyId: s.adminKeyId, now: NOW, current: signed, recipients: [a] }).serial).toBe(NOW + 1);
    expect(nextNoticeRecipientsBody({ adminKeyId: s.adminKeyId, now: NOW + 500, current: signed, recipients: [a] }).serial).toBe(NOW + 500);
  });

  it('refuses what machine-core refuses, with the same message, before signing', async () => {
    const s = await setup();
    const ok = nextNoticeRecipientsBody({ adminKeyId: s.adminKeyId, now: NOW, current: null, recipients: [uuid()] });
    const cases: unknown[] = [
      { ...ok, v: 2 },
      { ...ok, extra: 1 },
      { ...ok, adminKeyId: 'xyz' },
      { ...ok, serial: 0 },
      { ...ok, recipients: ['not-a-uuid'] },
      { ...ok, recipients: [uuid(), uuid(), uuid(), uuid(), uuid(), uuid(), uuid(), uuid(), uuid()].sort() },
      { ...ok, recipients: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] },
    ];
    for (const bad of cases) {
      let web = '';
      try {
        assertNoticeRecipientsBody(bad);
      } catch (e) {
        web = (e as Error).message;
      }
      expect(web, JSON.stringify(bad)).not.toBe('');
      let core = '';
      try {
        coreSign(bad as never, s.admin.privateKeyPkcs8);
      } catch (e) {
        core = (e as Error).message;
      }
      expect(web).toBe(core);
      await expect(signNoticeRecipients(bad as never, s.key)).rejects.toThrow(web);
    }
  });

  it('sealed document: the id rule of machine-cli, opened with the identity key of the addressee, nobody else can open it', async () => {
    const s = await setup();
    const to = uuid();
    const target = newPair();
    const signed = await signNoticeRecipients(nextNoticeRecipientsBody({ adminKeyId: s.adminKeyId, now: NOW, current: null, recipients: [uuid()] }), s.key);
    const doc = await sealedNoticeRecipientsDocument(signed, to, NOW, s.key, target.publicKey);
    expect(doc.body.id).toBe(coreDocumentId(`v2:notice-recipients:${to}:${signed.body.serial}:${signed.signature}`));
    expect(doc.body.kind).toBe('notice-recipients');
    expect(doc.body.expiresAt - doc.body.issuedAt).toBe(30 * 86_400);
    const ctx = { adminPublicKey: s.admin.publicKey, selfUuid: to, now: NOW };
    const verified = coreVerifyDocument(doc, { ...ctx, identityPrivateKeyPkcs8: target.privateKeyPkcs8 });
    expect(verified).toMatchObject({ ok: true, kind: 'notice-recipients' });
    if (verified.ok && verified.kind === 'notice-recipients') {
      expect(verified.noticeRecipients).toEqual(signed);
    }
    expect(coreVerifyDocument(doc, { ...ctx, identityPrivateKeyPkcs8: newPair().privateKeyPkcs8 })).toMatchObject({ ok: false, reason: 'cannot-open' });
    await expect(sealedNoticeRecipientsDocument(signed, to, NOW, s.key, undefined as never)).rejects.toThrow(/recipientIdentityPublicKey is required/);
  });
});
