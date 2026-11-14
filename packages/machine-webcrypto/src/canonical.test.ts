import { canonicalize as coreCanonicalize, signingInput as coreSigningInput, type Json } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { prng, randomJson } from '../test-support/kit.js';
import { decodeBase64urlStrict, encodeBase64url } from './base64url.js';
import { canonicalize, signingInput } from './canonical.js';

const VECTORS: Array<[unknown, string]> = [
  [{ b: 1, a: { d: [3, 2], c: 'x' } }, '{"a":{"c":"x","d":[3,2]},"b":1}'],
  [[2, 1], '[2,1]'],
  [null, 'null'],
  [{ k: 'a"b\\c\n\u0000é€\u{1f600}' }, '{"k":"a\\"b\\\\c\\n\\u0000é€\u{1f600}"}'],
  [{ n: -9007199254740991, z: 0, t: true, f: false }, '{"f":false,"n":-9007199254740991,"t":true,"z":0}'],
  [{ 'é': 1, e: 2, Z: 3, '\u{1f600}': 4 }, '{"Z":3,"e":2,"é":1,"\u{1f600}":4}'],
];

describe('canonicalize: same bytes as machine-core', () => {
  it.each(VECTORS)('fixed vector %#', (value, expected) => {
    expect(canonicalize(value as Json)).toBe(expected);
    expect(coreCanonicalize(value as Json)).toBe(expected);
  });

  it('100 random documents give identical text and identical signing input', () => {
    const rand = prng(42);
    for (let i = 0; i < 100; i++) {
      const value = randomJson(rand) as Json;
      expect(canonicalize(value)).toBe(coreCanonicalize(value));
      expect(Buffer.from(signingInput('machine/test/v1', value)).equals(Buffer.from(coreSigningInput('machine/test/v1', value)))).toBe(true);
    }
  });

  it('refuses what machine-core refuses, with the same message', () => {
    const evil = JSON.parse('{"__proto__": {"x": 1}}');
    const bad: unknown[] = [{ a: { b: 1.5 } }, { a: Number.NaN }, { a: 2 ** 60 }, { a: undefined }, { a: () => 1 }, { a: Symbol('x') }, { a: 10n }, evil, new Date(0), new Map(), { a: [undefined] }];
    for (const value of bad) {
      let core = '';
      try {
        coreCanonicalize(value as Json);
      } catch (e) {
        core = (e as Error).message;
      }
      expect(core, 'machine-core must refuse it too').not.toBe('');
      expect(() => canonicalize(value as Json)).toThrow(core);
    }
  });

  it('refuses an empty domain and a domain with a zero byte', () => {
    expect(() => signingInput('', {})).toThrow(/domain/);
    expect(() => signingInput('a\u0000b', {})).toThrow(/domain/);
  });

  it('puts the domain, one zero byte, then the canonical text', () => {
    expect(new TextDecoder().decode(signingInput('machine/x/v1', { a: 1 }))).toBe('machine/x/v1\u0000{"a":1}');
  });
});

describe('base64url (strict, no Buffer)', () => {
  it('round-trips every length from 0 to 70 and matches Buffer', () => {
    for (let n = 0; n <= 70; n++) {
      const data = new Uint8Array(n).map((_, i) => (i * 37 + n) & 255);
      const text = encodeBase64url(data);
      expect(text).toBe(Buffer.from(data).toString('base64url'));
      expect(Buffer.from(decodeBase64urlStrict(text, n, 'x')).equals(Buffer.from(data))).toBe(true);
    }
  });

  it('refuses padding, wrong alphabet, wrong length, non-canonical trailing bits and non-strings, naming the label', () => {
    const good = encodeBase64url(new Uint8Array(32).fill(7));
    expect(() => decodeBase64urlStrict(`${good}=`, 32, 'the key')).toThrow(/the key/);
    expect(() => decodeBase64urlStrict(good.replace('B', '+'), 32, 'the key')).toThrow(/the key/);
    expect(() => decodeBase64urlStrict(good.slice(1), 32, 'the key')).toThrow(/the key/);
    expect(() => decodeBase64urlStrict(7, 32, 'the key')).toThrow(/the key/);
    // 32 bytes end with two spare bits: the last character must have them at zero.
    const sloppy = `${good.slice(0, -1)}${good.endsWith('B') ? 'C' : 'B'}`;
    expect(() => decodeBase64urlStrict(sloppy, 32, 'the key')).toThrow(/canonical|the key/);
    expect(() => decodeBase64urlStrict('A', 1, 'the key')).toThrow(/the key/);
  });
});
