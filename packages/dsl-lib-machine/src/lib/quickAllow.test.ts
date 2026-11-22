import { afterEach, describe, expect, it } from 'vitest';
import { cardFlags, cardStatus, lifetimeMemory, startChoiceOf } from './quickAllow.js';
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
