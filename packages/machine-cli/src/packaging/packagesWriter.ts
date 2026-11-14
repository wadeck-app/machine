import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLATFORM_TARGETS } from '../platformBinary.ts';
import { platformKeys, platformPackageJson, wrapperPackageJson, type PackageJson } from './platformPackages.ts';
import { contentHash, platformVersion } from './publishPlan.ts';

// Writes the publishable folders (spec: packaging.md 3.3): <out>/machine-cli-dist (wrapper) and <out>/machine-cli-<key> per platform.
// Input: dist-launcher/<key>/<file> from ci/scripts/build-launcher.sh and the bundle folder (machine.cjs, machine-updater.cjs, app-module/).

export const WRAPPER_DIR = 'machine-cli-dist';
export const platformDir = (key: string): string => `machine-cli-${key}`;

/** Reads dist-launcher/<key>/<file> for every platform; throws naming the missing file and the build command. */
export function readLaunchers(launcherDir: string): Record<string, Uint8Array> {
  const result: Record<string, Uint8Array> = {};
  for (const key of platformKeys()) {
    const file = join(launcherDir, key, (PLATFORM_TARGETS[key] as { fileName: string }).fileName);
    if (!existsSync(file)) {
      throw new Error(`launcher ${file} not found: build it first (packages/machine-cli/ci/scripts/build-launcher.sh --platforms ${platformKeys().join(',')})`);
    }
    result[key] = readFileSync(file);
  }
  return result;
}

export interface GenerateOptions {
  outDir: string;
  /** Build version (CalVer) of the wrapper. */
  version: string;
  launcherDir: string;
  bundleDir: string;
  /** ci/templates/bin-machine.cjs */
  shimPath: string;
  /** CI: a missing updater or app-module is an error; locally it is a warning and the file is left out. */
  strict: boolean;
}

export function writeJson(path: string, value: PackageJson): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function generatePackages(options: GenerateOptions): { warnings: string[] } {
  const warnings: string[] = [];
  if (existsSync(options.outDir)) {
    throw new Error(`${options.outDir} already exists: delete it first, generated folders are never merged`);
  }
  if (!existsSync(options.shimPath)) throw new Error(`shim ${options.shimPath} not found: it ships at packages/machine-cli/ci/templates/bin-machine.cjs`);
  const bundle = join(options.bundleDir, 'machine.cjs');
  if (!existsSync(bundle)) throw new Error(`${bundle} not found: run npm run bundle (BUNDLE_VERSION=<version> node packages/machine-cli/scripts/bundle.mjs --out ${bundle})`);

  // Validate everything before the first write: a failure leaves no half generated output.
  const launchers = readLaunchers(options.launcherDir);
  const version = platformVersion(options.version, contentHash(launchers));
  const files = ['machine.cjs'];
  const updater = join(options.bundleDir, 'machine-updater.cjs');
  if (existsSync(updater)) files.push('machine-updater.cjs');
  else missing(options.strict, warnings, `${updater} not found: the updater entry is not built yet (WP9.5); without it \`machine cli update\` cannot work`);
  const appModule = join(options.bundleDir, 'app-module');
  if (existsSync(appModule)) {
    if (!existsSync(join(appModule, 'manifest.json'))) throw new Error(`${join(appModule, 'manifest.json')} not found: the app-module build is incomplete (rebuild app-module-machine)`);
    files.push('app-module');
  } else {
    missing(options.strict, warnings, `${appModule} not found: the app-module is not copied into the bundle yet (WP9.7)`);
  }

  mkdirSync(options.outDir, { recursive: true });
  for (const key of platformKeys()) {
    const fileName = (PLATFORM_TARGETS[key] as { fileName: string }).fileName;
    const dir = join(options.outDir, platformDir(key));
    mkdirSync(dir);
    writeJson(join(dir, 'package.json'), platformPackageJson(key, version));
    const target = join(dir, fileName);
    copyFileSync(join(options.launcherDir, key, fileName), target);
    if (!fileName.endsWith('.exe')) chmodSync(target, 0o755);
  }
  const wrapperDir = join(options.outDir, WRAPPER_DIR);
  mkdirSync(join(wrapperDir, 'bin'), { recursive: true });
  writeJson(join(wrapperDir, 'package.json'), wrapperPackageJson({ version: options.version, files }));
  copyFileSync(options.shimPath, join(wrapperDir, 'bin', 'machine.js'));
  chmodSync(join(wrapperDir, 'bin', 'machine.js'), 0o755);
  for (const f of files) cpSync(join(options.bundleDir, f), join(wrapperDir, f), { recursive: true });
  return { warnings };
}

function missing(strict: boolean, warnings: string[], message: string): void {
  if (strict) throw new Error(`${message} (strict mode; pass --no-strict only for a local build)`);
  warnings.push(message);
}
