import { describe, expect, it } from 'vitest';
import { generateSigningKeyPair } from './keys.js';
import { candidacyCode, finalCode, formatFinalCode, newCandidacyRandom } from './sas.js';

// Decision 55: the final code ("security code") is shown as 25 decimal digits in five groups of five, visibly unlike the
// base32 candidacy code and the relay login code. It carries 83 bits of the digest (80 before): never fewer.
describe('final code display (decision 55)', () => {
  it('shows five groups of five digits separated by spaces', () => {
    const code = finalCode(generateSigningKeyPair().publicKey, generateSigningKeyPair().publicKey, newCandidacyRandom());
    expect(code).toMatch(/^\d{5}( \d{5}){4}$/);
  });

  it('fixed vectors of the display encoding (the same ones are checked in machine-webcrypto)', () => {
    expect(formatFinalCode(Buffer.alloc(32))).toBe('00000 00000 00000 00000 00000');
    // 2^83 - 1: every kept bit set.
    expect(formatFinalCode(Buffer.alloc(32, 255))).toBe('96714 06556 91703 33976 49407');
    // 2^82: only the first bit set.
    expect(formatFinalCode(Buffer.concat([Buffer.from([0x80]), Buffer.alloc(31)]))).toBe('48357 03278 45851 66988 24704');
  });

  it('fixed vector from all-zero keys and random', () => {
    const zero = Buffer.alloc(32).toString('base64url');
    expect(finalCode(zero, zero, Buffer.alloc(16).toString('base64url'))).toBe(FIXED_FINAL_ZERO);
  });

  it('keeps 83 bits: the last kept bit changes the code, the 5 dropped bits do not', () => {
    const base = Buffer.alloc(32);
    const lastKept = Buffer.from(base);
    lastKept[10] = 0x20;
    const dropped = Buffer.from(base);
    dropped[10] = 0x1f;
    expect(formatFinalCode(lastKept)).not.toBe(formatFinalCode(base));
    expect(formatFinalCode(dropped)).toBe(formatFinalCode(base));
    expect(formatFinalCode(lastKept)).toBe('00000 00000 00000 00000 00001');
  });

  it('refuses a digest shorter than 11 bytes', () => {
    expect(() => formatFinalCode(Buffer.alloc(10))).toThrow(/at least 11 bytes/);
  });
});

// Computed once by machine-core and checked by the independent WebCrypto twin (machine-webcrypto/src/sas.test.ts).
const FIXED_FINAL_ZERO = '66266 06377 45699 09220 73088';

describe('verification codes (enrollment)', () => {
  it('shows 80 bits as four groups of four Crockford base32 characters', () => {
    const candidate = generateSigningKeyPair();
    const code = candidacyCode(candidate.publicKey, newCandidacyRandom());
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
  });

  it('is the same on both sides for the same key and random', () => {
    const candidate = generateSigningKeyPair();
    const random = newCandidacyRandom();
    expect(candidacyCode(candidate.publicKey, random)).toBe(candidacyCode(candidate.publicKey, random));
  });

  it('changes when the relay swaps the candidate key', () => {
    const real = generateSigningKeyPair();
    const fake = generateSigningKeyPair();
    const random = newCandidacyRandom();
    expect(candidacyCode(real.publicKey, random)).not.toBe(candidacyCode(fake.publicKey, random));
  });

  it('changes when the random value changes', () => {
    const candidate = generateSigningKeyPair();
    expect(candidacyCode(candidate.publicKey, newCandidacyRandom())).not.toBe(candidacyCode(candidate.publicKey, newCandidacyRandom()));
  });

  it('final code depends on both keys: a relay giving its own admin key shows another code', () => {
    const candidate = generateSigningKeyPair();
    const admin = generateSigningKeyPair();
    const relayAdmin = generateSigningKeyPair();
    const random = newCandidacyRandom();
    expect(finalCode(candidate.publicKey, admin.publicKey, random)).not.toBe(finalCode(candidate.publicKey, relayAdmin.publicKey, random));
  });

  it('keeps the two kinds of code apart (domain separation)', () => {
    const candidate = generateSigningKeyPair();
    const admin = generateSigningKeyPair();
    const random = newCandidacyRandom();
    expect(candidacyCode(candidate.publicKey, random)).not.toBe(finalCode(candidate.publicKey, admin.publicKey, random));
  });

  it('refuses a random value that is not 16 bytes of base64url', () => {
    const candidate = generateSigningKeyPair();
    expect(() => candidacyCode(candidate.publicKey, 'abc')).toThrow(/random.*16 bytes/);
  });

  it('refuses a padded or non-canonical public key and random (review finding)', () => {
    const candidate = generateSigningKeyPair();
    const random = newCandidacyRandom();
    expect(() => candidacyCode(`${candidate.publicKey}=`, random)).toThrow(/candidate public key/);
    expect(() => candidacyCode(candidate.publicKey, `${random}=`)).toThrow(/random/);
  });

  it('grinding is out of reach: 2000 swapped keys never reproduce the displayed code', () => {
    // Not a proof (the work factor is 2^80), a regression guard against a shortened code.
    const real = generateSigningKeyPair();
    const random = newCandidacyRandom();
    const target = candidacyCode(real.publicKey, random);
    for (let i = 0; i < 2000; i++) {
      expect(candidacyCode(generateSigningKeyPair().publicKey, random)).not.toBe(target);
    }
  });
});
