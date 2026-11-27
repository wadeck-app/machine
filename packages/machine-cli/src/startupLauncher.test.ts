import * as realFs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli } from './testing.js';
import { makeOrchStub, type OrchStub } from './orchStub.js';
import { platformPackageName } from './platformBinary.js';
import { enableStartup, launcherBundleOverride, registeredForm, startupStatus, StartupError, type DaemonSource, type StartupContext } from './startup.js';

// The staged launcher form of the orch job (spec: packaging.md sections 3.4 and 8). The orch is the stub, never the real one.

let root: string;
let configDir: string;
let stub: OrchStub;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'machine-startup-launcher-'));
  configDir = join(root, 'config');
  mkdirSync(configDir);
  stub = makeOrchStub();
});
afterEach(() => {
  delete process.env.ORCH_STUB_WATCH;
  rmSync(root, { recursive: true, force: true });
  rmSync(stub.dir, { recursive: true, force: true });
});

const NODE = '/home/u/.nvm/versions/node/v24.22.2/bin/node';
const NODE_PATH_PART = `PATH='/home/u/.nvm/versions/node/v24.22.2/bin':"\${PATH:-/usr/local/bin:/usr/bin:/bin}"`;
const UNIX_BUNDLE: DaemonSource = { platform: 'linux', execPath: '/usr/bin/node', scriptPath: '/opt/m/machine.cjs' };
const ensureArgs = (command: string) => ['ensure', 'startup', 'machine', '--command', command, '--restart-on-exit', '--timeout', '0', '--restart-if-changed', '--liveness-strategy', 'portFile', '--liveness-port-file', join(configDir, 'daemon.port.json'), '--json'];

describe('launcherBundleOverride (port of the rule of orch launcher-bundle.ts)', () => {
  const spec = '@wadeck-app/machine-cli/machine.cjs';
  const same = (p: string) => p;

  it('no node on PATH: the launcher cannot find anything by itself, the bundle is the override', () => {
    expect(launcherBundleOverride({ bundle: '/b/machine.cjs', spec, nodeDir: null, realpath: same })).toBe('/b/machine.cjs');
  });

  it('the bundle is the one the launcher finds under <node dir>/node_modules/<spec>: no override', () => {
    const bundle = join('/n', 'node_modules', '@wadeck-app', 'machine-cli', 'machine.cjs');
    expect(launcherBundleOverride({ bundle, spec, nodeDir: '/n', realpath: same })).toBeUndefined();
  });

  it('a junction (nvm) that resolves to the same real file counts as the same bundle', () => {
    const real = (p: string) => (p.includes('node_modules') ? '/real/machine.cjs' : p);
    expect(launcherBundleOverride({ bundle: '/real/machine.cjs', spec, nodeDir: '/n', realpath: real })).toBeUndefined();
  });

  it('any other bundle (checkout, a unix prefix with lib/) stays fixed by an override; a lookup that fails counts as not found', () => {
    expect(launcherBundleOverride({ bundle: '/elsewhere/machine.cjs', spec, nodeDir: '/n', realpath: same })).toBe('/elsewhere/machine.cjs');
    const throwing = () => {
      throw new Error('ENOENT');
    };
    expect(launcherBundleOverride({ bundle: '/b/machine.cjs', spec, nodeDir: '/n', realpath: throwing })).toBe('/b/machine.cjs');
  });
});

describe('registeredForm (which form a stored command is)', () => {
  it('recognises the staged launcher on both platforms, with or without the override and the config dir', () => {
    expect(registeredForm('"C:\\cfg\\bin\\1\\machine.exe" daemon')).toBe('launcher');
    expect(registeredForm("LAUNCHER_BUNDLE_OVERRIDE='/b/machine.cjs' '/cfg/bin/1/machine' daemon --config-dir '/c'")).toBe('launcher');
    expect(registeredForm(`LAUNCHER_BUNDLE_OVERRIDE='/b/machine.cjs' PATH='/n/bin':"\${PATH:-/usr/local/bin:/usr/bin:/bin}" '/cfg/bin/1/machine' daemon`)).toBe('launcher');
    expect(registeredForm(`PATH='/n/bin':"\${PATH:-/usr/local/bin:/usr/bin:/bin}" '/cfg/bin/1/machine' daemon`)).toBe('launcher');
  });

  it('recognises the node + bundle development form', () => {
    expect(registeredForm('"C:\\Program Files\\nodejs\\node.exe" "C:\\x\\machine.cjs" daemon')).toBe('development');
    expect(registeredForm("'/usr/bin/node' '/opt/it'\\''s here/machine.cjs' daemon")).toBe('development');
  });

  it('anything else is unknown, not guessed', () => {
    expect(registeredForm('echo hi')).toBe('unknown');
  });
});

describe('the staged launcher form, with a fake installed platform package', () => {
  const BUNDLE = '/opt/lib/machine.cjs';
  const notFound = (): string => {
    throw Object.assign(new Error('not found'), { code: 'MODULE_NOT_FOUND' });
  };
  const installed = (version = '1.0.0') => {
    const pkgDir = join(root, 'nm', ...platformPackageName('linux-x64').split('/'));
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'machine'), 'LAUNCHER-BYTES');
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'x', version }));
    return (spec: string) => {
      const target = join(root, 'nm', ...spec.split('/'));
      try {
        statSync(target);
      } catch {
        return notFound();
      }
      return target;
    };
  };
  const ctxWith = (resolve: (s: string) => string, extra: Partial<StartupContext> = {}): StartupContext => ({
    configDir,
    orch: stub.orch,
    // Staging and pruning are under test here, not the start of the daemon (startupDaemon.test.ts).
    start: false,
    platform: 'linux',
    env: { PATH: '' },
    bundlePath: BUNDLE,
    execPath: NODE,
    // node is not on the minimal PATH: `enable` warns (tested below), nothing else here depends on it.
    minimalPathHasNode: false,
    binary: { platform: 'linux', arch: 'x64', resolve },
    ...extra,
  });
  const staged = (stamp: string) => join(configDir, 'bin', stamp, 'machine');
  const launcherCommand = (stamp: string, nodePath = NODE_PATH_PART) => `LAUNCHER_BUNDLE_OVERRIDE='${BUNDLE}' ${nodePath} '${staged(stamp)}' daemon --config-dir '${configDir}'`;
  const devCommand = () => `'${NODE}' '${BUNDLE}' daemon --config-dir '${configDir}'`;

  it('enable on Unix puts the directory of the node that runs it in front of the PATH of the job, and says so (a warning when node is not on /usr/bin:/bin)', async () => {
    stub.script({ ensure: { stdout: 'added machine\n' } });
    const r = await enableStartup(ctxWith(installed('1.0.0')));
    expect(r.command).toBe(launcherCommand('1.0.0'));
    expect(r.nodePath).toEqual({ dir: '/home/u/.nvm/versions/node/v24.22.2/bin', onMinimalPath: false });
  });

  it('enable reports node as found on the minimal PATH when it is', async () => {
    stub.script({ ensure: { stdout: 'added machine\n' } });
    const r = await enableStartup(ctxWith(installed('1.0.0'), { minimalPathHasNode: true }));
    expect(r.nodePath).toEqual({ dir: '/home/u/.nvm/versions/node/v24.22.2/bin', onMinimalPath: true });
  });

  it('the development form and Windows carry no nodePath', async () => {
    stub.script({ ensure: { stdout: 'added machine\n' } });
    expect((await enableStartup(ctxWith(notFound))).nodePath).toBeUndefined();
  });

  it('status: a job registered before this change (no PATH part) is outdated; a job whose node directory moved is outdated', async () => {
    const old = `LAUNCHER_BUNDLE_OVERRIDE='${BUNDLE}' '${staged('1.0.0')}' daemon --config-dir '${configDir}'`;
    stub.script({ list: { stdout: '[]' }, show: { stdout: JSON.stringify({ command: old }) } });
    expect(await startupStatus(ctxWith(installed('1.0.0')))).toMatchObject({ upToDate: false, registeredForm: 'launcher' });
    const moved = launcherCommand('1.0.0', `PATH='/home/u/.nvm/versions/node/v22.1.0/bin':"\${PATH:-/usr/local/bin:/usr/bin:/bin}"`);
    stub.script({ list: { stdout: '[]' }, show: { stdout: JSON.stringify({ command: moved }) } });
    expect(await startupStatus(ctxWith(installed('1.0.0')))).toMatchObject({ upToDate: false });
    stub.script({ list: { stdout: '[]' }, show: { stdout: JSON.stringify({ command: launcherCommand('1.0.0') }) } });
    expect(await startupStatus(ctxWith(installed('1.0.0')))).toMatchObject({ upToDate: true });
  });

  it('enable stages the launcher into <configDir>/bin/<stamp>/ and registers it, never the node_modules path', async () => {
    stub.script({ ensure: { stdout: 'added machine\n' } });
    const r = await enableStartup(ctxWith(installed('1.0.0')));
    expect(stub.calls()).toEqual([ensureArgs(launcherCommand('1.0.0'))]);
    expect(readFileSync(staged('1.0.0'), 'utf8')).toBe('LAUNCHER-BYTES');
    expect(r).toMatchObject({ action: 'added', form: 'launcher', command: launcherCommand('1.0.0') });
    expect(r.command).not.toContain('node_modules');
  });

  it('prunes the older stamps only AFTER orch ensure returned 0 (the old folder still exists while orch runs)', async () => {
    mkdirSync(join(configDir, 'bin', '0.9.0'), { recursive: true });
    writeFileSync(staged('0.9.0'), 'OLD');
    stub.script({ ensure: { stdout: 'updated machine\n' } });
    process.env.ORCH_STUB_WATCH = staged('0.9.0');
    const r = await enableStartup(ctxWith(installed('1.0.0')));
    expect(stub.watched()).toEqual(['exists']);
    expect(existsSync(staged('0.9.0'))).toBe(false);
    expect(existsSync(staged('1.0.0'))).toBe(true);
    expect(r.pruned).toEqual({ removed: ['0.9.0'], skipped: [] });
  });

  it.each([1, 2, 4, 7])('orch ensure exit %i: nothing is pruned (the stored job may still name the old folder)', async (code) => {
    mkdirSync(join(configDir, 'bin', '0.9.0'), { recursive: true });
    writeFileSync(staged('0.9.0'), 'OLD');
    stub.script({ ensure: { code, stderr: 'boom' } });
    await expect(enableStartup(ctxWith(installed('1.0.0')))).rejects.toThrow(StartupError);
    expect(existsSync(staged('0.9.0'))).toBe(true);
    // The new copy is staged before orch is called, so a retry finds it.
    expect(existsSync(staged('1.0.0'))).toBe(true);
  });

  it('a stamp that cannot be pruned (running image) is reported as skipped, enable still succeeds', async () => {
    mkdirSync(join(configDir, 'bin', '0.9.0'), { recursive: true });
    stub.script({ ensure: { stdout: 'updated machine\n' } });
    const fs = {
      ...realFs,
      rmSync: () => {
        throw new Error('EBUSY');
      },
    };
    const r = await enableStartup(ctxWith(installed('1.0.0'), { binary: { platform: 'linux', arch: 'x64', resolve: installed('1.0.0'), fs } }));
    expect(r.pruned).toEqual({ removed: [], skipped: ['0.9.0'] });
  });

  it('no platform package (checkout, dev bundle): keeps node + bundle and says it is the development form and why', async () => {
    stub.script({ ensure: { stdout: 'added machine\n' } });
    const r = await enableStartup(ctxWith(notFound));
    expect(r.form).toBe('development');
    expect(r.command).toBe(devCommand());
    expect(r.formNote).toMatch(/development form/);
    expect(r.formNote).toContain('@wadeck-app/machine-cli-linux-x64');
    expect(existsSync(join(configDir, 'bin'))).toBe(false);
    expect(r.pruned).toBeUndefined();
  });

  it('an injected daemon source bypasses staging and pruning entirely (tests of the command only)', async () => {
    stub.script({ ensure: { stdout: 'added machine\n' } });
    const r = await enableStartup({ ...ctxWith(installed('1.0.0')), daemon: UNIX_BUNDLE });
    expect(r.form).toBe('development');
    expect(existsSync(join(configDir, 'bin'))).toBe(false);
  });

  it('a script that is not a bundle is refused even when a launcher is installed, saying how to build one', async () => {
    await expect(enableStartup(ctxWith(installed('1.0.0'), { bundlePath: '/repo/src/bin.ts' }))).rejects.toThrow(/npm run bundle/);
    expect(stub.calls()).toEqual([]);
  });

  it('status builds the expected command from the installed package without copying anything', async () => {
    stub.script({ list: { stdout: '[]' }, show: { code: 3 } });
    const r = await startupStatus(ctxWith(installed('1.0.0')));
    expect(r).toMatchObject({ exists: false, expected: launcherCommand('1.0.0'), expectedForm: 'launcher' });
    expect(existsSync(join(configDir, 'bin'))).toBe(false);
  });

  it('status: the registered launcher command equal to the expected one is up to date and says which form', async () => {
    stub.script({ list: { stdout: '[]' }, show: { stdout: JSON.stringify({ command: launcherCommand('1.0.0') }) } });
    expect(await startupStatus(ctxWith(installed('1.0.0')))).toMatchObject({ upToDate: true, registeredForm: 'launcher', expectedForm: 'launcher' });
  });

  it('status: a launcher of an older stamp is outdated (a new platform package is installed)', async () => {
    stub.script({ list: { stdout: '[]' }, show: { stdout: JSON.stringify({ command: launcherCommand('0.9.0') }) } });
    expect(await startupStatus(ctxWith(installed('1.0.0')))).toMatchObject({ upToDate: false, registeredForm: 'launcher' });
  });

  it('status: the development form registered while a launcher is available is outdated, both forms are reported', async () => {
    stub.script({ list: { stdout: '[]' }, show: { stdout: JSON.stringify({ command: devCommand() }) } });
    expect(await startupStatus(ctxWith(installed('1.0.0')))).toMatchObject({ upToDate: false, registeredForm: 'development', expectedForm: 'launcher' });
  });

  it('status without a platform package expects the development form and says why', async () => {
    stub.script({ list: { stdout: '[]' }, show: { code: 3 } });
    const r = await startupStatus(ctxWith(notFound));
    expect(r.expectedForm).toBe('development');
    expect(r.formNote).toMatch(/development form/);
  });

  it('CLI enable prints the form line; the development form says why, the launcher form says Node is required', async () => {
    stub.script({ ensure: { stdout: 'added machine\n' } });
    const dev = await cli(configDir, ['startup', 'enable'], undefined, { startup: ctxWith(notFound) });
    expect(dev.code, dev.err).toBe(0);
    expect(dev.out).toMatch(/form: development \(node \+ bundle\)/);
    expect(dev.out).toMatch(/development form/);
    const rel = await cli(configDir, ['startup', 'enable'], undefined, { startup: ctxWith(installed('1.0.0')) });
    expect(rel.code, rel.err).toBe(0);
    expect(rel.out).toMatch(/form: staged launcher/);
    expect(rel.out).toContain('Node >= 24');
  });

  it('CLI status says which form is registered and whether it is current', async () => {
    stub.script({ list: { stdout: '[]' }, show: { stdout: JSON.stringify({ command: launcherCommand('1.0.0') }) } });
    const ok = await cli(configDir, ['startup', 'status'], undefined, { startup: ctxWith(installed('1.0.0')) });
    expect(ok.out).toMatch(/registered form: staged launcher/);
    expect(ok.out).toMatch(/up to date/);
    stub.script({ list: { stdout: '[]' }, show: { stdout: JSON.stringify({ command: devCommand() }) } });
    const old = await cli(configDir, ['startup', 'status'], undefined, { startup: ctxWith(installed('1.0.0')) });
    expect(old.out).toMatch(/registered form: development/);
    expect(old.out).toMatch(/expected form: staged launcher/);
    expect(old.out).toMatch(/outdated: run machine startup enable/);
  });

  it('CLI enable: a warning plus one [info] line when node is not on /usr/bin:/bin, the [info] line alone when it is', async () => {
    stub.script({ ensure: { stdout: 'added machine\n' } });
    const off = await cli(configDir, ['startup', 'enable'], undefined, { startup: ctxWith(installed('1.0.0')) });
    expect(off.out).toContain('[warn] node was not found on the minimal PATH /usr/bin:/bin');
    const info = off.out.split('\n').filter((l) => l.startsWith('[info] job PATH'));
    expect(info).toHaveLength(1);
    expect(info[0]).toContain('/home/u/.nvm/versions/node/v24.22.2/bin');
    stub.script({ ensure: { stdout: 'unchanged machine\n' } });
    const on = await cli(configDir, ['startup', 'enable'], undefined, { startup: ctxWith(installed('1.0.0'), { minimalPathHasNode: true }) });
    expect(on.out).not.toContain('[warn] node was not found');
    expect(on.out).toContain('[info] job PATH');
  });
});
