import { candidacyCode as nodeCandidacyCode, finalCode as nodeFinalCode, generateSigningKeyPair, newCandidacyRandom } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { proveCandidacy } from './candidacyProof.js';

const candidate = generateSigningKeyPair();
const admin = generateSigningKeyPair();
const random = newCandidacyRandom();

describe('proveCandidacy (the page recomputes the codes from the key and random AS RECEIVED; the relay is never trusted)', () => {
  it('returns the candidacy code and the final code, equal to machine-core', async () => {
    const proof = await proveCandidacy({ identityPublicKey: candidate.publicKey, random, listedCode: nodeCandidacyCode(candidate.publicKey, random), adminPublicKey: admin.publicKey });
    expect(proof).toEqual({ candidacyCode: nodeCandidacyCode(candidate.publicKey, random), finalCode: nodeFinalCode(candidate.publicKey, admin.publicKey, random) });
  });

  it('refuses when the code listed by the backend differs from the recomputed one, naming the cause and the fix', async () => {
    await expect(proveCandidacy({ identityPublicKey: candidate.publicKey, random, listedCode: 'AAAA-BBBB-CCCC-DDDD', adminPublicKey: admin.publicKey })).rejects.toThrow(/does not match.*reject|Reject/s);
  });

  it('accepts the listed code up to case, spaces and dashes (same normalization as the backend)', async () => {
    const code = nodeCandidacyCode(candidate.publicKey, random);
    await expect(proveCandidacy({ identityPublicKey: candidate.publicKey, random, listedCode: code.toLowerCase().replaceAll('-', ' '), adminPublicKey: admin.publicKey })).resolves.toBeDefined();
  });

  it('refuses a missing key or random (a candidacy the backend could not compute a code for), with the fix', async () => {
    await expect(proveCandidacy({ identityPublicKey: undefined, random, listedCode: undefined, adminPublicKey: admin.publicKey })).rejects.toThrow(/Reject/);
    await expect(proveCandidacy({ identityPublicKey: candidate.publicKey, random: undefined, listedCode: undefined, adminPublicKey: admin.publicKey })).rejects.toThrow(/Reject/);
  });

  it('refuses a malformed admin key', async () => {
    await expect(proveCandidacy({ identityPublicKey: candidate.publicKey, random, listedCode: nodeCandidacyCode(candidate.publicKey, random), adminPublicKey: 'xx' })).rejects.toThrow(/admin/i);
  });

  it('refuses when the backend gave no code to compare with (nothing to cross-check: not assumed fine)', async () => {
    await expect(proveCandidacy({ identityPublicKey: candidate.publicKey, random, listedCode: undefined, adminPublicKey: admin.publicKey })).rejects.toThrow(/no code/i);
  });
});
