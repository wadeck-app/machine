import {
  MAX_DOCUMENT_BYTES,
  applyPolicy,
  assertPolicyBody,
  assertRegistrationBody,
  assertRevocationBody,
  DOCUMENT_DOMAIN_V2 as CORE_DOMAIN_V2,
  buildDocument as coreBuildDocument,
  documentId as coreDocumentId,
  documentSealContext as coreSealContext,
  keyId as coreKeyId,
  pairSecretDocumentContext as corePairContext,
  signPolicy as coreSignPolicy,
  signRegistration as coreSignRegistration,
  signNoticeRecipients as coreSignNoticeRecipients,
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
  DOCUMENT_DOMAIN_V2,
  buildDocument,
  documentId,
  documentSealContext,
  pairSecretDocumentContext,
  sealedPolicyDocument,
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
      // The generation of a renewal: a positive integer, version 2 only (the same refusals, the same messages).
      { ...goodPolicy, v: 2, defaults: [{ shell: 'sh', command: 'a', limits: { maxCalls: 1, renewals: 0 } }] },
      { ...goodPolicy, v: 2, defaults: [{ shell: 'sh', command: 'a', limits: { maxCalls: 1, renewals: 1.5 } }] },
      { ...goodPolicy, v: 1, defaults: [{ shell: 'sh', command: 'a', limits: { maxCalls: 1, renewals: 1 } }] },
      // Typed entries (policy version 2): the same refusals, the same messages.
      { ...goodPolicy, v: 3 },
      { ...goodPolicy, v: 2, defaults: [{ shell: 'sh', template: 'ls <n:int(5,1)>' }] },
      { ...goodPolicy, v: 2, defaults: [{ shell: 'sh', template: 'ls <n' }] },
      { ...goodPolicy, v: 2, defaults: [{ shell: 'sh', template: 'ls' }] },
      { ...goodPolicy, v: 2, defaults: [{ shell: 'sh', template: 'ls  <n:int(1,2)>' }] },
      { ...goodPolicy, v: 2, defaults: [{ shell: 'ps', template: 'ls @x <n:int(1,2)>' }] },
      { ...goodPolicy, v: 2, defaults: [{ shell: 'sh', template: 7 }] },
      { ...goodPolicy, v: 2, defaults: [{ shell: 'sh', command: 'ls', template: 'ls <n:int(1,2)>' }] },
      { ...goodPolicy, v: 2, defaults: [{ shell: 'sh' }] },
      { ...goodPolicy, v: 2, defaults: [{ shell: 'sh', command: 'ls <n:int(1,2)>' }] },
      { ...goodPolicy, v: 1, defaults: [{ shell: 'sh', command: 'ls <n:int(1,2)>' }] },
      { ...goodPolicy, v: 1, defaults: [{ shell: 'sh', template: 'ls <n:int(1,2)>' }] },
      { ...goodPolicy, v: 2, defaults: [{ shell: 'sh', template: 'x <a:int(1,5)>' }, { shell: 'sh', template: 'x <b:int(1,5)>' }] },
      { ...goodPolicy, v: 2, defaults: [{ shell: 'sh', template: 'x <a:port>' }, { shell: 'sh', template: 'x <a:int(1,65535)>' }] },
      { ...goodPolicy, defaults: Array.from({ length: 200 }, (_, i) => ({ shell: 'sh', command: `${i}-${'x'.repeat(2040)}` })), peers: { [uuid()]: Array.from({ length: 80 }, (_, i) => ({ shell: 'sh', command: `${i}-${'y'.repeat(2040)}` })) } },
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

  it('documentSealContext and the signature domain equal machine-core', async () => {
    const [x, y] = [uuid(), 'AAAAAAAAAAAAAAAAAAAAAA'];
    for (const kind of ['peer', 'policy', 'revocation', 'notice-recipients'] as const) expect(documentSealContext(kind, x, y)).toBe(coreSealContext(kind, x, y));
    expect(DOCUMENT_DOMAIN_V2).toBe(CORE_DOMAIN_V2);
  });

  it('a policy, a revocation and a peer document, built in the browser, are sealed and opened by machine-core verifyDocument with the key of the addressee', async () => {
    const s = await setup();
    const rand = prng(6);
    const to = uuid();
    const recipient = newPair();
    const inputs: DocumentInput[] = [];
    const policy = coreSignPolicy(policyBody(s.adminKeyId, to, rand), s.admin.privateKeyPkcs8);
    inputs.push({ kind: 'policy', to, id: coreDocumentId('p'), issuedAt: NOW, expiresAt: NOW + 1000, payload: policy as never, recipientIdentityPublicKey: recipient.publicKey });
    const revocation = coreSignRevocation({ v: 1, adminKeyId: s.adminKeyId, issuedAt: NOW, entries: [{ uuid: uuid(), serial: 2 }] }, s.admin.privateKeyPkcs8);
    inputs.push({ kind: 'revocation', to, id: coreDocumentId('r'), issuedAt: NOW, expiresAt: NOW + 1000, payload: revocation as never, recipientIdentityPublicKey: recipient.publicKey });
    const registration = coreSignRegistration(registrationBody(s.adminKeyId, rand), s.admin.privateKeyPkcs8);
    inputs.push({
      kind: 'peer',
      to,
      id: coreDocumentId('q'),
      issuedAt: NOW,
      expiresAt: NOW + 1000,
      payload: { registration, sealedPairSecret: 'AAAA', adminUuid: null } as never,
      recipientIdentityPublicKey: recipient.publicKey,
    });
    // The list of notice recipients (request-notices.md) is signed by the CLI; the page can only seal and sign the envelope of a stored one.
    const list = coreSignNoticeRecipients({ v: 1, adminKeyId: s.adminKeyId, serial: NOW, issuedAt: NOW, recipients: [uuid()] }, s.admin.privateKeyPkcs8);
    inputs.push({ kind: 'notice-recipients', to, id: coreDocumentId('n'), issuedAt: NOW, expiresAt: NOW + 1000, payload: list as never, recipientIdentityPublicKey: recipient.publicKey });
    for (const input of inputs) {
      const web = await buildDocument(input, s.key);
      expect(web.body.v).toBe(2);
      expect(Object.keys(web.body.payload)).toEqual(['sealed']);
      expect(JSON.stringify(web)).not.toContain('uptime');
      const ctx = { adminPublicKey: s.admin.publicKey, selfUuid: to, now: NOW };
      const verified = coreVerifyDocument(web, { ...ctx, identityPrivateKeyPkcs8: recipient.privateKeyPkcs8 });
      expect(verified.ok, JSON.stringify(verified)).toBe(true);
      // Another machine cannot open it.
      expect(coreVerifyDocument(web, { ...ctx, identityPrivateKeyPkcs8: newPair().privateKeyPkcs8 })).toMatchObject({ ok: false, reason: 'cannot-open' });
      // A document built by machine-core is read the same way: both builders speak one format.
      expect(coreVerifyDocument(coreBuildDocument(input, s.admin.privateKeyPkcs8), { ...ctx, identityPrivateKeyPkcs8: recipient.privateKeyPkcs8 }).ok).toBe(true);
    }
  });

  it('refuses an input without the key of the addressee: the page never builds a plaintext document', async () => {
    const s = await setup();
    const to = uuid();
    const policy = coreSignPolicy(policyBody(s.adminKeyId, to, prng(9)), s.admin.privateKeyPkcs8);
    const input = { kind: 'policy', to, id: coreDocumentId('p'), issuedAt: NOW, expiresAt: NOW + 1000, payload: policy } as unknown as DocumentInput;
    await expect(buildDocument(input, s.key)).rejects.toThrow(/recipientIdentityPublicKey is required/);
  });

  describe('sealedPolicyDocument (the inbox document of a policy the page signed)', () => {
    it('is a version 2 document with the id rule of machine-cli distributePolicy, opened by machine-core with the key of the target', async () => {
      const s = await setup();
      const to = uuid();
      const target = newPair();
      const policy = coreSignPolicy(policyBody(s.adminKeyId, to, prng(11)), s.admin.privateKeyPkcs8);
      const doc = await sealedPolicyDocument(policy, NOW, s.key, target.publicKey);
      expect(doc.body.id).toBe(coreDocumentId(`v2:policy:${to}:${policy.body.version}:${policy.signature}`));
      expect(doc.body.expiresAt).toBe(Math.min(policy.body.issuedAt + 30 * 86_400, policy.body.notAfter));
      const verified = coreVerifyDocument(doc, { adminPublicKey: s.admin.publicKey, selfUuid: to, now: NOW, identityPrivateKeyPkcs8: target.privateKeyPkcs8 });
      expect(verified.ok).toBe(true);
      if (verified.ok && verified.kind === 'policy') {
        expect(verified.policy).toEqual(policy);
      }
      expect(JSON.stringify(doc)).not.toContain('uptime');
    });

    it('refuses a policy that can no longer be applied, and a call without the key of the target', async () => {
      const s = await setup();
      const to = uuid();
      const policy = coreSignPolicy(policyBody(s.adminKeyId, to, prng(12)), s.admin.privateKeyPkcs8);
      await expect(sealedPolicyDocument(policy, policy.body.notAfter + 1, s.key, newPair().publicKey)).rejects.toThrow(/sign it again/);
      await expect(sealedPolicyDocument(policy, NOW, s.key, undefined as never)).rejects.toThrow(/recipientIdentityPublicKey is required/);
    });
  });

  it('refuses what machine-core refuses (envelope and payload shapes, size) with the same message', async () => {
    const s = await setup();
    const rand = prng(8);
    const to = uuid();
    const policy = coreSignPolicy(policyBody(s.adminKeyId, to, rand), s.admin.privateKeyPkcs8);
    const base: DocumentInput = { kind: 'policy', to, id: coreDocumentId('p'), issuedAt: NOW, expiresAt: NOW + 1000, payload: policy as never, recipientIdentityPublicKey: newPair().publicKey };
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

describe('typed entries and lifetimes (policy version 2): accepted and signed like machine-core', () => {
  it('signs a v2 policy with typed and exact entries and limits, byte-identical to machine-core, and the target applies it', async () => {
    const s = await setup();
    const target = uuid();
    const rand = prng(21);
    const body = policyBody(s.adminKeyId, target, rand);
    const typed: PolicyBody = {
      ...body,
      v: 2,
      defaults: [
        { shell: 'sh', command: 'uptime' },
        { shell: 'sh', template: 'orch logs <job:name> --tail <n:int(1,500)>', limits: { maxCalls: 5 } },
        { shell: 'sh', template: 'journalctl -u <u:enum(ssh.service|machine.service)> --lines=<n:int(1,500)> --no-pager', limits: { expiresAt: NOW + 3600 } },
      ],
    };
    const web = await signPolicy(typed, s.key);
    expect(web.signature).toBe(coreSignPolicy(typed, s.admin.privateKeyPkcs8).signature);
    const applied = applyPolicy({ version: typed.baseVersion, highestSeen: typed.baseVersion }, web, { adminPublicKey: s.admin.publicKey, now: NOW, targetUuid: target });
    expect(applied.ok, JSON.stringify(applied)).toBe(true);
  });
});
