// `machine cli post-update`: what follows an update or a rollback, run by the NEW install (packaging.md 3.5 step 4). Injectable: no orch, no daemon here.

export interface PostUpdateDeps {
  /** Version of the bundle that runs this code (the one just installed). */
  newVersion: string;
  startup: {
    status: () => Promise<{ exists: boolean }>;
    /** `machine startup enable`: stages the new launcher when the stamp changed and refreshes the job (`orch ensure --restart-if-changed`). */
    enable: () => Promise<{ action: string }>;
  };
  daemon: {
    /** Version the running daemon reports, undefined when no daemon runs. */
    version: () => Promise<string | undefined>;
    /** POST /quit: the daemon exits 0, orch restarts the job. */
    quit: () => Promise<void>;
  };
  say: (line: string) => void;
}

export interface PostUpdateResult {
  startup: 'absent' | 'enabled';
  daemon: 'left-alone' | 'not-running' | 'current' | 'restarted';
}

/**
 * 1. startup job exists: `startup enable`. It does not exist: nothing is changed (decision: only when it exists), and a daemon
 *    started by hand is NOT stopped, since nothing would restart it.
 * 2. a daemon runs a version other than the new one: one quit, orch relaunches the stored command. When step 1 already restarted it
 *    (`--restart-if-changed`) the version matches and nothing is done.
 * Not shared-updater's restartDaemon: it writes config.restart first, which makes the launcher relaunch node itself so orch sees no exit.
 */
export async function postUpdate(deps: PostUpdateDeps): Promise<PostUpdateResult> {
  const { say } = deps;
  let exists: boolean;
  try {
    ({ exists } = await deps.startup.status());
  } catch (e) {
    throw new Error(`cannot read the startup job: ${(e as Error).message}. Run \`machine startup status\` to see why, then \`machine startup enable\``);
  }
  if (!exists) {
    say('[ok] no startup job: nothing to refresh. A daemon you started by hand keeps running the previous version until you restart it (`machine stop`, then start it again)\n');
    return { startup: 'absent', daemon: 'left-alone' };
  }
  try {
    const r = await deps.startup.enable();
    say(`[ok] startup job ${r.action}\n`);
  } catch (e) {
    throw new Error(`startup enable failed: ${(e as Error).message}. The daemon was not touched. Run \`machine startup enable\` yourself once the cause is fixed`);
  }
  const running = await deps.daemon.version();
  if (running === undefined) {
    say('[ok] no daemon running: the next start uses the new version\n');
    return { startup: 'enabled', daemon: 'not-running' };
  }
  if (running === deps.newVersion) {
    say(`[ok] the daemon already runs v${running}\n`);
    return { startup: 'enabled', daemon: 'current' };
  }
  try {
    await deps.daemon.quit();
  } catch (e) {
    throw new Error(`the daemon (v${running}) did not accept the restart: ${(e as Error).message}. Restart it yourself: \`machine stop\` (orch starts it again from the job)`);
  }
  say(`[ok] daemon v${running} asked to quit: orch restarts it with v${deps.newVersion}\n`);
  return { startup: 'enabled', daemon: 'restarted' };
}
