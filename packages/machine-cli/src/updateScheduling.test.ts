import { afterEach, describe, expect, it } from 'vitest';
import { createUpdateScheduler } from './updateScheduling.js';

// Port of orch's update-scheduling tests. The daemon spawns the updater at startup and every 30 minutes. A development
// build must spawn none: the updater would compare 0.1.0 with the published CalVer and install it globally.

const RELEASE = '2026.11.14-592-abcdef12';
const BUNDLE = '/pkg/machine.cjs';
const saved = { force: process.env.UPDATER_FORCE, dir: process.env.MACHINE_CONFIG_DIR, fromDaemon: process.env.MACHINE_UPDATER_FROM_DAEMON };

afterEach(() => {
  for (const [name, value] of [['UPDATER_FORCE', saved.force], ['MACHINE_CONFIG_DIR', saved.dir], ['MACHINE_UPDATER_FROM_DAEMON', saved.fromDaemon]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function make(version: string, extra: { suspended?: () => string | null; spawnEnv?: Record<string, string> } = {}) {
  const spawned: { bundle: string; name: string; currentVersion: string; force: string | undefined; dir: string | undefined; fromDaemon: string | undefined }[] = [];
  const logs: string[] = [];
  const manager = {
    scheduleBackgroundUpdate: (bundle: string, name: string, currentVersion: string) => {
      spawned.push({ bundle, name, currentVersion, force: process.env.UPDATER_FORCE, dir: process.env.MACHINE_CONFIG_DIR, fromDaemon: process.env.MACHINE_UPDATER_FROM_DAEMON });
    },
  };
  const scheduler = createUpdateScheduler({ version, bundlePath: BUNDLE, manager, log: (m) => logs.push(m), updaterExists: () => true, ...extra });
  return { scheduler, spawned, logs };
}

describe('a release build', () => {
  it('spawns the machine updater next to its own bundle', () => {
    const { scheduler, spawned, logs } = make(RELEASE);
    expect(scheduler.request('startup')).toBe('scheduled');
    expect(spawned.map((s) => [s.bundle, s.name, s.currentVersion])).toEqual([[BUNDLE, 'machine-updater.cjs', RELEASE]]);
    expect(logs.join('\n')).toMatch(/background update check triggered \(startup\)/);
  });

  it('oncePerRun skips a second request, a plain request does not', () => {
    const { scheduler, spawned } = make(RELEASE);
    expect(scheduler.request('startup', { oncePerRun: true })).toBe('scheduled');
    expect(scheduler.request('startup again', { oncePerRun: true })).toBe('skipped-already');
    expect(scheduler.request('periodic')).toBe('scheduled');
    expect(spawned).toHaveLength(2);
  });

  it('force sets UPDATER_FORCE for the spawn only and restores the caller environment', () => {
    delete process.env.UPDATER_FORCE;
    const { scheduler, spawned } = make(RELEASE);
    scheduler.request('manual', { force: true });
    expect(spawned[0]?.force).toBe('1');
    expect(process.env.UPDATER_FORCE).toBeUndefined();
  });

  it('force restores a UPDATER_FORCE the caller already had', () => {
    process.env.UPDATER_FORCE = '0';
    const { scheduler } = make(RELEASE);
    scheduler.request('manual', { force: true });
    expect(process.env.UPDATER_FORCE).toBe('0');
  });

  it('spawnEnv (the config directory of the daemon) is set during the spawn only: the updater resolves the same directory as the daemon', () => {
    delete process.env.MACHINE_CONFIG_DIR;
    const { scheduler, spawned } = make(RELEASE, { spawnEnv: { MACHINE_CONFIG_DIR: '/custom/dir', MACHINE_UPDATER_FROM_DAEMON: '1' } });
    scheduler.request('startup');
    expect(spawned[0]).toMatchObject({ dir: '/custom/dir', fromDaemon: '1' });
    expect(process.env.MACHINE_CONFIG_DIR).toBeUndefined();
    expect(process.env.MACHINE_UPDATER_FROM_DAEMON).toBeUndefined();
  });

  it('spawnEnv is restored even when the spawn throws, and the error is not swallowed', () => {
    process.env.MACHINE_CONFIG_DIR = '/before';
    const scheduler = createUpdateScheduler({
      version: RELEASE,
      bundlePath: BUNDLE,
      manager: { scheduleBackgroundUpdate: () => { throw new Error('spawn failed'); } },
      log: () => undefined,
      updaterExists: () => true,
      spawnEnv: { MACHINE_CONFIG_DIR: '/custom/dir' },
    });
    expect(() => scheduler.request('startup')).toThrow('spawn failed');
    expect(process.env.MACHINE_CONFIG_DIR).toBe('/before');
  });
});

describe('an updater that is not next to the bundle', () => {
  it('spawns nothing, says so once per run with the path and the fix', () => {
    const { scheduler, spawned, logs } = make(RELEASE, { updaterExists: () => false } as never);
    expect(scheduler.request('startup')).toBe('skipped-no-updater');
    expect(scheduler.request('periodic')).toBe('skipped-no-updater');
    expect(spawned).toEqual([]);
    expect(logs.filter((l) => l.startsWith('ERROR'))).toHaveLength(1);
    expect(logs[0]).toContain('machine-updater.cjs');
    expect(logs[0]).toContain('npm install -g');
  });
});

describe('a development build', () => {
  for (const version of ['0.1.0', '0.0.0-dev', '2026.10.24-514-aac78c7a-local-dev']) {
    it(`${version} never spawns the updater`, () => {
      const { scheduler, spawned } = make(version);
      expect(scheduler.request('startup', { oncePerRun: true })).toBe('skipped-dev');
      expect(scheduler.request('periodic')).toBe('skipped-dev');
      expect(scheduler.request('manual', { force: true })).toBe('skipped-dev');
      expect(spawned).toEqual([]);
    });
  }

  it('an explicit request is always explained in the daemon log; background ones once per run', () => {
    const { scheduler, logs } = make('0.1.0');
    scheduler.request('startup', { oncePerRun: true });
    scheduler.request('periodic');
    scheduler.request('periodic');
    expect(logs.filter((l) => /dev build/.test(l))).toHaveLength(1);
    scheduler.request('manual', { force: true });
    scheduler.request('manual', { force: true });
    expect(logs.filter((l) => /dev build/.test(l))).toHaveLength(3);
    expect(logs.join('\n')).toMatch(/dev build 0\.1\.0: refusing to update the global install of machine.*machine cli update/);
  });
});

// CI stamps the month and day unpadded (npm rejects leading zeros): both forms count as releases.
describe('release version recognition', () => {
  for (const version of ['2026.10.3-035-1e4adce3', '2026.9.13-1000-b23303c8', '2026.11.01-001-abcdef12']) {
    it(`${version} is a release`, () => {
      const { scheduler, spawned } = make(version);
      expect(scheduler.request('startup')).toBe('scheduled');
      expect(spawned).toHaveLength(1);
    });
  }
  for (const version of ['0.0.0-dev', '0.1.0', '2026.13.1-001-abcdef12', '2026.11.1-001-abcdef1']) {
    it(`${version} is not a release`, () => {
      const { scheduler, spawned } = make(version);
      expect(scheduler.request('startup')).toBe('skipped-dev');
      expect(spawned).toEqual([]);
    });
  }
});

describe('once the guard has suspended the automatic updates', () => {
  it('a background request spawns nothing and says why, once per run', () => {
    const { scheduler, spawned, logs } = make(RELEASE, { suspended: () => 'the update did not change the running version' });
    expect(scheduler.request('startup', { oncePerRun: true })).toBe('skipped-suspended');
    expect(scheduler.request('periodic, every 30m')).toBe('skipped-suspended');
    expect(scheduler.request('periodic, every 30m')).toBe('skipped-suspended');
    expect(spawned).toEqual([]);
    expect(logs.filter((l) => l.includes('the update did not change the running version'))).toHaveLength(1);
  });

  it('an explicit request still goes through: a person asked', () => {
    const { scheduler, spawned } = make(RELEASE, { suspended: () => 'suspended' });
    expect(scheduler.request('manual', { force: true })).toBe('scheduled');
    expect(spawned).toHaveLength(1);
  });

  it('nothing changes while the guard has nothing to say', () => {
    const { scheduler, spawned } = make(RELEASE, { suspended: () => null });
    expect(scheduler.request('periodic')).toBe('scheduled');
    expect(spawned).toHaveLength(1);
  });
});
