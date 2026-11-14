import { derivePairSecret, derivePairSecretV2 } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { bytes, newPair, pkcs8FromSeed, prng, uuid, webKeyFrom } from '../test-support/kit.js';
import { derivePairSecretFromSignature } from './pairSecret.js';
import { derivePairSecretFromSeedForTests } from './pairSecretTestOnly.js';

const A = { uuid: '22222222-2222-4222-8222-222222222222', serial: 5 };
const B = { uuid: '11111111-1111-4111-8111-111111111111', serial: 9 };
const FIXED_SEED = new Uint8Array(32).map((_, i) => i + 1);

describe('derivePairSecretFromSignature equals derivePairSecretV2 of machine-core', () => {
  it('fixed vector (seed 01..20, fixed uuids and serials), both orders', async () => {
    const pkcs8 = pkcs8FromSeed(FIXED_SEED);
    const key = await crypto.subtle.importKey('pkcs8', pkcs8 as BufferSource, 'Ed25519', false, ['sign']);
    const core = derivePairSecretV2(pkcs8, A, B);
    expect(await derivePairSecretFromSignature(key, A, B)).toBe(core);
    expect(await derivePairSecretFromSignature(key, B, A)).toBe(core);
    expect(core).toBe(FIXED_V2);
  });

  it('100 random cases', async () => {
    const rand = prng(21);
    for (let i = 0; i < 100; i++) {
      const pair = newPair();
      const key = await webKeyFrom(pair);
      const a = { uuid: uuid(), serial: 1 + Math.floor(rand() * 1000) };
      const b = { uuid: uuid(), serial: 1 + Math.floor(rand() * 1000) };
      expect(await derivePairSecretFromSignature(key, a, b)).toBe(derivePairSecretV2(pair.privateKeyPkcs8, a, b));
    }
  });

  it('refuses a bad uuid, a bad serial and a machine paired with itself, with the same messages', async () => {
    const pair = newPair();
    const key = await webKeyFrom(pair);
    const cases: Array<[{ uuid: string; serial: number }, { uuid: string; serial: number }]> = [
      [{ uuid: 'nope', serial: 1 }, B],
      [{ uuid: A.uuid, serial: 0 }, B],
      [{ uuid: A.uuid, serial: 1.5 }, B],
      [A, A],
    ];
    for (const [a, b] of cases) {
      let core = '';
      try {
        derivePairSecretV2(pair.privateKeyPkcs8, a, b);
      } catch (e) {
        core = (e as Error).message;
      }
      expect(core).not.toBe('');
      await expect(derivePairSecretFromSignature(key, a, b)).rejects.toThrow(core);
    }
  });

  it('works with a non-extractable key and refuses a key that cannot sign', async () => {
    const pair = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
    const secret = await derivePairSecretFromSignature(pair.privateKey, A, B);
    expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
    await expect(derivePairSecretFromSignature(pair.publicKey, A, B)).rejects.toThrow(/signing key/);
  });
});

describe('derivePairSecretFromSeedForTests equals the current derivePairSecret (test helper only, needs the raw seed)', () => {
  it('fixed vector and 100 random cases', async () => {
    const pkcs8 = pkcs8FromSeed(FIXED_SEED);
    const core = derivePairSecret(pkcs8, A, B);
    expect(await derivePairSecretFromSeedForTests(FIXED_SEED, A, B)).toBe(core);
    expect(core).toBe(FIXED_V1);
    const rand = prng(22);
    for (let i = 0; i < 100; i++) {
      const seed = bytes(32);
      const a = { uuid: uuid(), serial: 1 + Math.floor(rand() * 1000) };
      const b = { uuid: uuid(), serial: 1 + Math.floor(rand() * 1000) };
      expect(await derivePairSecretFromSeedForTests(seed, a, b)).toBe(derivePairSecret(pkcs8FromSeed(seed), a, b));
    }
  });
});

// Recorded from machine-core (the reference implementation) for the fixed inputs above.
const FIXED_V1 = 'B7uiB-8H8gk_JzLvcowu1FoJCpo50H_qNVL_4eLYeNE';
const FIXED_V2 = 'km2Zr_NlRSSwCEmsTKLXra2zHQnz46sRJauLFB9LdrU';
