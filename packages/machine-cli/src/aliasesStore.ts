import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalSignedAliases, compareAliases, keyId, signAliases, verifyAliases, type AliasEntry, type SignedAliases } from '@wadeck-app/machine-core';
import { readAdminPin } from './admin.js';
import { withFileLock, writeFileAtomic } from './fsutil.js';

// <configDir>/aliases.json: the admin-signed network aliases (decision 116). Public data (labels and uuids), re-verified against the pinned admin
// key on every read. No file means no network alias. The local aliases of `machine alias set` stay in state.json and are never touched here.

export const aliasesFile = (configDir: string): string => join(configDir, 'aliases.json');

const unusable = (file: string, why: string): Error =>
  new Error(
    `${file} cannot be used (${why}): it holds the network aliases, nothing secret. Delete it, then run \`machine admin alias set <alias> <machine>\` on the admin machine (or \`machine admin alias list\` there to see what is signed) to send them again`,
  );

/** Undefined when no list is stored. A file that does not parse, or no longer verifies against the pinned admin key, stops the caller. */
export function readAliasesList(configDir: string, adminPublicKey: string): SignedAliases | undefined {
  const file = aliasesFile(configDir);
  if (!existsSync(file)) {
    return undefined;
  }
  let signed: SignedAliases;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { v?: unknown; signed?: unknown };
    if (typeof raw !== 'object' || raw === null || raw.v !== 1) {
      throw new Error('unexpected content');
    }
    signed = canonicalSignedAliases(raw.signed);
  } catch (e) {
    throw unusable(file, e instanceof SyntaxError ? 'not valid JSON' : (e as Error).message);
  }
  const checked = verifyAliases(signed, { adminPublicKey });
  if (!checked.ok) {
    throw unusable(file, `the stored list does not verify against the pinned admin key: ${checked.message}`);
  }
  return signed;
}

const write = (configDir: string, signed: SignedAliases): void => writeFileAtomic(aliasesFile(configDir), `${JSON.stringify({ v: 1, signed })}\n`, 0o644);

/**
 * Install a received list: verified against the pinned admin key, then the replace-newer rule (an equal or older serial changes nothing).
 * Throws `aliases list refused (<reason>)` for a list that does not verify.
 */
export function installAliases(configDir: string, signed: SignedAliases, adminPublicKey: string): { changed: boolean; reason?: 'already-installed' } {
  const checked = verifyAliases(signed, { adminPublicKey });
  if (!checked.ok) {
    throw new Error(`aliases list refused (${checked.reason}): ${checked.message}`);
  }
  return withFileLock(aliasesFile(configDir), () => {
    const current = readAliasesList(configDir, adminPublicKey);
    if (compareAliases(current, signed) !== 'newer') {
      return { changed: false, reason: 'already-installed' as const };
    }
    write(configDir, canonicalSignedAliases(signed));
    return { changed: true };
  });
}

export interface SignAliasesOptions {
  adminPrivateKeyPkcs8: Uint8Array;
  adminPublicKey: string;
  /** Epoch seconds. */
  now: number;
  /** The whole list after the change (already checked by `planAliasChange`). */
  entries: AliasEntry[];
}

/** Sign the list with a serial above the stored one, and keep it on this (admin) machine. */
export function signAliasesFor(configDir: string, o: SignAliasesOptions): SignedAliases {
  return withFileLock(aliasesFile(configDir), () => {
    const current = readAliasesList(configDir, o.adminPublicKey);
    const serial = Math.max(o.now, (current?.body.serial ?? 0) + 1);
    const signed = signAliases({ v: 1, adminKeyId: keyId(o.adminPublicKey), serial, issuedAt: o.now, entries: o.entries }, o.adminPrivateKeyPkcs8);
    write(configDir, signed);
    return signed;
  });
}

/** alias -> uuid of the verified network aliases ({} when none). Stops loudly on a damaged file: a reference must never silently mean something else. */
export function networkAliasMap(configDir: string): Record<string, string> {
  if (!existsSync(aliasesFile(configDir))) {
    return {};
  }
  const signed = readAliasesList(configDir, readAdminPin(configDir).adminPublicKey);
  return Object.fromEntries((signed?.body.entries ?? []).map((e) => [e.alias, e.uuid]));
}
