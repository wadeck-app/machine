import net from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { startMachineDaemon, type DaemonStart } from './daemonEntry.js';
import { UpdateManager } from '@wadeck-app/shared-cli/UpdateManager';
import { initMachine } from './identity.js';
import { prepareRollback } from './rollbackRecord.js';

// WP9.6: the daemon asks for an update check at start and every 30 minutes, guards against update loops, and answers POST /quit.

const RELEASE = '2026.11.14-592-bbbbbbbb';
const OLDER = '2026.11.14-590-aaaaaaaa';
let dir: string;
const stoppers: Array<() => Promise<void>> = [];
const saved = { dir: process.env.MACHINE_CONFIG_DIR, fromDaemon: process.env.MACHINE_UPDATER_FROM_DAEMON, force: process.env.UPDATER_FORCE };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'machine-daemon-updates-'));
  initMachine(dir, 'desktop');
  delete process.env.MACHINE_CONFIG_DIR;
  delete process.env.MACHINE_UPDATER_FROM_DAEMON;
  delete process.env.UPDATER_FORCE;
});
afterEach(async () => {
  while (stoppers.length > 0) await stoppers.pop()?.();
  for (const [name, value] of [['MACHINE_CONFIG_DIR', saved.dir], ['MACHINE_UPDATER_FROM_DAEMON', saved.fromDaemon], ['UPDATER_FORCE', saved.force]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

interface Spawn {
  bundle: string;
  name: string;
  version: string;
  configDir: string | undefined;
  fromDaemon: string | undefined;
}

function fakes(initialState?: unknown) {
  const spawns: Spawn[] = [];
  const logs: string[] = [];
  const timers: Array<{ fn: () => void; ms: number; stopped: boolean }> = [];
  let state = initialState ?? null;
  const updates: NonNullable<DaemonStart['updates']> = {
    bundlePath: '/pkg/machine.cjs',
    updaterExists: () => true,
    manager: {
      scheduleBackgroundUpdate: (bundle, name, version) => void spawns.push({ bundle, name, version, configDir: process.env.MACHINE_CONFIG_DIR, fromDaemon: process.env.MACHINE_UPDATER_FROM_DAEMON }),
      readAndClearState: () => {
        const s = state;
        state = null;
        return s as never;
      },
    },
    timer: (fn, ms) => {
      const t = { fn, ms, stopped: false };
      timers.push(t);
      return { stop: () => void (t.stopped = true) };
    },
  };
  return { spawns, logs, timers, updates };
}

async function start(version: string, f: ReturnType<typeof fakes>, extra: Partial<DaemonStart> = {}) {
  const daemon = await startMachineDaemon(dir, { port: 0, peerPort: 0, peerHost: '127.0.0.1', version, log: (l) => f.logs.push(l), updates: f.updates, ...extra });
  stoppers.push(daemon.stop);
  return daemon;
}

describe('the update check of the daemon', () => {
  it('asks once at start, from the daemon: the updater gets the config directory of the daemon and skips its time gate', async () => {
    const f = fakes();
    await start(RELEASE, f);
    expect(f.spawns).toEqual([{ bundle: '/pkg/machine.cjs', name: 'machine-updater.cjs', version: RELEASE, configDir: dir, fromDaemon: '1' }]);
    // For the spawn only: the daemon process environment is left as it was.
    expect(process.env.MACHINE_CONFIG_DIR).toBeUndefined();
  });

  it('asks again every 30 minutes, and the timer is stopped with the daemon', async () => {
    const f = fakes();
    const daemon = await start(RELEASE, f);
    expect(f.timers).toHaveLength(1);
    expect(f.timers[0]?.ms).toBe(30 * 60 * 1000);
    f.timers[0]?.fn();
    expect(f.spawns).toHaveLength(2);
    await daemon.stop();
    await daemon.stopped;
    expect(f.timers[0]?.stopped).toBe(true);
  });

  it('a development build spawns nothing and says why, once, in the daemon log', async () => {
    const f = fakes({ status: 'success', targetVersion: RELEASE, timestamp: 1 });
    await start('0.1.0', f);
    f.timers[0]?.fn();
    expect(f.spawns).toEqual([]);
    expect(f.logs.filter((l) => /dev build 0\.1\.0/.test(l))).toHaveLength(1);
  });

  it('a spawn that throws is logged and does not stop the daemon', async () => {
    const f = fakes();
    f.updates.manager = {
      scheduleBackgroundUpdate: () => {
        throw new Error('spawn EACCES');
      },
      readAndClearState: () => null,
    };
    const daemon = await start(RELEASE, f);
    expect(f.logs.join('\n')).toMatch(/update check failed: spawn EACCES/);
    expect(await daemon.stop()).toBeUndefined();
  });
});

describe('where the updater is looked for', () => {
  it('an updater that is not next to the bundle is an error in the log naming the path and the fix, once, and nothing is spawned', async () => {
    const f = fakes();
    f.updates.updaterExists = () => false;
    await start(RELEASE, f);
    f.timers[0]?.fn();
    expect(f.spawns).toEqual([]);
    const errors = f.logs.filter((l) => l.startsWith('ERROR') && l.includes('machine-updater.cjs'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/npm install -g @wadeck-app\/machine-cli/);
    expect(errors[0]).toContain('pkg');
  });

  it('without an explicit bundle path, it is the location of the running bundle, not process.argv[1] (a shim, or nothing)', async () => {
    const f = fakes();
    delete f.updates.bundlePath;
    const savedArgv = process.argv[1];
    process.argv[1] = '/some/shim/machine';
    try {
      await start(RELEASE, f);
    } finally {
      process.argv[1] = savedArgv as string;
    }
    expect(f.spawns[0]?.bundle).toBe(fileURLToPath(new URL('./daemonUpdates.ts', import.meta.url)));
  });
});

describe('what the daemon does with the update state it finds at start', () => {
  it('logs the notice (an interrupted or finished update is news)', async () => {
    const f = fakes({ status: 'success', targetVersion: RELEASE, timestamp: Date.now() });
    await start(RELEASE, f);
    expect(f.logs.join('\n')).toMatch(/update state: Updated to v2026\.11\.14-592-bbbbbbbb/);
  });

  it('an update that took effect is recorded as a start of the loop guard and suspends nothing', async () => {
    const f = fakes({ status: 'success', targetVersion: RELEASE, timestamp: Date.now() });
    await start(RELEASE, f);
    expect(JSON.parse(readFileSync(join(dir, 'update-starts.json'), 'utf8'))).toHaveLength(1);
    f.timers[0]?.fn();
    expect(f.spawns).toHaveLength(2);
  });

  it('an update that installed a version this daemon does not run suspends the automatic updates, loudly, and the periodic check spawns nothing', async () => {
    const f = fakes({ status: 'success', targetVersion: RELEASE, timestamp: Date.now() });
    await start(OLDER, f);
    expect(f.logs.some((l) => l.startsWith('ERROR automatic updates suspended: ') && l.includes(RELEASE) && l.includes(OLDER))).toBe(true);
    f.timers[0]?.fn();
    expect(f.spawns).toEqual([]);
  });

  it('a corrupt loop record is reported and the daemon still starts', async () => {
    writeFileSync(join(dir, 'update-starts.json'), '{not json');
    const f = fakes({ status: 'success', targetVersion: RELEASE, timestamp: Date.now() });
    await start(RELEASE, f);
    expect(f.logs.some((l) => l.includes('update-starts.json') && /not valid JSON/.test(l))).toBe(true);
  });
});

describe('POST /quit (what the post-update restart sends)', () => {
  it('stops the daemon, removes daemon.port.json and closes the peer listener', async () => {
    const f = fakes();
    const daemon = await start(RELEASE, f);
    const portFile = join(dir, 'daemon.port.json');
    expect(existsSync(portFile)).toBe(true);
    const token = readFileSync(join(dir, 'health_token'), 'utf8').trim();
    const response = await fetch(`http://127.0.0.1:${daemon.port}/quit`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    await daemon.stopped;
    expect(existsSync(portFile)).toBe(false);
    await expect(
      new Promise<void>((resolve, reject) => {
        const s = net.connect(daemon.peerPort, '127.0.0.1', () => {
          s.destroy();
          resolve();
        });
        s.on('error', reject);
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('refuses a request without the token and keeps running', async () => {
    const f = fakes();
    const daemon = await start(RELEASE, f);
    const response = await fetch(`http://127.0.0.1:${daemon.port}/quit`, { method: 'POST' });
    expect(response.status).toBe(401);
    expect(existsSync(join(dir, 'daemon.port.json'))).toBe(true);
  });
});

describe('a post-update that failed in a background run', () => {
  it('is an error in the daemon log at start, with the command to run', async () => {
    writeFileSync(join(dir, 'post-update-pending.json'), JSON.stringify({ targetVersion: RELEASE, error: '[fail] orch refused the job', timestamp: 1 }));
    const f = fakes();
    await start(RELEASE, f);
    expect(f.logs.some((l) => l.startsWith('ERROR') && l.includes('orch refused the job') && l.includes('machine cli post-update'))).toBe(true);
  });
});

describe('the record of the last update (rollback after the daemon consumed update-state.json)', () => {
  const recordFile = () => join(dir, 'last-update.json');
  const writeState = (status: string, over: Record<string, unknown> = {}) =>
    writeFileSync(join(dir, 'update-state.json'), JSON.stringify({ status, targetVersion: RELEASE, previousVersion: OLDER, timestamp: 5, ...over }));
  // Real readAndClearState (real file), fake spawner.
  const realManager = (f: ReturnType<typeof fakes>) => {
    const real = new UpdateManager('@wadeck-app/machine-cli', dir);
    f.updates.manager = { scheduleBackgroundUpdate: () => undefined, readAndClearState: () => real.readAndClearState() as never };
  };

  it('a success state left by an older updater (no record) is recorded at the daemon start, then `cli rollback` works', async () => {
    writeState('success');
    const f = fakes();
    realManager(f);
    await start(RELEASE, f);
    expect(existsSync(join(dir, 'update-state.json'))).toBe(false);
    expect(JSON.parse(readFileSync(recordFile(), 'utf8'))).toEqual({ previousVersion: OLDER, targetVersion: RELEASE, timestamp: 5 });
    expect(prepareRollback(dir, RELEASE).restored).toBe(true);
  });

  it('keeps the record the updater wrote (same update, newer timestamp)', async () => {
    writeState('success');
    writeFileSync(recordFile(), JSON.stringify({ previousVersion: OLDER, targetVersion: RELEASE, timestamp: 8 }));
    const f = fakes();
    realManager(f);
    await start(RELEASE, f);
    expect((JSON.parse(readFileSync(recordFile(), 'utf8')) as { timestamp: number }).timestamp).toBe(8);
  });

  it('no record for a failed, rolled-back or applying state', async () => {
    for (const status of ['failed', 'rolled-back', 'applying']) {
      writeState(status);
      const f = fakes();
      realManager(f);
      await start(RELEASE, f);
      expect(existsSync(recordFile())).toBe(false);
    }
  });

  it('a state with an invalid previousVersion is not recorded, and the daemon says so in its log', async () => {
    writeState('success', { previousVersion: 'x; rm -rf /' });
    const f = fakes();
    realManager(f);
    await start(RELEASE, f);
    expect(existsSync(recordFile())).toBe(false);
    expect(f.logs.join('\n')).toMatch(/last-update\.json.*previousVersion|previousVersion.*rollback/s);
  });
});
