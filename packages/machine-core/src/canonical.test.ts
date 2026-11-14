import { describe, expect, it } from 'vitest';
import { canonicalize, signingInput } from './canonical.js';

describe('canonicalize', () => {
  it('sorts object keys at every depth and removes whitespace', () => {
    expect(canonicalize({ b: 1, a: { d: [3, 2], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,2]},"b":1}');
  });

  it('gives the same text whatever the insertion order', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });

  it('keeps array order', () => {
    expect(canonicalize([2, 1])).toBe('[2,1]');
  });

  it('rejects numbers that are not safe integers, naming the path', () => {
    expect(() => canonicalize({ a: { b: 1.5 } })).toThrow(/a\.b.*safe integer/);
    expect(() => canonicalize({ a: Number.NaN })).toThrow(/safe integer/);
    expect(() => canonicalize({ a: 2 ** 60 })).toThrow(/safe integer/);
  });

  it('rejects undefined and functions instead of dropping them silently', () => {
    expect(() => canonicalize({ a: undefined } as never)).toThrow(/a.*undefined/);
    expect(() => canonicalize({ a: () => 1 } as never)).toThrow(/a.*function/);
  });

  it('rejects an object with a __proto__ key', () => {
    const evil = JSON.parse('{"__proto__": {"x": 1}}');
    expect(() => canonicalize(evil)).toThrow(/__proto__/);
  });
});

describe('signingInput', () => {
  it('separates domains: same document, different domain, different bytes', () => {
    const a = signingInput('machine/registration/v1', { a: 1 });
    const b = signingInput('machine/policy/v1', { a: 1 });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('puts a zero byte between the domain and the document', () => {
    const bytes = Buffer.from(signingInput('d', { a: 1 }));
    expect(bytes.toString('latin1')).toBe('d\u0000{"a":1}');
  });

  it('refuses an empty domain or a domain with a zero byte', () => {
    expect(() => signingInput('', {})).toThrow(/domain/);
    expect(() => signingInput('a\u0000b', {})).toThrow(/domain/);
  });
});

describe('canonicalize refuses non-JSON objects (review finding)', () => {
  it('refuses Date, Map, Set and class instances instead of signing them as {}', () => {
    expect(() => canonicalize({ when: new Date() } as never)).toThrow(/when.*not a plain/);
    expect(() => canonicalize({ m: new Map() } as never)).toThrow(/m.*not a plain/);
    expect(() => canonicalize({ s: new Set() } as never)).toThrow(/s.*not a plain/);
    class Foo {
      a = 1;
    }
    expect(() => canonicalize({ f: new Foo() } as never)).toThrow(/f.*not a plain/);
  });

  it('accepts an object without a prototype', () => {
    const bare = Object.assign(Object.create(null) as object, { a: 1 });
    expect(canonicalize(bare as never)).toBe('{"a":1}');
  });
});
