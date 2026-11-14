import { describe, expect, it } from 'vitest';
import { generateSigningKeyPair } from './keys.js';
import { candidacyCode, finalCode, newCandidacyRandom } from './sas.js';

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
