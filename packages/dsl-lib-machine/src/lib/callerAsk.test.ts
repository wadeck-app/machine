import { ASK_LARGE_TIMES, askAllowFlags as coreFlags, askRisk as coreRisk, askSummary as coreSummary, type CallerAsk as CoreAsk } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { ASK_LARGE_TIMES as WEB_LARGE_TIMES, askAllowFlags, askRisk, askSummary, choiceFromAsk } from './callerAsk.js';
import { lifetimeInput } from './lifetimeChoice.js';

// The page cannot import machine-core at runtime: this is the browser copy of what the owner is shown about the caller's ask. The table keeps it the same
// words as the terminal (`machine requests`), and the choice it pre-fills is only a starting point for the owner.

const CASES: CoreAsk[] = [
  { times: 1 },
  { times: 3, why: 'rerun after the fix' },
  { times: 49 },
  { times: ASK_LARGE_TIMES },
  { times: 10000 },
  { for: '15m' },
  { for: '1h' },
  { for: '1d' },
  { for: '7d' },
  { for: '8d' },
  { for: '90d' },
  { for: 'permanent', why: 'long job' },
  { why: 'only a reason' },
];

describe('the caller ask shown on the page says what the terminal says', () => {
  it('has the same threshold of a large number of calls', () => {
    expect(WEB_LARGE_TIMES).toBe(ASK_LARGE_TIMES);
  });

  it.each(CASES.map((a) => [JSON.stringify(a), a] as const))('%s: the same summary, risk and allow flags as machine-core', (_name, ask) => {
    expect(askSummary(ask)).toBe(coreSummary(ask));
    expect(askRisk(ask)).toBe(coreRisk(ask));
    expect(askAllowFlags(ask)).toBe(coreFlags(ask));
  });
});

describe('choiceFromAsk: what the lifetime selector starts from (the owner edits it before signing)', () => {
  it.each([
    [{ times: 1 }, { kind: 'once', customKind: 'calls', customText: '' }],
    [{ times: 3 }, { kind: 'custom', customKind: 'calls', customText: '3' }],
    [{ for: '15m' }, { kind: '15m', customKind: 'duration', customText: '' }],
    [{ for: '1h' }, { kind: '1h', customKind: 'duration', customText: '' }],
    [{ for: '1d' }, { kind: '1d', customKind: 'duration', customText: '' }],
    [{ for: '2h' }, { kind: 'custom', customKind: 'duration', customText: '2h' }],
    [{ for: 'permanent' }, { kind: 'permanent', customKind: 'duration', customText: '' }],
  ])('%j', (ask, expected) => {
    expect(choiceFromAsk(ask)).toEqual(expected);
  });

  it('a reason alone leaves the default of the page (undefined)', () => {
    expect(choiceFromAsk({ why: 'just why' })).toBeUndefined();
  });

  it('every pre-filled choice is a valid lifetime of the Allow dialog', () => {
    for (const ask of CASES) {
      const choice = choiceFromAsk(ask);
      if (choice !== undefined) {
        expect(lifetimeInput(choice).ok, JSON.stringify(ask)).toBe(true);
      }
    }
  });
});
