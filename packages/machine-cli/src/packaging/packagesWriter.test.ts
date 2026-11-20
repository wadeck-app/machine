import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLATFORM_TARGETS, platformPackageName } from '../platformBinary.ts';
import { generatePackages, readLaunchers } from './packagesWriter.ts';
import { publishPlatformPackages, type NpmClient } from './publishFlow.ts';
import { platformVersion, contentHash } from './publishPlan.ts';

const BUILD = '2026.11.14-003-cafebabe';
let root: string;
let launchers: string;
let bundle: string;
let out: string;
const SHIM = join(__dirname, '..', '..', 'ci', 'templates', 'bin-machine.cjs');
const README = join(__dirname, '..', '..', '..', '..', 'README.md');

function seed(): void {
  for (const [key, t] of Object.entries(PLATFORM_TARGETS)) {
    mkdirSync(join(launchers, key), { recursive: true });
    writeFileSync(join(launchers, key, t.fileName), `launcher ${key}`);
  }
  writeFileSync(join(bundle, 'machine.cjs'), '// bundle');
  writeFileSync(join(bundle, 'machine-updater.cjs'), '// updater');
  mkdirSync(join(bundle, 'app-module'), { recursive: true });
  writeFileSync(join(bundle, 'app-module', 'manifest.json'), '{}');
}
const json = (p: string): Record<string, unknown> => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
const opts = (over = {}) => ({ outDir: out, version: BUILD, launcherDir: launchers, bundleDir: bundle, shimPath: SHIM, readmePath: README, strict: true, ...over });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'machine-pkg-'));
  launchers = join(root, 'launchers');
  bundle = join(root, 'bundle');
  out = join(root, 'out');
  mkdirSync(bundle, { recursive: true });
  seed();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('generatePackages', () => {
  it('writes the wrapper and one package per platform with the hash version', () => {
    const { warnings } = generatePackages(opts());
    expect(warnings).toEqual([]);
    const version = platformVersion(BUILD, contentHash(readLaunchers(launchers)));
    for (const [key, t] of Object.entries(PLATFORM_TARGETS)) {
      const dir = join(out, `machine-cli-${key}`);
      expect(json(join(dir, 'package.json')).name).toBe(platformPackageName(key));
      expect(json(join(dir, 'package.json')).version).toBe(version);
      expect(readFileSync(join(dir, t.fileName), 'utf8')).toBe(`launcher ${key}`);
    }
    const wrapper = join(out, 'machine-cli-dist');
    expect(json(join(wrapper, 'package.json')).version).toBe(BUILD);
    expect(existsSync(join(wrapper, 'bin', 'machine.js'))).toBe(true);
    expect(existsSync(join(wrapper, 'machine.cjs'))).toBe(true);
    expect(existsSync(join(wrapper, 'machine-updater.cjs'))).toBe(true);
    expect(existsSync(join(wrapper, 'app-module', 'manifest.json'))).toBe(true);
    expect(json(join(wrapper, 'package.json')).files).toEqual(['bin/machine.js', 'machine.cjs', 'machine-updater.cjs', 'app-module']);
  });

  it('copies the root README.md into the wrapper (the npm package page) and fails when it is missing', () => {
    generatePackages(opts());
    expect(readFileSync(join(out, 'machine-cli-dist', 'README.md'), 'utf8')).toBe(readFileSync(README, 'utf8'));
    rmSync(out, { recursive: true });
    expect(() => generatePackages(opts({ readmePath: join(root, 'absent.md') }))).toThrow(/absent\.md.*not found/s);
  });

  it.skipIf(process.platform === 'win32')('sets the exec bit on the Unix launchers', () => {
    generatePackages(opts());
    expect(statSync(join(out, 'machine-cli-linux-x64', 'machine')).mode & 0o111).not.toBe(0);
  });

  it('fails when a launcher is missing, naming the build command', () => {
    rmSync(join(launchers, 'linux-x64'), { recursive: true });
    expect(() => generatePackages(opts())).toThrow(/linux-x64.*not found.*build-launcher/s);
  });

  it('fails when the bundle is missing', () => {
    rmSync(join(bundle, 'machine.cjs'));
    expect(() => generatePackages(opts())).toThrow(/machine\.cjs.*npm run bundle/s);
  });

  it('strict: a missing updater or app-module is an error; not strict: a warning and absent from files', () => {
    rmSync(join(bundle, 'machine-updater.cjs'));
    expect(() => generatePackages(opts())).toThrow(/machine-updater\.cjs.*WP9\.5/s);
    const { warnings } = generatePackages(opts({ strict: false }));
    expect(warnings.join('\n')).toMatch(/machine-updater\.cjs/);
    expect(json(join(out, 'machine-cli-dist', 'package.json')).files).not.toContain('machine-updater.cjs');
  });

  it('an app-module without manifest.json is an error', () => {
    rmSync(join(bundle, 'app-module', 'manifest.json'));
    expect(() => generatePackages(opts())).toThrow(/manifest\.json/);
  });

  it('refuses an existing output folder rather than mixing generations', () => {
    mkdirSync(out);
    expect(() => generatePackages(opts())).toThrow(/already exists/);
  });
});

function fakeNpm(published: Record<string, string[]>): NpmClient & { published: string[] } {
  const done: string[] = [];
  return {
    published: done,
    versions: (name) => published[name] ?? [],
    publish: (dir) => {
      done.push(dir);
    },
  };
}

describe('publishPlatformPackages', () => {
  beforeEach(() => {
    generatePackages(opts());
  });

  it('publishes the three platform packages when no version has this hash, then pins the wrapper', () => {
    const npm = fakeNpm({});
    const plan = publishPlatformPackages({ dir: out, buildVersion: BUILD, npm, publish: true });
    expect(plan.action).toBe('publish');
    expect(npm.published).toHaveLength(3);
    const pins = json(join(out, 'machine-cli-dist', 'package.json')).optionalDependencies as Record<string, string>;
    expect(Object.values(pins)).toEqual([plan.version, plan.version, plan.version]);
  });

  it('reuses a published version with the same hash: nothing published, wrapper pinned to it', () => {
    const hash = contentHash(readLaunchers(launchers));
    const old = `2026.11.01-001-aaaaaaaa-bin.${hash}`;
    const npm = fakeNpm(Object.fromEntries(Object.keys(PLATFORM_TARGETS).map((k) => [platformPackageName(k), [old]])));
    const plan = publishPlatformPackages({ dir: out, buildVersion: BUILD, npm, publish: true });
    expect(plan).toEqual({ version: old, action: 'reuse' });
    expect(npm.published).toEqual([]);
    const pins = json(join(out, 'machine-cli-dist', 'package.json')).optionalDependencies as Record<string, string>;
    expect(Object.values(pins)).toEqual([old, old, old]);
  });

  it('fails on a half published reuse', () => {
    const hash = contentHash(readLaunchers(launchers));
    const old = `2026.11.01-001-aaaaaaaa-bin.${hash}`;
    const npm = fakeNpm({ [platformPackageName('win32-x64')]: [old] });
    expect(() => publishPlatformPackages({ dir: out, buildVersion: BUILD, npm, publish: true })).toThrow(/not published for/);
  });

  it('without publish: plans only, publishes nothing, leaves the wrapper unpinned', () => {
    const npm = fakeNpm({});
    publishPlatformPackages({ dir: out, buildVersion: BUILD, npm, publish: false });
    expect(npm.published).toEqual([]);
    const pins = json(join(out, 'machine-cli-dist', 'package.json')).optionalDependencies as Record<string, string>;
    expect(Object.values(pins)).toEqual(['latest', 'latest', 'latest']);
  });

  it('fails when the folder was generated for another build version', () => {
    const npm = fakeNpm({});
    expect(() => publishPlatformPackages({ dir: out, buildVersion: '2026.11.15-001-deadbeef', npm, publish: true })).toThrow(/generated for|version/);
    expect(npm.published).toEqual([]);
  });

  it('fails when the generated folder is missing', () => {
    expect(() => publishPlatformPackages({ dir: join(root, 'nope'), buildVersion: BUILD, npm: fakeNpm({}), publish: true })).toThrow(/generate-platform-packages/);
  });
});
