import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isReleaseVersion } from '@wadeck-app/shared-cli/ReleaseVersion';
import { PLATFORM_TARGETS, platformKey, platformPackageName, type AbsentLauncher, type FoundLauncher } from './platformBinary.js';

// `machine cli self-check` (packaging.md 3.4). Run by node (never the launcher) from the NEW install, by the updater, before the update is accepted:
// a failure makes shared-updater restore the previous version. No identity access and no passphrase: it must run unattended.

export interface SelfCheckDeps {
  version: string;
  configDir: string;
  /** process.version */
  nodeVersion: string;
  platform: string;
  arch: string;
  /** package.json of the wrapper (the folder of the bundle); throws when unreadable. */
  wrapperManifest: () => { optionalDependencies?: Record<string, string> };
  findLauncher: () => FoundLauncher | AbsentLauncher;
  /** Version the running daemon reports, undefined when none runs; may throw. */
  daemonVersion: () => Promise<string | undefined>;
}

export interface SelfCheckResult {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
}

const MIN_NODE_MAJOR = 22;

/** Creates and removes a probe file in `dir`: proves the folder can be created and written, without leaving a trace. */
function probeWritable(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const probe = join(dir, `.self-check-${process.pid}`);
  writeFileSync(probe, '');
  rmSync(probe, { force: true });
}

export async function runSelfCheck(deps: SelfCheckDeps): Promise<SelfCheckResult> {
  const checks: SelfCheckResult['checks'] = [];
  const add = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  };

  add('version', isReleaseVersion(deps.version), isReleaseVersion(deps.version) ? undefined : `${deps.version} is not a release version (CalVer YYYY.MM.DD-BBB-hash): this is a development build, not an installed release`);

  const major = Number(/^v?(\d+)\./.exec(deps.nodeVersion)?.[1]);
  const nodeOk = Number.isInteger(major) && major >= MIN_NODE_MAJOR;
  add('node', nodeOk, nodeOk ? undefined : `node ${deps.nodeVersion} is too old (or unreadable): machine needs Node ${MIN_NODE_MAJOR} or newer`);

  try {
    probeWritable(deps.configDir);
    add('config-dir', true);
  } catch (e) {
    add('config-dir', false, `the configuration directory ${deps.configDir} cannot be created or written (${(e as Error).message}): check the folder permissions, or set MACHINE_CONFIG_DIR to a writable one`);
  }

  const binDir = join(deps.configDir, 'bin');
  try {
    probeWritable(binDir);
    add('staged-launcher', true);
  } catch (e) {
    add('staged-launcher', false, `the folder of the staged launcher ${binDir} cannot be created or written (${(e as Error).message}): \`machine startup enable\` could not stage the launcher`);
  }

  const key = platformKey(deps.platform, deps.arch);
  if (PLATFORM_TARGETS[key] === undefined) {
    // The reason goes in the NAME: only a failure prints its detail, so a skip must be visible without one.
    add(`platform-package (skipped: ${key} is not a published target)`, true);
  } else {
    const pkg = platformPackageName(key);
    try {
      const found = deps.findLauncher();
      if (found.kind === 'absent') {
        add('platform-package', false, `${found.reason}: npm skips a failing optional dependency in silence. Reinstall with \`npm install -g @wadeck-app/machine-cli\``);
      } else {
        const pin = deps.wrapperManifest().optionalDependencies?.[pkg];
        if (pin === undefined) add('platform-package', false, `the wrapper package.json declares no exact pin for ${pkg}`);
        else if (pin !== found.stamp) add('platform-package', false, `the wrapper pins ${pkg} ${pin} but ${found.stamp} is installed: reinstall with \`npm install -g @wadeck-app/machine-cli\``);
        else add('platform-package', true);
      }
    } catch (e) {
      add('platform-package', false, (e as Error).message);
    }
  }

  // Information only: the daemon still runs the previous version at this point (post-update restarts it).
  try {
    const running = await deps.daemonVersion();
    add(running === undefined ? 'daemon: not running' : `daemon: running v${running}`, true);
  } catch (e) {
    add(`daemon: not queried (${(e as Error).message})`, true);
  }

  return { ok: checks.every((c) => c.ok), checks };
}
