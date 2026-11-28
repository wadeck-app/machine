import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMachineDaemon } from './daemonEntry.js';
import type { InboxTimer } from './inboxLoop.js';
import { runDefaultsFile } from './runDefaultsStore.js';
import { cli, provision } from './testing.js';

// `machine run` waits by default (flags > machine setting run-defaults.json > built-in 10m), `machine run-defaults` reads and changes the setting.

const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';
const idleTimer: InboxTimer = { set: () => 0, clear: () => undefined };

let root: string;
let a: string;
let b: string;
let address: string;
const stoppers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-run-defaults-cli-'));
  a = join(root, 'a');
  b = join(root, 'b');
  await provision(root, a, b, [{ shell: SHELL, command: 'echo listed' }]);
  const daemon = await startMachineDaemon(b, { port: 0, version: 'e2e', peerPort: 0, peerHost: '127.0.0.1', advertise: [], inbox: { timer: idleTimer }, log: () => undefined });
  stoppers.push(daemon.stop);
  address = `127.0.0.1:${daemon.peerPort}`;
});
afterEach(async () => {
  while (stoppers.length > 0) await stoppers.pop()?.();
  rmSync(root, { recursive: true, force: true });
});

const run = (flags: string[], command: string[] = ['echo', 'later']) =>
  cli(a, ['run', 'laptop', '--address', address, '--shell', SHELL, ...flags, '--', ...command], undefined, { allowLoopbackPeers: true, waitProgressMs: 100, waitNoticeMs: 30 });

type Waiting = Array<{ id: string }>;
const waitingOf = async (): Promise<Waiting> => (JSON.parse((await cli(b, ['requests', '--json'])).out) as { summary: { waiting: Waiting } }).summary.waiting;

async function waitingCount(count: number): Promise<Waiting> {
  for (let i = 0; i < 300; i++) {
    const waiting = await waitingOf();
    if (waiting.length >= count) {
      return waiting;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${count} request(s) were never held`);
}

const denyAll = async (waiting: Waiting): Promise<void> => {
  for (const w of waiting) {
    await cli(b, ['requests', '--deny', w.id.slice(0, 8)]);
  }
};

describe('machine run-defaults', () => {
  it('shows the built-in default and the way to change it', async () => {
    const r = await cli(a, ['run-defaults']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/on refusal: wait \(built-in default\)/);
    expect(r.out).toMatch(/wait: 10m \(built-in default\)/);
    expect(r.out).toMatch(/machine run-defaults --on-refusal wait\|fail/);
    expect(r.out).toMatch(/--no-wait/);
  });

  it('sets the mode and the duration, shows where they come from, and --json is one document', async () => {
    const set = await cli(a, ['run-defaults', '--on-refusal', 'wait', '--wait', '15m']);
    expect(set.code, set.err).toBe(0);
    expect(JSON.parse(readFileSync(runDefaultsFile(a), 'utf8'))).toEqual({ v: 1, onRefusal: 'wait', waitSeconds: 900 });
    const shown = await cli(a, ['run-defaults']);
    expect(shown.out).toMatch(/on refusal: wait \(setting run-defaults\)/);
    expect(shown.out).toMatch(/wait: 15m \(setting run-defaults\)/);
    const json = await cli(a, ['run-defaults', '--json']);
    expect(JSON.parse(json.out)).toMatchObject({ onRefusal: 'wait', onRefusalSource: 'setting', waitSeconds: 900, waitSecondsSource: 'setting', file: runDefaultsFile(a) });
  });

  it('--on-refusal fail keeps a stored duration (unused while it fails)', async () => {
    await cli(a, ['run-defaults', '--wait', '20m']);
    const r = await cli(a, ['run-defaults', '--on-refusal', 'fail']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/on refusal: fail \(setting run-defaults\)/);
    expect(JSON.parse(readFileSync(runDefaultsFile(a), 'utf8'))).toEqual({ v: 1, onRefusal: 'fail', waitSeconds: 1200 });
  });

  it('--reset deletes the setting; it says so when there was none', async () => {
    await cli(a, ['run-defaults', '--on-refusal', 'fail']);
    const first = await cli(a, ['run-defaults', '--reset']);
    expect(first.code, first.err).toBe(0);
    expect(first.out).toMatch(/built-in default/);
    const again = await cli(a, ['run-defaults', '--reset']);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/no setting/);
  });

  it.each([
    ['a bad mode', ['--on-refusal', 'retry'], /--on-refusal "retry".*wait.*fail/s],
    ['a duration without unit', ['--wait', '10'], /no unit/],
    ['a duration out of range', ['--wait', '2h'], /outside 10 s to 60 min/],
    ['--no-wait (a per-run flag)', ['--no-wait'], /--no-wait.*machine run-defaults --on-refusal fail/s],
    ['--reset with another option', ['--reset', '--wait', '5m'], /--reset.*alone/s],
    ['a positional argument', ['laptop'], /unexpected argument "laptop"/],
  ])('refuses %s, nothing is written', async (_name, args, message) => {
    const r = await cli(a, ['run-defaults', ...args]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(message);
    expect((await cli(a, ['run-defaults'])).out).toMatch(/built-in default/);
  });

  it('a damaged file is a loud error naming the file and the fix; no fallback, no overwrite', async () => {
    writeFileSync(runDefaultsFile(a), '{ nope');
    for (const args of [['run-defaults'], ['run-defaults', '--on-refusal', 'fail']]) {
      const r = await cli(a, args);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain(runDefaultsFile(a));
      expect(r.err).toMatch(/machine run-defaults --reset/);
    }
    expect(readFileSync(runDefaultsFile(a), 'utf8')).toBe('{ nope');
    // --reset is the way out.
    const reset = await cli(a, ['run-defaults', '--reset']);
    expect(reset.code, reset.err).toBe(0);
  });

  it('the flags only belong to the commands they configure', async () => {
    const r = await cli(a, ['status', '--on-refusal', 'fail']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--on-refusal only applies to `machine run` and `machine run-defaults`/);
    const w = await cli(a, ['list', '--no-wait']);
    expect(w.code).toBe(2);
    expect(w.err).toMatch(/--no-wait only applies to/);
  });
});

describe('machine status', () => {
  it('ends with the effective behaviour of run and where it comes from', async () => {
    const r = await cli(a, ['status']);
    expect(r.code, r.err).toBe(0);
    expect(r.out.trimEnd().split('\n').at(-1)).toMatch(/^run: when a target does not allow a command yet: wait 10m \(built-in default\)/);
    await cli(a, ['run-defaults', '--on-refusal', 'fail']);
    const set = await cli(a, ['status']);
    expect(set.out.trimEnd().split('\n').at(-1)).toMatch(/^run: when a target does not allow a command yet: fail at once \(setting run-defaults\)/);
    const json = await cli(a, ['status', '--json']);
    expect(JSON.parse(json.out).runDefaults).toMatchObject({ onRefusal: 'fail', onRefusalSource: 'setting' });
  });

  it('a damaged file is a [warn] line with the fix (status stays readable) and an error field in --json', async () => {
    writeFileSync(runDefaultsFile(a), '{ nope');
    const r = await cli(a, ['status']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/\[warn\].*run-defaults\.json.*machine run-defaults --reset/s);
    const json = await cli(a, ['status', '--json']);
    expect(JSON.parse(json.out).runDefaults.error).toMatch(/run-defaults\.json/);
  });
});

describe('machine run: the wait is the default', () => {
  it('holds a refused command by default, says so once on stderr, and the owner Deny answers it', async () => {
    const pending = run([]);
    await denyAll(await waitingCount(1));
    const r = await pending;
    expect(r.code).toBe(255);
    expect(r.err).toContain('refused by laptop: denied');
    const notices = r.err.split('\n').filter((l) => l.includes('waiting up to 10m for laptop to allow it (default; --no-wait to fail at once)'));
    expect(notices).toHaveLength(1);
    expect(r.err.indexOf('waiting up to 10m')).toBeLessThan(r.err.indexOf('refused by'));
  });

  it('a command that is allowed keeps a clean stderr: the notice is only for an answer that is not immediate', async () => {
    const r = await cli(a, ['run', 'laptop', '--address', address, '--shell', SHELL, '--', 'echo', 'listed'], undefined, { allowLoopbackPeers: true, waitNoticeMs: 60_000 });
    expect(r.code, r.err).toBe(0);
    expect(r.err).toBe('');
  });

  it('--json keeps stdout clean while the notice goes to stderr', async () => {
    const pending = run(['--json']);
    await denyAll(await waitingCount(1));
    const r = await pending;
    // The refusal is one document too (decision 114, D5): the notice stays on stderr.
    expect(JSON.parse(r.out)).toMatchObject({ type: 'refused', code: 'denied' });
    expect(r.err).toMatch(/waiting up to 10m for laptop/);
  });

  it('--no-wait refuses at once, as before, without a notice', async () => {
    const r = await run(['--no-wait']);
    expect(r.code).toBe(255);
    expect(r.err).toContain('refused by laptop: not-listed');
    expect(r.err).not.toMatch(/waiting up to/);
  });

  it('--on-refusal fail is the same as --no-wait', async () => {
    const r = await run(['--on-refusal', 'fail']);
    expect(r.code).toBe(255);
    expect(r.err).toContain('refused by laptop: not-listed');
  });

  it('the machine setting fail makes the refusal immediate; --wait on the command line wins over it, with no default notice', async () => {
    await cli(a, ['run-defaults', '--on-refusal', 'fail']);
    const immediate = await run([]);
    expect(immediate.err).toContain('refused by laptop: not-listed');
    expect(immediate.err).not.toMatch(/waiting up to/);
    const pending = run(['--wait', '10s']);
    await denyAll(await waitingCount(1));
    const r = await pending;
    expect(r.err).toContain('refused by laptop: denied');
    expect(r.err).not.toMatch(/waiting up to/);
  });

  it('a wait from the setting says where it comes from', async () => {
    await cli(a, ['run-defaults', '--wait', '90s']);
    const pending = run([]);
    await denyAll(await waitingCount(1));
    const r = await pending;
    expect(r.err).toContain('waiting up to 90s for laptop to allow it (setting run-defaults; --no-wait to fail at once)');
  });

  it.each([
    ['--no-wait with --wait', ['--no-wait', '--wait', '5m'], /--no-wait.*--wait.*contradict/s],
    ['--on-refusal fail with --wait', ['--on-refusal', 'fail', '--wait', '5m'], /--on-refusal fail.*--wait.*contradict/s],
    ['--no-wait with --on-refusal wait', ['--no-wait', '--on-refusal', 'wait'], /--no-wait.*--on-refusal wait.*contradict/s],
  ])('refuses %s before any connection', async (_name, flags, message) => {
    const r = await run(flags);
    expect(r.code).toBe(255);
    expect(r.err).toMatch(message);
    expect(await waitingOf()).toEqual([]);
  });

  it('a damaged setting stops the run loudly, even with --no-wait, and nothing is sent', async () => {
    writeFileSync(runDefaultsFile(a), '{ nope');
    const r = await run(['--no-wait']);
    expect(r.code).toBe(255);
    expect(r.err).toContain(runDefaultsFile(a));
    expect(r.err).toMatch(/machine run-defaults --reset/);
    expect(await waitingOf()).toEqual([]);
  });

  it('a hold limit tells the caller what to do now that waiting is the default', async () => {
    // The owner of the target lowered the limit to 2 per peer AFTER its daemon started (hold-limits.json, read at each admission): the third is refused at once, with the advice.
    expect((await cli(b, ['hold-limits', '--per-peer', '2'])).code).toBe(0);
    const first = run([], ['echo', 'one']);
    const second = run([], ['echo', 'two']);
    await waitingCount(2);
    const third = await run([], ['echo', 'three']);
    expect(third.code).toBe(255);
    expect(third.err).toContain('hold-limit-peer');
    expect(third.err).toContain('machine hold-limits --per-peer <n>');
    expect(third.err).toMatch(/wait for the owner of laptop to answer the pending ones/);
    expect(third.err).toMatch(/--no-wait/);
    await denyAll(await waitingOf());
    await Promise.all([first, second]);
  });
});
