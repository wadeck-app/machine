import { spawn } from 'node:child_process';
import { resolveSelfCheckTarget } from './selfCheckTarget.js';

export const POST_UPDATE_TIMEOUT_MS = 120_000;
const PKG_NAME = '@wadeck-app/machine-cli';

/**
 * Runs `node <bin.machine of the new install> cli post-update`, so that a fix of the post-update logic applies to the very update that
 * installs it (the old code would otherwise run it). The entry is the one the self-check runs (resolveSelfCheckTarget: bin.machine).
 * The configuration directory is handed over through MACHINE_CONFIG_DIR: the child resolves its directory from the environment only.
 * Killed after `timeoutMs` (a stuck orch or daemon call must not hold the updater, and its lock, forever). Never throws: a failure is
 * `code` + `output`. The updater runs detached with stdio ignored, so `log` (the file `machine cli logs` shows) is the only trace.
 */
export function spawnPostUpdate(opts: {
  nodeExe: string;
  npmRoot: string;
  configDir: string;
  env: Record<string, string | undefined>;
  timeoutMs?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}): Promise<{ code: number; output: string }> {
  const log = opts.log ?? (() => undefined);
  const timeoutMs = opts.timeoutMs ?? POST_UPDATE_TIMEOUT_MS;
  const resolved = resolveSelfCheckTarget(opts.npmRoot, PKG_NAME);
  if (!resolved.ok) {
    return Promise.resolve({ code: 1, output: `[fail] cannot find the entry point of the new install: ${resolved.reason}. The new install is incomplete. Reinstall with: npm install -g ${PKG_NAME}@latest\n` });
  }
  const bin = resolved.target;
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (code: number, extra = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log(code === 0 ? 'info' : 'error', `post-update done: exit ${code}`);
      resolve({ code, output: output + extra });
    };
    log('info', `post-update started: ${opts.nodeExe} ${bin} cli post-update (timeout ${Math.round(timeoutMs / 1000)}s)`);
    const child = spawn(opts.nodeExe, [bin, 'cli', 'post-update'], {
      env: { ...opts.env, MACHINE_CONFIG_DIR: opts.configDir } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(1, `[fail] post-update did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped: the startup job or the running daemon may still use the previous version. Run: machine cli post-update\n`);
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.on('error', (e) => finish(1, `[fail] cannot start ${opts.nodeExe} ${bin}: ${e.message}\n`));
    child.on('close', (code) => finish(code ?? 1));
  });
}
