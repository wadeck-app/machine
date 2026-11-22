import { describe, expect, it } from 'vitest';
import { MAX_ASK_WHY, askFromFlags, askRisk, askSummary, parseCallerAsk } from './callerAsk.js';
import { MAX_TIMES } from './lifetime.js';

// What the CALLER of `machine run` asks for its request (decision 96): untrusted text and numbers that only PRE-FILL the owner's Allow. The target refuses what is
// out of range at once, with the fix; nothing here is a right.

describe('parseCallerAsk (the target side: strict, bounded, never clamped)', () => {
  it.each([
    [{ times: 3 }, { times: 3 }],
    [{ for: '30m' }, { for: '30m' }],
    [{ for: 'permanent' }, { for: 'permanent' }],
    [{ why: 'deploy of the nightly build' }, { why: 'deploy of the nightly build' }],
    [{ times: 1, why: 'once' }, { times: 1, why: 'once' }],
    [{ times: MAX_TIMES }, { times: MAX_TIMES }],
    [{ for: '365d' }, { for: '365d' }],
  ])('accepts %j', (raw, expected) => {
    expect(parseCallerAsk(raw)).toEqual({ ok: true, ask: expected });
  });

  it.each([
    ['times above the maximum', { times: MAX_TIMES + 1 }, new RegExp(`times.*1 to ${MAX_TIMES}`)],
    ['times zero', { times: 0 }, /times/],
    ['times fractional', { times: 1.5 }, /times/],
    ['times as text', { times: '3' }, /times/],
    ['for above 365 days', { for: '366d' }, /365 days/],
    ['for not a duration', { for: 'tomorrow' }, /for.*permanent|digits then/],
    ['for as a number', { for: 30 }, /for/],
    ['times and for together', { times: 3, for: '1h' }, /only one of times and for/],
    ['why with a line break', { why: 'a\nb' }, /printable ASCII/],
    ['why with an accent', { why: 'café' }, /printable ASCII/],
    ['why over the limit', { why: 'x'.repeat(MAX_ASK_WHY + 1) }, new RegExp(`at most ${MAX_ASK_WHY}`)],
    ['why empty', { why: '' }, /why/],
    ['an unknown key', { times: 1, colour: 'red' }, /colour/],
    ['an empty ask', {}, /nothing/],
    ['not an object', 'hello', /object/],
    ['an array', [1], /object/],
  ])('refuses %s, naming the fix', (_name, raw, message) => {
    const r = parseCallerAsk(raw);
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toMatch(message);
  });
});

describe('askFromFlags (the caller side: --times, --for, --why of `machine run`)', () => {
  it('builds the ask from the flags, the numbers as numbers', () => {
    expect(askFromFlags({ times: '5', why: ' rerun after the fix ' })).toEqual({ ok: true, ask: { times: 5, why: 'rerun after the fix' } });
    expect(askFromFlags({ for: '2h' })).toEqual({ ok: true, ask: { for: '2h' } });
    expect(askFromFlags({ for: 'permanent' })).toEqual({ ok: true, ask: { for: 'permanent' } });
  });

  it('nothing given is no ask', () => {
    expect(askFromFlags({})).toEqual({ ok: true, ask: undefined });
  });

  it.each([
    [{ times: '0' }, /--times/],
    [{ times: '10001' }, /--times/],
    [{ times: 'many' }, /--times/],
    [{ for: '1y' }, /--for/],
    [{ for: '400d' }, /--for/],
    [{ times: '2', for: '1h' }, /only one of --times and --for/],
    [{ times: '2', for: 'permanent' }, /only one of --times and --for/],
    [{ why: 'a\tb' }, /--why/],
    [{ why: 'x'.repeat(201) }, /--why/],
    [{ why: '   ' }, /--why/],
  ])('refuses %j before any connection, naming the flag and the fix', (flags, message) => {
    const r = askFromFlags(flags);
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toMatch(message);
  });
});

describe('askRisk: what the owner must see flagged', () => {
  it('flags permanent and a large number of calls, never a small ask', () => {
    expect(askRisk({ for: 'permanent' })).toMatch(/permanent/);
    expect(askRisk({ times: 100 })).toMatch(/100/);
    expect(askRisk({ times: 5 })).toBeUndefined();
    expect(askRisk({ for: '1h' })).toBeUndefined();
    expect(askRisk({ for: '90d' })).toMatch(/90d/);
    expect(askRisk({ why: 'only text' })).toBeUndefined();
  });
});

describe('askSummary: the words shown to the owner, attributed to the caller', () => {
  it('says what was asked and that the owner decides', () => {
    expect(askSummary({ times: 3, why: 'rerun' })).toBe('3 calls; reason given: rerun');
    expect(askSummary({ times: 1 })).toBe('1 call');
    expect(askSummary({ for: '30m' })).toBe('30m');
    expect(askSummary({ for: 'permanent' })).toBe('permanent');
    expect(askSummary({ why: 'rerun' })).toBe('reason given: rerun');
  });
});
