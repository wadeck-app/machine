import { describe, expect, it } from 'vitest';
import { MAX_PING_COUNT, parsePingCount, summarizeSamples } from './ping.js';

describe('summarizeSamples', () => {
  it('gives count, min, average and max, rounded to a tenth of a millisecond', () => {
    expect(summarizeSamples([40, 42.25, 41])).toEqual({ count: 3, min: 40, avg: 41.1, max: 42.3 });
  });

  it('is exact for one sample', () => {
    expect(summarizeSamples([12.5])).toEqual({ count: 1, min: 12.5, avg: 12.5, max: 12.5 });
  });

  it('refuses an empty list: there is nothing to summarize and a made-up zero would read as a very fast peer', () => {
    expect(() => summarizeSamples([])).toThrow(/no sample/);
  });

  it('refuses a sample that is not a finite non-negative number', () => {
    expect(() => summarizeSamples([1, Number.NaN])).toThrow(/sample/);
    expect(() => summarizeSamples([-1])).toThrow(/sample/);
  });
});

describe('parsePingCount', () => {
  it('defaults to 1', () => {
    expect(parsePingCount(undefined)).toEqual({ ok: true, count: 1 });
  });

  it('accepts 1 to the maximum', () => {
    expect(parsePingCount('10')).toEqual({ ok: true, count: 10 });
    expect(MAX_PING_COUNT).toBe(10);
  });

  it.each(['0', '11', '-1', '2.5', 'abc', '', '1e1'])('refuses %j and says the allowed range', (text) => {
    const r = parsePingCount(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/--count must be a whole number from 1 to 10/);
  });
});
