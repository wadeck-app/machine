import { assertPolicyBody as coreAssert, nextPolicyBody as coreNext, type PolicyBody, type PolicyEntry } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { assertPolicyBody as webAssert } from './documents.js';
import { nextPolicyBody as webNext } from './policyEdit.js';

// The browser reads and edits policies itself (admin-ui.md): a body with an input declaration (version 3, decision 114) must be read, refused and edited exactly as machine-core does,
// with the same words. The browser has no UI for inputs yet; it must not break on a list that holds one.

const NOW = 1_800_000_000;
const TARGET = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const KEY = 'a'.repeat(32);
const INPUT = { format: 'json', maxBytes: 65536, chars: ['letters', 'digits', 'space', 'json'] } as const;
const withInput = (input: unknown = INPUT): PolicyEntry => ({ shell: 'sh', command: 'task remote-call', input } as PolicyEntry);
const body = (defaults: PolicyEntry[], over: Partial<PolicyBody> = {}): PolicyBody => ({ v: 3, target: TARGET, version: 1, baseVersion: 0, adminKeyId: KEY, issuedAt: NOW, notBefore: NOW, notAfter: NOW + 3600, defaults, peers: {}, ...over });
const messageOf = (assert: (v: unknown, o?: { readsUpTo?: number }) => void, value: unknown, options?: { readsUpTo?: number }): string | undefined => {
  try {
    assert(value, options);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
};

describe('assertPolicyBody: the browser says what machine-core says', () => {
  const cases: Array<[string, unknown, { readsUpTo?: number } | undefined]> = [
    ['a valid version 3 body', body([withInput()]), undefined],
    ['input in a version 2 body', body([withInput()], { v: 2 }), undefined],
    ['input in a version 1 body', body([withInput()], { v: 1 }), undefined],
    ['a reader of versions 1 and 2', body([withInput()]), { readsUpTo: 2 }],
    ['version 4', body([], { v: 4 as never }), undefined],
    ['json without the json family', body([withInput({ ...INPUT, chars: ['letters'] })]), undefined],
    ['text with the json family', body([withInput({ format: 'text', maxBytes: 10, chars: ['json'] })]), undefined],
    ['a size above the ceiling', body([withInput({ ...INPUT, maxBytes: 600000 })]), undefined],
    ['chars out of order', body([withInput({ ...INPUT, chars: ['digits', 'letters', 'json'] })]), undefined],
    ['an unknown field', body([withInput({ ...INPUT, extra: 1 })]), undefined],
    ['utf8-text with a narrow family', body([withInput({ format: 'text', maxBytes: 10, chars: ['digits', 'utf8-text'] })]), undefined],
    ['input undefined', body([{ shell: 'sh', command: 'x', input: undefined } as never]), undefined],
  ];
  it.each(cases)('%s', (_name, value, options) => {
    expect(messageOf(webAssert as never, value, options)).toBe(messageOf(coreAssert as never, value, options));
  });
  it('accepts what machine-core accepts, and refuses what it refuses (at least one of each)', () => {
    expect(messageOf(webAssert as never, body([withInput()]))).toBeUndefined();
    expect(messageOf(webAssert as never, body([withInput()], { v: 2 }))).toMatch(/input needs version 3/);
  });
});

describe('nextPolicyBody: the browser builds the same next body', () => {
  const ctx = { target: TARGET, adminKeyId: KEY, now: NOW };
  it('version 3 when an entry declares an input, back to 1 when it is removed, replace on another declaration', () => {
    const first = coreNext(undefined, ctx, { kind: 'allow', entry: withInput() });
    const firstWeb = webNext(undefined, ctx, { kind: 'allow', entry: withInput() });
    expect(firstWeb).toEqual(first);
    if (!first.changed) throw new Error('unreachable');
    expect(first.body.v).toBe(3);
    const wider = withInput({ ...INPUT, maxBytes: 131072 });
    expect(webNext(first.body, ctx, { kind: 'allow', entry: wider })).toEqual(coreNext(first.body, ctx, { kind: 'allow', entry: wider }));
    expect(webNext(first.body, ctx, { kind: 'allow', entry: withInput() })).toEqual({ changed: false, reason: 'already-allowed' });
    const removed = webNext(first.body, ctx, { kind: 'remove', command: 'task remote-call' });
    expect(removed).toEqual(coreNext(first.body, ctx, { kind: 'remove', command: 'task remote-call' }));
    expect(removed.changed && removed.body.v).toBe(1);
  });
});
