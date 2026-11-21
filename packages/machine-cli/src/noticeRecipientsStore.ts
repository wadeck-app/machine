import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalSignedNoticeRecipients,
  compareNoticeRecipients,
  keyId,
  signNoticeRecipients,
  verifyNoticeRecipients,
  type SignedNoticeRecipients,
} from '@wadeck-app/machine-core';
import { withFileLock, writeFileAtomic } from './fsutil.js';

// <configDir>/notice-recipients.json: the admin-signed list of machines that receive request notices (request-notices.md, decision 84).
// Public data (uuids), re-verified against the pinned admin key on every read. No file means no recipients: the target notifies nobody.

export const noticeRecipientsFile = (configDir: string): string => join(configDir, 'notice-recipients.json');

const unusable = (file: string, why: string): Error =>
  new Error(
    `${file} cannot be used (${why}): it holds the list of machines that receive request notices, nothing secret. Delete it, then run \`machine admin distribute <this machine>\` on the admin machine (or \`machine admin notify-to <machine>...\`) to send it again`,
  );

/** Undefined when no list is stored. A file that does not parse, or no longer verifies against the pinned admin key, stops the caller. */
export function readNoticeRecipients(configDir: string, adminPublicKey: string): SignedNoticeRecipients | undefined {
  const file = noticeRecipientsFile(configDir);
  if (!existsSync(file)) {
    return undefined;
  }
  let signed: SignedNoticeRecipients;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { v?: unknown; signed?: unknown };
    if (typeof raw !== 'object' || raw === null || raw.v !== 1) {
      throw new Error('unexpected content');
    }
    signed = canonicalSignedNoticeRecipients(raw.signed);
  } catch (e) {
    throw unusable(file, (e as Error).message === 'Unexpected end of JSON input' || e instanceof SyntaxError ? 'not valid JSON' : (e as Error).message);
  }
  const checked = verifyNoticeRecipients(signed, { adminPublicKey });
  if (!checked.ok) {
    throw unusable(file, `the stored list does not verify against the pinned admin key: ${checked.message}`);
  }
  return signed;
}

const write = (configDir: string, signed: SignedNoticeRecipients): void =>
  writeFileAtomic(noticeRecipientsFile(configDir), `${JSON.stringify({ v: 1, signed })}\n`, 0o644);

/**
 * Install a received list: verified against the pinned admin key, then the replace-newer rule (an equal or older serial changes nothing).
 * Throws `notice-recipients list refused (<reason>)` for a list that does not verify.
 */
export function installNoticeRecipients(configDir: string, signed: SignedNoticeRecipients, adminPublicKey: string): { changed: boolean; reason?: 'already-installed' } {
  const checked = verifyNoticeRecipients(signed, { adminPublicKey });
  if (!checked.ok) {
    throw new Error(`notice-recipients list refused (${checked.reason}): ${checked.message}`);
  }
  return withFileLock(noticeRecipientsFile(configDir), () => {
    const current = readNoticeRecipients(configDir, adminPublicKey);
    if (compareNoticeRecipients(current, signed) !== 'newer') {
      return { changed: false, reason: 'already-installed' as const };
    }
    write(configDir, canonicalSignedNoticeRecipients(signed));
    return { changed: true };
  });
}

export interface SignRecipientsOptions {
  adminPrivateKeyPkcs8: Uint8Array;
  adminPublicKey: string;
  /** This (admin) machine: the default recipient when no list exists yet. */
  selfUuid: string;
  /** Epoch seconds. */
  now: number;
  /** An explicit list (`machine admin notify-to`): signed and stored with a serial above the stored one. Absent: the stored list is reused, or `[selfUuid]` is signed when none exists. */
  recipients?: string[];
}

/**
 * The list this admin machine sends with a distribution. A stored list (its own, or one received from another admin machine) is reused as it is,
 * so the second admin machine never overrides the first; only an explicit list or the absence of any list signs a new one.
 */
export function signNoticeRecipientsFor(configDir: string, o: SignRecipientsOptions): SignedNoticeRecipients {
  return withFileLock(noticeRecipientsFile(configDir), () => {
    const current = readNoticeRecipients(configDir, o.adminPublicKey);
    if (o.recipients === undefined && current !== undefined) {
      return current;
    }
    const recipients = [...new Set(o.recipients ?? [o.selfUuid])].sort();
    const serial = Math.max(o.now, (current?.body.serial ?? 0) + 1);
    const signed = signNoticeRecipients({ v: 1, adminKeyId: keyId(o.adminPublicKey), serial, issuedAt: o.now, recipients }, o.adminPrivateKeyPkcs8);
    write(configDir, signed);
    return signed;
  });
}
