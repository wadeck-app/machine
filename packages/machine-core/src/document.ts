import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { canonicalize, type Json } from './canonical.js';
import { INVALID_ADMIN_KEY_MESSAGE, decodeBase64urlStrict, signBytes, tryKeyId } from './keys.js';
import { POLICY_DOMAIN, assertPolicyBody, type SignedPolicy } from './policy.js';
import { verifyRegistration, type RegistrationBody, type SignedRegistration } from './registration.js';
import { verifyRevocation, type SignedRevocation } from './revocation.js';
import { assertNoticeRecipientsBody, verifyNoticeRecipients, type SignedNoticeRecipients } from './noticeRecipients.js';
import { openSealed, sealTo } from './seal.js';
import { signDocument, verifyDocument as verifySigned } from './signed.js';

// Documents distributed through the relay (distribution.md): a JSON object signed by the admin key and addressed to ONE
// machine. The relay only stores them; the recipient verifies everything locally. No I/O.
//
// Decision 78: the payload of EVERY document is sealed to the identity key of the addressee (envelope version 2). The relay sees the
// addressee, the type tag, the id, the dates and the size, never a policy, a revocation or a registration. The signature (admin key)
// covers the envelope including the sealed blob: it is the authenticity, the sealing is the confidentiality. A version 1 envelope
// (clear payload) is recognised only to be refused loudly; nothing builds one any more.

/** Signature domain of the version 1 envelope (clear payload): kept only to recognise, and refuse, what an older admin machine sent. */
export const DOCUMENT_DOMAIN = 'machine/document/v1';
/** Signature domain of the version 2 envelope (sealed payload). */
export const DOCUMENT_DOMAIN_V2 = 'machine/document/v2';
export const DOCUMENT_VERSION = 2;
export const DOCUMENT_KINDS = ['peer', 'policy', 'revocation', 'notice-recipients'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
/** What the relay accepts for one document. */
export const MAX_DOCUMENT_BYTES = 16 * 1024;
/** The relay drops a document after 30 days: no document is built to live longer. */
export const DOCUMENT_RETENTION_SECONDS = 30 * 86_400;
export const DOCUMENT_SKEW_SECONDS = 30;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** What the relay stores as the payload of a document: one sealed blob (`sealTo` of the canonical JSON of the real payload). */
export interface SealedPayload {
  sealed: string;
}

export interface DocumentBody {
  v: 2;
  /** The type tag: the relay and everybody on the path can read it. */
  kind: DocumentKind;
  /** UUID of the ONE machine this document is for. */
  to: string;
  /** 22 characters of base64url (16 bytes): see `documentId`. */
  id: string;
  issuedAt: number;
  expiresAt: number;
  payload: SealedPayload;
}

/** The purpose the payload of a document is sealed for: the envelope version, the type, the addressee and the id. A sealed payload opens only there. */
export function documentSealContext(kind: DocumentKind, to: string, id: string): string {
  return `document-payload:v2:${kind}:${to}:${id}`;
}

export interface SignedDocument {
  body: DocumentBody;
  signature: string;
}

/** Payload of a `peer` document: a registration the addressee must trust, and the pair secret sealed to the addressee. */
export interface PeerPayload {
  registration: SignedRegistration;
  /** `sealTo(identity key of the addressee, pair secret, pairSecretDocumentContext(adminUuid, to, peer uuid))`. */
  sealedPairSecret: string;
  /** The admin machine that derived the secret (null when it has no identity): part of the seal context, authenticated by the document signature. */
  adminUuid: string | null;
}

export interface DocumentInput {
  kind: DocumentKind;
  to: string;
  id: string;
  issuedAt: number;
  expiresAt: number;
  /** The real payload, in clear: it is validated, then sealed. It never leaves the admin machine in clear. */
  payload: Json;
  /**
   * The identity public key of the addressee (its signed registration): the payload is sealed to it. Required at run time, `buildDocument` throws without
   * it, there is no plaintext document. Optional in the TYPE only so that a caller that was not converted yet (the browser `policyDocumentFor`, see
   * distribution.md "Rollout") still compiles and fails loudly instead of sending a clear document.
   */
  recipientIdentityPublicKey?: string;
}

/** The id of a document: the first 16 bytes of the SHA-256 of a stable string, base64url (22 characters). Same string, same id: a re-PUT is idempotent. */
export function documentId(stableString: string): string {
  return createHash('sha256').update(stableString, 'utf8').digest().subarray(0, 16).toString('base64url');
}

/** The purpose a pair secret of a `peer` document is sealed for: the admin machine (sender), the addressee and the peer it is about. */
export function pairSecretDocumentContext(adminUuid: string | null, to: string, peerUuid: string): string {
  return `pair-secret:${adminUuid ?? 'none'}:${to}:${peerUuid}`;
}

const PKCS8_ED25519_BYTES = 48;
const PKCS8_ED25519_PREFIX_BYTES = 16;

/**
 * The pair secret of two machines, derived from the admin private key: HMAC-SHA256 over both uuids and serials (sorted by uuid, so both
 * sides get the same value). A retry of a distribution therefore seals the SAME secret, and the two machines of a pair always agree.
 * Anyone who holds the admin key can already sign any registration, so deriving from it widens nothing.
 * @deprecated Needs the raw admin seed in memory, which a non-extractable browser key cannot give. Use `derivePairSecretV2`
 * (decision pending, no caller switched yet).
 */
export function derivePairSecret(adminPrivateKeyPkcs8: Uint8Array, a: { uuid: string; serial: number }, b: { uuid: string; serial: number }): string {
  if (adminPrivateKeyPkcs8.length !== PKCS8_ED25519_BYTES) throw new Error('the admin private key is not an Ed25519 PKCS8 key of 48 bytes: the admin key file may be damaged');
  const [first, second] = a.uuid <= b.uuid ? [a, b] : [b, a];
  const data = `machine/pair-secret/v1\0${first.uuid}:${first.serial}\0${second.uuid}:${second.serial}`;
  // A dedicated subkey of the seed: the raw private key bytes are only ever used to sign.
  const subkey = Buffer.from(hkdfSync('sha256', Buffer.from(adminPrivateKeyPkcs8).subarray(PKCS8_ED25519_PREFIX_BYTES), Buffer.alloc(0), 'machine/pair-secret/v1', 32));
  try {
    return createHmac('sha256', subkey).update(data, 'utf8').digest().toString('base64url');
  } finally {
    subkey.fill(0);
  }
}

const PAIR_SECRET_V2_DOMAIN = 'machine/pair-secret/v2';

/**
 * The pair secret of two machines, derived from a deterministic Ed25519 signature of the admin key (no raw seed needed, so a
 * non-extractable browser key can compute it). Ed25519 is deterministic and unforgeable without the key, so the signature over a
 * domain-separated string naming both machines and serials is a keyed PRF; HKDF-SHA256 of the 64 signature bytes gives 32 bytes.
 * Both orders of the pair give the same value (sorted by uuid), and a retry seals the SAME secret. Same inputs and outputs as the
 * WebCrypto `derivePairSecretFromSignature` of machine-webcrypto. `distribute.ts` uses it; `derivePairSecret` (seed-based) is deprecated.
 */
export function derivePairSecretV2(adminPrivateKeyPkcs8: Uint8Array, a: { uuid: string; serial: number }, b: { uuid: string; serial: number }): string {
  if (adminPrivateKeyPkcs8.length !== PKCS8_ED25519_BYTES) throw new Error('the admin private key is not an Ed25519 PKCS8 key of 48 bytes: the admin key file may be damaged');
  for (const m of [a, b]) {
    if (typeof m.uuid !== 'string' || !UUID_V4.test(m.uuid)) throw new Error('pair secret: uuid must be a lowercase version 4 UUID');
    if (!Number.isSafeInteger(m.serial) || m.serial < 1) throw new Error('pair secret: serial must be a positive integer');
  }
  if (a.uuid === b.uuid) throw new Error('pair secret: a machine is never paired with itself; the two uuids must differ');
  const [first, second] = a.uuid < b.uuid ? [a, b] : [b, a];
  const data = `${PAIR_SECRET_V2_DOMAIN}\0${first.uuid}:${first.serial}\0${second.uuid}:${second.serial}`;
  const signature = Buffer.from(signBytes(adminPrivateKeyPkcs8, new TextEncoder().encode(data)), 'base64url');
  try {
    return Buffer.from(hkdfSync('sha256', signature, Buffer.alloc(0), PAIR_SECRET_V2_DOMAIN, 32)).toString('base64url');
  } finally {
    signature.fill(0);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isEpoch = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

function assertKeys(o: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(o)) if (!allowed.includes(key)) throw new Error(`${where}: unknown field "${key}"`);
  for (const key of allowed) if (!(key in o)) throw new Error(`${where}: missing field "${key}"`);
}

function assertId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !ID_PATTERN.test(id) || Buffer.from(id, 'base64url').toString('base64url') !== id) {
    throw new Error('document: id must be 22 characters of unpadded base64url (16 bytes), made by documentId()');
  }
}

/** Shape of the body, payload excluded. `version` is the envelope version being checked (1 only to recognise a plaintext document). Throws an Error naming the first problem. */
function assertEnvelope(body: unknown, version: 1 | 2 = 2): asserts body is DocumentBody {
  if (!isObject(body)) throw new Error('document: the body must be an object');
  assertKeys(body, ['v', 'kind', 'to', 'id', 'issuedAt', 'expiresAt', 'payload'], 'document');
  if (body.v !== version) {
    throw new Error(`document: unsupported envelope version ${String(body.v)} (this build reads version ${DOCUMENT_VERSION}, sealed payloads): update machine on this machine, or on the admin machine if it is the older one (\`machine cli update\`)`);
  }
  if (typeof body.kind !== 'string' || !(DOCUMENT_KINDS as readonly string[]).includes(body.kind)) {
    throw new Error(`document: kind must be one of ${DOCUMENT_KINDS.join(', ')} (got ${JSON.stringify(body.kind)}): update machine if the sender is newer`);
  }
  if (typeof body.to !== 'string' || !UUID_V4.test(body.to)) throw new Error('document: to must be a lowercase version 4 UUID');
  assertId(body.id);
  if (!isEpoch(body.issuedAt)) throw new Error('document: issuedAt must be epoch seconds');
  if (!isEpoch(body.expiresAt) || body.expiresAt <= body.issuedAt) throw new Error('document: expiresAt must be epoch seconds after issuedAt');
  if (body.expiresAt - body.issuedAt > DOCUMENT_RETENTION_SECONDS) throw new Error('document: it must not live longer than the 30 days the relay keeps a document');
}

function parsePeerPayload(payload: unknown): PeerPayload {
  if (!isObject(payload)) throw new Error('document: the payload of a peer document must be an object');
  assertKeys(payload, ['registration', 'sealedPairSecret', 'adminUuid'], 'document peer payload');
  if (!isObject(payload.registration) || !isObject(payload.registration.body) || typeof payload.registration.signature !== 'string') {
    throw new Error('document peer payload: registration must be a signed registration');
  }
  const sealed = payload.sealedPairSecret;
  if (typeof sealed !== 'string' || sealed.length === 0 || Buffer.from(sealed, 'base64url').toString('base64url') !== sealed) {
    throw new Error('document peer payload: sealedPairSecret must be unpadded base64url text');
  }
  if (payload.adminUuid !== null && (typeof payload.adminUuid !== 'string' || !UUID_V4.test(payload.adminUuid))) {
    throw new Error('document peer payload: adminUuid must be a lowercase UUID, or null when the admin machine has no identity');
  }
  return payload as unknown as PeerPayload;
}

function parseSignedPayload(payload: unknown, kind: 'policy' | 'revocation' | 'notice-recipients'): { body: Record<string, unknown>; signature: string } {
  if (!isObject(payload)) throw new Error(`document: the payload of a ${kind} document must be an object`);
  assertKeys(payload, ['body', 'signature'], `document ${kind} payload`);
  if (!isObject(payload.body) || typeof payload.signature !== 'string') throw new Error(`document ${kind} payload: expected a signed ${kind} ({ body, signature })`);
  return payload as { body: Record<string, unknown>; signature: string };
}

/** Everything that can be checked about the payload without a key: shape only. */
function assertPayloadShape(kind: DocumentKind, payload: unknown): void {
  if (kind === 'peer') parsePeerPayload(payload);
  else if (kind === 'policy') {
    assertPolicyBody(parseSignedPayload(payload, 'policy').body);
  } else if (kind === 'notice-recipients') {
    assertNoticeRecipientsBody(parseSignedPayload(payload, 'notice-recipients').body);
  } else parseSignedPayload(payload, 'revocation');
}

function sizeOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function assertSealedPayload(payload: unknown): asserts payload is SealedPayload {
  if (!isObject(payload)) {
    throw new Error('document: the payload must be an object holding one sealed blob ({ sealed })');
  }
  assertKeys(payload, ['sealed'], 'document payload');
  const sealed = payload.sealed;
  if (typeof sealed !== 'string' || sealed.length === 0 || Buffer.from(sealed, 'base64url').toString('base64url') !== sealed) {
    throw new Error('document payload: sealed must be unpadded base64url text');
  }
}

/**
 * Admin side: validate the real payload, seal it to the addressee and sign the envelope. Refuses to sign what no machine would accept.
 * There is no plaintext mode: an input without the key of the addressee is an error.
 */
export function buildDocument(input: DocumentInput, adminPrivateKeyPkcs8: Uint8Array): SignedDocument {
  if (typeof input.recipientIdentityPublicKey !== 'string' || input.recipientIdentityPublicKey.length === 0) {
    throw new Error(
      'document: recipientIdentityPublicKey is required: every document is sealed to the identity key of its addressee because the relay must not read it, and there is no plaintext mode. Take the key from the registration of the addressee that this machine signed',
    );
  }
  // The shape of the clear payload is checked first: a payload no machine would accept is never sealed.
  assertEnvelope({ v: 2, kind: input.kind, to: input.to, id: input.id, issuedAt: input.issuedAt, expiresAt: input.expiresAt, payload: {} });
  assertPayloadShape(input.kind, input.payload);
  const sealed = sealTo(input.recipientIdentityPublicKey, Buffer.from(canonicalize(input.payload), 'utf8'), documentSealContext(input.kind, input.to, input.id));
  const body: DocumentBody = { v: 2, kind: input.kind, to: input.to, id: input.id, issuedAt: input.issuedAt, expiresAt: input.expiresAt, payload: { sealed } };
  const signed: SignedDocument = { body, signature: signDocument(DOCUMENT_DOMAIN_V2, body as unknown as Json, adminPrivateKeyPkcs8) };
  const size = sizeOf(signed);
  if (size > MAX_DOCUMENT_BYTES) {
    throw new Error(
      `document ${input.id} is too large: ${size} bytes once sealed (the sealed form is a third bigger than the clear one), the relay accepts at most ${MAX_DOCUMENT_BYTES} bytes (16 KiB). A policy or a revocation list this big must be split or reduced`,
    );
  }
  return signed;
}

export type DocumentFailure =
  | 'malformed'
  | 'too-large'
  | 'invalid-admin-key'
  | 'bad-signature'
  | 'wrong-recipient'
  | 'not-yet-valid'
  | 'expired'
  | 'invalid-payload'
  | 'self-peer'
  | 'revoked'
  /** An envelope version 1 document (clear payload) signed by the admin: refused, the relay could read it. */
  | 'plaintext'
  /** The sealed payload does not open with this identity key (sealed to another machine, altered, or sealed for another type, addressee or id). */
  | 'cannot-open'
  /** The caller gave no identity key: the document is valid but nobody here can read it. */
  | 'sealed-unopened';

export interface VerifyDocumentContext {
  /** The admin public key pinned on this machine. */
  adminPublicKey: string;
  /** UUID of the machine verifying: the document must be addressed to it. */
  selfUuid: string;
  /** Epoch seconds, from the verifying machine's own clock. */
  now: number;
  skewSeconds?: number;
  isRevoked?: (uuid: string, serial: number) => boolean;
  /** The identity private key (PKCS8) of the addressee: needed to open the sealed payload. Without it only `verifyDocumentEnvelope` can say something. */
  identityPrivateKeyPkcs8?: Uint8Array;
}

export type EnvelopeContext = Pick<VerifyDocumentContext, 'adminPublicKey' | 'selfUuid' | 'now' | 'skewSeconds'>;

export type VerifiedDocument =
  | { ok: true; kind: 'peer'; body: DocumentBody; registration: RegistrationBody; signedRegistration: SignedRegistration; sealedPairSecret: string; adminUuid: string | null }
  | { ok: true; kind: 'policy'; body: DocumentBody; policy: SignedPolicy }
  | { ok: true; kind: 'revocation'; body: DocumentBody; revocation: SignedRevocation }
  | { ok: true; kind: 'notice-recipients'; body: DocumentBody; noticeRecipients: SignedNoticeRecipients };

/** `signed` is true when the admin signature was verified before the failure: only then does the failure say something about a document of the admin (and not about junk or a forgery). */
export type DocumentResult = VerifiedDocument | { ok: false; reason: DocumentFailure; message: string; signed: boolean };

const fail = (reason: DocumentFailure, message: string, signed = true): DocumentResult => ({ ok: false, reason, message, signed });
const unsigned = (reason: DocumentFailure, message: string): DocumentResult => fail(reason, message, false);

/**
 * Everything that can be verified WITHOUT opening the payload: shape, size, pinned key, signature, addressee, time window, and that
 * the payload is one sealed blob. A version 1 document (clear payload) signed by the admin is refused as `plaintext`. This is what the
 * admin side can check about a document addressed to another machine; the addressee uses `verifyDocument`.
 */
export function verifyDocumentEnvelope(signed: unknown, ctx: EnvelopeContext): { ok: true; kind: DocumentKind; body: DocumentBody } | { ok: false; reason: DocumentFailure; message: string; signed: boolean } {
  if (!isObject(signed) || typeof signed.signature !== 'string' || !isObject(signed.body)) {
    return unsigned('malformed', 'document refused: it is not a signed document ({ body, signature })');
  }
  let size: number;
  try {
    size = sizeOf(signed);
  } catch {
    return unsigned('malformed', 'document refused: it cannot be serialized');
  }
  if (size > MAX_DOCUMENT_BYTES) return unsigned('too-large', `document refused: ${size} bytes, the limit is ${MAX_DOCUMENT_BYTES} bytes (16 KiB)`);
  const version = signed.body.v === 1 ? 1 : 2;
  try {
    assertKeys(signed, ['body', 'signature'], 'document');
    assertEnvelope(signed.body, version);
  } catch (e) {
    return unsigned('malformed', `document refused: ${(e as Error).message}`);
  }
  const body = signed.body as unknown as DocumentBody;
  if (tryKeyId(ctx.adminPublicKey) === undefined) return unsigned('invalid-admin-key', INVALID_ADMIN_KEY_MESSAGE);
  if (!verifySigned(version === 1 ? DOCUMENT_DOMAIN : DOCUMENT_DOMAIN_V2, body as unknown as Json, ctx.adminPublicKey, signed.signature)) {
    return unsigned('bad-signature', `document ${body.id} has an invalid signature; it was altered or not signed by the admin key pinned on this machine`);
  }
  if (version === 1) {
    return fail(
      'plaintext',
      `document ${body.id} (${body.kind}) arrived in PLAINTEXT (envelope version 1): the relay could read it, so this machine refuses it and never installs it. The admin machine runs an older build: run \`machine cli update\` there, then \`machine admin distribute\` again (for a policy: \`machine admin distribute --policy <file>\`)`,
    );
  }
  if (body.to !== ctx.selfUuid) return fail('wrong-recipient', `document ${body.id} is addressed to machine ${body.to}, not to this machine (${ctx.selfUuid})`);
  const skew = ctx.skewSeconds ?? DOCUMENT_SKEW_SECONDS;
  if (ctx.now + skew < body.issuedAt) {
    return fail('not-yet-valid', `document ${body.id} is dated ${new Date(body.issuedAt * 1000).toISOString()}, in the future; check the clocks of this machine and of the admin machine`);
  }
  if (ctx.now - skew > body.expiresAt) {
    return fail('expired', `document ${body.id} expired at ${new Date(body.expiresAt * 1000).toISOString()}; ask the admin to distribute it again (\`machine admin distribute\`), or check the clock of this machine`);
  }
  try {
    assertSealedPayload(body.payload);
  } catch (e) {
    return fail('malformed', `document ${body.id} refused: ${(e as Error).message}`);
  }
  return { ok: true, kind: body.kind, body };
}

/**
 * Receiver side. Order: shape, size, pinned key, signature, addressee, time window, opening of the sealed payload, payload. Nothing is
 * installed here: the caller installs through the existing validators (importPeer, installPolicy, installRevocation), which check again.
 */
export function verifyDocument(signed: unknown, ctx: VerifyDocumentContext): DocumentResult {
  const envelope = verifyDocumentEnvelope(signed, ctx);
  if (!envelope.ok) {
    return envelope;
  }
  const skew = ctx.skewSeconds ?? DOCUMENT_SKEW_SECONDS;
  const body = envelope.body;
  if (ctx.identityPrivateKeyPkcs8 === undefined) {
    return fail('sealed-unopened', `document ${body.id} (${body.kind}) is sealed to its addressee: it can only be read with the identity key of machine ${body.to}, which this check was not given`);
  }
  let plain: unknown;
  try {
    const bytes = openSealed(ctx.identityPrivateKeyPkcs8, body.payload.sealed, documentSealContext(body.kind, body.to, body.id));
    plain = undefined;
    try {
      plain = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      return fail('malformed', `document ${body.id} refused: its sealed payload opened but is not JSON (it was sealed by something else than machine admin): ask the admin to distribute it again`);
    }
  } catch (e) {
    return fail(
      'cannot-open',
      `document ${body.id} (${body.kind}) cannot be opened, ask the admin to run \`machine admin distribute\` again: it is not sealed to the identity key of this machine, was altered, or is bound to another type, addressee or id (${(e as Error).message})`,
    );
  }
  try {
    assertPayloadShape(body.kind, plain);
  } catch (e) {
    return fail('malformed', `document ${body.id} refused: ${(e as Error).message}`);
  }
  if (body.kind === 'peer') {
    const payload = plain as unknown as PeerPayload;
    const registration = verifyRegistration(payload.registration, {
      adminPublicKey: ctx.adminPublicKey,
      now: ctx.now,
      skewSeconds: skew,
      ...(ctx.isRevoked ? { isRevoked: ctx.isRevoked } : {}),
    });
    if (!registration.ok) {
      const reason: DocumentFailure = registration.reason === 'not-yet-valid' || registration.reason === 'expired' || registration.reason === 'revoked' ? registration.reason : 'invalid-payload';
      return fail(reason, `document ${body.id} carries a registration that is not valid here (${registration.reason}): ${registration.message}`);
    }
    if (registration.body.uuid === ctx.selfUuid) return fail('self-peer', `document ${body.id} is about this machine itself: a machine is never its own peer`);
    return { ok: true, kind: 'peer', body, registration: registration.body, signedRegistration: payload.registration, sealedPairSecret: payload.sealedPairSecret, adminUuid: payload.adminUuid };
  }
  if (body.kind === 'policy') {
    const policy = plain as unknown as SignedPolicy;
    if (policy.body.target !== body.to) {
      return fail('invalid-payload', `document ${body.id} carries a policy written for machine ${policy.body.target}, not for the addressee ${body.to}`);
    }
    if (!verifySigned(POLICY_DOMAIN, policy.body as unknown as Json, ctx.adminPublicKey, policy.signature)) {
      return fail('invalid-payload', `document ${body.id} carries a policy with an invalid signature`);
    }
    return { ok: true, kind: 'policy', body, policy };
  }
  if (body.kind === 'notice-recipients') {
    const noticeRecipients = plain as unknown as SignedNoticeRecipients;
    const verifiedList = verifyNoticeRecipients(noticeRecipients, { adminPublicKey: ctx.adminPublicKey });
    if (!verifiedList.ok) {
      return fail('invalid-payload', `document ${body.id} carries a notice-recipients list that is not valid (${verifiedList.reason}): ${verifiedList.message}`);
    }
    return { ok: true, kind: 'notice-recipients', body, noticeRecipients };
  }
  const revocation = plain as unknown as SignedRevocation;
  const checked = verifyRevocation(revocation, { adminPublicKey: ctx.adminPublicKey });
  if (!checked.ok) return fail('invalid-payload', `document ${body.id} carries a revocation list that is not valid (${checked.reason}): ${checked.message}`);
  return { ok: true, kind: 'revocation', body, revocation };
}

/**
 * Open the pair secret of a verified `peer` document with the identity key of the addressee. The seal context binds the admin
 * machine, the addressee and the peer: a secret taken from another document or sealed for another machine does not open.
 */
export function openPairSecret(document: Extract<VerifiedDocument, { kind: 'peer' }>, identityPrivateKeyPkcs8: Uint8Array): string {
  const context = pairSecretDocumentContext(document.adminUuid, document.body.to, document.registration.uuid);
  let secret: Uint8Array;
  try {
    secret = openSealed(identityPrivateKeyPkcs8, document.sealedPairSecret, context);
  } catch (e) {
    throw new Error(
      `cannot open the sealed pair secret of document ${document.body.id}: it is not sealed to the identity key of this machine, was altered, or is bound to another admin machine, addressee or peer (${(e as Error).message}). Ask the admin to run \`machine admin distribute\` again`,
    );
  }
  if (secret.length !== 32) throw new Error(`the pair secret of document ${document.body.id} has ${secret.length} bytes after opening, expected 32: do not trust this document`);
  const encoded = Buffer.from(secret).toString('base64url');
  decodeBase64urlStrict(encoded, 32, 'pair secret');
  return encoded;
}
