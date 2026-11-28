import { describe, expect, it } from 'vitest';
import { statusHeadlineOf } from './problemHeadline.js';

// "Cannot be approved" alone hides the reason until the row is expanded: the status says WHY in a few words (UX review 4, d). The whole sentences stay in the row expansion.

const EXPIRED = 'this candidacy is expired: the candidate must post a new one (`machine join --resume`)';
const NO_UUID = 'the candidacy carries no uuid (posted by an older `machine join`, or the relay dropped it): reject it, and ask the candidate to run `machine join --resume`';

describe('statusHeadlineOf', () => {
  it('a row with a problem says the reason in a few words', () => {
    expect(statusHeadlineOf({ statusText: `Cannot be approved: ${EXPIRED}`, problems: [EXPIRED] })).toBe('Cannot be approved: expired');
    expect(statusHeadlineOf({ statusText: `Cannot be approved: ${NO_UUID}`, problems: [NO_UUID] })).toBe('Cannot be approved: no uuid');
    expect(statusHeadlineOf({ statusText: 'x', problems: ['the relay sent a verification code that does not match the key and random it sent: the relay is inconsistent or swapped the key; do NOT approve'] })).toBe('Cannot be approved: code mismatch');
  });

  it('several problems: the first one, and how many more', () => {
    expect(statusHeadlineOf({ statusText: 'x', problems: [EXPIRED, NO_UUID] })).toBe('Cannot be approved: expired (+1 more)');
    expect(statusHeadlineOf({ statusText: 'x', problems: [EXPIRED, NO_UUID, 'a third'] })).toBe('Cannot be approved: expired (+2 more)');
  });

  it('an unknown problem is cut at its first separator and bounded, never the whole sentence, never empty', () => {
    const headline = statusHeadlineOf({ statusText: 'x', problems: ['the relay sent an unusable "createdAt" (string, expected an ISO 8601 date or epoch seconds): it may be an incompatible version'] });
    expect(headline.length).toBeLessThanOrEqual(60);
    expect(headline.startsWith('Cannot be approved: ')).toBe(true);
    expect(statusHeadlineOf({ statusText: 'x', problems: ['  '] })).toBe('Cannot be approved: see the details');
  });

  it('a row without a problem keeps the headline of its status text', () => {
    expect(statusHeadlineOf({ statusText: 'Pending', problems: [] })).toBe('Pending');
    expect(statusHeadlineOf({ statusText: 'Approved by the admin (relay status: approved)', problems: [] })).toBe('Approved by the admin');
  });
});
