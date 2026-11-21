import { describe, expect, it } from 'vitest';
import { generateSigningKeyPair, newCandidacyRandom, openSealed, sealTo } from '@wadeck-app/machine-core';
import { approvalSealContext, checkApproval, sealApproval } from './approval.js';
import type { MachineInfo } from './network.js';

// Decision 77: the approval an admin returns through the relay is sealed to the identity key of the candidate, as a whole.
// The shape and content checks of what is inside are in enroll.test.ts (they go through the real join); here: the envelope.

const UUID = '11111111-1111-4111-8111-111111111111';

function setup() {
  const identity = generateSigningKeyPair();
  const self: MachineInfo = { v: 1, uuid: UUID, name: 'laptop', identityPublicKey: identity.publicKey };
  const random = newCandidacyRandom();
  const inner = { v: 1, self: { registration: { body: {}, signature: 's' }, sealedPairSecret: 'AAAA' }, admin: { v: 1, adminPublicKey: 'k', adminKeyId: 'i' }, adminUuid: null, peers: [], random };
  return { identity, self, random, inner };
}

describe('sealApproval', () => {
  it('is { v: 2, random, sealed } and nothing else: the random is the one of the candidacy the relay already holds', () => {
    const s = setup();
    const sealed = sealApproval(s.inner, s.identity.publicKey, s.self.uuid);
    expect(Object.keys(sealed).sort()).toEqual(['random', 'sealed', 'v']);
    expect(sealed.v).toBe(2);
    expect(sealed.random).toBe(s.random);
    expect(JSON.stringify(sealed)).not.toContain('adminPublicKey');
  });

  it('opens only with the key of the candidate, for this candidate uuid and this random', () => {
    const s = setup();
    const sealed = sealApproval(s.inner, s.identity.publicKey, s.self.uuid);
    const plain = openSealed(s.identity.privateKeyPkcs8, sealed.sealed, approvalSealContext(s.self.uuid, s.random));
    expect(JSON.parse(Buffer.from(plain).toString('utf8')).random).toBe(s.random);
    expect(() => openSealed(generateSigningKeyPair().privateKeyPkcs8, sealed.sealed, approvalSealContext(s.self.uuid, s.random))).toThrow();
    expect(() => openSealed(s.identity.privateKeyPkcs8, sealed.sealed, approvalSealContext('22222222-2222-4222-8222-222222222222', s.random))).toThrow();
    expect(() => openSealed(s.identity.privateKeyPkcs8, sealed.sealed, approvalSealContext(s.self.uuid, newCandidacyRandom()))).toThrow();
  });
});

describe('checkApproval: the envelope', () => {
  const now = Math.floor(Date.now() / 1000);

  it('refuses a clear approval (envelope version 1) loudly, naming the update on the admin machine, and pins nothing', () => {
    const s = setup();
    expect(() => checkApproval(s.inner, s.self, now, s.random, s.identity.privateKeyPkcs8)).toThrow(/PLAINTEXT.*machine cli update/s);
  });

  it('refuses an approval sealed to another key, with the fix', () => {
    const s = setup();
    const sealed = sealApproval(s.inner, generateSigningKeyPair().publicKey, s.self.uuid);
    expect(() => checkApproval(sealed, s.self, now, s.random, s.identity.privateKeyPkcs8)).toThrow(/cannot open the approval.*machine join --resume/s);
  });

  it('refuses a sealed approval that answers another candidacy before opening it', () => {
    const s = setup();
    const sealed = sealApproval(s.inner, s.identity.publicKey, s.self.uuid);
    expect(() => checkApproval(sealed, s.self, now, newCandidacyRandom(), s.identity.privateKeyPkcs8)).toThrow(/another candidacy/);
  });

  it('refuses unknown fields in the envelope and an unknown envelope version', () => {
    const s = setup();
    const sealed = sealApproval(s.inner, s.identity.publicKey, s.self.uuid);
    expect(() => checkApproval({ ...sealed, extra: 1 }, s.self, now, s.random, s.identity.privateKeyPkcs8)).toThrow(/unknown field "extra"/);
    expect(() => checkApproval({ ...sealed, v: 3 }, s.self, now, s.random, s.identity.privateKeyPkcs8)).toThrow(/version 3/);
  });

  it('refuses a sealed blob that is not an approval (sealed by something else), without trusting anything', () => {
    const s = setup();
    const sealed = { v: 2, random: s.random, sealed: sealTo(s.identity.publicKey, Buffer.from('not json'), approvalSealContext(s.self.uuid, s.random)) };
    expect(() => checkApproval(sealed, s.self, now, s.random, s.identity.privateKeyPkcs8)).toThrow(/not JSON|not an approval/);
  });
});
