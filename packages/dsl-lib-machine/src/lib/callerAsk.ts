import { MAX_TIMES, parseLifetime } from '@wadeck-app/machine-webcrypto';
import type { LifetimeChoice } from './lifetimeChoice.js';

// What the CALLER of `machine run` asked the owner for (decision 96): the browser copy of machine-core callerAsk.ts (the page cannot import machine-core at
// runtime), kept the same by callerAsk.test.ts. UNTRUSTED text and numbers: only ever shown as the caller's wish and used as the STARTING POINT of the
// lifetime selector. The owner edits and signs; nothing is applied by itself.

export interface CallerAsk {
  times?: number;
  for?: string;
  why?: string;
}

export const ASK_LARGE_TIMES = 50;
const ASK_LONG_SECONDS = 7 * 24 * 3600;

/** The part of an ask the owner must see flagged (permanent, a large number of calls, a long duration), undefined for a small ask. */
export function askRisk(ask: CallerAsk): string | undefined {
  if (ask.for === 'permanent') {
    return 'permanent (no limit)';
  }
  if (ask.times !== undefined && ask.times >= ASK_LARGE_TIMES) {
    return `a large number of calls (${ask.times})`;
  }
  if (ask.for !== undefined && durationOf(ask.for) > ASK_LONG_SECONDS) {
    return `a long duration (${ask.for})`;
  }
  return undefined;
}

/** The ask in words, for the owner: `3 calls; reason given: rerun`. */
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

/** The `--times n` / `--for d` of the `allow` command that follows the ask; permanent and no ask add nothing. */
export function askAllowFlags(ask: CallerAsk | undefined): string {
  if (ask?.times !== undefined) {
    return ` --times ${ask.times}`;
  }
  if (ask?.for !== undefined && ask.for !== 'permanent') {
    return ` --for ${ask.for}`;
  }
  return '';
}

function durationOf(text: string): number {
  try {
    return parseLifetime({ for: text }, 0)?.expiresAt ?? 0;
  } catch {
    return 0;
  }
}

/**
 * The choice the lifetime selector starts from when the caller asked for a lifetime: one call is once, a preset duration its preset, anything else a custom
 * value. Undefined when it asked none (a reason alone): the default of the page applies. A text that is not a lifetime of the dialog is not pre-filled.
 */
export function choiceFromAsk(ask: CallerAsk): LifetimeChoice | undefined {
  if (ask.times !== undefined) {
    if (!Number.isSafeInteger(ask.times) || ask.times < 1 || ask.times > MAX_TIMES) {
      return undefined;
    }
    return ask.times === 1 ? { kind: 'once', customKind: 'calls', customText: '' } : { kind: 'custom', customKind: 'calls', customText: String(ask.times) };
  }
  if (ask.for === undefined) {
    return undefined;
  }
  if (ask.for === 'permanent') {
    return { kind: 'permanent', customKind: 'duration', customText: '' };
  }
  if (ask.for === '15m' || ask.for === '1h' || ask.for === '1d') {
    return { kind: ask.for, customKind: 'duration', customText: '' };
  }
  return durationOf(ask.for) > 0 ? { kind: 'custom', customKind: 'duration', customText: ask.for } : undefined;
}
