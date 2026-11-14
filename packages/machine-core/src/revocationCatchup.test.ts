import { describe, expect, it } from 'vitest';
import { parseRevocationHello, shouldSendRevocations } from './revocationCatchup.js';

const D1 = 'a'.repeat(64);
const D2 = 'b'.repeat(64);

describe('parseRevocationHello', () => {
  it('accepts a hello with a digest and a version', () => {
    expect(parseRevocationHello({ type: 'hello', revocationDigest: D1, revocationVersion: 7 })).toEqual({
      ok: true,
      hello: { revocationDigest: D1, revocationVersion: 7, revocationsFollow: false },
    });
  });

  it('keeps the revocationsFollow flag', () => {
    expect(parseRevocationHello({ type: 'hello', revocationDigest: D1, revocationVersion: 0, revocationsFollow: true })).toMatchObject({ ok: true, hello: { revocationsFollow: true } });
  });

  it.each([
    ['not an object', 'x'],
    ['a missing digest', { type: 'hello', revocationVersion: 1 }],
    ['a digest that is not 64 lowercase hex characters', { type: 'hello', revocationDigest: 'zz', revocationVersion: 1 }],
    ['a negative version', { type: 'hello', revocationDigest: D1, revocationVersion: -1 }],
    ['a fractional version', { type: 'hello', revocationDigest: D1, revocationVersion: 1.5 }],
    ['a version that is not a number', { type: 'hello', revocationDigest: D1, revocationVersion: '1' }],
    ['a non boolean follow flag', { type: 'hello', revocationDigest: D1, revocationVersion: 1, revocationsFollow: 'yes' }],
    ['an unknown field', { type: 'hello', revocationDigest: D1, revocationVersion: 1, extra: 1 }],
  ])('refuses %s with a message that names the cause', (_name, value) => {
    const r = parseRevocationHello(value);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/hello/);
  });
});

describe('shouldSendRevocations', () => {
  it('sends nothing when the digests are equal', () => {
    expect(shouldSendRevocations({ digest: D1, hasLists: true }, { digest: D1 })).toBe(false);
  });

  it('sends when the digests differ, whatever the versions (the version only orders and informs)', () => {
    expect(shouldSendRevocations({ digest: D1, hasLists: true }, { digest: D2 })).toBe(true);
  });

  it('cannot send what it does not hold: no signed list, nothing to send', () => {
    expect(shouldSendRevocations({ digest: D1, hasLists: false }, { digest: D2 })).toBe(false);
  });
});
