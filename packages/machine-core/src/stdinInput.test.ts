import { describe, expect, it } from 'vitest';
import type { InputDeclaration } from './inputDeclaration.js';
import { INPUT_MAX_JSON_DEPTH, checkInputPayload, displayInput, inputDigest, suggestInput } from './stdinInput.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (chars: string[], maxBytes = 1000): InputDeclaration => ({ format: 'text', maxBytes, chars: chars as InputDeclaration['chars'] });
const json = (chars: string[], maxBytes = 1000): InputDeclaration => ({ format: 'json', maxBytes, chars: [...chars, 'json'] as InputDeclaration['chars'] });

const refusal = (payload: Uint8Array, d: InputDeclaration): { reason: string; message: string } => {
  const r = checkInputPayload(payload, d);
  if (r.ok) throw new Error('expected a refusal');
  return r;
};

describe('inputDigest', () => {
  it('is the size and the SHA-256 of the bytes (lowercase hex)', () => {
    expect(inputDigest(enc('abc'))).toEqual({ bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' });
    expect(inputDigest(new Uint8Array(0)).bytes).toBe(0);
  });
});

describe('checkInputPayload: size', () => {
  it('accepts exactly maxBytes and refuses one more, naming the maximum', () => {
    expect(checkInputPayload(enc('a'.repeat(10)), text(['letters'], 10)).ok).toBe(true);
    const r = refusal(enc('a'.repeat(11)), text(['letters'], 10));
    expect(r.reason).toBe('input-too-large');
    expect(r.message).toMatch(/11 bytes.*10/);
  });
});

describe('checkInputPayload: UTF-8 and the always refused characters', () => {
  it('refuses bytes that are not UTF-8 (input-format) whatever the union', () => {
    expect(refusal(new Uint8Array([0x61, 0xff, 0x62]), text(['utf8-text'])).reason).toBe('input-format');
    // an overlong encoding and a lone surrogate encoded as UTF-8 (CESU)
    expect(refusal(new Uint8Array([0xc0, 0x80]), text(['utf8-text'])).reason).toBe('input-format');
    expect(refusal(new Uint8Array([0xed, 0xa0, 0x80]), text(['utf8-text'])).reason).toBe('input-format');
  });
  it.each([
    ['NUL', '\u0000'],
    ['tab', '\t'],
    ['carriage return', '\r'],
    ['escape', '\u001b'],
    ['DEL', '\u007f'],
    ['C1 control', '\u0085'],
    ['right-to-left override', '\u202e'],
    ['left-to-right isolate', '\u2066'],
    ['LRM', '\u200e'],
    ['Arabic letter mark', '\u061c'],
  ])('refuses %s even under utf8-text', (_n, ch) => {
    const r = refusal(enc(`a${ch}b`), text(['utf8-text']));
    expect(r.reason).toBe('input-chars');
    // the message names the code point and the place, never the character itself
    expect(r.message).toMatch(/U\+[0-9A-F]{4}/);
    expect(r.message).not.toContain(ch);
  });
  it('line feed is a character like another (family space or utf8-text)', () => {
    expect(checkInputPayload(enc('a\nb'), text(['letters', 'space'])).ok).toBe(true);
    expect(checkInputPayload(enc('a\nb'), text(['letters'])).ok).toBe(false);
  });
});

describe('checkInputPayload: the whitelist union', () => {
  it('letters covers accents and other scripts, digits only 0-9', () => {
    expect(checkInputPayload(enc('Éléphant 東京'), text(['letters', 'space'])).ok).toBe(true);
    expect(checkInputPayload(enc('٣'), text(['letters', 'digits'])).ok).toBe(false);
    expect(checkInputPayload(enc('0123456789'), text(['digits'])).ok).toBe(true);
    // a combining mark is a letter family member
    expect(checkInputPayload(enc('é'), text(['letters'])).ok).toBe(true);
  });
  it('punct is only . , : ! ? - _ ( )', () => {
    expect(checkInputPayload(enc('.,:!?-_()'), text(['punct'])).ok).toBe(true);
    for (const ch of ['/', '\\', '"', "'", '`', ';', '&', '|', '$', '<', '>', '@', '#', '%', '*', '+', '=', '~', '^', '{', '}', '[', ']']) {
      expect(checkInputPayload(enc(ch), text(['letters', 'digits', 'space', 'punct'])).ok, ch).toBe(false);
    }
  });
  it.each([
    ['slash', '/'],
    ['backslash', '\\'],
    ['dquote', '"'],
    ['squote', "'"],
    ['backquote', '`'],
    ['semicolon', ';'],
    ['ampersand', '&'],
    ['pipe', '|'],
    ['dollar', '$'],
    ['lt', '<'],
    ['gt', '>'],
    ['at', '@'],
    ['hash', '#'],
    ['percent', '%'],
    ['star', '*'],
    ['plus', '+'],
    ['equal', '='],
    ['tilde', '~'],
    ['caret', '^'],
    ['brace-open', '{'],
    ['brace-close', '}'],
    ['bracket-open', '['],
    ['bracket-close', ']'],
  ])('the explicit family %s allows exactly %j', (name, ch) => {
    expect(checkInputPayload(enc(ch), text([name])).ok).toBe(true);
    const others = ['/', '\\', '"', "'", '`', ';', '&', '|', '$', '<', '>', '@', '#', '%', '*', '+', '=', '~', '^', '{', '}', '[', ']'].filter((c) => c !== ch);
    for (const other of others) expect(checkInputPayload(enc(other), text([name])).ok, other).toBe(false);
  });
  it('a character outside the union is refused with its code point, its place and the family to add', () => {
    const r = refusal(enc('ab;c'), text(['letters']));
    expect(r.reason).toBe('input-chars');
    expect(r.message).toMatch(/U\+003B/);
    expect(r.message).toMatch(/position 3/);
    expect(r.message).toMatch(/semicolon/);
    expect(r.message).toMatch(/machine admin allow --help/);
  });
  it('utf8-text allows every text character (accents, punctuation, quotes, shell characters, line feeds) and nothing that is always refused', () => {
    expect(checkInputPayload(enc('Il a dit : "c\'est l\'été" ; $(x) `y` | \\ \n 日本語 😀'), text(['utf8-text'])).ok).toBe(true);
  });
});

describe('checkInputPayload: json format', () => {
  const d = json(['letters', 'digits', 'space']);
  const dp = json(['letters', 'digits', 'space', 'punct']);
  it('accepts a document, passed on byte for byte (no re-serialization is needed)', () => {
    expect(checkInputPayload(enc('{"a": [1, 2, {"b": "c d"}], "n": null}'), json(['letters', 'digits', 'space', 'punct'])).ok).toBe(true);
    expect(checkInputPayload(enc('{"op":"get","id":12}'), d).ok).toBe(true);
  });
  it('refuses what does not parse (input-format) and is not decided by JSON.parse leniency', () => {
    for (const bad of ['{', '{"a":}', "{'a':1}", '{"a":1,}', '[1 2]', '01', '', 'undefined', '{"a":1}x', '{"a":NaN}']) {
      expect(refusal(enc(bad), json(['letters', 'digits', 'space', 'punct', 'squote', 'plus'])).reason, bad).toBe('input-format');
    }
  });
  it('refuses a duplicate key at any depth (ambiguity between parsers)', () => {
    expect(refusal(enc('{"a":1,"a":2}'), d).reason).toBe('input-format');
    expect(refusal(enc('{"x":{"a":1,"b":[{"c":1,"c":2}]}}'), d).reason).toBe('input-format');
    // the same key in two different objects is not a duplicate
    expect(checkInputPayload(enc('{"x":{"a":1},"y":{"a":2}}'), d).ok).toBe(true);
    // an escape does not hide a duplicate
    expect(refusal(enc('{"a":1,"\\u0061":2}'), d).reason).toBe('input-format');
  });
  it('refuses __proto__, constructor and prototype as a key at any depth, escapes included (D8)', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expect(refusal(enc(`{"${key}":1}`), dp).reason, key).toBe('input-format');
      expect(refusal(enc(`{"a":[{"${key}":1}]}`), dp).reason, key).toBe('input-format');
    }
    expect(refusal(enc('{"\\u005f\\u005fproto\\u005f\\u005f":1}'), d).reason).toBe('input-format');
    // as a VALUE it is only text
    expect(checkInputPayload(enc('{"a":"__proto__"}'), json(['letters', 'digits', 'space', 'punct']) ).ok).toBe(true);
  });
  it(`refuses a nesting deeper than ${INPUT_MAX_JSON_DEPTH}`, () => {
    const ok = `${'['.repeat(INPUT_MAX_JSON_DEPTH)}${']'.repeat(INPUT_MAX_JSON_DEPTH)}`;
    const deep = `${'['.repeat(INPUT_MAX_JSON_DEPTH + 1)}${']'.repeat(INPUT_MAX_JSON_DEPTH + 1)}`;
    expect(checkInputPayload(enc(ok), d).ok).toBe(true);
    const r = refusal(enc(deep), d);
    expect(r.reason).toBe('input-format');
    expect(r.message).toMatch(/32/);
    // an enormous nesting never reaches the parser (no stack overflow)
    expect(refusal(enc('['.repeat(200_000)), json(['letters'], 524288)).reason).toBe('input-format');
  });
  it('the json family alone does not allow letters or digits: the union is still the whitelist', () => {
    expect(refusal(enc('{"a":1}'), { format: 'json', maxBytes: 100, chars: ['json'] }).reason).toBe('input-chars');
  });
  it('characters are checked before the format: a forbidden character is input-chars even in a broken document', () => {
    expect(refusal(enc('{"a":1;'), d).reason).toBe('input-chars');
  });
});

describe('displayInput (escaped display of a held payload, T-42)', () => {
  it('shows control characters and bidi marks as escapes, the size and the hash', () => {
    const shown = displayInput(enc('a\u202eb\u0000\nc'), 4096);
    expect(shown.text).toContain('\\u202e');
    expect(shown.text).toContain('\\u0000');
    expect(shown.text).toContain('\\n');
    expect(shown.text).not.toContain('\u202e');
    expect(shown.bytes).toBe(enc('a\u202eb\u0000\nc').length);
    expect(shown.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(shown.cut).toBe(false);
  });
  it('shows the first 4 KiB and says it was cut', () => {
    const shown = displayInput(enc('x'.repeat(5000)), 4096);
    expect(shown.text.length).toBe(4096);
    expect(shown.cut).toBe(true);
  });
  it('bytes that are not UTF-8 are shown as \\x escapes, never decoded lossily', () => {
    expect(displayInput(new Uint8Array([0x61, 0xff]), 4096).text).toBe('a\\xff');
  });
});

describe('suggestInput (the smallest declaration that covers an example payload: the owner edits and signs)', () => {
  it('a JSON document of words and numbers: json, and only the families it uses', () => {
    const s = suggestInput(enc('{"op": "get", "id": 12}'));
    expect(s).toEqual({ format: 'json', chars: ['letters', 'digits', 'space', 'json'] });
  });
  it('plain text with a semicolon and an apostrophe: text, the characters named one by one', () => {
    expect(suggestInput(enc("it's a; b"))).toEqual({ format: 'text', chars: ['letters', 'space', 'squote', 'semicolon'] });
  });
  it('a character outside the table of names needs utf8-text, which then stands alone', () => {
    expect(suggestInput(enc('prix: 5 €'))).toEqual({ format: 'text', chars: ['utf8-text'] });
  });
  it('a payload that is not text at all has no suggestion (the owner sees the escaped bytes and decides)', () => {
    expect(suggestInput(new Uint8Array([0xff, 0x00]))).toBeUndefined();
    expect(suggestInput(enc('a\u0000b'))).toBeUndefined();
  });
  it('the suggestion accepts its own payload', () => {
    for (const sample of ['{"a":[1,2,"x y"]}', "it's a; b", 'prix €']) {
      const s = suggestInput(enc(sample));
      if (s === undefined) throw new Error('no suggestion');
      expect(checkInputPayload(enc(sample), { ...s, maxBytes: 1000 }).ok, sample).toBe(true);
    }
  });
});
