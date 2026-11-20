import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// `npm run bundle` (scripts/bundle.mjs): the single-file CommonJS bundle at <repo>/dist/machine.cjs. The test builds
// into a temp folder (--out) so that it never overwrites the bundle the user installed from.

const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/bundle.mjs', import.meta.url));
const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string; scripts: Record<string, string> };
const rootPackageJson = JSON.parse(readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8')) as { scripts: Record<string, string> };

let root: string;
let bundle: string;
let output: string;

async function machine(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return run(process.execPath, [bundle, ...args], { windowsHide: true, timeout: 60_000 });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-bundle-script-'));
  bundle = join(root, 'out', 'machine.cjs');
  // BUNDLE_VERSION must not leak in from the caller: it would change what the default build inlines.
  const env = { ...process.env };
  delete env.BUNDLE_VERSION;
  output = (await run(process.execPath, [script, '--out', bundle], { windowsHide: true, timeout: 60_000, env })).stdout;
}, 90_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the bundle script', () => {
  it('writes the single file where --out says, and says where and how big', () => {
    expect(existsSync(bundle)).toBe(true);
    expect(output).toContain(bundle);
    expect(output).toContain(`${statSync(bundle).size} bytes`);
  });

  it('inlines the version of package.json', async () => {
    expect(output).toContain(packageJson.version);
    const dir = join(root, 'cfg');
    await machine('init', '--name', 'bundled', '--config-dir', dir);
    expect((await machine('status', '--config-dir', dir)).stdout).toContain(`version: ${packageJson.version}`);
  });

  it('BUNDLE_VERSION wins over package.json and is the version the bundle reports (CI sets it, as queue does)', async () => {
    const out = join(root, 'ci', 'machine.cjs');
    const calver = '2026.11.14-592-abcdef12';
    const r = await run(process.execPath, [script, '--out', out], { windowsHide: true, timeout: 60_000, env: { ...process.env, BUNDLE_VERSION: calver } });
    expect(r.stdout).toContain(calver);
    const dir = join(root, 'cfg-ci');
    await run(process.execPath, [out, 'init', '--name', 'ci', '--config-dir', dir], { windowsHide: true, timeout: 60_000 });
    const status = await run(process.execPath, [out, 'status', '--config-dir', dir], { windowsHide: true, timeout: 60_000 });
    expect(status.stdout).toContain(`version: ${calver}`);
  });

  it('an empty BUNDLE_VERSION fails loudly instead of falling back to package.json', async () => {
    const e = (await run(process.execPath, [script, '--out', join(root, 'empty', 'machine.cjs')], { windowsHide: true, timeout: 60_000, env: { ...process.env, BUNDLE_VERSION: '' } }).catch((x: unknown) => x)) as { code?: number; stderr?: string };
    expect(e.code).toBe(1);
    expect(e.stderr).toMatch(/BUNDLE_VERSION is set but empty/);
  });

  // The updater bundle (WP9.5): machine-updater.cjs next to machine.cjs, spawned by `cli update` and by the daemon.
  describe('the updater bundle', () => {
    const updater = () => join(root, 'out', 'machine-updater.cjs');
    const UPDATER_CAP_BYTES = 500 * 1024;

    it('is written next to the bundle and is announced by the script', () => {
      expect(existsSync(updater())).toBe(true);
      expect(output).toContain(updater());
    });

    it('stays under 500 KB', () => {
      expect(statSync(updater()).size).toBeLessThan(UPDATER_CAP_BYTES);
    });

    it('imports nothing of the runtime: it runs from the install it is about to replace', () => {
      const text = readFileSync(updater(), 'utf8');
      // Identifiers and package names that only the daemon and the CLI bring in.
      for (const marker of ['startMachineDaemon', 'makeCommands', 'machine-transport', 'machine-core', 'machine-exec', 'singleton-daemon-kit']) {
        expect(text, marker).not.toContain(marker);
      }
      // A bundle is self-contained: no require of a file next to it.
      expect(text).not.toMatch(/require\(["']\.\.?\//);
    });

    it('has the version inlined', () => {
      expect(readFileSync(updater(), 'utf8')).toContain(JSON.stringify(packageJson.version));
    });

    it('BUNDLE_VERSION wins for the updater too', async () => {
      const out = join(root, 'ci2', 'machine.cjs');
      const calver = '2026.11.14-593-abcdef12';
      await run(process.execPath, [script, '--out', out], { windowsHide: true, timeout: 60_000, env: { ...process.env, BUNDLE_VERSION: calver } });
      expect(readFileSync(join(root, 'ci2', 'machine-updater.cjs'), 'utf8')).toContain(JSON.stringify(calver));
    });

    // Both refusals happen before any npm call, so this runs the real bundle with no risk for the install.
    it('a development build refuses: exit 0 in the background (the reason goes to the log), exit 1 when forced', async () => {
      const cfg = join(root, 'cfg-updater');
      const base: NodeJS.ProcessEnv = { ...process.env, MACHINE_CONFIG_DIR: cfg };
      delete base.UPDATER_FORCE;
      const quiet = await run(process.execPath, [updater()], { windowsHide: true, timeout: 60_000, env: base });
      expect(quiet.stderr).toBe('');
      // MACHINE_CONFIG_DIR decides where the updater logs (the daemon hands its --config-dir over this way).
      expect(readFileSync(join(cfg, 'logs', `${new Date().toISOString().slice(0, 10)}.ndjson`), 'utf8')).toMatch(/dev build/);
      const forced = (await run(process.execPath, [updater()], { windowsHide: true, timeout: 60_000, env: { ...base, UPDATER_FORCE: '1' } }).catch((x: unknown) => x)) as { code?: number; stderr?: string };
      expect(forced.code).toBe(1);
      expect(forced.stderr).toMatch(/\[fail\].*dev build.*machine cli update/);
    });

  });

  it('runs --help', async () => {
    const r = await machine('--help');
    expect(r.stdout).toContain('startup [status | enable | disable]');
  });

  it('has an npm run bundle in the package and at the root', () => {
    expect(packageJson.scripts.bundle).toBeDefined();
    expect(rootPackageJson.scripts.bundle).toMatch(/bundle/);
  });

  it('writes dist/machine.cjs at the repo root by default, and dist/ is git-ignored', () => {
    expect(readFileSync(fileURLToPath(new URL('../scripts/bundle.mjs', import.meta.url)), 'utf8')).toMatch(/dist.*machine\.cjs/s);
    expect(readFileSync(fileURLToPath(new URL('../../../.gitignore', import.meta.url)), 'utf8').split(/\r?\n/)).toContain('dist/');
  });
});
