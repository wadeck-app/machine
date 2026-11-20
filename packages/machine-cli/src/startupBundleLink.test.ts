import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import * as realFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli } from './testing.js';
import { makeOrchStub, type OrchStub } from './orchStub.js';
import { platformPackageName } from './platformBinary.js';
import { postUpdate } from './postUpdate.js';
import { enableStartup, startupStatus, type StartupContext } from './startup.js';

// The Windows junction of the staged launcher folder, wired into enable / status / post-update (bundleLink.ts). Stub orch, fake platform package,
// temp folders only: the real orch job and the real configuration folder are never touched.

const notFound = (): string => {
  throw Object.assign(new Error('not found'), { code: 'MODULE_NOT_FOUND' });
};

describe.runIf(process.platform === 'win32')('node_modules junction of the staged launcher (enable, status, post-update)', () => {
  let root: string;
  let configDir: string;
  let stub: OrchStub;
  let modules: string;
  let bundle: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'machine-startup-link-'));
    configDir = join(root, 'config');
    mkdirSync(configDir);
    stub = makeOrchStub();
    // Global modules in a "%APPDATA%\npm" of their own: not next to the (absent) node, so the launcher cannot find the bundle by itself.
    modules = join(root, 'npm', 'node_modules');
    bundle = join(modules, '@wadeck-app', 'machine-cli', 'machine.cjs');
    mkdirSync(join(modules, '@wadeck-app', 'machine-cli'), { recursive: true });
    writeFileSync(bundle, '// bundle');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(stub.dir, { recursive: true, force: true });
  });
  const installed = (version = '1.0.0') => {
    const pkgDir = join(root, 'pkgs', ...platformPackageName('win32-x64').split('/'));
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'machine.exe'), 'LAUNCHER-BYTES');
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'x', version }));
    return (spec: string) => {
      const target = join(root, 'pkgs', ...spec.split('/'));
      return existsSync(target) ? target : notFound();
    };
  };
  const ctxWith = (resolve: (s: string) => string, extra: Partial<StartupContext> = {}): StartupContext => ({
    configDir,
    orch: stub.orch,
    // Staging order and the junction are under test here, not the start of the daemon (startupDaemon.test.ts).
    start: false,
    platform: 'win32',
    env: { PATH: '', SystemRoot: 'C:\\Windows' },
    bundlePath: bundle,
    binary: { platform: 'win32', arch: 'x64', resolve },
    ...extra,
  });
  const link = (stamp = '1.0.0') => join(configDir, 'bin', stamp, 'node_modules');
  const showJob = (ctx: StartupContext) => {
    // The status compares the stored command with what enable writes: store exactly that.
    return startupStatus(ctx);
  };

  it('enable creates the junction next to the staged launcher, before orch is called, and reports it', async () => {
    stub.script({ ensure: { stdout: 'added machine\n' } });
    process.env.ORCH_STUB_WATCH = link();
    const r = await enableStartup(ctxWith(installed()));
    delete process.env.ORCH_STUB_WATCH;
    expect(stub.watched()).toEqual(['exists']);
    expect(r.bundleLink).toMatchObject({ state: 'created', link: link(), modulesDir: modules });
    expect(readFileSync(join(link(), '@wadeck-app', 'machine-cli', 'machine.cjs'), 'utf8')).toBe('// bundle');
  });

  it('enable twice: the second finds the junction correct', async () => {
    stub.script({ ensure: { stdout: 'added machine\n' } });
    await enableStartup(ctxWith(installed()));
    expect((await enableStartup(ctxWith(installed()))).bundleLink?.state).toBe('unchanged');
  });

  it('a bundle that is not under a node_modules (checkout): no junction, nothing reported', async () => {
    stub.script({ ensure: { stdout: 'added machine\n' } });
    const checkout = join(root, 'checkout', 'dist', 'machine.cjs');
    mkdirSync(join(root, 'checkout', 'dist'), { recursive: true });
    writeFileSync(checkout, '// bundle');
    const r = await enableStartup(ctxWith(installed(), { bundlePath: checkout }));
    expect(r.bundleLink).toBeUndefined();
    expect(existsSync(link())).toBe(false);
  });

  it('a non-Windows job gets no junction', async () => {
    stub.script({ ensure: { stdout: 'added machine\n' } });
    const pkgDir = join(root, 'pkgs', ...platformPackageName('linux-x64').split('/'));
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'machine'), 'LAUNCHER-BYTES');
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
    const resolve = (spec: string) => join(root, 'pkgs', ...spec.split('/'));
    const r = await enableStartup({ configDir, orch: stub.orch, platform: 'linux', env: { PATH: '' }, bundlePath: bundle, binary: { platform: 'linux', arch: 'x64', resolve } });
    expect(r.bundleLink).toBeUndefined();
    expect(existsSync(link())).toBe(false);
  });

  it('status repairs a missing junction, then a stale one, and says so; a correct one is only reported', async () => {
    stub.script({ ensure: { stdout: 'added machine\n' } });
    const enabled = await enableStartup(ctxWith(installed()));
    stub.script({ list: { stdout: '[]' }, show: { stdout: JSON.stringify({ command: enabled.command }) } });

    expect((await showJob(ctxWith(installed()))).bundleLink?.state).toBe('unchanged');

    unlinkSync(link());
    expect(existsSync(link())).toBe(false);
    expect((await showJob(ctxWith(installed()))).bundleLink?.state).toBe('created');
    expect(existsSync(join(link(), '@wadeck-app', 'machine-cli', 'machine.cjs'))).toBe(true);

    const other = join(root, 'other', 'node_modules');
    mkdirSync(other, { recursive: true });
    unlinkSync(link());
    symlinkSync(other, link(), 'junction');
    expect((await showJob(ctxWith(installed()))).bundleLink?.state).toBe('replaced');
    expect(existsSync(join(link(), '@wadeck-app', 'machine-cli', 'machine.cjs'))).toBe(true);
  });

  it('status before enable (launcher not staged): reported as a warning, nothing created', async () => {
    stub.script({ list: { stdout: '[]' }, show: { stdout: JSON.stringify({ command: 'x' }) } });
    const s = await startupStatus(ctxWith(installed()));
    expect(s.bundleLink?.state).toBe('not-staged');
    expect(existsSync(join(configDir, 'bin'))).toBe(false);
  });

  it('a junction that cannot be created does not fail enable: the [warn] line names the cause and the fix', async () => {
    stub.script({ ensure: { stdout: 'added machine\n' } });
    const bundleLinkFs = {
      ...realFs,
      symlinkSync: () => {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      },
    };
    const out = await cli(configDir, ['startup', 'enable'], undefined, { startup: ctxWith(installed(), { bundleLinkFs }) });
    expect(out.code, out.err).toBe(0);
    expect(out.out).toMatch(/\[warn\] bundle link: cannot link .*EPERM.*machine startup enable/);
  });

  it('CLI enable and status print the [ok] bundle link line', async () => {
    stub.script({ ensure: { stdout: 'added machine\n' } });
    const en = await cli(configDir, ['startup', 'enable'], undefined, { startup: ctxWith(installed()) });
    expect(en.code, en.err).toBe(0);
    expect(en.out).toContain(`[ok] bundle link created: ${link()} -> ${modules}`);
    stub.script({ list: { stdout: '[]' }, show: { stdout: JSON.stringify({ command: (await enableStartup(ctxWith(installed()))).command }) } });
    unlinkSync(link());
    const st = await cli(configDir, ['startup', 'status'], undefined, { startup: ctxWith(installed()) });
    expect(st.out).toContain('[ok] bundle link created');
    expect(lstatSync(link()).isSymbolicLink()).toBe(true);
  });

  it('post-update says the junction line after the job line', async () => {
    const lines: string[] = [];
    stub.script({ ensure: { stdout: 'updated machine\n' } });
    await postUpdate({
      newVersion: 'v2',
      startup: { status: async () => ({ exists: true }), enable: () => enableStartup(ctxWith(installed())) },
      daemon: { version: async () => undefined, quit: async () => undefined },
      say: (l) => lines.push(l),
    });
    expect(lines[0]).toMatch(/\[ok\] startup job/);
    expect(lines[1]).toContain('[ok] bundle link created');
  });
});
