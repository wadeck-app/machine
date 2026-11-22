import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_NOTICES, applyNotice, endNotice, parseRequestNotice, type NoticeOutcome, type StoredNotice } from '@wadeck-app/machine-core';
import { withFileLock, writeFileAtomic } from './fsutil.js';
import { recordNoticeEndOutcome } from './noticeEnds.js';

// <configDir>/notices.json: the request notices other machines sent to this one (request-notices.md, decision 83). Information about requests held on
// OTHER machines, not verified live; never an authority. Bounded (200 newest, 7 days), written atomically, damaged file refused loudly.
// No secret: a notice holds a command text as the target saw it, names, ids and dates.

export const noticesFile = (configDir: string): string => join(configDir, 'notices.json');

const unusable = (file: string, why: string): Error =>
  new Error(`${file} cannot be used (${why}): it holds the request notices sent by other machines, nothing secret and nothing that grants a right. Delete it; new notices fill it again (the live view of a machine stays available with "Load the other machines" or \`machine requests <machine>\`)`);

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Only the declared fields of a notice: what a file or a peer put next to them is dropped. */
function canonical(n: StoredNotice): StoredNotice {
  return {
    machine: n.machine,
    machineName: n.machineName,
    receivedAt: n.receivedAt,
    id: n.id,
    peer: n.peer,
    peerName: n.peerName,
    shell: n.shell,
    command: n.command,
    commandTruncated: n.commandTruncated,
    state: n.state,
    deadline: n.deadline,
    ts: n.ts,
    ...(n.renewal !== undefined ? { renewal: n.renewal } : {}),
  };
}

function validated(raw: unknown, file: string): StoredNotice[] {
  const list = (raw as { v?: unknown; notices?: unknown } | null)?.notices;
  if (typeof raw !== 'object' || raw === null || (raw as { v?: unknown }).v !== 1 || !Array.isArray(list) || list.length > MAX_NOTICES) {
    throw unusable(file, 'unexpected content');
  }
  return list.map((entry: unknown) => {
    const o = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const { machine, machineName, receivedAt, ...frame } = o;
    const parsed = parseRequestNotice({ type: 'request-notice', ...frame });
    if (!parsed.ok || typeof machine !== 'string' || !UUID.test(machine) || typeof machineName !== 'string' || !NAME.test(machineName) || !Number.isSafeInteger(receivedAt)) {
      throw unusable(file, parsed.ok ? 'a notice has a bad sender or date' : parsed.message);
    }
    const { type: _type, ...notice } = parsed.notice;
    return canonical({ ...notice, machine, machineName, receivedAt: receivedAt as number });
  });
}

/** Every stored notice, oldest first. No file: none. A damaged file stops the caller. */
export function readNotices(configDir: string): StoredNotice[] {
  const file = noticesFile(configDir);
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

function update(configDir: string, change: (list: StoredNotice[]) => StoredNotice[]): void {
  const file = noticesFile(configDir);
  withFileLock(file, () => {
    const next = change(readNotices(configDir));
    writeFileAtomic(file, `${JSON.stringify({ v: 1, notices: next.map(canonical) })}\n`, 0o600);
  });
}

/** Insert or replace a notice (bounded, aged). Throws when the file is damaged: the caller reports it, the connection is not affected. */
export function recordNotice(configDir: string, notice: StoredNotice, now: number): void {
  update(configDir, (list) => applyNotice(list, notice, now));
}

/**
 * The end of a request: its notice is dropped (also ages the others out). With `outcome`, how it ended is kept as well (notice-ends.json), so the Requests page
 * can tell the person that the held command was released, denied or timed out (decision 86).
 */
export function recordNoticeEnd(configDir: string, machine: string, id: string, now: number, outcome?: NoticeOutcome): void {
  update(configDir, (list) => endNotice(list, machine, id).filter((n) => now - n.receivedAt <= 7 * 86_400));
  if (outcome !== undefined) {
    recordNoticeEndOutcome(configDir, { machine, id, outcome, at: now }, now);
  }
}
