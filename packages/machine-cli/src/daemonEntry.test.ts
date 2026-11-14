import net from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import { startMachineDaemon, type DaemonStart } from './daemonEntry.js';
import { initMachine } from './identity.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'machine-daemon-entry-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function cli(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await runCli([...args, '--config-dir', dir], { stdout: (t) => (out += t), stderr: (t) => (err += t) });
  return { code, out, err };
}

describe('startMachineDaemon', () => {
  it('refuses to start without an identity and says what to run', async () => {
    await expect(startMachineDaemon(dir, { port: 0, version: 'x' })).rejects.toThrow(/machine init --name/);
  });

  it('serves the CLI: status goes through the running daemon, not an in-process copy', async () => {
    initMachine(dir, 'desktop');
    const daemon = await startMachineDaemon(dir, { port: 0, version: 'served-by-daemon' });
    try {
      const r = await cli('status');
      expect(r.code).toBe(0);
      // The CLI itself reports the package version; only the daemon reports this one.
      expect(r.out).toContain('served-by-daemon');
    } finally {
      await daemon.stop();
    }
  });

  it('exposes a promise that settles when the daemon has stopped, so `machine daemon` can end cleanly', async () => {
    initMachine(dir, 'desktop');
    const daemon = await startMachineDaemon(dir, { port: 0, version: 'v' });
    let settled = false;
    void daemon.stopped.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    await daemon.stop();
    await daemon.stopped;
    expect(settled).toBe(true);
  });

  it('falls back to in-process answers once the daemon is stopped', async () => {
    initMachine(dir, 'desktop');
    const daemon = await startMachineDaemon(dir, { port: 0, version: 'served-by-daemon' });
    await daemon.stop();
    const r = await cli('status');
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('served-by-daemon');
  });
});

describe('the daemon port file (what orch reads to know the daemon is alive)', () => {
  const portFile = () => join(dir, 'daemon.port.json');

  it('exists only while the daemon runs, holds pid, api port and peer port, and is removed by stop', async () => {
    initMachine(dir, 'desktop');
    const daemon = await startMachineDaemon(dir, { port: 0, peerPort: 0, peerHost: '127.0.0.1', version: 'v' });
    expect(JSON.parse(readFileSync(portFile(), 'utf8'))).toEqual({ pid: process.pid, port: daemon.port, peerPort: daemon.peerPort });
    if (process.platform !== 'win32') expect(statSync(portFile()).mode & 0o777).toBe(0o600);
    // No temp file is left next to it.
    expect(readdirSync(dir).filter((f) => f.startsWith('daemon.port.json.'))).toEqual([]);
    await daemon.stop();
    await daemon.stopped;
    expect(existsSync(portFile())).toBe(false);
  });

  it('is never written by a start that failed (peer port already taken), and a stale one of a dead process is replaced', async () => {
    initMachine(dir, 'desktop');
    const taken = net.createServer();
    await new Promise<void>((r) => taken.listen(0, '127.0.0.1', r));
    try {
      const port = (taken.address() as net.AddressInfo).port;
      await expect(startMachineDaemon(dir, { port: 0, peerPort: port, peerHost: '127.0.0.1', version: 'v' })).rejects.toThrow();
      expect(existsSync(portFile())).toBe(false);
    } finally {
      await new Promise((r) => taken.close(r));
    }
    writeFileSync(portFile(), JSON.stringify({ pid: 999999, port: 1, peerPort: 2 }));
    const daemon = await startMachineDaemon(dir, { port: 0, peerPort: 0, peerHost: '127.0.0.1', version: 'v' });
    expect(JSON.parse(readFileSync(portFile(), 'utf8')).pid).toBe(process.pid);
    await daemon.stop();
  });

  it('is left alone at stop when it now belongs to another process (a successor already wrote its own)', async () => {
    initMachine(dir, 'desktop');
    const daemon = await startMachineDaemon(dir, { port: 0, peerPort: 0, peerHost: '127.0.0.1', version: 'v' });
    writeFileSync(portFile(), JSON.stringify({ pid: process.pid + 1, port: 1, peerPort: 2 }));
    await daemon.stop();
    expect(JSON.parse(readFileSync(portFile(), 'utf8')).pid).toBe(process.pid + 1);
  });

  it('fails loudly (and stops the daemon) when the file cannot be written', async () => {
    initMachine(dir, 'desktop');
    // A directory in the way makes the rename fail.
    mkdirSync(portFile());
    await expect(startMachineDaemon(dir, { port: 0, peerPort: 0, peerHost: '127.0.0.1', version: 'v' })).rejects.toThrow(/daemon\.port\.json/);
  });
});

// A release version makes the daemon schedule an update check: these tests never build the real UpdateManager (it spawns the updater).
const inertUpdates = (spawned: string[] = []): NonNullable<DaemonStart['updates']> => ({
  bundlePath: '/pkg/machine.cjs',
  updaterExists: () => true,
  manager: { scheduleBackgroundUpdate: (_bundle, _name, version) => void spawned.push(version), readAndClearState: () => null },
  timer: () => ({ stop: () => undefined }),
});

describe('startMachineDaemon app-core registration', () => {
  it('registers the module once the daemon is up, with its own config dir and version, and never blocks the start', async () => {
    initMachine(dir, 'desktop');
    const calls: Array<{ machineConfigDir?: string | undefined; moduleStamp?: string | undefined }> = [];
    const daemon = await startMachineDaemon(dir, {
      port: 0,
      version: '2026.11.14-001-abcdef12',
      updates: inertUpdates(),
      register: async (o) => {
        // The port file means everything is up: registration comes after it.
        expect(existsSync(join(dir, 'daemon.port.json'))).toBe(true);
        calls.push({ machineConfigDir: o.machineConfigDir, moduleStamp: o.moduleStamp });
      },
    });
    try {
      expect(calls).toEqual([{ machineConfigDir: dir, moduleStamp: '2026.11.14-001-abcdef12' }]);
    } finally {
      await daemon.stop();
    }
  });

  it('a registration that throws is a log line, the daemon stays up', async () => {
    initMachine(dir, 'desktop');
    const lines: string[] = [];
    const daemon = await startMachineDaemon(dir, {
      port: 0,
      version: 'x',
      log: (l) => lines.push(l),
      register: async () => {
        throw new Error('app-core exploded');
      },
    });
    try {
      await new Promise((r) => setTimeout(r, 20));
      expect(lines.join('\n')).toMatch(/app-core exploded/);
      expect(existsSync(join(dir, 'daemon.port.json'))).toBe(true);
    } finally {
      await daemon.stop();
    }
  });

  it('a development build does not register and says so in the log', async () => {
    initMachine(dir, 'desktop');
    const lines: string[] = [];
    const daemon = await startMachineDaemon(dir, { port: 0, version: '0.1.0', log: (l) => lines.push(l) });
    try {
      expect(lines.join('\n')).toMatch(/app-core registration skipped: 0\.1\.0 is a development build/);
    } finally {
      await daemon.stop();
    }
  });
});
