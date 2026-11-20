import { describe, expect, it } from 'vitest';
import { decodeOutput } from './outputDecode.js';

const utf8 = (s: string) => [Buffer.from(s, 'utf8')];
const fixed = (page: number | undefined) => async () => page;
const accented = String.fromCharCode(0xe9);

describe('decodeOutput', () => {
  it('leaves valid UTF-8 alone and never asks for the code page', async () => {
    let asked = false;
    const r = await decodeOutput(utf8(`caf${accented}`), false, async () => {
      asked = true;
      return 850;
    });
    expect(r).toEqual({ text: `caf${accented}`, lossy: false, decodedFrom: undefined });
    expect(asked).toBe(false);
  });

  it('decodes OEM bytes with the page of the machine and says which page', async () => {
    // 0x82 is e acute in cp850 and an invalid UTF-8 byte.
    const r = await decodeOutput([Buffer.from([0x63, 0x61, 0x66, 0x82])], false, fixed(850));
    expect(r).toEqual({ text: `caf${accented}`, lossy: false, decodedFrom: 'cp850' });
  });

  it('joins chunks before decoding (a character may be split between two reads)', async () => {
    const r = await decodeOutput([Buffer.from([0x63, 0x61]), Buffer.from([0x66, 0x82])], false, fixed(850));
    expect(r.text).toBe(`caf${accented}`);
  });

  it('keeps the old lossy behaviour when the page is unknown', async () => {
    const r = await decodeOutput([Buffer.from([0x63, 0x82])], false, fixed(undefined));
    expect(r).toEqual({ text: 'c\ufffd', lossy: true, decodedFrom: undefined });
  });

  it('keeps the old lossy behaviour when the page is not supported', async () => {
    const r = await decodeOutput([Buffer.from([0x63, 0x82])], false, fixed(932));
    expect(r.lossy).toBe(true);
    expect(r.decodedFrom).toBeUndefined();
  });

  it('keeps the old lossy behaviour when the bytes are invalid even in the page (cp1252 0x81)', async () => {
    const r = await decodeOutput([Buffer.from([0x63, 0x81])], false, fixed(1252));
    expect(r.lossy).toBe(true);
    expect(r.decodedFrom).toBeUndefined();
  });

  it('does not treat a character cut in two by the output cap as an encoding problem', async () => {
    const r = await decodeOutput([Buffer.from([0x61, 0xc3])], true, fixed(850));
    expect(r.lossy).toBe(false);
    expect(r.decodedFrom).toBeUndefined();
  });

  it('a failing page lookup is the old behaviour, never a crash', async () => {
    const r = await decodeOutput([Buffer.from([0x63, 0x82])], false, async () => {
      throw new Error('boom');
    });
    expect(r.lossy).toBe(true);
  });
});
