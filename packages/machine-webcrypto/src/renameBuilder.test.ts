import {
  documentId as coreDocumentId,
  generateSigningKeyPair,
  keyId,
  registrationReplaces,
  signNoticeRecipients as coreSignNoticeRecipients,
  signRegistration as coreSignRegistration,
  verifyInboxDocument,
  verifyRegistration,
  type RegistrationBody,
  type SignedRegistration,
} from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { newPair, uuid, webKeyFrom } from '../test-support/kit.js';
import { buildRename, type BuildRenameInput } from './renameBuilder.js';

// Rename from the page (decision 114): the new registration and the documents that carry it, built in the browser with the unlocked key. Verified and opened here
// by the REAL machine-core code, with the identity key of each addressee, and against the ids machine-cli `distributeRename` derives.

const NOW = 1_800_000_000;

const machine = (name: string) => ({ uuid: uuid(), name, identity: generateSigningKeyPair() });

async function setup(peerCount = 2, overrides: Partial<BuildRenameInput> = {}) {
  const adminPair = newPair();
  const adminPrivateKey = await webKeyFrom(adminPair);
  const adminKeyId = keyId(adminPair.publicKey);
  const sign = (m: { uuid: string; name: string; identity: { publicKey: string } }, serial = NOW - 1000, validTo = NOW + 90 * 86_400): SignedRegistration => {
    const body: RegistrationBody = { v: 1, uuid: m.uuid, name: m.name, identityPublicKey: m.identity.publicKey, serial, validFrom: serial, validTo, adminKeyId };
    return coreSignRegistration(body, adminPair.privateKeyPkcs8);
  };
  const adminMachine = machine('desk');
  const subject = machine('thinkcentre');
  const others = Array.from({ length: peerCount }, (_, i) => machine(`peer-${i}`));
  const current = sign(subject, 7);
  const input: BuildRenameInput = {
    adminPrivateKey,
    adminPublicKey: adminPair.publicKey,
    adminUuid: adminMachine.uuid,
    current,
    newName: 'box',
    machines: [adminMachine, subject, ...others].map((m) => ({ uuid: m.uuid, name: m.name })),
    aliases: {},
    networkAliases: {},
    revokedUpTo: undefined,
    others: others.map((o) => sign(o)),
    noticeRecipients: null,
    now: NOW,
    ...overrides,
  };
  return { adminPair, adminKeyId, adminMachine, subject, others, input, sign, current };
}

const open = (adminPublicKey: string, to: { uuid: string; identity: { privateKeyPkcs8: Uint8Array } }, document: unknown) =>
  verifyInboxDocument(document, { adminPublicKey, selfUuid: to.uuid, now: NOW, identityPrivateKeyPkcs8: to.identity.privateKeyPkcs8 });

describe('buildRename: the registration', () => {
  it('is the registration of machine-core: same uuid and key, new name, serial + 1, same expiry, signed by the admin key', async () => {
    const s = await setup();
    const built = await buildRename(s.input);
    expect(verifyRegistration(built.signed, { adminPublicKey: s.adminPair.publicKey, now: NOW })).toMatchObject({ ok: true });
    expect(built.signed.body).toEqual({ ...s.current.body, name: 'box', serial: 8, validFrom: NOW });
    expect(registrationReplaces(s.current.body, built.signed.body)).toEqual({ ok: true, action: 'replace' });
    expect(built.newName).toBe('box');
    expect(built.normalized).toBe(false);
  });

  it('normalizes the typed name like the CLI and says so', async () => {
    const s = await setup();
    const built = await buildRename({ ...s.input, newName: 'My Box' });
    expect(built.newName).toBe('my-box');
    expect(built.normalized).toBe(true);
    expect(built.signed.body.name).toBe('my-box');
  });
});

describe('buildRename: the documents', () => {
  it('are, for each peer, the document about the renamed machine and the one about the peer, a list of notice recipients for everybody and the self-registration; all opened by their addressee with machine-core', async () => {
    const s = await setup(2);
    const built = await buildRename(s.input);
    expect(built.failures).toEqual([]);
    const byTo = (to: string) => built.documents.filter((d) => d.body.to === to);
    const renamed = built.signed;
    for (const other of s.others) {
      const toOther = byTo(other.uuid);
      expect(toOther.map((d) => d.body.kind).sort()).toEqual(['notice-recipients', 'peer']);
      const peer = toOther.find((d) => d.body.kind === 'peer');
      const opened = open(s.adminPair.publicKey, other, peer);
      expect(opened, JSON.stringify(opened)).toMatchObject({ ok: true, kind: 'peer' });
      // The peer learns the NEW registration of the renamed machine.
      expect((opened as { registration: RegistrationBody }).registration).toEqual(renamed.body);
      const otherReg = s.input.others.find((r) => r.body.uuid === other.uuid) as SignedRegistration;
      expect(peer?.body.id).toBe(coreDocumentId(`v2:peer:${other.uuid}:${otherReg.body.serial}:${s.subject.uuid}:${renamed.body.serial}`));
    }
    const toSubject = byTo(s.subject.uuid);
    expect(toSubject.map((d) => d.body.kind).sort()).toEqual(['notice-recipients', 'peer', 'peer', 'self-registration']);
    for (const d of toSubject) expect(open(s.adminPair.publicKey, s.subject, d), JSON.stringify(d.body)).toMatchObject({ ok: true });
    const self = toSubject.find((d) => d.body.kind === 'self-registration');
    expect(self?.body.id).toBe(coreDocumentId(`v2:self-registration:${s.subject.uuid}:${renamed.body.serial}`));
    expect(self?.body.issuedAt).toBe(renamed.body.validFrom);
    expect(self?.body.expiresAt).toBe(Math.min(renamed.body.validFrom + 30 * 86_400, renamed.body.validTo));
    expect(open(s.adminPair.publicKey, s.subject, self)).toMatchObject({ ok: true, kind: 'self-registration', registration: renamed.body });
    // Nothing for the admin machine: it installs the registration itself.
    expect(byTo(s.adminMachine.uuid)).toEqual([]);
  });

  it('with no other peer, the renamed machine still gets its self-registration and the list', async () => {
    const s = await setup(0);
    const built = await buildRename(s.input);
    expect(built.documents.map((d) => d.body.kind).sort()).toEqual(['notice-recipients', 'self-registration']);
  });

  it('signs the list of notice recipients when the admin machine has none, and reuses the stored one', async () => {
    const s = await setup(1);
    const fresh = await buildRename(s.input);
    expect(fresh.noticeRecipients?.body.recipients).toEqual([s.adminMachine.uuid]);
    const stored = coreSignNoticeRecipients({ v: 1, adminKeyId: s.adminKeyId, serial: NOW - 5, issuedAt: NOW - 5, recipients: [s.adminMachine.uuid] }, s.adminPair.privateKeyPkcs8);
    const reused = await buildRename({ ...s.input, noticeRecipients: stored as never });
    expect(reused.noticeRecipients).toBeNull();
  });

  it('reports a document that cannot be built as a failure of that machine, the others are built', async () => {
    // The registration of the first peer expires exactly now: no document for it can outlive now. The renamed machine and the other peer are still told.
    const s = await setup(2);
    const expired = s.sign(s.others[0] as (typeof s.others)[number], NOW - 1000, NOW);
    const built = await buildRename({ ...s.input, others: [expired, s.input.others[1] as SignedRegistration] });
    const failed = built.failures.filter((f) => f.toUuid === s.others[0]?.uuid);
    expect(failed.map((f) => f.kind)).toEqual(['peer']);
    expect(failed[0]?.message).toMatch(/machine admin approve|expired/);
    expect(built.documents.some((d) => d.body.kind === 'self-registration' && d.body.to === s.subject.uuid)).toBe(true);
    expect(built.documents.some((d) => d.body.to === s.others[1]?.uuid)).toBe(true);
  });
});

describe('buildRename refuses, naming the cause and the fix, before anything is signed', () => {
  it('the admin machine itself', async () => {
    const s = await setup();
    await expect(buildRename({ ...s.input, adminUuid: s.subject.uuid })).rejects.toThrow(/admin machine itself.*Nothing was signed/);
  });

  it.each([
    ['a name used by another machine', { newName: 'desk' }, /already used by machine "desk".*Nothing was signed/],
    ['a name that is not one', { newName: '!!!' }, /Nothing was signed/],
    ['the same name', { newName: 'thinkcentre' }, /already has the name "thinkcentre"/],
    ['a revoked machine', { revokedUpTo: 7 }, /revoked here.*Nothing was signed/],
    ['a network alias of another machine', { networkAliases: { box: '7a1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f' } }, /network alias of another machine.*Nothing was signed/],
  ])('%s', async (_name, change, message) => {
    const s = await setup();
    await expect(buildRename({ ...s.input, ...change } as BuildRenameInput)).rejects.toThrow(message);
  });

  it('a registration of the renamed machine that the unlocked key did not sign', async () => {
    const s = await setup();
    const stranger = newPair();
    const forged = coreSignRegistration(s.current.body, stranger.privateKeyPkcs8);
    await expect(buildRename({ ...s.input, current: forged })).rejects.toThrow(/not signed by the admin key that was unlocked.*Nothing was signed/);
  });

  it('a peer registration that the unlocked key did not sign', async () => {
    const s = await setup(1);
    const stranger = newPair();
    const forged = coreSignRegistration((s.input.others[0] as SignedRegistration).body, stranger.privateKeyPkcs8);
    await expect(buildRename({ ...s.input, others: [forged] })).rejects.toThrow(/not signed by the admin key that was unlocked/);
  });

  it('a list of peers that includes the renamed machine or the admin machine', async () => {
    const s = await setup(1);
    await expect(buildRename({ ...s.input, others: [s.current] })).rejects.toThrow(/include the new machine|include the renamed machine/);
    const adminReg = s.sign(s.adminMachine);
    await expect(buildRename({ ...s.input, others: [adminReg] })).rejects.toThrow(/include the admin machine/);
  });
});
