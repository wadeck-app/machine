import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLATFORM_TARGETS, platformPackageName } from '../platformBinary.ts';

// T5/T6 of packaging.md: the real scripts, run in a temp folder; npm pack --dry-run needs no registry and no network.
const scripts = resolve(import.meta.dirname, '..', '..', 'ci', 'scripts');
const BUILD = '2026.11.14-003-cafebabe';
let root: string;

function node(script: string, args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [join(scripts, script), ...args], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'machine-pkgscripts-'));
  for (const [key, t] of Object.entries(PLATFORM_TARGETS)) {
    mkdirSync(join(root, 'launchers', key), { recursive: true });
    writeFileSync(join(root, 'launchers', key, t.fileName), `launcher ${key}`);
  }
  mkdirSync(join(root, 'bundle', 'app-module'), { recursive: true });
  writeFileSync(join(root, 'bundle', 'machine.cjs'), '//');
  writeFileSync(join(root, 'bundle', 'machine-updater.cjs'), '//');
  writeFileSync(join(root, 'bundle', 'app-module', 'manifest.json'), '{}');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const gen = (extra: string[] = []) => node('generate-platform-packages.mjs', ['--out', join(root, 'out'), '--version', BUILD, '--launchers', join(root, 'launchers'), '--bundle-dir', join(root, 'bundle'), ...extra]);

describe('generate and pin scripts', () => {
  it('generate, then pin: exact pins, no placeholder, no range', () => {
    const g = gen();
    expect(g.out).toContain('[ok]');
    expect(g.status).toBe(0);
    const wrapperPath = join(root, 'out', 'machine-cli-dist', 'package.json');
    const p = node('pin-platform-versions.mjs', ['--wrapper', join(root, 'out', 'machine-cli-dist'), '--version', `${BUILD}-bin.0123456789ab`]);
    expect(p.out).toContain('[ok]');
    const pkg = JSON.parse(readFileSync(wrapperPath, 'utf8')) as { optionalDependencies: Record<string, string>; private?: boolean };
    for (const key of Object.keys(PLATFORM_TARGETS)) expect(pkg.optionalDependencies[platformPackageName(key)]).toBe(`${BUILD}-bin.0123456789ab`);
    expect(JSON.stringify(pkg)).not.toMatch(/>=0\.0\.0-0|latest/);
    expect(pkg.private).toBeUndefined();
  });

  it('generate fails loudly (exit 1, cause and fix) when a launcher is missing', () => {
    rmSync(join(root, 'launchers', 'darwin-arm64'), { recursive: true });
    const g = gen();
    expect(g.status).toBe(1);
    expect(g.out).toMatch(/\[fail\].*darwin-arm64.*build-launcher/s);
  });

  it('generate without --out / --version / with a typo names the usage', () => {
    for (const args of [[], ['--out', join(root, 'x')], ['--bogus']]) {
      const g = node('generate-platform-packages.mjs', args);
      expect(g.status).toBe(1);
      expect(g.out).toMatch(/\[fail\].*usage/);
    }
  });

  it('pin refuses a range', () => {
    gen();
    const p = node('pin-platform-versions.mjs', ['--wrapper', join(root, 'out', 'machine-cli-dist'), '--version', '^1.0.0']);
    expect(p.status).toBe(1);
    expect(p.out).toMatch(/not an exact version/);
  });

  it('publish script refuses missing arguments before any network access', () => {
    const r = node('publish-platform-packages.mjs', ['--dir', root]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/usage/);
  });

  it('npm pack --dry-run of each generated folder lists the expected files', () => {
    gen();
    for (const key of Object.keys(PLATFORM_TARGETS)) {
      const files = packList(join(root, 'out', `machine-cli-${key}`));
      expect(files).toEqual(['package.json', (PLATFORM_TARGETS[key] as { fileName: string }).fileName].sort());
    }
    const wrapper = packList(join(root, 'out', 'machine-cli-dist'));
    expect(wrapper).toEqual(['app-module/manifest.json', 'bin/machine.js', 'machine-updater.cjs', 'machine.cjs', 'package.json']);
  });
});

function packList(dir: string): string[] {
  // shell: true because npm is npm.cmd on Windows; the arguments are fixed.
  const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: dir, encoding: 'utf8', shell: true });
  if (r.status !== 0) throw new Error(`npm pack --dry-run failed in ${dir}: ${r.stderr}${r.stdout}`);
  const parsed = JSON.parse(r.stdout) as Array<{ files: Array<{ path: string }> }>;
  return (parsed[0] as { files: Array<{ path: string }> }).files.map((f) => f.path.replaceAll('\\', '/')).sort();
}
