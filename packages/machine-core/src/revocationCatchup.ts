// Revocation catch-up between two peers (threat model T-06): the first application frame of a session is a `hello` that
// says which revocation list the sender holds. Pure functions only: the session code lives in machine-cli.

const DIGEST = /^[0-9a-f]{64}$/;

export interface RevocationHello {
  /** revocationDigest of the merged entries held by the sender. */
  revocationDigest: string;
  /** Informational: issuedAt (epoch seconds) of the newest admin-signed list the sender holds, 0 when it holds none. */
  revocationVersion: number;
  /** In a reply: the sender's signed list is the next frame. */
  revocationsFollow: boolean;
}

export type HelloResult = { ok: true; hello: RevocationHello } | { ok: false; message: string };

export function parseRevocationHello(value: unknown): HelloResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, message: 'revocation hello: the frame must be an object' };
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!['type', 'revocationDigest', 'revocationVersion', 'revocationsFollow'].includes(key)) return { ok: false, message: `revocation hello: unknown field "${key}"` };
  }
  if (typeof record.revocationDigest !== 'string' || !DIGEST.test(record.revocationDigest)) {
    return { ok: false, message: 'revocation hello: revocationDigest must be 64 lowercase hex characters' };
  }
  if (typeof record.revocationVersion !== 'number' || !Number.isSafeInteger(record.revocationVersion) || record.revocationVersion < 0) {
    return { ok: false, message: 'revocation hello: revocationVersion must be a non-negative integer' };
  }
  if (record.revocationsFollow !== undefined && typeof record.revocationsFollow !== 'boolean') {
    return { ok: false, message: 'revocation hello: revocationsFollow must be true or false' };
  }
  return { ok: true, hello: { revocationDigest: record.revocationDigest, revocationVersion: record.revocationVersion, revocationsFollow: record.revocationsFollow === true } };
}

/**
 * Should this side send its signed lists to a peer that announced `remote`? Whenever the merged entries differ and it holds at least one list:
 * the version is NOT used to decide (two admin machines can each hold a list the other lacks, and a tie must converge). Each side sends at most
 * once per session, and the receiver verifies and merges grow-only, so the redundancy is harmless.
 */
export function shouldSendRevocations(local: { digest: string; hasLists: boolean }, remote: { digest: string }): boolean {
  return local.hasLists && local.digest !== remote.digest;
}
