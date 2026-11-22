import type { Json } from './canonical.js';
import { INVALID_ADMIN_KEY_MESSAGE, keyId, tryKeyId } from './keys.js';
import { signDocument, verifyDocument } from './signed.js';

export const REGISTRATION_DOMAIN = 'machine/registration/v1';

/** What the admin key certifies about one machine (decision 24). */
export interface RegistrationBody {
  v: 1;
  uuid: string;
  name: string;
  /** Raw Ed25519 public key of the machine, unpadded base64url. */
  identityPublicKey: string;
  serial: number;
  /** Epoch seconds. */
  validFrom: number;
  validTo: number;
  adminKeyId: string;
}

export interface SignedRegistration {
  body: RegistrationBody;
  signature: string;
}

export type RegistrationFailure = 'malformed' | 'invalid-admin-key' | 'wrong-admin-key' | 'bad-signature' | 'revoked' | 'not-yet-valid' | 'expired';

export type RegistrationResult = { ok: true; body: RegistrationBody } | { ok: false; reason: RegistrationFailure; message: string };

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const KEY_ID = /^[0-9a-f]{32}$/;
const FIELDS = ['v', 'uuid', 'name', 'identityPublicKey', 'serial', 'validFrom', 'validTo', 'adminKeyId'];

function isNonNegativeInt(x: unknown): x is number {
  return typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
}

/** Throws an Error naming the first problem; the message is meant to be shown to the user. */
export function assertRegistrationBody(value: unknown): asserts value is RegistrationBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('registration: the body must be an object');
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!FIELDS.includes(key)) throw new Error(`registration: unknown field "${key}"`);
  }
  for (const key of FIELDS) {
    if (!(key in record)) throw new Error(`registration: missing field "${key}"`);
  }
  if (record.v !== 1) throw new Error(`registration: unsupported version ${String(record.v)} (this build reads version 1): run \`machine cli update\` on this machine`);
  if (typeof record.uuid !== 'string' || !UUID_V4.test(record.uuid)) throw new Error('registration: uuid must be a lowercase version 4 UUID');
  if (typeof record.name !== 'string' || !NAME.test(record.name)) {
    throw new Error('registration: name must be 1 to 32 characters (letters, digits, "_" or "-"), starting with a letter or a digit');
  }
  if (typeof record.identityPublicKey !== 'string') throw new Error('registration: identityPublicKey must be a string');
  try {
    keyId(record.identityPublicKey);
  } catch (e) {
    throw new Error(`registration: identityPublicKey is invalid: ${(e as Error).message}`);
  }
  if (!isNonNegativeInt(record.serial) || record.serial < 1) throw new Error('registration: serial must be a positive integer');
  if (!isNonNegativeInt(record.validFrom)) throw new Error('registration: validFrom must be epoch seconds (a non-negative integer)');
  if (!isNonNegativeInt(record.validTo) || record.validTo <= record.validFrom) {
    throw new Error('registration: validTo must be epoch seconds after validFrom');
  }
  if (typeof record.adminKeyId !== 'string' || !KEY_ID.test(record.adminKeyId)) throw new Error('registration: adminKeyId must be 32 lowercase hex characters');
}

export function signRegistration(body: RegistrationBody, adminPrivateKeyPkcs8: Uint8Array): SignedRegistration {
  assertRegistrationBody(body);
  return { body, signature: signDocument(REGISTRATION_DOMAIN, body as unknown as Json, adminPrivateKeyPkcs8) };
}

export interface VerifyRegistrationContext {
  /** The admin public key pinned on this machine. */
  adminPublicKey: string;
  /** Epoch seconds, from the verifying machine's own clock. */
  now: number;
  /** Tolerated clock skew applied to validFrom and validTo. */
  skewSeconds?: number;
  /** Extra tolerance for validFrom only (not-yet-valid side); the larger of this and `skewSeconds` applies there. */
  notBeforeLeewaySeconds?: number;
  isRevoked?: (uuid: string, serial: number) => boolean;
}

export function verifyRegistration(signed: SignedRegistration, ctx: VerifyRegistrationContext): RegistrationResult {
  try {
    if (typeof signed !== 'object' || signed === null || typeof signed.signature !== 'string') throw new Error('registration: missing signature');
    assertRegistrationBody(signed.body);
  } catch (e) {
    return { ok: false, reason: 'malformed', message: (e as Error).message };
  }
  const { body } = signed;
  const pinnedId = tryKeyId(ctx.adminPublicKey);
  if (pinnedId === undefined) return { ok: false, reason: 'invalid-admin-key', message: INVALID_ADMIN_KEY_MESSAGE };
  if (body.adminKeyId !== pinnedId) {
    return {
      ok: false,
      reason: 'wrong-admin-key',
      message: `registration of "${body.name}" is certified by admin key ${body.adminKeyId}, but this machine pins ${pinnedId}; re-enroll the machine or rotate the admin key`,
    };
  }
  if (!verifyDocument(REGISTRATION_DOMAIN, body as unknown as Json, ctx.adminPublicKey, signed.signature)) {
    return { ok: false, reason: 'bad-signature', message: `registration of "${body.name}" has an invalid signature; it was altered or not signed by the admin key` };
  }
  if (ctx.isRevoked?.(body.uuid, body.serial) === true) {
    return { ok: false, reason: 'revoked', message: `machine "${body.name}" (serial ${body.serial}) is revoked` };
  }
  if (ctx.now + Math.max(ctx.skewSeconds ?? 0, ctx.notBeforeLeewaySeconds ?? 0) < body.validFrom) {
    return { ok: false, reason: 'not-yet-valid', message: `registration of "${body.name}" starts at ${new Date(body.validFrom * 1000).toISOString()}; check the clock of this machine or of the admin machine` };
  }
  if (ctx.now - (ctx.skewSeconds ?? 0) > body.validTo) {
    return {
      ok: false,
      reason: 'expired',
      message: `registration of "${body.name}" expired at ${new Date(body.validTo * 1000).toISOString()}; ask the admin to renew it, or check the clock of this machine if the date looks wrong`,
    };
  }
  return { ok: true, body };
}
