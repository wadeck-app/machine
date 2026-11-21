import { MAX_WAIT_SECONDS, MIN_WAIT_SECONDS, describeSeconds, parseWait } from './hold.js';

// What `machine run` does when the target does not allow the command yet. Precedence, highest first: the flags of the command, the machine setting
// (`<configDir>/run-defaults.json`, public, unsigned, local), the built-in default (wait 10 minutes). Pure: no I/O. Waiting changes WHEN a refusal is
// answered, never WHAT is allowed (hold-for-approval.md).

export const ON_REFUSAL_VALUES = ['wait', 'fail'] as const;
export type OnRefusal = (typeof ON_REFUSAL_VALUES)[number];
export const DEFAULT_ON_REFUSAL: OnRefusal = 'wait';
export const DEFAULT_WAIT_SECONDS = 600;
/** The caller says that the wait is on by default when the target has not answered after this long (a held request, or a slow command). */
export const DEFAULT_WAIT_NOTICE_DELAY_MS = 2000;

const WAIT_RANGE = `${MIN_WAIT_SECONDS} s to ${MAX_WAIT_SECONDS / 60} min`;

/** The content of `run-defaults.json`. An absent field means "not set here": the built-in default applies. */
export interface RunDefaults {
  v: 1;
  onRefusal?: OnRefusal;
  waitSeconds?: number;
}

/** The flags of `machine run` as typed (`wait` is the raw text, validated here). */
export interface RunWaitFlags {
  onRefusal?: string;
  wait?: string;
  noWait?: boolean;
}

export type RunWaitSource = 'flag' | 'setting' | 'built-in';

export type RunWait =
  | { onRefusal: 'wait'; seconds: number; onRefusalSource: RunWaitSource; secondsSource: RunWaitSource }
  | { onRefusal: 'fail'; onRefusalSource: RunWaitSource };

/** Throws a message naming the field and the fix. A damaged setting is never read as "not set". */
export function parseRunDefaults(raw: unknown): RunDefaults {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('not an object: expected {"v": 1, "onRefusal": "wait" | "fail", "waitSeconds": <10 to 3600>}');
  }
  const field = (name: string): unknown => Reflect.get(raw, name);
  const unknown = Object.keys(raw).find((k) => k !== 'v' && k !== 'onRefusal' && k !== 'waitSeconds');
  if (unknown !== undefined) {
    throw new Error(`unknown field "${unknown}": the known fields are "v", "onRefusal" and "waitSeconds"`);
  }
  if (field('v') !== 1) {
    throw new Error('"v" must be 1');
  }
  const out: RunDefaults = { v: 1 };
  const onRefusal = field('onRefusal');
  if (onRefusal !== undefined) {
    if (onRefusal !== 'wait' && onRefusal !== 'fail') {
      throw new Error(`"onRefusal" must be "wait" or "fail", got ${JSON.stringify(onRefusal)}`);
    }
    out.onRefusal = onRefusal;
  }
  const waitSeconds = field('waitSeconds');
  if (waitSeconds !== undefined) {
    if (typeof waitSeconds !== 'number' || !Number.isInteger(waitSeconds) || waitSeconds < MIN_WAIT_SECONDS || waitSeconds > MAX_WAIT_SECONDS) {
      throw new Error(`"waitSeconds" must be a whole number of seconds, ${WAIT_RANGE} (3600 at most), got ${JSON.stringify(waitSeconds)}`);
    }
    out.waitSeconds = waitSeconds;
  }
  return out;
}

export function serializeRunDefaults(defaults: RunDefaults): string {
  return `${JSON.stringify(defaults, null, 2)}\n`;
}

/**
 * The effective behaviour of one `machine run`. Throws a message with the fix when the flags contradict each other or hold a bad value (refused
 * before anything is sent, whatever the setting says).
 */
export function resolveRunWait(flags: RunWaitFlags, setting: RunDefaults | undefined): RunWait {
  let flagMode: OnRefusal | undefined;
  if (flags.onRefusal !== undefined) {
    if (flags.onRefusal !== 'wait' && flags.onRefusal !== 'fail') {
      throw new Error(`--on-refusal ${JSON.stringify(flags.onRefusal)} is not a choice: use --on-refusal wait (hold the request until the owner answers) or --on-refusal fail (refuse at once)`);
    }
    flagMode = flags.onRefusal;
  }
  const noWait = flags.noWait === true;
  const flagSeconds = flags.wait !== undefined ? parseWait(flags.wait) : undefined;
  if (noWait && flagSeconds !== undefined) {
    throw new Error('--no-wait (fail at once) and --wait (wait up to a duration) contradict each other: remove one of them');
  }
  if (noWait && flagMode === 'wait') {
    throw new Error('--no-wait (fail at once) and --on-refusal wait contradict each other: remove one of them');
  }
  if (flagMode === 'fail' && flagSeconds !== undefined) {
    throw new Error('--on-refusal fail (refuse at once) and --wait (wait up to a duration) contradict each other: remove one of them, or use --on-refusal wait --wait <duration>');
  }

  let mode: OnRefusal;
  let modeSource: RunWaitSource;
  if (noWait) {
    mode = 'fail';
    modeSource = 'flag';
  } else if (flagMode !== undefined) {
    mode = flagMode;
    modeSource = 'flag';
  } else if (flagSeconds !== undefined) {
    mode = 'wait';
    modeSource = 'flag';
  } else if (setting?.onRefusal !== undefined) {
    mode = setting.onRefusal;
    modeSource = 'setting';
  } else {
    mode = DEFAULT_ON_REFUSAL;
    modeSource = 'built-in';
  }
  if (mode === 'fail') {
    return { onRefusal: 'fail', onRefusalSource: modeSource };
  }
  if (flagSeconds !== undefined) {
    return { onRefusal: 'wait', seconds: flagSeconds, onRefusalSource: modeSource, secondsSource: 'flag' };
  }
  if (setting?.waitSeconds !== undefined) {
    return { onRefusal: 'wait', seconds: setting.waitSeconds, onRefusalSource: modeSource, secondsSource: 'setting' };
  }
  return { onRefusal: 'wait', seconds: DEFAULT_WAIT_SECONDS, onRefusalSource: modeSource, secondsSource: 'built-in' };
}

/**
 * The line printed once on stderr at the start of a `run` that waits although the command line did not ask for it (default or setting). Undefined
 * when the person typed the choice: they know.
 */
export function defaultWaitNotice(machineName: string, wait: RunWait): string | undefined {
  if (wait.onRefusal !== 'wait' || (wait.onRefusalSource === 'flag' && wait.secondsSource === 'flag')) {
    return undefined;
  }
  if (wait.onRefusalSource === 'flag') {
    // --on-refusal wait without a duration: the person asked for the wait, the duration is not typed.
    return undefined;
  }
  const origin = wait.onRefusalSource === 'setting' || wait.secondsSource === 'setting' ? 'setting run-defaults' : 'default';
  return `waiting up to ${describeSeconds(wait.seconds)} for ${machineName} to allow it (${origin}; --no-wait to fail at once)`;
}

const SOURCE_TEXT: Record<RunWaitSource, string> = { flag: 'flag', setting: 'setting run-defaults', 'built-in': 'built-in default' };

/** The effective values with where they come from, for `machine run-defaults` and `machine status`. */
export function describeRunWait(wait: RunWait): { onRefusal: string; wait?: string } {
  const onRefusal = `${wait.onRefusal} (${SOURCE_TEXT[wait.onRefusalSource]})`;
  return wait.onRefusal === 'wait' ? { onRefusal, wait: `${describeSeconds(wait.seconds)} (${SOURCE_TEXT[wait.secondsSource]})` } : { onRefusal };
}

/**
 * Printed after a refusal that was not held although a wait was in effect: the target runs a version without the hold (it ignores the field and
 * refuses at once). The refusal itself is the ordinary one.
 */
export function notHeldWarning(machineName: string, wait: RunWait): string | undefined {
  if (wait.onRefusal !== 'wait') {
    return undefined;
  }
  const update = `it most likely runs a version without the hold (update it: run machine cli update there); the refusal above is the ordinary one`;
  if (wait.onRefusalSource === 'flag' && wait.secondsSource === 'flag') {
    return `${machineName} did not hold the request although --wait was given: ${update}`;
  }
  const origin = wait.onRefusalSource === 'setting' || wait.secondsSource === 'setting' ? 'by the setting run-defaults' : 'by default';
  return `${machineName} did not hold the request although the wait is on ${origin}: ${update}. To stop asking for the wait: --no-wait on this run, or machine run-defaults --on-refusal fail for every run`;
}

/** The target refuses a hold because it already holds too many requests: what the caller does, now that the wait is the default. */
export function holdLimitAdvice(reason: string, machineName: string): string | undefined {
  if (reason !== 'hold-limit-peer' && reason !== 'hold-limit-machine') {
    return undefined;
  }
  return `Waiting is on for \`machine run\`: wait for the owner of ${machineName} to answer the pending ones (they are listed by \`machine requests\` on ${machineName}), then run it again; or use --no-wait to be refused at once without holding a slot`;
}
