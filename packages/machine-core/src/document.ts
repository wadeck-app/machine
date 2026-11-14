import { createHash, createHmac, hkdfSync } from 'node:crypto';
import type { Json } from './canonical.js';
import { INVALID_ADMIN_KEY_MESSAGE, decodeBase64urlStrict, tryKeyId } from './keys.js';
import { POLICY_DOMAIN, assertPolicyBody, type SignedPolicy } from './policy.js';
import { verifyRegistration, type RegistrationBody, type SignedRegistration } from './registration.js';
import { verifyRevocation, type SignedRevocation } from './revocation.js';
import { openSealed } from './seal.js';
import { signDocument, verifyDocument as verifySigned } from './signed.js';

// Documents distributed through the relay (distribution.md): a JSON object signed by the admin key and addressed to ONE
// machine. The relay only stores them; the recipient verifies everything locally. No I/O.

export const DOCUMENT_DOMAIN = 'machine/document/v1';
export const DOCUMENT_KINDS = ['peer', 'policy', 'revocation'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
/** What the relay accepts for one document. */
export const MAX_DOCUMENT_BYTES = 16 * 1024;
/** The relay drops a document after 30 days: no document is built to live longer. */
export const DOCUMENT_RETENTION_SECONDS = 30 * 86_400;
export const DOCUMENT_SKEW_SECONDS = 30;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export interface DocumentBody {
  v: 1;
  kind: DocumentKind;
  /** UUID of the ONE machine this document is for. */
  to: string;
  /** 22 characters of base64url (16 bytes): see `documentId`. */
  id: string;
  issuedAt: number;
  expiresAt: number;
  payload: Json;
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
  payload: Json;
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

/** Shape of the body, payload excluded. Throws an Error naming the first problem. */
function assertEnvelope(body: unknown): asserts body is DocumentBody {
  if (!isObject(body)) throw new Error('document: the body must be an object');
  assertKeys(body, ['v', 'kind', 'to', 'id', 'issuedAt', 'expiresAt', 'payload'], 'document');
  if (body.v !== 1) throw new Error(`document: unsupported version ${String(body.v)} (this build reads version 1)`);
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

function parseSignedPayload(payload: unknown, kind: 'policy' | 'revocation'): { body: Record<string, unknown>; signature: string } {
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
  } else parseSignedPayload(payload, 'revocation');
}

function sizeOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** Admin side: build and sign a document. Refuses to sign what no machine would accept. */
export function buildDocument(input: DocumentInput, adminPrivateKeyPkcs8: Uint8Array): SignedDocument {
  const body: DocumentBody = { v: 1, kind: input.kind, to: input.to, id: input.id, issuedAt: input.issuedAt, expiresAt: input.expiresAt, payload: input.payload };
  assertEnvelope(body);
  assertPayloadShape(body.kind, body.payload);
  const signed: SignedDocument = { body, signature: signDocument(DOCUMENT_DOMAIN, body as unknown as Json, adminPrivateKeyPkcs8) };
  const size = sizeOf(signed);
  if (size > MAX_DOCUMENT_BYTES) {
    throw new Error(`document ${input.id} is too large: ${size} bytes, the relay accepts at most ${MAX_DOCUMENT_BYTES} bytes (16 KiB). A policy this big must be split or reduced`);
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
  | 'revoked';

export interface VerifyDocumentContext {
  /** The admin public key pinned on this machine. */
  adminPublicKey: string;
  /** UUID of the machine verifying: the document must be addressed to it. */
  selfUuid: string;
  /** Epoch seconds, from the verifying machine's own clock. */
  now: number;
  skewSeconds?: number;
  isRevoked?: (uuid: string, serial: number) => boolean;
}

export type VerifiedDocument =
  | { ok: true; kind: 'peer'; body: DocumentBody; registration: RegistrationBody; signedRegistration: SignedRegistration; sealedPairSecret: string; adminUuid: string | null }
  | { ok: true; kind: 'policy'; body: DocumentBody; policy: SignedPolicy }
  | { ok: true; kind: 'revocation'; body: DocumentBody; revocation: SignedRevocation };

/** `signed` is true when the admin signature was verified before the failure: only then does the failure say something about a document of the admin (and not about junk or a forgery). */
export type DocumentResult = VerifiedDocument | { ok: false; reason: DocumentFailure; message: string; signed: boolean };

const fail = (reason: DocumentFailure, message: string, signed = true): DocumentResult => ({ ok: false, reason, message, signed });
const unsigned = (reason: DocumentFailure, message: string): DocumentResult => fail(reason, message, false);

/**
 * Receiver side. Order: shape, size, pinned key, signature, addressee, time window, payload. Nothing is installed here:
 * the caller installs through the existing validators (importPeer, installPolicy, installRevocation), which check again.
 */
export function verifyDocument(signed: unknown, ctx: VerifyDocumentContext): DocumentResult {
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
  try {
    assertKeys(signed, ['body', 'signature'], 'document');
    assertEnvelope(signed.body);
  } catch (e) {
    return unsigned('malformed', `document refused: ${(e as Error).message}`);
  }
  const body = signed.body as DocumentBody;
  if (tryKeyId(ctx.adminPublicKey) === undefined) return unsigned('invalid-admin-key', INVALID_ADMIN_KEY_MESSAGE);
  if (!verifySigned(DOCUMENT_DOMAIN, body as unknown as Json, ctx.adminPublicKey, signed.signature)) {
    return unsigned('bad-signature', `document ${body.id} has an invalid signature; it was altered or not signed by the admin key pinned on this machine`);
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
    assertPayloadShape(body.kind, body.payload);
  } catch (e) {
    return fail('malformed', `document ${body.id} refused: ${(e as Error).message}`);
  }
  if (body.kind === 'peer') {
    const payload = body.payload as unknown as PeerPayload;
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
    const policy = body.payload as unknown as SignedPolicy;
    if (policy.body.target !== body.to) {
      return fail('invalid-payload', `document ${body.id} carries a policy written for machine ${policy.body.target}, not for the addressee ${body.to}`);
    }
    if (!verifySigned(POLICY_DOMAIN, policy.body as unknown as Json, ctx.adminPublicKey, policy.signature)) {
      return fail('invalid-payload', `document ${body.id} carries a policy with an invalid signature`);
    }
    return { ok: true, kind: 'policy', body, policy };
  }
  const revocation = body.payload as unknown as SignedRevocation;
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
