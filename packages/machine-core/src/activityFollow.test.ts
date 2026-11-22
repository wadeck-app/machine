import { describe, expect, it } from 'vitest';
import { FOLLOW_MAX_LINE, FOLLOW_OVERSIZED, createAuditFollower, createSentFollower, createTailer, type LogObservation, type FollowItem } from './activityFollow.js';
import { appendAudit, GENESIS_HASH } from './audit.js';
import { buildRunLogLine } from './runLog.js';

// The pure part of `machine log --follow` (run-log.md): a tailer that decides what to read from what a poll saw of a file, and followers that
// turn each new line into rows. No I/O here: the reader of the files is machine-cli's.

const enc = new TextEncoder();
const bytes = (text: string): Uint8Array => enc.encode(text);
const hex = (text: string): string => Buffer.from(text).toString('hex').slice(0, 128);
const obs = (content: string, mtimeMs = 1): LogObservation => ({ size: Buffer.byteLength(content), mtimeMs, head: hex(content) });

describe('createTailer', () => {
  it('starts from the end of a file that exists: what is already there is not read', () => {
    const t = createTailer();
    expect(t.plan(obs('old\n'))).toEqual({});
    expect(t.plan(obs('old\nnew\n'))).toEqual({ read: { from: 4, to: 8 } });
    expect(t.push(bytes('new\n'))).toEqual(['new']);
    expect(t.plan(obs('old\nnew\n'))).toEqual({});
  });

  it('starts from a given observation (history shown first), so nothing is missed between the history and the follow', () => {
    const t = createTailer(obs('a\n'));
    expect(t.plan(obs('a\nb\n'))).toEqual({ read: { from: 2, to: 4 } });
  });

  it('reads a file that did not exist at the start from its first byte, without a notice', () => {
    const t = createTailer(null);
    expect(t.plan(undefined)).toEqual({});
    expect(t.plan(obs('first\n'))).toEqual({ read: { from: 0, to: 6 } });
  });

  it('keeps a line without newline until the newline comes, even in the middle of a multi-byte character', () => {
    const t = createTailer(obs(''));
    const whole = bytes('café 1\nnext');
    const cut = 4; // inside the two bytes of the accented letter
    expect(t.plan({ size: cut, mtimeMs: 2, head: Buffer.from(whole.slice(0, cut)).toString('hex') })).toEqual({ read: { from: 0, to: cut } });
    expect(t.push(whole.slice(0, cut))).toEqual([]);
    expect(t.push(whole.slice(cut))).toEqual(['café 1']);
    expect(t.push(bytes(' line\n'))).toEqual(['next line']);
  });

  it('skips empty lines and handles several lines in one read', () => {
    const t = createTailer(obs(''));
    expect(t.push(bytes('a\n\nb\r\nc\n'))).toEqual(['a', 'b', 'c']);
  });

  it('restarts from the first byte when the file is cut (truncation), and says so', () => {
    const t = createTailer(obs('aaaa\nbbbb\n'));
    expect(t.plan(obs('x\n'))).toEqual({ restart: 'truncated', read: { from: 0, to: 2 } });
    expect(t.push(bytes('x\n'))).toEqual(['x']);
  });

  it('forgets a half line of a file that was cut', () => {
    const t = createTailer(obs(''));
    t.push(bytes('half'));
    expect(t.plan({ size: 1, mtimeMs: 3, head: hex('y') })).toMatchObject({ restart: 'truncated' });
    expect(t.push(bytes('y\n'))).toEqual(['y']);
  });

  it('restarts when the file was replaced by another one (rotation), even when the new one is bigger', () => {
    const t = createTailer(obs('old line\n'));
    const fresh = 'a brand new and much longer first line\n';
    expect(t.plan(obs(fresh))).toEqual({ restart: 'replaced', read: { from: 0, to: Buffer.byteLength(fresh) } });
  });

  it('does not take a file that grew for a replaced one (its head was shorter than the fingerprint)', () => {
    const t = createTailer(obs('ab'));
    expect(t.plan(obs('ab\ncd\n'))).toEqual({ read: { from: 2, to: 6 } });
  });

  it('says when the file disappears, and reads the next one from its start', () => {
    const t = createTailer(obs('abc\n'));
    expect(t.plan(undefined)).toEqual({ restart: 'disappeared' });
    expect(t.plan(undefined)).toEqual({});
    expect(t.plan(obs('z\n'))).toEqual({ read: { from: 0, to: 2 } });
  });

  it('reads at most one chunk per plan: a big append is read in several rounds', () => {
    const t = createTailer(obs(''));
    const plan = t.plan({ size: 10_000_000, mtimeMs: 2, head: hex('x') });
    expect(plan.read?.from).toBe(0);
    expect(plan.read!.to).toBeLessThan(10_000_000);
  });

  it('gives an oversized line as a marker instead of keeping it in memory', () => {
    const t = createTailer(obs(''));
    expect(t.push(bytes(`${'x'.repeat(FOLLOW_MAX_LINE + 10)}\nok\n`))).toEqual([FOLLOW_OVERSIZED, 'ok']);
    // the same, the long line arriving in pieces
    expect(t.push(bytes('x'.repeat(FOLLOW_MAX_LINE)))).toEqual([]);
    expect(t.push(bytes('x'.repeat(50)))).toEqual([]);
    expect(t.push(bytes('\nok2\n'))).toEqual([FOLLOW_OVERSIZED, 'ok2']);
  });
});

// ------------------------------------------------------------------------------------------------------------------------ followers

const SELF = { uuid: 'uuid-self-0000', name: 'thinkcentre' };
const PEER = 'uuid-peer-1111';
const names = (uuid: string): string | undefined => (uuid === PEER ? 'desktop' : undefined);
const T0 = Date.parse('2026-11-22T10:00:00.000Z');
const at = (s: number): string => new Date(T0 + s * 1000).toISOString();

/** An audit log writer: each call gives the next line of a valid chain. */
function chain(): (entry: Record<string, string | number | boolean | null>) => string {
  let prev = GENESIS_HASH;
  let seq = 0;
  return (entry) => {
    const { line, hash } = appendAudit({ prevHash: prev, seq, entry });
    prev = hash;
    seq += 1;
    return line;
  };
}

const events = (items: FollowItem[]) => items.filter((i): i is Extract<FollowItem, { kind: 'event' }> => i.kind === 'event').map((i) => i.event);
const warns = (items: FollowItem[]) => items.filter((i): i is Extract<FollowItem, { kind: 'warn' }> => i.kind === 'warn').map((i) => i.message);

describe('createAuditFollower', () => {
  const make = () => createAuditFollower({ self: SELF, nameOf: names, file: '/cfg/audit.log', nowMs: () => T0 });

  it('shows an accepted request at once as running, then the same request with its exit code and run time when it completes', () => {
    const w = chain();
    const f = make();
    const accepted = events(f.feed(w({ ts: at(0), event: 'accepted', source: PEER, id: 'r1', shell: 'sh', command: 'ls -l' })));
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ direction: 'received', outcome: 'running', command: 'ls -l', shell: 'sh', from: { name: 'desktop' }, to: { name: 'thinkcentre' }, verified: true });
    const done = events(f.feed(w({ event: 'completed', id: 'r1', exitCode: 3, timedOut: false, truncated: false, durationMs: 1500 })));
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ outcome: 'ran', exitCode: 3, execMs: 1500, durationMs: 1500, command: 'ls -l', from: { name: 'desktop' } });
  });

  it('shows a failed run as an error with its cause, and keeps the command of the acceptance', () => {
    const w = chain();
    const f = make();
    f.feed(w({ ts: at(0), event: 'accepted', source: PEER, id: 'r2', shell: 'sh', command: 'boom' }));
    const [e] = events(f.feed(w({ event: 'failed', id: 'r2', error: 'spawn ENOENT' })));
    expect(e).toMatchObject({ outcome: 'error', cause: 'spawn ENOENT', command: 'boom' });
  });

  it('shows a completion whose acceptance was not seen (follow started in between) without inventing a command', () => {
    const w = chain();
    const f = make();
    const [e] = events(f.feed(w({ event: 'completed', id: 'zz', exitCode: 0, timedOut: false, truncated: false, durationMs: 10 })));
    expect(e).toMatchObject({ outcome: 'ran', exitCode: 0, command: '' });
  });

  it('shows a refusal with its reason, and a denial as denied', () => {
    const w = chain();
    const f = make();
    expect(events(f.feed(w({ ts: at(1), event: 'refused', source: PEER, reason: 'not-listed', id: 'r3', shell: 'sh', command: 'rm x' })))[0]).toMatchObject({ outcome: 'refused', reason: 'not-listed', command: 'rm x' });
    expect(events(f.feed(w({ ts: at(2), event: 'refused', source: PEER, reason: 'denied', id: 'r4', shell: 'sh', command: 'rm y' })))[0]).toMatchObject({ outcome: 'denied' });
  });

  it('shows holds, sessions, documents and notices as one row each, named by their event and one reason', () => {
    const w = chain();
    const f = make();
    const held = events(f.feed(w({ ts: at(1), event: 'held', source: PEER, id: 'h1', shell: 'sh', command: 'df', deadline: at(600), waitSeconds: 600 })));
    expect(held[0]).toMatchObject({ outcome: 'held', command: 'df', from: { name: 'desktop' } });
    const ended = events(f.feed(w({ ts: at(30), event: 'hold-ended', source: PEER, id: 'h1', shell: 'sh', command: 'df', outcome: 'allowed' })));
    expect(ended[0]).toMatchObject({ outcome: 'hold-ended', detail: 'allowed' });
    expect(events(f.feed(w({ ts: at(31), event: 'session-closed', source: PEER, reason: 'peer-revoked' })))[0]).toMatchObject({ outcome: 'session-closed', detail: 'peer-revoked' });
    expect(events(f.feed(w({ ts: at(32), event: 'document-accepted', kind: 'policy', id: 'd1' })))[0]).toMatchObject({ outcome: 'document-accepted' });
    expect(events(f.feed(w({ ts: at(33), event: 'notice-undelivered', recipient: PEER, recipientName: 'desktop', id: 'n1', kind: 'held', cause: 'unreachable' })))[0]).toMatchObject({ outcome: 'notice-undelivered', detail: 'unreachable' });
    expect(events(f.feed(w({ ts: at(34), event: 'daemon-started' })))[0]).toMatchObject({ outcome: 'daemon-started' });
  });

  it('never carries an environment, an output or a message of the entry into what it shows', () => {
    const w = chain();
    const f = make();
    const items = f.feed(w({ ts: at(1), event: 'session-error', source: PEER, error: 'boom', env: 'SECRET=hunter2', stdout: 'TOPSECRET', message: 'MSGTEXT', passphrase: 'pp' }));
    const text = JSON.stringify(items);
    for (const secret of ['hunter2', 'TOPSECRET', 'MSGTEXT', 'pp"']) {
      expect(text).not.toContain(secret);
    }
  });

  it('stays quiet about a valid chain, and checks only the lines it reads', () => {
    const w = chain();
    w({ ts: at(0), event: 'daemon-started' });
    const second = w({ ts: at(1), event: 'daemon-started' });
    const f = make(); // starts in the middle of a log: the first line read has no known predecessor
    expect(warns(f.feed(second))).toEqual([]);
    expect(warns(f.feed(w({ ts: at(2), event: 'daemon-started' })))).toEqual([]);
  });

  it('warns ONCE when the chain breaks (a line removed) and marks what follows as unverified', () => {
    const w = chain();
    const first = w({ ts: at(0), event: 'daemon-started' });
    w({ ts: at(1), event: 'daemon-started' }); // removed from the file
    const third = w({ ts: at(2), event: 'accepted', source: PEER, id: 'r9', shell: 'sh', command: 'ls' });
    const fourth = w({ ts: at(3), event: 'accepted', source: PEER, id: 'r10', shell: 'sh', command: 'ls' });
    const f = make();
    expect(warns(f.feed(first))).toEqual([]);
    const items = f.feed(third);
    expect(warns(items)).toHaveLength(1);
    expect(warns(items)[0]).toMatch(/audit log is broken at line 3.*does not follow the previous line.*\/cfg\/audit\.log/);
    expect(events(items)[0]?.verified).toBe(false);
    const next = f.feed(fourth);
    expect(warns(next)).toEqual([]);
    expect(events(next)[0]?.verified).toBe(false);
  });

  it('warns when a line was modified (its hash does not match)', () => {
    const w = chain();
    const line = w({ ts: at(0), event: 'accepted', source: PEER, id: 'r1', shell: 'sh', command: 'ls' });
    const edited = line.replace('"ls"', '"rm"');
    const f = make();
    const items = f.feed(edited);
    expect(warns(items)[0]).toMatch(/was modified/);
    expect(events(items)[0]?.verified).toBe(false);
  });

  it('shows a damaged line as a warning, never throws, and goes on with the next line', () => {
    const w = chain();
    const f = make();
    for (const bad of ['{"seq":', 'not json at all', FOLLOW_OVERSIZED, '[]', '{"seq":1}']) {
      const items = f.feed(bad);
      expect(events(items)).toEqual([]);
      expect(warns(items)).toHaveLength(1);
      expect(warns(items)[0]).toMatch(/damaged line of the audit log.*\/cfg\/audit\.log/);
    }
    expect(events(f.feed(w({ ts: at(0), event: 'daemon-started' })))).toHaveLength(1);
  });

  it('takes the entry time from the line, else from the clock', () => {
    const w = chain();
    const f = make();
    expect(events(f.feed(w({ ts: at(5), event: 'daemon-started' })))[0]?.atMs).toBe(T0 + 5000);
    expect(events(f.feed(w({ event: 'session-closed', source: PEER, reason: 'x' })))[0]?.atMs).toBe(T0);
  });

  it('can start after the last known line: the first line read is checked against it', () => {
    const w = chain();
    const known = w({ ts: at(0), event: 'daemon-started' });
    const parsed = JSON.parse(known) as { seq: number; hash: string };
    w({ ts: at(1), event: 'daemon-started' });
    const third = w({ ts: at(2), event: 'daemon-started' });
    const f = createAuditFollower({ self: SELF, nameOf: names, file: '/cfg/audit.log', nowMs: () => T0, last: { seq: parsed.seq, hash: parsed.hash } });
    expect(warns(f.feed(third))).toHaveLength(1);
  });

  it('forgets the chain when the log restarts (cut or replaced) so the new first line is not reported as a break', () => {
    const w = chain();
    const f = make();
    f.feed(w({ ts: at(0), event: 'daemon-started' }));
    f.feed(w({ ts: at(1), event: 'daemon-started' }));
    f.restart();
    const fresh = chain();
    expect(warns(f.feed(fresh({ ts: at(2), event: 'daemon-started' })))).toEqual([]);
  });
});

describe('createSentFollower', () => {
  const line = (over: Record<string, unknown> = {}): string =>
    buildRunLogLine({
      now: T0,
      runId: '00000000-0000-4000-8000-000000000001',
      from: { name: 'thinkcentre', uuid: SELF.uuid },
      to: { name: 'desktop', uuid: PEER },
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

  it('shows a sent run as the row `machine log` shows', () => {
    const f = createSentFollower({ file: '/cfg/run-log/runs.ndjson' });
    const items = f.feed(line());
    expect(events(items)[0]).toMatchObject({ direction: 'sent', outcome: 'ran', exitCode: 0, execMs: 12, command: 'ls -l', to: { name: 'desktop' } });
  });

  it('shows a damaged line as a warning and goes on', () => {
    const f = createSentFollower({ file: '/cfg/run-log/runs.ndjson' });
    const bad = f.feed('{"v":1,');
    expect(warns(bad)[0]).toMatch(/damaged line of the run log.*\/cfg\/run-log\/runs\.ndjson/);
    expect(events(f.feed(line()))).toHaveLength(1);
    expect(warns(f.feed(FOLLOW_OVERSIZED))).toHaveLength(1);
  });
});
