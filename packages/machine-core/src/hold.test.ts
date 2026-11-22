import { describe, expect, it } from 'vitest';
import { DEFAULT_HELD_PER_MACHINE, DEFAULT_HELD_PER_PEER, DEFAULT_TARGET_WAIT_CAP_SECONDS, HoldTable, holdAnswerTimeoutMs, progressPrinter, progressText, MAX_WAIT_SECONDS, MIN_WAIT_SECONDS, capWait, checkDenyReason, deniedMessage, NO_DENY_REASON_MESSAGE, describeSeconds, parseWait, waitedText } from './hold.js';

const PEER_A = '11111111-1111-4111-8111-111111111111';
const PEER_B = '22222222-2222-4222-8222-222222222222';
const T0 = 1_800_000_000;

const admit = (table: HoldTable, id: string, peer = PEER_A, over: { requestedSeconds?: number; capSeconds?: number; now?: number } = {}) =>
  table.admit({ id, peer, shell: 'sh', command: 'ls', now: over.now ?? T0, requestedSeconds: over.requestedSeconds ?? 600, capSeconds: over.capSeconds ?? DEFAULT_TARGET_WAIT_CAP_SECONDS });

describe('parseWait', () => {
  it('reads seconds, minutes and hours', () => {
    expect(parseWait('10s')).toBe(10);
    expect(parseWait('10m')).toBe(600);
    expect(parseWait('1h')).toBe(3600);
    expect(parseWait('90s')).toBe(90);
  });

  it('refuses a value below 10 s or above 60 min and names the limits', () => {
    expect(() => parseWait('9s')).toThrow(/10 s to 60 min/);
    expect(() => parseWait('61m')).toThrow(/10 s to 60 min/);
    expect(() => parseWait('2h')).toThrow(/10 s to 60 min/);
    expect(MIN_WAIT_SECONDS).toBe(10);
    expect(MAX_WAIT_SECONDS).toBe(3600);
  });

  it('refuses text that is not a duration, with an example', () => {
    expect(() => parseWait('soon')).toThrow(/10m/);
    expect(() => parseWait('')).toThrow(/10m/);
    expect(() => parseWait('10')).toThrow(/unit/);
    expect(() => parseWait('-5m')).toThrow(/10m/);
    expect(() => parseWait('1.5m')).toThrow(/10m/);
  });
});

describe('capWait', () => {
  it('keeps a wait within the cap of the target', () => {
    expect(capWait(600, 1800)).toEqual({ seconds: 600, capped: false });
  });

  it('caps a wait above the cap and says so', () => {
    expect(capWait(3600, 1800)).toEqual({ seconds: 1800, capped: true });
  });

  it('the default cap of the target is 30 minutes', () => {
    expect(DEFAULT_TARGET_WAIT_CAP_SECONDS).toBe(1800);
  });
});

describe('describeSeconds / waitedText', () => {
  it('prints the biggest exact unit', () => {
    expect(describeSeconds(600)).toBe('10m');
    expect(describeSeconds(3600)).toBe('1h');
    expect(describeSeconds(90)).toBe('90s');
    expect(describeSeconds(45)).toBe('45s');
  });

  it('names the wait that expired', () => {
    expect(waitedText(600, false)).toBe('waited 10m, nobody answered');
    expect(waitedText(1800, true)).toContain('capped');
    expect(waitedText(1800, true)).toContain('30m');
  });
});

describe('checkDenyReason', () => {
  it('accepts printable ASCII and trims', () => {
    expect(checkDenyReason('  not now  ')).toEqual({ ok: true, reason: 'not now' });
  });

  it('treats absent or blank as no reason', () => {
    expect(checkDenyReason(undefined)).toEqual({ ok: true, reason: undefined });
    expect(checkDenyReason('   ')).toEqual({ ok: true, reason: undefined });
  });

  it('refuses control characters, non-ASCII and over 200 characters, naming the fix', () => {
    expect(checkDenyReason('a\nb')).toMatchObject({ ok: false });
    expect(checkDenyReason('café')).toMatchObject({ ok: false });
    const long = checkDenyReason('x'.repeat(201));
    expect(long).toMatchObject({ ok: false });
    expect((long as { message: string }).message).toMatch(/200/);
  });
});

describe('deniedMessage', () => {
  it('is the owner text itself when there is one, a fixed sentence when there is none (the caller prints "refused by <machine>: denied: <message>")', () => {
    expect(deniedMessage('not today')).toBe('not today');
    expect(deniedMessage(undefined)).toBe(NO_DENY_REASON_MESSAGE);
    expect(NO_DENY_REASON_MESSAGE).toBe('denied by the owner, no reason given');
  });
});

describe('HoldTable.admit', () => {
  it('admits a hold with its deadline', () => {
    const table = new HoldTable();
    const r = admit(table, 'a');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.hold).toMatchObject({ id: 'a', peer: PEER_A, shell: 'sh', command: 'ls', since: T0, deadline: T0 + 600, waitSeconds: 600, capped: false });
    }
    expect(table.list()).toHaveLength(1);
  });

  it('caps the wait to the target maximum and records that it did', () => {
    const table = new HoldTable();
    const r = admit(table, 'a', PEER_A, { requestedSeconds: 3600, capSeconds: 1800 });
    expect(r.ok && r.hold).toMatchObject({ waitSeconds: 1800, requestedSeconds: 3600, capped: true, deadline: T0 + 1800 });
  });

  it('refuses a sixth hold of the same peer, naming the limit, the way to change it and the holds that fill it', () => {
    const table = new HoldTable();
    for (const id of ['aaaaaa1', 'bbbbbb2', 'cccccc3', 'dddddd4', 'eeeeee5']) expect(admit(table, id).ok).toBe(true);
    const r = admit(table, 'ffffff6');
    expect(r).toMatchObject({ ok: false, reason: 'hold-limit-peer' });
    const message = (r as { message: string }).message;
    expect(message).toContain('holds 5 requests of yours');
    expect(message).toContain('machine hold-limits --per-peer <n>');
    expect(message).toContain('aaaaaa ls');
    expect(message).toContain('eeeeee ls');
    expect(message).toContain('machine requests --deny <id>');
  });

  it('lists only the holds of the caller, with a shortened command', () => {
    const table = new HoldTable({ perPeer: 1 });
    table.admit({ id: 'mine-0001', peer: PEER_A, shell: 'sh', command: `echo ${'x'.repeat(100)}`, now: T0, requestedSeconds: 600, capSeconds: 1800 });
    admit(table, 'other-0002', PEER_B);
    const message = (admit(table, 'again-0003') as { message: string }).message;
    expect(message).toContain('mine-0');
    expect(message).toContain('...');
    expect(message).not.toContain('other-');
    expect(message).not.toContain('x'.repeat(100));
  });

  it('refuses an eleventh hold of the machine, naming the setting', () => {
    const table = new HoldTable();
    const peers = Array.from({ length: 5 }, (_, i) => `${i}${i}${i}${i}${i}${i}${i}${i}-0000-4000-8000-000000000000`);
    let n = 0;
    for (const p of peers) for (let k = 0; k < 2; k++) expect(admit(table, `id${n++}`, p).ok).toBe(true);
    const r = admit(table, 'last', 'ffffffff-0000-4000-8000-000000000000');
    expect(r).toMatchObject({ ok: false, reason: 'hold-limit-machine' });
    expect((r as { message: string }).message).toContain('machine hold-limits --per-machine <n>');
  });

  it('the default limits are 5 per peer and 10 per machine', () => {
    expect(DEFAULT_HELD_PER_PEER).toBe(5);
    expect(DEFAULT_HELD_PER_MACHINE).toBe(10);
  });

  it('reads the limits at each admission when they are given as a function', () => {
    let limits = { perPeer: 1, perMachine: 10 };
    const table = new HoldTable(() => limits);
    expect(admit(table, 'a').ok).toBe(true);
    expect(admit(table, 'b')).toMatchObject({ ok: false, reason: 'hold-limit-peer' });
    limits = { perPeer: 2, perMachine: 10 };
    expect(admit(table, 'b').ok).toBe(true);
  });

  it('a slot is free again once a hold ends', () => {
    const table = new HoldTable({ perPeer: 2 });
    admit(table, 'a');
    admit(table, 'b');
    expect(admit(table, 'c').ok).toBe(false);
    table.end('a');
    expect(admit(table, 'c').ok).toBe(true);
  });
});

describe('HoldTable.check and deny', () => {
  it('a hold is waiting until its deadline, then expired', () => {
    const table = new HoldTable();
    admit(table, 'a');
    expect(table.check('a', T0 + 599)).toEqual({ state: 'waiting' });
    expect(table.check('a', T0 + 600)).toEqual({ state: 'deadline' });
  });

  it('a deny answers at once and carries the reason', () => {
    const table = new HoldTable();
    admit(table, 'a');
    expect(table.deny('a', 'not now')).toMatchObject({ ok: true });
    expect(table.check('a', T0 + 1)).toEqual({ state: 'denied', reason: 'not now' });
  });

  it('a deny without a reason carries none', () => {
    const table = new HoldTable();
    admit(table, 'a');
    table.deny('a', undefined);
    expect(table.check('a', T0 + 1)).toEqual({ state: 'denied' });
  });

  it('a deny takes a unique prefix of at least 6 characters', () => {
    const table = new HoldTable();
    admit(table, 'abcdef-1111');
    admit(table, 'abcdef-2222');
    expect(table.deny('abcdef', undefined)).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect(table.deny('abcdef-1', undefined)).toMatchObject({ ok: true });
    expect(table.deny('abc', undefined)).toMatchObject({ ok: false, reason: 'too-short' });
  });

  it('a deny of an unknown id names what to do', () => {
    const table = new HoldTable();
    const r = table.deny('nothing-here', undefined);
    expect(r).toMatchObject({ ok: false, reason: 'unknown' });
    expect((r as { message: string }).message).toMatch(/machine requests/);
  });

  it('a deny of an invalid reason is refused', () => {
    const table = new HoldTable();
    admit(table, 'a');
    expect(table.deny('a', 'bad\nreason')).toMatchObject({ ok: false, reason: 'bad-reason' });
    expect(table.check('a', T0 + 1)).toEqual({ state: 'waiting' });
  });

  it('an ended hold cannot be checked or denied', () => {
    const table = new HoldTable();
    admit(table, 'a');
    table.end('a');
    expect(table.check('a', T0)).toEqual({ state: 'gone' });
    expect(table.deny('a', undefined)).toMatchObject({ ok: false, reason: 'unknown' });
  });

  it('the denied hold is not counted twice (deny keeps the first reason)', () => {
    const table = new HoldTable();
    admit(table, 'a');
    table.deny('a', 'first');
    table.deny('a', 'second');
    expect(table.check('a', T0)).toEqual({ state: 'denied', reason: 'first' });
  });
});

describe('holdAnswerTimeoutMs', () => {
  it('is the wait plus the run timeout plus 30 s', () => {
    expect(holdAnswerTimeoutMs(600, 60_000)).toBe(600_000 + 60_000 + 30_000);
    expect(holdAnswerTimeoutMs(10, 60_000)).toBe(100_000);
  });

  it('without a wait it is the run timeout plus 30 s (unchanged behaviour)', () => {
    expect(holdAnswerTimeoutMs(0, 60_000)).toBe(90_000);
  });
});

describe('progressPrinter (user report: "9 min left" printed twice, the tick is every 30 s but the text only changes every minute)', () => {
  it('never returns the same line twice in a row', () => {
    const next = progressPrinter('thinkcentre');
    const seconds = [570, 540, 510, 480, 450, 420];
    const lines = seconds.map(s => next(s)).filter((l): l is string => l !== undefined);
    expect(lines).toEqual([
      'waiting for thinkcentre to allow it (10 min left)',
      'waiting for thinkcentre to allow it (9 min left)',
      'waiting for thinkcentre to allow it (8 min left)',
      'waiting for thinkcentre to allow it (7 min left)',
    ]);
  });

  it('keeps counting in seconds below one minute, every tick is a new line', () => {
    const next = progressPrinter('x');
    expect([45, 15].map(s => next(s))).toEqual(['waiting for x to allow it (45 s left)', 'waiting for x to allow it (15 s left)']);
  });

  it('two printers do not share state', () => {
    const a = progressPrinter('a');
    const b = progressPrinter('a');
    expect(a(120)).toBeDefined();
    expect(b(120)).toBeDefined();
  });
});

describe('progressText', () => {
  it('says how long is left, in minutes then in seconds', () => {
    expect(progressText('thinkcentre', 7 * 60)).toBe('waiting for thinkcentre to allow it (7 min left)');
    expect(progressText('thinkcentre', 90)).toBe('waiting for thinkcentre to allow it (2 min left)');
    expect(progressText('thinkcentre', 45)).toBe('waiting for thinkcentre to allow it (45 s left)');
    expect(progressText('thinkcentre', 0)).toBe('waiting for thinkcentre to allow it (0 s left)');
  });
});
