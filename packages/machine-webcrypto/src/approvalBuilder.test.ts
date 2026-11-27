import {
  approvalSealContext,
  canonicalize,
  derivePairSecretV2,
  finalCode as coreFinalCode,
  generateSigningKeyPair,
  importCandidateSealContext,
  keyId,
  newCandidacyRandom,
  openSealed,
  pairSecretContext,
  signRegistration as coreSignRegistration,
  verifyRegistration,
  type Json,
  type RegistrationBody,
} from '@wadeck-app/machine-core';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { newPair, pkcs8FromSeed, uuid, webKeyFrom } from '../test-support/kit.js';
import {
  approvalSealContext as webApprovalSealContext,
  buildApproval,
  importCandidateSealContext as webImportContext,
  pairSecretContext as webPairSecretContext,
  type BuildApprovalInput,
} from './approvalBuilder.js';

const NOW = 1_800_000_000;
const FIXED_SEED = new Uint8Array(32).map((_, i) => i + 1);

async function setup(overrides: Partial<BuildApprovalInput> = {}) {
  const adminPair = newPair();
  const adminPrivateKey = await webKeyFrom(adminPair);
  const candidateIdentity = generateSigningKeyPair();
  const adminMachineIdentity = generateSigningKeyPair();
  const candidate = { uuid: uuid(), name: 'laptop', identityPublicKey: candidateIdentity.publicKey, random: newCandidacyRandom() };
  const adminMachine = { uuid: uuid(), name: 'desk', identityPublicKey: adminMachineIdentity.publicKey };
  const input: BuildApprovalInput = {
    adminPrivateKey,
    adminPublicKey: adminPair.publicKey,
    adminKeyId: keyId(adminPair.publicKey),
    candidate,
    adminMachine,
    now: NOW,
    validForDays: 90,
    ...overrides,
  };
  return { adminPair, candidateIdentity, adminMachineIdentity, candidate, adminMachine, input };
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('seal contexts (copies of machine-core)', () => {
  it('are equal to the ones of machine-core', () => {
    const parts = { adminUuid: uuid(), candidateUuid: uuid(), random: newCandidacyRandom(), slot: 'self' };
    expect(webPairSecretContext(parts)).toBe(pairSecretContext(parts));
    expect(webPairSecretContext({ ...parts, adminUuid: null })).toBe(pairSecretContext({ ...parts, adminUuid: null }));
    expect(webApprovalSealContext(parts.candidateUuid, parts.random)).toBe(approvalSealContext(parts.candidateUuid, parts.random));
    expect(webImportContext(parts.adminUuid, parts.candidateUuid, parts.random)).toBe(importCandidateSealContext(parts.adminUuid, parts.candidateUuid, parts.random));
  });
});

describe('buildApproval: registrations and pair secret equal machine-core', () => {
  it('fixed vector: both registrations are byte-for-byte what machine-core signs for the same body (Ed25519 is deterministic)', async () => {
    const pkcs8 = pkcs8FromSeed(FIXED_SEED);
    const adminPair = { privateKeyPkcs8: pkcs8, publicKey: generateSigningKeyPairFromSeedPublic(pkcs8) };
    const key = await crypto.subtle.importKey('pkcs8', pkcs8 as BufferSource, 'Ed25519', false, ['sign']);
    const s = await setup({ adminPrivateKey: key, adminPublicKey: adminPair.publicKey, adminKeyId: keyId(adminPair.publicKey) });
    const built = await buildApproval(s.input);
    const body = (m: { uuid: string; name: string; identityPublicKey: string }): RegistrationBody => ({
      v: 1,
      uuid: m.uuid,
      name: m.name,
      identityPublicKey: m.identityPublicKey,
      serial: NOW,
      validFrom: NOW,
      validTo: NOW + 90 * 86_400,
      adminKeyId: keyId(adminPair.publicKey),
    });
    expect(canonicalize(built.registrations.candidate as unknown as Json)).toBe(canonicalize(coreSignRegistration(body(s.candidate), pkcs8) as unknown as Json));
    expect(canonicalize(built.registrations.adminMachine as unknown as Json)).toBe(canonicalize(coreSignRegistration(body(s.adminMachine), pkcs8) as unknown as Json));
  });

  it('the candidate and the admin machine share the pair secret V2 of machine-core (same on both bundles)', async () => {
    const s = await setup();
    const built = await buildApproval(s.input);
    const expected = derivePairSecretV2(s.adminPair.privateKeyPkcs8, { uuid: s.candidate.uuid, serial: NOW }, { uuid: s.adminMachine.uuid, serial: NOW });
    const inner = JSON.parse(text(openSealed(s.candidateIdentity.privateKeyPkcs8, built.approval.sealed, approvalSealContext(s.candidate.uuid, s.candidate.random)))) as {
      self: { sealedPairSecret: string };
      peers: Array<{ registration: { body: RegistrationBody }; sealedPairSecret: string }>;
    };
    const selfSecret = openSealed(s.candidateIdentity.privateKeyPkcs8, inner.self.sealedPairSecret, pairSecretContext({ adminUuid: s.adminMachine.uuid, candidateUuid: s.candidate.uuid, random: s.candidate.random, slot: 'self' }));
    expect(Buffer.from(selfSecret).toString('base64url')).toBe(expected);
    expect(inner.peers).toHaveLength(1);
    const peer = inner.peers[0]!;
    expect(peer.registration.body.uuid).toBe(s.adminMachine.uuid);
    const peerSecret = openSealed(s.candidateIdentity.privateKeyPkcs8, peer.sealedPairSecret, pairSecretContext({ adminUuid: s.adminMachine.uuid, candidateUuid: s.candidate.uuid, random: s.candidate.random, slot: `peer:${s.adminMachine.uuid}` }));
    expect(Buffer.from(peerSecret).toString('base64url')).toBe(expected);
  });
});

describe('buildApproval: the sealed approval', () => {
  it('is { v: 2, random, sealed } and its plaintext has the shape of machine-cli (v, self, admin, adminUuid, peers, random) with registrations verified by the admin public key', async () => {
    const s = await setup();
    const built = await buildApproval(s.input);
    expect(Object.keys(built.approval).sort()).toEqual(['random', 'sealed', 'v']);
    expect(built.approval.v).toBe(2);
    expect(built.approval.random).toBe(s.candidate.random);
    const inner = JSON.parse(text(openSealed(s.candidateIdentity.privateKeyPkcs8, built.approval.sealed, approvalSealContext(s.candidate.uuid, s.candidate.random)))) as Record<string, unknown> & {
      self: { registration: never };
      peers: Array<{ registration: never }>;
    };
    expect(Object.keys(inner).sort()).toEqual(['admin', 'adminUuid', 'peers', 'random', 'self', 'v']);
    expect(inner['admin']).toEqual({ v: 1, adminPublicKey: s.adminPair.publicKey, adminKeyId: keyId(s.adminPair.publicKey) });
    expect(inner['adminUuid']).toBe(s.adminMachine.uuid);
    expect(verifyRegistration(inner.self.registration, { adminPublicKey: s.adminPair.publicKey, now: NOW }).ok).toBe(true);
    expect(verifyRegistration(inner.peers[0]!.registration, { adminPublicKey: s.adminPair.publicKey, now: NOW }).ok).toBe(true);
    // The relay sees nothing of it.
    expect(JSON.stringify(built.approval)).not.toContain(s.adminPair.publicKey);
  });

  it('opens only for this candidate key, uuid and random', async () => {
    const s = await setup();
    const built = await buildApproval(s.input);
    expect(() => openSealed(generateSigningKeyPair().privateKeyPkcs8, built.approval.sealed, approvalSealContext(s.candidate.uuid, s.candidate.random))).toThrow();
    expect(() => openSealed(s.candidateIdentity.privateKeyPkcs8, built.approval.sealed, approvalSealContext(uuid(), s.candidate.random))).toThrow();
    expect(() => openSealed(s.candidateIdentity.privateKeyPkcs8, built.approval.sealed, approvalSealContext(s.candidate.uuid, newCandidacyRandom()))).toThrow();
  });

  it('the security code is the final code of machine-core for the three public values', async () => {
    const s = await setup();
    const built = await buildApproval(s.input);
    expect(built.finalCode).toBe(coreFinalCode(s.candidate.identityPublicKey, s.adminPair.publicKey, s.candidate.random));
  });

  it('two builds of the same input differ in the sealed text (fresh ephemeral keys) but carry the same registrations and secrets', async () => {
    const s = await setup();
    const a = await buildApproval(s.input);
    const b = await buildApproval(s.input);
    expect(a.approval.sealed).not.toBe(b.approval.sealed);
    expect(canonicalize(a.registrations.candidate as unknown as Json)).toBe(canonicalize(b.registrations.candidate as unknown as Json));
    expect(a.adminImport?.sealedPairSecret).not.toBe(b.adminImport?.sealedPairSecret);
  });
});

describe('buildApproval: what the admin machine imports', () => {
  it('carries the candidate registration and the pair secret sealed to the identity key of the ADMIN machine for the import context only', async () => {
    const s = await setup();
    const built = await buildApproval(s.input);
    const imp = built.adminImport;
    expect(imp).not.toBeNull();
    expect(imp!.registration).toEqual(built.registrations.candidate);
    const context = importCandidateSealContext(s.adminMachine.uuid, s.candidate.uuid, s.candidate.random);
    const secret = openSealed(s.adminMachineIdentity.privateKeyPkcs8, imp!.sealedPairSecret, context);
    expect(Buffer.from(secret).toString('base64url')).toBe(derivePairSecretV2(s.adminPair.privateKeyPkcs8, { uuid: s.candidate.uuid, serial: NOW }, { uuid: s.adminMachine.uuid, serial: NOW }));
    // Not the candidate, not another candidacy, not the approval context.
    expect(() => openSealed(s.candidateIdentity.privateKeyPkcs8, imp!.sealedPairSecret, context)).toThrow();
    expect(() => openSealed(s.adminMachineIdentity.privateKeyPkcs8, imp!.sealedPairSecret, importCandidateSealContext(s.adminMachine.uuid, s.candidate.uuid, newCandidacyRandom()))).toThrow();
    expect(JSON.stringify(imp)).not.toContain(Buffer.from(secret).toString('base64url'));
  });

  it('the approval of the first machine itself (candidate uuid = admin machine uuid): no peer, nothing to import, no pair secret with itself', async () => {
    const s = await setup();
    const self = { uuid: s.candidate.uuid, name: s.candidate.name, identityPublicKey: s.candidate.identityPublicKey };
    const built = await buildApproval({ ...s.input, adminMachine: self });
    expect(built.adminImport).toBeNull();
    expect(built.registrations.adminMachine).toBeUndefined();
    const inner = JSON.parse(text(openSealed(s.candidateIdentity.privateKeyPkcs8, built.approval.sealed, approvalSealContext(s.candidate.uuid, s.candidate.random)))) as { peers: unknown[]; adminUuid: string };
    expect(inner.peers).toEqual([]);
    expect(inner.adminUuid).toBe(s.candidate.uuid);
  });

  it('refuses a candidate that claims the uuid of the admin machine with another key or name (a squatter), nothing is signed', async () => {
    const s = await setup();
    await expect(buildApproval({ ...s.input, adminMachine: { uuid: s.candidate.uuid, name: s.candidate.name, identityPublicKey: generateSigningKeyPair().publicKey } })).rejects.toThrow(/claims the uuid of this machine.*another key or name.*Nothing was signed/s);
    await expect(buildApproval({ ...s.input, adminMachine: { uuid: s.candidate.uuid, name: 'other', identityPublicKey: s.candidate.identityPublicKey } })).rejects.toThrow(/claims the uuid of this machine/);
  });

  it('an admin machine without identity (null): no peer, adminUuid null, nothing to import', async () => {
    const s = await setup();
    const built = await buildApproval({ ...s.input, adminMachine: null });
    expect(built.adminImport).toBeNull();
    const inner = JSON.parse(text(openSealed(s.candidateIdentity.privateKeyPkcs8, built.approval.sealed, approvalSealContext(s.candidate.uuid, s.candidate.random)))) as { peers: unknown[]; adminUuid: unknown };
    expect(inner.adminUuid).toBeNull();
    expect(inner.peers).toEqual([]);
  });
});

describe('buildApproval: refusals name the cause and the fix', () => {
  it('a validity outside 1 to 3650 days', async () => {
    const s = await setup();
    for (const days of [0, 3651, 1.5, Number.NaN]) {
      await expect(buildApproval({ ...s.input, validForDays: days })).rejects.toThrow(/the validity must be 1 to 3650 days/);
    }
  });

  it('a candidate key that is not an Ed25519 public key, an invalid random, an invalid name or uuid', async () => {
    const s = await setup();
    await expect(buildApproval({ ...s.input, candidate: { ...s.candidate, identityPublicKey: 'nope' } })).rejects.toThrow(/identityPublicKey/);
    await expect(buildApproval({ ...s.input, candidate: { ...s.candidate, random: 'AAAA' } })).rejects.toThrow(/random/);
    await expect(buildApproval({ ...s.input, candidate: { ...s.candidate, name: 'bad name!' } })).rejects.toThrow(/name/);
    await expect(buildApproval({ ...s.input, candidate: { ...s.candidate, uuid: 'x' } })).rejects.toThrow(/uuid/);
  });

  it('an admin key id that is not the one of the admin public key', async () => {
    const s = await setup();
    await expect(buildApproval({ ...s.input, adminKeyId: '0'.repeat(32) })).rejects.toThrow(/admin key id.*does not match/s);
  });

  it('a locked or non-signing key', async () => {
    const s = await setup();
    const verifyOnly = await crypto.subtle.importKey('raw', Buffer.from(s.adminPair.publicKey, 'base64url') as BufferSource, 'Ed25519', true, ['verify']);
    await expect(buildApproval({ ...s.input, adminPrivateKey: verifyOnly })).rejects.toThrow();
  });
});

// Public key of an Ed25519 PKCS8 key, through machine-core.
function generateSigningKeyPairFromSeedPublic(pkcs8: Uint8Array): string {
  const jwk = createPublicKey(createPrivateKey({ key: Buffer.from(pkcs8), format: 'der', type: 'pkcs8' })).export({ format: 'jwk' });
  return jwk.x as string;
}
