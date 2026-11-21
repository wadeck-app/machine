import { DURATION_MAX_SECONDS, durationSeconds } from './typedParams.js';

// Lifetime of an allow-list entry: permanent (no limits), N calls, a duration or a date (typed-parameters.md, "Lifetimes"). Pure, no import
// of the policy module: copied byte for byte into machine-webcrypto (the Allow modal), a test keeps the two identical.

export interface LifetimeLimits {
  maxCalls?: number;
  expiresAt?: number;
}

export const MAX_TIMES = 10000;
/** `--for` and `--until` reach at most 365 days past the signing. */
export const MAX_LIFETIME_SECONDS = DURATION_MAX_SECONDS;

export interface LifetimeInput {
  times?: string;
  for?: string;
  until?: string;
}

const DIGITS = '0123456789';

function parseTimes(text: string): number {
  const n = Number(text);
  const canonical = text.length > 0 && [...text].every((c) => DIGITS.includes(c)) && (text === '0' || text[0] !== '0');
  if (!canonical || n < 1 || n > MAX_TIMES) {
    throw new Error(`--times must be a whole number from 1 to ${MAX_TIMES} (digits only, no sign), got ${JSON.stringify(text)}`);
  }
  return n;
}

function parseFor(text: string, now: number): number {
  const parsed = durationSeconds(text);
  if (!parsed.ok || parsed.seconds < 1) {
    throw new Error(`--for must be digits then s, m, h or d, like 30m or 2h (${parsed.ok ? 'at least 1 second' : parsed.rule}), got ${JSON.stringify(text)}`);
  }
  if (parsed.seconds > MAX_LIFETIME_SECONDS) {
    throw new Error(`--for is at most 365 days (${MAX_LIFETIME_SECONDS} seconds), got ${JSON.stringify(text)}`);
  }
  return now + parsed.seconds;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2}))?$/;

function parseUntil(text: string, now: number): number {
  const fix = 'write a date (2027-02-01, the end of that day in UTC) or an instant with its zone (2027-02-01T18:00Z, 2027-02-01T18:00:00+02:00)';
  const m = ISO.exec(text);
  if (m === null) {
    throw new Error(`--until is not a date or an instant with a zone: ${fix}, got ${JSON.stringify(text)}`);
  }
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const timed = m[4] !== undefined;
  const [hour, minute, second] = timed ? [Number(m[4]), Number(m[5]), Number(m[6] ?? '0')] : [23, 59, 59];
  const millis = m[7] === undefined ? 0 : Number(m[7].padEnd(3, '0'));
  let ms = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day || back.getUTCHours() !== hour || back.getUTCMinutes() !== minute) {
    throw new Error(`--until is not a date of the calendar: ${fix}, got ${JSON.stringify(text)}`);
  }
  const zone = m[8];
  if (zone !== undefined && zone !== 'Z') {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMinutes = Number(zone.slice(4, 6));
    if (offsetHours > 14 || offsetMinutes > 59) {
      throw new Error(`--until has an impossible zone offset: ${fix}, got ${JSON.stringify(text)}`);
    }
    ms -= (zone[0] === '-' ? -1 : 1) * (offsetHours * 60 + offsetMinutes) * 60000;
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds <= now) {
    throw new Error(`--until is in the past (${new Date(seconds * 1000).toISOString().replace('.000Z', 'Z')}): write a later date`);
  }
  if (seconds - now > MAX_LIFETIME_SECONDS) {
    throw new Error(`--until is at most 365 days after the signing (${MAX_LIFETIME_SECONDS} seconds), got ${JSON.stringify(text)}`);
  }
  return seconds;
}

/** The limits of the lifetime flags, or undefined for a permanent entry. At most one of the three flags; `now` is the signing time, epoch seconds. */
export function parseLifetime(input: LifetimeInput, now: number): LifetimeLimits | undefined {
  const given = [input.times, input.for, input.until].filter((v) => v !== undefined).length;
  if (given > 1) {
    throw new Error('give only one of --times, --for, --until (an entry is permanent, or limited by calls, by a duration, or by a date)');
  }
  if (input.times !== undefined) {
    return { maxCalls: parseTimes(input.times) };
  }
  if (input.for !== undefined) {
    return { expiresAt: parseFor(input.for, now) };
  }
  if (input.until !== undefined) {
    return { expiresAt: parseUntil(input.until, now) };
  }
  return undefined;
}

const instant = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString().replace('.000Z', 'Z');

/** The lifetime in words. `used`: calls already counted for the entry when the counter is known (on the target machine). */
export function describeLimits(limits: LifetimeLimits | undefined, now: number, used?: number): string {
  if (limits === undefined || (limits.maxCalls === undefined && limits.expiresAt === undefined)) {
    return 'permanent';
  }
  const parts: string[] = [];
  if (limits.maxCalls !== undefined) {
    if (used === undefined) {
      parts.push(`${limits.maxCalls} ${limits.maxCalls === 1 ? 'call' : 'calls'}`);
    }
    else {
      const left = Math.max(0, limits.maxCalls - used);
      parts.push(`${left} of ${limits.maxCalls} calls left${left === 0 ? ' (exhausted)' : ''}`);
    }
  }
  if (limits.expiresAt !== undefined) {
    parts.push(now > limits.expiresAt ? `expired (was until ${instant(limits.expiresAt)})` : `until ${instant(limits.expiresAt)}`);
  }
  return parts.join(', ');
}

/** True when two entries have the same lifetime (no limits equals no limits). */
export function limitsEqual(a: LifetimeLimits | undefined, b: LifetimeLimits | undefined): boolean {
  return a?.maxCalls === b?.maxCalls && a?.expiresAt === b?.expiresAt;
}
