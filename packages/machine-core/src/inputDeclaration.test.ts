import { describe, expect, it } from 'vitest';
import { INPUT_CHAR_NAMES, INPUT_DEFAULT_MAX_BYTES, INPUT_MAX_BYTES_CEILING, assertInputDeclaration, describeInput, parseInputChars, parseInputDeclaration, parseInputSize } from './inputDeclaration.js';

// The declaration of an allow entry that accepts a payload on stdin (stdin-input.md, decision 114): format, size, characters as a whitelist union.

describe('parseInputSize', () => {
  it('reads KiB with a k and plain bytes', () => {
    expect(parseInputSize('64k')).toBe(65536);
    expect(parseInputSize('512k')).toBe(524288);
    expect(parseInputSize('1000')).toBe(1000);
  });
  it('refuses zero, above the hard ceiling, and text, with the fix', () => {
    expect(() => parseInputSize('0')).toThrow(/at least 1/);
    expect(() => parseInputSize('513k')).toThrow(/512k|524288/);
    expect(() => parseInputSize('1m')).toThrow(/--stdin-max/);
    expect(() => parseInputSize('')).toThrow(/--stdin-max/);
  });
  it('the defaults of the first release: 64 KiB default, 512 KiB ceiling', () => {
    expect(INPUT_DEFAULT_MAX_BYTES).toBe(64 * 1024);
    expect(INPUT_MAX_BYTES_CEILING).toBe(512 * 1024);
  });
});

describe('parseInputChars', () => {
  it('keeps a canonical order whatever the order typed', () => {
    expect(parseInputChars('space+digits+letters')).toEqual(['letters', 'digits', 'space']);
  });
  it('refuses an empty union, an unknown family and a repeated one, naming the fix', () => {
    expect(() => parseInputChars('')).toThrow(/--stdin-chars/);
    expect(() => parseInputChars('letters+nope')).toThrow(/nope.*letters/s);
    expect(() => parseInputChars('letters+letters')).toThrow(/twice/);
    expect(() => parseInputChars('xml')).toThrow(/xml/);
  });
  it('names every family of the table, the explicit characters and the whole-text family', () => {
    for (const n of ['letters', 'digits', 'space', 'punct', 'slash', 'backslash', 'dquote', 'squote', 'backquote', 'semicolon', 'ampersand', 'pipe', 'dollar', 'lt', 'gt', 'at', 'hash', 'percent', 'star', 'plus', 'equal', 'tilde', 'caret', 'brace-open', 'brace-close', 'bracket-open', 'bracket-close', 'json', 'utf8-text']) {
      expect(INPUT_CHAR_NAMES).toContain(n);
    }
  });
  it('utf8-text stands alone (or with json): a union that looks narrower than it is is refused', () => {
    expect(parseInputChars('utf8-text')).toEqual(['utf8-text']);
    expect(parseInputChars('json+utf8-text')).toEqual(['json', 'utf8-text']);
    expect(() => parseInputChars('utf8-text+digits')).toThrow(/utf8-text/);
  });
});

describe('parseInputDeclaration', () => {
  it('json implies the json family, said by the caller of this function through `added`', () => {
    const d = parseInputDeclaration({ format: 'json', max: '64k', chars: 'letters+digits+space' });
    expect(d.declaration).toEqual({ format: 'json', maxBytes: 65536, chars: ['letters', 'digits', 'space', 'json'] });
    expect(d.added).toEqual(['json']);
  });
  it('text with the json family is refused: it belongs to --stdin json', () => {
    expect(() => parseInputDeclaration({ format: 'text', chars: 'letters+json' })).toThrow(/--stdin json/);
  });
  it('the size defaults to 64 KiB, the characters are mandatory (no implicit set)', () => {
    expect(parseInputDeclaration({ format: 'text', chars: 'letters' }).declaration.maxBytes).toBe(65536);
    expect(() => parseInputDeclaration({ format: 'text' })).toThrow(/--stdin-chars/);
  });
  it('refuses a format that is neither text nor json (xml is not built)', () => {
    expect(() => parseInputDeclaration({ format: 'xml', chars: 'letters' })).toThrow(/text.*json/s);
  });
});

describe('assertInputDeclaration (what a signed policy may hold)', () => {
  const ok = { format: 'text', maxBytes: 100, chars: ['letters', 'digits'] };
  it('accepts a valid declaration', () => {
    expect(() => assertInputDeclaration(ok, 'defaults')).not.toThrow();
  });
  it.each([
    ['unknown key', { ...ok, extra: 1 }, /unknown field "extra"/],
    ['bad format', { ...ok, format: 'xml' }, /format/],
    ['size 0', { ...ok, maxBytes: 0 }, /maxBytes/],
    ['size above the ceiling', { ...ok, maxBytes: INPUT_MAX_BYTES_CEILING + 1 }, /maxBytes/],
    ['fraction', { ...ok, maxBytes: 1.5 }, /maxBytes/],
    ['empty chars', { ...ok, chars: [] }, /chars/],
    ['unknown family', { ...ok, chars: ['nope'] }, /nope/],
    ['not canonical order', { ...ok, chars: ['digits', 'letters'] }, /order/],
    ['duplicate', { ...ok, chars: ['letters', 'letters'] }, /twice|order/],
    ['json format without the json family', { ...ok, format: 'json' }, /json family/],
    ['text format with the json family', { ...ok, chars: ['letters', 'json'] }, /json/],
    ['not an object', 'x', /object/],
  ])('refuses %s', (_name, value, message) => {
    expect(() => assertInputDeclaration(value, 'defaults')).toThrow(message);
  });
});

describe('describeInput (shown next to the command: Allowed, requests, signing summary)', () => {
  it('says format, characters and size', () => {
    expect(describeInput({ format: 'json', maxBytes: 65536, chars: ['letters', 'digits', 'space', 'json'] })).toBe('stdin: json, letters+digits+space+json, up to 64 KiB');
    expect(describeInput({ format: 'text', maxBytes: 1500, chars: ['utf8-text'] })).toBe('stdin: text, utf8-text, up to 1500 bytes');
  });
});
