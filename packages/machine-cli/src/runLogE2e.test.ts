import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunLogEntry } from '@wadeck-app/machine-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMachineDaemon } from './daemonEntry.js';
import { readMachine } from './identity.js';
import type { InboxTimer } from './inboxLoop.js';
import { RUN_LOG_FILE, readRunLog, runLogDir } from './runLogStore.js';
import { cli, provision } from './testing.js';

// Every `machine run` leaves one line in the OUTGOING run log of the machine that sent it (run-log.md): who, to whom, what, how it ended.
// Real daemons on loopback, like holdE2e: A ("desktop") sends, B ("laptop") receives.

const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';
const idleTimer: InboxTimer = { set: () => 0, clear: () => undefined };

let root: string;
let a: string;
let b: string;
let address: string;
const stoppers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-runlog-e2e-'));
  a = join(root, 'a');
  b = join(root, 'b');
  await provision(root, a, b, [{ shell: SHELL, command: 'echo listed' }]);
  const daemon = await startMachineDaemon(b, { port: 0, version: 'e2e', peerPort: 0, peerHost: '127.0.0.1', advertise: [], inbox: { timer: idleTimer }, log: () => undefined });
  stoppers.push(daemon.stop);
  address = `127.0.0.1:${daemon.peerPort}`;
});
afterEach(async () => {
  while (stoppers.length > 0) {
    await stoppers.pop()?.();
  }
  rmSync(root, { recursive: true, force: true });
});

const run = (extra: string[], command: string[], to = 'laptop', addr = address) =>
  cli(a, ['run', to, '--address', addr, '--shell', SHELL, ...extra, '--', ...command], undefined, { allowLoopbackPeers: true, waitProgressMs: 100 });

const entries = (): RunLogEntry[] => readRunLog(a).entries;

describe('the outgoing run log of machine run', () => {
  it('records an allowed run: who sent it to whom, the command, the exit code, and no output', async () => {
    const r = await run([], ['echo', 'listed']);
    expect(r.code, r.err).toBe(0);
    expect(entries()).toHaveLength(1);
    const e = entries()[0] as RunLogEntry;
    expect(e).toMatchObject({
      v: 1,
      from: { name: 'desktop', uuid: readMachine(a).uuid },
      to: { name: 'laptop', uuid: readMachine(b).uuid },
      shell: SHELL,
      command: 'echo listed',
      truncated: false,
      waitMode: 'default',
      onRefusal: 'wait',
      waitSeconds: 600,
      outcome: 'ran',
      exitCode: 0,
    });
    expect(Date.now() - Date.parse(e.ts)).toBeLessThan(60_000);
    expect(e.durationMs).toBeGreaterThanOrEqual(0);
    expect(e.runId).toMatch(/^[0-9a-f-]{36}$/);
    // The output of the command is never stored.
    expect(readFileSync(join(runLogDir(a), RUN_LOG_FILE), 'utf8')).not.toMatch(/stdout|stderr/);
  });

  it('records a refusal with its reason, and that the wait came from a flag', async () => {
    const r = await run(['--no-wait'], ['echo', 'unlisted']);
    expect(r.code).toBe(255);
    expect(entries()[0]).toMatchObject({ outcome: 'refused', reason: 'not-listed', waitMode: 'flag', onRefusal: 'fail', command: 'echo unlisted' });
  });

  it('records an owner Deny as `denied`, with the time waited', async () => {
    const pending = run(['--wait', '10s'], ['echo', 'nope']);
    let id = '';
    for (let i = 0; i < 200 && id === ''; i++) {
      const listing = JSON.parse((await cli(b, ['requests', '--json'])).out) as { summary: { waiting: Array<{ id: string }> } };
      id = listing.summary.waiting[0]?.id ?? '';
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(id).not.toBe('');
    await cli(b, ['requests', '--deny', id.slice(0, 8)]);
    const r = await pending;
    expect(r.code).toBe(255);
    expect(entries()[0]).toMatchObject({ outcome: 'denied', reason: 'denied', waitMode: 'flag', onRefusal: 'wait', waitSeconds: 10 });
    expect(entries()[0]?.waitedSeconds).toBeGreaterThanOrEqual(0);
  });

  it('records a run that could not reach the peer as `error` with the cause', async () => {
    const r = await run(['--no-wait'], ['echo', 'listed'], 'laptop', '127.0.0.1:1');
    expect(r.code).toBe(255);
    const e = entries()[0] as RunLogEntry;
    expect(e.outcome).toBe('error');
    expect(e.cause).toBeTruthy();
    expect(e.to.name).toBe('laptop');
  });

  it('records nothing for a run refused before anything was sent (bad flag, unknown machine)', async () => {
    expect((await run([], ['echo', 'x'], 'nobody')).code).toBe(255);
    expect((await cli(a, ['run', 'laptop', '--shell', 'nope', '--', 'echo', 'x'], undefined, { allowLoopbackPeers: true })).code).toBe(255);
    expect(existsSync(runLogDir(a))).toBe(false);
  });

  it('never blocks the run when the log cannot be written: the run goes on and ONE [warn] names the folder and the fix', async () => {
    // A file where the folder should be.
    writeFileSync(runLogDir(a), 'not a folder');
    const r = await run(['--json'], ['echo', 'listed']);
    expect(r.code, r.err).toBe(0);
    expect((JSON.parse(r.out) as { stdout: string }).stdout).toContain('listed');
    const warnings = r.err.split('\n').filter((l) => l.startsWith('[warn]') && l.includes('run log'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(runLogDir(a));
    expect(warnings[0]).toMatch(/NOT recorded/);
  });

  it('two runs make two lines, oldest first, each with its own run id', async () => {
    await run([], ['echo', 'listed']);
    await run(['--no-wait'], ['echo', 'unlisted']);
    expect(entries().map((e) => e.outcome)).toEqual(['ran', 'refused']);
    expect(new Set(entries().map((e) => e.runId)).size).toBe(2);
  });
});
