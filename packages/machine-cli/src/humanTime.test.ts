import { describe, expect, it } from 'vitest';
import { expiryText, whenText } from './humanTime.js';

// Built from LOCAL components so the expectations hold in any time zone.
const local = (y: number, mo: number, d: number, h: number, mi: number, s = 0): number => Math.floor(new Date(y, mo - 1, d, h, mi, s).getTime() / 1000);

describe('whenText (local time with a relative hint)', () => {
  const now = local(2026, 11, 15, 14, 20);

  it('future, same day: "in 12 min (14:32)"', () => {
    expect(whenText(local(2026, 11, 15, 14, 32), now)).toBe('in 12 min (14:32)');
  });

  it('past, same day: "3 min ago (14:17)"', () => {
    expect(whenText(local(2026, 11, 15, 14, 17), now)).toBe('3 min ago (14:17)');
  });

  it('under two minutes is given in seconds', () => {
    expect(whenText(now + 45, now)).toBe('in 45 s (14:20)');
    expect(whenText(now - 100, now)).toBe('100 s ago (14:18)');
  });

  it('within five seconds is "now"', () => {
    expect(whenText(now + 2, now)).toBe('now (14:20)');
    expect(whenText(now - 3, now)).toBe('now (14:19)');
  });

  it('hours and days, with the date when it is not today', () => {
    expect(whenText(local(2026, 11, 15, 18, 20), now)).toBe('in 4 h (18:20)');
    expect(whenText(local(2026, 11, 16, 14, 20), now)).toBe('in 24 h (2026-11-16 14:20)');
    expect(whenText(local(2026, 11, 12, 14, 20), now)).toBe('3 days ago (2026-11-12 14:20)');
  });

  it('expiryText says expires or expired', () => {
    expect(expiryText(local(2026, 11, 15, 14, 32), now)).toBe('expires in 12 min (14:32)');
    expect(expiryText(local(2026, 11, 15, 14, 17), now)).toBe('expired 3 min ago (14:17)');
  });

  it('never prints UTC or an ISO string with a Z', () => {
    expect(whenText(local(2026, 11, 15, 14, 32), now)).not.toMatch(/Z|T\d/);
  });

  it('refuses a value that is not a finite number of seconds', () => {
    expect(() => whenText(Number.NaN, now)).toThrow(/epoch seconds/);
  });
});
