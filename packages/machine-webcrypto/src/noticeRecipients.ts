import type { SignedDocument } from '@wadeck-app/machine-core';
import type { Json } from './canonical.js';
import { buildDocument, documentId, DOCUMENT_RETENTION_SECONDS } from './documents.js';
import { signBody } from './signed.js';

// The list of machines that receive request notices (request-notices.md, decisions 83 and 84), signed by the admin page like the CLI does. Same domain,
// same body, same document as machine-core noticeRecipients.ts and machine-cli distribute.ts `putNoticeRecipients`; noticeRecipients.test.ts proves it.
// It is NOT a right: it only decides who receives information.

export const NOTICE_RECIPIENTS_DOMAIN = 'machine/notice-recipients/v1';
export const MAX_NOTICE_RECIPIENTS = 8;

export interface NoticeRecipientsBody {
  v: 1;
  adminKeyId: string;
  serial: number;
  issuedAt: number;
  recipients: string[];
}

export interface SignedNoticeRecipients {
  body: NoticeRecipientsBody;
  signature: string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_ID = /^[0-9a-f]{32}$/;

/** Copy of machine-core `assertNoticeRecipientsBody`, message for message. */
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

/** The next list: `serial = max(now, previous + 1)` (machine-cli `signNoticeRecipientsFor`), recipients sorted and unique. */
export function nextNoticeRecipientsBody(input: { adminKeyId: string; now: number; current: SignedNoticeRecipients | null; recipients: string[] }): NoticeRecipientsBody {
  return {
    v: 1,
    adminKeyId: input.adminKeyId,
    serial: Math.max(input.now, (input.current?.body.serial ?? 0) + 1),
    issuedAt: input.now,
    recipients: [...new Set(input.recipients)].sort(),
  };
}

export async function signNoticeRecipients(body: NoticeRecipientsBody, adminPrivateKey: CryptoKey): Promise<SignedNoticeRecipients> {
  assertNoticeRecipientsBody(body);
  return signBody(NOTICE_RECIPIENTS_DOMAIN, body as unknown as Json, adminPrivateKey) as unknown as Promise<SignedNoticeRecipients>;
}

/**
 * The inbox document that carries a signed list to one machine, sealed to its identity key (decision 78). The id and the lifetime are the ones of
 * machine-cli `putNoticeRecipients`: `v2:notice-recipients:<to>:<serial>:<signature>`, issued now, kept by the relay 30 days.
 */
export async function sealedNoticeRecipientsDocument(signed: SignedNoticeRecipients, to: string, now: number, adminPrivateKey: CryptoKey, recipientIdentityPublicKey: string): Promise<SignedDocument> {
  return buildDocument(
    {
      kind: 'notice-recipients',
      to,
      id: await documentId(`v2:notice-recipients:${to}:${signed.body.serial}:${signed.signature}`),
      issuedAt: now,
      expiresAt: now + DOCUMENT_RETENTION_SECONDS,
      payload: signed as never,
      recipientIdentityPublicKey,
    },
    adminPrivateKey,
  );
}
