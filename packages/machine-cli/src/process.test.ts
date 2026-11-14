import { execFile, spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bundleMachine } from './bundle.js';
import { provision } from './testing.js';

// The real thing: the bundled CLI as separate operating system processes, a daemon and a client, talking over loopback.

const run = promisify(execFile);
const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';

let root: string;
let bundle: string;
let a: string;
let b: string;
let daemon: ChildProcess | undefined;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function machine(configDir: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const split = args.indexOf('--');
  const argv = split === -1 ? [...args, '--config-dir', configDir] : [...args.slice(0, split), '--config-dir', configDir, ...args.slice(split)];
  try {
    const r = await run(process.execPath, [bundle, ...argv], { windowsHide: true, timeout: 60_000 });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-process-'));
  bundle = join(root, 'machine.cjs');
  await bundleMachine({ outfile: bundle, version: 'process-test' });
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  a = mkdtempSync(join(root, 'a-'));
  b = mkdtempSync(join(root, 'b-'));
});

afterEach(async () => {
  if (daemon && daemon.exitCode === null) {
    await machine(b, ['stop']);
    await new Promise((r) => setTimeout(r, 500));
    if (daemon.exitCode === null) daemon.kill();
  }
  daemon = undefined;
});

async function startDaemon(configDir: string, peerPort: number): Promise<void> {
  const apiPort = await freePort();
  const child = spawn(process.execPath, [bundle, 'daemon', '--api-port', String(apiPort), '--peer-host', '127.0.0.1', '--peer-port', String(peerPort), '--config-dir', configDir], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemon = child;
  await new Promise<void>((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => reject(new Error(`the daemon did not start within 20 s. stdout: ${out} stderr: ${err}`)), 20_000);
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString();
      if (out.includes('[ok] machine daemon')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr?.on('data', (c: Buffer) => (err += c.toString()));
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the daemon exited early with code ${code}. stdout: ${out} stderr: ${err}`));
    });
  });
}

describe('the bundled CLI as real processes', () => {
  it('prints its version from the bundle (no package.json next to it)', async () => {
    await machine(a, ['init', '--name', 'desktop']);
    const r = await machine(a, ['status']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('process-test');
  });

  it('a daemon process serves a run issued by another process, and stop ends it', async () => {
    await provision(root, a, b, [{ shell: SHELL, command: 'echo from a real process' }]);
    const peerPort = await freePort();
    await startDaemon(b, peerPort);

    const answer = await machine(a, ['run', 'laptop', '--address', `127.0.0.1:${peerPort}`, '--shell', SHELL, '--', 'echo', 'from', 'a', 'real', 'process']);
    expect(answer.stderr).toBe('');
    expect(answer.code).toBe(0);
    expect(answer.stdout.trim()).toBe('from a real process');

    const refused = await machine(a, ['run', 'laptop', '--address', `127.0.0.1:${peerPort}`, '--shell', SHELL, '--', 'echo', 'not', 'allowed']);
    expect(refused.code).toBe(255);
    expect(refused.stderr).toMatch(/not-listed/);

    const exited = new Promise<number | null>((resolve) => daemon?.on('exit', (code) => resolve(code)));
    const stop = await machine(b, ['stop']);
    expect(stop.code).toBe(0);
    expect(stop.stdout).toMatch(/stopped/);
    expect(await Promise.race([exited, new Promise((r) => setTimeout(() => r('still running'), 10_000))])).not.toBe('still running');
  }, 120_000);

  it('stop says so, and succeeds, when no daemon is running', async () => {
    await machine(a, ['init', '--name', 'desktop']);
    const r = await machine(a, ['stop']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/not running/);
  });
});
