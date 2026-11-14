// machine updater entry point, bundled as machine-updater.cjs next to machine.cjs.
// Spawned by `machine cli update` (UPDATER_FORCE=1, inherited stdio) and, detached with stdio ignored, by the daemon (MACHINE_UPDATER_FROM_DAEMON=1).
// Runs from the install it is about to replace: it must NOT import any machine runtime module (daemon, transport, core, kit).
import { appendLog, execNpm, readState, runUpdater, stateFilePath } from '@wadeck-app/shared-updater';
import { resolveConfigDir } from '../paths.js';
import { resolveSelfCheckTarget } from './selfCheckTarget.js';
import { spawnPostUpdate } from './spawnPostUpdate.js';
import { updaterMain } from './updaterMain.js';
import { createUpdateRecords } from './updateRecords.js';

/** Inlined by the bundler (src/bundle.ts); absent when this file runs from the sources. */
declare const __MACHINE_VERSION__: string | undefined;

const PKG_NAME = '@wadeck-app/machine-cli';

if (typeof __MACHINE_VERSION__ !== 'string') {
  process.stderr.write('[fail] machine-updater runs only from its bundle (npm run bundle): the version is inlined at build time and there is no version to compare from the sources\n');
  process.exit(1);
}

// MACHINE_CONFIG_DIR only: the CLI and the daemon set it from their --config-dir before spawning this process.
const configDir = resolveConfigDir(undefined, process.env);
const stateFile = stateFilePath(configDir);

const log = (level: 'info' | 'warn' | 'error', message: string): void => {
  try {
    appendLog(configDir, level, message);
  } catch {
    // The message is also on stderr when someone is watching; a log that cannot be written must not stop the update.
  }
};

updaterMain({
  pkgName: PKG_NAME,
  configDir,
  currentVersion: __MACHINE_VERSION__,
  env: process.env,
  nodeExe: process.execPath,
  log,
  stderr: (text) => process.stderr.write(text),
  npmRootGlobal: () => execNpm(['root', '-g'], { timeout: 10_000 }),
  resolveTarget: (npmRoot) => resolveSelfCheckTarget(npmRoot, PKG_NAME),
  readState: () => readState(stateFile),
  runUpdater,
  spawnPostUpdate: (npmRoot) => spawnPostUpdate({ nodeExe: process.execPath, npmRoot, configDir, env: process.env, log }),
  now: () => Date.now(),
  records: createUpdateRecords(configDir),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`[fail] machine-updater: unexpected error: ${(e as Error).stack ?? String(e)}\n`);
    process.exitCode = 1;
  },
);
