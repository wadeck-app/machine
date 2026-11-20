import { describe, expect, it } from 'vitest';
import { SUPPORTED_CODE_PAGES, decodeCodePage, parseOemCodePage } from './codePages.js';

function decodeByte(page: number, byte: number): string | undefined {
  return decodeCodePage(Uint8Array.of(byte), page);
}

// Expected code points written from the published mappings of each page (independent of the table in codePages.ts).
const KNOWN: Record<number, Array<[number, number, string]>> = {
  437: [[0x80, 0x00c7, 'C cedilla'], [0x82, 0x00e9, 'e acute'], [0x8a, 0x00e8, 'e grave'], [0x9b, 0x00a2, 'cent'], [0xc4, 0x2500, 'box light horizontal'], [0xe1, 0x00df, 'sharp s'], [0xe9, 0x0398, 'Theta'], [0xfb, 0x221a, 'square root']],
  850: [[0x80, 0x00c7, 'C cedilla'], [0x82, 0x00e9, 'e acute'], [0x8a, 0x00e8, 'e grave'], [0x9b, 0x00f8, 'o stroke'], [0xb5, 0x00c1, 'A acute'], [0xd5, 0x0131, 'dotless i'], [0xe9, 0x00da, 'U acute'], [0xfd, 0x00b2, 'superscript two']],
  858: [[0x82, 0x00e9, 'e acute'], [0x8a, 0x00e8, 'e grave'], [0xb5, 0x00c1, 'A acute'], [0xd5, 0x20ac, 'euro (the difference with 850)'], [0xe9, 0x00da, 'U acute']],
  852: [[0x82, 0x00e9, 'e acute'], [0x9f, 0x010d, 'c caron'], [0xa4, 0x0104, 'A ogonek'], [0xa5, 0x0105, 'a ogonek'], [0xd0, 0x0111, 'd stroke'], [0xee, 0x0163, 't cedilla']],
  860: [[0x84, 0x00e3, 'a tilde'], [0x86, 0x00c1, 'A acute'], [0x82, 0x00e9, 'e acute'], [0x8f, 0x00c2, 'A circumflex'], [0x9d, 0x00d9, 'U grave']],
  863: [[0x82, 0x00e9, 'e acute'], [0x84, 0x00c2, 'A circumflex'], [0x8d, 0x2017, 'double low line'], [0x8f, 0x00a7, 'section sign'], [0xa8, 0x00ce, 'I circumflex']],
  865: [[0x82, 0x00e9, 'e acute'], [0x9b, 0x00f8, 'o stroke'], [0x9d, 0x00d8, 'O stroke'], [0xa8, 0x00bf, 'inverted question mark'], [0xaf, 0x00a4, 'currency sign']],
  1252: [[0x80, 0x20ac, 'euro'], [0xe9, 0x00e9, 'e acute'], [0xe8, 0x00e8, 'e grave'], [0xa0, 0x00a0, 'no-break space'], [0x99, 0x2122, 'trade mark']],
};

describe('decodeCodePage', () => {
  it('knows exactly the pages the documentation lists', () => {
    expect([...SUPPORTED_CODE_PAGES].sort((a, b) => a - b)).toEqual([437, 850, 852, 858, 860, 863, 865, 1252]);
  });

  for (const page of Object.keys(KNOWN).map(Number)) {
    it(`maps well-known characters of cp${page}`, () => {
      for (const [byte, codePoint, name] of KNOWN[page]!) {
        expect(decodeByte(page, byte), `cp${page} byte 0x${byte.toString(16)} (${name})`).toBe(String.fromCodePoint(codePoint));
      }
    });
  }

  it('keeps ASCII unchanged on every page', () => {
    for (const page of SUPPORTED_CODE_PAGES) {
      const ascii = Uint8Array.from({ length: 128 }, (_, i) => i);
      expect(decodeCodePage(ascii, page)).toBe(Buffer.from(ascii).toString('latin1'));
    }
  });

  it('decodes the 850 bytes of a French word as cmd writes it', () => {
    expect(decodeCodePage(Buffer.from([0x64, 0x82, 0x66, 0x61, 0x75, 0x74]), 850)).toBe(`d${String.fromCharCode(0xe9)}faut`);
  });

  it('returns undefined for a page it does not know', () => {
    expect(decodeCodePage(Uint8Array.of(0x82), 932)).toBeUndefined();
    expect(decodeCodePage(Uint8Array.of(0x82), 65001)).toBeUndefined();
  });

  it('returns undefined when a byte is undefined in the page (cp1252 has five)', () => {
    for (const byte of [0x81, 0x8d, 0x8f, 0x90, 0x9d]) expect(decodeByte(1252, byte), `0x${byte.toString(16)}`).toBeUndefined();
    expect(decodeByte(1252, 0x80)).toBe('\u20ac');
  });
});

describe('parseOemCodePage', () => {
  it('reads the value of `reg query ... /v OEMCP`', () => {
    const out = '\r\nHKEY_LOCAL_MACHINE (the CodePage key)\r\n    OEMCP    REG_SZ    850\r\n\r\n';
    expect(parseOemCodePage(out)).toBe(850);
  });

  it('returns undefined for anything else, without throwing', () => {
    expect(parseOemCodePage('')).toBeUndefined();
    expect(parseOemCodePage('ERROR: The system was unable to find the specified registry key or value.')).toBeUndefined();
    expect(parseOemCodePage('    OEMCP    REG_SZ    abc')).toBeUndefined();
  });
});
