import { describe, expect, it } from 'vitest';
import { appendAudit, GENESIS_HASH } from './audit.js';
import type { Json } from './canonical.js';
import { ACTIVITY_DEFAULT_LIMIT, ACTIVITY_MAX_LIMIT, buildActivity, parseActivityQuery, type ActivityFilter } from './activity.js';
import type { RunLogEntry } from './runLog.js';

// The Activity timeline: the outgoing run log and the audit log of THIS machine in one list, newest first, filtered and paginated. Pure.

const SELF = { name: 'laptop', uuid: '11111111-1111-4111-8111-111111111111' };
const DESK = { name: 'desk', uuid: '22222222-2222-4222-8222-222222222222' };
const NAS = { name: 'nas', uuid: '33333333-3333-4333-8333-333333333333' };
const T0 = Date.UTC(2026, 10, 21, 12, 0, 0);
const iso = (offsetSeconds: number) => new Date(T0 + offsetSeconds * 1000).toISOString();

function sent(at: number, over: Partial<RunLogEntry> = {}): RunLogEntry {
  return { v: 1, ts: iso(at), runId: `run-${at}`, from: SELF, to: DESK, shell: 'sh', command: 'ls', truncated: false, waitMode: 'default', onRefusal: 'wait', waitSeconds: 600, waitedSeconds: 0, outcome: 'ran', exitCode: 0, durationMs: 100, ...over };
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

const accepted = (at: number, source: string, id: string, command = 'whoami'): Record<string, Json> => ({ ts: iso(at), event: 'accepted', source, id, shell: 'sh', command });
const completed = (at: number, id: string, exitCode: number | null = 0): Record<string, Json> => ({ ts: iso(at), event: 'completed', id, exitCode, timedOut: false, truncated: false, durationMs: 50 });
const refusedEntry = (at: number, source: string, reason = 'not-listed', command = 'rm x'): Record<string, Json> => ({ ts: iso(at), event: 'refused', source, reason, id: `r-${at}`, shell: 'sh', command });

const names: Record<string, string> = { [DESK.uuid]: 'desk', [NAS.uuid]: 'nas' };
const run = (input: { sent?: RunLogEntry[]; audit?: Array<Record<string, Json>> }, filter: ActivityFilter = {}) =>
  buildActivity({ self: SELF, sent: input.sent ?? [], auditLines: auditLog(input.audit ?? []), nameOf: (uuid) => names[uuid], filter });

describe('the merged timeline', () => {
  it('puts sent and received runs in one list, newest first, with from and to on every row', () => {
    const page = run({ sent: [sent(10), sent(30)], audit: [accepted(20, NAS.uuid, 'a1'), completed(21, 'a1', 3)] });
    expect(page.items.map((e) => [e.direction, e.from.name, e.to.name, e.outcome])).toEqual([
      ['sent', 'laptop', 'desk', 'ran'],
      ['received', 'nas', 'laptop', 'ran'],
      ['sent', 'laptop', 'desk', 'ran'],
    ]);
    expect(page.items[1]).toMatchObject({ exitCode: 3, command: 'whoami', shell: 'sh', ts: iso(20), from: { uuid: NAS.uuid } });
    expect(page.counts).toEqual({ sent: 2, received: 1 });
    expect(page.total).toBe(3);
  });

  it('shows what became of a received command: ran, error, unfinished, refused, denied', () => {
    const page = run({
      audit: [
        accepted(1, DESK.uuid, 'ok'), completed(2, 'ok'),
        accepted(3, DESK.uuid, 'cut'),
        { ts: iso(5), event: 'accepted', source: DESK.uuid, id: 'bad', shell: 'sh', command: 'x' }, { ts: iso(6), event: 'failed', id: 'bad', error: 'spawn failed' },
        refusedEntry(7, DESK.uuid),
        refusedEntry(8, DESK.uuid, 'denied'),
      ],
    });
    expect(page.items.map((e) => e.outcome)).toEqual(['denied', 'refused', 'error', 'unfinished', 'ran']);
    expect(page.items.find((e) => e.outcome === 'refused')).toMatchObject({ reason: 'not-listed', command: 'rm x' });
  });

  it('leaves out what is not a command: sessions, documents, holds', () => {
    const page = run({ audit: [{ ts: iso(1), event: 'daemon-started' }, { ts: iso(2), event: 'session-closed', source: DESK.uuid, reason: 'peer-revoked' }, { ts: iso(3), event: 'held', source: DESK.uuid, id: 'h', shell: 'sh', command: 'x', deadline: 99999999999 }] });
    expect(page.items).toEqual([]);
  });

  it('reports a broken audit chain and still lists what is readable, flagged unverified', () => {
    const lines = auditLog([accepted(1, DESK.uuid, 'a'), completed(2, 'a'), accepted(3, DESK.uuid, 'b'), completed(4, 'b')]);
    lines[1] = lines[1]?.replace('"exitCode":0', '"exitCode":9') as string;
    const page = buildActivity({ self: SELF, sent: [], auditLines: lines, nameOf: () => undefined, filter: {} });
    expect(page.chain).toMatchObject({ ok: false, line: 2 });
    expect(page.items.some((e) => !e.verified)).toBe(true);
    expect(page.items.some((e) => e.verified)).toBe(true);
  });

  it('is empty, not an error, when there is nothing yet', () => {
    expect(run({})).toMatchObject({ items: [], total: 0, counts: { sent: 0, received: 0 }, hasMore: false });
  });

  it('lists the other machines it saw, for a filter choice', () => {
    expect(run({ sent: [sent(1, { to: NAS })], audit: [accepted(2, DESK.uuid, 'a')] }).machines).toEqual(['desk', 'nas']);
  });
});

describe('filters', () => {
  const data = () => ({
    sent: [sent(10), sent(20, { to: NAS, outcome: 'refused', reason: 'not-listed', command: 'df -h' }), sent(30, { outcome: 'denied', reason: 'denied', command: 'reboot' })],
    audit: [accepted(15, NAS.uuid, 'a1', 'uname'), completed(16, 'a1'), refusedEntry(25, DESK.uuid)],
  });

  it('by direction', () => {
    expect(run(data(), { direction: 'sent' }).items.every((e) => e.direction === 'sent')).toBe(true);
    expect(run(data(), { direction: 'received' }).total).toBe(2);
  });

  it('by machine: the other side, by name (any case) or by uuid prefix, for both directions', () => {
    expect(run(data(), { machine: 'NAS' }).items.map((e) => e.direction)).toEqual(['sent', 'received']);
    expect(run(data(), { machine: '2222' }).total).toBe(3);
    expect(run(data(), { machine: 'nobody' }).total).toBe(0);
  });

  it('by outcome', () => {
    expect(run(data(), { outcome: 'denied' }).items.map((e) => e.command)).toEqual(['reboot']);
    expect(run(data(), { outcome: 'ran' }).total).toBe(2);
  });

  it('by time range, both ends inclusive, in epoch milliseconds', () => {
    const page = run(data(), { sinceMs: T0 + 15_000, untilMs: T0 + 25_000 });
    expect(page.items.map((e) => e.ts)).toEqual([iso(25), iso(20), iso(15)]);
  });

  it('by text: command, machine, shell or outcome, any case', () => {
    expect(run(data(), { text: 'DF -H' }).total).toBe(1);
    expect(run(data(), { text: 'reboot' }).items[0]?.outcome).toBe('denied');
    expect(run(data(), { text: 'not-listed' }).total).toBe(2);
  });

  it('combines the filters (and), and the counts follow the filters', () => {
    const page = run(data(), { direction: 'sent', machine: 'desk', outcome: 'ran' });
    expect(page.total).toBe(1);
    expect(page.counts).toEqual({ sent: 1, received: 0 });
  });
});

describe('pagination', () => {
  const many = Array.from({ length: 25 }, (_, i) => sent(i));

  it('defaults to a page of 50, newest first', () => {
    expect(ACTIVITY_DEFAULT_LIMIT).toBe(50);
    expect(run({ sent: many }).items).toHaveLength(25);
  });

  it('cuts a page with limit and offset and says whether more follow', () => {
    const first = run({ sent: many }, { limit: 10 });
    expect(first).toMatchObject({ total: 25, offset: 0, limit: 10, hasMore: true, nextOffset: 10 });
    expect(first.items[0]?.ts).toBe(iso(24));
    const last = run({ sent: many }, { limit: 10, offset: 20 });
    expect(last.items).toHaveLength(5);
    expect(last).toMatchObject({ hasMore: false });
    expect(last.nextOffset).toBeUndefined();
  });

  it('an offset past the end is an empty page, not an error', () => {
    expect(run({ sent: many }, { offset: 99 }).items).toEqual([]);
  });

  it('refuses a limit or offset that is not a whole number in range, naming the bound', () => {
    expect(() => run({}, { limit: 0 })).toThrow(/limit.*1.*500/);
    expect(() => run({}, { limit: ACTIVITY_MAX_LIMIT + 1 })).toThrow(/limit/);
    expect(() => run({}, { offset: -1 })).toThrow(/offset/);
    expect(() => run({}, { limit: 1.5 })).toThrow(/limit/);
  });
});

describe('what is shown', () => {
  it('reduces every text to printable ASCII, so an old or edited log cannot drive a terminal or a page', () => {
    const page = run({ sent: [sent(1, { command: 'echo \u001b[31mred\ncaf\u00e9' })] });
    expect(page.items[0]?.command).toBe('echo ?[31mred?caf?');
  });
});

describe('parseActivityQuery (the flags of `machine log` and the query of the Activity page)', () => {
  const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);

  it('reads every field, and treats an empty text as not set (a page sends empty fields)', () => {
    expect(parseActivityQuery({ direction: 'sent', machine: 'desk', outcome: 'refused', since: '2h', text: 'ls', limit: '20', offset: '40' }, NOW)).toEqual({ direction: 'sent', machine: 'desk', outcome: 'refused', sinceMs: NOW - 2 * 3_600_000, text: 'ls', limit: 20, offset: 40 });
    expect(parseActivityQuery({ direction: '', machine: '', outcome: '', since: '', text: '', limit: '', offset: '' }, NOW)).toEqual({});
  });

  it('reads a duration in minutes, hours or days, and a local date or date and time', () => {
    expect(parseActivityQuery({ since: '30m' }, NOW).sinceMs).toBe(NOW - 30 * 60_000);
    expect(parseActivityQuery({ since: '7d' }, NOW).sinceMs).toBe(NOW - 7 * 86_400_000);
    expect(parseActivityQuery({ since: '2026-11-20' }, NOW).sinceMs).toBe(new Date(2026, 10, 20, 0, 0, 0).getTime());
    expect(parseActivityQuery({ since: '2026-11-20 21:30' }, NOW).sinceMs).toBe(new Date(2026, 10, 20, 21, 30, 0).getTime());
  });

  it.each([
    [{ direction: 'out' }, /direction.*sent.*received/s],
    [{ outcome: 'done' }, /outcome.*ran.*refused/s],
    [{ since: 'yesterday' }, /since.*30m.*2026-11-20/s],
    [{ since: '0m' }, /since.*at least 1/],
    [{ since: '2026-13-40' }, /since/],
    [{ limit: '0' }, /limit.*1.*500/s],
    [{ limit: 'ten' }, /limit/],
    [{ offset: '-1' }, /offset/],
    [{ machine: 'x'.repeat(101) }, /machine.*100/],
  ])('refuses %j naming the field and what is accepted', (query, message) => {
    expect(() => parseActivityQuery(query, NOW)).toThrow(message);
  });
});
