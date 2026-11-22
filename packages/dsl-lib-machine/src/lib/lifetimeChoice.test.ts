import { parseLifetime as coreParseLifetime } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { LIFETIME_PRESETS, choiceFromLimits, lifetimeInput, lifetimeWords, type LifetimeChoice } from './lifetimeChoice.js';

// The lifetime choices of the Allow dialog: the same pure parser as the CLI flags --times, --for, --until (machine-core lifetime.ts, copied byte for
// byte into machine-webcrypto), so the entry the page signs is the entry the CLI would produce.

const NOW = 1_800_000_000;
const choice = (over: Partial<LifetimeChoice>): LifetimeChoice => ({ kind: 'once', customKind: 'duration', customText: '', ...over });

describe('lifetimeInput: the choice as the CLI flags', () => {
  it.each([
    ['once', { times: '1' }],
    ['15m', { for: '15m' }],
    ['1h', { for: '1h' }],
    ['1d', { for: '1d' }],
  ] as const)('the preset %s', (kind, flags) => {
    expect(lifetimeInput(choice({ kind }))).toMatchObject({ ok: true, flags });
  });

  it('permanent has no flag', () => {
    expect(lifetimeInput(choice({ kind: 'permanent' }))).toMatchObject({ ok: true, flags: {} });
  });

  it('custom calls and custom duration', () => {
    expect(lifetimeInput(choice({ kind: 'custom', customKind: 'calls', customText: '25' }))).toMatchObject({ ok: true, flags: { times: '25' } });
    expect(lifetimeInput(choice({ kind: 'custom', customKind: 'duration', customText: '90m' }))).toMatchObject({ ok: true, flags: { for: '90m' } });
  });

  it('the presets are listed in the order of the dialog, once first', () => {
    expect(LIFETIME_PRESETS.map((p) => p.label)).toEqual(['Once (1 call)', '15 minutes', '1 hour', '1 day', 'Permanent', 'Custom']);
  });

  it.each([
    ['0 calls', { customKind: 'calls', customText: '0' }, /1 to 10000/],
    ['10001 calls', { customKind: 'calls', customText: '10001' }, /1 to 10000/],
    ['a negative number', { customKind: 'calls', customText: '-3' }, /digits only/],
    ['a fractional number', { customKind: 'calls', customText: '2.5' }, /digits only/],
    ['an empty number', { customKind: 'calls', customText: '' }, /Enter a number of calls/],
    ['a duration without a unit', { customKind: 'duration', customText: '30' }, /s, m, h or d/],
    ['a duration over 365 days', { customKind: 'duration', customText: '400d' }, /at most 365 days/],
    ['a zero duration', { customKind: 'duration', customText: '0m' }, /no leading zero/],
    ['an empty duration', { customKind: 'duration', customText: '  ' }, /Enter a duration/],
  ] as const)('refuses %s with a message that says what to write, nothing to sign', (_name, over, message) => {
    const r = lifetimeInput(choice({ kind: 'custom', ...over }));
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toMatch(message);
    // The wording is about the dialog field, never about a CLI flag.
    expect((r as { message: string }).message).not.toMatch(/--times|--for/);
  });

  it('accepts the bounds: 1 and 10000 calls, 1 s and 365 days', () => {
    for (const [customKind, customText] of [['calls', '1'], ['calls', '10000'], ['duration', '1s'], ['duration', '365d']] as const) {
      expect(lifetimeInput(choice({ kind: 'custom', customKind, customText })).ok).toBe(true);
    }
  });

  it('the resulting limits are exactly what the core parser gives for the same flags', () => {
    for (const c of [choice({ kind: 'once' }), choice({ kind: '15m' }), choice({ kind: '1d' }), choice({ kind: 'custom', customKind: 'calls', customText: '7' }), choice({ kind: 'custom', customKind: 'duration', customText: '3h' })]) {
      const r = lifetimeInput(c);
      if (!r.ok) throw new Error(r.message);
      expect(r.limits(NOW)).toEqual(coreParseLifetime(r.flags, NOW));
    }
    const permanent = lifetimeInput(choice({ kind: 'permanent' }));
    if (!permanent.ok) throw new Error(permanent.message);
    expect(permanent.limits(NOW)).toBeUndefined();
  });
});

describe('lifetimeWords: the sentence of the signing summary', () => {
  // A fixed zone offset is not assumed: the clock part is checked with the same formatter the page uses.
  const clock = (epoch: number) => new Date(epoch * 1000).toTimeString().slice(0, 5);

  it('once', () => {
    expect(lifetimeWords({ maxCalls: 1 }, NOW)).toBe('allowed once');
  });
  it('several calls', () => {
    expect(lifetimeWords({ maxCalls: 25 }, NOW)).toBe('allowed 25 times');
  });
  it('permanent', () => {
    expect(lifetimeWords(undefined, NOW)).toBe('permanent, until you remove it');
  });
  it('a duration under a day: the time of day and the minutes', () => {
    expect(lifetimeWords({ expiresAt: NOW + 15 * 60 }, NOW)).toBe(`until ${clock(NOW + 15 * 60)} (in 15 min)`);
    expect(lifetimeWords({ expiresAt: NOW + 3600 }, NOW)).toBe(`until ${clock(NOW + 3600)} (in 1 h)`);
    expect(lifetimeWords({ expiresAt: NOW + 90 * 60 }, NOW)).toBe(`until ${clock(NOW + 90 * 60)} (in 1 h 30 min)`);
  });
  it('a duration of a day or more: the date too', () => {
    const at = NOW + 2 * 86400;
    const date = new Date(at * 1000);
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    expect(lifetimeWords({ expiresAt: at }, NOW)).toBe(`until ${day} ${clock(at)} (in 2 days)`);
  });
  it('seconds are said as seconds', () => {
    expect(lifetimeWords({ expiresAt: NOW + 30 }, NOW)).toBe(`until ${clock(NOW + 30)} (in 30 s)`);
  });
});

describe('choiceFromLimits: the default of a renewal is the limits the entry had', () => {
  it('one call -> once; n calls -> custom calls n', () => {
    expect(choiceFromLimits({ maxCalls: 1 })).toEqual({ kind: 'once', customKind: 'calls', customText: '' });
    expect(choiceFromLimits({ maxCalls: 7 })).toEqual({ kind: 'custom', customKind: 'calls', customText: '7' });
  });
  it('expired only (the original duration is not stored) -> 1 hour; no limits -> permanent', () => {
    expect(choiceFromLimits({ expiresAt: NOW - 5 })).toEqual({ kind: '1h', customKind: 'duration', customText: '' });
    expect(choiceFromLimits(undefined)).toEqual({ kind: 'permanent', customKind: 'duration', customText: '' });
  });
  it('calls win over a date when both are set (the entry was used up)', () => {
    expect(choiceFromLimits({ maxCalls: 2, expiresAt: NOW + 5 })).toMatchObject({ kind: 'custom', customText: '2' });
  });
  it('the choice it gives resolves to flags the CLI parser accepts', () => {
    for (const limits of [{ maxCalls: 1 }, { maxCalls: 7 }, { expiresAt: NOW - 5 }, undefined]) {
      expect(lifetimeInput(choiceFromLimits(limits)).ok).toBe(true);
    }
  });
});
