import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { devBuildRefusalMessage, isReleaseVersion } from '@wadeck-app/shared-cli/ReleaseVersion';

// Port of orch's update-scheduling ('machine', machine-updater.cjs).

export interface UpdateSpawner {
  scheduleBackgroundUpdate(bundlePath: string, updaterName: string, currentVersion: string): void;
}

export interface RequestOptions {
  /** Skip the request when one was already made in this run (the startup check). */
  oncePerRun?: boolean;
  /** An explicit request: the updater bypasses autoUpdate: false through UPDATER_FORCE. */
  force?: boolean;
}

export type RequestResult = 'scheduled' | 'skipped-already' | 'skipped-dev' | 'skipped-suspended' | 'skipped-no-updater';

/** Name of the updater bundle, next to machine.cjs. */
export const UPDATER_BUNDLE_NAME = 'machine-updater.cjs';

/**
 * The single place the daemon spawns the updater from (startup, every 30 minutes). A development build spawns nothing (see
 * devBuildRefusalMessage); background requests explain it once per run, explicit ones every time.
 */
export function createUpdateScheduler(deps: {
  version: string;
  bundlePath: string;
  manager: UpdateSpawner;
  log: (message: string) => void;
  /** Why the automatic updates are suspended (updateGuard.ts), or null. Read at every request; an explicit one still goes through. */
  suspended?: () => string | null;
  /**
   * Environment variables set for the spawn only (restored after, even on a throw). The daemon passes MACHINE_CONFIG_DIR here:
   * the updater resolves its configuration directory from the environment, so a daemon started with --config-dir X must hand X over.
   */
  spawnEnv?: Record<string, string>;
  /** Tests only: does the updater bundle exist (default: existsSync). */
  updaterExists?: (path: string) => boolean;
}) {
  let requested = false;
  let devExplained = false;
  let suspensionSaid = false;
  let noUpdaterSaid = false;
  const updaterPath = join(dirname(deps.bundlePath), UPDATER_BUNDLE_NAME);
  return {
    request(reason: string, opts: RequestOptions = {}): RequestResult {
      if (!isReleaseVersion(deps.version)) {
        if (opts.force || !devExplained) {
          deps.log(`background update check (${reason}) skipped: ${devBuildRefusalMessage('machine', deps.version)}`);
          devExplained = true;
        }
        return 'skipped-dev';
      }
      const suspendedBecause = deps.suspended?.() ?? null;
      if (suspendedBecause !== null && !opts.force) {
        // Said once per run, not at every tick; before oncePerRun is spent, so a later explicit request is not blocked by it.
        if (!suspensionSaid) {
          deps.log(`background update check (${reason}) refused: ${suspendedBecause}`);
          suspensionSaid = true;
        }
        return 'skipped-suspended';
      }
      // shared-cli's spawner returns in silence when the updater is not there (and falls back to another name): said here, once per run.
      if (!(deps.updaterExists ?? existsSync)(updaterPath)) {
        if (!noUpdaterSaid) {
          deps.log(`ERROR background update check (${reason}) cannot run: ${updaterPath} does not exist (the daemon runs from ${deps.bundlePath}). Automatic updates do not work until it is there: reinstall with \`npm install -g @wadeck-app/machine-cli@latest\``);
          noUpdaterSaid = true;
        }
        return 'skipped-no-updater';
      }
      if (opts.oncePerRun) {
        if (requested) {
          deps.log(`background update check (${reason}): skipped, already scheduled this run`);
          return 'skipped-already';
        }
        requested = true;
      }
      deps.log(`background update check triggered (${reason})`);
      const overrides: Record<string, string> = { ...deps.spawnEnv, ...(opts.force ? { UPDATER_FORCE: '1' } : {}) };
      const previous = new Map<string, string | undefined>(Object.keys(overrides).map((name) => [name, process.env[name]]));
      Object.assign(process.env, overrides);
      try {
        deps.manager.scheduleBackgroundUpdate(deps.bundlePath, UPDATER_BUNDLE_NAME, deps.version);
      } finally {
        for (const [name, value] of previous) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
      return 'scheduled';
    },
  };
}
