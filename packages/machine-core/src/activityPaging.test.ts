import { describe, expect, it } from 'vitest';
import { appendAudit, GENESIS_HASH } from './audit.js';
import type { Json } from './canonical.js';
import { ACTIVITY_PAGE_SIZES, buildActivity, classifyAuditLine, formatCount, formatRunTime, type ActivityFilter, type ActivityPhase } from './activity.js';
import type { RunLogEntry } from './runLog.js';

// The Activity timeline read for volume: newest first, lazily, filters before the page, an exact total or a flagged approximation, and the
// run time of the command apart from the time spent waiting for the owner. Pure: the sources are iterables of lines, newest first.

const SELF = { name: 'laptop', uuid: '11111111-1111-4111-8111-111111111111' };
const DESK = { name: 'desk', uuid: '22222222-2222-4222-8222-222222222222' };
const T0 = Date.UTC(2026, 10, 21, 12, 0, 0);
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();

function sent(at: number, over: Partial<RunLogEntry> = {}): RunLogEntry {
  return { v: 1, ts: iso(at), runId: `run-${at}`, from: SELF, to: DESK, shell: 'sh', command: `cmd ${at}`, truncated: false, waitMode: 'default', onRefusal: 'wait', waitSeconds: 600, waitedSeconds: 0, outcome: 'ran', exitCode: 0, durationMs: 100, ...over };
}

function auditLog(entries: Array<Record<string, Json>>): string[] {
  const lines: string[] = [];
  let prev = GENESIS_HASH;
  entries.forEach((entry, seq) => {
    const r = appendAudit({ prevHash: prev, seq, entry });
    lines.push(r.line);
    prev = r.hash;
  });
  return lines;
}

/** Sources that count the lines each phase pulls: a lazy reader pulls few for a page. */
function counting(sentFile: string[], auditFile: string[]) {
  const pulled: Record<ActivityPhase, { sent: number; audit: number }> = { page: { sent: 0, audit: 0 }, count: { sent: 0, audit: 0 } };
  function* newestFirst(lines: string[], phase: ActivityPhase, which: 'sent' | 'audit'): Generator<string> {
    for (let i = lines.length - 1; i >= 0; i--) {
      pulled[phase][which] += 1;
      yield lines[i] as string;
    }
  }
  return {
    pulled,
    sources: {
      sentLines: (phase: ActivityPhase) => newestFirst(sentFile, phase, 'sent'),
      auditLines: (phase: ActivityPhase) => newestFirst(auditFile, phase, 'audit'),
    },
  };
}

const fileOf = (entries: RunLogEntry[]): string[] => entries.map((e) => JSON.stringify(e));
const nameOf = (uuid: string) => (uuid === DESK.uuid ? 'desk' : undefined);
const build = (sources: ReturnType<typeof counting>['sources'], filter: ActivityFilter = {}, extra: { knownRows?: { sent: number; received: number }; maxCountLines?: number } = {}) =>
  buildActivity({ self: SELF, sources: { ...sources, ...(extra.knownRows !== undefined ? { knownRows: () => ({ ...(extra.knownRows as { sent: number; received: number }), damaged: { sent: 0, received: 0 } }) } : {}) }, nameOf, filter, ...(extra.maxCountLines !== undefined ? { maxCountLines: extra.maxCountLines } : {}) });

describe('reading lazily from the newest line', () => {
  const many = Array.from({ length: 1000 }, (_, i) => sent(i));

  it('pulls about one page of lines, not the whole log, when the total is already known', () => {
    const { sources, pulled } = counting(fileOf(many), []);
    const page = build(sources, { limit: 25 }, { knownRows: { sent: 1000, received: 0 } });
    expect(page.items.map((e) => e.command)).toEqual(Array.from({ length: 25 }, (_, i) => `cmd ${999 - i}`));
    expect(page).toMatchObject({ total: 1000, totalExact: true, hasMore: true });
    expect(pulled.page.sent).toBeLessThanOrEqual(30);
    expect(pulled.count).toEqual({ sent: 0, audit: 0 });
  });

  it('counts by reading everything once when a filter makes the known total useless, and says it is exact', () => {
    const { sources, pulled } = counting(fileOf(many), []);
    const page = build(sources, { limit: 25, text: 'cmd 99' });
    // cmd 99, cmd 990 to cmd 999
    expect(page).toMatchObject({ total: 11, totalExact: true });
    expect(pulled.count.sent).toBe(1000);
  });

  it('stops counting when the period ends: lines older than the start are never pulled', () => {
    const { sources, pulled } = counting(fileOf(many), []);
    const page = build(sources, { limit: 25, sinceMs: T0 + 990_000 });
    expect(page.total).toBe(10);
    expect(pulled.count.sent).toBeLessThan(30);
    expect(pulled.page.sent).toBeLessThan(30);
  });

  it('marks the total as a lower bound when counting would pass the budget', () => {
    const { sources } = counting(fileOf(many), []);
    const page = build(sources, { limit: 25, text: 'cmd' }, { maxCountLines: 200 });
    expect(page.totalExact).toBe(false);
    expect(page.total).toBeGreaterThanOrEqual(200);
    expect(page.total).toBeLessThan(1000);
    expect(page.items).toHaveLength(25);
  });

  it('applies every filter before the page: page 2 of the matches, not of the log', () => {
    const entries = Array.from({ length: 60 }, (_, i) => sent(i, i % 3 === 0 ? { outcome: 'refused', reason: 'not-listed', exitCode: undefined } : {}));
    const { sources } = counting(fileOf(entries), []);
    const page2 = build(sources, { outcome: 'refused', limit: 10, offset: 10 });
    expect(page2.total).toBe(20);
    expect(page2.items.map((e) => e.command)).toEqual(Array.from({ length: 10 }, (_, i) => `cmd ${(19 - 10 - i) * 3}`));
    expect(page2.hasMore).toBe(false);
  });

  it('refuses a page beyond the last one, with the last page in the message', () => {
    const { sources } = counting(fileOf(many), []);
    expect(() => build(sources, { limit: 25, offset: 1000, page: 41 })).toThrow(/page 41 is beyond the last page \(40\)/);
  });
});

describe('order', () => {
  it('puts a run that waited a long time before one sent after it that finished first, by the time each was SENT', () => {
    // The run sent at +0 waited 100 s, so it was appended after the one sent at +10 (which ended at +11).
    const slow = sent(0, { durationMs: 100_000, waitedSeconds: 100 });
    const quick = sent(10, { durationMs: 1000 });
    const later = sent(20, { durationMs: 1000 });
    const { sources } = counting(fileOf([quick, slow, later].sort((a, b) => Date.parse(a.ts) + a.durationMs - (Date.parse(b.ts) + b.durationMs))), []);
    expect(build(sources, {}).items.map((e) => e.command)).toEqual(['cmd 20', 'cmd 10', 'cmd 0']);
  });

  it('merges the received entries by their own time, one row per request, a completion folded into its acceptance', () => {
    const audit = auditLog([
      { ts: iso(5), event: 'accepted', source: DESK.uuid, id: 'a1', shell: 'sh', command: 'whoami' },
      { ts: iso(6), event: 'accepted', source: DESK.uuid, id: 'a2', shell: 'sh', command: 'uname' },
      { ts: iso(7), event: 'completed', id: 'a1', exitCode: 3, timedOut: false, truncated: false, durationMs: 1234 },
      { ts: iso(30), event: 'refused', source: DESK.uuid, id: 'r1', reason: 'not-listed', shell: 'sh', command: 'rm x' },
    ]);
    const { sources } = counting(fileOf([sent(2), sent(10), sent(40)]), audit);
    const page = build(sources, {});
    expect(page.items.map((e) => `${e.direction}:${e.command}:${e.outcome}`)).toEqual(['sent:cmd 40:ran', 'received:rm x:refused', 'sent:cmd 10:ran', 'received:uname:unfinished', 'received:whoami:ran', 'sent:cmd 2:ran']);
    expect(page.items.find((e) => e.command === 'whoami')).toMatchObject({ exitCode: 3, execMs: 1234 });
    expect(page.total).toBe(6);
  });

  it('keeps the page boundaries consistent: the pages together are the whole list, no entry twice', () => {
    const entries = Array.from({ length: 53 }, (_, i) => sent(i));
    const audit = auditLog(Array.from({ length: 20 }, (_, i) => ({ ts: iso(i * 2 + 0.5), event: 'refused', source: DESK.uuid, id: `r${i}`, reason: 'not-listed', shell: 'sh', command: `r ${i}` })));
    const all: string[] = [];
    for (let offset = 0; offset < 73; offset += 25) {
      const { sources } = counting(fileOf(entries), audit);
      all.push(...build(sources, { limit: 25, offset }).items.map((e) => e.command));
    }
    expect(all).toHaveLength(73);
    expect(new Set(all).size).toBe(73);
  });
});

describe('the run time and the wait', () => {
  it('uses the run time recorded by the target (execMs) as is, and does not mark it', () => {
    const { sources } = counting(fileOf([sent(0, { durationMs: 107_300, waitedSeconds: 107, execMs: 312 })]), []);
    expect(build(sources).items[0]).toMatchObject({ execMs: 312, durationMs: 107_300, waitedSeconds: 107 });
    expect(build(sources).items[0]?.execDerived).toBeUndefined();
  });

  it('derives total minus waited for an old line without execMs, and says so', () => {
    const { sources } = counting(fileOf([sent(0, { durationMs: 107_300, waitedSeconds: 107 })]), []);
    expect(build(sources).items[0]).toMatchObject({ execMs: 300, execDerived: true });
  });

  it('shows no run time rather than an invented one: a negative difference, or a command that did not run', () => {
    const { sources } = counting(fileOf([sent(0, { durationMs: 106_800, waitedSeconds: 107 }), sent(1, { outcome: 'refused', reason: 'denied', exitCode: undefined, durationMs: 500 })]), []);
    for (const e of build(sources).items) {
      expect(e.execMs).toBeUndefined();
    }
  });

  it('gives a received command its recorded run time, no wait', () => {
    const audit = auditLog([{ ts: iso(5), event: 'accepted', source: DESK.uuid, id: 'a1', shell: 'sh', command: 'x' }, { ts: iso(6), event: 'completed', id: 'a1', exitCode: 0, timedOut: true, truncated: false, durationMs: 60_000 }]);
    const { sources } = counting([], audit);
    const e = build(sources).items[0];
    expect(e).toMatchObject({ execMs: 60_000, timedOut: true });
    expect(e?.waitedSeconds).toBeUndefined();
  });
});

describe('damaged lines', () => {
  it('skips a damaged line of either log, counts it, and still builds the page', () => {
    const audit = auditLog([{ ts: iso(5), event: 'refused', source: DESK.uuid, id: 'r', reason: 'not-listed', shell: 'sh', command: 'x' }]);
    const { sources } = counting([JSON.stringify(sent(1)), '{"v":1,"ts":', JSON.stringify(sent(3)), '\u0000garbage'], [...audit, 'not json']);
    const page = build(sources);
    expect(page.items).toHaveLength(3);
    expect(page.damaged).toEqual({ sent: 2, received: 1 });
  });
});

describe('the audit window', () => {
  it('verifies only the lines it read: a break outside the page window is not looked for', () => {
    const lines = auditLog(Array.from({ length: 200 }, (_, i) => ({ ts: iso(i), event: 'refused', source: DESK.uuid, id: `r${i}`, reason: 'not-listed', shell: 'sh', command: `c${i}` })));
    lines[3] = (lines[3] as string).replace('"c3"', '"c9"');
    const { sources, pulled } = counting([], lines);
    const page = build(sources, { limit: 10 });
    expect(page.chain).toMatchObject({ scope: 'window', ok: true });
    expect(pulled.page.audit).toBeLessThan(40);
  });

  it('flags the rows after a break inside the window', () => {
    const lines = auditLog(Array.from({ length: 6 }, (_, i) => ({ ts: iso(i), event: 'refused', source: DESK.uuid, id: `r${i}`, reason: 'not-listed', shell: 'sh', command: `c${i}` })));
    lines[2] = (lines[2] as string).replace('"c2"', '"c9"');
    const { sources } = counting([], lines);
    const page = build(sources, {});
    expect(page.chain).toMatchObject({ scope: 'window', ok: false, line: 3 });
    expect(page.items.map((e) => e.verified)).toEqual([false, false, false, false, true, true]);
  });
});

describe('classifyAuditLine (what the cache of counts reads)', () => {
  it('tells a row of the timeline from another event and from a damaged line', () => {
    const [accepted, held, refused] = auditLog([
      { ts: iso(1), event: 'accepted', source: DESK.uuid, id: 'a', shell: 'sh', command: 'x' },
      { ts: iso(2), event: 'held', source: DESK.uuid, id: 'h', shell: 'sh', command: 'x', deadline: 5 },
      { ts: iso(3), event: 'refused', source: DESK.uuid, id: 'r', reason: 'denied', shell: 'sh', command: 'x' },
    ]) as [string, string, string];
    expect([accepted, held, refused].map(classifyAuditLine)).toEqual(['row', 'other', 'row']);
    expect(classifyAuditLine('nope')).toBe('damaged');
    expect(classifyAuditLine('{"seq":0}')).toBe('damaged');
  });
});

describe('formatRunTime', () => {
  it.each([
    [0, '0 ms'],
    [312, '312 ms'],
    [999, '999 ms'],
    [1000, '1.0 s'],
    [1234, '1.2 s'],
    [107_300, '1 min 47 s'],
    [59_949, '59.9 s'],
    [59_960, '1 min'],
    [184_000, '3 min 4 s'],
    [180_000, '3 min'],
    [3_600_000, '1 h'],
    [3_960_000, '1 h 6 min'],
  ])('%i ms -> %s', (ms, text) => {
    expect(formatRunTime(ms)).toBe(text);
  });

  it('refuses a number that is not a duration', () => {
    expect(() => formatRunTime(-1)).toThrow(/duration/);
    expect(() => formatRunTime(Number.NaN)).toThrow(/duration/);
  });
});

describe('formatCount', () => {
  it.each([[0, '0'], [999, '999'], [1000, '1,000'], [1234567, '1,234,567']])('%i -> %s', (n, text) => {
    expect(formatCount(n)).toBe(text);
  });
});

describe('page sizes', () => {
  it('are 25, 50 and 100', () => {
    expect([...ACTIVITY_PAGE_SIZES]).toEqual([25, 50, 100]);
  });
});
