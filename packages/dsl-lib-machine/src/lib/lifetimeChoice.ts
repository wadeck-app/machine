import { parseLifetime, MAX_TIMES, MAX_LIFETIME_SECONDS, type LifetimeInput, type LifetimeLimits } from '@wadeck-app/machine-webcrypto';

// The lifetime of the entry the Allow dialog signs (typed-parameters.md, "Lifetimes"): once, a preset duration, permanent, or a custom number of calls
// or duration. The checks are the ones of the CLI flags --times and --for (the same pure parser, copied byte for byte into machine-webcrypto), so the entry
// the page signs is the entry `machine admin allow --times/--for` would sign. No I/O, no clock of its own: `now` is the signing time.

export type LifetimeKind = 'once' | '15m' | '1h' | '1d' | 'permanent' | 'custom';

export interface LifetimeChoice {
  kind: LifetimeKind;
  /** `custom` only: a number of calls, or a duration (digits then s, m, h or d). */
  customKind: 'calls' | 'duration';
  customText: string;
}

/** The options of the dialog, in order. */
export const LIFETIME_PRESETS: ReadonlyArray<{ kind: LifetimeKind; label: string }> = [
  { kind: 'once', label: 'Once (1 call)' },
  { kind: '15m', label: '15 minutes' },
  { kind: '1h', label: '1 hour' },
  { kind: '1d', label: '1 day' },
  { kind: 'permanent', label: 'Permanent' },
  { kind: 'custom', label: 'Custom' },
];

export type LifetimeResolution = { ok: true; flags: LifetimeInput; limits: (now: number) => LifetimeLimits | undefined } | { ok: false; message: string };

const PRESET_FLAGS: Record<Exclude<LifetimeKind, 'permanent' | 'custom'>, LifetimeInput> = {
  once: { times: '1' },
  '15m': { for: '15m' },
  '1h': { for: '1h' },
  '1d': { for: '1d' },
};

/** What the CLI parser makes of the field of the dialog, worded for the dialog (the CLI wording talks about flags). */
function customProblem(choice: LifetimeChoice): string | undefined {
  const text = choice.customText.trim();
  if (choice.customKind === 'calls') {
    if (text === '') {
      return `Enter a number of calls, from 1 to ${MAX_TIMES}. Nothing was signed.`;
    }
    try {
      parseLifetime({ times: text }, 0);
    } catch {
      return `The number of calls must be a whole number from 1 to ${MAX_TIMES} (digits only, no sign, no decimals), got ${JSON.stringify(text)}. Nothing was signed.`;
    }
    return undefined;
  }
  if (text === '') {
    return 'Enter a duration: digits then s, m, h or d, like 30m or 2h. Nothing was signed.';
  }
  try {
    parseLifetime({ for: text }, 0);
  } catch (e) {
    const days = MAX_LIFETIME_SECONDS / 86400;
    const message = (e as Error).message;
    if (message.includes('at most 365 days')) {
      return `The duration is at most ${days} days (${text} is longer). Nothing was signed.`;
    }
    if (message.includes('at least 1 second')) {
      return `The duration must be at least 1 second, got ${JSON.stringify(text)}. Nothing was signed.`;
    }
    return `The duration must be digits then s, m, h or d, like 30m or 2h (no leading zero, no decimals), got ${JSON.stringify(text)}. Nothing was signed.`;
  }
  return undefined;
}

export function lifetimeInput(choice: LifetimeChoice): LifetimeResolution {
  let flags: LifetimeInput;
  if (choice.kind === 'permanent') {
    flags = {};
  } else if (choice.kind === 'custom') {
    const problem = customProblem(choice);
    if (problem !== undefined) {
      return { ok: false, message: problem };
    }
    const text = choice.customText.trim();
    flags = choice.customKind === 'calls' ? { times: text } : { for: text };
  } else {
    flags = PRESET_FLAGS[choice.kind];
  }
  return { ok: true, flags, limits: (now) => parseLifetime(flags, now) };
}

const clock = (epoch: number): string => new Date(epoch * 1000).toTimeString().slice(0, 5);
const day = (epoch: number): string => {
  const d = new Date(epoch * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function inText(seconds: number): string {
  if (seconds >= 86400) {
    const days = Math.round(seconds / 86400);
    return `${days} ${days === 1 ? 'day' : 'days'}`;
  }
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
  }
  if (seconds >= 60) {
    return `${Math.round(seconds / 60)} min`;
  }
  return `${seconds} s`;
}

/** The lifetime in words for the signing summary, shown BEFORE the passphrase. `now` is the time of the page; the signature counts from the moment it is made. */
export function lifetimeWords(limits: LifetimeLimits | undefined, now: number): string {
  if (limits === undefined || (limits.maxCalls === undefined && limits.expiresAt === undefined)) {
    return 'permanent, until you remove it';
  }
  if (limits.maxCalls !== undefined) {
    return limits.maxCalls === 1 ? 'allowed once' : `allowed ${limits.maxCalls} times`;
  }
  const at = limits.expiresAt as number;
  const seconds = at - now;
  return `until ${seconds >= 86400 ? `${day(at)} ` : ''}${clock(at)} (in ${inText(seconds)})`;
}
