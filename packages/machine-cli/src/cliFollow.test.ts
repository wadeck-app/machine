import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRunLogLine } from '@wadeck-app/machine-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readMachine } from './identity.js';
import { appendRunLog, RUN_LOG_FILE, runLogDir } from './runLogStore.js';
import { FileAuditLog } from './stores.js';
import { cli, provision } from './testing.js';

// `machine log --follow` (run-log.md): the live stream of the audit log and the run log of THIS machine. No real sleep: each "sleep" of the poll
// loop runs the next step of the script (a line appended, a file rotated) and, after the last step, one more poll and the Ctrl-C.

let root: string;
let a: string;
let b: string;
const iso = (): string => new Date().toISOString();

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-follow-'));
  a = join(root, 'a');
  b = join(root, 'b');
  await provision(root, a, b, [{ shell: 'sh', command: 'ls' }]);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Runs `machine log --follow <args>` on `config`; step n runs during the n-th sleep, the sleep after the last step is the Ctrl-C. */
async function follow(config: string, args: string[], steps: Array<() => void> = []): Promise<{ code: number; out: string; err: string; sleeps: number[] }> {
  const controller = new AbortController();
  const sleeps: number[] = [];
  const timing = {
    sleep: (ms: number): Promise<void> => {
      sleeps.push(ms);
      steps[sleeps.length - 1]?.();
      if (sleeps.length > steps.length) {
        controller.abort();
      }
      return Promise.resolve();
    },
    nowMs: (): number => Date.now(),
    pollIntervalMs: 500,
    signal: controller.signal,
  };
  const r = await cli(config, ['log', '--follow', ...args], undefined, { timing });
  return { ...r, sleeps };
}

/** B receives from A: writes lines of the audit log of B. */
function audit(...entries: Array<Record<string, string | number | boolean | null>>): void {
  auditAt(b, a, ...entries);
}

/** The audit log of the machine at `dir`, as written for requests from `peer`. */
function auditAt(dir: string, peer: string, ...entries: Array<Record<string, string | number | boolean | null>>): void {
  const log = new FileAuditLog(join(dir, 'audit.log'));
  for (const e of entries) {
    log.write({ ts: iso(), source: readMachine(peer).uuid, ...e });
  }
}

function sent(over: Record<string, unknown> = {}): void {
  const line = buildRunLogLine({
    now: Date.now(),
    runId: '00000000-0000-4000-8000-000000000001',
    from: { name: 'desktop', uuid: readMachine(a).uuid },
    to: { name: 'laptop', uuid: readMachine(b).uuid },
    shell: 'sh',
    command: 'ls -l',
    waitMode: 'default',
    onRefusal: 'wait',
    waitSeconds: 600,
    waitedSeconds: 0,
    outcome: { outcome: 'ran', exitCode: 0 },
    durationMs: 20,
    execMs: 12,
    ...over,
  } as Parameters<typeof buildRunLogLine>[0]);
  expect(appendRunLog(a, line).warnings).toEqual([]);
}

describe('machine log --follow', () => {
  it('shows, from now on, each request the daemon accepts and its end with exit code and run time, one line each, and exits 0', async () => {
    audit({ event: 'accepted', id: 'old', shell: 'sh', command: 'echo before-the-follow' });
    const r = await follow(b, ['--received'], [
      () => audit({ event: 'accepted', id: 'r1', shell: 'sh', command: 'ls -l' }),
      () => audit({ event: 'completed', id: 'r1', exitCode: 3, timedOut: false, truncated: false, durationMs: 1500 }),
      () => audit({ event: 'refused', id: 'r2', reason: 'not-listed', shell: 'sh', command: 'rm -rf x' }),
    ]);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toBe('');
    expect(r.out).not.toContain('before-the-follow');
    const rows = r.out.split('\n').filter((l) => l.includes('<='));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatch(/<= desktop -> laptop\s+sh\s+ls -l\s+running/);
    expect(rows[1]).toMatch(/<= desktop -> laptop\s+sh\s+ls -l\s+ran\s+3\s+1\.5 s/);
    expect(rows[2]).toMatch(/<= desktop -> laptop\s+sh\s+rm -rf x\s+refused \(not-listed\)/);
    expect(r.out).toMatch(/Following the activity of laptop \(received\)/);
    expect(r.out).toMatch(/TIME\s+FROM -> TO\s+SHELL\s+COMMAND\s+RESULT\s+EXIT\s+RAN\s+WAITED/);
    // 500 ms between two looks
    expect(new Set(r.sleeps)).toEqual(new Set([500]));
  });

  it('shows holds, sessions and documents with no row of their own as one line each', async () => {
    const r = await follow(b, ['--received'], [
      () => audit({ event: 'held', id: 'h1', shell: 'sh', command: 'df', waitSeconds: 600 }),
      () => audit({ event: 'hold-ended', id: 'h1', shell: 'sh', command: 'df', outcome: 'allowed' }),
      () => audit({ event: 'session-closed', reason: 'peer-revoked' }),
      () => audit({ event: 'document-accepted', kind: 'policy', id: 'd1' }),
    ]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/df\s+held\b/);
    expect(r.out).toMatch(/df\s+hold-ended \(allowed\)/);
    expect(r.out).toMatch(/session-closed \(peer-revoked\)/);
    expect(r.out).toMatch(/document-accepted \(policy\)/);
  });

  it('follows both the audit log and the run log without --received, and only one of them with --sent / --received', async () => {
    const steps = [() => auditAt(a, b, { event: 'accepted', id: 'r1', shell: 'sh', command: 'from-peer' }), () => sent({ command: 'to-peer' })];
    const both = await follow(a, [], steps);
    expect(both.err).not.toContain('[warn]');
    expect(both.out).toMatch(/Following the activity of desktop \(sent and received\)/);
    expect(both.out).toMatch(/<= laptop -> desktop\s+sh\s+from-peer\s+running/);
    expect(both.out).toMatch(/=> desktop -> laptop\s+sh\s+to-peer\s+ran\s+0\s+12 ms/);
    const onlySent = await follow(a, ['--sent'], [() => sent({ command: 'only-sent-seen' }), () => auditAt(a, b, { event: 'accepted', id: 'r9', shell: 'sh', command: 'audit-not-seen' })]);
    expect(onlySent.out).toContain('only-sent-seen');
    expect(onlySent.out).not.toContain('audit-not-seen');
  });

  it('shows the history of --since first, oldest first, then the new entries', async () => {
    sent({ command: 'history-one' });
    sent({ command: 'history-two', runId: '00000000-0000-4000-8000-000000000002' });
    const r = await follow(a, ['--sent', '--since', '1h'], [() => sent({ command: 'live-three', runId: '00000000-0000-4000-8000-000000000003' })]);
    expect(r.code, r.err).toBe(0);
    const order = ['history-one', 'history-two', 'live-three'].map((c) => r.out.indexOf(c));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((x, y) => x - y));
  });

  it('says what is left out of a --since history cut by --limit, and refuses --limit without --since', async () => {
    for (let i = 1; i <= 3; i++) {
      sent({ command: `run-${i}`, runId: `00000000-0000-4000-8000-00000000000${i}` });
    }
    const cut = await follow(a, ['--sent', '--since', '1h', '--limit', '2']);
    expect(cut.err).toMatch(/\[info\] 1 older entries match --since 1h/);
    const bad = await follow(a, ['--limit', '2']);
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/--limit only applies to the history shown first.*--since/);
  });

  it('waits for a log that does not exist yet and follows it from its first line', async () => {
    const r = await follow(b, ['--received'], [() => audit({ event: 'accepted', id: 'r1', shell: 'sh', command: 'first-ever' })]);
    expect(r.err).toMatch(/\[info\] the audit log .*audit\.log does not exist yet/);
    expect(r.out).toContain('first-ever');
  });

  it('a damaged line is a [warn] line, not a crash, and the next lines are shown', async () => {
    audit({ event: 'daemon-started' });
    const r = await follow(b, ['--received'], [
      () => appendFileSync(join(b, 'audit.log'), '{"seq": 1, "pr\n'),
      () => appendFileSync(join(b, 'audit.log'), 'not json at all\n'),
    ]);
    expect(r.code, r.err).toBe(0);
    expect(r.err.match(/\[warn\] a damaged line of the audit log was skipped/g)).toHaveLength(2);
    expect(r.err).toContain(join(b, 'audit.log'));
  });

  it('checks the chain only on the lines it reads: a line that does not follow the previous one is ONE warning, then the entries are [UNVERIFIED]', async () => {
    audit({ event: 'daemon-started' });
    const r = await follow(b, ['--received'], [
      () => {
        // A line of another chain: valid by itself, but it does not follow the one before it.
        const other = new FileAuditLog(join(root, 'other.log'));
        other.write({ ts: iso(), event: 'daemon-started' });
        other.write({ ts: iso(), event: 'accepted', source: readMachine(a).uuid, id: 'x1', shell: 'sh', command: 'after-the-break' });
        const lines = readFileSync(join(root, 'other.log'), 'utf8');
        appendFileSync(join(b, 'audit.log'), lines);
      },
    ]);
    expect(r.code, r.err).toBe(0);
    expect(r.err.match(/\[warn\] the audit log is broken at line/g)).toHaveLength(1);
    expect(r.out).toContain('after-the-break');
    expect(r.out).toMatch(/\[UNVERIFIED\]/);
  });

  it('follows the run log through a rotation (the file is replaced) and says so', async () => {
    sent({ command: 'before-rotation' });
    const dir = runLogDir(a);
    const r = await follow(a, ['--sent'], [
      () => sent({ command: 'live-one' }),
      () => {
        renameSync(join(dir, RUN_LOG_FILE), join(dir, 'runs.1700000000000-1.ndjson'));
        sent({ command: 'after-rotation', runId: '00000000-0000-4000-8000-000000000009' });
      },
    ]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('live-one');
    expect(r.out).toContain('after-rotation');
    expect(r.out).not.toContain('before-rotation');
    expect(r.err).toMatch(/\[info\] the run log was (replaced \(rotation\)|cut): following it from its start/);
  });

  it('follows the audit log again from its start after it was truncated', async () => {
    audit({ event: 'daemon-started' }, { event: 'daemon-started' });
    const r = await follow(b, ['--received'], [
      () => truncateSync(join(b, 'audit.log'), 0),
      () => writeFileSync(join(b, 'audit.log'), ''),
      () => audit({ event: 'accepted', id: 'r1', shell: 'sh', command: 'after-truncation' }),
    ]);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toMatch(/\[info\] the audit log was cut: following it from its start/);
    expect(r.err).not.toMatch(/broken/);
    expect(r.out).toContain('after-truncation');
  });

  it('never prints an environment, an output, or a free message of an entry', async () => {
    const r = await follow(b, ['--received'], [() => audit({ event: 'session-error', error: 'boom', env: 'TOKEN=hunter2', stdout: 'TOPSECRET-OUTPUT', message: 'FREE-MESSAGE', passphrase: 'pp-secret' })]);
    const all = r.out + r.err;
    for (const secret of ['hunter2', 'TOPSECRET-OUTPUT', 'FREE-MESSAGE', 'pp-secret']) {
      expect(all).not.toContain(secret);
    }
    expect(r.out).toMatch(/session-error \(boom\)/);
  });

  it('prints one JSON object per line with --json', async () => {
    const r = await follow(b, ['--received', '--json'], [() => audit({ event: 'accepted', id: 'r1', shell: 'sh', command: 'ls' })]);
    const rows = r.out.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as { command: string; outcome: string });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ command: 'ls', outcome: 'running' });
  });

  it('refuses what it cannot do, with the fix: filters, both directions, extra words, a machine that is not initialized', async () => {
    for (const [args, message] of [
      [['--machine', 'laptop'], /--machine does not combine with --follow/],
      [['--outcome', 'ran'], /--outcome does not combine with --follow/],
      [['--text', 'x'], /--text does not combine with --follow/],
      [['--offset', '5'], /--offset does not combine with --follow/],
      [['--sent', '--received'], /contradict each other/],
      [['stray'], /unexpected argument "stray"/],
    ] as const) {
      const r = await follow(b, [...args]);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err).toMatch(message);
    }
    const none = await follow(join(root, 'nothing-here'), []);
    expect(none.code).toBe(1);
    expect(none.err).toMatch(/not initialized|machine init|setup/i);
  });

  it('-f is the same as --follow, and --follow elsewhere says where it applies', async () => {
    const controller = new AbortController();
    controller.abort();
    const timing = { sleep: (): Promise<void> => Promise.resolve(), nowMs: (): number => Date.now(), pollIntervalMs: 500, signal: controller.signal };
    const r = await cli(b, ['log', '-f', '--received'], undefined, { timing });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/Following the activity of laptop/);
    const other = await cli(b, ['list', '--follow']);
    expect(other.code).toBe(2);
    expect(other.err).toMatch(/--follow only applies to `machine log`.*`machine cli logs`/);
  });
});

