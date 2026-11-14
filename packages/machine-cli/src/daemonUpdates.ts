import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isReleaseVersion } from '@wadeck-app/shared-cli/ReleaseVersion';
import { UpdateManager } from '@wadeck-app/shared-cli/UpdateManager';
import { PACKAGE_NAME } from './cliMeta.js';
import { guardUpdates, UPDATE_STARTS_FILE } from './updateGuard.js';
import { postUpdatePendingNotice, updateNotice, type UpdateStateLike } from './updateNotice.js';
import { createUpdateScheduler, type UpdateSpawner } from './updateScheduling.js';

/** The daemon asks for an update check at start and then at this interval (the updater skips its own time gate for it). */
export const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

export interface DaemonUpdates {
  /** Tests only: what spawns the updater and reads the update state (default: shared-cli UpdateManager). */
  manager?: UpdateSpawner & { readAndClearState(): UpdateStateLike | null };
  /** Absolute path of the running bundle; the updater is looked for next to it. Default: this bundle's own file (never process.argv[1]: a shim or a wrapper is not it). */
  bundlePath?: string;
  /** Tests only: does the updater bundle exist (default: existsSync). */
  updaterExists?: (path: string) => boolean;
  /** Tests only: the periodic timer (default: setInterval, unref'd so that it never keeps the process alive). */
  timer?: (fn: () => void, ms: number) => { stop: () => void };
}

const defaultTimer = (fn: () => void, ms: number) => {
  const handle = setInterval(fn, ms);
  handle.unref();
  return { stop: () => clearInterval(handle) };
};

/**
 * What the daemon does about updates (packaging.md 3.5.7): read the state a previous updater left, guard against an update loop, ask for a
 * check now and every 30 minutes. Returns what stops the periodic check. Never throws: an update problem must not stop a daemon that
 * peers rely on, so it is a line in the log.
 */
export function startUpdates(configDir: string, version: string, options: DaemonUpdates | undefined, log: (line: string) => void): { stop: () => void } {
  const manager = options?.manager ?? new UpdateManager(PACKAGE_NAME, configDir);
  const bundlePath = options?.bundlePath ?? fileURLToPath(import.meta.url);
  let suspended: string | null = null;
  const scheduler = createUpdateScheduler({
    version,
    bundlePath,
    manager,
    log,
    ...(options?.updaterExists === undefined ? {} : { updaterExists: options.updaterExists }),
    suspended: () => suspended,
    // The updater resolves its configuration directory from the environment only: a daemon started with --config-dir X must hand X over.
    spawnEnv: { MACHINE_CONFIG_DIR: configDir, MACHINE_UPDATER_FROM_DAEMON: '1' },
  });
  const request = (reason: string, opts?: { oncePerRun?: boolean }): void => {
    try {
      scheduler.request(reason, opts);
    } catch (e) {
      log(`update check failed: ${(e as Error).message}`);
    }
  };

  // A development build never updates, so the state of an installed release (which a later `machine` command shows) is not its business.
  if (isReleaseVersion(version)) {
    // Persisted by an updater whose post-update failed: it ran detached with stdio ignored, so nobody saw its output.
    const pending = postUpdatePendingNotice(configDir);
    if (pending) log(`ERROR ${pending.text}`);
    const state = manager.readAndClearState();
    const notice = updateNotice(state);
    if (notice) log(`update state: ${notice.text}`);
    // An update that did not change the version this daemon runs, or updates that restart it again and again, stop the automatic updates.
    suspended = guardUpdates({ version, state, bundlePath, startsFile: join(configDir, UPDATE_STARTS_FILE), now: Date.now(), log });
  }

  request('startup', { oncePerRun: true });
  const timer = (options?.timer ?? defaultTimer)(() => request('periodic, every 30m'), UPDATE_CHECK_INTERVAL_MS);
  return { stop: () => timer.stop() };
}
