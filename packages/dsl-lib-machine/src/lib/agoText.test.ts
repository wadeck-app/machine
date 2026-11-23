import { describe, expect, it } from 'vitest';
import { agoText } from './agoText.js';

// The same words as the module backend (`ago` of requests.ts: under 5 s "now", then s, min, h, days), so a row reads the same before and after it ticks.
describe('agoText', () => {
  it.each([
    [0, 'now'],
    [4, 'now'],
    [5, '5 s ago'],
    [119, '119 s ago'],
    [120, '2 min ago'],
    [7199, '120 min ago'],
    [7200, '2 h ago'],
    [48 * 3600, '2 days ago'],
  ])('%i s is "%s"', (seconds, text) => {
    expect(agoText(seconds)).toBe(text);
  });

  it('never goes negative', () => {
    expect(agoText(-30)).toBe('now');
  });
});
