import { describe, expect, it } from 'vitest';
import { DEFAULT_TARGET_WAIT_CAP_SECONDS, HoldTable, holdAnswerTimeoutMs, progressText, MAX_WAIT_SECONDS, MIN_WAIT_SECONDS, capWait, checkDenyReason, describeSeconds, parseWait, waitedText } from './hold.js';

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

  it('refuses a third hold of the same peer, naming the limit and the fix', () => {
    const table = new HoldTable();
    admit(table, 'a');
    admit(table, 'b');
    const r = admit(table, 'c');
    expect(r).toMatchObject({ ok: false, reason: 'hold-limit-peer' });
    expect((r as { message: string }).message).toMatch(/2/);
    expect((r as { message: string }).message).toMatch(/wait|deny|allow/i);
  });

  it('refuses a fifth hold of the machine', () => {
    const table = new HoldTable({ perPeer: 4 });
    for (const id of ['a', 'b', 'c', 'd']) expect(admit(table, id, id === 'a' || id === 'b' ? PEER_A : PEER_B).ok).toBe(true);
    const r = admit(table, 'e', PEER_B);
    expect(r).toMatchObject({ ok: false, reason: 'hold-limit-machine' });
  });

  it('the default limits are 2 per peer and 4 per machine', () => {
    const table = new HoldTable();
    const p3 = '33333333-3333-4333-8333-333333333333';
    const p4 = '44444444-4444-4444-8444-444444444444';
    const p5 = '55555555-5555-4555-8555-555555555555';
    expect(admit(table, '1', PEER_A).ok).toBe(true);
    expect(admit(table, '2', PEER_A).ok).toBe(true);
    expect(admit(table, '3', PEER_B).ok).toBe(true);
    expect(admit(table, '4', p3).ok).toBe(true);
    expect(admit(table, '5', p4)).toMatchObject({ ok: false, reason: 'hold-limit-machine' });
    expect(admit(table, '6', p5)).toMatchObject({ ok: false, reason: 'hold-limit-machine' });
  });

  it('a slot is free again once a hold ends', () => {
    const table = new HoldTable();
    admit(table, 'a');
    admit(table, 'b');
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

describe('progressText', () => {
  it('says how long is left, in minutes then in seconds', () => {
    expect(progressText('thinkcentre', 7 * 60)).toBe('waiting for thinkcentre to allow it (7 min left)');
    expect(progressText('thinkcentre', 90)).toBe('waiting for thinkcentre to allow it (2 min left)');
    expect(progressText('thinkcentre', 45)).toBe('waiting for thinkcentre to allow it (45 s left)');
    expect(progressText('thinkcentre', 0)).toBe('waiting for thinkcentre to allow it (0 s left)');
  });
});
