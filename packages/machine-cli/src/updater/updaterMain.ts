import type { UpdaterConfig } from '@wadeck-app/shared-updater';
import { devBuildRefusalMessage, isReleaseVersion } from '@wadeck-app/shared-cli/ReleaseVersion';
import { armSelfCheck, type SelfCheckTarget } from './selfCheckTarget.js';

// The logic of the updater entry (entry.ts), with every side effect injected so that tests never run npm, touch the install
// or spawn a process. Must NOT import any machine runtime module: the updater runs from the install it is about to replace.

export interface UpdaterMainDeps {
  pkgName: string;
  configDir: string;
  currentVersion: string;
  /** process.env: read for UPDATER_FORCE, MACHINE_UPDATER_FROM_DAEMON, UPDATER_SELF_CHECK_CMD; UPDATER_SELF_CHECK_CMD is set here. */
  env: Record<string, string | undefined>;
  nodeExe: string;
  /** The log `machine cli logs` shows (this process is detached with stdio ignored when the daemon started it). */
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  stderr: (text: string) => void;
  /** `npm root -g`; throws when npm fails. */
  npmRootGlobal: () => string;
  resolveTarget: (npmRoot: string) => SelfCheckTarget;
  readState: () => { status: string; currentVersion?: string; targetVersion?: string; error?: string; timestamp?: number } | null;
  runUpdater: (cfg: UpdaterConfig) => Promise<void>;
  /** Runs `cli post-update` of the NEW install (so that a fix of that logic applies to the update that installs it). */
  spawnPostUpdate: (npmRoot: string) => Promise<{ code: number; output: string }>;
  now: () => number;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Returns the exit code of the updater process. */
export async function updaterMain(deps: UpdaterMainDeps): Promise<number> {
  const { pkgName, configDir, currentVersion, env } = deps;
  const forced = env.UPDATER_FORCE === '1';

  // Before ANY npm call: a repo-built bundle is older than every published version, so the updater would find an "update" and run
  // `npm install -g` over the real install, which killed halfway leaves the CLI uninstalled.
  if (!isReleaseVersion(currentVersion)) {
    const text = `${pkgName}: ${devBuildRefusalMessage('machine', currentVersion)}`;
    deps.log('warn', text);
    if (forced) {
      deps.stderr(`[fail] ${text}\n`);
      return 1;
    }
    return 0;
  }

  let npmRoot: string | undefined;
  const globalRoot = (): string => {
    if (npmRoot === undefined) {
      try {
        npmRoot = deps.npmRootGlobal().trim();
      } catch (e) {
        throw new Error(`cannot resolve 'npm root -g': ${message(e)}`);
      }
    }
    return npmRoot;
  };

  // shared-updater treats an unset UPDATER_SELF_CHECK_CMD as "the check passed": never leave it unset.
  if (!env.UPDATER_SELF_CHECK_CMD) {
    const interrupted = deps.readState()?.status === 'applying';
    let resolved: SelfCheckTarget;
    try {
      resolved = deps.resolveTarget(globalRoot());
    } catch (e) {
      resolved = { ok: false, reason: message(e) };
    }
    const armed = armSelfCheck({ nodeExe: deps.nodeExe, resolved, interrupted });
    if (armed.abort !== undefined) {
      deps.log('error', `${pkgName} update aborted: ${armed.abort}`);
      deps.stderr(`[fail] update aborted: ${armed.abort}\n`);
      return 1;
    }
    if (armed.note) deps.log('warn', `${pkgName} ${armed.note}`);
    env.UPDATER_SELF_CHECK_CMD = armed.command;
  }

  const startedAt = deps.now();
  try {
    await deps.runUpdater({
      pkgName,
      configDir,
      currentVersion,
      strategy: 'without-daemon',
      // The daemon owns its own cadence (startup + every 30 minutes): the time gate would skip every other spawn.
      ...(env.MACHINE_UPDATER_FROM_DAEMON === '1' ? { skipThrottle: true } : {}),
      // Whether a remote execution is running is not known to this process: see the open question in the plan (busy signal).
      onUpdateAvailable: async () => 'apply-now' as const,
    });
  } catch (e) {
    deps.log('error', `${pkgName} updater failed: ${message(e)}`);
    deps.stderr(`[fail] the updater failed: ${message(e)}. State: ${configDir}/update-state.json; log: \`machine cli logs\`; by hand: npm install -g ${pkgName}@latest\n`);
    return 1;
  }

  const state = deps.readState();
  // runUpdater returns nothing: "this run installed something" is read from the state file.
  if (state === null || state.timestamp === undefined || state.timestamp < startedAt) return 0;
  if (state.status === 'failed' || state.status === 'rolled-back') {
    deps.stderr(`[fail] update to v${state.targetVersion ?? '?'} ${state.status === 'failed' ? 'failed' : 'was rolled back'}: ${state.error ?? 'no reason recorded'} (state: ${configDir}/update-state.json; log: \`machine cli logs\`)\n`);
    return 1;
  }
  if (state.status !== 'success' || state.targetVersion === undefined || state.targetVersion === currentVersion) return 0;

  deps.stderr(`[ok] updated machine to v${state.targetVersion} (was v${currentVersion})\n`);
  let root: string;
  try {
    root = globalRoot();
  } catch (e) {
    deps.stderr(`[fail] the update is installed but post-update could not run: ${message(e)}. Finish by hand: machine cli post-update\n`);
    return 1;
  }
  const post = await deps.spawnPostUpdate(root);
  if (post.output.length > 0) deps.stderr(post.output.endsWith('\n') ? post.output : `${post.output}\n`);
  if (post.code !== 0) {
    deps.log('error', `${pkgName} post-update exited with code ${post.code}`);
    deps.stderr(`[fail] the update is installed, but post-update failed (exit ${post.code}): the startup job or the running daemon may still use v${currentVersion}. Fix the cause above, then run: machine cli post-update\n`);
    return 1;
  }
  return 0;
}
