import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRunLogLine, type RunLogInput } from '@wadeck-app/machine-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readMachine } from './identity.js';
import { appendRunLog, RUN_LOG_FILE, runLogDir } from './runLogStore.js';
import { FileAuditLog } from './stores.js';
import { cli, provision } from './testing.js';

// `machine log` (run-log.md): the outgoing run log and the audit log of THIS machine as one timeline. A is "desktop" (sends), B is "laptop".

let root: string;
let a: string;
let b: string;
const iso = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * 60_000).toISOString();

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-log-'));
  a = join(root, 'a');
  b = join(root, 'b');
  await provision(root, a, b, [{ shell: 'sh', command: 'ls' }]);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function send(minutesAgo: number, over: Partial<RunLogInput> = {}): void {
  const to = { name: 'laptop', uuid: readMachine(b).uuid };
  const line = buildRunLogLine({ now: Date.now() - minutesAgo * 60_000, runId: `00000000-0000-4000-8000-${String(minutesAgo).padStart(12, '0')}`, from: { name: 'desktop', uuid: readMachine(a).uuid }, to, shell: 'sh', command: 'ls -l', waitMode: 'default', onRefusal: 'wait', waitSeconds: 600, waitedSeconds: 0, outcome: { outcome: 'ran', exitCode: 0 }, durationMs: 20, ...over });
  const result = appendRunLog(a, line);
  expect(result.warnings).toEqual([]);
}

/** B received commands from A (the audit log of B). */
function receive(minutesAgo: number, event: Array<Record<string, string | number | boolean | null>>): void {
  const log = new FileAuditLog(join(b, 'audit.log'));
  for (const e of event) {
    log.write({ ts: iso(minutesAgo), source: readMachine(a).uuid, ...e });
  }
}

const widest = (text: string): number => Math.max(...text.split('\n').map((l) => l.length));

describe('machine log', () => {
  it('says so, with what to do, when nothing was sent or received yet', async () => {
    const r = await cli(a, ['log']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/Activity of desktop: 0 entries \(0 sent, 0 received\)/);
    expect(r.out).toMatch(/no activity yet/);
  });

  it('lists sent runs on the sender: header with counts, aligned rows, arrow, from -> to, shell, command, outcome', async () => {
    send(30);
    send(10, { command: 'df -h', outcome: { outcome: 'refused', reason: 'not-listed' }, waitMode: 'flag' });
    const r = await cli(a, ['log']);
    expect(r.code, r.err).toBe(0);
    const lines = r.out.split('\n');
    expect(lines[0]).toMatch(/^Activity of desktop: 2 entries \(2 sent, 0 received\), newest first, showing 1-2$/);
    expect(lines[1]).toMatch(/^TIME\s+FROM -> TO\s+SHELL\s+COMMAND\s+RESULT\s+EXIT\s+RAN\s+WAITED$/);
    // Newest first.
    // No command ran: dashes for the exit code, the run time and the wait.
    expect(lines[2]).toMatch(/=>\s+desktop -> laptop\s+sh\s+df -h\s+refused \(not-listed\)\s+-\s+-\s+-$/);
    // An old-format line (no execMs): the run time is the whole run minus the wait, marked with ~.
    expect(lines[3]).toMatch(/=>\s+desktop -> laptop\s+sh\s+ls -l\s+ran\s+0\s+~20 ms\s+-$/);
    expect(r.out).toMatch(/~ estimated: the whole run minus the wait/);
    // The columns line up: every row has its command at the same offset.
    expect(lines[2]?.indexOf('df -h')).toBe(lines[3]?.indexOf('ls -l'));
  });

  it('lists received commands on the receiver, with the same layout, and both directions together', async () => {
    send(30);
    receive(5, [{ event: 'accepted', id: 'r1', shell: 'sh', command: 'whoami' }, { event: 'completed', id: 'r1', exitCode: 2, timedOut: false, truncated: false, durationMs: 5 }]);
    const r = await cli(b, ['log']);
    expect(r.out).toMatch(/Activity of laptop: 1 entry \(0 sent, 1 received\)/);
    expect(r.out).toMatch(/<=\s+desktop -> laptop\s+sh\s+whoami\s+ran\s+2\s+5 ms\s+-/);
  });

  it('separates the exit code, the run time of the command and the time waited for the owner', async () => {
    send(3, { durationMs: 107_300, waitedSeconds: 107, execMs: 312 });
    send(2, { outcome: { outcome: 'ran', exitCode: 127 }, durationMs: 3_000, execMs: 2_900 });
    send(1, { outcome: { outcome: 'ran', exitCode: null, timedOut: true }, durationMs: 60_500, execMs: 60_000 });
    send(0, { outcome: { outcome: 'ran', exitCode: null }, durationMs: 40, execMs: 10 });
    const rows = (await cli(a, ['log'])).out.split('\n').filter((l) => /^(\d{4}-)?\d\d-\d\d \d\d:\d\d /.test(l));
    expect(rows[0]).toMatch(/ran\s+killed\s+10 ms\s+-$/);
    expect(rows[1]).toMatch(/ran\s+timed out\s+1 min\s+-$/);
    expect(rows[2]).toMatch(/ran\s+127\s+2\.9 s\s+-$/);
    expect(rows[3]).toMatch(/ran\s+0\s+312 ms\s+1 min 47 s$/);
    expect(rows.join('\n')).not.toMatch(/~/);
    expect(rows.every((l) => l.length <= 100)).toBe(true);
  });

  it('shows the exit code and the run time of a received command, and a dash where the audit has no wait', async () => {
    receive(5, [{ event: 'accepted', id: 'r1', shell: 'sh', command: 'false' }, { event: 'completed', id: 'r1', exitCode: 1, timedOut: false, truncated: false, durationMs: 1234 }]);
    const r = await cli(b, ['log']);
    expect(r.out).toMatch(/<=\s+desktop -> laptop\s+sh\s+false\s+ran\s+1\s+1\.2 s\s+-$/m);
  });

  it('keeps every line under 100 characters, ASCII only, cutting a long command with ...', async () => {
    send(1, { command: `echo ${'x'.repeat(500)}`, outcome: { outcome: 'error', cause: 'the connection to the peer failed in an unusually long way'.repeat(3) } });
    send(2, { outcome: { outcome: 'ran', exitCode: 255, timedOut: true } });
    const r = await cli(a, ['log']);
    expect(widest(r.out)).toBeLessThanOrEqual(100);
    // eslint-disable-next-line no-control-regex
    expect(r.out).toMatch(/^[\x0a\x20-\x7e]*$/);
    expect(r.out).toContain('...');
  });

  it('--sent and --received keep one direction; both together are refused with a usage error', async () => {
    send(30);
    receive(5, [{ event: 'accepted', id: 'r1', shell: 'sh', command: 'whoami' }, { event: 'completed', id: 'r1', exitCode: 0, timedOut: false, truncated: false, durationMs: 5 }]);
    // Nothing to filter on A but sent; on B nothing is sent.
    expect((await cli(a, ['log', '--received'])).out).toMatch(/0 entries/);
    expect((await cli(b, ['log', '--sent'])).out).toMatch(/0 entries/);
    expect((await cli(a, ['log', '--sent'])).out).toMatch(/1 entry \(1 sent, 0 received\)/);
    const both = await cli(a, ['log', '--sent', '--received']);
    expect(both.code).toBe(2);
    expect(both.err).toMatch(/--sent and --received contradict/);
  });

  it('filters by machine, outcome, text and time, and says which filters apply', async () => {
    send(300, { command: 'old command' });
    send(10, { command: 'df -h', outcome: { outcome: 'denied', reason: 'denied' } });
    send(5, { command: 'free -m' });
    const byOutcome = await cli(a, ['log', '--outcome', 'denied']);
    expect(byOutcome.out).toMatch(/1 entry/);
    expect(byOutcome.out).toMatch(/filters: outcome=denied/);
    expect((await cli(a, ['log', '--since', '1h'])).out).toMatch(/2 entries/);
    expect((await cli(a, ['log', '--text', 'FREE'])).out).toMatch(/1 entry/);
    expect((await cli(a, ['log', '--machine', 'LAPTOP'])).out).toMatch(/3 entries/);
  });

  it('pages with --limit and --offset and says how to get the next page', async () => {
    for (let i = 1; i <= 5; i++) {
      send(i);
    }
    const first = await cli(a, ['log', '--limit', '2']);
    expect(first.out).toMatch(/5 entries .*showing 1-2/);
    expect(first.out).toMatch(/\[info\] 3 more: --offset 2 shows the next page/);
    const last = await cli(a, ['log', '--limit', '2', '--offset', '4']);
    expect(last.out).toMatch(/showing 5-5/);
    expect(last.out).not.toMatch(/more:/);
  });

  it('--json is one document with the items as the page builds them', async () => {
    send(5);
    const r = await cli(a, ['log', '--json']);
    const doc = JSON.parse(r.out) as { total: number; totalExact: boolean; page: number; pageCount: number; counts: { sent: number }; items: Array<{ direction: string; from: { name: string }; to: { name: string }; command: string; outcome: string; ts: string; durationMs: number; execMs?: number; execDerived?: boolean; waitedSeconds: number; exitCode: number }> };
    expect(doc).toMatchObject({ total: 1, totalExact: true, page: 1, pageCount: 1 });
    expect(doc.items[0]).toMatchObject({ durationMs: 20, execMs: 20, execDerived: true, waitedSeconds: 0, exitCode: 0 });
    expect(doc.items[0]).toMatchObject({ direction: 'sent', from: { name: 'desktop' }, to: { name: 'laptop' }, command: 'ls -l', outcome: 'ran' });
    expect(Date.parse(doc.items[0]?.ts as string)).not.toBeNaN();
  });

  it.each([
    [['--outcome', 'done'], /outcome "done" is not a choice: use ran, refused/],
    [['--since', 'yesterday'], /since "yesterday" is not understood: use a duration/],
    [['--limit', '0'], /limit must be a whole number from 1 to 500/],
    [['--offset', 'x'], /offset must be a whole number/],
  ])('refuses %j with the accepted values and exit 2', async (flags, message) => {
    const r = await cli(a, ['log', ...flags]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(message);
    expect(r.err).toMatch(/usage: machine log/);
  });

  it('warns about a machine name nobody knows instead of showing an empty list silently', async () => {
    send(5);
    const r = await cli(a, ['log', '--machine', 'ghost']);
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/\[warn\] no machine named "ghost" is known here \(known: .*laptop/);
  });

  it('skips a damaged line of the run log with ONE counted warning that names the folder, and shows the rest', async () => {
    send(5);
    mkdirSync(runLogDir(a), { recursive: true });
    writeFileSync(join(runLogDir(a), RUN_LOG_FILE), `garbage\n{"v":1\n`, { flag: 'a' });
    send(1);
    const r = await cli(a, ['log']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/2 entries/);
    expect(r.err.match(/\[warn\]/g)).toHaveLength(1);
    expect(r.err).toMatch(/2 damaged line\(s\) of the run log were skipped.*run-log/);
  });

  it('shows a broken audit chain as a warning and flags the entries after it', async () => {
    receive(9, [{ event: 'accepted', id: 'r1', shell: 'sh', command: 'one' }, { event: 'completed', id: 'r1', exitCode: 0, timedOut: false, truncated: false, durationMs: 1 }]);
    receive(8, [{ event: 'accepted', id: 'r2', shell: 'sh', command: 'two' }, { event: 'completed', id: 'r2', exitCode: 0, timedOut: false, truncated: false, durationMs: 1 }]);
    const file = join(b, 'audit.log');
    const lines = (await import('node:fs')).readFileSync(file, 'utf8').split('\n');
    lines[1] = (lines[1] as string).replace('"exitCode":0', '"exitCode":7');
    writeFileSync(file, lines.join('\n'));
    const r = await cli(b, ['log']);
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/\[warn\] the audit log is broken at line 2/);
    expect(r.err).toMatch(/lines read for this page/);
    expect(r.out).toMatch(/\[UNVERIFIED\]/);
  });

  it('fails with the fix when the machine is not initialized', async () => {
    const r = await cli(join(root, 'nothing'), ['log']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/\[fail\]/);
  });

  it('takes no argument (a typo is refused, not ignored)', async () => {
    const r = await cli(a, ['log', 'desk']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unexpected argument "desk"/);
  });
});
