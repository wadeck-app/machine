import { MAX_LIFETIME_SECONDS, MAX_TIMES, parseLifetime } from './lifetime.js';
import { durationSeconds } from './typedParams.js';

// What the CALLER of `machine run` asks for its held request (decision 96, hold-for-approval.md "Caller's ask"): a number of calls, a duration or
// `permanent`, and a short reason. UNTRUSTED text and numbers that travel in the signed request body and only PRE-FILL the owner's Allow: they grant
// nothing, the owner always edits and signs. What is out of range is refused by the target at once, never clamped. Pure, no I/O.

export interface CallerAsk {
  /** Calls asked for (`--times`), 1 to MAX_TIMES. */
  times?: number;
  /** `permanent`, or a duration like `30m` (`--for`), at most 365 days. Never together with `times`. */
  for?: string;
  /** Why, printable ASCII, 1 to MAX_ASK_WHY characters (`--why`). */
  why?: string;
}

export const MAX_ASK_WHY = 200;
/** The owner sees an ask as a risk from this many calls, or this long a duration: a warning line says it was the caller's wish. */
export const ASK_LARGE_TIMES = 50;
export const ASK_LONG_SECONDS = 7 * 24 * 3600;

const KEYS = ['times', 'for', 'why'];
const PRINTABLE = /^[\x20-\x7e]+$/;

export type AskResult = { ok: true; ask: CallerAsk } | { ok: false; message: string };

/** Why `for` is not `permanent` or a duration of at most 365 days (the words of the target), undefined when it is one. */
function forProblem(text: string): string | undefined {
  if (text === 'permanent') {
    return undefined;
  }
  const parsed = durationSeconds(text);
  if (!parsed.ok || parsed.seconds < 1) {
    return `for must be "permanent" or digits then s, m, h or d, like 30m or 2h, got ${JSON.stringify(text)}`;
  }
  if (parsed.seconds > MAX_LIFETIME_SECONDS) {
    return `for is at most 365 days, got ${JSON.stringify(text)}`;
  }
  return undefined;
}

/**
 * The ask of a request body, read by the TARGET: strict and bounded. Anything outside the ranges is a refusal with the fix, never a clamp: the owner must
 * see what the caller really asked, or nothing.
 */
export function parseCallerAsk(raw: unknown): AskResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: 'the ask must be an object {times, for, why}' };
  }
  const r = Object.fromEntries(Object.entries(raw));
  const unknown = Object.keys(r).find((k) => !KEYS.includes(k));
  if (unknown !== undefined) {
    return { ok: false, message: `the ask has an unknown key "${unknown}": the caller runs another version of machine` };
  }
  if (Object.keys(r).length === 0) {
    return { ok: false, message: 'the ask is empty (it asks for nothing): leave --times, --for and --why out instead' };
  }
  const ask: CallerAsk = {};
  if (r['times'] !== undefined) {
    const times = r['times'];
    if (typeof times !== 'number' || !Number.isSafeInteger(times) || times < 1 || times > MAX_TIMES) {
      return { ok: false, message: `times must be a whole number from 1 to ${MAX_TIMES}, got ${JSON.stringify(times)}` };
    }
    ask.times = times;
  }
  if (r['for'] !== undefined) {
    const text = r['for'];
    if (typeof text !== 'string') {
      return { ok: false, message: `for must be text ("permanent" or a duration like 30m), got ${JSON.stringify(text)}` };
    }
    const problem = forProblem(text);
    if (problem !== undefined) {
      return { ok: false, message: problem };
    }
    ask.for = text;
  }
  if (ask.times !== undefined && ask.for !== undefined) {
    return { ok: false, message: 'give only one of times and for (an entry is limited by a number of calls or by a duration, never both)' };
  }
  if (r['why'] !== undefined) {
    const why = r['why'];
    if (typeof why !== 'string' || why.length === 0) {
      return { ok: false, message: 'why must be a text of 1 to 200 characters' };
    }
    if (why.length > MAX_ASK_WHY) {
      return { ok: false, message: `why has ${why.length} characters: at most ${MAX_ASK_WHY}; shorten it` };
    }
    if (!PRINTABLE.test(why)) {
      return { ok: false, message: 'why must be printable ASCII (no accent, no line break); rewrite it' };
    }
    ask.why = why;
  }
  return { ok: true, ask };
}

export interface AskFlags {
  times?: string | undefined;
  for?: string | undefined;
  why?: string | undefined;
}

/**
 * The ask of the flags `--times`, `--for` and `--why` of `machine run`, checked BEFORE any connection (the same parser as `machine admin allow`, lifetime.ts).
 * Nothing given is no ask (`ask: undefined`).
 */
export function askFromFlags(flags: AskFlags): AskResult | { ok: true; ask: undefined } {
  if (flags.times === undefined && flags.for === undefined && flags.why === undefined) {
    return { ok: true, ask: undefined };
  }
  if (flags.times !== undefined && flags.for !== undefined) {
    return { ok: false, message: 'give only one of --times and --for (an entry is limited by a number of calls or by a duration, `--for permanent` means no limit); the owner decides anyway' };
  }
  const ask: CallerAsk = {};
  try {
    if (flags.times !== undefined) {
      ask.times = parseLifetime({ times: flags.times }, 0)?.maxCalls as number;
    }
    if (flags.for !== undefined) {
      // parseLifetime knows `permanent` and the duration limits; the text itself is what travels (the owner reads what was typed).
      parseLifetime({ for: flags.for }, 0);
      ask.for = flags.for;
    }
  } catch (e) {
    // violations-suppress: ts/no-err-message-direct the error is thrown by parseLifetime above, which words its own fix
    return { ok: false, message: (e as Error).message };
  }
  if (flags.why !== undefined) {
    const why = flags.why.trim();
    if (why === '') {
      return { ok: false, message: '--why is empty: give a short sentence, or leave the flag out' };
    }
    if (why.length > MAX_ASK_WHY) {
      return { ok: false, message: `--why has ${why.length} characters: at most ${MAX_ASK_WHY}; shorten it` };
    }
    if (!PRINTABLE.test(why)) {
      return { ok: false, message: '--why must be printable ASCII (no accent, no line break); rewrite it' };
    }
    ask.why = why;
  }
  return { ok: true, ask };
}

/** The part of an ask the owner must see flagged (permanent, a large number of calls, a long duration), undefined for a small ask. */
export function askRisk(ask: CallerAsk): string | undefined {
  if (ask.for === 'permanent') {
    return 'permanent (no limit)';
  }
  if (ask.times !== undefined && ask.times >= ASK_LARGE_TIMES) {
    return `a large number of calls (${ask.times})`;
  }
  if (ask.for !== undefined) {
    const parsed = durationSeconds(ask.for);
    if (parsed.ok && parsed.seconds > ASK_LONG_SECONDS) {
      return `a long duration (${ask.for})`;
    }
  }
  return undefined;
}

/** The ask in words, for the owner: `3 calls; reason given: rerun`. Always shown as the CALLER's wish, never as a decision. */
export function askSummary(ask: CallerAsk): string {
  const parts: string[] = [];
  if (ask.times !== undefined) {
    parts.push(`${ask.times} ${ask.times === 1 ? 'call' : 'calls'}`);
  }
  if (ask.for !== undefined) {
    parts.push(ask.for);
  }
  if (ask.why !== undefined) {
    parts.push(`reason given: ${ask.why}`);
  }
  return parts.join('; ');
}

/** The `--times n` / `--for d` of an `allow` command that follows the ask; permanent and no ask add nothing (the default of an entry is permanent). */
export function askAllowFlags(ask: CallerAsk | undefined): string {
  if (ask?.times !== undefined) {
    return ` --times ${ask.times}`;
  }
  if (ask?.for !== undefined && ask.for !== 'permanent') {
    return ` --for ${ask.for}`;
  }
  return '';
}
