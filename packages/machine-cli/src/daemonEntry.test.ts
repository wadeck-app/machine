import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import { startMachineDaemon } from './daemonEntry.js';
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
