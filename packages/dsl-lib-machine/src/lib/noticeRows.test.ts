import { describe, expect, it } from 'vitest';
import { mergeNotices, noticeNote, type NoticeData } from './noticeRows.js';

const SELF = '22222222-2222-4222-8222-222222222222';
const LAPTOP = '33333333-3333-4333-8333-333333333333';
const THINK = '11111111-1111-4111-8111-111111111111';
const RECEIVED = Math.floor(new Date(2026, 10, 21, 14, 2, 30).getTime() / 1000);

const notice = (over: Partial<NoticeData> = {}): NoticeData => ({
  id: 'aaaa1111-0000-4000-8000-000000000000',
  machine: LAPTOP,
  machineName: 'laptop',
  peerText: 'thinkcentre',
  peer: THINK,
  shell: 'sh',
  command: 'ls -l',
  commandTruncated: false,
  state: 'held',
  secondsLeft: 300,
  receivedAt: RECEIVED,
  ...over,
});

const merge = (notices: NoticeData[], over: Partial<Parameters<typeof mergeNotices>[0]> = {}) => mergeNotices({ notices, selfUuid: SELF, loadedMachines: new Set(), filter: 'all', allowAvailable: true, ...over });

describe('noticeNote', () => {
  it('names the machine that reported, the time, and how to confirm', () => {
    expect(noticeNote('laptop', RECEIVED)).toBe('reported by laptop at 14:02; not verified live: use Load the other machines to confirm');
  });
});

describe('mergeNotices', () => {
  it('a held notice becomes a held row of the machine that reported it, with Allow for that machine and the Deny hint ON that machine', () => {
    const { held } = merge([notice()]);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      id: 'aaaa1111-0000-4000-8000-000000000000',
      peerText: 'thinkcentre',
      shell: 'sh',
      command: 'ls -l',
      secondsLeft: 300,
      machine: { uuid: LAPTOP, name: 'laptop' },
      canAllow: true,
      note: 'reported by laptop at 14:02; not verified live: use Load the other machines to confirm',
    });
    // The Deny button is offered like for any row; the machine to tell is the one that holds it (decision 85).
    expect(held[0]).not.toHaveProperty('denyText');
  });

  it('a refused notice becomes a row in a section of the machine that reported it', () => {
    const { refused } = merge([notice({ state: 'refused', secondsLeft: null })]);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.machine).toEqual({ uuid: LAPTOP, name: 'laptop' });
    expect(refused[0]?.rows[0]).toMatchObject({ peerText: 'thinkcentre', shell: 'sh', command: 'ls -l', canAllow: true, note: noticeNote('laptop', RECEIVED) });
  });

  it('keeps the command as it is (escaping is the job of the text node), whatever it contains', () => {
    const nasty = '<img src=x onerror=alert(1)>; echo "$(id)"';
    expect(merge([notice({ command: nasty })]).held[0]?.command).toBe(nasty);
  });

  it('a truncated command is marked and Allow is not offered for it (it would sign another command)', () => {
    const { held } = merge([notice({ commandTruncated: true })]);
    expect(held[0]).toMatchObject({ canAllow: false, commandTruncated: true });
    expect(held[0]?.nextCommand).toMatch(/truncated.*Load the other machines/);
    const { refused } = merge([notice({ state: 'refused', secondsLeft: null, commandTruncated: true })]);
    expect(refused[0]?.rows[0]).toMatchObject({ canAllow: false, commandTruncated: true });
  });

  it('where Allow is not available here the row shows the command to run instead', () => {
    const { held } = merge([notice()], { allowAvailable: false });
    expect(held[0]?.canAllow).toBe(false);
    expect(held[0]?.nextCommand).toBe('machine admin allow laptop --shell sh -- "ls -l"');
  });

  it('the live rows win: every notice of a machine that was loaded is dropped (same request id, or a request that is no longer there)', () => {
    const { held, refused } = merge([notice(), notice({ id: 'bbbb2222-0000-4000-8000-000000000000', state: 'refused', secondsLeft: null }), notice({ machine: THINK, machineName: 'thinkcentre', id: 'cccc3333-0000-4000-8000-000000000000' })], { loadedMachines: new Set([LAPTOP]) });
    expect(refused).toEqual([]);
    expect(held.map((h) => h.id)).toEqual(['cccc3333-0000-4000-8000-000000000000']);
  });

  it('a notice about this machine itself is not shown (its own rows are live)', () => {
    expect(merge([notice({ machine: SELF, machineName: 'midgard2' })])).toEqual({ held: [], refused: [] });
  });

  it('the machine filter keeps only the notices of that machine', () => {
    const list = [notice(), notice({ machine: THINK, machineName: 'thinkcentre', id: 'cccc3333-0000-4000-8000-000000000000' })];
    expect(merge(list, { filter: THINK }).held.map((h) => h.machine?.name)).toEqual(['thinkcentre']);
    expect(merge(list, { filter: SELF })).toEqual({ held: [], refused: [] });
    expect(merge(list).held).toHaveLength(2);
  });

  it('a request id reported twice by the same machine appears once (the first, newest)', () => {
    const { held } = merge([notice({ receivedAt: RECEIVED + 5 }), notice({ receivedAt: RECEIVED })]);
    expect(held).toHaveLength(1);
    expect(held[0]?.note).toContain('14:02');
  });

  it('the label is the machine that REPORTED, never a name found in the notice', () => {
    const { held } = merge([notice({ peerText: 'laptop-fake', machineName: 'laptop' })]);
    expect(held[0]?.machine?.name).toBe('laptop');
    expect(held[0]?.note).toContain('reported by laptop');
    expect(held[0]?.note).not.toContain('laptop-fake');
  });

  it('groups the refused rows by machine, in order of arrival', () => {
    const { refused } = merge([
      notice({ state: 'refused', secondsLeft: null, id: 'a0000000-0000-4000-8000-000000000001' }),
      notice({ state: 'refused', secondsLeft: null, machine: THINK, machineName: 'thinkcentre', id: 'a0000000-0000-4000-8000-000000000002' }),
      notice({ state: 'refused', secondsLeft: null, id: 'a0000000-0000-4000-8000-000000000003', command: 'df' }),
    ]);
    expect(refused.map((s) => [s.machine.name, s.rows.length])).toEqual([
      ['laptop', 2],
      ['thinkcentre', 1],
    ]);
  });
});

describe('mergeNotices: a notice that waits for a renewal', () => {
  const renewal = { reason: 'exhausted' as const, entry: 'orch stop', typed: false, own: false, maxCalls: 1, used: 1, note: 'entry used 1 of 1 call(s)' };

  it('the held row carries the renewal and its exact command replaces the entry (--renew, the entry text, the old limit)', () => {
    const { held } = merge([notice({ command: 'orch stop', renewal })]);
    expect(held[0]?.renewal).toEqual(renewal);
    expect(held[0]?.nextCommand).toBe('machine admin allow laptop --renew --shell sh --times 1 -- "orch stop"');
  });

  it('a typed entry is renewed by its template', () => {
    const typed = { ...renewal, entry: 'orch logs <j:name>', typed: true, maxCalls: 3, used: 3, note: 'entry used 3 of 3 call(s)' };
    const { held } = merge([notice({ command: 'orch logs abc', renewal: typed })]);
    expect(held[0]?.nextCommand).toBe('machine admin allow laptop --renew --shell sh --times 3 -- "orch logs <j:name>"');
  });

  it('a notice without a renewal has none', () => {
    expect(merge([notice()]).held[0]).not.toHaveProperty('renewal');
  });
});

describe('mergeNotices: a notice that carries what the caller asked for (decision 96)', () => {
  it('the held row carries the ask and its exact command suggests --times n / --for d (nothing for permanent); the owner edits it', () => {
    const at = (ask: NonNullable<NoticeData['ask']>) => merge([notice({ command: 'orch deploy', ask })]).held[0];
    expect(at({ times: 3, why: 'rerun' })?.ask).toEqual({ times: 3, why: 'rerun' });
    expect(at({ times: 3 })?.nextCommand).toBe('machine admin allow laptop --shell sh --times 3 -- "orch deploy"');
    expect(at({ for: '30m' })?.nextCommand).toBe('machine admin allow laptop --shell sh --for 30m -- "orch deploy"');
    expect(at({ for: 'permanent' })?.nextCommand).toBe('machine admin allow laptop --shell sh -- "orch deploy"');
  });

  it('a notice without an ask has no ask key', () => {
    expect(merge([notice({ command: 'ls' })]).held[0]).not.toHaveProperty('ask');
  });
});
