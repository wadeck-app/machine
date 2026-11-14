import { describe, expect, it } from 'vitest';
import { updaterMain, type UpdaterMainDeps } from './updaterMain.js';

// The updater entry, with every side effect injected: nothing here runs npm, touches the real install or spawns a process.

const CURRENT = '2026.11.14-590-aaaaaaaa';
const TARGET = '2026.11.14-592-bbbbbbbb';
const NPM_ROOT = '/npm/root';
const BIN = `${NPM_ROOT}/@wadeck-app/machine-cli/bin/machine.js`;

type Cfg = Parameters<UpdaterMainDeps['runUpdater']>[0];

function make(over: Partial<UpdaterMainDeps> = {}, runs: { cfg?: Cfg; envAtRun?: string | undefined; decisions?: unknown[] } = {}) {
  const logs: string[] = [];
  const err: string[] = [];
  const calls = { npmRoot: 0, postUpdate: [] as string[] };
  const env: Record<string, string | undefined> = {};
  const deps: UpdaterMainDeps = {
    pkgName: '@wadeck-app/machine-cli',
    configDir: '/cfg',
    currentVersion: CURRENT,
    env,
    nodeExe: '/usr/bin/node',
    log: (level, message) => logs.push(`${level}: ${message}`),
    stderr: (text) => err.push(text),
    npmRootGlobal: () => {
      calls.npmRoot += 1;
      return NPM_ROOT;
    },
    resolveTarget: (npmRoot) => ({ ok: true, target: `${npmRoot}/@wadeck-app/machine-cli/bin/machine.js` }),
    readState: () => null,
    runUpdater: async (cfg) => {
      runs.cfg = cfg;
      runs.envAtRun = env.UPDATER_SELF_CHECK_CMD;
      if (cfg.strategy === 'without-daemon' && cfg.onUpdateAvailable) runs.decisions = [await cfg.onUpdateAvailable(TARGET)];
    },
    spawnPostUpdate: async (npmRoot) => {
      calls.postUpdate.push(npmRoot);
      return { code: 0, output: '[ok] post-update done\n' };
    },
    now: () => 1_000,
    ...over,
  };
  return { deps, logs, err, calls, env, runs };
}

describe('a development build', () => {
  it('exits 0 for a background run, logs why, and touches nothing (no npm, no updater)', async () => {
    const t = make({ currentVersion: '0.1.0' });
    expect(await updaterMain(t.deps)).toBe(0);
    expect(t.logs.join('\n')).toMatch(/warn: .*dev build 0\.1\.0/);
    expect(t.calls.npmRoot).toBe(0);
    expect(t.runs.cfg).toBeUndefined();
  });

  it('exits 1 with the reason on stderr when the update was explicitly requested (UPDATER_FORCE=1)', async () => {
    const t = make({ currentVersion: '0.1.0' });
    t.env.UPDATER_FORCE = '1';
    expect(await updaterMain(t.deps)).toBe(1);
    expect(t.err.join('')).toMatch(/\[fail\].*dev build 0\.1\.0.*machine cli update/);
    expect(t.runs.cfg).toBeUndefined();
  });
});

describe('arming the self-check', () => {
  it('arms the quoted command on bin.machine of the global install before the updater runs', async () => {
    const t = make();
    await updaterMain(t.deps);
    expect(t.runs.envAtRun).toBe(`"/usr/bin/node" "${BIN}" cli self-check`);
  });

  it('aborts when `npm root -g` fails: an unset command would mean "check passed" and install an unverified update', async () => {
    const t = make({
      npmRootGlobal: () => {
        throw new Error('npm not found');
      },
    });
    expect(await updaterMain(t.deps)).toBe(1);
    expect(t.runs.cfg).toBeUndefined();
    expect(t.err.join('')).toMatch(/\[fail\].*cannot resolve 'npm root -g': npm not found.*npm install -g @wadeck-app\/machine-cli@latest/s);
    expect(t.logs.join('\n')).toMatch(/error: .*update aborted/);
  });

  it('aborts when the target is not on disk', async () => {
    const t = make({ resolveTarget: () => ({ ok: false, reason: 'bin.machine points at /x, which does not exist' }) });
    expect(await updaterMain(t.deps)).toBe(1);
    expect(t.runs.cfg).toBeUndefined();
    expect(t.err.join('')).toMatch(/does not exist/);
  });

  it('with an interrupted install journaled and no usable target, still runs (the repair) with a self-check that fails', async () => {
    const t = make({ resolveTarget: () => ({ ok: false, reason: 'half removed' }), readState: () => ({ status: 'applying', timestamp: 1 }) });
    await updaterMain(t.deps);
    expect(t.runs.cfg).toBeDefined();
    expect(t.runs.envAtRun).toMatch(/machine-self-check-unavailable/);
    expect(t.logs.join('\n')).toMatch(/warn: .*half removed/);
  });

  it('keeps a UPDATER_SELF_CHECK_CMD that the caller set, and does not call npm for it', async () => {
    const t = make();
    t.env.UPDATER_SELF_CHECK_CMD = 'custom check';
    await updaterMain(t.deps);
    expect(t.runs.envAtRun).toBe('custom check');
    expect(t.calls.npmRoot).toBe(0);
  });
});

describe('the updater configuration', () => {
  it('uses the without-daemon strategy with no restartDaemon (the restart is cli post-update, not config.restart)', async () => {
    const t = make();
    await updaterMain(t.deps);
    expect(t.runs.cfg).toMatchObject({ pkgName: '@wadeck-app/machine-cli', configDir: '/cfg', currentVersion: CURRENT, strategy: 'without-daemon' });
    expect(t.runs.cfg).not.toHaveProperty('restartDaemon');
  });

  it('skips the throttle only when the daemon spawned it (it owns its 30 minute cadence)', async () => {
    const fromCli = make();
    await updaterMain(fromCli.deps);
    expect(fromCli.runs.cfg?.skipThrottle).toBeFalsy();
    const fromDaemon = make();
    fromDaemon.env.MACHINE_UPDATER_FROM_DAEMON = '1';
    await updaterMain(fromDaemon.deps);
    expect(fromDaemon.runs.cfg?.skipThrottle).toBe(true);
  });

  it('applies an available update at once (explicit or background)', async () => {
    const t = make();
    await updaterMain(t.deps);
    expect(t.runs.decisions).toEqual(['apply-now']);
  });
});

describe('after the updater ran', () => {
  const success = { status: 'success', currentVersion: CURRENT, targetVersion: TARGET, previousVersion: CURRENT, timestamp: 2_000 };

  it('runs post-update from the NEW install, once, when this run installed a new version', async () => {
    const t = make({ readState: () => success });
    expect(await updaterMain(t.deps)).toBe(0);
    expect(t.calls.postUpdate).toEqual([NPM_ROOT]);
    expect(t.err.join('')).toMatch(/\[ok\] updated machine to v2026\.11\.14-592-bbbbbbbb \(was v2026\.11\.14-590-aaaaaaaa\)/);
    expect(t.err.join('')).toContain('[ok] post-update done');
  });

  it('does nothing more when the state is not a success of this run (older record, same version, up to date)', async () => {
    for (const state of [{ ...success, timestamp: 999 }, { ...success, targetVersion: CURRENT }, { status: 'deferred', currentVersion: CURRENT, timestamp: 2_000 }, null]) {
      const t = make({ readState: () => state });
      expect(await updaterMain(t.deps), JSON.stringify(state)).toBe(0);
      expect(t.calls.postUpdate).toEqual([]);
    }
  });

  it('a failure or rollback of this run is a failure: exit 1, the reason and the state file on stderr, no post-update', async () => {
    for (const status of ['failed', 'rolled-back']) {
      const t = make({ readState: () => ({ status, currentVersion: CURRENT, targetVersion: TARGET, error: 'self-check failed', timestamp: 2_000 }) });
      expect(await updaterMain(t.deps), status).toBe(1);
      expect(t.err.join('')).toMatch(/\[fail\].*self-check failed/);
      expect(t.err.join('')).toContain('update-state.json');
      expect(t.calls.postUpdate).toEqual([]);
    }
  });

  it('a post-update that fails is reported with the command to run by hand, exit 1', async () => {
    const t = make({ readState: () => success, spawnPostUpdate: async () => ({ code: 1, output: '[fail] orch is not installed\n' }) });
    expect(await updaterMain(t.deps)).toBe(1);
    expect(t.err.join('')).toContain('[fail] orch is not installed');
    expect(t.err.join('')).toMatch(/\[fail\].*machine cli post-update/);
  });

  it('a throw of the updater is a failure with the reason', async () => {
    const t = make({
      runUpdater: async () => {
        throw new Error('boom');
      },
    });
    expect(await updaterMain(t.deps)).toBe(1);
    expect(t.err.join('')).toMatch(/\[fail\].*boom/);
  });

  it('with a success but no npm root to run post-update from, says so and how to finish by hand', async () => {
    const t = make({
      readState: () => success,
      npmRootGlobal: () => {
        throw new Error('gone');
      },
    });
    t.env.UPDATER_SELF_CHECK_CMD = 'custom check';
    expect(await updaterMain(t.deps)).toBe(1);
    expect(t.err.join('')).toMatch(/\[fail\].*npm root -g.*gone.*machine cli post-update/s);
  });
});
