import { printable, summarizeRequests, type HistoryEntry, type RequestsChain } from './requests.js';
import type { RunLogEntry } from './runLog.js';

// The Activity timeline (run-log.md): the commands THIS machine sent (its outgoing run log) and received (its audit log) in one list, newest
// first, filtered and paginated. Pure: the caller reads the files. Every text shown is printable ASCII and bounded: an old or edited log cannot
// send a control sequence to a terminal or a web page.

export const ACTIVITY_DEFAULT_LIMIT = 50;
export const ACTIVITY_MAX_LIMIT = 500;
export const ACTIVITY_DIRECTIONS = ['sent', 'received'] as const;
export type ActivityDirection = (typeof ACTIVITY_DIRECTIONS)[number];
/** The outcomes of the run log, and `unfinished`: a received command accepted whose completion is not in the log (a crash or a cut). */
export const ACTIVITY_OUTCOMES = ['ran', 'refused', 'denied', 'deadline', 'timeout', 'connection-lost', 'error', 'unfinished'] as const;

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
  durationMs?: number;
  /** Sent: the command was cut in the log. */
  truncated?: boolean;
  /** Sent: how long the caller waited for the answer, in seconds. */
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
}

export interface ActivityPage {
  /** The requested window, newest first. */
  items: ActivityEvent[];
  /** Entries that match the filter, before the window. */
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset?: number;
  /** Sent and received among the `total` entries. */
  counts: { sent: number; received: number };
  /** The other machines seen in either log, by name, sorted: the choices of a machine filter. */
  machines: string[];
  /** State of the audit chain of this machine (a break is shown, never hidden). Absent when there is no audit log. */
  chain: RequestsChain | undefined;
}

export interface ActivityInput {
  self: { uuid: string; name: string };
  /** The outgoing run log, any order. */
  sent: readonly RunLogEntry[];
  /** The lines of this machine's audit log, in order. */
  auditLines: readonly string[];
  nameOf: (uuid: string) => string | undefined;
  filter: ActivityFilter;
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

const clean = (text: string | undefined, max = 2048): string | undefined => (text === undefined ? undefined : printable(text, max));

function sentEvent(e: RunLogEntry): ActivityEvent {
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
    ...(e.truncated ? { truncated: true } : {}),
    waitedSeconds: e.waitedSeconds,
    verified: true,
  };
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

export function buildActivity(input: ActivityInput): ActivityPage {
  const { self, filter } = input;
  const limit = checkRange('limit', filter.limit, 1, ACTIVITY_MAX_LIMIT) ?? ACTIVITY_DEFAULT_LIMIT;
  const offset = checkRange('offset', filter.offset, 0, undefined) ?? 0;

  const events: ActivityEvent[] = input.sent.map(sentEvent);

  let chain: RequestsChain | undefined;
  if (input.auditLines.length > 0) {
    const summary = summarizeRequests(input.auditLines, { now: 0, isAllowed: () => false, nameOf: input.nameOf, history: { kinds: ['run', 'refused'], limit: Number.MAX_SAFE_INTEGER } });
    chain = summary.chain;
    for (const h of summary.history) {
      const peerName = h.peerName ?? (h.peer !== undefined ? input.nameOf(h.peer) : undefined);
      const outcome = receivedOutcome(h);
      events.push({
        ts: new Date(h.at * 1000).toISOString(),
        atMs: h.at * 1000,
        direction: 'received',
        from: { ...(h.peer !== undefined ? { uuid: h.peer } : {}), ...(peerName !== undefined ? { name: clean(peerName, 100) as string } : {}) },
        to: { uuid: self.uuid, name: clean(self.name, 100) as string },
        shell: h.shell ?? '',
        command: h.command ?? '',
        outcome,
        ...(h.id !== undefined ? { id: h.id } : {}),
        ...(outcome === 'ran' && h.exitCode !== undefined ? { exitCode: h.exitCode } : {}),
        ...(h.timedOut === true ? { timedOut: true } : {}),
        ...(h.kind === 'refused' && h.reason !== undefined ? { reason: h.reason } : {}),
        ...(h.error !== undefined ? { cause: h.error } : {}),
        ...(h.durationMs !== undefined ? { durationMs: h.durationMs } : {}),
        verified: h.verified,
      });
    }
  }

  const names = new Set<string>();
  for (const e of events) {
    const other = e.direction === 'sent' ? e.to : e.from;
    if (other.name !== undefined) {
      names.add(other.name);
    }
  }

  // Newest first; the sort is stable, so equal times keep a sent run before a received one of the same instant.
  const matching = events.filter((e) => matches(e, filter, self.uuid)).sort((a, b) => b.atMs - a.atMs);
  const items = matching.slice(offset, offset + limit);
  const end = offset + items.length;
  return {
    items,
    total: matching.length,
    offset,
    limit,
    hasMore: end < matching.length,
    ...(end < matching.length ? { nextOffset: end } : {}),
    counts: { sent: matching.filter((e) => e.direction === 'sent').length, received: matching.filter((e) => e.direction === 'received').length },
    machines: [...names].sort((a, b) => a.localeCompare(b)),
    chain,
  };
}

/** The outcome of a received entry of the audit log: what the owner's machine did with the request. */
function receivedOutcome(h: HistoryEntry): string {
  if (h.kind === 'refused') {
    return h.reason === 'denied' ? 'denied' : 'refused';
  }
  if (h.outcome === 'completed') {
    return 'ran';
  }
  return h.outcome === 'failed' ? 'error' : 'unfinished';
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
  if (!/^\d+$/.test(text) || n < min || (max !== undefined && n > max)) {
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
  if (limit !== undefined) {
    out.limit = wholeNumber('limit', limit, 1, ACTIVITY_MAX_LIMIT);
  }
  const offset = set(q.offset);
  if (offset !== undefined) {
    out.offset = wholeNumber('offset', offset, 0, undefined);
  }
  return out;
}
