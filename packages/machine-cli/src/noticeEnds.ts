import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOTICE_OUTCOMES, type NoticeOutcome } from '@wadeck-app/machine-core';
import { withFileLock, writeFileAtomic } from './fsutil.js';

// <configDir>/notice-ends.json: how the holds ended (decision 86): the outcome a target reported in `request-notice-end` for a request it held, and the
// outcome of the holds of THIS machine. The Requests page asks for it every 2 s after an Allow, to show that the held command was released (or why not).
// Information only, never a right. Bounded (100 newest, one day), written atomically, a damaged file is refused loudly. No secret: ids, outcomes, dates.

export const MAX_NOTICE_ENDS = 100;
const MAX_AGE_SECONDS = 86_400;

export const noticeEndsFile = (configDir: string): string => join(configDir, 'notice-ends.json');

export interface NoticeEnd {
  /** The machine that held the request (its uuid: this machine's for a local hold). */
  machine: string;
  /** The id of the held request. */
  id: string;
  outcome: NoticeOutcome;
  /** Epoch seconds. */
  at: number;
}

const unusable = (file: string, why: string): Error =>
  new Error(`${file} cannot be used (${why}): it only remembers how held requests ended, nothing secret and nothing that grants a right. Delete it; the Requests page then shows no confirmation for the requests it held (\`machine requests <machine>\` still lists what waits)`);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUEST_ID = /^[0-9a-f-]{6,36}$/;

function validated(raw: unknown, file: string): NoticeEnd[] {
  const list = (raw as { v?: unknown; ends?: unknown } | null)?.ends;
  if (typeof raw !== 'object' || raw === null || (raw as { v?: unknown }).v !== 1 || !Array.isArray(list) || list.length > MAX_NOTICE_ENDS) {
    throw unusable(file, 'unexpected content');
  }
  return list.map((entry: unknown) => {
    const e: Record<string, unknown> = typeof entry === 'object' && entry !== null ? Object.fromEntries(Object.entries(entry)) : {};
    if (typeof e['machine'] !== 'string' || !UUID.test(e['machine']) || typeof e['id'] !== 'string' || !REQUEST_ID.test(e['id']) || !(NOTICE_OUTCOMES as readonly string[]).includes(e['outcome'] as string) || !Number.isSafeInteger(e['at'])) {
      throw unusable(file, 'an entry is not a machine, a request id, an outcome and a date');
    }
    return { machine: e['machine'], id: e['id'], outcome: e['outcome'] as NoticeOutcome, at: e['at'] as number };
  });
}

/** Every recorded end, oldest first. No file: none. A damaged file stops the caller. */
export function readNoticeEnds(configDir: string): NoticeEnd[] {
  const file = noticeEndsFile(configDir);
  if (!existsSync(file)) {
    return [];
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw unusable(file, 'not valid JSON');
  }
  return validated(raw, file);
}

export function findNoticeEnd(configDir: string, machine: string, id: string): NoticeEnd | undefined {
  return readNoticeEnds(configDir).find((e) => e.machine === machine && e.id === id);
}

/** Remember how a hold ended (replaces an earlier record of the same hold). Refuses an outcome that is not a known one. */
export function recordNoticeEndOutcome(configDir: string, end: NoticeEnd, now: number): void {
  if (!(NOTICE_OUTCOMES as readonly string[]).includes(end.outcome)) {
    throw new Error(`cannot record the end of a request: the outcome "${String(end.outcome)}" is not one of ${NOTICE_OUTCOMES.join(', ')}`);
  }
  const file = noticeEndsFile(configDir);
  withFileLock(file, () => {
    const kept = readNoticeEnds(configDir).filter((e) => !(e.machine === end.machine && e.id === end.id) && now - e.at <= MAX_AGE_SECONDS);
    const next = [...kept, { machine: end.machine, id: end.id, outcome: end.outcome, at: end.at }].slice(-MAX_NOTICE_ENDS);
    writeFileAtomic(file, `${JSON.stringify({ v: 1, ends: next })}\n`, 0o600);
  });
}
