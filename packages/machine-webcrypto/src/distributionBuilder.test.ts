import {
  derivePairSecretV2,
  documentId as coreDocumentId,
  generateSigningKeyPair,
  keyId,
  openSealed,
  pairSecretDocumentContext,
  signNoticeRecipients as coreSignNoticeRecipients,
  signRegistration as coreSignRegistration,
  verifyInboxDocument,
  type RegistrationBody,
  type SignedRegistration,
} from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { newPair, uuid, webKeyFrom } from '../test-support/kit.js';
import { buildDistribution, type BuildDistributionInput } from './distributionBuilder.js';

// Approve from the page, lot 5 (admin-ui.md): the documents that tell the other peers about the new machine, built in the browser. Opened here by the REAL
// machine-core receiver code (`verifyDocument`), with the identity key of each addressee.

const NOW = 1_800_000_000;

function machine(name: string) {
  const identity = generateSigningKeyPair();
  return { uuid: uuid(), name, identity };
}

async function setup(peerCount = 2, overrides: Partial<BuildDistributionInput> = {}) {
  const adminPair = newPair();
  const adminPrivateKey = await webKeyFrom(adminPair);
  const adminKeyId = keyId(adminPair.publicKey);
  const sign = (m: { uuid: string; name: string; identity: { publicKey: string } }, serial = NOW - 1000, validTo = NOW + 90 * 86_400): SignedRegistration => {
    const body: RegistrationBody = { v: 1, uuid: m.uuid, name: m.name, identityPublicKey: m.identity.publicKey, serial, validFrom: serial, validTo, adminKeyId };
    return coreSignRegistration(body, adminPair.privateKeyPkcs8);
  };
  const adminMachine = machine('desk');
  const subject = machine('laptop');
  const others = Array.from({ length: peerCount }, (_, i) => machine(`peer-${i}`));
  const input: BuildDistributionInput = {
    adminPrivateKey,
    adminPublicKey: adminPair.publicKey,
    adminUuid: adminMachine.uuid,
    subject: sign(subject, NOW),
    others: others.map((o) => sign(o)),
    noticeRecipients: null,
    now: NOW,
    ...overrides,
  };
  return { adminPair, adminMachine, subject, others, input, sign };
}

const open = (adminPublicKey: string, to: { uuid: string; identity: { privateKeyPkcs8: Uint8Array } }, document: unknown) =>
  verifyInboxDocument(document, { adminPublicKey, selfUuid: to.uuid, now: NOW, identityPrivateKeyPkcs8: to.identity.privateKeyPkcs8 });

describe('buildDistribution', () => {
  it('builds, per other peer, one peer document about the new machine for it and one about it for the new machine, all opened by machine-core', async () => {
    const s = await setup(2);
    const built = await buildDistribution(s.input);
    expect(built.failures).toEqual([]);
    const peerDocs = built.documents.filter((d) => d.body.kind === 'peer');
    expect(peerDocs).toHaveLength(4);
    for (const other of s.others) {
      const toOther = peerDocs.find((d) => d.body.to === other.uuid)!;
      const opened = open(s.adminPair.publicKey, other, toOther);
      expect(opened).toMatchObject({ ok: true, kind: 'peer' });
      if (!opened.ok || opened.kind !== 'peer') throw new Error('not a peer document');
      expect(opened.registration.uuid).toBe(s.subject.uuid);
      expect(opened.adminUuid).toBe(s.adminMachine.uuid);
      // The pair secret is the V2 secret of machine-core for the two machines and serials, and the same one is sealed to both sides.
      const expected = derivePairSecretV2(s.adminPair.privateKeyPkcs8, { uuid: s.subject.uuid, serial: NOW }, { uuid: other.uuid, serial: NOW - 1000 });
      const secret = openSealed(other.identity.privateKeyPkcs8, opened.sealedPairSecret, pairSecretDocumentContext(s.adminMachine.uuid, other.uuid, s.subject.uuid));
      expect(Buffer.from(secret).toString('base64url')).toBe(expected);

      const toSubject = peerDocs.find((d) => d.body.to === s.subject.uuid && (open(s.adminPair.publicKey, s.subject, d) as { registration?: { uuid: string } }).registration?.uuid === other.uuid)!;
      const opened2 = open(s.adminPair.publicKey, s.subject, toSubject);
      if (!opened2.ok || opened2.kind !== 'peer') throw new Error('not a peer document');
      const secret2 = openSealed(s.subject.identity.privateKeyPkcs8, opened2.sealedPairSecret, pairSecretDocumentContext(s.adminMachine.uuid, s.subject.uuid, other.uuid));
      expect(Buffer.from(secret2).toString('base64url')).toBe(expected);
    }
  });

  it('document ids and dates follow the rule of machine-cli distribute.ts peerDocument', async () => {
    const s = await setup(1);
    const built = await buildDistribution(s.input);
    const other = s.others[0]!;
    const toOther = built.documents.find((d) => d.body.kind === 'peer' && d.body.to === other.uuid)!;
    expect(toOther.body.id).toBe(coreDocumentId(`v2:peer:${other.uuid}:${NOW - 1000}:${s.subject.uuid}:${NOW}`));
    expect(toOther.body.issuedAt).toBe(NOW);
    expect(toOther.body.expiresAt).toBe(NOW + 30 * 86_400);
    const toSubject = built.documents.find((d) => d.body.kind === 'peer' && d.body.to === s.subject.uuid)!;
    expect(toSubject.body.id).toBe(coreDocumentId(`v2:peer:${s.subject.uuid}:${NOW}:${other.uuid}:${NOW - 1000}`));
  });

  it('with no stored list signs [admin machine], returns it for the daemon to keep, and sends it sealed to the new machine and every other peer (never to the admin machine)', async () => {
    const s = await setup(2);
    const built = await buildDistribution(s.input);
    expect(built.noticeRecipients).not.toBeNull();
    expect(built.noticeRecipients!.body.recipients).toEqual([s.adminMachine.uuid]);
    expect(built.noticeRecipients!.body.serial).toBe(NOW);
    const lists = built.documents.filter((d) => d.body.kind === 'notice-recipients');
    expect(lists.map((d) => d.body.to).sort()).toEqual([s.subject.uuid, ...s.others.map((o) => o.uuid)].sort());
    for (const target of [s.subject, ...s.others]) {
      const doc = lists.find((d) => d.body.to === target.uuid)!;
      const opened = open(s.adminPair.publicKey, target, doc);
      expect(opened).toMatchObject({ ok: true, kind: 'notice-recipients' });
      expect(doc.body.id).toBe(coreDocumentId(`v2:notice-recipients:${target.uuid}:${NOW}:${built.noticeRecipients!.signature}`));
    }
  });

  it('a stored list is reused as it is (a second admin machine never overrides the first) and is not returned as new', async () => {
    const s = await setup(1);
    const stored = coreSignNoticeRecipients({ v: 1, adminKeyId: keyId(s.adminPair.publicKey), serial: 5, issuedAt: 5, recipients: [s.others[0]!.uuid] }, s.adminPair.privateKeyPkcs8);
    const built = await buildDistribution({ ...s.input, noticeRecipients: stored as never });
    expect(built.noticeRecipients).toBeNull();
    const doc = built.documents.find((d) => d.body.kind === 'notice-recipients' && d.body.to === s.subject.uuid)!;
    const opened = open(s.adminPair.publicKey, s.subject, doc);
    if (!opened.ok || opened.kind !== 'notice-recipients') throw new Error('not a list');
    expect(opened.noticeRecipients).toEqual(stored);
  });

  it('refuses loudly a registration of another peer that is not signed by the admin key (a hostile backend cannot make the page seal to its own key)', async () => {
    const s = await setup(1);
    const forged = { ...s.input.others[0]!, body: { ...s.input.others[0]!.body, identityPublicKey: generateSigningKeyPair().publicKey } };
    await expect(buildDistribution({ ...s.input, others: [forged] })).rejects.toThrow(/peer-0.*not signed by the admin key.*Nothing was signed/s);
  });

  it('refuses a list of peers that contains the new machine or the admin machine', async () => {
    const s = await setup(1);
    await expect(buildDistribution({ ...s.input, others: [s.input.subject] })).rejects.toThrow(/new machine/);
    const adminReg = s.sign(s.adminMachine);
    await expect(buildDistribution({ ...s.input, others: [adminReg] })).rejects.toThrow(/admin machine/);
  });

  it('a peer whose registration is too old for a document is a failure of that peer only, named, the others are still built', async () => {
    const s = await setup(2);
    const old = s.sign(s.others[0]!, NOW - 40 * 86_400, NOW - 1);
    const built = await buildDistribution({ ...s.input, others: [old, s.input.others[1]!] });
    expect(built.failures.map((f) => f.toUuid).sort()).toEqual([s.others[0]!.uuid, s.subject.uuid].sort());
    expect(built.failures[0]!.message).toMatch(/approve the machine again|older than the 30 days|expired/);
    expect(built.documents.some((d) => d.body.kind === 'peer' && d.body.to === s.others[1]!.uuid)).toBe(true);
  });

  it('refuses a locked key', async () => {
    const s = await setup(1);
    const { markLocked } = await import('./signed.js');
    markLocked(s.input.adminPrivateKey);
    await expect(buildDistribution(s.input)).rejects.toThrow(/locked/);
  });

  it('with no other peer builds nothing but still no failure', async () => {
    const s = await setup(0);
    const built = await buildDistribution(s.input);
    expect(built.failures).toEqual([]);
    expect(built.documents.filter((d) => d.body.kind === 'peer')).toHaveLength(0);
  });
});
