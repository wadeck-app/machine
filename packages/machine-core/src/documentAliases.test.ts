import { describe, expect, it } from 'vitest';
import { signAliases, type AliasesBody } from './aliases.js';
import type { Json } from './canonical.js';
import { DOCUMENT_KINDS, buildDocument, documentId, verifyDocument } from './document.js';
import { generateSigningKeyPair, keyId } from './keys.js';

// Decision 116: an `aliases` document carries the admin-signed list, sealed to the addressee like every other document.

const NOW = 1_800_000_000;
const SELF = '14695579-c70a-44ea-9831-5284c05ea5a2';
const THINK = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';

function setup() {
  const admin = generateSigningKeyPair();
  const machine = generateSigningKeyPair();
  const body: AliasesBody = { v: 1, adminKeyId: keyId(admin.publicKey), serial: NOW, issuedAt: NOW, entries: [{ alias: 'box', uuid: THINK }] };
  const document = (payload: unknown, to = SELF) =>
    buildDocument({ kind: 'aliases', to, id: documentId('aliases:test'), issuedAt: NOW - 10, expiresAt: NOW + 1000, payload: payload as Json, recipientIdentityPublicKey: machine.publicKey }, admin.privateKeyPkcs8);
  const ctx = (over: Record<string, unknown> = {}) => ({ adminPublicKey: admin.publicKey, selfUuid: SELF, now: NOW, identityPrivateKeyPkcs8: machine.privateKeyPkcs8, ...over });
  return { admin, machine, body, document, ctx };
}

describe('aliases documents', () => {
  it('is a document kind', () => {
    expect(DOCUMENT_KINDS).toContain('aliases');
  });

  it('the addressee opens one and gets the signed list', () => {
    const { admin, body, document, ctx } = setup();
    const signed = signAliases(body, admin.privateKeyPkcs8);
    expect(verifyDocument(document(signed), ctx())).toMatchObject({ ok: true, kind: 'aliases', aliases: signed });
  });

  it('the aliases travel sealed: the relay reads the type tag and the size, never an alias', () => {
    const { admin, body, document } = setup();
    const doc = document(signAliases(body, admin.privateKeyPkcs8));
    expect(JSON.stringify(doc)).not.toContain('"box"');
    expect(doc.body.kind).toBe('aliases');
  });

  it('refuses a list that the pinned admin key did not sign, naming the cause', () => {
    const { body, document, ctx } = setup();
    const stranger = generateSigningKeyPair();
    const verified = verifyDocument(document(signAliases({ ...body, adminKeyId: keyId(stranger.publicKey) }, stranger.privateKeyPkcs8)), ctx());
    expect(verified).toMatchObject({ ok: false, reason: 'invalid-payload' });
    expect((verified as { message: string }).message).toMatch(/aliases list that is not valid \(wrong-admin-key\)/);
  });

  it('refuses a payload with another shape before sealing it', () => {
    const { admin, body, document } = setup();
    const signed = signAliases(body, admin.privateKeyPkcs8);
    expect(() => document({ ...signed, extra: 1 })).toThrow(/unknown field "extra"/);
    expect(() => document({ body: { ...body, entries: [{ alias: 'Bad Alias', uuid: THINK }] }, signature: 'x' })).toThrow(/alias "Bad Alias"/);
  });
});
