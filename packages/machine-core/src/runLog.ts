import { NO_DENY_REASON_MESSAGE } from './hold.js';
import type { RunWait } from './runDefaults.js';

// The OUTGOING run log (run-log.md): what THIS machine asked its peers to run, one JSON line per `machine run`. Pure: it builds and reads the
// lines, the files (location, rotation, modes) are machine-cli's. The command is stored as typed, so it must never carry a secret (the same rule
// as the allow list); the environment, the passphrase and the output of the command are never part of an entry.

/** Longest command stored, in characters; a longer one is cut and flagged `truncated`. */
export const RUN_LOG_MAX_COMMAND = 2048;
/** A line, newline included, never exceeds this many bytes: one `write` of it is appended whole even by two processes at once. */
export const RUN_LOG_MAX_LINE = 4096;
const MAX_CAUSE = 300;
const MAX_NAME = 100;

export const RUN_LOG_OUTCOMES = ['ran', 'refused', 'denied', 'deadline', 'timeout', 'connection-lost', 'error'] as const;
export type RunLogOutcomeKind = (typeof RUN_LOG_OUTCOMES)[number];
export type RunLogWaitMode = 'default' | 'flag' | 'setting';

export interface RunLogMachine {
  name: string;
  uuid: string;
}

/** How a run ended, as recorded. `ran` says the command was executed (its exit code may still be non-zero); every other outcome ran nothing. */
export interface RunLogOutcome {
  outcome: RunLogOutcomeKind;
  /** `ran`: the exit code of the command, null when it was killed. */
  exitCode?: number | null;
  /** `ran`: the target stopped the command at its time limit. */
  timedOut?: boolean;
  /** Refusals: the reason the target gave (`not-listed`, `denied`, ...). */
  reason?: string;
  /** `error`: what failed, bounded printable ASCII. */
  cause?: string;
}

export interface RunLogInput {
  /** Epoch milliseconds. */
  now: number;
  runId: string;
  from: RunLogMachine;
  to: RunLogMachine;
  shell: string;
  command: string;
  waitMode: RunLogWaitMode;
  onRefusal: 'wait' | 'fail';
  /** The wait asked for (only when `onRefusal` is `wait`). */
  waitSeconds?: number;
  /** Time before the answer, the run time of the command itself excluded; 0 when no wait was asked. */
  waitedSeconds: number;
  outcome: RunLogOutcome;
  /** The whole run, connection and wait included. */
  durationMs: number;
  /** `ran` only: the run time of the command on the target, as the target measured it (the `durationMs` of its result). */
  execMs?: number;
}

export interface RunLogEntry {
  v: 1;
  /** ISO 8601, UTC. */
  ts: string;
  runId: string;
  from: RunLogMachine;
  to: RunLogMachine;
  shell: string;
  command: string;
  truncated: boolean;
  waitMode: RunLogWaitMode;
  onRefusal: 'wait' | 'fail';
  waitSeconds?: number;
  waitedSeconds: number;
  outcome: RunLogOutcomeKind;
  exitCode?: number | null;
  timedOut?: boolean;
  reason?: string;
  cause?: string;
  durationMs: number;
  /** Absent in a line written before this field existed, and when no command ran: a reader never invents it (activity.ts derives, and says so). */
  execMs?: number;
}

/** Printable ASCII, bounded: anything else becomes `?` (a cause comes from an error message or from a peer). */
function printableText(value: string, max: number): string {
  const text = value.length > max ? `${value.slice(0, max - 3)}...` : value;
  return text.replace(/[^\x20-\x7e]/g, '?');
}

function requireText(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`run log: ${field} must be a non-empty text, got ${JSON.stringify(value)}`);
  }
  return value;
}

function machineOf(field: string, m: RunLogMachine): RunLogMachine {
  return { name: printableText(requireText(`${field}.name`, m.name), MAX_NAME), uuid: requireText(`${field}.uuid`, m.uuid) };
}

function toEntry(input: RunLogInput, command: string, truncated: boolean): RunLogEntry {
  const o = input.outcome;
  return {
    v: 1,
    ts: new Date(input.now).toISOString(),
    runId: requireText('runId', input.runId),
    from: machineOf('from', input.from),
    to: machineOf('to', input.to),
    shell: printableText(requireText('shell', input.shell), 16),
    command,
    truncated,
    waitMode: input.waitMode,
    onRefusal: input.onRefusal,
    ...(input.waitSeconds !== undefined ? { waitSeconds: input.waitSeconds } : {}),
    waitedSeconds: input.waitedSeconds,
    outcome: o.outcome,
    ...(o.exitCode !== undefined ? { exitCode: o.exitCode } : {}),
    ...(o.timedOut === true ? { timedOut: true } : {}),
    ...(o.reason !== undefined ? { reason: printableText(o.reason, 64) } : {}),
    ...(o.cause !== undefined ? { cause: printableText(o.cause, MAX_CAUSE) } : {}),
    durationMs: input.durationMs,
    ...(o.outcome === 'ran' && input.execMs !== undefined ? { execMs: Math.max(0, Math.round(input.execMs)) } : {}),
  };
}

/**
 * The line to append (newline included). Only the fields of RunLogEntry are written, whatever the input holds. A command longer than
 * RUN_LOG_MAX_COMMAND, or whose JSON form would push the line over RUN_LOG_MAX_LINE bytes, is cut and flagged.
 */
export function buildRunLogLine(input: RunLogInput): string {
  let command = input.command;
  let truncated = false;
  if (command.length > RUN_LOG_MAX_COMMAND) {
    command = command.slice(0, RUN_LOG_MAX_COMMAND);
    truncated = true;
  }
  for (;;) {
    const line = `${JSON.stringify(toEntry(input, command, truncated))}\n`;
    const excess = Buffer.byteLength(line) - RUN_LOG_MAX_LINE;
    if (excess <= 0) {
      return line;
    }
    if (command.length === 0) {
      throw new Error(`run log: an entry without its command is still ${Buffer.byteLength(line)} bytes: shorten the names or the cause`);
    }
    // Each character costs at least one byte: cut at least `excess / 6` (the worst escape, \u0001) and re-measure.
    command = command.slice(0, Math.max(0, command.length - Math.max(1, Math.ceil(excess / 6))));
    truncated = true;
  }
}

/** Where the behaviour of `run` came from: any flag wins, then the machine setting, else the built-in default. */
export function waitModeOf(wait: RunWait): RunLogWaitMode {
  const sources = wait.onRefusal === 'wait' ? [wait.onRefusalSource, wait.secondsSource] : [wait.onRefusalSource];
  if (sources.includes('flag')) {
    return 'flag';
  }
  if (sources.includes('setting')) {
    return 'setting';
  }
  return 'default';
}

/** The refusals of a held request that mean "nobody allowed it before the end of the wait". */
const UNANSWERED_HOLD_REASONS: readonly string[] = ['not-listed', 'no-policy'];

/** What the peer answered, as an outcome. `held` is present when the target held the request. */
export function outcomeOfAnswer(answer: { type: 'result'; exitCode: number | null; timedOut: boolean } | { type: 'refused'; reason: string; message?: string; held?: unknown }): RunLogOutcome {
  if (answer.type === 'result') {
    return { outcome: 'ran', exitCode: answer.exitCode, ...(answer.timedOut ? { timedOut: true } : {}) };
  }
  if (answer.reason === 'denied') {
    // The owner's text is the cause of a Deny; the fixed no-reason sentence says nothing more than the outcome.
    const owner = answer.message !== undefined && answer.message !== NO_DENY_REASON_MESSAGE && answer.message !== '' ? answer.message : undefined;
    return { outcome: 'denied', reason: 'denied', ...(owner !== undefined ? { cause: owner } : {}) };
  }
  if (answer.held !== undefined && UNANSWERED_HOLD_REASONS.includes(answer.reason)) {
    return { outcome: 'deadline', reason: answer.reason };
  }
  return { outcome: 'refused', reason: answer.reason };
}

/** A failure that was thrown instead of answered. */
export function outcomeOfFailure(message: string): RunLogOutcome {
  if (message.startsWith('no answer from the peer within')) {
    return { outcome: 'timeout' };
  }
  if (message === 'connection closed' || message.startsWith('the connection ended while')) {
    return { outcome: 'connection-lost' };
  }
  return { outcome: 'error', cause: message };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isMachine = (v: unknown): v is RunLogMachine => isRecord(v) && typeof v['name'] === 'string' && typeof v['uuid'] === 'string';

function asEntry(raw: unknown): RunLogEntry | undefined {
  if (!isRecord(raw) || raw['v'] !== 1) {
    return undefined;
  }
  if (typeof raw['ts'] !== 'string' || Number.isNaN(Date.parse(raw['ts']))) {
    return undefined;
  }
  if (typeof raw['runId'] !== 'string' || typeof raw['shell'] !== 'string' || typeof raw['command'] !== 'string') {
    return undefined;
  }
  if (!isMachine(raw['from']) || !isMachine(raw['to'])) {
    return undefined;
  }
  if (typeof raw['outcome'] !== 'string' || !(RUN_LOG_OUTCOMES as readonly string[]).includes(raw['outcome'])) {
    return undefined;
  }
  if (typeof raw['durationMs'] !== 'number' || !Number.isFinite(raw['durationMs'])) {
    return undefined;
  }
  if (typeof raw['waitedSeconds'] !== 'number' || (raw['onRefusal'] !== 'wait' && raw['onRefusal'] !== 'fail')) {
    return undefined;
  }
  const waitMode = raw['waitMode'];
  if (waitMode !== 'default' && waitMode !== 'flag' && waitMode !== 'setting') {
    return undefined;
  }
  const exitCode = raw['exitCode'];
  if (exitCode !== undefined && exitCode !== null && typeof exitCode !== 'number') {
    return undefined;
  }
  const execMs = raw['execMs'];
  if (execMs !== undefined && (typeof execMs !== 'number' || !Number.isFinite(execMs) || execMs < 0)) {
    return undefined;
  }
  return {
    v: 1,
    ts: raw['ts'],
    runId: raw['runId'],
    from: { name: raw['from'].name, uuid: raw['from'].uuid },
    to: { name: raw['to'].name, uuid: raw['to'].uuid },
    shell: raw['shell'],
    command: raw['command'],
    truncated: raw['truncated'] === true,
    waitMode,
    onRefusal: raw['onRefusal'],
    ...(typeof raw['waitSeconds'] === 'number' ? { waitSeconds: raw['waitSeconds'] } : {}),
    waitedSeconds: raw['waitedSeconds'],
    outcome: raw['outcome'] as RunLogOutcomeKind,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(raw['timedOut'] === true ? { timedOut: true } : {}),
    ...(typeof raw['reason'] === 'string' ? { reason: printableText(raw['reason'], 64) } : {}),
    ...(typeof raw['cause'] === 'string' ? { cause: printableText(raw['cause'], MAX_CAUSE) } : {}),
    durationMs: raw['durationMs'],
    ...(execMs !== undefined ? { execMs } : {}),
  };
}

/** One line of a log file: an entry, or `damaged` (cut by a crash, edited, newer format). Never throws. */
export function parseRunLogLine(line: string): RunLogEntry | 'damaged' {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return 'damaged';
  }
  return asEntry(raw) ?? 'damaged';
}

/** The entries of one log file, in file order. A line that is not a valid entry is counted, never thrown. */
export function parseRunLogLines(text: string): { entries: RunLogEntry[]; damaged: number } {
  const entries: RunLogEntry[] = [];
  let damaged = 0;
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    const entry = parseRunLogLine(line);
    if (entry === 'damaged') {
      damaged += 1;
    } else {
      entries.push(entry);
    }
  }
  return { entries, damaged };
}
