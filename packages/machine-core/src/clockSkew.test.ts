import { describe, expect, it } from 'vitest';
import { CLOCK_SKEW_WARN_SECONDS, NOT_YET_VALID_LEEWAY_SECONDS, clockSkewProblem, describeClockSkew, formatDuration, measuredSkew } from './clockSkew.js';

// 2026-11-22T10:29:26Z
const NOW = 1_795_343_366;

describe('clock skew helpers', () => {
  it('names the leeway and the warning threshold', () => {
    expect(NOT_YET_VALID_LEEWAY_SECONDS).toBe(120);
    expect(CLOCK_SKEW_WARN_SECONDS).toBe(30);
  });

  it('measures the skew as peer time minus own time (negative: the peer is behind)', () => {
    expect(measuredSkew(NOW - 196, NOW)).toBe(-196);
    expect(measuredSkew(NOW + 5, NOW)).toBe(5);
  });

  it('formats a duration in one short unit pair', () => {
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(60)).toBe('1 min');
    expect(formatDuration(196)).toBe('3 min 16 s');
    expect(formatDuration(3 * 3600 + 120)).toBe('3 h 2 min');
  });

  it('says which side is behind, with both times and the fix', () => {
    const text = describeClockSkew('thinkcentre', NOW - 196, NOW);
    expect(text).toBe(
      "thinkcentre's clock is 3 min 16 s behind this machine (its time 10:26:10, this machine 10:29:26): fix its time sync (Linux: `timedatectl status`, Windows: `w32tm /query /status`)",
    );
    expect(describeClockSkew('thinkcentre', NOW + 90, NOW)).toContain("thinkcentre's clock is 1 min 30 s ahead of this machine (its time 10:30:56, this machine 10:29:26)");
  });

  it('only reports a skew above the warning threshold', () => {
    expect(clockSkewProblem('x', NOW - CLOCK_SKEW_WARN_SECONDS, NOW)).toBeUndefined();
    expect(clockSkewProblem('x', NOW + CLOCK_SKEW_WARN_SECONDS, NOW)).toBeUndefined();
    expect(clockSkewProblem('x', NOW - CLOCK_SKEW_WARN_SECONDS - 1, NOW)).toContain("x's clock is 31 s behind");
  });

  it('ignores a time that is absent or not a whole number of seconds (an older build, junk)', () => {
    expect(clockSkewProblem('x', undefined, NOW)).toBeUndefined();
    expect(clockSkewProblem('x', Number.NaN, NOW)).toBeUndefined();
    expect(clockSkewProblem('x', -5, NOW)).toBeUndefined();
  });
});
