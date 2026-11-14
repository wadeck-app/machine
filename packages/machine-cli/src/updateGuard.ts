import { readFileSync } from 'node:fs';
import { isReleaseVersion } from '@wadeck-app/shared-cli/ReleaseVersion';
import { writeFileAtomic } from './fsutil.js';
import type { UpdateStateLike } from './updateNotice.js';

/**
 * Two guards against an update that never takes effect and restarts the daemon again and again (orch saw 822 restarts in a day:
 * the updater installed into the npm prefix of the active node while the daemon kept starting the bundle of another one).
 * Neither guard needs to know why an update does not take.
 */

/** How many restarts caused by updates, within the window, are too many. */
export const UPDATE_LOOP_LIMIT = 3;
export const UPDATE_LOOP_WINDOW_MS = 30 * 60_000;
export const UPDATE_STARTS_FILE = 'update-starts.json';

/** A start dated later than this (the clock was set back) is not a recent one: it would otherwise count until the clock catches up. */
const CLOCK_SKEW_MS = 60_000;
const isRecent = (t: number, now: number): boolean => now - t < UPDATE_LOOP_WINDOW_MS && t - now <= CLOCK_SKEW_MS;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The update says it installed a version this daemon is not running: the updater and this daemon do not look at the same
 * install, so another update would change nothing and restart the daemon for nothing. Null when there is nothing to say.
 */
export function staleUpdateProblem(runningVersion: string, state: UpdateStateLike | null, bundlePath: string): string | null {
  if (!state || state.status !== 'success' || !isReleaseVersion(runningVersion)) return null;
  const target = state.targetVersion ?? state.newVersion;
  if (target === undefined || target === runningVersion) return null;
  return (
    `an update to v${target} was installed, but this daemon runs v${runningVersion} from ${bundlePath}: the updater installs into the npm prefix of the node that is active now, ` +
    'and this daemon was started from a bundle somewhere else (after a node version switch, for instance). Automatic updates are suspended until it restarts. ' +
    'Fix: `machine stop`, then `machine startup enable` with the node you use now (it registers the bundle of that node and restarts the daemon).'
  );
}

/** Restarts caused by updates that are too frequent: a loop, whatever its cause. Null when the rate is fine. */
export function updateStartLoopProblem(starts: readonly number[], now: number): string | null {
  const recent = starts.filter((t) => isRecent(t, now));
  if (recent.length < UPDATE_LOOP_LIMIT) return null;
  return (
    `the daemon was restarted ${recent.length} times in the last ${UPDATE_LOOP_WINDOW_MS / 60_000} minutes by updates. ` +
    'Automatic updates are suspended until the oldest of these restarts is that old. `machine cli self-check` says what is wrong with the install; ' +
    'if it does not, check that the node that runs `machine` is the one the daemon starts under.'
  );
}

/** The record of the starts that followed an update. A file that cannot be read counts as empty and is reported. */
export function loadUpdateStarts(file: string): { starts: number[]; problem: string | null } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { starts: [], problem: null };
    return { starts: [], problem: `${file} cannot be read (${msg(e)}); it is treated as empty` };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.every((t) => typeof t === 'number' && Number.isFinite(t))) return { starts: parsed as number[], problem: null };
    return { starts: [], problem: `${file} does not hold a list of times; it is treated as empty and rewritten` };
  } catch (e) {
    return { starts: [], problem: `${file} is not valid JSON (${msg(e)}); it is treated as empty and rewritten` };
  }
}

/** Adds a start to the record, drops what left the window, writes it, and returns what is kept. Throws if it cannot write. */
export function recordUpdateStart(file: string, now: number): number[] {
  const kept = [...loadUpdateStarts(file).starts.filter((t) => isRecent(t, now)), now];
  writeFileAtomic(file, `${JSON.stringify(kept)}\n`, 0o600);
  return kept;
}

/**
 * What the daemon does with the update state it reads at start: records the restart when an update caused it, and returns why the
 * automatic updates must be suspended (also written to the log as an error), or null. A stale install wins over a loop, since it
 * names the cause. Never throws: a record that cannot be read or written is reported and the daemon goes on.
 */
export function guardUpdates(opts: { version: string; state: UpdateStateLike | null; bundlePath: string; startsFile: string; now: number; log: (message: string) => void }): string | null {
  const { state, log } = opts;
  if (!state) return null;
  let loop: string | null = null;
  if (state.status === 'success') {
    const loaded = loadUpdateStarts(opts.startsFile);
    if (loaded.problem) log(`ERROR ${loaded.problem}`);
    let starts: number[];
    try {
      starts = recordUpdateStart(opts.startsFile, opts.now);
    } catch (e) {
      log(`ERROR ${opts.startsFile} could not be written (${msg(e)}): the restarts caused by updates cannot be counted, so the loop guard is limited to this start`);
      starts = [...loaded.starts, opts.now];
    }
    loop = updateStartLoopProblem(starts, opts.now);
  }
  const why = staleUpdateProblem(opts.version, state, opts.bundlePath) ?? loop;
  if (why) log(`ERROR automatic updates suspended: ${why}`);
  return why;
}
