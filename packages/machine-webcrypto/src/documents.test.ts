import {
  MAX_DOCUMENT_BYTES,
  applyPolicy,
  assertPolicyBody,
  assertRegistrationBody,
  assertRevocationBody,
  buildDocument as coreBuildDocument,
  documentId as coreDocumentId,
  keyId as coreKeyId,
  pairSecretDocumentContext as corePairContext,
  signPolicy as coreSignPolicy,
  signRegistration as coreSignRegistration,
  signRevocation as coreSignRevocation,
  verifyInboxDocument as coreVerifyDocument,
  verifyRegistration,
  verifyRevocation,
  type DocumentInput,
  type PolicyBody,
  type RegistrationBody,
  type RevocationBody,
} from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { newPair, prng, uuid, webKeyFrom } from '../test-support/kit.js';
import {
  assertPolicyBody as webAssertPolicy,
  assertRegistrationBody as webAssertRegistration,
  assertRevocationBody as webAssertRevocation,
  buildDocument,
  documentId,
  pairSecretDocumentContext,
  signPolicy,
  signRegistration,
  signRevocation,
} from './documents.js';

const NOW = 1_800_000_000;

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return '';
}

async function setup() {
  const admin = newPair();
  return { admin, key: await webKeyFrom(admin), adminKeyId: coreKeyId(admin.publicKey) };
}

function registrationBody(adminKeyId: string, rand: () => number): RegistrationBody {
  return {
    v: 1,
    uuid: uuid(),
    name: `m${Math.floor(rand() * 1e6)}-x`,
    identityPublicKey: newPair().publicKey,
    serial: 1 + Math.floor(rand() * 50),
    validFrom: NOW - 10,
    validTo: NOW + 3600 + Math.floor(rand() * 1e6),
    adminKeyId,
  };
}

function policyBody(adminKeyId: string, target: string, rand: () => number): PolicyBody {
  const version = 1 + Math.floor(rand() * 20);
  return {
    v: 1,
    target,
    version,
    baseVersion: version - 1,
    adminKeyId,
    issuedAt: NOW,
    notBefore: NOW - 5,
    notAfter: NOW + 86400,
    defaults: [{ shell: 'sh', command: 'uptime' }],
    peers: { [uuid()]: [{ shell: 'bash', command: 'echo "a b" | wc -c', limits: { maxCalls: 1 + Math.floor(rand() * 5), expiresAt: NOW + 100 } }] },
  };
}

describe('registration, policy, revocation signing: verified by machine-core, byte-identical signatures', () => {
  it('100 random registrations', async () => {
    const s = await setup();
    const rand = prng(1);
    for (let i = 0; i < 100; i++) {
      const body = registrationBody(s.adminKeyId, rand);
      const web = await signRegistration(body, s.key);
      const verified = verifyRegistration(web, { adminPublicKey: s.admin.publicKey, now: NOW });
      expect(verified.ok, JSON.stringify(verified)).toBe(true);
      expect(web.signature).toBe(coreSignRegistration(body, s.admin.privateKeyPkcs8).signature);
    }
  });

  it('100 random policies', async () => {
    const s = await setup();
    const rand = prng(2);
    for (let i = 0; i < 100; i++) {
      const target = uuid();
      const body = policyBody(s.adminKeyId, target, rand);
      const web = await signPolicy(body, s.key);
      const applied = applyPolicy({ version: body.baseVersion, highestSeen: body.baseVersion }, web, { adminPublicKey: s.admin.publicKey, now: NOW, targetUuid: target });
      expect(applied.ok, JSON.stringify(applied)).toBe(true);
      expect(web.signature).toBe(coreSignPolicy(body, s.admin.privateKeyPkcs8).signature);
    }
  });

  it('100 random revocation lists (sorted by uuid, as machine-core demands)', async () => {
    const s = await setup();
    const rand = prng(3);
    for (let i = 0; i < 100; i++) {
      const entries = Array.from({ length: Math.floor(rand() * 6) }, () => ({ uuid: uuid(), serial: 1 + Math.floor(rand() * 9) })).sort((a, b) => (a.uuid < b.uuid ? -1 : 1));
      const body: RevocationBody = { v: 1, adminKeyId: s.adminKeyId, issuedAt: NOW, entries };
      const web = await signRevocation(body, s.key);
      expect(verifyRevocation(web, { adminPublicKey: s.admin.publicKey }).ok).toBe(true);
      expect(web.signature).toBe(coreSignRevocation(body, s.admin.privateKeyPkcs8).signature);
    }
  });

  it('refuses to sign a body machine-core refuses, with the same message', async () => {
    const s = await setup();
    const rand = prng(4);
    const good = registrationBody(s.adminKeyId, rand);
    const badRegistrations: unknown[] = [
      { ...good, extra: 1 },
      { ...good, uuid: 'nope' },
      { ...good, name: '-bad' },
      { ...good, identityPublicKey: 'AAAA' },
      { ...good, serial: 0 },
      { ...good, validTo: good.validFrom },
      { ...good, adminKeyId: 'ABC' },
      { ...good, v: 2 },
      null,
      [],
    ];
    for (const bad of badRegistrations) {
      const core = messageOf(() => assertRegistrationBody(bad));
      expect(core).not.toBe('');
      expect(messageOf(() => webAssertRegistration(bad))).toBe(core);
      await expect(signRegistration(bad as never, s.key)).rejects.toThrow(core);
    }
    const goodPolicy = policyBody(s.adminKeyId, uuid(), rand);
    const badPolicies: unknown[] = [
      { ...goodPolicy, version: goodPolicy.version + 1 },
      { ...goodPolicy, defaults: [{ shell: 'zsh', command: 'x' }] },
      { ...goodPolicy, defaults: [{ shell: 'sh', command: 'café' }] },
      { ...goodPolicy, defaults: [{ shell: 'sh', command: 'a' }, { shell: 'sh', command: 'a' }] },
      { ...goodPolicy, defaults: [{ shell: 'sh', command: 'a', limits: { maxCalls: 0 } }] },
      { ...goodPolicy, defaults: [{ shell: 'sh', command: 'a', limits: { color: 1 } }] },
      { ...goodPolicy, defaults: [{ shell: 'sh', command: 'a', limits: undefined }] },
      { ...goodPolicy, peers: { 'not-a-uuid': [] } },
      { ...goodPolicy, notAfter: goodPolicy.notBefore },
      { ...goodPolicy, defaults: Array.from({ length: 201 }, (_, i) => ({ shell: 'sh', command: `c${i}` })) },
      { ...goodPolicy, peers: Object.fromEntries(Array.from({ length: 65 }, () => [uuid(), []])) },
      { ...goodPolicy, target: 'x' },
    ];
    for (const bad of badPolicies) {
      const core = messageOf(() => assertPolicyBody(bad));
      expect(core, JSON.stringify(bad).slice(0, 80)).not.toBe('');
      expect(messageOf(() => webAssertPolicy(bad))).toBe(core);
      await expect(signPolicy(bad as never, s.key)).rejects.toThrow(core);
    }
    const a = uuid();
    const b = uuid();
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const goodRev = { v: 1, adminKeyId: s.adminKeyId, issuedAt: NOW, entries: [{ uuid: lo, serial: 1 }] };
    const badRevocations: unknown[] = [
      { ...goodRev, entries: [{ uuid: hi, serial: 1 }, { uuid: lo, serial: 1 }] },
      { ...goodRev, entries: [{ uuid: lo, serial: 1 }, { uuid: lo, serial: 2 }] },
      { ...goodRev, entries: [{ uuid: lo, serial: 0 }] },
      { ...goodRev, entries: [{ uuid: lo, serial: 1, extra: 1 }] },
      { ...goodRev, issuedAt: -1 },
      { ...goodRev, entries: 'x' },
      { ...goodRev, extra: 1 },
    ];
    for (const bad of badRevocations) {
      const core = messageOf(() => assertRevocationBody(bad));
      expect(core).not.toBe('');
      expect(messageOf(() => webAssertRevocation(bad))).toBe(core);
      await expect(signRevocation(bad as never, s.key)).rejects.toThrow(core);
    }
  });
});

describe('buildDocument (kinds peer, policy, revocation)', () => {
  it('documentId and pairSecretDocumentContext equal machine-core for 100 random strings', async () => {
    const rand = prng(5);
    for (let i = 0; i < 100; i++) {
      const text = `stable:${rand()}:é€`;
      expect(await documentId(text)).toBe(coreDocumentId(text));
    }
    const [x, y, z] = [uuid(), uuid(), uuid()];
    expect(pairSecretDocumentContext(x, y, z)).toBe(corePairContext(x, y, z));
    expect(pairSecretDocumentContext(null, y, z)).toBe(corePairContext(null, y, z));
  });

  it('a policy, a revocation and a peer document are accepted by machine-core verifyDocument, with the same signature as machine-core', async () => {
    const s = await setup();
    const rand = prng(6);
    const to = uuid();
    const inputs: DocumentInput[] = [];
    const policy = coreSignPolicy(policyBody(s.adminKeyId, to, rand), s.admin.privateKeyPkcs8);
    inputs.push({ kind: 'policy', to, id: coreDocumentId('p'), issuedAt: NOW, expiresAt: NOW + 1000, payload: policy as never });
    const revocation = coreSignRevocation({ v: 1, adminKeyId: s.adminKeyId, issuedAt: NOW, entries: [{ uuid: uuid(), serial: 2 }] }, s.admin.privateKeyPkcs8);
    inputs.push({ kind: 'revocation', to, id: coreDocumentId('r'), issuedAt: NOW, expiresAt: NOW + 1000, payload: revocation as never });
    const registration = coreSignRegistration(registrationBody(s.adminKeyId, rand), s.admin.privateKeyPkcs8);
    inputs.push({
      kind: 'peer',
      to,
      id: coreDocumentId('q'),
      issuedAt: NOW,
      expiresAt: NOW + 1000,
      payload: { registration, sealedPairSecret: 'AAAA', adminUuid: null } as never,
    });
    for (const input of inputs) {
      const web = await buildDocument(input, s.key);
      const verified = coreVerifyDocument(web, { adminPublicKey: s.admin.publicKey, selfUuid: to, now: NOW });
      // The peer document carries a placeholder seal, which verifyDocument does not open: shape only.
      expect(verified.ok, JSON.stringify(verified)).toBe(true);
      expect(web.signature).toBe(coreBuildDocument(input, s.admin.privateKeyPkcs8).signature);
    }
  });

  it('refuses what machine-core refuses (envelope and payload shapes, size) with the same message', async () => {
    const s = await setup();
    const rand = prng(8);
    const to = uuid();
    const policy = coreSignPolicy(policyBody(s.adminKeyId, to, rand), s.admin.privateKeyPkcs8);
    const base: DocumentInput = { kind: 'policy', to, id: coreDocumentId('p'), issuedAt: NOW, expiresAt: NOW + 1000, payload: policy as never };
    const bad: DocumentInput[] = [
      { ...base, kind: 'other' as never },
      { ...base, to: 'x' },
      { ...base, id: 'short' },
      { ...base, id: `${'A'.repeat(21)}B` },
      { ...base, issuedAt: 0 },
      { ...base, expiresAt: NOW },
      { ...base, expiresAt: NOW + 31 * 86_400 },
      { ...base, payload: { body: policy.body } as never },
      { ...base, kind: 'peer', payload: { registration: {}, sealedPairSecret: 'x', adminUuid: null } as never },
      { ...base, kind: 'peer', payload: { registration: policy, sealedPairSecret: '', adminUuid: null } as never },
      { ...base, kind: 'peer', payload: { registration: policy, sealedPairSecret: 'AAAA', adminUuid: 'x' } as never },
      { ...base, kind: 'revocation', payload: { signature: 1 } as never },
      { ...base, payload: { body: { ...policy.body, defaults: 'x' }, signature: policy.signature } as never },
    ];
    for (const input of bad) {
      const core = messageOf(() => coreBuildDocument(input, s.admin.privateKeyPkcs8));
      expect(core, JSON.stringify(input).slice(0, 100)).not.toBe('');
      await expect(buildDocument(input, s.key)).rejects.toThrow(core);
    }
    const huge: DocumentInput = { ...base, kind: 'revocation', payload: { body: { v: 1, adminKeyId: s.adminKeyId, issuedAt: NOW, entries: [] }, signature: 'x'.repeat(MAX_DOCUMENT_BYTES) } as never };
    const core = messageOf(() => coreBuildDocument(huge, s.admin.privateKeyPkcs8));
    expect(core).toMatch(/too large/);
    await expect(buildDocument(huge, s.key)).rejects.toThrow(core);
  });
});
