import type { UpdaterConfig } from '@wadeck-app/shared-updater';
import { devBuildRefusalMessage, isReleaseVersion } from '@wadeck-app/shared-cli/ReleaseVersion';
import { armSelfCheck, type SelfCheckTarget } from './selfCheckTarget.js';
import type { UpdateRecords } from './updateRecords.js';

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
  readState: () => { status: string; currentVersion?: string; previousVersion?: string; targetVersion?: string; error?: string; timestamp?: number } | null;
  runUpdater: (cfg: UpdaterConfig) => Promise<void>;
  /** Runs `cli post-update` of the NEW install (so that a fix of that logic applies to the update that installs it). */
  spawnPostUpdate: (npmRoot: string) => Promise<{ code: number; output: string }>;
  now: () => number;
  /** The post-update-pending and update-blocked records (updateRecords.ts). */
  records: UpdateRecords;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** What of a post-update output is kept in the log and the record: the tail, where the reason is. */
const MAX_OUTPUT = 2000;
const tail = (output: string): string => {
  const text = output.trim();
  return text.length <= MAX_OUTPUT ? text : `...${text.slice(-MAX_OUTPUT)}`;
};
/** A background run does not install again a version whose last install failed: it asks the updater to defer by this much (one line in the log, once). */
const BLOCKED_RETRY_IN_MS = 24 * 60 * 60 * 1000;

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

  // A post-update that failed in an earlier run (the update is installed, the startup job or the daemon was not refreshed): retried first.
  await retryPendingPostUpdate(deps, globalRoot);

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
      onUpdateAvailable: async (newVersion) => {
        const blocked = readBlocked(deps);
        // An explicit update (`machine cli update` sets UPDATER_FORCE) is a person asking: it goes through. A background run does not install again
        // the version whose last install failed or was rolled back (npm install -g, then a restore, every 30 minutes).
        if (forced || blocked === null || blocked.version !== newVersion) return 'apply-now' as const;
        if (blocked.skipLogged !== true) {
          deps.log('error', `${pkgName} v${newVersion} is not installed automatically: the last attempt ${blocked.error}. It is not retried until a newer version is published; to install it anyway, run: machine cli update`);
          try {
            deps.records.writeBlocked({ ...blocked, skipLogged: true });
          } catch (e) {
            deps.log('error', `${pkgName} cannot update the record of the blocked update: ${message(e)}`);
          }
        }
        return { defer: true as const, retryIn: BLOCKED_RETRY_IN_MS };
      },
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
    if (state.targetVersion !== undefined) {
      const error = state.error ?? 'no reason recorded';
      deps.log('error', `${pkgName} update to v${state.targetVersion} ${state.status}: ${error}. It will not be retried automatically; to try it again, run: machine cli update`);
      try {
        deps.records.writeBlocked({ version: state.targetVersion, error: `${state.status === 'failed' ? 'failed' : 'was rolled back'} (${error})`, timestamp: deps.now() });
      } catch (e) {
        deps.log('error', `${pkgName} cannot record the failed update, so it will be retried automatically: ${message(e)}`);
      }
    }
    deps.stderr(`[fail] update to v${state.targetVersion ?? '?'} ${state.status === 'failed' ? 'failed' : 'was rolled back'}: ${state.error ?? 'no reason recorded'} (state: ${configDir}/update-state.json; log: \`machine cli logs\`)\n`);
    return 1;
  }
  if (state.status !== 'success' || state.targetVersion === undefined || state.targetVersion === currentVersion) return 0;

  try {
    deps.records.clearBlocked();
  } catch (e) {
    deps.log('warn', `${pkgName} cannot clear the record of the blocked update: ${message(e)}`);
  }
  // Before post-update (which may restart the daemon): the daemon consumes update-state.json at its start, and a rollback needs the versions.
  try {
    deps.records.writeLastUpdate({ previousVersion: state.previousVersion ?? currentVersion, targetVersion: state.targetVersion, timestamp: deps.now() });
  } catch (e) {
    deps.log('error', `${pkgName} cannot record the update for a rollback: ${message(e)}`);
    deps.stderr(`[warn] cannot record the update for \`machine cli rollback\` (${message(e)}): once the daemon has started, a rollback needs: npm install -g ${pkgName}@${currentVersion}\n`);
  }
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
    // The daemon starts this process with stdio ignored: the log and the pending record are the only places this reaches a person.
    deps.log('error', `${pkgName} post-update exited with code ${post.code}: ${tail(post.output) || '(no output)'}`);
    try {
      deps.records.writePending({ targetVersion: state.targetVersion, error: tail(post.output) || `exit ${post.code}, no output`, timestamp: deps.now() });
    } catch (e) {
      deps.log('error', `${pkgName} cannot record the failed post-update, so it will not be retried: ${message(e)}`);
    }
    deps.stderr(`[fail] the update is installed, but post-update failed (exit ${post.code}): the startup job or the running daemon may still use v${currentVersion}. Fix the cause above, then run: machine cli post-update\n`);
    return 1;
  }
  try {
    deps.records.clearPending();
  } catch (e) {
    deps.log('warn', `${pkgName} cannot clear the post-update record: ${message(e)}`);
  }
  return 0;
}

function readBlocked(deps: UpdaterMainDeps): ReturnType<UpdateRecords['readBlocked']> {
  try {
    return deps.records.readBlocked();
  } catch (e) {
    deps.log('error', `${deps.pkgName} ${message(e)}`);
    return null;
  }
}

async function retryPendingPostUpdate(deps: UpdaterMainDeps, globalRoot: () => string): Promise<void> {
  const { pkgName } = deps;
  let pending: ReturnType<UpdateRecords['readPending']>;
  try {
    pending = deps.records.readPending();
  } catch (e) {
    deps.log('error', `${pkgName} ${message(e)}`);
    return;
  }
  if (pending === null) return;
  deps.log('info', `${pkgName} retrying the post-update of v${pending.targetVersion} that failed earlier (${pending.error.split('\n')[0]})`);
  let post: { code: number; output: string };
  try {
    post = await deps.spawnPostUpdate(globalRoot());
  } catch (e) {
    post = { code: 1, output: message(e) };
  }
  try {
    if (post.code === 0) {
      deps.records.clearPending();
      deps.log('info', `${pkgName} the post-update of v${pending.targetVersion} succeeded on retry`);
    } else {
      deps.log('error', `${pkgName} the retry of the post-update failed again (exit ${post.code}): ${tail(post.output) || '(no output)'}. Run: machine cli post-update`);
      deps.records.writePending({ ...pending, error: tail(post.output) || `exit ${post.code}, no output`, timestamp: deps.now() });
    }
  } catch (e) {
    deps.log('error', `${pkgName} cannot update the post-update record: ${message(e)}`);
  }
}
