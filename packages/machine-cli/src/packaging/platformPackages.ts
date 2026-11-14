import { PLATFORM_TARGETS, platformPackageName } from '../platformBinary.ts';

// Pure generation of the publishable package.json files (spec: packaging.md sections 3.1-3.3, D29).
// The platform table is PLATFORM_TARGETS (platformBinary.ts): one source, no second list.

export const WRAPPER_PACKAGE = '@wadeck-app/machine-cli';
export const REGISTRY = 'https://npm.pkg.github.com';
/** Placeholder written by the generator; the pin step replaces every one with an exact version. */
export const UNPINNED = 'latest';

const OS_OF: Record<string, string> = { win32: 'win32', darwin: 'darwin', linux: 'linux' };

// Exact semver (no range, no `v`, no build metadata). CalVer `2026.11.14-001-abcd1234` and `-bin.<hash>` suffixes are valid prereleases.
const EXACT_SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

export function assertExactVersion(version: string, what: string): void {
  if (!EXACT_SEMVER.test(version)) {
    throw new Error(`${what}: "${version}" is not an exact version (expected e.g. 2026.11.14-001-abcd1234); a range or an empty value cannot be published or pinned: pass the exact version`);
  }
}

export function platformKeys(): string[] {
  return Object.keys(PLATFORM_TARGETS);
}

export function splitKey(key: string): { os: string; cpu: string } {
  const [os, cpu] = key.split('-');
  const mapped = os === undefined ? undefined : OS_OF[os];
  if (mapped === undefined || (cpu !== 'x64' && cpu !== 'arm64')) {
    throw new Error(`platform key "${key}" is not "<os>-<cpu>" with os in ${Object.keys(OS_OF).join('/')} and cpu x64/arm64: fix PLATFORM_TARGETS in src/platformBinary.ts`);
  }
  return { os: mapped, cpu };
}

export interface PackageJson {
  name: string;
  version: string;
  [field: string]: unknown;
}

export function platformPackageJson(key: string, version: string): PackageJson {
  assertExactVersion(version, `platform package ${key}`);
  const target = PLATFORM_TARGETS[key];
  if (target === undefined) {
    throw new Error(`unknown platform "${key}": supported ${platformKeys().join(', ')}`);
  }
  const { os, cpu } = splitKey(key);
  return {
    name: platformPackageName(key),
    version,
    description: `Native launcher of machine for ${key}. Installed through ${WRAPPER_PACKAGE}; not meant to be installed by hand.`,
    os: [os],
    cpu: [cpu],
    files: [target.fileName],
    publishConfig: { registry: REGISTRY, access: 'public' },
  };
}

export interface WrapperOptions {
  version: string;
  /** Files and folders (relative to the package) that the wrapper ships, beside bin/machine.js. */
  files: string[];
  /** Exact version per platform package name; defaults to UNPINNED for every platform. */
  pins?: Record<string, string>;
}

export function wrapperPackageJson(options: WrapperOptions): PackageJson {
  assertExactVersion(options.version, 'wrapper package');
  const optionalDependencies: Record<string, string> = {};
  for (const key of platformKeys()) {
    const name = platformPackageName(key);
    const pin = options.pins?.[name] ?? UNPINNED;
    if (pin !== UNPINNED) assertExactVersion(pin, `pin of ${name}`);
    optionalDependencies[name] = pin;
  }
  return {
    name: WRAPPER_PACKAGE,
    version: options.version,
    description: 'machine: run commands on your own machines under an admin-signed allowlist.',
    type: 'commonjs',
    bin: { machine: 'bin/machine.js' },
    files: ['bin/machine.js', ...options.files],
    engines: { node: '>=22' },
    optionalDependencies,
    publishConfig: { registry: REGISTRY, access: 'public' },
  };
}

/**
 * Replace every optionalDependencies entry of the wrapper with the exact version of that platform package.
 * Fails when a platform package has no version, when a version is not exact, or when the map names a package the wrapper does not list.
 */
export function pinPlatformVersions(wrapper: PackageJson, versions: Record<string, string>): PackageJson {
  const current = wrapper.optionalDependencies as Record<string, string> | undefined;
  if (current === undefined || Object.keys(current).length === 0) {
    throw new Error(`${wrapper.name} has no optionalDependencies: regenerate it with generate-platform-packages`);
  }
  const pinned: Record<string, string> = {};
  for (const name of Object.keys(current)) {
    const version = versions[name];
    if (version === undefined) {
      throw new Error(`no version given for ${name}: pass every platform version (${Object.keys(current).join(', ')})`);
    }
    assertExactVersion(version, `pin of ${name}`);
    pinned[name] = version;
  }
  for (const name of Object.keys(versions)) {
    if (!(name in current)) {
      throw new Error(`${name} is not an optional dependency of ${wrapper.name} (${Object.keys(current).join(', ')}): remove it or fix the platform table`);
    }
  }
  return { ...wrapper, optionalDependencies: pinned };
}
