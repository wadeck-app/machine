import { checkDenyReason, NO_DENY_REASON_MESSAGE } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { NO_REASON_TEXT, REASON_MAX, reasonProblem } from './DenyForm.js';

// The page cannot import machine-core at runtime (node: modules in the bundle), so DenyForm keeps a browser copy of the whitelist of checkDenyReason.
// The copy is only valid while it answers like the original for every kind of text: this table is what keeps them one rule (the same whitelist
// for the CLI, the daemon, the route and the page).

const CASES: Array<[string, string]> = [
  ['empty', ''],
  ['blank', '   '],
  ['plain', 'not today, ask again after the release'],
  ['padded', '  padded  '],
  ['exactly the limit', 'x'.repeat(REASON_MAX)],
  ['one over the limit', 'x'.repeat(REASON_MAX + 1)],
  ['padded to the limit', ` ${'x'.repeat(REASON_MAX)} `],
  ['a line break', 'a\nb'],
  ['a tab', 'a\tb'],
  ['an escape sequence', 'a\u001b[2Jb'],
  ['DEL', 'a\u007fb'],
  ['an accent', 'café'],
  ['an emoji', 'ok \u{1F600}'],
  ['a right-to-left mark', 'a‮b'],
];

describe('the Deny reason whitelist of the page is the one of machine-core', () => {
  it('has the same maximum length', () => {
    expect(REASON_MAX).toBe(200);
  });

  it('says the same sentence when there is no reason as the one the caller is given', () => {
    expect(NO_REASON_TEXT).toBe(NO_DENY_REASON_MESSAGE);
  });

  it.each(CASES)('%s: the same verdict and the same words as checkDenyReason', (_name, text) => {
    const core = checkDenyReason(text);
    expect(reasonProblem(text)).toBe(core.ok ? undefined : core.message);
  });
});
