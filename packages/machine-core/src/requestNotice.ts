import { SHELLS, commandTextProblem, type Shell } from './policy.js';
import { isUuid } from './reference.js';
import { parseCallerAsk, type CallerAsk } from './callerAsk.js';
import { parseWaitingRenewal, type WaitingRenewal } from './requests.js';

// Request notices (request-notices.md, decisions 83 and 84): a target tells a notice recipient that it HOLDS a request, or refused one, so the
// admin page can show it without a passphrase. Information only: a notice grants nothing and runs nothing. Everything here is untrusted input
// from a peer: strict fixed fields, bounded, printable ASCII. No I/O.

export const MAX_NOTICE_FRAME_BYTES = 4096;
export const MAX_NOTICE_COMMAND = 2048;
export const MAX_NOTICES = 200;
export const MAX_NOTICE_AGE_SECONDS = 7 * 86_400;
export const MAX_NOTICES_PER_MINUTE = 30;

export const NOTICE_STATES = ['held', 'refused'] as const;
export type NoticeState = (typeof NOTICE_STATES)[number];
export const NOTICE_OUTCOMES = ['allowed', 'denied', 'deadline', 'disconnected', 'refused', 'revoked'] as const;
export type NoticeOutcome = (typeof NOTICE_OUTCOMES)[number];

export interface RequestNotice {
  type: 'request-notice';
  /** The request id (a UUID made by the caller). */
  id: string;
  /** The machine that asked, as the target names it (uuid and name). The label shown is the SENDER of the notice; these only say who asked there. */
  peer: string;
  peerName: string;
  shell: Shell;
  command: string;
  commandTruncated: boolean;
  state: NoticeState;
  /** Epoch seconds of the target clock when a hold ends by itself; null for a refusal. */
  deadline: number | null;
  /** Epoch seconds of the target clock. */
  ts: number;
  /** Only when the request waits for the renewal of an exhausted or expired entry: which entry, and why. Absent otherwise (older receivers keep reading plain notices). */
  renewal?: WaitingRenewal;
  /** Only when the caller asked something (`--times`, `--for`, `--why`): its wish, shown to the owner as such. An older recipient refuses the frame (unknown field): update it. */
  ask?: CallerAsk;
}

export interface RequestNoticeEnd {
  type: 'request-notice-end';
  id: string;
  outcome: NoticeOutcome;
  ts: number;
}

/** What the recipient keeps: the notice, who sent it (the authenticated machine of the connection) and when it arrived (its own clock). */
export interface StoredNotice extends Omit<RequestNotice, 'type'> {
  machine: string;
  machineName: string;
  receivedAt: number;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const isEpoch = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const FIELDS = ['type', 'id', 'peer', 'peerName', 'shell', 'command', 'commandTruncated', 'state', 'deadline', 'ts'];
const OPTIONAL_FIELDS = ['renewal', 'ask'];
const END_FIELDS = ['type', 'id', 'outcome', 'ts'];

export function buildRequestNotice(input: { id: string; peer: string; peerName: string; shell: Shell; command: string; state: NoticeState; deadline: number | null; now: number; renewal?: WaitingRenewal; ask?: CallerAsk }): RequestNotice {
  const truncated = input.command.length > MAX_NOTICE_COMMAND;
  return {
    type: 'request-notice',
    id: input.id,
    peer: input.peer,
    peerName: input.peerName,
    shell: input.shell,
    command: truncated ? input.command.slice(0, MAX_NOTICE_COMMAND) : input.command,
    commandTruncated: truncated,
    state: input.state,
    deadline: input.deadline,
    ts: input.now,
    ...(input.renewal !== undefined ? { renewal: input.renewal } : {}),
    ...(input.ask !== undefined ? { ask: input.ask } : {}),
  };
}

export function buildRequestNoticeEnd(input: { id: string; outcome: NoticeOutcome; now: number }): RequestNoticeEnd {
  return { type: 'request-notice-end', id: input.id, outcome: input.outcome, ts: input.now };
}

function keysProblem(o: Record<string, unknown>, allowed: string[], what: string, optional: string[] = []): string | undefined {
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key) && !optional.includes(key)) {
      return `${what}: unknown field "${key}"`;
    }
  }
  for (const key of allowed) {
    if (!(key in o)) {
      return `${what}: missing field "${key}"`;
    }
  }
  return undefined;
}

type Fail = { ok: false; message: string };

export function parseRequestNotice(message: unknown): { ok: true; notice: RequestNotice } | Fail {
  const fail = (m: string): Fail => ({ ok: false, message: m });
  if (!isObject(message)) {
    return fail('request-notice: the frame must be an object');
  }
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(message));
  } catch {
    return fail('request-notice: the frame cannot be serialized');
  }
  if (size > MAX_NOTICE_FRAME_BYTES) {
    return fail(`request-notice: ${size} bytes, the limit is ${MAX_NOTICE_FRAME_BYTES}`);
  }
  const problem = keysProblem(message, FIELDS, 'request-notice', OPTIONAL_FIELDS);
  if (problem !== undefined) {
    return fail(problem);
  }
  if (message.type !== 'request-notice') {
    return fail('request-notice: type must be "request-notice"');
  }
  if (typeof message.id !== 'string' || !isUuid(message.id)) {
    return fail('request-notice: id must be a UUID');
  }
  if (typeof message.peer !== 'string' || !isUuid(message.peer)) {
    return fail('request-notice: peer must be a UUID');
  }
  if (typeof message.peerName !== 'string' || !NAME.test(message.peerName)) {
    return fail('request-notice: peerName must be a machine name (letters, digits, "-" and "_", at most 32)');
  }
  if (typeof message.shell !== 'string' || !(SHELLS as readonly string[]).includes(message.shell)) {
    return fail(`request-notice: shell must be one of ${SHELLS.join(', ')}`);
  }
  if (typeof message.command !== 'string') {
    return fail('request-notice: command must be text');
  }
  const commandProblem = commandTextProblem(message.command);
  if (commandProblem !== undefined) {
    return fail(`request-notice: command: ${commandProblem}`);
  }
  if (typeof message.commandTruncated !== 'boolean') {
    return fail('request-notice: commandTruncated must be true or false');
  }
  if (typeof message.state !== 'string' || !(NOTICE_STATES as readonly string[]).includes(message.state)) {
    return fail(`request-notice: state must be one of ${NOTICE_STATES.join(', ')}`);
  }
  if (message.state === 'held' ? !isEpoch(message.deadline) : message.deadline !== null) {
    return fail('request-notice: deadline must be epoch seconds for a held request and null for a refused one');
  }
  if (!isEpoch(message.ts)) {
    return fail('request-notice: ts must be epoch seconds');
  }
  if ('renewal' in message && parseWaitingRenewal(message.renewal) === undefined) {
    return fail('request-notice: renewal is not a valid renewal (reason expired or exhausted, the entry text, typed, own, optional maxCalls, expiresAt and used, a note)');
  }
  if ('ask' in message) {
    const asked = parseCallerAsk(message.ask);
    if (!asked.ok) {
      return fail(`request-notice: ask is not a valid ask (${asked.message})`);
    }
  }
  return { ok: true, notice: message as unknown as RequestNotice };
}

export function parseRequestNoticeEnd(message: unknown): { ok: true; end: RequestNoticeEnd } | Fail {
  const fail = (m: string): Fail => ({ ok: false, message: m });
  if (!isObject(message)) {
    return fail('request-notice-end: the frame must be an object');
  }
  const problem = keysProblem(message, END_FIELDS, 'request-notice-end');
  if (problem !== undefined) {
    return fail(problem);
  }
  if (message.type !== 'request-notice-end') {
    return fail('request-notice-end: type must be "request-notice-end"');
  }
  if (typeof message.id !== 'string' || !isUuid(message.id)) {
    return fail('request-notice-end: id must be a UUID');
  }
  if (typeof message.outcome !== 'string' || !(NOTICE_OUTCOMES as readonly string[]).includes(message.outcome)) {
    return fail(`request-notice-end: outcome must be one of ${NOTICE_OUTCOMES.join(', ')}`);
  }
  if (!isEpoch(message.ts)) {
    return fail('request-notice-end: ts must be epoch seconds');
  }
  return { ok: true, end: message as unknown as RequestNoticeEnd };
}

/** Insert or replace by (machine, id), drop what is older than 7 days, keep the 200 newest. Pure: the caller writes the result. */
export function applyNotice(list: StoredNotice[], incoming: StoredNotice, now: number): StoredNotice[] {
  const kept = list.filter((n) => !(n.machine === incoming.machine && n.id === incoming.id) && now - n.receivedAt <= MAX_NOTICE_AGE_SECONDS);
  kept.push(incoming);
  kept.sort((a, b) => a.receivedAt - b.receivedAt);
  return kept.slice(-MAX_NOTICES);
}

/** The end of a request: its notice is dropped. */
export function endNotice(list: StoredNotice[], machine: string, id: string): StoredNotice[] {
  return list.filter((n) => !(n.machine === machine && n.id === id));
}

/** What a page or a terminal shows: a held notice whose deadline passed is gone (the target answered the caller by itself), newest first. */
export function visibleNotices(list: StoredNotice[], now: number): StoredNotice[] {
  return list.filter((n) => n.state === 'refused' || (n.deadline !== null && n.deadline > now)).sort((a, b) => b.receivedAt - a.receivedAt);
}

/** A held notice whose deadline passed: the target answered the caller by itself (or the end frame was lost). Only a hold expires; a refusal has no deadline. */
export function isNoticeExpired(n: StoredNotice, now: number): boolean {
  return n.state === 'held' && n.deadline !== null && n.deadline <= now;
}

/** The held notices past their deadline with no end notice received, newest first: the Requests page shows them as expired, to dismiss (decision 100). */
export function expiredNotices(list: StoredNotice[], now: number): StoredNotice[] {
  return list.filter((n) => isNoticeExpired(n, now)).sort((a, b) => b.receivedAt - a.receivedAt);
}

/** What a dismiss names: one notice by the machine that reported it and its request id, or every expired one. */
export type DismissSelector = { machine: string; id: string } | { expired: true };

export type DismissResult =
  | { ok: true; list: StoredNotice[]; removed: StoredNotice[] }
  | { ok: false; reason: 'unknown' | 'live' | 'none'; message: string };

/**
 * Dismiss display rows of the notice store (decision 100). Only a refused notice or a held one past its deadline can go: a live hold is a caller waiting, it
 * ends by Allow, Deny or its deadline. Pure: the caller writes `list`. It touches the notices only, never the audit log.
 */
export function dismissNotices(list: StoredNotice[], selector: DismissSelector, now: number): DismissResult {
  if ('expired' in selector) {
    const removed = list.filter((n) => isNoticeExpired(n, now));
    if (removed.length === 0) {
      return { ok: false, reason: 'none', message: 'there is no expired request notice to clear (a held request that is still waiting ends by Allow, Deny or its deadline)' };
    }
    return { ok: true, list: list.filter((n) => !isNoticeExpired(n, now)), removed };
  }
  const found = list.find((n) => n.machine === selector.machine && n.id === selector.id);
  if (found === undefined) {
    return { ok: false, reason: 'unknown', message: `no request notice with the id ${selector.id} from that machine: it is already gone (ended, aged out or dismissed); reload the Requests page` };
  }
  if (found.state === 'held' && !isNoticeExpired(found, now)) {
    return { ok: false, reason: 'live', message: `the request ${selector.id} is still held on ${found.machineName}: a caller is waiting. Deny it, or wait for its deadline; only a refused or expired notice can be dismissed` };
  }
  return { ok: true, list: list.filter((n) => n !== found), removed: [found] };
}
