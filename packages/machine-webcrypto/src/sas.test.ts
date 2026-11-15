import { candidacyCode as coreCandidacy, finalCode as coreFinal, newCandidacyRandom } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { b64u, bytes, newPair } from '../test-support/kit.js';
import { candidacyCode, finalCode, formatFinalCode, formatVerificationCode } from './sas.js';

describe('verification codes', () => {
  it('fixed vector: all-zero keys and random, equal to machine-core', async () => {
    const zero = b64u(new Uint8Array(32));
    const random = b64u(new Uint8Array(16));
    const core = coreCandidacy(zero, random);
    expect(core).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    expect(await candidacyCode(zero, random)).toBe(core);
    expect(await finalCode(zero, zero, random)).toBe(coreFinal(zero, zero, random));
  });

  // Decision 55: the final code is 25 digits in five groups of five (83 bits). Same fixed vectors as machine-core sas.test.ts.
  it('final code: fixed vectors, five groups of five digits, equal to machine-core', async () => {
    expect(formatFinalCode(new Uint8Array(32))).toBe('00000 00000 00000 00000 00000');
    expect(formatFinalCode(new Uint8Array(32).fill(255))).toBe('96714 06556 91703 33976 49407');
    const first = new Uint8Array(32);
    first[0] = 0x80;
    expect(formatFinalCode(first)).toBe('48357 03278 45851 66988 24704');
    const lastKept = new Uint8Array(32);
    lastKept[10] = 0x20;
    expect(formatFinalCode(lastKept)).toBe('00000 00000 00000 00000 00001');
    const dropped = new Uint8Array(32);
    dropped[10] = 0x1f;
    expect(formatFinalCode(dropped)).toBe('00000 00000 00000 00000 00000');
    expect(() => formatFinalCode(new Uint8Array(10))).toThrow(/at least 11 bytes/);
    const zero = b64u(new Uint8Array(32));
    const random = b64u(new Uint8Array(16));
    expect(await finalCode(zero, zero, random)).toBe('66266 06377 45699 09220 73088');
    expect(coreFinal(zero, zero, random)).toBe('66266 06377 45699 09220 73088');
  });

  it('100 random cases give the same candidacy and final codes as machine-core', async () => {
    for (let i = 0; i < 100; i++) {
      const candidate = newPair().publicKey;
      const admin = newPair().publicKey;
      const random = newCandidacyRandom();
      expect(await candidacyCode(candidate, random)).toBe(coreCandidacy(candidate, random));
      expect(await finalCode(candidate, admin, random)).toBe(coreFinal(candidate, admin, random));
    }
  });

  it('formats 80 bits as four groups of four Crockford characters', () => {
    expect(formatVerificationCode(new Uint8Array(32))).toBe('0000-0000-0000-0000');
    expect(formatVerificationCode(new Uint8Array(32).fill(255))).toBe('ZZZZ-ZZZZ-ZZZZ-ZZZZ');
    expect(() => formatVerificationCode(new Uint8Array(5))).toThrow(/at least 10 bytes/);
  });

  it('refuses malformed keys and randoms like machine-core, naming what is wrong', async () => {
    const ok = newPair().publicKey;
    await expect(candidacyCode('AAAA', newCandidacyRandom())).rejects.toThrow(/candidate public key/);
    await expect(candidacyCode(ok, 'AAAA')).rejects.toThrow(/candidacy random/);
    await expect(finalCode(ok, 'AAAA', newCandidacyRandom())).rejects.toThrow(/admin public key/);
    expect(bytes(1)).toHaveLength(1);
  });
});
