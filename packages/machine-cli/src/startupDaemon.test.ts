import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli } from './testing.js';
import { makeOrchStub, type OrchStub } from './orchStub.js';
import { readDaemonState } from './daemonPortFile.js';
import { enableStartup, type DaemonSource } from './startup.js';

// `machine startup enable` starts the daemon NOW when it is not running (a `startup` job only starts when orch starts, at login);
// `machine status` and `machine startup status` say whether it runs. orch is a stub, never the real one.

const UNIX_BUNDLE: DaemonSource = { platform: 'linux', execPath: '/usr/bin/node', scriptPath: '/opt/machine.cjs' };
const LIVE = { pid: 4242, port: 5555, peerPort: 6666 };

let root: string;
let configDir: string;
let stub: OrchStub;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'machine-startup-daemon-'));
  configDir = join(root, 'config');
  mkdirSync(configDir);
  stub = makeOrchStub();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(stub.dir, { recursive: true, force: true });
});

const portFile = () => join(configDir, 'daemon.port.json');
const portFileContent = (info = LIVE) => `${JSON.stringify(info)}\n`;
/** What orch `restart-job` answers when it started the job (the stub also writes the port file a started daemon writes). */
const startsDaemon = () => ({ stdout: JSON.stringify({ id: 'machine', wasRunning: false, killed: 0, started: true, pid: 77 }), writeFile: { path: portFile(), content: portFileContent() } });
const alive = (pid: number) => pid === LIVE.pid;
const base = () => ({ configDir, orch: stub.orch, daemon: UNIX_BUNDLE, platform: 'linux' as const, isAlive: alive, startWaitMs: 400, startPollMs: 10 });
const restartCalls = () => stub.calls().filter((c) => c[0] === 'restart-job');

describe('readDaemonState (daemon.port.json + a live pid, read only)', () => {
  it('no file: not running, no problem to report', () => {
    expect(readDaemonState(configDir, alive)).toEqual({ running: false });
  });

  it('a file whose pid is alive: running, with the pid and the ports', () => {
    writeFileSync(portFile(), portFileContent());
    expect(readDaemonState(configDir, alive)).toEqual({ running: true, ...LIVE });
  });

  it('a stale file (its pid is gone): not running, and it says the file is stale', () => {
    writeFileSync(portFile(), portFileContent({ ...LIVE, pid: 1 }));
    const s = readDaemonState(configDir, alive);
    expect(s.running).toBe(false);
    expect(s).toMatchObject({ problem: expect.stringMatching(/pid 1, which is not running.*stale/) as string });
  });

  it('a damaged file: not running, and the problem names the file and the fix', () => {
    writeFileSync(portFile(), '{not json');
    const s = readDaemonState(configDir, alive);
    expect(s.running).toBe(false);
    expect(s).toMatchObject({ problem: expect.stringMatching(/daemon\.port\.json.*not valid.*delete it/s) as string });
    writeFileSync(portFile(), JSON.stringify({ pid: 'x' }));
    expect(readDaemonState(configDir, alive)).toMatchObject({ running: false, problem: expect.stringMatching(/pid.*port.*peerPort/s) as string });
  });
});

describe('enableStartup starts the daemon now when it is not running', () => {
  it('down: orch restart-job <id> --json (never trigger), then waits for the port file', async () => {
    stub.script({ ensure: { stdout: 'added machine\n' }, 'restart-job': startsDaemon() });
    const r = await enableStartup(base());
    expect(stub.calls().map((c) => c[0])).toEqual(['ensure', 'restart-job']);
    expect(restartCalls()).toEqual([['restart-job', 'machine', '--json']]);
    expect(r.daemon).toEqual({ running: true, started: true, pid: LIVE.pid, peerPort: LIVE.peerPort });
  });

  it('already running: untouched, no restart-job', async () => {
    writeFileSync(portFile(), portFileContent());
    stub.script({ ensure: { stdout: 'unchanged machine\n' } });
    const r = await enableStartup(base());
    expect(stub.calls().map((c) => c[0])).toEqual(['ensure']);
    expect(r.daemon).toEqual({ running: true, started: false, pid: LIVE.pid, peerPort: LIVE.peerPort });
  });

  it('already running with an outdated command: orch ensure --restart-if-changed restarts it, enable does not add a second restart', async () => {
    writeFileSync(portFile(), portFileContent());
    stub.script({ ensure: { stdout: 'updated machine\n' } });
    const r = await enableStartup(base());
    expect(restartCalls()).toEqual([]);
    expect(r.action).toBe('updated');
    expect(r.daemon.running).toBe(true);
  });

  it('a stale port file counts as down: the daemon is started', async () => {
    writeFileSync(portFile(), portFileContent({ ...LIVE, pid: 1 }));
    stub.script({ ensure: { stdout: 'unchanged machine\n' }, 'restart-job': startsDaemon() });
    const r = await enableStartup(base());
    expect(restartCalls()).toHaveLength(1);
    expect(r.daemon).toMatchObject({ running: true, started: true });
  });

  it('start: false (--no-start): the job is registered, nothing is started, the state is still reported', async () => {
    stub.script({ ensure: { stdout: 'added machine\n' } });
    const r = await enableStartup({ ...base(), start: false });
    expect(stub.calls().map((c) => c[0])).toEqual(['ensure']);
    expect(r.daemon).toEqual({ running: false, started: false });
  });

  it('restart-job answers started but no port file appears: not an exception, a reason with the wait and the fix', async () => {
    stub.script({ ensure: { stdout: 'added machine\n' }, 'restart-job': { stdout: JSON.stringify({ started: true, pid: 77 }) } });
    const r = await enableStartup({ ...base(), startWaitMs: 60 });
    expect(r.action).toBe('added');
    expect(r.daemon.running).toBe(false);
    expect(r.daemon.started).toBe(false);
    expect(r.daemon.reason).toMatch(/did not start within/);
    expect(r.daemon.reason).toMatch(/machine daemon/);
    expect(r.daemon.reason).toMatch(/machine cli logs/);
    expect(r.daemon.reason).toMatch(/orch logs/);
  });

  it('restart-job refuses (exit 1 with a JSON reason): the reason of orch is carried, the job stays registered', async () => {
    stub.script({ ensure: { stdout: 'added machine\n' }, 'restart-job': { code: 1, stdout: JSON.stringify({ started: false, skipped: 'concurrency', reason: 'the job is at its limit of 1 run' }) } });
    const r = await enableStartup(base());
    expect(r.daemon).toMatchObject({ running: false, started: false });
    expect(r.daemon.reason).toMatch(/the job is at its limit of 1 run/);
  });

  it('restart-job fails with plain text (exit 1, stderr): stderr is carried', async () => {
    stub.script({ ensure: { stdout: 'added machine\n' }, 'restart-job': { code: 1, stderr: 'Job "machine" is disabled\n' } });
    const r = await enableStartup(base());
    expect(r.daemon.reason).toMatch(/Job "machine" is disabled/);
  });

  it('restart-job skipped by the liveness check while the file now shows a live daemon: running, not started by us', async () => {
    stub.script({ ensure: { stdout: 'added machine\n' }, 'restart-job': { code: 1, stdout: JSON.stringify({ started: false, skipped: 'liveness', reason: 'alive' }), writeFile: { path: portFile(), content: portFileContent() } } });
    const r = await enableStartup(base());
    expect(r.daemon).toEqual({ running: true, started: false, pid: LIVE.pid, peerPort: LIVE.peerPort });
  });

  it('a failing ensure still throws and nothing is started', async () => {
    stub.script({ ensure: { code: 1, stderr: 'locked' } });
    await expect(enableStartup(base())).rejects.toThrow(/locked/);
    expect(restartCalls()).toEqual([]);
  });
});

describe('machine startup enable (CLI)', () => {
  const run = (args: string[], extra: Record<string, unknown> = {}) => cli(configDir, args, undefined, { startup: { orch: stub.orch, daemon: UNIX_BUNDLE, platform: 'linux', isAlive: alive, startWaitMs: 400, startPollMs: 10, ...extra } });

  it('down -> started: prints the job, then `[ok] daemon started (peer port N)`', async () => {
    stub.script({ ensure: { stdout: 'added machine\n' }, 'restart-job': startsDaemon() });
    const r = await run(['startup', 'enable']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('[ok] startup job "machine" added');
    expect(r.out).toContain('[ok] daemon started (peer port 6666)');
  });

  it('already running: `[ok] daemon already running (peer port N, pid P)`, nothing restarted', async () => {
    writeFileSync(portFile(), portFileContent());
    stub.script({ ensure: { stdout: 'unchanged machine\n' } });
    const r = await run(['startup', 'enable']);
    expect(r.out).toContain('[ok] daemon already running (peer port 6666, pid 4242)');
    expect(restartCalls()).toEqual([]);
  });

  it('started but no daemon comes up in time: `[warn] the job is registered but the daemon did not start within N s: ...`', async () => {
    stub.script({ ensure: { stdout: 'added machine\n' }, 'restart-job': { stdout: JSON.stringify({ started: true, pid: 77 }) } });
    const r = await run(['startup', 'enable'], { startWaitMs: 1000 });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\[warn\] the job is registered but the daemon did not start within 1 s: .*machine daemon.*machine cli logs/s);
  });

  it('start fails: exit 0 (the job is registered), `[warn]` with cause and fix on stdout', async () => {
    stub.script({ ensure: { stdout: 'added machine\n' }, 'restart-job': { code: 1, stderr: 'Job "machine" not started: spawn failed\n' } });
    const r = await run(['startup', 'enable'], { startWaitMs: 15000 });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\[warn\] the job is registered but orch did not start it: .*spawn failed/);
    expect(r.out).toMatch(/machine daemon/);
    expect(r.out).toMatch(/machine cli logs/);
  });

  it('--no-start: the job only, one honest line says the daemon was not started and how to start it', async () => {
    stub.script({ ensure: { stdout: 'added machine\n' } });
    const r = await run(['startup', 'enable', '--no-start']);
    expect(r.code, r.err).toBe(0);
    expect(restartCalls()).toEqual([]);
    expect(r.out).toMatch(/\[info\] daemon not started \(--no-start\).*orch restart-job machine/);
  });

  it('--json: one document with daemon {running, started, peerPort}', async () => {
    stub.script({ ensure: { stdout: 'added machine\n' }, 'restart-job': startsDaemon() });
    const r = await run(['startup', 'enable', '--json']);
    expect(JSON.parse(r.out)).toMatchObject({ action: 'added', daemon: { running: true, started: true, peerPort: 6666 } });
  });

  it('--json with a start that failed: daemon.reason in the document, the warning on stderr', async () => {
    stub.script({ ensure: { stdout: 'added machine\n' }, 'restart-job': { code: 1, stderr: 'nope' } });
    const r = await run(['startup', 'enable', '--json']);
    expect(JSON.parse(r.out).daemon).toMatchObject({ running: false, started: false, reason: expect.stringContaining('nope') as string });
    expect(r.err).toContain('[warn]');
  });

  it('--no-start only applies to startup enable, join and setup', async () => {
    const r = await cli(configDir, ['status', '--no-start']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--no-start only applies to `machine startup enable`, `machine join` and `machine setup`/);
  });
});

describe('machine startup status shows whether the daemon runs', () => {
  const run = (args: string[]) => cli(configDir, args, undefined, { startup: { orch: stub.orch, daemon: UNIX_BUNDLE, platform: 'linux', isAlive: alive } });

  it('job present, daemon down: says so and how to start it', async () => {
    stub.script({ show: { stdout: JSON.stringify({ command: 'old' }) }, list: { stdout: '[]' } });
    const r = await run(['startup', 'status']);
    expect(r.out).toMatch(/daemon: NOT running: start it with `orch restart-job machine` or `machine startup enable`/);
    expect(restartCalls()).toEqual([]);
  });

  it('job present, daemon up: pid and peer port', async () => {
    writeFileSync(portFile(), portFileContent());
    stub.script({ show: { stdout: JSON.stringify({ command: 'old' }) }, list: { stdout: '[]' } });
    const r = await run(['startup', 'status']);
    expect(r.out).toContain('daemon: running (peer port 6666, pid 4242)');
    const j = await run(['startup', 'status', '--json']);
    expect(JSON.parse(j.out).daemon).toEqual({ running: true, ...LIVE });
  });

  it('job absent: the daemon state is still shown', async () => {
    stub.script({ show: { code: 3 }, list: { stdout: '[]' } });
    const r = await run(['startup', 'status', '--json']);
    expect(JSON.parse(r.out)).toMatchObject({ exists: false, daemon: { running: false } });
  });
});

describe('machine status shows whether the daemon runs (read only, no network, never starts anything)', () => {
  const init = async () => {
    const r = await cli(configDir, ['init', '--name', 'desktop']);
    expect(r.code, r.err).toBe(0);
  };
  const run = (args: string[]) => cli(configDir, args, undefined, { startup: { orch: stub.orch, daemon: UNIX_BUNDLE, platform: 'linux', isAlive: alive } });

  it('down: `daemon: NOT running: start it with machine startup enable (at login) or machine daemon`', async () => {
    await init();
    const r = await run(['status']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('daemon: NOT running: start it with machine startup enable (at login) or machine daemon');
    expect(stub.calls()).toEqual([]);
  });

  it('up: pid and peer port from the port file', async () => {
    await init();
    writeFileSync(portFile(), portFileContent());
    const r = await run(['status']);
    expect(r.out).toContain('daemon: running (peer port 6666, pid 4242)');
  });

  it('--json carries daemon', async () => {
    await init();
    expect(JSON.parse((await run(['status', '--json'])).out).daemon).toEqual({ running: false });
    writeFileSync(portFile(), portFileContent());
    expect(JSON.parse((await run(['status', '--json'])).out).daemon).toEqual({ running: true, ...LIVE });
  });

  it('a stale or damaged file is said, not hidden', async () => {
    await init();
    writeFileSync(portFile(), '{broken');
    const r = await run(['status']);
    expect(r.out).toMatch(/daemon: NOT running.*\n.*daemon\.port\.json.*not valid/s);
  });
});

describe('callers of enable', () => {
  it('post-update (default wiring) refreshes the job but never starts the daemon: a daemon stopped on purpose stays stopped', async () => {
    const source: DaemonSource = UNIX_BUNDLE;
    // `machine cli post-update` through runCli, with the real startup wiring and the orch stub; only the daemon probe is injected.
    stub.script({ show: { stdout: JSON.stringify({ command: 'old' }) }, list: { stdout: '[]' }, ensure: { stdout: 'updated machine\n' }, 'restart-job': startsDaemon() });
    let out = '';
    let err = '';
    const { runCli } = await import('./cli.js');
    const code = await runCli(['cli', 'post-update', '--config-dir', configDir], {
      stdout: (t) => (out += t),
      stderr: (t) => (err += t),
      startup: { orch: stub.orch, daemon: source, platform: 'linux', isAlive: alive },
      cliMeta: { version: '2026.11.14-592-bbbbbbbb', postUpdate: { daemon: { version: async () => undefined, quit: async () => undefined } } },
    });
    expect({ code, err }).toEqual({ code: 0, err: '' });
    expect(out).toMatch(/\[ok\] startup job updated/);
    expect(out).toMatch(/no daemon running/);
    expect(stub.calls().map((c) => c[0])).toEqual(['show', 'list', 'ensure']);
  });
});
