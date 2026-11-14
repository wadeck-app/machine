import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createUpdateRecords } from './updater/updateRecords.js';

// What `machine` and the daemon say about update-state.json. Pure, so the wording is testable (port of orch's update-notice).

/** A record older than this is dead whatever its pid says (pid reuse); same bound as shared-updater's repair. */
export const APPLYING_STALE_MS = 15 * 60 * 1000;

/** The slice of the update state that is read here. */
export interface UpdateStateLike {
  status: string;
  pid?: number;
  /** The npm child of the updater, journaled by shared-updater. */
  npmPid?: number;
  npmStartedAt?: number;
  targetVersion?: string;
  newVersion?: string;
  previousVersion?: string;
  error?: string;
  reason?: string;
  timestamp?: number;
}

export interface UpdateNotice {
  level: 'info' | 'warn';
  text: string;
}

export interface UpdateNoticeOptions {
  now?: number;
  isAlive?: (pid: number) => boolean;
}

/** EPERM means the process exists and is not ours: alive. Only ESRCH (or a bad pid) means gone. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function updateNotice(state: UpdateStateLike | null, opts: UpdateNoticeOptions = {}): UpdateNotice | null {
  if (!state) return null;
  const { status } = state;
  if (status === 'success') return { level: 'info', text: `Updated to v${state.targetVersion ?? state.newVersion ?? '?'}` };
  if (status === 'rolled-back') return { level: 'warn', text: `Rollback to v${state.previousVersion ?? '?'}` };
  if (status === 'failed' || status === 'update-failed') return { level: 'warn', text: `Update failed (${state.error ?? state.reason ?? 'unknown'})` };
  if (status === 'applying') return applyingNotice(state, opts);
  // 'update-available', 'deferred' and the like are not news for the reader of this notice.
  return null;
}

function applyingNotice(state: UpdateStateLike, opts: UpdateNoticeOptions): UpdateNotice {
  const now = opts.now ?? Date.now();
  const isAlive = opts.isAlive ?? isPidAlive;
  const target = state.targetVersion ?? state.newVersion ?? '?';
  const age = typeof state.timestamp === 'number' ? now - state.timestamp : Number.POSITIVE_INFINITY;
  const running = typeof state.pid === 'number' && age <= APPLYING_STALE_MS && isAlive(state.pid);
  if (running) return { level: 'info', text: `An update to v${target} is in progress (pid ${state.pid}).` };
  // The updater journals 'applying' before npm runs: a record whose updater is gone is an install that was killed, possibly with
  // the old package already removed. The next updater run repairs it.
  const orphanNpm = typeof state.npmPid === 'number' && age <= APPLYING_STALE_MS && isAlive(state.npmPid) ? ` Its npm (pid ${state.npmPid}) is still running: the repair waits for it, then stops it.` : '';
  return {
    level: 'warn',
    text: `An update to v${target} was interrupted (previous version: v${state.previousVersion ?? '?'}).${orphanNpm} The next update run repairs it: run \`machine cli update\` now; if \`machine\` is no longer found, run \`npm install -g @wadeck-app/machine-cli@latest\`.`,
  };
}

/**
 * Reads update-state.json WITHOUT deleting it, with the same normalisation of the legacy field names as shared-cli's
 * readAndClearState. A command line must not consume the state: the daemon reads it at start for its update-loop guard and clears it
 * itself. Null when the file is absent or unreadable.
 */
export function readUpdateStateReadOnly(configDir: string): UpdateStateLike | null {
  try {
    const state = JSON.parse(readFileSync(join(configDir, 'update-state.json'), 'utf8')) as UpdateStateLike;
    if (state === null || typeof state !== 'object' || typeof state.status !== 'string') return null;
    if (state.status === 'update-failed') state.status = 'failed';
    if (!state.targetVersion && state.newVersion) state.targetVersion = state.newVersion;
    if (!state.error && state.reason) state.error = state.reason;
    return state;
  } catch {
    return null;
  }
}

/** Marker of the terminal state a command line already showed (the state itself stays for the daemon). */
export const NOTICE_SEEN_FILE = 'update-notice-seen.json';

/** What identifies a state for "already shown": a new update attempt changes it. */
export function noticeKey(state: UpdateStateLike): string {
  return `${state.status}|${state.timestamp ?? ''}|${state.targetVersion ?? ''}`;
}

/**
 * An update that is installed but whose post-update failed (the startup job or the daemon may still run the previous version).
 * Shown at every command until `machine cli post-update` succeeds or a later updater run retries it. Null when there is none.
 */
export function postUpdatePendingNotice(configDir: string): UpdateNotice | null {
  try {
    const pending = createUpdateRecords(configDir).readPending();
    if (pending === null) return null;
    return {
      level: 'warn',
      text: `The update to v${pending.targetVersion} is installed but its post-update failed (${pending.error.split('\n')[0]}): the startup job or the running daemon may still use the previous version. Fix the cause, then run: machine cli post-update (the next background update run retries it too)`,
    };
  } catch (e) {
    return { level: 'warn', text: (e as Error).message };
  }
}
