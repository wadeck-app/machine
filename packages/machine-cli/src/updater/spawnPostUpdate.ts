import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Runs `node <npm root>/@wadeck-app/machine-cli/bin/machine.js cli post-update` of the NEW install, so that a fix of the post-update
 * logic applies to the very update that installs it (the old code would otherwise run it). The configuration directory is handed over
 * through MACHINE_CONFIG_DIR: the child resolves its directory from the environment only. Never throws: a failure is `code` + `output`.
 */
export function spawnPostUpdate(opts: { nodeExe: string; npmRoot: string; configDir: string; env: Record<string, string | undefined> }): Promise<{ code: number; output: string }> {
  const bin = join(opts.npmRoot, '@wadeck-app', 'machine-cli', 'bin', 'machine.js');
  if (!existsSync(bin)) return Promise.resolve({ code: 1, output: `[fail] ${bin} does not exist: the new install is incomplete. Reinstall with: npm install -g @wadeck-app/machine-cli@latest\n` });
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(opts.nodeExe, [bin, 'cli', 'post-update'], {
      env: { ...opts.env, MACHINE_CONFIG_DIR: opts.configDir } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.on('error', (e) => resolve({ code: 1, output: `${output}[fail] cannot start ${opts.nodeExe} ${bin}: ${e.message}\n` }));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}
