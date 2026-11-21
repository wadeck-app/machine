import { describe, expect, it } from 'vitest';
import { reachableText, type Reachable } from './reachability.js';

const NOW = 1_800_000_000;

describe('reachableText (decision 86): the words the CLI and the pages use for "can the admin machine reach it directly"', () => {
  it('direct: the time of the handshake and how old the check is', () => {
    const r: Reachable = { state: 'direct', ms: 12, checkedAt: NOW - 8 };
    expect(reachableText(r, NOW)).toBe('direct now (12 ms, checked 8 s ago)');
  });

  it('not direct: last seen, and that only the relay inbox is left', () => {
    const r: Reachable = { state: 'not-direct', checkedAt: NOW - 5, lastSeenAt: NOW - 2 * 3600, cause: 'connect timed out' };
    expect(reachableText(r, NOW)).toBe('not reachable directly (last seen 2 h ago; relay inbox only)');
  });

  it('not direct and never seen: says so instead of inventing a date', () => {
    expect(reachableText({ state: 'not-direct', checkedAt: NOW }, NOW)).toBe('not reachable directly (never seen directly; relay inbox only)');
  });

  it('unknown: not checked yet', () => {
    expect(reachableText({ state: 'unknown' }, NOW)).toBe('unknown');
  });

  it('rounds the ages like the rest of the CLI (seconds, minutes, hours, days)', () => {
    expect(reachableText({ state: 'direct', ms: 3, checkedAt: NOW - 90 }, NOW)).toBe('direct now (3 ms, checked 90 s ago)');
    expect(reachableText({ state: 'direct', ms: 3, checkedAt: NOW - 600 }, NOW)).toBe('direct now (3 ms, checked 10 min ago)');
    expect(reachableText({ state: 'not-direct', checkedAt: NOW, lastSeenAt: NOW - 3 * 86_400 }, NOW)).toBe('not reachable directly (last seen 3 days ago; relay inbox only)');
  });

  it('a check dated in the future (clock moved) is shown as just now, never a negative age', () => {
    expect(reachableText({ state: 'direct', ms: 5, checkedAt: NOW + 50 }, NOW)).toBe('direct now (5 ms, checked 0 s ago)');
  });
});
