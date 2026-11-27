import { derivePairSecretV2, finalCode, generateSigningKeyPair, keyId, newCandidacyRandom } from '@wadeck-app/machine-core';
import { buildApproval } from '@wadeck-app/machine-webcrypto';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkApproval } from './approval.js';
import type { MachineInfo } from './network.js';

// Approve from the page, lot 2: the approval built in the browser package (WebCrypto, non-extractable key) is read by the REAL candidate code (`checkApproval`),
// which verifies every registration against the admin key found in the approval and opens every sealed value. Fixed clock, fresh keys.

const NOW = 1_800_000_000;

async function scenario() {
  const adminPair = generateSigningKeyPair();
  const adminPrivateKey = await crypto.subtle.importKey('pkcs8', adminPair.privateKeyPkcs8 as BufferSource, 'Ed25519', false, ['sign']);
  const candidateIdentity = generateSigningKeyPair();
  const adminMachineIdentity = generateSigningKeyPair();
  const random = newCandidacyRandom();
  const candidate: MachineInfo = { v: 1, uuid: randomUUID(), name: 'laptop', identityPublicKey: candidateIdentity.publicKey };
  const adminMachine: MachineInfo = { v: 1, uuid: randomUUID(), name: 'desk', identityPublicKey: adminMachineIdentity.publicKey };
  const input = { adminPrivateKey, adminPublicKey: adminPair.publicKey, adminKeyId: keyId(adminPair.publicKey), candidate: { uuid: candidate.uuid, name: candidate.name, identityPublicKey: candidate.identityPublicKey, random }, now: NOW, validForDays: 90 };
  return { adminPair, candidateIdentity, adminMachineIdentity, random, candidate, adminMachine, input };
}

describe('an approval built by machine-webcrypto is accepted by machine-cli checkApproval', () => {
  it('opens, verifies both registrations against the admin key it carries, and yields the pair secret V2 of machine-core on both entries', async () => {
    const s = await scenario();
    const built = await buildApproval({ ...s.input, adminMachine: { uuid: s.adminMachine.uuid, name: s.adminMachine.name, identityPublicKey: s.adminMachine.identityPublicKey } });
    const checked = checkApproval(built.approval, s.candidate, NOW, s.random, s.candidateIdentity.privateKeyPkcs8);
    expect(checked.admin).toMatchObject({ adminPublicKey: s.adminPair.publicKey, adminKeyId: keyId(s.adminPair.publicKey) });
    expect(checked.selfBody).toMatchObject({ uuid: s.candidate.uuid, name: 'laptop', identityPublicKey: s.candidate.identityPublicKey, serial: NOW, validTo: NOW + 90 * 86_400 });
    expect(checked.peerBodies.map((b) => b.uuid)).toEqual([s.adminMachine.uuid]);
    const expected = derivePairSecretV2(s.adminPair.privateKeyPkcs8, { uuid: s.candidate.uuid, serial: NOW }, { uuid: s.adminMachine.uuid, serial: NOW });
    expect(checked.approval.self.pairSecret).toBe(expected);
    expect(checked.approval.peers[0]?.pairSecret).toBe(expected);
    expect(checked.approval.adminUuid).toBe(s.adminMachine.uuid);
  });

  it('the first machine approving itself: accepted with no peer', async () => {
    const s = await scenario();
    const built = await buildApproval({ ...s.input, adminMachine: { uuid: s.candidate.uuid, name: s.candidate.name, identityPublicKey: s.candidate.identityPublicKey } });
    const checked = checkApproval(built.approval, s.candidate, NOW, s.random, s.candidateIdentity.privateKeyPkcs8);
    expect(checked.peerBodies).toEqual([]);
  });

  it('the security code of the page is the one the candidate computes from the admin key carried by the approval (final code of machine-core)', async () => {
    const s = await scenario();
    const built = await buildApproval({ ...s.input, adminMachine: null });
    const checked = checkApproval(built.approval, s.candidate, NOW, s.random, s.candidateIdentity.privateKeyPkcs8);
    expect(built.finalCode).toBe(finalCode(s.candidate.identityPublicKey, checked.admin.adminPublicKey, s.random));
  });

  it('refused by the candidate when sealed for another candidacy random (the page signs for the random it recomputed from)', async () => {
    const s = await scenario();
    const built = await buildApproval({ ...s.input, adminMachine: null });
    expect(() => checkApproval(built.approval, s.candidate, NOW, newCandidacyRandom(), s.candidateIdentity.privateKeyPkcs8)).toThrow(/another candidacy/);
  });
});
