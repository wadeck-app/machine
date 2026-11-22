import { verifyAuditChain } from './audit.js';
import { askAllowFlags, parseCallerAsk, type CallerAsk } from './callerAsk.js';
import type { Renewal } from './policy.js';

// Reader of the audit log of a machine (T-07, T-21): what the peers asked and what became of it. Pure: it takes the lines of the
// log and the answers of the current policy, and reads no file. The chain is verified first; what follows a break is shown flagged
// (`verified: false`) and never feeds the pending list. Everything shown is printable ASCII and bounded: an old or edited log
// cannot send a control sequence to a terminal or a web page.

export const DEFAULT_PENDING_LIMIT = 100;
export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_LIMIT = 1000;
const MAX_TEXT = 2048;

/** Refusals of a request that the admin (or the owner) could still allow: the command is not on the list, or there is no list. */
const PENDING_REASONS: readonly string[] = ['not-listed', 'no-policy'];

export const HISTORY_KINDS = ['run', 'refused', 'session', 'document'] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

export interface PendingGroup {
  peer: string;
  peerName?: string;
  shell: string;
  command: string;
  count: number;
  /** Epoch seconds. */
  firstSeen: number;
  lastSeen: number;
  /** Reason of the last refusal: `not-listed` or `no-policy`. */
  reason: string;
}

/** The entry a held request waits to have RENEWED (exhausted or expired): the `Renewal` of the refusal, with its words. Local data, shown to the owner only. */
export interface WaitingRenewal extends Renewal {
  /** `entry used 1 of 1 call(s)` or `expired at <instant>`: shown after `renew:`. */
  note: string;
}

const RENEWAL_KEYS = ['reason', 'entry', 'typed', 'own', 'maxCalls', 'expiresAt', 'used', 'note'];
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/**
 * A renewal read from an audit line, a frame or a stored file: strict and bounded, undefined when it is not one (never a partial object). The texts are
 * printable ASCII already or the whole value is refused: nothing a peer or an old log wrote reaches a terminal or a page unchecked.
 */
export function parseWaitingRenewal(raw: unknown): WaitingRenewal | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const r = Object.fromEntries(Object.entries(raw));
  if (Object.keys(r).some((k) => !RENEWAL_KEYS.includes(k))) {
    return undefined;
  }
  if ((r['reason'] !== 'expired' && r['reason'] !== 'exhausted') || typeof r['typed'] !== 'boolean' || typeof r['own'] !== 'boolean') {
    return undefined;
  }
  const printableText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max && /^[ -~]+$/.test(v);
  if (!printableText(r['entry'], MAX_TEXT) || !printableText(r['note'], 200)) {
    return undefined;
  }
  for (const key of ['maxCalls', 'expiresAt', 'used']) {
    if (r[key] !== undefined && !isCount(r[key])) {
      return undefined;
    }
  }
  return {
    reason: r['reason'],
    entry: r['entry'],
    typed: r['typed'],
    own: r['own'],
    note: r['note'],
    ...(r['maxCalls'] !== undefined ? { maxCalls: r['maxCalls'] as number } : {}),
    ...(r['expiresAt'] !== undefined ? { expiresAt: r['expiresAt'] as number } : {}),
    ...(r['used'] !== undefined ? { used: r['used'] as number } : {}),
  };
}

/** A request the target holds right now, waiting for its owner to allow or deny it (`machine run --wait`). Derived from the audit log. */
export interface WaitingRequest {
  /** The id of the request, as `machine requests --deny <id>` takes it. */
  id: string;
  peer: string;
  peerName?: string;
  shell: string;
  command: string;
  /** Epoch seconds. */
  since: number;
  deadline: number;
  /** Present when the request waits for the renewal of an exhausted or expired entry (not for a command that is not listed). */
  renewal?: WaitingRenewal;
  /** What the caller asked the owner for (`machine run --times/--for/--why`): the caller's wish, never a decision. Absent when it asked nothing. */
  ask?: CallerAsk;
}

export interface HistoryEntry {
  /** Epoch seconds. */
  at: number;
  kind: HistoryKind;
  /** The event name of the log (`accepted` for a run, whatever its outcome). */
  event: string;
  /** False after a break of the chain: the entry cannot be trusted. */
  verified: boolean;
  peer?: string;
  peerName?: string;
  shell?: string;
  command?: string;
  id?: string;
  reason?: string;
  /** Refusals: the closest typed entry and the rule that failed (token number and rule, never the value). LOCAL only, never sent to the caller. */
  detail?: string;
  /** Runs: the template of the typed entry that matched, as signed. */
  template?: string;
  /** Hold events: how a hold ended (`allowed`, `denied`, `deadline`, ...) and the owner's text of a Deny. */
  holdOutcome?: string;
  note?: string;
  /** Runs: `completed`, `failed`, or `accepted` (no completion in the log: a crash or a cut). */
  outcome?: string;
  exitCode?: number | null;
  durationMs?: number;
  timedOut?: boolean;
  truncated?: boolean;
  error?: string;
}

export type RequestsChain =
  | { ok: true; entries: number }
  | { ok: false; line: number; message: string; trustedEntries: number; unverifiedEntries: number; unreadableLines: number };

export interface RequestsSummary {
  chain: RequestsChain;
  /** Requests held right now (soonest deadline first): not refused yet, the owner may still allow or deny them. */
  waiting: WaitingRequest[];
  pending: PendingGroup[];
  /** Distinct pending groups before the cap. */
  pendingTotal: number;
  /** Groups left out because the current policy allows them now. */
  allowedNow: number;
  history: HistoryEntry[];
  /** Entries that match the filter before the limit. */
  historyTotal: number;
  /** Verified entries left out because their time or shape is unusable. */
  skipped: number;
}

export interface HistoryFilter {
  /** UUID of the source machine. */
  peer?: string;
  /** Epoch seconds, inclusive. */
  since?: number;
  kinds?: readonly HistoryKind[];
  limit?: number;
}

export interface SummarizeOptions {
  /** Epoch seconds: a held request whose deadline passed is not waiting any more. */
  now: number;
  /** Does the policy in force allow this command for this peer now? (false when there is no policy) */
  isAllowed: (peer: string, shell: string, command: string) => boolean;
  nameOf?: (uuid: string) => string | undefined;
  pendingLimit?: number;
  history?: HistoryFilter;
}

/** Printable ASCII, bounded: anything else becomes `?`. */
export function printable(value: string, max: number = MAX_TEXT): string {
  const text = value.length > max ? `${value.slice(0, max)}...` : value;
  return text.replace(/[^\x20-\x7e]/g, '?');
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? printable(v) : undefined);

interface Parsed {
  entry: Record<string, unknown>;
  verified: boolean;
}

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line) as { entry?: unknown };
    const entry = parsed?.entry;
    return typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? (entry as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function kindOf(event: string): HistoryKind {
  if (event === 'accepted' || event === 'completed' || event === 'failed') return 'run';
  if (event === 'refused') return 'refused';
  if (event.startsWith('document')) return 'document';
  return 'session';
}

export function summarizeRequests(lines: readonly string[], options: SummarizeOptions): RequestsSummary {
  const verification = verifyAuditChain(lines);
  const trusted = verification.ok ? lines.length : verification.line - 1;
  const parsed: Parsed[] = [];
  let unreadable = 0;
  lines.forEach((line, index) => {
    const entry = parseLine(line);
    if (entry === undefined) {
      // A verified line always parses: only the part after a break can be unreadable.
      unreadable += 1;
      return;
    }
    parsed.push({ entry, verified: index < trusted });
  });
  const unverified = parsed.filter((p) => !p.verified).length;
  const chain: RequestsChain = verification.ok
    ? { ok: true, entries: verification.entries }
    : { ok: false, line: verification.line, message: verification.message, trustedEntries: trusted, unverifiedEntries: unverified, unreadableLines: unreadable };

  const nameOf = (uuid: string | undefined): { peerName?: string } => {
    const name = uuid === undefined ? undefined : options.nameOf?.(uuid);
    return name === undefined ? {} : { peerName: printable(name, 100) };
  };

  const heldById = new Map<string, WaitingRequest>();
  const endedHolds = new Set<string>();
  const groups = new Map<string, PendingGroup>();
  const rows: HistoryEntry[] = [];
  const runById = new Map<string, HistoryEntry>();
  let skipped = 0;

  for (const { entry, verified } of parsed) {
    const event = str(entry['event']);
    const ts = typeof entry['ts'] === 'string' ? Date.parse(entry['ts']) : Number.NaN;
    if (event === undefined || Number.isNaN(ts)) {
      if (verified) skipped += 1;
      continue;
    }
    const at = Math.floor(ts / 1000);
    const kind = kindOf(event);
    const peer = str(entry['source']);
    const shell = str(entry['shell']);
    const command = str(entry['command']);
    const id = str(entry['id']);
    const reason = str(entry['reason']);

    if (verified && event === 'daemon-started') {
      // A restart ends every hold (they live in memory): what was held before it is not waiting any more.
      heldById.clear();
    }
    if (verified && event === 'held') {
      const deadline = entry['deadline'];
      if (id !== undefined && peer !== undefined && shell !== undefined && command !== undefined && typeof deadline === 'number' && Number.isFinite(deadline)) {
        const renewal = parseWaitingRenewal(entry['renewal']);
        // An ask that is not valid (an edited line) is dropped, the request is still listed: the target wrote only valid ones.
        const asked = entry['ask'] === undefined ? undefined : parseCallerAsk(entry['ask']);
        heldById.set(id, { id, peer, ...nameOf(peer), shell, command, since: at, deadline, ...(renewal !== undefined ? { renewal } : {}), ...(asked?.ok === true ? { ask: asked.ask } : {}) });
      } else skipped += 1;
    }
    if (verified && event === 'hold-ended' && id !== undefined) {
      endedHolds.add(id);
    }

    if (event === 'completed' || event === 'failed') {
      const row = id === undefined ? undefined : runById.get(id);
      if (row !== undefined) {
        row.outcome = event;
        if (event === 'completed') {
          if (typeof entry['exitCode'] === 'number' || entry['exitCode'] === null) row.exitCode = entry['exitCode'];
          if (typeof entry['durationMs'] === 'number') row.durationMs = entry['durationMs'];
          if (typeof entry['timedOut'] === 'boolean') row.timedOut = entry['timedOut'];
          if (typeof entry['truncated'] === 'boolean') row.truncated = entry['truncated'];
        } else {
          const error = str(entry['error']);
          if (error !== undefined) row.error = error;
        }
        continue;
      }
    }

    const row: HistoryEntry = {
      at,
      kind,
      event,
      verified,
      ...(peer !== undefined ? { peer, ...nameOf(peer) } : {}),
      ...(shell !== undefined ? { shell } : {}),
      ...(command !== undefined ? { command } : {}),
      ...(id !== undefined ? { id } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...(str(entry['detail']) !== undefined ? { detail: str(entry['detail']) as string } : {}),
      ...(str(entry['template']) !== undefined ? { template: str(entry['template']) as string } : {}),
    };
    if (event === 'hold-ended') {
      const outcome = str(entry['outcome']);
      if (outcome !== undefined) {
        row.holdOutcome = outcome;
      }
      const note = str(entry['note']);
      if (note !== undefined) {
        row.note = note;
      }
    }
    if (event === 'accepted') {
      row.outcome = 'accepted';
      if (id !== undefined) runById.set(id, row);
    } else if (kind === 'run') {
      // A completion whose acceptance is not in the log (cut at the head): shown on its own.
      row.outcome = event;
      if (typeof entry['exitCode'] === 'number' || entry['exitCode'] === null) row.exitCode = entry['exitCode'] as number | null;
      if (typeof entry['durationMs'] === 'number') row.durationMs = entry['durationMs'];
      const error = str(entry['error']);
      if (error !== undefined) row.error = error;
    }
    rows.push(row);

    if (verified && event === 'refused' && reason !== undefined && PENDING_REASONS.includes(reason) && peer !== undefined && shell !== undefined && command !== undefined) {
      const key = `${peer}\u0000${shell}\u0000${command}`;
      const group = groups.get(key);
      if (group === undefined) groups.set(key, { peer, ...nameOf(peer), shell, command, count: 1, firstSeen: at, lastSeen: at, reason });
      else {
        group.count += 1;
        group.firstSeen = Math.min(group.firstSeen, at);
        group.lastSeen = Math.max(group.lastSeen, at);
        group.reason = reason;
      }
    }
  }

  let allowedNow = 0;
  const open = [...groups.values()].filter((g) => {
    if (!options.isAllowed(g.peer, g.shell, g.command)) return true;
    allowedNow += 1;
    return false;
  });
  // Newest first; the sort is stable, so equal times keep the order of the log.
  open.sort((a, b) => b.lastSeen - a.lastSeen);

  const filter = options.history ?? {};
  const matching = rows.filter(
    (h) => (filter.peer === undefined || h.peer === filter.peer) && (filter.since === undefined || h.at >= filter.since) && (filter.kinds === undefined || filter.kinds.includes(h.kind)),
  );
  const limit = filter.limit ?? DEFAULT_HISTORY_LIMIT;

  const waiting = [...heldById.values()].filter((w) => !endedHolds.has(w.id) && w.deadline > options.now).sort((a, b) => a.deadline - b.deadline);

  return {
    chain,
    waiting,
    pending: open.slice(0, options.pendingLimit ?? DEFAULT_PENDING_LIMIT),
    pendingTotal: open.length,
    allowedNow,
    history: limit >= matching.length ? matching : matching.slice(matching.length - limit),
    historyTotal: matching.length,
    skipped,
  };
}

/** The command as the admin would type it after `--` (one argument). Best effort for a POSIX shell, shown as a suggestion only. */
export function shellQuote(command: string): string {
  if (/^[A-Za-z0-9_\-./:=@%+,]+$/.test(command)) return command;
  if (!/["$`\\]/.test(command)) return `"${command}"`;
  if (!command.includes("'")) return `'${command}'`;
  return `"${command.replace(/(["$`\\])/g, '\\$1')}"`;
}

/**
 * The command that allows a pending request: `machine admin allow <machine> ...` (mode admin, run on the admin machine) or
 * `machine policy allow ...` (mode local, run ON that machine).
 */
export function allowCommand(group: Pick<PendingGroup, 'shell' | 'command'> & { renewal?: WaitingRenewal; ask?: CallerAsk }, machine: { name: string; policyMode: 'admin' | 'local' }): string {
  const { renewal } = group;
  // A renewal replaces the entry that exists: its text (the template of a typed entry), `--renew` (the counter starts again even with the same limits)
  // and the limits it had (an expired entry cannot give its duration back: the owner writes it).
  // The ask of the caller is a SUGGESTION in the command the owner edits and runs (`--times n` / `--for d`; permanent adds nothing); it wins over the previous limits of a renewal.
  const asked = askAllowFlags(group.ask);
  const limits = asked !== '' ? asked : renewal === undefined ? '' : renewal.maxCalls !== undefined && renewal.reason === 'exhausted' ? ` --times ${renewal.maxCalls}` : ' --for <duration>';
  const tail = `${renewal === undefined ? '' : '--renew '}--shell ${group.shell}${limits} -- ${shellQuote(renewal === undefined ? group.command : renewal.entry)}`;
  return machine.policyMode === 'local' ? `machine policy allow ${tail}` : `machine admin allow ${machine.name} ${tail}`;
}

/** One line about a history entry (without its time, peer and kind): `sh "ls" -> exit 0 in 1.5 s`, `(not-listed) sh "ls"`, `session-closed (too-many-refusals)`. */
export function describeHistory(h: HistoryEntry): string {
  switch (h.kind) {
    case 'run': {
      const call = `${h.shell ?? '?'} "${h.command ?? '?'}"`;
      const typed = h.template !== undefined ? ` [typed: ${h.template}]` : '';
      if (h.outcome === 'completed') {
        const exit = h.exitCode === null || h.exitCode === undefined ? 'none' : String(h.exitCode);
        return `${call} -> exit ${exit}${h.timedOut ? ' (timed out)' : ''}${h.durationMs !== undefined ? ` in ${(h.durationMs / 1000).toFixed(1)} s` : ''}${typed}`;
      }
      if (h.outcome === 'failed') {
        return `${call} -> could not run${h.error !== undefined ? `: ${h.error}` : ''}${typed}`;
      }
      return `${call} -> accepted, no completion in the log (crash or cut)${typed}`;
    }
    case 'refused':
      return `(${h.reason ?? 'unknown reason'})${h.shell !== undefined ? ` ${h.shell} "${h.command ?? '?'}"` : ''}${h.detail !== undefined ? `: ${h.detail}` : ''}`;
    case 'session':
      if (h.event === 'held') {
        return `held ${h.shell ?? '?'} "${h.command ?? '?'}" waiting for approval`;
      }
      if (h.event === 'hold-ended') {
        return `hold ended: ${h.holdOutcome ?? 'unknown'}${h.note !== undefined ? ` (${h.note})` : ''}${h.command !== undefined ? ` ${h.shell ?? '?'} "${h.command}"` : ''}`;
      }
      return `${h.event}${h.reason !== undefined ? ` (${h.reason})` : ''}`;
    default:
      return `${h.event}${h.reason !== undefined ? ` (${h.reason})` : ''}`;
  }
}
