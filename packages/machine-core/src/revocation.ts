import { createHash } from 'node:crypto';
import { canonicalize, type Json } from './canonical.js';
import { INVALID_ADMIN_KEY_MESSAGE, tryKeyId } from './keys.js';
import { signDocument, verifyDocument } from './signed.js';

export const REVOCATION_DOMAIN = 'machine/revocation/v1';

/** Revokes every registration of `uuid` whose serial is at most `serial` (a re-registration with a higher serial is a new machine identity). */
export interface RevocationEntry {
  uuid: string;
  serial: number;
}

export interface RevocationBody {
  v: 1;
  adminKeyId: string;
  issuedAt: number;
  /** Sorted by uuid, one entry per uuid: a single canonical form. */
  entries: RevocationEntry[];
}

export interface SignedRevocation {
  body: RevocationBody;
  signature: string;
}

export type RevocationFailure = 'malformed' | 'invalid-admin-key' | 'wrong-admin-key' | 'bad-signature';
export type RevocationResult = { ok: true; body: RevocationBody } | { ok: false; reason: RevocationFailure; message: string };

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_ID = /^[0-9a-f]{32}$/;

export function assertRevocationBody(value: unknown): asserts value is RevocationBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('revocation: the body must be an object');
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!['v', 'adminKeyId', 'issuedAt', 'entries'].includes(key)) throw new Error(`revocation: unknown field "${key}"`);
  }
  if (record.v !== 1) throw new Error(`revocation: unsupported version ${String(record.v)} (this build reads version 1)`);
  if (typeof record.adminKeyId !== 'string' || !KEY_ID.test(record.adminKeyId)) throw new Error('revocation: adminKeyId must be 32 lowercase hex characters');
  if (typeof record.issuedAt !== 'number' || !Number.isSafeInteger(record.issuedAt) || record.issuedAt < 0) throw new Error('revocation: issuedAt must be epoch seconds');
  if (!Array.isArray(record.entries)) throw new Error('revocation: entries must be a list');
  let previous: string | undefined;
  for (const entry of record.entries as unknown[]) {
    const e = entry as Record<string, unknown>;
    if (typeof e !== 'object' || e === null) throw new Error('revocation: every entry must be an object');
    for (const key of Object.keys(e)) {
      if (key !== 'uuid' && key !== 'serial') throw new Error(`revocation: unknown entry field "${key}"`);
    }
    if (typeof e.uuid !== 'string' || !UUID_V4.test(e.uuid)) throw new Error('revocation: entry uuid must be a lowercase version 4 UUID');
    if (typeof e.serial !== 'number' || !Number.isSafeInteger(e.serial) || e.serial < 1) throw new Error('revocation: entry serial must be a positive integer');
    if (previous !== undefined && e.uuid === previous) throw new Error(`revocation: duplicate entry for ${e.uuid}; keep only the highest serial`);
    if (previous !== undefined && e.uuid < previous) throw new Error('revocation: entries must be sorted by uuid');
    previous = e.uuid;
  }
}

export function signRevocation(body: RevocationBody, adminPrivateKeyPkcs8: Uint8Array): SignedRevocation {
  assertRevocationBody(body);
  return { body, signature: signDocument(REVOCATION_DOMAIN, body as unknown as Json, adminPrivateKeyPkcs8) };
}

export function verifyRevocation(signed: SignedRevocation, ctx: { adminPublicKey: string }): RevocationResult {
  try {
    if (typeof signed !== 'object' || signed === null || typeof signed.signature !== 'string') throw new Error('revocation: missing signature');
    assertRevocationBody(signed.body);
  } catch (e) {
    return { ok: false, reason: 'malformed', message: (e as Error).message };
  }
  const pinned = tryKeyId(ctx.adminPublicKey);
  if (pinned === undefined) return { ok: false, reason: 'invalid-admin-key', message: INVALID_ADMIN_KEY_MESSAGE };
  if (signed.body.adminKeyId !== pinned) {
    return { ok: false, reason: 'wrong-admin-key', message: `revocation list is certified by admin key ${signed.body.adminKeyId}, but this machine pins ${pinned}` };
  }
  if (!verifyDocument(REVOCATION_DOMAIN, signed.body as unknown as Json, ctx.adminPublicKey, signed.signature)) {
    return { ok: false, reason: 'bad-signature', message: 'revocation list has an invalid signature; it was altered or not signed by the admin key' };
  }
  return { ok: true, body: signed.body };
}

/**
 * The only way a received list changes local state: verify it, then MERGE into the local entries.
 * A verified list is never a replacement, so an old signed list replayed by the relay cannot un-revoke anyone.
 */
export function applyRevocation(
  local: RevocationEntry[],
  signed: SignedRevocation,
  ctx: { adminPublicKey: string },
): { ok: true; entries: RevocationEntry[]; changed: boolean } | { ok: false; reason: RevocationFailure; message: string } {
  const verified = verifyRevocation(signed, ctx);
  if (!verified.ok) return verified;
  const entries = mergeRevocations(local, verified.body.entries);
  return { ok: true, entries, changed: revocationDigest(entries) !== revocationDigest(local) };
}

/** Grow-only merge: union of the lists, highest serial per machine, sorted by uuid. Nothing is ever removed. */
export function mergeRevocations(...lists: RevocationEntry[][]): RevocationEntry[] {
  const highest = new Map<string, number>();
  for (const list of lists) {
    for (const { uuid, serial } of list) {
      if ((highest.get(uuid) ?? 0) < serial) highest.set(uuid, serial);
    }
  }
  return [...highest.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([uuid, serial]) => ({ uuid, serial }));
}

export function isRevoked(entries: RevocationEntry[], uuid: string, serial: number): boolean {
  const entry = entries.find(e => e.uuid === uuid);
  return entry !== undefined && serial <= entry.serial;
}

/** Compared by two peers at handshake time: a different digest means one of them is behind. */
export function revocationDigest(entries: RevocationEntry[]): string {
  return createHash('sha256').update(canonicalize({ entries: mergeRevocations(entries) as unknown as Json })).digest('hex');
}
