import { describe, expect, it } from 'vitest';
import { splitHeadline } from './statusHeadline.js';

// A table cell that must not wrap (a word is never cut) holds a SHORT headline; what follows it moves to the row expansion.

describe('splitHeadline', () => {
  it('keeps a short text whole', () => {
    expect(splitHeadline('Pending')).toEqual({ headline: 'Pending', detail: '' });
    expect(splitHeadline('Warning: uuid already bound to a token')).toEqual({ headline: 'Warning: uuid already bound to a token', detail: '' });
    expect(splitHeadline('directly reachable')).toEqual({ headline: 'directly reachable', detail: '' });
  });

  it('cuts a long text at its first colon: the headline stays, the rest is the detail', () => {
    const text = 'Cannot be approved: the candidacy carries no uuid (posted by an older `machine join`): reject it';
    expect(splitHeadline(text)).toEqual({ headline: 'Cannot be approved', detail: 'the candidacy carries no uuid (posted by an older `machine join`): reject it' });
    expect(splitHeadline('not reachable now: documents go through the relay inbox')).toEqual({ headline: 'not reachable now', detail: 'documents go through the relay inbox' });
  });

  it('cuts a long text at its first parenthesis when that comes first, without the parentheses in the detail', () => {
    expect(splitHeadline('Approved by the admin (relay status: approved)')).toEqual({ headline: 'Approved by the admin', detail: 'relay status: approved' });
  });

  it('a long text with no place to cut stays whole (nothing is lost)', () => {
    const text = 'a status sentence without any separator that is longer than the limit';
    expect(splitHeadline(text)).toEqual({ headline: text, detail: '' });
  });

  it('the limit is a parameter', () => {
    expect(splitHeadline('abc: def', 3)).toEqual({ headline: 'abc', detail: 'def' });
  });
});
