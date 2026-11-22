import { describe, expect, it } from 'vitest';
import { describeLimits, limitsEqual, parseLifetime } from './lifetime.js';

const NOW = 1_800_000_000; // 2027-01-15T08:00:00Z

describe('parseLifetime: --times, --for, --until (permanent by default)', () => {
  it('nothing given: permanent, no limits', () => {
    expect(parseLifetime({}, NOW)).toBeUndefined();
  });

  it('--for permanent is the explicit way to say no limits, and still excludes --times and --until', () => {
    expect(parseLifetime({ for: 'permanent' }, NOW)).toBeUndefined();
    expect(() => parseLifetime({ for: 'permanent', times: '3' }, NOW)).toThrow(/only one of/);
    expect(() => parseLifetime({ for: 'Permanent' }, NOW)).toThrow(/--for/);
  });

  it('--times N is maxCalls', () => {
    expect(parseLifetime({ times: '5' }, NOW)).toEqual({ maxCalls: 5 });
    expect(parseLifetime({ times: '1' }, NOW)).toEqual({ maxCalls: 1 });
  });

  it.each(['0', '-1', '1.5', 'x', '', '05', '1e3', '2147483648', ' 5'])('refuses --times %j with the fix', (v) => {
    expect(() => parseLifetime({ times: v }, NOW)).toThrow(/--times.*whole number/);
  });

  it('--for is the signing time plus the duration', () => {
    expect(parseLifetime({ for: '2h' }, NOW)).toEqual({ expiresAt: NOW + 7200 });
    expect(parseLifetime({ for: '90s' }, NOW)).toEqual({ expiresAt: NOW + 90 });
    expect(parseLifetime({ for: '30m' }, NOW)).toEqual({ expiresAt: NOW + 1800 });
    expect(parseLifetime({ for: '7d' }, NOW)).toEqual({ expiresAt: NOW + 7 * 86400 });
  });

  it.each(['0s', '0', '2', '2x', 'h', '-2h', '1.5h', '2H', '2h30m', '', '99999999999d'])('refuses --for %j with the fix', (v) => {
    expect(() => parseLifetime({ for: v }, NOW)).toThrow(/--for.*(like 30m|digits)/);
  });

  it('--until takes a full ISO instant with a zone, or a date (end of that day, UTC)', () => {
    expect(parseLifetime({ until: '2027-02-01T18:00:00Z' }, NOW)).toEqual({ expiresAt: Date.UTC(2027, 1, 1, 18, 0, 0) / 1000 });
    expect(parseLifetime({ until: '2027-02-01T18:00Z' }, NOW)).toEqual({ expiresAt: Date.UTC(2027, 1, 1, 18, 0, 0) / 1000 });
    expect(parseLifetime({ until: '2027-02-01T18:00:00+02:00' }, NOW)).toEqual({ expiresAt: Date.UTC(2027, 1, 1, 16, 0, 0) / 1000 });
    expect(parseLifetime({ until: '2027-02-01' }, NOW)).toEqual({ expiresAt: Date.UTC(2027, 1, 1, 23, 59, 59) / 1000 });
  });

  it.each(['2027-02-01T18:00:00', 'tomorrow', '2027-02-30', '2027-13-01', '2027-02-01T25:00Z', '01/02/2027', '', '2027-2-1'])('refuses --until %j (no zone, not a date, not on the calendar)', (v) => {
    expect(() => parseLifetime({ until: v }, NOW)).toThrow(/--until/);
  });

  it('refuses --until in the past', () => {
    expect(() => parseLifetime({ until: '2027-01-01T00:00Z' }, NOW)).toThrow(/--until.*past/);
  });

  it('refuses two choices at once, naming the three', () => {
    expect(() => parseLifetime({ times: '2', for: '1h' }, NOW)).toThrow(/only one of --times, --for, --until/);
    expect(() => parseLifetime({ for: '1h', until: '2027-02-01' }, NOW)).toThrow(/only one of/);
  });
});

describe('describeLimits and limitsEqual', () => {
  it('describes the lifetime', () => {
    expect(describeLimits(undefined, NOW)).toBe('permanent');
    expect(describeLimits({ maxCalls: 5 }, NOW)).toBe('5 calls');
    expect(describeLimits({ maxCalls: 1 }, NOW)).toBe('1 call');
    expect(describeLimits({ expiresAt: Date.UTC(2027, 1, 1, 18, 0, 0) / 1000 }, NOW)).toBe('until 2027-02-01T18:00:00Z');
    expect(describeLimits({ maxCalls: 5, expiresAt: Date.UTC(2027, 1, 1, 18, 0, 0) / 1000 }, NOW)).toBe('5 calls, until 2027-02-01T18:00:00Z');
  });
  it('says what is left when the usage is known', () => {
    expect(describeLimits({ maxCalls: 5 }, NOW, 2)).toBe('3 of 5 calls left');
    expect(describeLimits({ maxCalls: 5 }, NOW, 5)).toBe('0 of 5 calls left (exhausted)');
    expect(describeLimits({ expiresAt: NOW - 1 }, NOW)).toBe(`expired (was until ${new Date((NOW - 1) * 1000).toISOString().replace('.000Z', 'Z')})`);
  });
  it('compares limits', () => {
    expect(limitsEqual(undefined, undefined)).toBe(true);
    expect(limitsEqual({ maxCalls: 2 }, { maxCalls: 2 })).toBe(true);
    expect(limitsEqual({ maxCalls: 2 }, { maxCalls: 3 })).toBe(false);
    expect(limitsEqual({ maxCalls: 2 }, undefined)).toBe(false);
    expect(limitsEqual({ expiresAt: 5 }, { expiresAt: 5 })).toBe(true);
  });
});

describe('limits of a lifetime, at the boundary', () => {
  it('--times: 10000 accepted, 10001 and 0 and empty refused, naming 10000', () => {
    expect(parseLifetime({ times: '10000' }, NOW)).toEqual({ maxCalls: 10000 });
    expect(() => parseLifetime({ times: '10001' }, NOW)).toThrow(/from 1 to 10000/);
    expect(() => parseLifetime({ times: '0' }, NOW)).toThrow(/from 1 to 10000/);
    expect(() => parseLifetime({ times: '' }, NOW)).toThrow(/from 1 to 10000/);
  });

  it('--for: 365 days accepted, one second more refused, naming 365 days', () => {
    expect(parseLifetime({ for: '365d' }, NOW)).toEqual({ expiresAt: NOW + 31536000 });
    expect(parseLifetime({ for: '31536000s' }, NOW)).toEqual({ expiresAt: NOW + 31536000 });
    expect(parseLifetime({ for: '8760h' }, NOW)).toEqual({ expiresAt: NOW + 31536000 });
    expect(() => parseLifetime({ for: '31536001s' }, NOW)).toThrow(/at most 365 days/);
    expect(() => parseLifetime({ for: '366d' }, NOW)).toThrow(/at most 365 days/);
    expect(() => parseLifetime({ for: '' }, NOW)).toThrow(/--for/);
  });

  it('--until: 365 days from signing accepted, one second more refused, naming 365 days', () => {
    const edge = new Date((NOW + 31536000) * 1000).toISOString();
    expect(parseLifetime({ until: edge }, NOW)).toEqual({ expiresAt: NOW + 31536000 });
    expect(() => parseLifetime({ until: new Date((NOW + 31536001) * 1000).toISOString() }, NOW)).toThrow(/at most 365 days/);
    expect(() => parseLifetime({ until: '' }, NOW)).toThrow(/--until/);
  });
});
