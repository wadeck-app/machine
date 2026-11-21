import type { Json } from './canonical.js';
import { INVALID_ADMIN_KEY_MESSAGE, tryKeyId } from './keys.js';
import { signDocument, verifyDocument } from './signed.js';

// The machines that receive request notices (request-notices.md, decision 84): an admin-signed list of machine uuids, sent to every
// machine as a sealed inbox document. It is NOT a right: it only decides who receives information. No I/O.

export const NOTICE_RECIPIENTS_DOMAIN = 'machine/notice-recipients/v1';
export const MAX_NOTICE_RECIPIENTS = 8;

export interface NoticeRecipientsBody {
  v: 1;
  adminKeyId: string;
  /** Replace-newer rule: a list with a higher serial replaces the stored one. Epoch seconds, or one above the previous when that is later. */
  serial: number;
  issuedAt: number;
  /** Sorted, unique lowercase uuids. May be empty: nobody is notified. */
  recipients: string[];
}

export interface SignedNoticeRecipients {
  body: NoticeRecipientsBody;
  signature: string;
}

export type NoticeRecipientsFailure = 'malformed' | 'invalid-admin-key' | 'wrong-admin-key' | 'bad-signature';
export type NoticeRecipientsResult = { ok: true; body: NoticeRecipientsBody } | { ok: false; reason: NoticeRecipientsFailure; message: string };

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_ID = /^[0-9a-f]{32}$/;

export function assertNoticeRecipientsBody(value: unknown): asserts value is NoticeRecipientsBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('notice-recipients: the body must be an object');
  }
  const record = value as Partial<Record<keyof NoticeRecipientsBody, unknown>>;
  for (const key of Object.keys(record)) {
    if (!['v', 'adminKeyId', 'serial', 'issuedAt', 'recipients'].includes(key)) {
      throw new Error(`notice-recipients: unknown field "${key}"`);
    }
  }
  if (record.v !== 1) {
    throw new Error(`notice-recipients: unsupported version ${String(record.v)} (this build reads version 1): update machine on this machine (\`machine cli update\`)`);
  }
  if (typeof record.adminKeyId !== 'string' || !KEY_ID.test(record.adminKeyId)) {
    throw new Error('notice-recipients: adminKeyId must be 32 lowercase hex characters');
  }
  if (typeof record.serial !== 'number' || !Number.isSafeInteger(record.serial) || record.serial < 1) {
    throw new Error('notice-recipients: serial must be a positive integer');
  }
  if (typeof record.issuedAt !== 'number' || !Number.isSafeInteger(record.issuedAt) || record.issuedAt < 1) {
    throw new Error('notice-recipients: issuedAt must be epoch seconds');
  }
  if (!Array.isArray(record.recipients)) {
    throw new Error('notice-recipients: recipients must be a list');
  }
  if (record.recipients.length > MAX_NOTICE_RECIPIENTS) {
    throw new Error(`notice-recipients: too many recipients (${record.recipients.length}): at most ${MAX_NOTICE_RECIPIENTS}`);
  }
  let previous: string | undefined;
  for (const uuid of record.recipients as unknown[]) {
    if (typeof uuid !== 'string' || !UUID_V4.test(uuid)) {
      throw new Error('notice-recipients: every recipient must be a lowercase version 4 UUID');
    }
    if (previous !== undefined && uuid === previous) {
      throw new Error(`notice-recipients: duplicate recipient ${uuid}`);
    }
    if (previous !== undefined && uuid < previous) {
      throw new Error('notice-recipients: recipients must be sorted by uuid');
    }
    previous = uuid;
  }
}

/** Only { body, signature }: anything else next to them is dropped before a list is stored. */
export function canonicalSignedNoticeRecipients(value: unknown): SignedNoticeRecipients {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('notice-recipients: a signed list must be an object');
  }
  const { body, signature } = value as { body?: unknown; signature?: unknown };
  if (typeof signature !== 'string') {
    throw new Error('notice-recipients: missing signature');
  }
  if (typeof body !== 'object' || body === null) {
    throw new Error('notice-recipients: missing body');
  }
  return { body: body as NoticeRecipientsBody, signature };
}

export function signNoticeRecipients(body: NoticeRecipientsBody, adminPrivateKeyPkcs8: Uint8Array): SignedNoticeRecipients {
  assertNoticeRecipientsBody(body);
  return { body, signature: signDocument(NOTICE_RECIPIENTS_DOMAIN, body as unknown as Json, adminPrivateKeyPkcs8) };
}

export function verifyNoticeRecipients(signed: SignedNoticeRecipients, ctx: { adminPublicKey: string }): NoticeRecipientsResult {
  try {
    if (typeof signed !== 'object' || signed === null || typeof signed.signature !== 'string') {
      throw new Error('notice-recipients: missing signature');
    }
    assertNoticeRecipientsBody(signed.body);
  } catch (e) {
    return { ok: false, reason: 'malformed', message: (e as Error).message };
  }
  const pinned = tryKeyId(ctx.adminPublicKey);
  if (pinned === undefined) {
    return { ok: false, reason: 'invalid-admin-key', message: INVALID_ADMIN_KEY_MESSAGE };
  }
  if (signed.body.adminKeyId !== pinned) {
    return { ok: false, reason: 'wrong-admin-key', message: `notice-recipients list is certified by admin key ${signed.body.adminKeyId}, but this machine pins ${pinned}` };
  }
  if (!verifyDocument(NOTICE_RECIPIENTS_DOMAIN, signed.body as unknown as Json, ctx.adminPublicKey, signed.signature)) {
    return { ok: false, reason: 'bad-signature', message: 'notice-recipients list has an invalid signature; it was altered or not signed by the admin key' };
  }
  return { ok: true, body: signed.body };
}

/** The replace-newer rule: `newer` installs, `same` and `older` are acknowledged without installing. */
export function compareNoticeRecipients(current: SignedNoticeRecipients | undefined, incoming: SignedNoticeRecipients): 'newer' | 'same' | 'older' {
  if (current === undefined) {
    return 'newer';
  }
  if (incoming.body.serial > current.body.serial) {
    return 'newer';
  }
  return incoming.body.serial === current.body.serial ? 'same' : 'older';
}
