import {
  compareAliases,
  documentId as coreDocumentId,
  generateSigningKeyPair,
  keyId,
  signAliases as coreSignAliases,
  signRegistration as coreSignRegistration,
  verifyAliases,
  verifyInboxDocument,
  type AliasEntry,
  type RegistrationBody,
  type SignedRegistration,
} from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { newPair, uuid, webKeyFrom } from '../test-support/kit.js';
import { buildAliases, type BuildAliasesInput } from './aliasesBuilder.js';

// Network aliases from the page (decision 116): the signed list and the documents that carry it, built in the browser with the unlocked key. Verified and opened
// here by the REAL machine-core code, against the ids machine-cli `distributeAliases` derives and the serial rule of `signAliasesFor`.

const NOW = 1_800_000_000;

const machine = (name: string) => ({ uuid: uuid(), name, identity: generateSigningKeyPair() });

async function setup(peerCount = 2, overrides: Partial<BuildAliasesInput> = {}) {
  const adminPair = newPair();
  const adminPrivateKey = await webKeyFrom(adminPair);
  const adminKeyId = keyId(adminPair.publicKey);
  const sign = (m: { uuid: string; name: string; identity: { publicKey: string } }): SignedRegistration => {
    const body: RegistrationBody = { v: 1, uuid: m.uuid, name: m.name, identityPublicKey: m.identity.publicKey, serial: NOW - 1000, validFrom: NOW - 1000, validTo: NOW + 90 * 86_400, adminKeyId };
    return coreSignRegistration(body, adminPair.privateKeyPkcs8);
  };
  const adminMachine = machine('desk');
  const peers = Array.from({ length: peerCount }, (_, i) => machine(`peer-${i}`));
  const input: BuildAliasesInput = {
    adminPrivateKey,
    adminPublicKey: adminPair.publicKey,
    adminUuid: adminMachine.uuid,
    change: { action: 'set', alias: 'box', uuid: peers[0]?.uuid ?? adminMachine.uuid },
    current: null,
    machines: [adminMachine, ...peers].map((m) => ({ uuid: m.uuid, name: m.name })),
    revoked: [],
    recipients: peers.map(sign),
    now: NOW,
    ...overrides,
  };
  return { adminPair, adminKeyId, adminMachine, peers, input, sign };
}

const open = (adminPublicKey: string, to: { uuid: string; identity: { privateKeyPkcs8: Uint8Array } }, document: unknown) =>
  verifyInboxDocument(document, { adminPublicKey, selfUuid: to.uuid, now: NOW, identityPrivateKeyPkcs8: to.identity.privateKeyPkcs8 });

describe('buildAliases: the signed list', () => {
  it('a first alias: serial = now, issued now, verified by machine-core against the admin key', async () => {
    const s = await setup();
    const built = await buildAliases(s.input);
    expect(verifyAliases(built.signed, { adminPublicKey: s.adminPair.publicKey })).toMatchObject({ ok: true });
    expect(built.signed.body).toEqual({ v: 1, adminKeyId: s.adminKeyId, serial: NOW, issuedAt: NOW, entries: [{ alias: 'box', uuid: s.peers[0]?.uuid }] });
    expect(built.alias).toBe('box');
    expect(built.normalized).toBe(false);
    expect(built.entries).toEqual(built.signed.body.entries);
  });

  it('is dated above the stored serial when that one is later than now, and replaces it (compareAliases)', async () => {
    const s = await setup();
    const stored = coreSignAliases({ v: 1, adminKeyId: s.adminKeyId, serial: NOW + 50, issuedAt: NOW, entries: [{ alias: 'laptop', uuid: s.peers[1]?.uuid as string }] }, s.adminPair.privateKeyPkcs8);
    const built = await buildAliases({ ...s.input, current: stored });
    expect(built.signed.body.serial).toBe(NOW + 51);
    expect(built.signed.body.issuedAt).toBe(NOW);
    expect(built.signed.body.entries.map((e: AliasEntry) => e.alias)).toEqual(['box', 'laptop']);
    expect(compareAliases(stored, built.signed)).toBe('newer');
  });

  it('removes an alias, and an empty list is a valid list', async () => {
    const s = await setup();
    const stored = coreSignAliases({ v: 1, adminKeyId: s.adminKeyId, serial: NOW - 10, issuedAt: NOW - 10, entries: [{ alias: 'box', uuid: s.peers[0]?.uuid as string }] }, s.adminPair.privateKeyPkcs8);
    const built = await buildAliases({ ...s.input, current: stored, change: { action: 'rm', alias: 'box' } });
    expect(built.signed.body.entries).toEqual([]);
    expect(verifyAliases(built.signed, { adminPublicKey: s.adminPair.publicKey })).toMatchObject({ ok: true });
  });

  it('normalizes the typed alias and says so', async () => {
    const s = await setup();
    const built = await buildAliases({ ...s.input, change: { action: 'set', alias: 'My Box', uuid: s.peers[0]?.uuid as string } });
    expect(built.alias).toBe('my-box');
    expect(built.normalized).toBe(true);
  });
});

describe('buildAliases: the documents', () => {
  it('are one per peer (never the admin machine), with the id and the dates of distributeAliases, opened by their addressee with machine-core', async () => {
    const s = await setup(3);
    const built = await buildAliases(s.input);
    expect(built.failures).toEqual([]);
    expect(built.documents.map((d) => d.body.to).sort()).toEqual(s.peers.map((p) => p.uuid).sort());
    for (const peer of s.peers) {
      const d = built.documents.find((x) => x.body.to === peer.uuid);
      expect(d?.body.kind).toBe('aliases');
      expect(d?.body.id).toBe(coreDocumentId(`v2:aliases:${peer.uuid}:${built.signed.body.serial}:${built.signed.signature}`));
      expect(d?.body.issuedAt).toBe(NOW);
      expect(d?.body.expiresAt).toBe(NOW + 30 * 86_400);
      expect(open(s.adminPair.publicKey, peer, d)).toMatchObject({ ok: true, kind: 'aliases', aliases: built.signed });
    }
  });

  it('there is nobody to tell when this machine has no peer: the list is signed, no document', async () => {
    const s = await setup(0);
    const built = await buildAliases(s.input);
    expect(built.documents).toEqual([]);
  });
});

describe('buildAliases refuses, naming the cause and the fix, before anything is signed', () => {
  it.each([
    ['an alias that is the name of a machine', { change: { action: 'set', alias: 'peer-1', uuid: 'PEER0' } }, /already the name of machine "peer-1".*Nothing was signed/],
    ['an alias that has no letter or digit', { change: { action: 'set', alias: '!!!', uuid: 'PEER0' } }, /no letter or digit.*Nothing was signed/],
    ['a machine that is not trusted', { change: { action: 'set', alias: 'box', uuid: '7a1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f' } }, /not a trusted machine.*Nothing was signed/],
    ['a revoked machine', { revoked: ['PEER0'], change: { action: 'set', alias: 'box', uuid: 'PEER0' } }, /revoked here.*Nothing was signed/],
    ['removing an alias that does not exist', { change: { action: 'rm', alias: 'nope' } }, /no network alias "nope".*Nothing was signed/],
  ])('%s', async (_name, change, message) => {
    const s = await setup();
    const peer0 = s.peers[0]?.uuid as string;
    const patched = JSON.parse(JSON.stringify(change).replaceAll('PEER0', peer0)) as Partial<BuildAliasesInput>;
    await expect(buildAliases({ ...s.input, ...patched })).rejects.toThrow(message);
  });

  it('an alias that already points to that machine: nothing to sign', async () => {
    const s = await setup();
    const stored = coreSignAliases({ v: 1, adminKeyId: s.adminKeyId, serial: NOW - 10, issuedAt: NOW - 10, entries: [{ alias: 'box', uuid: s.peers[0]?.uuid as string }] }, s.adminPair.privateKeyPkcs8);
    await expect(buildAliases({ ...s.input, current: stored })).rejects.toThrow(/already points to.*nothing to sign/);
  });

  it('a stored list or a peer registration that the unlocked key did not sign', async () => {
    const s = await setup(1);
    const stranger = newPair();
    const list = coreSignAliases({ v: 1, adminKeyId: keyId(stranger.publicKey), serial: NOW - 10, issuedAt: NOW - 10, entries: [] }, stranger.privateKeyPkcs8);
    await expect(buildAliases({ ...s.input, current: list })).rejects.toThrow(/stored list of network aliases.*not signed by the admin key that was unlocked.*Nothing was signed/);
    const forged = coreSignRegistration((s.input.recipients[0] as SignedRegistration).body, stranger.privateKeyPkcs8);
    await expect(buildAliases({ ...s.input, recipients: [forged] })).rejects.toThrow(/registration of "peer-0".*not signed by the admin key that was unlocked.*Nothing was signed/);
  });

  it('a list of peers that includes the admin machine', async () => {
    const s = await setup(1);
    await expect(buildAliases({ ...s.input, recipients: [s.sign(s.adminMachine)] })).rejects.toThrow(/include the admin machine/);
  });
});
