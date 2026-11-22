// Hold of a refused request (`machine run --wait`, spec hold-for-approval.md): the table of the requests a target keeps open while its owner
// decides, and the pure helpers around it. A hold changes WHEN a refusal is answered, never WHAT is allowed: nothing here authorizes a command
// (hard rules 3 and 4); the peer service runs the same `authorize` as for a fresh request when the policy changes. No I/O, no clock: time is an
// argument (epoch seconds).

import type { WaitingRenewal } from './requests.js';

/** Shortest and longest wait a caller may ask for (CLI limits). */
export const MIN_WAIT_SECONDS = 10;
export const MAX_WAIT_SECONDS = 3600;
/** The target bounds the wait the caller chose (default 30 min). */
export const DEFAULT_TARGET_WAIT_CAP_SECONDS = 1800;
/** Requests this machine holds per calling peer and in all, unless its owner set other limits (`machine hold-limits`, holdLimits.ts). */
export const DEFAULT_HELD_PER_PEER = 5;
export const DEFAULT_HELD_PER_MACHINE = 10;
/** The highest values the owner may set: raising a limit only lets an authenticated peer leave more requests open, so it is bounded. */
export const MAX_HELD_PER_PEER_SETTING = 20;
export const MAX_HELD_PER_MACHINE_SETTING = 50;
/** Longest command text of a refusal that lists the held requests of the caller. */
const LISTED_COMMAND_LENGTH = 60;
/** The caller waits for the wait, then for a command that was just allowed to run, plus this margin for the network and the output. */
export const HOLD_ANSWER_MARGIN_MS = 30_000;
/** The caller prints a progress line this often. */
export const PROGRESS_INTERVAL_SECONDS = 30;
/** Longest owner text of a Deny, shown to the agent. */
export const MAX_DENY_REASON_LENGTH = 200;
/** A Deny names a hold by its id or by a unique prefix of at least this length. */
export const MIN_ID_PREFIX = 6;

const WAIT_RANGE = `${describeSeconds(MIN_WAIT_SECONDS).replace('s', ' s')} to ${MAX_WAIT_SECONDS / 60} min`;

/** `--wait 10m`: a whole number and a unit (s, m, h), from 10 s to 60 min. Throws a message that names the fix. */
export function parseWait(text: string): number {
  const match = /^(\d+)([a-z]*)$/.exec(text.trim());
  if (match === null || match[1] === undefined) {
    throw new Error(`--wait ${JSON.stringify(text)} is not a duration: use a whole number and a unit, for example 90s, 10m or 1h (${WAIT_RANGE})`);
  }
  const unit = match[2] ?? '';
  if (unit === '') {
    throw new Error(`--wait ${text} has no unit: write ${text}s, ${text}m or ${text}h (${WAIT_RANGE})`);
  }
  const factor = { s: 1, m: 60, h: 3600 }[unit as 's' | 'm' | 'h'];
  if (factor === undefined) {
    throw new Error(`--wait ${JSON.stringify(text)}: the unit "${unit}" is unknown, use s, m or h, for example 10m (${WAIT_RANGE})`);
  }
  const seconds = Number(match[1]) * factor;
  if (seconds < MIN_WAIT_SECONDS || seconds > MAX_WAIT_SECONDS) {
    throw new Error(`--wait ${text} is outside ${WAIT_RANGE}: the owner needs time to read the request, and a longer hold keeps a connection and a slot of the target open`);
  }
  return seconds;
}

/** The target bounds the wait: above its maximum the wait is capped, and the answer says so. */
export function capWait(requestedSeconds: number, capSeconds: number): { seconds: number; capped: boolean } {
  return requestedSeconds > capSeconds ? { seconds: capSeconds, capped: true } : { seconds: requestedSeconds, capped: false };
}

/** `10m`, `1h`, `90s`: the biggest unit that divides exactly. */
export function describeSeconds(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) {
    return `${seconds / 3600}h`;
  }
  if (seconds >= 60 && seconds % 60 === 0) {
    return `${seconds / 60}m`;
  }
  return `${seconds}s`;
}

/** The sentence of the refusal when the deadline passed. */
export function waitedText(waitSeconds: number, capped: boolean, requestedSeconds?: number): string {
  const base = `waited ${describeSeconds(waitSeconds)}, nobody answered`;
  if (!capped) {
    return base;
  }
  return `${base} (the wait was capped by this machine to ${describeSeconds(waitSeconds)}${requestedSeconds !== undefined ? `, you asked for ${describeSeconds(requestedSeconds)}` : ''}: its maximum)`;
}

/** What the caller is told when the owner denied without a reason; `machine run` prints it as `refused by <machine>: <this>`. */
export const NO_DENY_REASON_MESSAGE = 'denied by the owner, no reason given';

/** The message of the `denied` refusal: the owner's text as typed (already checked by checkDenyReason), or the fixed sentence. */
export function deniedMessage(reason: string | undefined): string {
  return reason !== undefined ? reason : NO_DENY_REASON_MESSAGE;
}

export type DenyReasonCheck = { ok: true; reason: string | undefined } | { ok: false; message: string };

/** The owner's text of a Deny reaches the agent and the audit log: printable ASCII, bounded, no secret by contract (it is typed by the owner). */
export function checkDenyReason(text: string | undefined): DenyReasonCheck {
  if (text === undefined) {
    return { ok: true, reason: undefined };
  }
  const trimmed = text.trim();
  if (trimmed === '') {
    return { ok: true, reason: undefined };
  }
  if (trimmed.length > MAX_DENY_REASON_LENGTH) {
    return { ok: false, message: `the reason has ${trimmed.length} characters: at most ${MAX_DENY_REASON_LENGTH} (the agent reads it); shorten it` };
  }
  if (!/^[\x20-\x7e]+$/.test(trimmed)) {
    return { ok: false, message: 'the reason must be printable ASCII (no accent, no line break): the agent reads it and the audit log keeps it; rewrite it' };
  }
  return { ok: true, reason: trimmed };
}

export interface Hold {
  id: string;
  peer: string;
  shell: string;
  command: string;
  /** Epoch seconds. */
  since: number;
  deadline: number;
  /** The wait applied (after the cap) and the wait the caller asked for. */
  waitSeconds: number;
  requestedSeconds: number;
  capped: boolean;
  /** The request waits for the renewal of an exhausted or expired entry: the same hold, the same limits, only the words differ. */
  renewal?: WaitingRenewal;
}

export interface HoldLimits {
  perPeer?: number;
  perMachine?: number;
}

/** A fixed pair, or a function read at each admission (the daemon: the setting file of the owner, no restart needed). */
export type HoldLimitsSource = HoldLimits | (() => HoldLimits);

function shortCommand(command: string): string {
  const one = command.replace(/\s+/g, ' ').trim();
  return one.length > LISTED_COMMAND_LENGTH ? `${one.slice(0, LISTED_COMMAND_LENGTH - 3)}...` : one;
}

export type AdmitResult = { ok: true; hold: Hold } | { ok: false; reason: 'hold-limit-peer' | 'hold-limit-machine'; message: string };
export type DenyResult = { ok: true; hold: Hold } | { ok: false; reason: 'unknown' | 'ambiguous' | 'too-short' | 'bad-reason'; message: string };
export type HoldCheck = { state: 'waiting' } | { state: 'deadline' } | { state: 'denied'; reason?: string } | { state: 'gone' };

/** The holds of one daemon, in memory (nothing persists: a restart ends them all). */
export class HoldTable {
  private readonly holds = new Map<string, Hold>();
  private readonly denials = new Map<string, { reason?: string }>();
  private readonly limits: () => HoldLimits;

  constructor(limits: HoldLimitsSource = {}) {
    this.limits = typeof limits === 'function' ? limits : () => limits;
  }

  admit(input: { id: string; peer: string; shell: string; command: string; now: number; requestedSeconds: number; capSeconds: number; renewal?: WaitingRenewal }): AdmitResult {
    const limits = this.limits();
    const perPeer = limits.perPeer ?? DEFAULT_HELD_PER_PEER;
    const perMachine = limits.perMachine ?? DEFAULT_HELD_PER_MACHINE;
    const all = [...this.holds.values()];
    const mine = all.filter((h) => h.peer === input.peer);
    if (mine.length >= perPeer) {
      const slots = mine.map((h) => `${h.id.slice(0, MIN_ID_PREFIX)} ${shortCommand(h.command)}`).join('; ');
      return {
        ok: false,
        reason: 'hold-limit-peer',
        message: `this machine already holds ${perPeer} requests of yours waiting for approval (the limit per peer; its owner can change it with \`machine hold-limits --per-peer <n>\` on that machine): ${slots}. Wait for their answer, or ask its owner to allow or deny them (\`machine requests\` lists them, \`machine requests --deny <id>\` refuses one), then retry`,
      };
    }
    if (all.length >= perMachine) {
      return { ok: false, reason: 'hold-limit-machine', message: `this machine already holds ${perMachine} requests waiting for approval (the limit per machine; its owner can change it with \`machine hold-limits --per-machine <n>\` on that machine): retry later, or ask its owner to allow or deny them (\`machine requests\`)` };
    }
    const wait = capWait(input.requestedSeconds, input.capSeconds);
    const hold: Hold = {
      id: input.id,
      peer: input.peer,
      shell: input.shell,
      command: input.command,
      since: input.now,
      deadline: input.now + wait.seconds,
      waitSeconds: wait.seconds,
      requestedSeconds: input.requestedSeconds,
      capped: wait.capped,
      ...(input.renewal !== undefined ? { renewal: input.renewal } : {}),
    };
    this.holds.set(hold.id, hold);
    return { ok: true, hold };
  }

  get(id: string): Hold | undefined {
    return this.holds.get(id);
  }

  list(): Hold[] {
    return [...this.holds.values()];
  }

  /** The hold is over (answered, denied, expired, dropped): its slot is free. */
  end(id: string): void {
    this.holds.delete(id);
    this.denials.delete(id);
  }

  /** A Deny by the owner (restricting, unsigned, hard rule 4). The id may be a unique prefix. The first Deny of a hold wins. */
  deny(idOrPrefix: string, reasonText: string | undefined): DenyResult {
    const checked = checkDenyReason(reasonText);
    if (!checked.ok) {
      return { ok: false, reason: 'bad-reason', message: checked.message };
    }
    let hold = this.holds.get(idOrPrefix);
    if (hold === undefined) {
      const matches = [...this.holds.values()].filter((h) => h.id.startsWith(idOrPrefix));
      if (idOrPrefix.length < MIN_ID_PREFIX && matches.length > 0) {
        return { ok: false, reason: 'too-short', message: `"${idOrPrefix}" is too short to name a waiting request: give at least ${MIN_ID_PREFIX} characters of its id (\`machine requests\` lists them)` };
      }
      if (matches.length > 1) {
        return { ok: false, reason: 'ambiguous', message: `"${idOrPrefix}" matches ${matches.length} waiting requests: give more characters of the id (\`machine requests\` lists them)` };
      }
      hold = matches[0];
    }
    if (hold === undefined) {
      return { ok: false, reason: 'unknown', message: `no request is waiting under the id "${idOrPrefix}": it may have been answered, expired or dropped already; \`machine requests\` lists the requests waiting now with their id` };
    }
    if (!this.denials.has(hold.id)) {
      this.denials.set(hold.id, checked.reason === undefined ? {} : { reason: checked.reason });
    }
    return { ok: true, hold };
  }

  check(id: string, now: number): HoldCheck {
    const hold = this.holds.get(id);
    if (hold === undefined) {
      return { state: 'gone' };
    }
    const denial = this.denials.get(id);
    if (denial !== undefined) {
      return denial.reason === undefined ? { state: 'denied' } : { state: 'denied', reason: denial.reason };
    }
    return now >= hold.deadline ? { state: 'deadline' } : { state: 'waiting' };
  }
}

/** How long the caller waits for the answer: the hold, then the command it may trigger, plus the margin. Without a wait: unchanged. */
export function holdAnswerTimeoutMs(waitSeconds: number, runTimeoutMs: number): number {
  return waitSeconds * 1000 + runTimeoutMs + HOLD_ANSWER_MARGIN_MS;
}

/**
 * The progress lines of a wait: the tick is every 30 s but the text changes once a minute, so a line identical to the previous one is
 * NOT returned (undefined): the caller prints nothing.
 */
export function progressPrinter(machineName: string): (secondsLeft: number) => string | undefined {
  let last: string | undefined;
  return secondsLeft => {
    const line = progressText(machineName, secondsLeft);
    if (line === last) {
      return undefined;
    }
    last = line;
    return line;
  };
}

/** The progress line the caller prints every 30 s. */
export function progressText(machineName: string, secondsLeft: number): string {
  const left = secondsLeft >= 60 ? `${Math.ceil(secondsLeft / 60)} min` : `${Math.max(0, Math.ceil(secondsLeft))} s`;
  return `waiting for ${machineName} to allow it (${left} left)`;
}
