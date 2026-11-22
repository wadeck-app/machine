import { ACTIVITY_OUTCOMES, ACTIVITY_PAGE_SIZES, formatCount, formatRunTime, type ActivityEvent, type ActivityPage } from '@wadeck-app/machine-core';
import { ageText } from './candidacies.js';

// The Activity page (run-log.md): the commands THIS machine sent (its outgoing run log) and received (its audit log) in one timeline. The data is
// the answer of the daemon command `activity` (the reader of `machine log`, machine-core buildActivity); this file turns it into rows with
// humanized ages and a tone for the outcome. Read-only. Nothing secret exists in it: the log holds the command as typed, never its output.

/** The query of the page names a field this module does not know, or repeats one. Answered 400. */
export class ActivityQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActivityQueryError';
  }
}

/** The daemon answered something that is not the `activity` command of this version. */
export class ActivityAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActivityAnswerError';
  }
}

const QUERY_FIELDS = ['direction', 'machine', 'outcome', 'since', 'text', 'limit', 'offset', 'page', 'pageSize'] as const;

/** The query string of the page as the text fields the daemon takes. An empty field is dropped (the page sends every field, set or not). */
export function activityQueryOf(query: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (query === undefined || query === null) {
    return out;
  }
  if (typeof query !== 'object' || Array.isArray(query)) {
    throw new ActivityQueryError(`the query must be fields of text (${QUERY_FIELDS.join(', ')})`);
  }
  for (const [key, value] of Object.entries(query)) {
    if (!(QUERY_FIELDS as readonly string[]).includes(key)) {
      throw new ActivityQueryError(`the query field "${key}" is not known: use ${QUERY_FIELDS.join(', ')}`);
    }
    if (typeof value !== 'string') {
      throw new ActivityQueryError(`the query field "${key}" must be given once, as text`);
    }
    if (value !== '') {
      out[key] = value;
    }
  }
  return out;
}

export type ActivityTone = 'success' | 'warning' | 'danger' | 'neutral';
/** The exit code cell: `ok` is green, `fail` red, `none` a muted dash (no command ran). */
export type ExitTone = 'ok' | 'fail' | 'none';

export interface ActivityRow {
  /** Stable key of the row: direction, id and time. */
  key: string;
  ts: string;
  whenText: string;
  direction: 'sent' | 'received';
  directionText: string;
  fromText: string;
  toText: string;
  shell: string;
  command: string;
  outcome: string;
  /** The Result column: `ran`, `refused (reason)`, `denied`, `deadline`, `timeout`, `connection-lost`, `error (cause)`, `unfinished`. */
  resultText: string;
  tone: ActivityTone;
  /** The Exit column: the code, `timed out`, `killed`, or `-` when no command ran. */
  exitText: string;
  exitTone: ExitTone;
  exitTitle: string;
  /** The Ran for column: the run time of the command on the target, `-` when unknown; `~` in front of an estimate. */
  ranText: string;
  ranDerived: boolean;
  ranTitle: string;
  /** The Waited column: the time the request was held waiting for approval, `-` when it was not. */
  waitedText: string;
  /** Other facts of the row: a command cut in the log, an entry that cannot be trusted. */
  detailText: string;
  verified: boolean;
}

export interface ActivityPageModel {
  machine: { uuid: string; name: string };
  rows: ActivityRow[];
  total: number;
  /** False: counting stopped at its budget and `total` is a lower bound. */
  totalExact: boolean;
  /** 1-based. */
  page: number;
  pageSize: number;
  pageCount: number;
  /** The page sizes the page accepts. */
  pageSizes: number[];
  counts: { sent: number; received: number };
  /** The other machines seen in the logs and in the network: the choices of the machine filter. */
  machines: string[];
  /** The outcomes a filter accepts. */
  outcomes: string[];
  emptyMessage: string;
  chainText: string;
  notes: string[];
}

function resultText(e: ActivityEvent): string {
  if (e.outcome === 'refused') {
    return `refused (${e.reason ?? 'unknown reason'})`;
  }
  if (e.outcome === 'error') {
    return e.cause !== undefined ? `error (${e.cause})` : 'error';
  }
  return e.outcome;
}

const WARNING_OUTCOMES: readonly string[] = ['refused', 'denied', 'deadline', 'timeout'];
const DANGER_OUTCOMES: readonly string[] = ['error', 'connection-lost'];

function toneOf(e: ActivityEvent): ActivityTone {
  if (e.outcome === 'ran') {
    return e.exitCode === 0 && e.timedOut !== true ? 'success' : 'warning';
  }
  if (WARNING_OUTCOMES.includes(e.outcome)) {
    return 'warning';
  }
  return DANGER_OUTCOMES.includes(e.outcome) ? 'danger' : 'neutral';
}

function exitOf(e: ActivityEvent): { text: string; tone: ExitTone; title: string } {
  if (e.outcome !== 'ran') {
    return { text: '-', tone: 'none', title: 'No command ran' };
  }
  if (e.timedOut === true) {
    return { text: 'timed out', tone: 'fail', title: 'The target stopped the command at its time limit' };
  }
  if (e.exitCode === null || e.exitCode === undefined) {
    return { text: 'killed', tone: 'fail', title: 'The command was killed: it has no exit code' };
  }
  return { text: String(e.exitCode), tone: e.exitCode === 0 ? 'ok' : 'fail', title: e.exitCode === 0 ? 'Exit code 0: success' : `Exit code ${e.exitCode}: the command failed` };
}

function ranOf(e: ActivityEvent): { text: string; derived: boolean; title: string } {
  if (e.execMs === undefined) {
    return { text: '-', derived: false, title: e.outcome === 'ran' ? 'The run time was not recorded and cannot be derived' : 'No command ran' };
  }
  const whole = e.durationMs === undefined ? '' : `whole run ${formatRunTime(e.durationMs)}`;
  if (e.execDerived === true) {
    return { text: `~${formatRunTime(e.execMs)}`, derived: true, title: `Estimated: the whole run minus the wait, from an entry written before the run time was recorded; it includes the connection${whole === '' ? '' : ` (${whole})`}` };
  }
  return { text: formatRunTime(e.execMs), derived: false, title: `Run time of the command on the target${whole === '' ? '' : `, ${whole}`}` };
}

const nameOf = (m: { name?: string | undefined; uuid?: string | undefined }): string => m.name ?? (m.uuid === undefined ? '?' : m.uuid.slice(0, 8));

function row(e: ActivityEvent, nowSeconds: number): ActivityRow {
  const detail: string[] = [];
  if (e.truncated === true) {
    detail.push('command cut in the log');
  }
  if (!e.verified) {
    detail.push('UNVERIFIED: after a break of the audit chain');
  }
  const age = nowSeconds - e.atMs / 1000;
  const exit = exitOf(e);
  const ran = ranOf(e);
  return {
    key: `${e.direction}-${e.id ?? 'x'}-${e.ts}`,
    ts: e.ts,
    whenText: age < 5 ? 'now' : `${ageText(age)} ago`,
    direction: e.direction,
    directionText: e.direction === 'sent' ? 'Sent' : 'Received',
    fromText: nameOf(e.from),
    toText: nameOf(e.to),
    shell: e.shell,
    command: e.command,
    outcome: e.outcome,
    resultText: resultText(e),
    tone: toneOf(e),
    exitText: exit.text,
    exitTone: exit.tone,
    exitTitle: exit.title,
    ranText: ran.text,
    ranDerived: ran.derived,
    ranTitle: ran.title,
    waitedText: e.waitedSeconds !== undefined && e.waitedSeconds > 0 ? formatRunTime(e.waitedSeconds * 1000) : '-',
    detailText: detail.join(', '),
    verified: e.verified,
  };
}

interface ActivityAnswerLike {
  initialized: true;
  ok: true;
  self: { uuid: string; name: string };
  page: ActivityPage;
  runLog: { dir: string; files: number; damagedLines: number; recounted?: string[] };
  auditDamagedLines?: number;
  machines: string[];
}

function isAnswer(answer: unknown): answer is ActivityAnswerLike {
  const a: Partial<Record<string, unknown>> | undefined = typeof answer === 'object' && answer !== null ? Object.fromEntries(Object.entries(answer)) : undefined;
  if (a === undefined || a['initialized'] !== true || a['ok'] !== true) {
    return false;
  }
  const page = a['page'] as { items?: unknown; total?: unknown; pageCount?: unknown } | null | undefined;
  return typeof page === 'object' && page !== null && Array.isArray(page.items) && typeof page.total === 'number' && typeof page.pageCount === 'number' && typeof a['self'] === 'object' && a['self'] !== null && Array.isArray(a['machines']) && typeof a['runLog'] === 'object' && a['runLog'] !== null;
}

export function activityPage(answer: unknown, nowSeconds: number): ActivityPageModel {
  if (!isAnswer(answer)) {
    throw new ActivityAnswerError('the daemon answered the activity command with something unexpected: it is probably an older version, update it with `machine cli update` and restart it');
  }
  const { page } = answer;
  const notes: string[] = [];
  if (answer.runLog.damagedLines > 0) {
    notes.push(`${answer.runLog.damagedLines} damaged line(s) of the run log were skipped (a crash cut them, or the file was edited): see ${answer.runLog.dir}.`);
  }
  if ((answer.auditDamagedLines ?? 0) > 0) {
    notes.push(`${answer.auditDamagedLines} damaged line(s) of the audit log were skipped: keep a copy of the file for the investigation.`);
  }
  for (const recount of answer.runLog.recounted ?? []) {
    notes.push(`${recount.charAt(0).toUpperCase()}${recount.slice(1)}.`);
  }
  if (!page.totalExact) {
    notes.push(`There are more than ${formatCount(page.total)} matching entries: counting stopped there. Narrow the period or the filters for an exact count.`);
  }
  const chain = page.chain;
  return {
    machine: answer.self,
    rows: page.items.map((e) => row(e, nowSeconds)),
    total: page.total,
    totalExact: page.totalExact,
    page: page.page,
    pageSize: page.pageSize,
    pageCount: page.pageCount,
    pageSizes: [...ACTIVITY_PAGE_SIZES],
    counts: page.counts,
    machines: answer.machines,
    outcomes: [...ACTIVITY_OUTCOMES],
    emptyMessage: page.machines.length > 0 || page.total > 0 ? 'No entry matches these filters' : 'No activity yet: no `machine run` was sent from this machine and no request reached it',
    chainText:
      chain === undefined || chain.ok
        ? ''
        : `The audit log is broken at line ${chain.line}: ${chain.message}. Checked on the ${chain.checkedLines} lines read for this page (the daemon checks the whole log when it starts); the received entries from that line on are shown as unverified. Keep a copy of the file for the investigation, then move it away to start a new log (the daemon refuses to start on a broken log).`,
    notes,
  };
}
