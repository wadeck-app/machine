import { afterEach, describe, expect, it } from 'vitest';
import { cardFlags, cardStatus, lifetimeMemory, readOnlyDefaultKind, startChoiceOf } from './quickAllow.js';
import type { LifetimeChoice } from './lifetimeChoice.js';

// What the card of a held request decides before the click (one-click Allow): the starting lifetime, what is flagged, the ONE status line.

const once: LifetimeChoice = { kind: 'once', customKind: 'duration', customText: '' };
const custom = (customKind: 'calls' | 'duration', customText: string): LifetimeChoice => ({ kind: 'custom', customKind, customText });

afterEach(() => lifetimeMemory.reset());

describe('startChoiceOf', () => {
  it('is Once when nothing else is known', () => {
    expect(startChoiceOf({})).toMatchObject({ kind: 'once' });
  });
  it('the caller ask wins over the renewal and over the last choice', () => {
    lifetimeMemory.remember({ kind: '1h', customKind: 'duration', customText: '' });
    expect(startChoiceOf({ ask: { times: 3 }, renewal: { maxCalls: 1 } })).toEqual(custom('calls', '3'));
  });
  it('a renewal starts from the limits of the entry, over the last choice', () => {
    lifetimeMemory.remember({ kind: '1d', customKind: 'duration', customText: '' });
    expect(startChoiceOf({ renewal: { maxCalls: 1 } })).toMatchObject({ kind: 'once' });
  });
  it('the last choice of the session is the default of the next card', () => {
    lifetimeMemory.remember({ kind: '1h', customKind: 'duration', customText: '' });
    expect(startChoiceOf({})).toMatchObject({ kind: '1h' });
  });
});

describe('lifetimeMemory', () => {
  it('never remembers a flagged lifetime (permanent, 50 calls or more, more than 7 days): the next card starts safe again', () => {
    for (const c of [{ kind: 'permanent' } as LifetimeChoice, custom('calls', '50'), custom('duration', '8d')]) {
      lifetimeMemory.remember(c);
      expect(lifetimeMemory.get()).toBeUndefined();
    }
  });
  it('never remembers a custom choice that is not a lifetime yet (the field is being typed)', () => {
    lifetimeMemory.remember(custom('calls', ''));
    lifetimeMemory.remember(custom('duration', '5x'));
    expect(lifetimeMemory.get()).toBeUndefined();
  });
  it('keeps an unflagged custom choice', () => {
    lifetimeMemory.remember(custom('calls', '49'));
    expect(lifetimeMemory.get()).toEqual(custom('calls', '49'));
  });
});

describe('cardFlags', () => {
  it('nothing is flagged for a small lifetime', () => {
    expect(cardFlags(once, undefined)).toEqual([]);
    expect(cardFlags(custom('calls', '49'), { times: 49 })).toEqual([]);
    expect(cardFlags(custom('duration', '7d'), { for: '7d' })).toEqual([]);
  });
  it('flags a permanent, large or long CHOICE', () => {
    expect(cardFlags({ kind: 'permanent', customKind: 'duration', customText: '' }, undefined)).toEqual(['permanent (no limit)']);
    expect(cardFlags(custom('calls', '50'), undefined)).toEqual(['a large number of calls (50)']);
    expect(cardFlags(custom('duration', '8d'), undefined)).toEqual(['a long duration (8d)']);
  });
  it('flags the caller ask even when the owner picked something small (second click stays)', () => {
    expect(cardFlags(once, { for: 'permanent' })).toEqual(['the caller asked for permanent (no limit)']);
  });
  it('says each reason once', () => {
    expect(cardFlags({ kind: 'permanent', customKind: 'duration', customText: '' }, { for: 'permanent' })).toEqual(['permanent (no limit)', 'the caller asked for permanent (no limit)']);
  });
});

describe('cardStatus: ONE short line', () => {
  it('is empty when there is nothing to say', () => {
    expect(cardStatus({ shell: 'sh' })).toBe('');
  });
  it('merges the renewal, the caller ask, the notice and the truncation', () => {
    const text = cardStatus({ shell: 'sh', renewal: { note: 'entry used 1 of 1 call(s)' }, ask: { times: 3, why: 'rerun' }, isNotice: true, commandTruncated: true });
    expect(text).toBe('Renewal: entry used 1 of 1 call(s). Caller asked: 3 calls; reason given: rerun. Reported, not verified live. Command truncated.');
  });
});

describe('startChoiceOf: read-only requests (recognised by machine-core classifyReadOnly)', () => {
  const permanent = { kind: 'permanent', customKind: 'duration', customText: '' };
  it('a recognised command starts from Permanent', () => {
    expect(startChoiceOf({ shell: 'sh', command: 'hostname' })).toEqual(permanent);
    expect(startChoiceOf({ shell: 'cmd', command: 'ipconfig /all' })).toEqual(permanent);
  });
  it('a command that is not recognised, or whose shell is another, starts from Once', () => {
    expect(startChoiceOf({ shell: 'sh', command: 'hostname; reboot' })).toMatchObject({ kind: 'once' });
    expect(startChoiceOf({ shell: 'cmd', command: 'ls' })).toMatchObject({ kind: 'once' });
    expect(startChoiceOf({ shell: 'sh', command: 'orch deploy' })).toMatchObject({ kind: 'once' });
  });
  it('the caller ask wins over read-only (3 calls stay 3 calls, once stays once)', () => {
    expect(startChoiceOf({ shell: 'sh', command: 'hostname', ask: { times: 3 } })).toEqual(custom('calls', '3'));
    expect(startChoiceOf({ shell: 'sh', command: 'hostname', ask: { times: 1 } })).toMatchObject({ kind: 'once' });
    expect(startChoiceOf({ shell: 'sh', command: 'hostname', ask: { for: '15m' } })).toMatchObject({ kind: '15m' });
  });
  it('an ask that is only a reason does not hide read-only', () => {
    expect(startChoiceOf({ shell: 'sh', command: 'hostname', ask: { why: 'check' } })).toEqual(permanent);
  });
  it('a renewal keeps the limits the entry had, over read-only', () => {
    expect(startChoiceOf({ shell: 'sh', command: 'hostname', renewal: { maxCalls: 1 } })).toMatchObject({ kind: 'once' });
  });
  it('read-only wins over the last choice of the session; another command still starts from it', () => {
    lifetimeMemory.remember({ kind: '1h', customKind: 'duration', customText: '' });
    expect(startChoiceOf({ shell: 'sh', command: 'hostname' })).toEqual(permanent);
    expect(startChoiceOf({ shell: 'sh', command: 'orch deploy' })).toMatchObject({ kind: '1h' });
  });
  it('a row without a shell and a command (the old callers) is not recognised', () => {
    expect(startChoiceOf({})).toMatchObject({ kind: 'once' });
  });
});

describe('readOnlyDefaultKind (dialog and batch bar)', () => {
  it('is permanent only when EVERY request is recognised, once otherwise, once for none', () => {
    expect(readOnlyDefaultKind([{ shell: 'sh', command: 'hostname' }, { shell: 'sh', command: 'uptime' }])).toBe('permanent');
    expect(readOnlyDefaultKind([{ shell: 'sh', command: 'hostname' }, { shell: 'sh', command: 'orch deploy' }])).toBe('once');
    expect(readOnlyDefaultKind([{ shell: 'sh', command: 'hostname; id' }])).toBe('once');
    expect(readOnlyDefaultKind([])).toBe('once');
  });
});
