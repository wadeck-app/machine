import { auditLineHashOk } from './audit.js';
import { printable } from './requests.js';
import { parseRunLogLine, type RunLogEntry } from './runLog.js';

// The Activity timeline (run-log.md): the commands THIS machine sent (its outgoing run log) and received (its audit log) in one list, newest
// first, filtered and paginated. Pure: the caller hands over the lines of both logs as lazy iterables, NEWEST FIRST, and this reads only as many
// as the page needs (the logs are rotated and can hold tens of thousands of lines). Every text shown is printable ASCII and bounded: an old or
// edited log cannot send a control sequence to a terminal or a web page.

export const ACTIVITY_DEFAULT_LIMIT = 50;
export const ACTIVITY_MAX_LIMIT = 500;
/** The page sizes of the Activity page. */
export const ACTIVITY_PAGE_SIZES = [25, 50, 100] as const;
export const ACTIVITY_DEFAULT_PAGE_SIZE = 25;
/** Lines read, over both logs, to count the entries that match a filter; past it the total is a lower bound (`totalExact: false`). */
export const ACTIVITY_MAX_COUNT_LINES = 400_000;
export const ACTIVITY_DIRECTIONS = ['sent', 'received'] as const;
export type ActivityDirection = (typeof ACTIVITY_DIRECTIONS)[number];
/** The outcomes of the run log, and `unfinished`: a received command accepted whose completion is not in the log (a crash or a cut). */
export const ACTIVITY_OUTCOMES = ['ran', 'refused', 'denied', 'deadline', 'timeout', 'connection-lost', 'error', 'unfinished'] as const;

/** A page was asked past the last one. Not a bug of the caller's code: the message says what the last page is. */
export class ActivityRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActivityRangeError';
  }
}

export interface ActivityMachine {
  uuid?: string;
  name?: string;
}

export interface ActivityEvent {
  /** ISO 8601, UTC. */
  ts: string;
  /** Epoch milliseconds of `ts`. */
  atMs: number;
  direction: ActivityDirection;
  from: ActivityMachine;
  to: ActivityMachine;
  shell: string;
  command: string;
  outcome: string;
  /** The run id (sent) or the request id (received); lets a sent run be matched with the target's audit log. */
  id?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  reason?: string;
  cause?: string;
  /** Sent: the whole run, connection and wait included. Received: the run time of the command. */
  durationMs?: number;
  /** The run time of the command on the target. Absent when no command ran, or when it cannot be known (see `execDerived`). */
  execMs?: number;
  /** True when `execMs` is an estimate, the whole run minus the wait, because the line was written before the run time was recorded. */
  execDerived?: boolean;
  /** Follow mode only: the one word that qualifies an audit entry with no row of its own (`session-closed (peer-revoked)`). */
  detail?: string;
  /** Sent: the command was cut in the log. */
  truncated?: boolean;
  /** Sent: how long the request was held waiting for the owner, in seconds. */
  waitedSeconds?: number;
  /** False for a received entry after a break of the audit chain: it cannot be trusted. */
  verified: boolean;
}

export interface ActivityFilter {
  direction?: ActivityDirection;
  /** The OTHER machine: its name (any case) or a uuid prefix. */
  machine?: string;
  outcome?: string;
  /** Epoch milliseconds, inclusive. */
  sinceMs?: number;
  untilMs?: number;
  /** Case-insensitive text found in the command, a machine name, the shell, the outcome or the reason. */
  text?: string;
  limit?: number;
  offset?: number;
  /** Only to word the error of a page past the end ("page 9 is beyond the last page (5)"); `offset` and `limit` decide. */
  page?: number;
}

/**
 * What the audit lines READ for this page say about their chain: the lines are checked against each other, not the whole log (that is the
 * daemon's check at start and `machine requests`). A break found is shown, never hidden.
 */
export type ActivityChain =
  | { scope: 'window'; ok: true; checkedLines: number }
  | { scope: 'window'; ok: false; line: number; message: string; checkedLines: number };

export interface ActivityPage {
  /** The requested window, newest first. */
  items: ActivityEvent[];
  /** Entries that match the filter, before the window. A lower bound when `totalExact` is false. */
  total: number;
  /** False when counting stopped at the line budget: the real total is at least `total`. */
  totalExact: boolean;
  offset: number;
  limit: number;
  /** 1-based number of this page (the window starts at `(page - 1) * limit` when the offset is a multiple of the limit). */
  page: number;
  pageSize: number;
  /** Pages at the current size (at least 1). A lower bound when `totalExact` is false. */
  pageCount: number;
  hasMore: boolean;
  nextOffset?: number;
  /** Sent and received among the `total` entries. */
  counts: { sent: number; received: number };
  /** The other machines seen on the lines read for this page, by name, sorted. */
  machines: string[];
  /** State of the audit lines read (a break is shown, never hidden). Absent when no audit line was read. */
  chain: ActivityChain | undefined;
  /** Damaged lines skipped: in the whole logs when the cache or the counting pass read them all, else those met on this page. */
  damaged: { sent: number; received: number };
}

/** Why a log is read: the lines of one page, or the full pass that counts what matches. A reader can account for them apart. */
export type ActivityPhase = 'page' | 'count';

export interface ActivitySources {
  /** The lines of the outgoing run log, NEWEST FIRST (file order reversed). */
  sentLines: (phase: ActivityPhase) => Iterable<string>;
  /** The lines of the audit log, NEWEST FIRST. */
  auditLines: (phase: ActivityPhase) => Iterable<string>;
  /**
   * Valid rows of each log with no filter, and its damaged lines, from the reader's cache: with no filter on the content the total needs no pass.
   * A function: a reader whose cache is cold only pays for the scan when the answer is used.
   */
  knownRows?: () => { sent: number; received: number; damaged: { sent: number; received: number } };
}

export interface ActivityInput {
  self: { uuid: string; name: string };
  sources: ActivitySources;
  nameOf: (uuid: string) => string | undefined;
  filter: ActivityFilter;
  /** Lines read in the counting pass, both logs together (default ACTIVITY_MAX_COUNT_LINES). */
  maxCountLines?: number;
}

function checkRange(name: string, value: number | undefined, min: number, max: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value < min || (max !== undefined && value > max)) {
    throw new Error(`${name} must be a whole number ${max === undefined ? `of at least ${min}` : `from ${min} to ${max}`}, got ${String(value)}`);
  }
  return value;
}

export const clean = (text: string | undefined, max = 2048): string | undefined => (text === undefined ? undefined : printable(text, max));

/** 1234567 -> "1,234,567": a count with thousands separators (the same in every locale, so a page and a test read alike). */
export function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "312 ms", "1.2 s", "3 min 4 s", "1 h 6 min": the duration as a person reads it. */
export function formatRunTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error(`a duration is a number of milliseconds of at least 0, got ${String(ms)}`);
  }
  if (ms < 999.5) {
    return `${Math.round(ms)} ms`;
  }
  const tenths = Math.round(ms / 100);
  if (tenths < 600) {
    return `${(tenths / 10).toFixed(1)} s`;
  }
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return m === 0 ? `${h} h` : `${h} h ${m} min`;
  }
  return s === 0 ? `${m} min` : `${m} min ${s} s`;
}

// ---------------------------------------------------------------------------------------------------------------- sent

export function sentEvent(e: RunLogEntry): ActivityEvent {
  // The run time of the command: as recorded, else (old line) the whole run minus the wait, flagged as an estimate; never a negative or a made-up number.
  let execMs: number | undefined;
  let execDerived = false;
  if (e.outcome === 'ran') {
    if (e.execMs !== undefined) {
      execMs = e.execMs;
    } else if (e.durationMs - e.waitedSeconds * 1000 >= 0) {
      execMs = e.durationMs - e.waitedSeconds * 1000;
      execDerived = true;
    }
  }
  return {
    ts: e.ts,
    atMs: Date.parse(e.ts),
    direction: 'sent',
    from: { uuid: e.from.uuid, name: clean(e.from.name, 100) as string },
    to: { uuid: e.to.uuid, name: clean(e.to.name, 100) as string },
    shell: clean(e.shell, 16) as string,
    command: clean(e.command) as string,
    outcome: e.outcome,
    id: clean(e.runId, 64) as string,
    ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
    ...(e.timedOut === true ? { timedOut: true } : {}),
    ...(e.reason !== undefined ? { reason: clean(e.reason, 64) as string } : {}),
    ...(e.cause !== undefined ? { cause: clean(e.cause, 300) as string } : {}),
    durationMs: e.durationMs,
    ...(execMs !== undefined ? { execMs } : {}),
    ...(execDerived ? { execDerived: true } : {}),
    ...(e.truncated ? { truncated: true } : {}),
    waitedSeconds: e.waitedSeconds,
    verified: true,
  };
}

/** An event read from a log, with the latest time any line NOT YET READ of that log can have (`frontier`). */
interface Item {
  event: ActivityEvent;
  frontier: number;
}

interface ReadStats {
  damaged: number;
}

/**
 * The run log is appended when a run ENDS, with the time it was SENT: a run that waited an hour is written after runs sent later. A line not yet
 * read was appended before the one in hand, so it was sent no later than the end of the one in hand (sent + whole run).
 */
function* sentStream(lines: Iterable<string>, sinceMs: number | undefined, stats: ReadStats): Generator<Item> {
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    const entry = parseRunLogLine(line);
    if (entry === 'damaged') {
      stats.damaged += 1;
      continue;
    }
    const event = sentEvent(entry);
    const frontier = event.atMs + entry.durationMs;
    yield { event, frontier };
    if (sinceMs !== undefined && frontier < sinceMs) {
      return;
    }
  }
}

// ------------------------------------------------------------------------------------------------------------- received

interface AuditLine {
  seq: number;
  prev: string;
  hash: string;
  entry: Record<string, unknown>;
}

export function parseAuditLine(line: string): AuditLine | undefined {
  try {
    const p = JSON.parse(line) as Partial<Record<string, unknown>> | null;
    const entry = p?.['entry'];
    if (typeof p?.['seq'] !== 'number' || typeof p['prev'] !== 'string' || typeof p['hash'] !== 'string' || typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return undefined;
    }
    return { seq: p['seq'], prev: p['prev'], hash: p['hash'], entry: entry as Record<string, unknown> };
  } catch {
    return undefined;
  }
}

export const str = (v: unknown, max?: number): string | undefined => (typeof v === 'string' ? printable(v, max) : undefined);
export const atMsOf = (entry: Record<string, unknown>): number => (typeof entry['ts'] === 'string' ? Date.parse(entry['ts']) : Number.NaN);

/**
 * What one audit line is for the timeline: a `row` (a command accepted, or refused), `other` (a completion, a hold, a session...: no row of its
 * own), or `damaged`. The reader of the files counts rows with it, once per file, in a cache.
 */
export function classifyAuditLine(line: string): 'row' | 'other' | 'damaged' {
  const parsed = parseAuditLine(line);
  if (parsed === undefined) {
    return 'damaged';
  }
  const event = parsed.entry['event'];
  return (event === 'accepted' || event === 'refused') && !Number.isNaN(atMsOf(parsed.entry)) ? 'row' : 'other';
}

/**
 * The row of one received request: its `accepted` or `refused` entry, and the `completed` / `failed` entry of the same id when there is one.
 * The ONE builder of a received row: the pages of `machine log` and its live follow mode (activityFollow.ts) both use it.
 */
export function receivedRowEvent(entry: Record<string, unknown>, kind: 'accepted' | 'refused', atMs: number, done: Record<string, unknown> | undefined, self: { uuid: string; name: string }, nameOf: (uuid: string) => string | undefined): ActivityEvent {
  const id = str(entry['id']);
  const peer = str(entry['source']);
  const peerName = peer === undefined ? undefined : nameOf(peer);
  const reason = str(entry['reason']);
  let outcome: string;
  if (kind === 'refused') {
    outcome = reason === 'denied' ? 'denied' : 'refused';
  } else if (done === undefined) {
    outcome = 'unfinished';
  } else {
    outcome = done['event'] === 'completed' ? 'ran' : 'error';
  }
  const exitCode = done?.['exitCode'];
  const durationMs = done?.['durationMs'];
  // A denied request keeps the owner's text of the Deny (the `note` of the refused line, written by the target): printable and bounded like any shown text.
  const error = done?.['event'] === 'failed' ? str(done['error'], 300) : outcome === 'denied' ? str(entry['note'], 300) : undefined;
  return {
    ts: new Date(atMs).toISOString(),
    atMs,
    direction: 'received',
    from: { ...(peer !== undefined ? { uuid: peer } : {}), ...(peerName !== undefined ? { name: clean(peerName, 100) as string } : {}) },
    to: { uuid: self.uuid, name: clean(self.name, 100) as string },
    shell: str(entry['shell']) ?? '',
    command: str(entry['command']) ?? '',
    outcome,
    ...(id !== undefined ? { id } : {}),
    ...(outcome === 'ran' && (typeof exitCode === 'number' || exitCode === null) ? { exitCode } : {}),
    ...(done?.['timedOut'] === true ? { timedOut: true } : {}),
    ...(kind === 'refused' && reason !== undefined ? { reason } : {}),
    ...(error !== undefined ? { cause: error } : {}),
    ...(outcome === 'ran' && typeof durationMs === 'number' ? { durationMs, execMs: durationMs } : {}),
    verified: true,
  };
}

interface AuditLineMeta {
  seq: number;
  prev: string;
  hash: string;
  selfOk: boolean;
}

/** The audit line (by sequence number) each received event comes from: the window check flags the events after a break. */
type SeqOf = WeakMap<ActivityEvent, number>;

/**
 * The received rows, newest first. A completion is written after its acceptance, so it is read BEFORE it: it waits in a map until the acceptance
 * shows up (and is dropped there), so the memory is the requests in flight in the lines read, not the log. A completion whose acceptance is not in
 * the log (the head was cut by hand; the audit log never rotates) shows no row of its own here.
 */
function* auditStream(lines: Iterable<string>, self: { uuid: string; name: string }, nameOf: (uuid: string) => string | undefined, sinceMs: number | undefined, stats: ReadStats, seqOf: SeqOf, meta: AuditLineMeta[] | undefined): Generator<Item> {
  const completions = new Map<string, Record<string, unknown>>();
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    const parsed = parseAuditLine(line);
    if (parsed === undefined) {
      stats.damaged += 1;
      continue;
    }
    meta?.push({ seq: parsed.seq, prev: parsed.prev, hash: parsed.hash, selfOk: auditLineHashOk(parsed.seq, parsed.prev, parsed.entry, parsed.hash) });
    const { entry } = parsed;
    const kind = str(entry['event']);
    const id = str(entry['id']);
    if ((kind === 'completed' || kind === 'failed') && id !== undefined) {
      if (!completions.has(id)) {
        completions.set(id, entry);
      }
      continue;
    }
    if (kind !== 'accepted' && kind !== 'refused') {
      continue;
    }
    const atMs = atMsOf(entry);
    if (Number.isNaN(atMs)) {
      continue;
    }
    const done = kind === 'accepted' && id !== undefined ? completions.get(id) : undefined;
    if (id !== undefined) {
      completions.delete(id);
    }
    const event = receivedRowEvent(entry, kind, atMs, done, self, nameOf);
    seqOf.set(event, parsed.seq);
    yield { event, frontier: atMs };
    if (sinceMs !== undefined && atMs < sinceMs) {
      return;
    }
  }
}

/** Checks the audit lines read against each other, oldest to newest; the first line that is not what its neighbour says marks the break. */
function checkWindow(meta: AuditLineMeta[]): { chain: ActivityChain | undefined; breakSeq: number | undefined } {
  if (meta.length === 0) {
    return { chain: undefined, breakSeq: undefined };
  }
  // `meta` is newest first.
  for (let i = meta.length - 1; i >= 0; i--) {
    const m = meta[i] as AuditLineMeta;
    const older = meta[i + 1];
    let message: string | undefined;
    if (!m.selfOk) {
      message = `audit log line ${m.seq + 1} was modified: its content does not match its hash`;
    } else if (older !== undefined && (m.seq !== older.seq + 1 || m.prev !== older.hash)) {
      message = `audit log line ${m.seq + 1} does not follow the previous line (an entry was deleted, reordered, inserted or damaged)`;
    }
    if (message !== undefined) {
      return { chain: { scope: 'window', ok: false, line: m.seq + 1, message, checkedLines: meta.length }, breakSeq: m.seq };
    }
  }
  return { chain: { scope: 'window', ok: true, checkedLines: meta.length }, breakSeq: undefined };
}

// ---------------------------------------------------------------------------------------------------------------- merge

/**
 * Both streams as one, newest first by the time of each event. An event is released when no line still to be read of either log can be newer
 * than it; the buffer holds the few events waiting for that (a run that waited a long time is appended late).
 */
function* mergeNewestFirst(sent: Iterator<Item>, audit: Iterator<Item>): Generator<ActivityEvent> {
  const sources: Array<{ it: Iterator<Item>; frontier: number }> = [{ it: sent, frontier: Number.POSITIVE_INFINITY }, { it: audit, frontier: Number.POSITIVE_INFINITY }];
  const buffer: Array<{ event: ActivityEvent; rank: number }> = [];
  try {
    for (;;) {
      const threshold = Math.max(sources[0]!.frontier, sources[1]!.frontier);
      const top = buffer[0];
      if (top !== undefined && (top.event.atMs > threshold || threshold === Number.NEGATIVE_INFINITY)) {
        buffer.shift();
        yield top.event;
        continue;
      }
      if (threshold === Number.NEGATIVE_INFINITY) {
        return;
      }
      // Read from the log that can still hold the newest unread line.
      const rank = sources[0]!.frontier >= sources[1]!.frontier ? 0 : 1;
      const source = sources[rank]!;
      const next = source.it.next();
      if (next.done === true) {
        source.frontier = Number.NEGATIVE_INFINITY;
        continue;
      }
      source.frontier = next.value.frontier;
      // Newest first; equal times keep a sent run before a received one, then the order of the log (stable).
      let at = buffer.length;
      while (at > 0) {
        const before = buffer[at - 1] as { event: ActivityEvent; rank: number };
        if (before.event.atMs > next.value.event.atMs || (before.event.atMs === next.value.event.atMs && before.rank <= rank)) {
          break;
        }
        at -= 1;
      }
      buffer.splice(at, 0, { event: next.value.event, rank });
    }
  } finally {
    sent.return?.();
    audit.return?.();
  }
}

function matches(e: ActivityEvent, f: ActivityFilter, selfUuid: string): boolean {
  if (f.direction !== undefined && e.direction !== f.direction) {
    return false;
  }
  if (f.outcome !== undefined && e.outcome !== f.outcome) {
    return false;
  }
  if (f.sinceMs !== undefined && e.atMs < f.sinceMs) {
    return false;
  }
  if (f.untilMs !== undefined && e.atMs > f.untilMs) {
    return false;
  }
  if (f.machine !== undefined) {
    const other = e.direction === 'sent' ? e.to : e.from;
    const wanted = f.machine.toLowerCase();
    const byName = other.name !== undefined && other.name.toLowerCase() === wanted;
    const byUuid = other.uuid !== undefined && other.uuid !== selfUuid && wanted.length >= 4 && other.uuid.toLowerCase().startsWith(wanted);
    if (!byName && !byUuid) {
      return false;
    }
  }
  if (f.text !== undefined && f.text.length > 0) {
    const needle = f.text.toLowerCase();
    const hay = [e.command, e.from.name, e.to.name, e.shell, e.outcome, e.reason].filter((v): v is string => v !== undefined).join('\n').toLowerCase();
    if (!hay.includes(needle)) {
      return false;
    }
  }
  return true;
}

/** True when the filter only picks a direction: the totals of the reader's cache answer it. */
const isContentFree = (f: ActivityFilter): boolean => f.machine === undefined && f.outcome === undefined && f.sinceMs === undefined && f.untilMs === undefined && (f.text === undefined || f.text.length === 0);

/** Lines taken from `lines`, at most what is left of the budget; `state.cut` says the budget ended the read. */
function* withinBudget(lines: Iterable<string>, state: { left: number; cut: boolean }): Generator<string> {
  for (const line of lines) {
    if (state.left <= 0) {
      state.cut = true;
      return;
    }
    state.left -= 1;
    yield line;
  }
}

function countMatching(input: ActivityInput, maxLines: number): { sent: number; received: number; exact: boolean; damaged: { sent: number; received: number } } {
  const { filter, self, sources } = input;
  const state = { left: maxLines, cut: false };
  const stats: ReadStats = { damaged: 0 };
  const auditStats: ReadStats = { damaged: 0 };
  let sentCount = 0;
  let receivedCount = 0;
  if (filter.direction !== 'received') {
    for (const item of sentStream(withinBudget(sources.sentLines('count'), state), filter.sinceMs, stats)) {
      if (matches(item.event, filter, self.uuid)) {
        sentCount += 1;
      }
    }
  }
  if (filter.direction !== 'sent') {
    for (const item of auditStream(withinBudget(sources.auditLines('count'), state), self, input.nameOf, filter.sinceMs, auditStats, new WeakMap(), undefined)) {
      if (matches(item.event, filter, self.uuid)) {
        receivedCount += 1;
      }
    }
  }
  return { sent: sentCount, received: receivedCount, exact: !state.cut, damaged: { sent: stats.damaged, received: auditStats.damaged } };
}

function lastPageWording(filter: ActivityFilter, limit: number, offset: number, total: number): string {
  const pageCount = Math.max(1, Math.ceil(total / limit));
  if (filter.page !== undefined) {
    return `page ${filter.page} is beyond the last page (${pageCount}): ${total} entr${total === 1 ? 'y' : 'ies'} match${total === 1 ? 'es' : ''} at ${limit} per page. Ask for a page from 1 to ${pageCount}`;
  }
  return `offset ${offset} is beyond the last entry (${total} match${total === 1 ? 'es' : ''}, last page starts at offset ${(pageCount - 1) * limit}). Ask for an offset below ${Math.max(1, total)}`;
}

export function buildActivity(input: ActivityInput): ActivityPage {
  const { self, filter, sources } = input;
  const limit = checkRange('limit', filter.limit, 1, ACTIVITY_MAX_LIMIT) ?? ACTIVITY_DEFAULT_LIMIT;
  const offset = checkRange('offset', filter.offset, 0, undefined) ?? 0;

  // 1. How many entries match: the cache of the reader when the filter does not look inside the entries, else one full pass (within a budget).
  let counts: { sent: number; received: number };
  let totalExact = true;
  // Damaged lines of the whole logs when the cache or the counting pass saw them all; else only those met on the page.
  let wholeDamaged: { sent: number; received: number } | undefined;
  if (sources.knownRows !== undefined && isContentFree(filter)) {
    const known = sources.knownRows();
    counts = { sent: filter.direction === 'received' ? 0 : known.sent, received: filter.direction === 'sent' ? 0 : known.received };
    wholeDamaged = known.damaged;
  } else {
    const counted = countMatching(input, input.maxCountLines ?? ACTIVITY_MAX_COUNT_LINES);
    counts = { sent: counted.sent, received: counted.received };
    totalExact = counted.exact;
    if (counted.exact && filter.sinceMs === undefined) {
      wholeDamaged = counted.damaged;
    }
  }
  const total = counts.sent + counts.received;
  if (offset > 0 && totalExact && offset >= total) {
    throw new ActivityRangeError(lastPageWording(filter, limit, offset, total));
  }

  // 2. The page: read newest first, skip the entries before the window, stop one entry past it.
  const stats: ReadStats = { damaged: 0 };
  const auditStats: ReadStats = { damaged: 0 };
  const seqOf: SeqOf = new WeakMap();
  const meta: AuditLineMeta[] = [];
  const noLines: string[] = [];
  const sentSide = sentStream(filter.direction === 'received' ? noLines : sources.sentLines('page'), filter.sinceMs, stats);
  const auditSide = auditStream(filter.direction === 'sent' ? noLines : sources.auditLines('page'), self, input.nameOf, filter.sinceMs, auditStats, seqOf, meta);
  const names = new Set<string>();
  const items: ActivityEvent[] = [];
  let skipped = 0;
  let more = false;
  for (const event of mergeNewestFirst(sentSide, auditSide)) {
    const other = event.direction === 'sent' ? event.to : event.from;
    if (other.name !== undefined) {
      names.add(other.name);
    }
    if (event.atMs < (filter.sinceMs ?? Number.NEGATIVE_INFINITY)) {
      break;
    }
    if (!matches(event, filter, self.uuid)) {
      continue;
    }
    if (skipped < offset) {
      skipped += 1;
    } else if (items.length < limit) {
      items.push(event);
    } else {
      more = true;
      break;
    }
  }

  // 3. The audit lines read, checked against each other: the events from the first broken line on are flagged.
  const { chain, breakSeq } = checkWindow(meta);
  if (breakSeq !== undefined) {
    for (const e of items) {
      const seq = seqOf.get(e);
      if (seq !== undefined && seq >= breakSeq) {
        e.verified = false;
      }
    }
  }

  const end = offset + items.length;
  const hasMore = totalExact ? end < total : more;
  const pageCount = Math.max(1, Math.ceil(total / limit));
  return {
    items,
    total,
    totalExact,
    offset,
    limit,
    page: Math.floor(offset / limit) + 1,
    pageSize: limit,
    pageCount,
    hasMore,
    ...(hasMore ? { nextOffset: end } : {}),
    counts,
    machines: [...names].sort((a, b) => a.localeCompare(b)),
    chain,
    damaged: wholeDamaged ?? { sent: stats.damaged, received: auditStats.damaged },
  };
}

/** The fields of a query as text: the flags of `machine log`, or the query string of the Activity page. An empty text is "not set". */
export interface ActivityQueryText {
  direction?: string | undefined;
  machine?: string | undefined;
  outcome?: string | undefined;
  since?: string | undefined;
  text?: string | undefined;
  limit?: string | undefined;
  offset?: string | undefined;
  /** 1-based page number, with `pageSize` (25, 50 or 100): the way of the Activity page. `limit` and `offset` are the way of `machine log`. */
  page?: string | undefined;
  pageSize?: string | undefined;
}

const SINCE_FORMS = 'a duration (30m, 2h, 3d) or a local date (2026-11-20 or "2026-11-20 21:30")';
const MAX_FILTER_TEXT = 100;

function parseSinceMs(text: string, nowMs: number): number {
  const duration = /^(\d{1,6})([mhd])$/.exec(text);
  if (duration !== null) {
    const n = Number(duration[1]);
    if (n === 0) {
      throw new Error(`since ${JSON.stringify(text)}: the duration must be at least 1 (${SINCE_FORMS})`);
    }
    return nowMs - n * { m: 60_000, h: 3_600_000, d: 86_400_000 }[duration[2] as 'm' | 'h' | 'd'];
  }
  const date = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(text);
  if (date !== null) {
    const [, y, mo, d, h = '0', mi = '0'] = date;
    const parsed = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), 0);
    if (!Number.isNaN(parsed.getTime()) && parsed.getMonth() === Number(mo) - 1) {
      return parsed.getTime();
    }
  }
  throw new Error(`since ${JSON.stringify(text)} is not understood: use ${SINCE_FORMS}`);
}

function wholeNumber(field: string, text: string, min: number, max: number | undefined): number {
  const n = Number(text);
  if (!/^\d+$/.test(text) || n < min || (max !== undefined && n > max) || !Number.isSafeInteger(n)) {
    throw new Error(`${field} must be a whole number ${max === undefined ? `of at least ${min}` : `from ${min} to ${max}`}, got ${JSON.stringify(text)}`);
  }
  return n;
}

/** A filter from text fields. Throws a message naming the field and what is accepted: nothing is guessed. */
export function parseActivityQuery(q: ActivityQueryText, nowMs: number): ActivityFilter {
  const set = (v: string | undefined): string | undefined => (v === undefined || v === '' ? undefined : v);
  const out: ActivityFilter = {};
  const direction = set(q.direction);
  if (direction !== undefined) {
    if (!(ACTIVITY_DIRECTIONS as readonly string[]).includes(direction)) {
      throw new Error(`direction ${JSON.stringify(direction)} is not a choice: use ${ACTIVITY_DIRECTIONS.join(' or ')}`);
    }
    out.direction = direction as ActivityDirection;
  }
  const machine = set(q.machine);
  if (machine !== undefined) {
    if (machine.length > MAX_FILTER_TEXT) {
      throw new Error(`machine is longer than ${MAX_FILTER_TEXT} characters: give a machine name or the start of its uuid`);
    }
    out.machine = machine;
  }
  const outcome = set(q.outcome);
  if (outcome !== undefined) {
    if (!(ACTIVITY_OUTCOMES as readonly string[]).includes(outcome)) {
      throw new Error(`outcome ${JSON.stringify(outcome)} is not a choice: use ${ACTIVITY_OUTCOMES.join(', ')}`);
    }
    out.outcome = outcome;
  }
  const since = set(q.since);
  if (since !== undefined) {
    out.sinceMs = parseSinceMs(since, nowMs);
  }
  const text = set(q.text);
  if (text !== undefined) {
    if (text.length > MAX_FILTER_TEXT) {
      throw new Error(`text is longer than ${MAX_FILTER_TEXT} characters: search for a shorter word`);
    }
    out.text = text;
  }
  const limit = set(q.limit);
  const offset = set(q.offset);
  const page = set(q.page);
  const pageSize = set(q.pageSize);
  if (limit !== undefined) {
    out.limit = wholeNumber('limit', limit, 1, ACTIVITY_MAX_LIMIT);
  }
  if (offset !== undefined) {
    out.offset = wholeNumber('offset', offset, 0, undefined);
  }
  if (page !== undefined || pageSize !== undefined) {
    if (pageSize !== undefined && limit !== undefined) {
      throw new Error('pageSize and limit contradict each other: give one of them (pageSize is 25, 50 or 100)');
    }
    if (page !== undefined && offset !== undefined) {
      throw new Error('page and offset contradict each other: give one of them');
    }
    let size: number = ACTIVITY_DEFAULT_PAGE_SIZE;
    if (pageSize !== undefined) {
      size = Number(pageSize);
      if (!(ACTIVITY_PAGE_SIZES as readonly number[]).includes(size) || !/^\d+$/.test(pageSize)) {
        throw new Error(`pageSize must be ${ACTIVITY_PAGE_SIZES.slice(0, -1).join(', ')} or ${ACTIVITY_PAGE_SIZES[ACTIVITY_PAGE_SIZES.length - 1] as number}, got ${JSON.stringify(pageSize)}`);
      }
    } else if (out.limit !== undefined) {
      size = out.limit;
    }
    out.limit = size;
    if (page !== undefined) {
      const number = wholeNumber('page', page, 1, undefined);
      out.offset = (number - 1) * size;
      out.page = number;
    } else if (offset === undefined) {
      out.offset = 0;
      out.page = 1;
    }
  }
  return out;
}
