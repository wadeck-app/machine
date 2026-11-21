import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withFileLock, writeFileAtomic } from './fsutil.js';

// <configDir>/notice-recipients-sent.json: what THIS admin machine sent of the notice-recipients list, per machine, and what each machine said it holds
// (the `noticeRecipientsSerial` of its admin-signed requests-list answer). A record for display only: it grants nothing and is never trusted for a decision.
// Not a secret (uuids, serials, times). Bounded: MAX_SENT_MACHINES machines.

export const MAX_SENT_MACHINES = 256;

export const noticeSentFile = (configDir: string): string => join(configDir, 'notice-recipients-sent.json');

export interface NoticeSent {
  serial: number;
  /** Epoch seconds. */
  at: number;
  /** The relay stored (or already held) the document: the machine reads it at its next inbox check. False: the send failed. */
  stored: boolean;
}

export interface NoticeConfirmed {
  /** The serial the machine said it holds; null: it holds no list. */
  serial: number | null;
  at: number;
}

export interface NoticeSentEntry {
  sent?: NoticeSent;
  confirmed?: NoticeConfirmed;
}

export type NoticeSentRecord = Record<string, NoticeSentEntry>;

const unusable = (file: string, why: string): Error =>
  new Error(`${file} cannot be used (${why}): it only records which machine received the list of request-notice recipients, nothing secret and nothing depends on it. Delete it; \`machine admin notify-to --list\` then shows every machine as unknown until the next send or \`machine requests <machine>\``);

const isInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

function parse(file: string, text: string): NoticeSentRecord {
  let raw: { v?: unknown; machines?: unknown };
  try {
    raw = JSON.parse(text) as typeof raw;
  } catch {
    throw unusable(file, 'not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || raw.v !== 1 || typeof raw.machines !== 'object' || raw.machines === null || Array.isArray(raw.machines)) {
    throw unusable(file, 'unexpected content');
  }
  const out: NoticeSentRecord = {};
  for (const [uuid, value] of Object.entries(raw.machines)) {
    const v: { sent?: Record<string, unknown>; confirmed?: Record<string, unknown> } | null = value;
    if (typeof v !== 'object' || v === null) {
      throw unusable(file, `the entry of ${uuid} is not an object`);
    }
    const entry: NoticeSentEntry = {};
    if (v.sent !== undefined) {
      if (!isInt(v.sent['serial']) || !isInt(v.sent['at']) || typeof v.sent['stored'] !== 'boolean') {
        throw unusable(file, `the "sent" entry of ${uuid} is malformed`);
      }
      entry.sent = { serial: v.sent['serial'], at: v.sent['at'], stored: v.sent['stored'] };
    }
    if (v.confirmed !== undefined) {
      if ((v.confirmed['serial'] !== null && !isInt(v.confirmed['serial'])) || !isInt(v.confirmed['at'])) {
        throw unusable(file, `the "confirmed" entry of ${uuid} is malformed`);
      }
      entry.confirmed = { serial: v.confirmed['serial'] as number | null, at: v.confirmed['at'] };
    }
    out[uuid] = entry;
  }
  return out;
}

/** Empty when no file exists. A file that does not parse stops the caller with its path and the fix. */
export function readNoticeSent(configDir: string): NoticeSentRecord {
  const file = noticeSentFile(configDir);
  return existsSync(file) ? parse(file, readFileSync(file, 'utf8')) : {};
}

/** The newest `MAX_SENT_MACHINES` machines by their last activity. */
function bounded(all: NoticeSentRecord): NoticeSentRecord {
  const last = (e: NoticeSentEntry): number => Math.max(e.sent?.at ?? 0, e.confirmed?.at ?? 0);
  const kept = Object.entries(all)
    .sort((a, b) => last(b[1]) - last(a[1]))
    .slice(0, MAX_SENT_MACHINES);
  return Object.fromEntries(kept);
}

function update(configDir: string, uuid: string, change: (entry: NoticeSentEntry) => NoticeSentEntry): void {
  const file = noticeSentFile(configDir);
  withFileLock(file, () => {
    const all = readNoticeSent(configDir);
    all[uuid] = change(all[uuid] ?? {});
    writeFileAtomic(file, `${JSON.stringify({ v: 1, machines: bounded(all) })}\n`, 0o644);
  });
}

export function recordNoticeSent(configDir: string, uuid: string, sent: NoticeSent): void {
  update(configDir, uuid, (entry) => ({ ...entry, sent }));
}

export function recordNoticeConfirmed(configDir: string, uuid: string, confirmed: NoticeConfirmed): void {
  update(configDir, uuid, (entry) => ({ ...entry, confirmed }));
}

export type Holding =
  | { state: 'current'; serial: number; at: number }
  | { state: 'newer'; serial: number; at: number }
  | { state: 'sent'; at: number }
  | { state: 'send-failed'; at: number }
  | { state: 'older'; serial: number; at: number }
  | { state: 'none'; at: number }
  | { state: 'unknown' };

/**
 * What a machine holds, from the record and the serial of the list this admin machine signed. A confirmation (the machine's own answer) wins over a
 * send that is older than it; a send of the current list that is newer than the last answer is "sent, not confirmed".
 */
export function holdingOf(currentSerial: number, entry: NoticeSentEntry | undefined): Holding {
  const sent = entry?.sent !== undefined && entry.sent.serial >= currentSerial ? entry.sent : undefined;
  const confirmed = entry?.confirmed;
  if (confirmed !== undefined && confirmed.serial !== null && confirmed.serial >= currentSerial) {
    return { state: confirmed.serial === currentSerial ? 'current' : 'newer', serial: confirmed.serial, at: confirmed.at };
  }
  if (sent !== undefined && (confirmed === undefined || sent.at >= confirmed.at)) {
    return sent.stored ? { state: 'sent', at: sent.at } : { state: 'send-failed', at: sent.at };
  }
  if (confirmed !== undefined) {
    return confirmed.serial === null ? { state: 'none', at: confirmed.at } : { state: 'older', serial: confirmed.serial, at: confirmed.at };
  }
  return { state: 'unknown' };
}

/**
 * What a peer said it holds in its requests-list answer. Absent (an older build) records nothing: the machine stays "unknown".
 * Returns a warning for the caller to show when the record cannot be written; the answer itself is never refused for that.
 */
export function confirmFromAnswer(configDir: string, uuid: string, answer: { noticeRecipientsSerial?: number | null }, now: number): string | undefined {
  if (answer.noticeRecipientsSerial === undefined) {
    return undefined;
  }
  try {
    recordNoticeConfirmed(configDir, uuid, { serial: answer.noticeRecipientsSerial, at: now });
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}
