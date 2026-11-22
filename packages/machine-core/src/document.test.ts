import { createHmac, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Json } from './canonical.js';
import { canonicalize } from './canonical.js';
import {
  DOCUMENT_DOMAIN_V2,
  DOCUMENT_RETENTION_SECONDS,
  MAX_DOCUMENT_BYTES,
  buildDocument,
  derivePairSecret,
  derivePairSecretV2,
  documentId,
  documentSealContext,
  openPairSecret,
  pairSecretDocumentContext,
  verifyDocument,
  type SignedDocument,
} from './document.js';
import { generateSigningKeyPair, keyId } from './keys.js';
import { signPolicy, type PolicyBody } from './policy.js';
import { signRegistration, type RegistrationBody } from './registration.js';
import { signRevocation } from './revocation.js';
import { sealTo } from './seal.js';
import { signDocument } from './signed.js';

const NOW = 1_800_000_000;
const ADMIN_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TO = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

function setup() {
  const admin = generateSigningKeyPair();
  const recipient = generateSigningKeyPair();
  const peerKeys = generateSigningKeyPair();
  const registration = (uuid: string, identityPublicKey: string, signer = admin) => {
    const body: RegistrationBody = {
      v: 1,
      uuid,
      name: 'laptop',
      identityPublicKey,
      serial: NOW - 100,
      validFrom: NOW - 100,
      validTo: NOW + 86_400,
      adminKeyId: keyId(signer.publicKey),
    };
    return signRegistration(body, signer.privateKeyPkcs8);
  };
  const secret = new Uint8Array(32).fill(7);
  const sealedFor = (uuidTo: string, peerUuid: string, adminUuid: string | null = ADMIN_UUID) => sealTo(recipient.publicKey, secret, pairSecretDocumentContext(adminUuid, uuidTo, peerUuid));
  const peerPayload = (over: Record<string, unknown> = {}) => ({
    registration: registration(PEER, peerKeys.publicKey),
    sealedPairSecret: sealedFor(TO, PEER),
    adminUuid: ADMIN_UUID,
    ...over,
  });
  const policyBody = (target = TO): PolicyBody => ({
    v: 1,
    target,
    version: 2,
    baseVersion: 1,
    adminKeyId: keyId(admin.publicKey),
    issuedAt: NOW - 10,
    notBefore: NOW - 10,
    notAfter: NOW + 1000,
    defaults: [{ shell: 'sh', command: 'echo hi' }],
    peers: {},
  });
  const input = (over: Record<string, unknown> = {}) => ({
    kind: 'peer' as const,
    to: TO,
    id: documentId('peer:test'),
    issuedAt: NOW - 10,
    expiresAt: NOW + 1000,
    payload: peerPayload() as unknown as Json,
    recipientIdentityPublicKey: recipient.publicKey,
    ...over,
  });
  const ctx = (over: Record<string, unknown> = {}) => ({ adminPublicKey: admin.publicKey, selfUuid: TO, now: NOW, identityPrivateKeyPkcs8: recipient.privateKeyPkcs8, ...over });
  return { admin, recipient, peerKeys, secret, registration, peerPayload, policyBody, input, ctx, sealedFor };
}

type Setup = ReturnType<typeof setup>;
const built = (s: Setup, over: Record<string, unknown> = {}) => buildDocument(s.input(over) as never, s.admin.privateKeyPkcs8);
/** A document signed as is, bypassing the builder (to test what the verifier does with something a buggy or hostile admin would sign). */
const signRaw = (s: Setup, body: Record<string, unknown>, extraTop: Record<string, unknown> = {}): SignedDocument =>
  ({ body, signature: signDocument(DOCUMENT_DOMAIN_V2, body as Json, s.admin.privateKeyPkcs8), ...extraTop }) as unknown as SignedDocument;
/** An envelope version 2 body, its payload sealed with the context of the FINAL kind, addressee and id (so a test changes one thing at a time). */
const rawBody = (s: Setup, over: Record<string, unknown> = {}) => {
  const { recipientIdentityPublicKey, payload, ...rest } = Object.assign({}, s.input(), over) as ReturnType<Setup['input']>;
  const body = { v: 2, ...rest };
  return { ...body, payload: { sealed: sealTo(recipientIdentityPublicKey, Buffer.from(canonicalize(payload)), documentSealContext(body.kind, body.to, body.id)) } };
};

describe('document ids', () => {
  it('are 22 characters of base64url, the first 16 bytes of the SHA-256 of a stable string, and stable', () => {
    const id = documentId('peer:a:b');
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(documentId('peer:a:b')).toBe(id);
    expect(documentId('peer:a:c')).not.toBe(id);
  });
});

describe('buildDocument and verifyDocument: peer', () => {
  it('a document built by the admin verifies on the addressee and exposes the registration and the sealed secret', () => {
    const s = setup();
    const payload = s.peerPayload();
    const doc = built(s, { payload: payload as unknown as Json });
    const result = verifyDocument(doc, s.ctx());
    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== 'peer') throw new Error('expected a verified peer document');
    expect(result.body.id).toBe(doc.body.id);
    expect(result.registration.uuid).toBe(PEER);
    // The signed registration itself, as importPeer needs it.
    expect(result.signedRegistration).toEqual(payload.registration);
    expect(result.sealedPairSecret).toBe(payload.sealedPairSecret);
  });

  it('the same input gives other bytes (the payload is sealed with a fresh ephemeral key): a re-PUT is answered id_conflict by the relay', () => {
    const s = setup();
    const payload = s.peerPayload() as unknown as Json;
    expect(JSON.stringify(built(s, { payload }))).not.toBe(JSON.stringify(built(s, { payload })));
  });

  it('opens the pair secret with the identity key of the addressee', () => {
    const s = setup();
    const result = verifyDocument(built(s), s.ctx());
    if (!result.ok || result.kind !== 'peer') throw new Error('expected a verified peer document');
    const opened = openPairSecret(result, s.recipient.privateKeyPkcs8);
    expect(Buffer.from(opened, 'base64url').equals(Buffer.from(s.secret))).toBe(true);
  });

  it('refuses to open a secret sealed for another recipient, another peer or another admin machine (context)', () => {
    const s = setup();
    for (const sealed of [s.sealedFor(OTHER, PEER), s.sealedFor(TO, OTHER), s.sealedFor(TO, PEER, null)]) {
      const result = verifyDocument(built(s, { payload: s.peerPayload({ sealedPairSecret: sealed }) as unknown as Json }), s.ctx());
      if (!result.ok || result.kind !== 'peer') throw new Error('expected a verified peer document');
      expect(() => openPairSecret(result, s.recipient.privateKeyPkcs8)).toThrow(/cannot open the sealed pair secret/);
    }
  });

  it('refuses to open with another identity key, without leaking the secret', () => {
    const s = setup();
    const result = verifyDocument(built(s), s.ctx());
    if (!result.ok || result.kind !== 'peer') throw new Error('expected a verified peer document');
    expect(() => openPairSecret(result, generateSigningKeyPair().privateKeyPkcs8)).toThrow(/cannot open the sealed pair secret/);
  });

  it('the context names the admin machine (or none), the addressee and the peer', () => {
    expect(pairSecretDocumentContext(ADMIN_UUID, TO, PEER)).toBe(`pair-secret:${ADMIN_UUID}:${TO}:${PEER}`);
    expect(pairSecretDocumentContext(null, TO, PEER)).toBe(`pair-secret:none:${TO}:${PEER}`);
  });

  it('refuses a registration that is not signed by the pinned admin key', () => {
    const s = setup();
    const stranger = generateSigningKeyPair();
    const payload = s.peerPayload({ registration: s.registration(PEER, s.peerKeys.publicKey, stranger) }) as unknown as Json;
    expect(verifyDocument(built(s, { payload }), s.ctx())).toMatchObject({ ok: false, reason: 'invalid-payload' });
  });

  it('refuses a peer document about the addressee itself', () => {
    const s = setup();
    const payload = s.peerPayload({ registration: s.registration(TO, s.peerKeys.publicKey) }) as unknown as Json;
    expect(verifyDocument(built(s, { payload }), s.ctx())).toMatchObject({ ok: false, reason: 'self-peer' });
  });

  it('refuses a revoked registration (revocation-aware)', () => {
    const s = setup();
    const result = verifyDocument(built(s), s.ctx({ isRevoked: (uuid: string) => uuid === PEER }));
    expect(result).toMatchObject({ ok: false, reason: 'revoked' });
  });

  it('a registration that starts in the future is reported as not-yet-valid (the daemon keeps the document and retries)', () => {
    const s = setup();
    const future = { ...s.registration(PEER, s.peerKeys.publicKey) };
    const body: RegistrationBody = { ...future.body, validFrom: NOW + 500, validTo: NOW + 90_000 };
    const payload = s.peerPayload({ registration: signRegistration(body, s.admin.privateKeyPkcs8) }) as unknown as Json;
    expect(verifyDocument(built(s, { payload }), s.ctx())).toMatchObject({ ok: false, reason: 'not-yet-valid' });
  });

  it('refuses a payload with an unknown field, even signed, and a bad adminUuid', () => {
    const s = setup();
    expect(verifyDocument(signRaw(s, rawBody(s, { payload: s.peerPayload({ extra: 1 }) })), s.ctx())).toMatchObject({ ok: false, reason: 'malformed' });
    expect(verifyDocument(signRaw(s, rawBody(s, { payload: s.peerPayload({ adminUuid: 'nope' }) })), s.ctx())).toMatchObject({ ok: false, reason: 'malformed' });
    expect(verifyDocument(built(s, { payload: s.peerPayload({ adminUuid: null }) as unknown as Json }), s.ctx()).ok).toBe(true);
  });
});

describe('verifyDocument: tampering and addressing', () => {
  it('refuses every tampered field of the body and the signature', () => {
    const s = setup();
    const doc = built(s);
    const mutate = (over: Record<string, unknown>): SignedDocument => ({ ...doc, body: { ...doc.body, ...over } }) as SignedDocument;
    const cases: Record<string, SignedDocument> = {
      kind: mutate({ kind: 'revocation' }),
      to: mutate({ to: OTHER }),
      id: mutate({ id: documentId('another') }),
      issuedAt: mutate({ issuedAt: doc.body.issuedAt + 1 }),
      expiresAt: mutate({ expiresAt: doc.body.expiresAt + 1 }),
      payload: mutate({ payload: { ...(doc.body.payload as object), sealed: 'AAAA' } }),
      signature: { ...doc, signature: `${doc.signature.slice(0, -2)}${doc.signature.endsWith('AA') ? 'BB' : 'AA'}` },
    };
    for (const [field, tampered] of Object.entries(cases)) {
      expect(verifyDocument(tampered, s.ctx()), field).toMatchObject({ ok: false, reason: 'bad-signature' });
    }
  });

  it('refuses a document signed by another key than the pinned admin key', () => {
    const s = setup();
    const doc = buildDocument(s.input() as never, generateSigningKeyPair().privateKeyPkcs8);
    expect(verifyDocument(doc, s.ctx())).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('refuses an invalid pinned admin key with the usual message', () => {
    const s = setup();
    expect(verifyDocument(built(s), s.ctx({ adminPublicKey: 'nope' }))).toMatchObject({ ok: false, reason: 'invalid-admin-key' });
  });

  it('refuses a validly signed document addressed to another machine', () => {
    const s = setup();
    const result = verifyDocument(built(s, { to: OTHER }), s.ctx());
    expect(result).toMatchObject({ ok: false, reason: 'wrong-recipient' });
    if (!result.ok) expect(result.message).toContain(OTHER);
  });

  it('refuses a document whose time window has passed or has not started, with a tolerance for the clock skew', () => {
    const s = setup();
    const doc = built(s, { issuedAt: NOW - 100, expiresAt: NOW + 100 });
    expect(verifyDocument(doc, s.ctx({ now: NOW + 101 }))).toMatchObject({ ok: true });
    expect(verifyDocument(doc, s.ctx({ now: NOW + 131 }))).toMatchObject({ ok: false, reason: 'expired' });
    // Not-yet-valid side: the leeway of 120 s (decision 88); the expiry side keeps its 30 s.
    expect(verifyDocument(doc, s.ctx({ now: NOW - 100 - 120 }))).toMatchObject({ ok: true });
    expect(verifyDocument(doc, s.ctx({ now: NOW - 100 - 121 }))).toMatchObject({ ok: false, reason: 'not-yet-valid' });
    expect(verifyDocument(doc, s.ctx({ now: NOW + 131, skewSeconds: 60 }))).toMatchObject({ ok: true });
  });

  it('a registration inside a peer document starts up to the leeway before its validFrom, not more', () => {
    const s = setup();
    const future = { ...s.registration(PEER, s.peerKeys.publicKey) };
    const body: RegistrationBody = { ...future.body, validFrom: NOW + 120, validTo: NOW + 90_000 };
    const payload = s.peerPayload({ registration: signRegistration(body, s.admin.privateKeyPkcs8) }) as unknown as Json;
    expect(verifyDocument(built(s, { payload, issuedAt: NOW - 100 }), s.ctx())).toMatchObject({ ok: true });
    const late: RegistrationBody = { ...body, validFrom: NOW + 121 };
    const latePayload = s.peerPayload({ registration: signRegistration(late, s.admin.privateKeyPkcs8) }) as unknown as Json;
    expect(verifyDocument(built(s, { payload: latePayload, issuedAt: NOW - 100 }), s.ctx())).toMatchObject({ ok: false, reason: 'not-yet-valid' });
  });

  it('refuses things that are not documents', () => {
    const s = setup();
    for (const junk of [null, 'x', 5, [], {}, { body: {}, signature: 's' }, { body: 'x', signature: 1 }]) {
      expect(verifyDocument(junk, s.ctx()), JSON.stringify(junk)).toMatchObject({ ok: false, reason: 'malformed' });
    }
  });

  it('refuses unknown fields at the top level and in the body, even when the admin signed them', () => {
    const s = setup();
    expect(verifyDocument(signRaw(s, rawBody(s), { extra: true }), s.ctx())).toMatchObject({ ok: false, reason: 'malformed' });
    expect(verifyDocument(signRaw(s, rawBody(s, { extra: 1 })), s.ctx())).toMatchObject({ ok: false, reason: 'malformed' });
    const noVersion = rawBody(s);
    delete (noVersion as Record<string, unknown>).v;
    expect(verifyDocument(signRaw(s, noVersion), s.ctx())).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('refuses a misaddressed or malformed id, an unknown kind, a bad version and a bad time window', () => {
    const s = setup();
    for (const over of [
      { id: 'short' },
      { id: `${documentId('x')}=` },
      { id: 'A'.repeat(22) + '!' },
      // 22 characters whose last character carries bits beyond 16 bytes: not a canonical encoding
      { id: `${documentId('x').slice(0, 21)}B` },
      { kind: 'command' },
      { v: 3 },
      { to: ADMIN_UUID.toUpperCase() },
      { issuedAt: '1800000000' },
      { expiresAt: NOW - 1000 },
    ]) {
      const result = verifyDocument(signRaw(s, rawBody(s, over)), s.ctx());
      expect(result.ok, JSON.stringify(over)).toBe(false);
      if (!result.ok) expect(['malformed', 'expired']).toContain(result.reason);
    }
  });

  it('refuses a document larger than 16 KiB before looking at its signature', () => {
    const s = setup();
    const huge = signRaw(s, rawBody(s, { payload: { filler: 'x'.repeat(MAX_DOCUMENT_BYTES) } }));
    expect(verifyDocument(huge, s.ctx())).toMatchObject({ ok: false, reason: 'too-large' });
    const unsigned = { body: rawBody(s, { payload: { filler: 'x'.repeat(MAX_DOCUMENT_BYTES) } }), signature: 'bad' };
    expect(verifyDocument(unsigned, s.ctx())).toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('the builder refuses the same things (it never signs a document that no machine would accept)', () => {
    const s = setup();
    expect(() => built(s, { payload: s.peerPayload({ sealedPairSecret: 'A'.repeat(MAX_DOCUMENT_BYTES) }) as unknown as Json })).toThrow(/16 KiB|too large/);
    expect(() => built(s, { id: 'short' })).toThrow(/id/);
    expect(() => built(s, { kind: 'command' })).toThrow(/kind/);
    expect(() => built(s, { expiresAt: NOW - 1000 })).toThrow(/expiresAt/);
    expect(() => built(s, { to: 'nope' })).toThrow(/to/);
    expect(() => built(s, { payload: s.peerPayload({ extra: 1 }) as unknown as Json })).toThrow(/unknown field/);
  });

  it('documents live at most as long as the relay keeps them', () => {
    expect(DOCUMENT_RETENTION_SECONDS).toBe(30 * 86_400);
  });
});

describe('verifyDocument: policy and revocation', () => {
  it('a policy document carries a signed policy for the addressee', () => {
    const s = setup();
    const signed = signPolicy(s.policyBody(), s.admin.privateKeyPkcs8);
    const result = verifyDocument(built(s, { kind: 'policy', payload: signed as unknown as Json }), s.ctx());
    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== 'policy') throw new Error('expected a policy document');
    expect(result.policy).toEqual(signed);
  });

  it('refuses a policy written for another machine than the one the document is addressed to', () => {
    const s = setup();
    const signed = signPolicy(s.policyBody(OTHER), s.admin.privateKeyPkcs8);
    expect(verifyDocument(built(s, { kind: 'policy', payload: signed as unknown as Json }), s.ctx())).toMatchObject({ ok: false, reason: 'invalid-payload' });
  });

  it('refuses a policy payload that is not a policy, with an unknown field or without signature', () => {
    const s = setup();
    const signed = signPolicy(s.policyBody(), s.admin.privateKeyPkcs8);
    for (const payload of [{ ...signed, extra: 1 }, { body: signed.body }, { ...signed, body: { ...signed.body, version: 5 } }]) {
      const result = verifyDocument(signRaw(s, rawBody(s, { kind: 'policy', payload })), s.ctx());
      expect(result.ok, JSON.stringify(Object.keys(payload))).toBe(false);
    }
  });

  it('a revocation document carries a signed revocation list', () => {
    const s = setup();
    const signed = signRevocation({ v: 1, adminKeyId: keyId(s.admin.publicKey), issuedAt: NOW - 5, entries: [{ uuid: PEER, serial: 3 }] }, s.admin.privateKeyPkcs8);
    const result = verifyDocument(built(s, { kind: 'revocation', payload: signed as unknown as Json }), s.ctx());
    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== 'revocation') throw new Error('expected a revocation document');
    expect(result.revocation).toEqual(signed);
  });

  it('refuses a revocation payload that is not a revocation list', () => {
    const s = setup();
    expect(verifyDocument(built(s, { kind: 'revocation', payload: { body: { v: 1 }, signature: 'x' } as unknown as Json }), s.ctx())).toMatchObject({ ok: false, reason: 'invalid-payload' });
  });
});

describe('derivePairSecret', () => {
  const a = { uuid: PEER, serial: 5 };
  const b = { uuid: TO, serial: 9 };

  it('is 32 bytes, the same for both sides of the pair and for every run (so a retry builds the same secret)', () => {
    const s = setup();
    const x = derivePairSecret(s.admin.privateKeyPkcs8, a, b);
    expect(Buffer.from(x, 'base64url')).toHaveLength(32);
    expect(derivePairSecret(s.admin.privateKeyPkcs8, b, a)).toBe(x);
    expect(derivePairSecret(s.admin.privateKeyPkcs8, a, b)).toBe(x);
  });

  it('changes with the admin key, the machines and the serials', () => {
    const s = setup();
    const x = derivePairSecret(s.admin.privateKeyPkcs8, a, b);
    expect(derivePairSecret(generateSigningKeyPair().privateKeyPkcs8, a, b)).not.toBe(x);
    expect(derivePairSecret(s.admin.privateKeyPkcs8, a, { ...b, uuid: OTHER })).not.toBe(x);
    expect(derivePairSecret(s.admin.privateKeyPkcs8, a, { ...b, serial: 10 })).not.toBe(x);
  });

  it('refuses a key that is not an Ed25519 PKCS8 key', () => {
    expect(() => derivePairSecret(new Uint8Array(10), a, b)).toThrow(/private key/);
  });
});

describe('verifyDocument: what was verified (the receiver remembers nothing about what it could not verify)', () => {
  it('failures before the signature check say signed=false, after it signed=true', () => {
    const s = setup();
    const doc = built(s);
    const tampered = { ...doc, body: { ...doc.body, kind: 'revocation' } };
    const expectSigned = (result: ReturnType<typeof verifyDocument>, signed: boolean, label: string) => {
      expect(result.ok, label).toBe(false);
      if (!result.ok) expect(result.signed, label).toBe(signed);
    };
    expectSigned(verifyDocument(null, s.ctx()), false, 'not a document');
    expectSigned(verifyDocument(signRaw(s, rawBody(s, { extra: 1 })), s.ctx()), false, 'unknown field');
    expectSigned(verifyDocument(tampered, s.ctx()), false, 'tampered');
    expectSigned(verifyDocument(buildDocument(s.input() as never, generateSigningKeyPair().privateKeyPkcs8), s.ctx()), false, 'other key');
    expectSigned(verifyDocument(doc, s.ctx({ adminPublicKey: 'nope' })), false, 'invalid pinned key');
    expectSigned(verifyDocument(built(s, { to: OTHER }), s.ctx()), true, 'wrong recipient');
    expectSigned(verifyDocument(doc, s.ctx({ now: NOW + 100_000 })), true, 'expired');
    expectSigned(verifyDocument(doc, s.ctx({ now: NOW - 100_000 })), true, 'not yet valid');
    expectSigned(verifyDocument(built(s, { payload: s.peerPayload({ registration: s.registration(TO, s.peerKeys.publicKey) }) as unknown as Json }), s.ctx()), true, 'self peer');
    expectSigned(verifyDocument(signRaw(s, rawBody(s, { payload: s.peerPayload({ extra: 1 }) })), s.ctx()), true, 'payload shape');
  });

  it('refuses a document that lives longer than the relay keeps it (30 days), verifier and builder', () => {
    const s = setup();
    const over = { issuedAt: NOW - 10, expiresAt: NOW - 10 + DOCUMENT_RETENTION_SECONDS + 1 };
    expect(verifyDocument(signRaw(s, rawBody(s, over)), s.ctx())).toMatchObject({ ok: false, reason: 'malformed' });
    expect(() => built(s, over)).toThrow(/30 days/);
    expect(verifyDocument(built(s, { issuedAt: NOW - 10, expiresAt: NOW - 10 + DOCUMENT_RETENTION_SECONDS }), s.ctx()).ok).toBe(true);
  });
});

describe('derivePairSecret key separation', () => {
  it('is keyed by an HKDF subkey of the admin seed, not by the raw PKCS8 bytes used for signing', () => {
    const s = setup();
    const a = { uuid: PEER, serial: 5 };
    const b = { uuid: TO, serial: 9 };
    const data = `machine/pair-secret/v1\0${TO}:9\0${PEER}:5`;
    const sorted = a.uuid <= b.uuid ? `machine/pair-secret/v1\0${a.uuid}:5\0${b.uuid}:9` : data;
    const rawKeyed = createHmac('sha256', Buffer.from(s.admin.privateKeyPkcs8)).update(sorted, 'utf8').digest().toString('base64url');
    expect(derivePairSecret(s.admin.privateKeyPkcs8, a, b)).not.toBe(rawKeyed);
    const seed = Buffer.from(s.admin.privateKeyPkcs8).subarray(16);
    const subkey = Buffer.from(hkdfSync('sha256', seed, Buffer.alloc(0), 'machine/pair-secret/v1', 32));
    const expected = createHmac('sha256', subkey).update(sorted, 'utf8').digest().toString('base64url');
    expect(derivePairSecret(s.admin.privateKeyPkcs8, a, b)).toBe(expected);
  });
});

describe('derivePairSecretV2 (deterministic signature, no raw seed needed)', () => {
  const a = { uuid: PEER, serial: 5 };
  const b = { uuid: TO, serial: 9 };

  it('is 32 bytes, the same for both orders and every run', () => {
    const s = setup();
    const x = derivePairSecretV2(s.admin.privateKeyPkcs8, a, b);
    expect(Buffer.from(x, 'base64url')).toHaveLength(32);
    expect(derivePairSecretV2(s.admin.privateKeyPkcs8, b, a)).toBe(x);
    expect(derivePairSecretV2(s.admin.privateKeyPkcs8, a, b)).toBe(x);
  });

  it('changes with the admin key, the machines and the serials, and differs from the v1 secret', () => {
    const s = setup();
    const x = derivePairSecretV2(s.admin.privateKeyPkcs8, a, b);
    expect(derivePairSecretV2(generateSigningKeyPair().privateKeyPkcs8, a, b)).not.toBe(x);
    expect(derivePairSecretV2(s.admin.privateKeyPkcs8, a, { ...b, uuid: OTHER })).not.toBe(x);
    expect(derivePairSecretV2(s.admin.privateKeyPkcs8, a, { ...b, serial: 10 })).not.toBe(x);
    expect(derivePairSecretV2(s.admin.privateKeyPkcs8, a, b)).not.toBe(derivePairSecret(s.admin.privateKeyPkcs8, a, b));
  });

  it('refuses a key that is not Ed25519 PKCS8, a bad uuid or serial, and a machine paired with itself', () => {
    const s = setup();
    expect(() => derivePairSecretV2(new Uint8Array(10), a, b)).toThrow(/private key/);
    expect(() => derivePairSecretV2(s.admin.privateKeyPkcs8, { uuid: 'nope', serial: 1 }, b)).toThrow(/uuid/);
    expect(() => derivePairSecretV2(s.admin.privateKeyPkcs8, { uuid: PEER, serial: 0 }, b)).toThrow(/serial/);
    expect(() => derivePairSecretV2(s.admin.privateKeyPkcs8, a, a)).toThrow(/itself/);
  });
});
