import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLATFORM_TARGETS, platformPackageName } from '../platformBinary.ts';
import { WRAPPER_DIR, platformDir, writeJson } from './packagesWriter.ts';
import { pinPlatformVersions, platformKeys, type PackageJson } from './platformPackages.ts';
import { contentHash, planPublish, platformVersion, requireAllPublished, type PublishPlan } from './publishPlan.ts';

// Hash-reuse publish of the platform packages, then pin of the wrapper (D29). The registry is behind NpmClient:
// tests use a fake, the CLI script (ci/scripts/publish-platform-packages.mjs) uses the real npm.

export interface NpmClient {
  /** Versions of a package already on the registry (empty when the package was never published). */
  versions(name: string): string[];
  /** `npm publish` of the folder; throws on failure. */
  publish(dir: string): void;
}

function readJson(path: string, fix: string): PackageJson {
  if (!existsSync(path)) throw new Error(`${path} not found: ${fix}`);
  return JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
}

export interface PublishOptions {
  /** Output folder of generate-platform-packages. */
  dir: string;
  /** Build version given to generate-platform-packages. */
  buildVersion: string;
  npm: NpmClient;
  /** false: compute and return the plan only (no publish, no pin). */
  publish: boolean;
}

export function publishPlatformPackages(options: PublishOptions): PublishPlan {
  const regenerate = `run generate-platform-packages into ${options.dir}`;
  const wrapperPath = join(options.dir, WRAPPER_DIR, 'package.json');
  const wrapper = readJson(wrapperPath, regenerate);
  // Read the launcher bytes back from the generated platform folders: the hash covers what would be published.
  const binaries: Record<string, Uint8Array> = {};
  for (const key of platformKeys()) {
    const fileName = (PLATFORM_TARGETS[key] as { fileName: string }).fileName;
    const file = join(options.dir, platformDir(key), fileName);
    if (!existsSync(file)) throw new Error(`${file} not found: run generate-platform-packages into ${options.dir}`);
    binaries[key] = readFileSync(file);
  }
  const hash = contentHash(binaries);
  const expected = platformVersion(options.buildVersion, hash);
  for (const key of platformKeys()) {
    const pkg = readJson(join(options.dir, platformDir(key), 'package.json'), `run generate-platform-packages into ${options.dir}`);
    if (pkg.version !== expected) {
      throw new Error(`${platformPackageName(key)} in ${options.dir} has version ${pkg.version} but build ${options.buildVersion} with these launchers gives ${expected}: the folder was generated for another build or its launcher changed; regenerate it`);
    }
  }
  const published: Record<string, string[]> = {};
  for (const key of platformKeys()) published[platformPackageName(key)] = options.npm.versions(platformPackageName(key));
  const first = published[platformPackageName(platformKeys()[0] as string)] as string[];
  const plan = planPublish(options.buildVersion, hash, first);
  if (plan.action === 'reuse') requireAllPublished(plan.version, published);
  if (!options.publish) return plan;
  if (plan.action === 'publish') {
    for (const key of platformKeys()) options.npm.publish(join(options.dir, platformDir(key)));
  }
  const versions = Object.fromEntries(platformKeys().map((k) => [platformPackageName(k), plan.version]));
  writeJson(wrapperPath, pinPlatformVersions(wrapper, versions));
  return plan;
}
