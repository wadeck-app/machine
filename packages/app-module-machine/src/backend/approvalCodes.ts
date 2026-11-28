import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// The security code of each approval made from the page, kept so that it can be read again after the dialog is closed (admin-ui.md, "Approve from the page"). The
// relay purges the candidacy random once approved, so the code cannot be recomputed later: the page hands it over right after the approval. It is a PUBLIC value
// (derived from two public keys and a random both machines see) and only a reminder for the human who compares it: it proves and widens nothing, and the decisive
// confirmation is the one made on the candidate machine. No secret is stored here.

export const APPROVAL_CODES_FILE = 'approval-codes.json';
/** The candidate has this long to confirm on its own machine; after it the reminder is dropped. */
export const APPROVAL_CODES_RETENTION_SECONDS = 7 * 24 * 3600;
export const APPROVAL_CODES_KEPT = 20;

export interface ApprovalCode {
  uuid: string;
  name: string;
  /** Five groups of five digits. */
  code: string;
}

export interface RecordedApproval extends ApprovalCode {
  /** Epoch seconds, from the clock of this machine. */
  at: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CODE = /^\d{5}( \d{5}){4}$/;
// No control character in a name that is shown back on the page.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const RULE = 'expected exactly {"uuid": "<uuid of the approved machine>", "name": "<its name, 1 to 64 characters>", "code": "<five groups of five digits>"}, nothing else';

/** The shape of the page's request, or the sentence that says what is wrong. */
export function parseApprovalCode(body: unknown): ApprovalCode | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return RULE;
  const keys = Object.keys(body);
  const b = body as Record<string, unknown>;
  if (keys.length !== 3 || !keys.every((k) => k === 'uuid' || k === 'name' || k === 'code')) return RULE;
  if (typeof b['uuid'] !== 'string' || !UUID.test(b['uuid'])) return `"uuid" is not the uuid of a machine: ${RULE}`;
  if (typeof b['name'] !== 'string' || b['name'].length < 1 || b['name'].length > 64 || CONTROL.test(b['name'])) return `"name" must be 1 to 64 printable characters: ${RULE}`;
  if (typeof b['code'] !== 'string' || !CODE.test(b['code'])) return `"code" must be five groups of five digits: ${RULE}`;
  return { uuid: b['uuid'], name: b['name'], code: b['code'] };
}

const fileOf = (configDir: string): string => join(configDir, APPROVAL_CODES_FILE);

const damaged = (file: string, why: string): Error => new Error(`${file} is damaged (${why}): delete it; it only holds reminders of security codes already compared, and the next approval writes a new one`);

function read(configDir: string): RecordedApproval[] {
  const file = fileOf(configDir);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`${file} cannot be read (${(e as Error).message}): check its permissions, or delete it`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw damaged(file, (e as Error).message);
  }
  const list = typeof parsed === 'object' && parsed !== null ? (parsed as { v?: unknown; approvals?: unknown }) : undefined;
  if (list === undefined || list.v !== 1 || !Array.isArray(list.approvals)) throw damaged(file, 'not the expected {"v": 1, "approvals": [...]}');
  const out: RecordedApproval[] = [];
  for (const raw of list.approvals) {
    const entry = parseApprovalCode({ uuid: (raw as Record<string, unknown> | null)?.['uuid'], name: (raw as Record<string, unknown> | null)?.['name'], code: (raw as Record<string, unknown> | null)?.['code'] });
    const at = (raw as Record<string, unknown> | null)?.['at'];
    if (typeof entry === 'string' || typeof at !== 'number' || !Number.isFinite(at)) throw damaged(file, 'an entry is not a uuid, a name, a code and a time');
    out.push({ ...entry, at });
  }
  return out;
}

const fresh = (list: RecordedApproval[], now: number): RecordedApproval[] =>
  list
    .filter((e) => now - e.at < APPROVAL_CODES_RETENTION_SECONDS)
    .sort((a, b) => b.at - a.at)
    .slice(0, APPROVAL_CODES_KEPT);

/** The approvals still worth a reminder, newest first. Throws a sentence naming the file and the fix when it is damaged. */
export function listApprovalCodes(configDir: string, now: number): RecordedApproval[] {
  return fresh(read(configDir), now);
}

/** Keeps `entry` (replacing the one of the same machine) and drops what is too old or beyond the newest ones. Written whole, then renamed. */
export function recordApprovalCode(configDir: string, entry: ApprovalCode, now: number): RecordedApproval {
  const recorded: RecordedApproval = { ...entry, at: now };
  const approvals = fresh([recorded, ...read(configDir).filter((e) => e.uuid !== entry.uuid)], now);
  const file = fileOf(configDir);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ v: 1, approvals }, null, 2)}\n`);
  renameSync(temp, file);
  return recorded;
}
