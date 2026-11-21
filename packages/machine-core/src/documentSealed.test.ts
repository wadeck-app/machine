import { describe, expect, it } from 'vitest';
import type { Json } from './canonical.js';
import { canonicalize } from './canonical.js';
import {
  DOCUMENT_DOMAIN,
  DOCUMENT_DOMAIN_V2,
  MAX_DOCUMENT_BYTES,
  buildDocument,
  documentId,
  documentSealContext,
  pairSecretDocumentContext,
  verifyDocument,
  verifyDocumentEnvelope,
  type SignedDocument,
} from './document.js';
import { generateSigningKeyPair, keyId } from './keys.js';
import { signPolicy, type PolicyBody } from './policy.js';
import { signRegistration, type RegistrationBody } from './registration.js';
import { signRevocation } from './revocation.js';
import { sealTo } from './seal.js';
import { signDocument } from './signed.js';

// Decision 78: every document the admin puts in an inbox is sealed to the identity key of the addressee. The relay keeps only what it needs to route.

const NOW = 1_800_000_000;
const ADMIN_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TO = '11111111-1111-4111-8111-111111111111';
const OTHER_TO = '33333333-3333-4333-8333-333333333333';
const PEER = '22222222-2222-4222-8222-222222222222';
const SECRET_COMMAND = 'rm -rf /srv/very-secret-command-text';

function setup() {
  const admin = generateSigningKeyPair();
  const recipient = generateSigningKeyPair();
  const peerKeys = generateSigningKeyPair();
  const policy = signPolicy(
    {
      v: 1,
      target: TO,
      version: 2,
      baseVersion: 1,
      adminKeyId: keyId(admin.publicKey),
      issuedAt: NOW - 10,
      notBefore: NOW - 10,
      notAfter: NOW + 1000,
      defaults: [{ shell: 'sh', command: SECRET_COMMAND }],
      peers: {},
    } satisfies PolicyBody,
    admin.privateKeyPkcs8,
  );
  const revocation = signRevocation({ v: 1, adminKeyId: keyId(admin.publicKey), issuedAt: NOW - 5, entries: [{ uuid: OTHER_TO, serial: 4 }] }, admin.privateKeyPkcs8);
  const registration = signRegistration(
    { v: 1, uuid: PEER, name: 'secret-laptop', identityPublicKey: peerKeys.publicKey, serial: 3, validFrom: NOW - 100, validTo: NOW + 86_400, adminKeyId: keyId(admin.publicKey) } satisfies RegistrationBody,
    admin.privateKeyPkcs8,
  );
  const peerPayload = { registration, sealedPairSecret: sealTo(recipient.publicKey, new Uint8Array(32).fill(7), pairSecretDocumentContext(ADMIN_UUID, TO, PEER)), adminUuid: ADMIN_UUID };
  const input = (kind: 'peer' | 'policy' | 'revocation', over: Record<string, unknown> = {}) => ({
    kind,
    to: TO,
    id: documentId(`${kind}:test`),
    issuedAt: NOW - 10,
    expiresAt: NOW + 1000,
    payload: (kind === 'peer' ? peerPayload : kind === 'policy' ? policy : revocation) as unknown as Json,
    recipientIdentityPublicKey: recipient.publicKey,
    ...over,
  });
  const ctx = (over: Record<string, unknown> = {}) => ({ adminPublicKey: admin.publicKey, selfUuid: TO, now: NOW, identityPrivateKeyPkcs8: recipient.privateKeyPkcs8, ...over });
  return { admin, recipient, policy, revocation, registration, peerPayload, input, ctx };
}

const build = (s: ReturnType<typeof setup>, kind: 'peer' | 'policy' | 'revocation', over: Record<string, unknown> = {}) => buildDocument(s.input(kind, over) as never, s.admin.privateKeyPkcs8);
const signRaw = (s: ReturnType<typeof setup>, body: Record<string, unknown>, domain = DOCUMENT_DOMAIN_V2): SignedDocument =>
  ({ body, signature: signDocument(domain, body as Json, s.admin.privateKeyPkcs8) }) as unknown as SignedDocument;

describe('sealed documents: what the relay can read', () => {
  it.each(['peer', 'policy', 'revocation'] as const)('a %s document is envelope version 2 and its payload is one sealed blob and nothing else', (kind) => {
    const s = setup();
    const doc = build(s, kind);
    expect(doc.body.v).toBe(2);
    expect(doc.body.kind).toBe(kind);
    expect(Object.keys(doc.body.payload as object)).toEqual(['sealed']);
  });

  it('the serialized document holds no command text, no shell, no machine name, no revoked uuid, no registration', () => {
    const s = setup();
    for (const kind of ['peer', 'policy', 'revocation'] as const) {
      const text = JSON.stringify(build(s, kind));
      for (const forbidden of [SECRET_COMMAND, 'very-secret', '"shell"', 'secret-laptop', OTHER_TO, PEER, ADMIN_UUID, 'identityPublicKey', 'defaults', 'entries']) {
        expect(text, `${kind} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('sealing is random: the same input gives other bytes (the relay answers id_conflict on a re-PUT, which the admin reports as already there)', () => {
    const s = setup();
    expect(JSON.stringify(build(s, 'policy'))).not.toBe(JSON.stringify(build(s, 'policy')));
  });

  it('the builder refuses an input without the key of the addressee: there is no plaintext document', () => {
    const s = setup();
    const { recipientIdentityPublicKey: _dropped, ...without } = s.input('policy');
    expect(() => buildDocument(without as never, s.admin.privateKeyPkcs8)).toThrow(/recipientIdentityPublicKey.*plaintext|plaintext.*recipientIdentityPublicKey/is);
  });

  it('the builder still refuses a payload no machine would accept, before sealing it', () => {
    const s = setup();
    expect(() => build(s, 'policy', { payload: { body: { v: 1 }, signature: 'x' } })).toThrow(/policy/);
  });

  it('the builder refuses a document that does not fit the 16 KiB of the relay once sealed, naming the limit', () => {
    const s = setup();
    const entries = Array.from({ length: 300 }, (_v, i) => ({ uuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, serial: 1 }));
    const big = signRevocation({ v: 1, adminKeyId: keyId(s.admin.publicKey), issuedAt: NOW, entries }, s.admin.privateKeyPkcs8);
    expect(() => build(s, 'revocation', { payload: big })).toThrow(new RegExp(String(MAX_DOCUMENT_BYTES)));
  });
});

describe('sealed documents: the addressee', () => {
  it('opens a peer, a policy and a revocation document with its identity key and finds what the admin signed', () => {
    const s = setup();
    const peer = verifyDocument(build(s, 'peer'), s.ctx());
    const policy = verifyDocument(build(s, 'policy'), s.ctx());
    const revocation = verifyDocument(build(s, 'revocation'), s.ctx());
    if (!peer.ok || peer.kind !== 'peer' || !policy.ok || policy.kind !== 'policy' || !revocation.ok || revocation.kind !== 'revocation') {
      throw new Error('expected three verified documents');
    }
    expect(peer.registration.uuid).toBe(PEER);
    expect(policy.policy).toEqual(s.policy);
    expect(revocation.revocation).toEqual(s.revocation);
  });

  it('cannot open a document sealed to another machine (reason cannot-open, a verdict on a signed document)', () => {
    const s = setup();
    const stranger = generateSigningKeyPair();
    const result = verifyDocument(build(s, 'policy'), s.ctx({ identityPrivateKeyPkcs8: stranger.privateKeyPkcs8 }));
    expect(result).toMatchObject({ ok: false, reason: 'cannot-open', signed: true, message: expect.stringMatching(/not sealed to the identity key of this machine/) });
  });

  it('without an identity key the document is not readable: it says so instead of guessing', () => {
    const s = setup();
    const result = verifyDocument(build(s, 'policy'), s.ctx({ identityPrivateKeyPkcs8: undefined }));
    expect(result).toMatchObject({ ok: false, reason: 'sealed-unopened', signed: true });
  });

  it('a sealed payload cannot be replayed as another document type', () => {
    const s = setup();
    const doc = build(s, 'policy');
    const body = { ...doc.body, kind: 'revocation' };
    expect(verifyDocument(signRaw(s, body), s.ctx())).toMatchObject({ ok: false, reason: 'cannot-open' });
  });

  it('a sealed payload cannot be replayed to another recipient or under another id', () => {
    const s = setup();
    const doc = build(s, 'policy');
    // Same recipient key, other uuid in `to` (two machines that share a key would be a bug, the context still separates them).
    expect(verifyDocument(signRaw(s, { ...doc.body, to: OTHER_TO }), s.ctx({ selfUuid: OTHER_TO }))).toMatchObject({ ok: false, reason: 'cannot-open' });
    expect(verifyDocument(signRaw(s, { ...doc.body, id: documentId('another') }), s.ctx())).toMatchObject({ ok: false, reason: 'cannot-open' });
  });

  it('the context names the type, the recipient and the id', () => {
    expect(documentSealContext('policy', TO, 'abc')).toBe(`document-payload:v2:policy:${TO}:abc`);
    expect(documentSealContext('policy', TO, 'abc')).not.toBe(documentSealContext('revocation', TO, 'abc'));
  });

  it('refuses a sealed payload whose content is not the shape of its kind, even signed (a hostile admin cannot make it pass)', () => {
    const s = setup();
    const id = documentId('hostile');
    const sealed = sealTo(s.recipient.publicKey, Buffer.from(canonicalize({ nonsense: true } as Json)), documentSealContext('policy', TO, id));
    const result = verifyDocument(signRaw(s, { v: 2, kind: 'policy', to: TO, id, issuedAt: NOW - 10, expiresAt: NOW + 1000, payload: { sealed } }), s.ctx());
    expect(result).toMatchObject({ ok: false, reason: 'malformed', signed: true });
  });

  it('refuses a v2 document whose payload is not exactly { sealed } (a plain payload slipped into the new envelope)', () => {
    const s = setup();
    const doc = build(s, 'policy');
    const plain = signRaw(s, { ...doc.body, payload: s.policy as unknown as Json });
    expect(verifyDocument(plain, s.ctx())).toMatchObject({ ok: false, reason: 'malformed' });
    const extra = signRaw(s, { ...doc.body, payload: { ...(doc.body.payload as object), extra: 1 } });
    expect(verifyDocument(extra, s.ctx())).toMatchObject({ ok: false, reason: 'malformed' });
  });
});

describe('plaintext documents (envelope version 1) are refused', () => {
  const legacy = (s: ReturnType<typeof setup>, over: Record<string, unknown> = {}): SignedDocument =>
    signRaw(s, { v: 1, kind: 'policy', to: TO, id: documentId('old'), issuedAt: NOW - 10, expiresAt: NOW + 1000, payload: s.policy as unknown as Json, ...over }, DOCUMENT_DOMAIN);

  it('a version 1 document signed by the admin is refused as plaintext, with the fix in the message, and is a verdict on a document of the admin', () => {
    const s = setup();
    const result = verifyDocument(legacy(s), s.ctx());
    expect(result).toMatchObject({ ok: false, reason: 'plaintext', signed: true });
    if (!result.ok) {
      expect(result.message).toMatch(/PLAINTEXT/);
      expect(result.message).toMatch(/machine cli update/);
      expect(result.message).toMatch(/machine admin distribute/);
      // The refusal never echoes the content.
      expect(result.message).not.toContain(SECRET_COMMAND);
    }
  });

  it('a version 1 document that the pinned key did not sign is junk, not a verdict (signed false, nothing audited one by one)', () => {
    const s = setup();
    const other = generateSigningKeyPair();
    const forged = { body: legacy(s).body, signature: signDocument(DOCUMENT_DOMAIN, legacy(s).body as unknown as Json, other.privateKeyPkcs8) } as SignedDocument;
    expect(verifyDocument(forged, s.ctx())).toMatchObject({ ok: false, reason: 'bad-signature', signed: false });
  });

  it('is refused for the three kinds, whatever the payload looks like', () => {
    const s = setup();
    for (const kind of ['peer', 'policy', 'revocation'] as const) {
      expect(verifyDocument(legacy(s, { kind, payload: { anything: 1 } }), s.ctx())).toMatchObject({ ok: false, reason: 'plaintext' });
    }
  });

  it('an unknown envelope version is refused and says to update', () => {
    const s = setup();
    const doc = signRaw(s, { ...build(s, 'policy').body, v: 3 });
    const result = verifyDocument(doc, s.ctx());
    expect(result).toMatchObject({ ok: false, reason: 'malformed', message: expect.stringMatching(/version 3/) });
  });
});

describe('signature domains', () => {
  it('a version 2 document verifies only under the version 2 domain', () => {
    const s = setup();
    const doc = build(s, 'policy');
    expect(verifyDocument(doc, s.ctx())).toMatchObject({ ok: true });
    const wrongDomain = signRaw(s, { ...doc.body }, DOCUMENT_DOMAIN);
    expect(verifyDocument(wrongDomain, s.ctx())).toMatchObject({ ok: false, reason: 'bad-signature' });
  });
});

describe('verifyDocumentEnvelope (the admin side check, no key needed)', () => {
  it('accepts a document of the admin addressed to the machine and gives the type tag, without opening it', () => {
    const s = setup();
    const r = verifyDocumentEnvelope(build(s, 'policy'), { adminPublicKey: s.admin.publicKey, selfUuid: TO, now: NOW });
    expect(r).toMatchObject({ ok: true, kind: 'policy', body: { to: TO } });
  });

  it('refuses a plaintext document, a bad signature and another addressee exactly like verifyDocument', () => {
    const s = setup();
    const ctx = { adminPublicKey: s.admin.publicKey, selfUuid: TO, now: NOW };
    expect(verifyDocumentEnvelope(signRaw(s, { v: 1, kind: 'policy', to: TO, id: documentId('o'), issuedAt: NOW - 10, expiresAt: NOW + 1000, payload: s.policy as unknown as Json }, DOCUMENT_DOMAIN), ctx)).toMatchObject({ ok: false, reason: 'plaintext' });
    const tampered = { ...build(s, 'policy'), signature: 'AAAA' };
    expect(verifyDocumentEnvelope(tampered, ctx)).toMatchObject({ ok: false, reason: 'bad-signature' });
    expect(verifyDocumentEnvelope(build(s, 'policy'), { ...ctx, selfUuid: OTHER_TO })).toMatchObject({ ok: false, reason: 'wrong-recipient' });
  });
});
