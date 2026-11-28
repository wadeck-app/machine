import {
  documentId as coreDocumentId,
  generateSigningKeyPair,
  keyId,
  signNoticeRecipients as coreSignNoticeRecipients,
  signRegistration as coreSignRegistration,
  verifyInboxDocument,
  verifyRevocation,
  type RegistrationBody,
  type SignedRegistration,
} from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { newPair, uuid, webKeyFrom } from '../test-support/kit.js';
import { buildRevocation, type BuildRevocationInput } from './revocationBuilder.js';

// Revoke from the page (admin-ui.md, "Revoke from the page"): the revocation list and the documents that carry it to the other peers, built in the browser with
// the unlocked key. Verified and opened here by the REAL machine-core code, with the identity key of each addressee.

const NOW = 1_800_000_000;

const machine = (name: string) => ({ uuid: uuid(), name, identity: generateSigningKeyPair() });

async function setup(peerCount = 2, overrides: Partial<BuildRevocationInput> = {}) {
  const adminPair = newPair();
  const adminPrivateKey = await webKeyFrom(adminPair);
  const adminKeyId = keyId(adminPair.publicKey);
  const sign = (m: { uuid: string; name: string; identity: { publicKey: string } }, serial = NOW - 1000): SignedRegistration => {
    const body: RegistrationBody = { v: 1, uuid: m.uuid, name: m.name, identityPublicKey: m.identity.publicKey, serial, validFrom: serial, validTo: NOW + 90 * 86_400, adminKeyId };
    return coreSignRegistration(body, adminPair.privateKeyPkcs8);
  };
  const adminMachine = machine('desk');
  const revoked = machine('laptop');
  const others = Array.from({ length: peerCount }, (_, i) => machine(`peer-${i}`));
  const input: BuildRevocationInput = {
    adminPrivateKey,
    adminPublicKey: adminPair.publicKey,
    adminUuid: adminMachine.uuid,
    revoked: { uuid: revoked.uuid, serial: NOW - 500 },
    held: { entries: [], version: 0 },
    recipients: others.map((o) => sign(o)),
    noticeRecipients: null,
    now: NOW,
    ...overrides,
  };
  return { adminPair, adminKeyId, adminMachine, revoked, others, input, sign };
}

const open = (adminPublicKey: string, to: { uuid: string; identity: { privateKeyPkcs8: Uint8Array } }, document: unknown) =>
  verifyInboxDocument(document, { adminPublicKey, selfUuid: to.uuid, now: NOW, identityPrivateKeyPkcs8: to.identity.privateKeyPkcs8 });

describe('buildRevocation: the signed list', () => {
  it('is the union of what is held and the revoked machine, dated above the held version, verified by machine-core against the admin key', async () => {
    const earlier = { uuid: uuid(), serial: 3 };
    const s = await setup(1, {});
    const built = await buildRevocation({ ...s.input, held: { entries: [earlier], version: NOW + 50 } });
    expect(verifyRevocation(built.signed, { adminPublicKey: s.adminPair.publicKey })).toMatchObject({ ok: true });
    expect(built.signed.body.adminKeyId).toBe(s.adminKeyId);
    expect(built.signed.body.issuedAt).toBe(NOW + 51);
    expect(built.signed.body.entries).toEqual([earlier, { uuid: s.revoked.uuid, serial: NOW - 500 }].sort((a, b) => (a.uuid < b.uuid ? -1 : 1)));
  });

  it('is dated now when nothing newer is held, and keeps the highest serial of a machine already listed', async () => {
    const s = await setup(1);
    const built = await buildRevocation({ ...s.input, held: { entries: [{ uuid: s.revoked.uuid, serial: NOW + 7 }], version: 10 } });
    expect(built.signed.body.issuedAt).toBe(NOW);
    expect(built.signed.body.entries).toEqual([{ uuid: s.revoked.uuid, serial: NOW + 7 }]);
  });
});

describe('buildRevocation: the documents', () => {
  it('one revocation document per recipient, sealed to its identity key, carrying the signed list, with the id and dates of machine-cli distributeRevocation', async () => {
    const s = await setup(2);
    const built = await buildRevocation(s.input);
    expect(built.failures).toEqual([]);
    const docs = built.documents.filter((d) => d.body.kind === 'revocation');
    expect(docs.map((d) => d.body.to).sort()).toEqual(s.others.map((o) => o.uuid).sort());
    for (const other of s.others) {
      const doc = docs.find((d) => d.body.to === other.uuid)!;
      const opened = open(s.adminPair.publicKey, other, doc);
      if (!opened.ok || opened.kind !== 'revocation') throw new Error(`not a revocation document: ${JSON.stringify(opened)}`);
      expect(opened.revocation).toEqual(built.signed);
      expect(doc.body.id).toBe(coreDocumentId(`v2:revocation:${other.uuid}:${built.signed.signature}`));
      expect(doc.body.issuedAt).toBe(built.signed.body.issuedAt);
      expect(doc.body.expiresAt).toBe(built.signed.body.issuedAt + 30 * 86_400);
    }
  });

  it('with no stored list of notice recipients signs [admin machine], returns it for the daemon to keep, and seals it to every recipient', async () => {
    const s = await setup(2);
    const built = await buildRevocation(s.input);
    expect(built.noticeRecipients?.body.recipients).toEqual([s.adminMachine.uuid]);
    const lists = built.documents.filter((d) => d.body.kind === 'notice-recipients');
    expect(lists.map((d) => d.body.to).sort()).toEqual(s.others.map((o) => o.uuid).sort());
    for (const other of s.others) {
      expect(open(s.adminPair.publicKey, other, lists.find((d) => d.body.to === other.uuid))).toMatchObject({ ok: true, kind: 'notice-recipients' });
    }
  });

  it('a stored list is reused as it is and not returned as new', async () => {
    const s = await setup(1);
    const stored = coreSignNoticeRecipients({ v: 1, adminKeyId: s.adminKeyId, serial: 5, issuedAt: 5, recipients: [s.others[0]!.uuid] }, s.adminPair.privateKeyPkcs8);
    const built = await buildRevocation({ ...s.input, noticeRecipients: stored as never });
    expect(built.noticeRecipients).toBeNull();
    const opened = open(s.adminPair.publicKey, s.others[0]!, built.documents.find((d) => d.body.kind === 'notice-recipients'));
    if (!opened.ok || opened.kind !== 'notice-recipients') throw new Error('not a list');
    expect(opened.noticeRecipients).toEqual(stored);
  });

  it('with no other peer there is a signed list and no document', async () => {
    const s = await setup(0);
    const built = await buildRevocation(s.input);
    expect(built.signed.body.entries).toHaveLength(1);
    expect(built.documents).toEqual([]);
    expect(built.failures).toEqual([]);
  });
});

describe('buildRevocation: refusals, loud, before anything is signed', () => {
  it('a registration of a peer that the admin key did not sign (a hostile backend)', async () => {
    const s = await setup(1);
    const forged = { ...s.input.recipients[0]!, body: { ...s.input.recipients[0]!.body, identityPublicKey: generateSigningKeyPair().publicKey } };
    await expect(buildRevocation({ ...s.input, recipients: [forged] })).rejects.toThrow(/peer-0.*not signed by the admin key.*Nothing was signed/s);
  });

  it('the revoked machine or the admin machine among the peers to inform', async () => {
    const s = await setup(1);
    await expect(buildRevocation({ ...s.input, recipients: [s.sign(s.revoked)] })).rejects.toThrow(/revoked machine.*Nothing was signed/s);
    await expect(buildRevocation({ ...s.input, recipients: [s.sign(s.adminMachine)] })).rejects.toThrow(/admin machine.*Nothing was signed/s);
  });

  it('the admin machine revoking itself, and a serial that is not a positive integer', async () => {
    const s = await setup(1);
    await expect(buildRevocation({ ...s.input, revoked: { uuid: s.adminMachine.uuid, serial: 1 } })).rejects.toThrow(/admin machine itself.*Nothing was signed/s);
    await expect(buildRevocation({ ...s.input, revoked: { uuid: s.revoked.uuid, serial: 0 } })).rejects.toThrow(/serial/);
  });

  it('a locked key', async () => {
    const s = await setup(1);
    const { markLocked } = await import('./signed.js');
    markLocked(s.input.adminPrivateKey);
    await expect(buildRevocation(s.input)).rejects.toThrow(/locked/);
  });
});
