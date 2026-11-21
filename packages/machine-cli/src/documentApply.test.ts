import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDocument, documentId, generateSigningKeyPair, signPolicy, type Json, type SignedDocument } from '@wadeck-app/machine-core';
import { unlockAdminKey } from './admin.js';
import { createDocumentApplier } from './documentApply.js';
import { readMachine } from './identity.js';
import { exportMachineInfo, loadNetwork } from './network.js';
import { makeAdmin, ok, type TestAdmin } from './testing.js';

// The ONE function that verifies and applies an admin document, used by the inbox loop and by `deliver-document` (decision 86).

let root: string;
let adminDir: string;
let laptop: string;
let admin: TestAdmin;
const now = () => Math.floor(Date.now() / 1000);

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-apply-'));
  adminDir = join(root, 'desktop');
  laptop = join(root, 'laptop');
  for (const dir of [adminDir, laptop]) {
    mkdirSync(dir);
    await ok(dir, ['init', '--name', dir === adminDir ? 'desktop' : 'laptop']);
  }
  admin = makeAdmin(adminDir);
  await ok(laptop, ['admin', 'pin', join(adminDir, 'admin.json')]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function policyDocument(version: number, signer?: Uint8Array, to?: string): Promise<SignedDocument> {
  const key = await unlockAdminKey(adminDir, async () => admin.passphrase);
  const info = exportMachineInfo(laptop);
  const signed = signPolicy(
    { v: 1, target: info.uuid, version, baseVersion: version - 1, adminKeyId: admin.adminKeyId, issuedAt: now(), notBefore: now() - 5, notAfter: now() + 100_000, defaults: [{ shell: 'sh', command: `echo v${version}` }], peers: {} },
    key.privateKeyPkcs8,
  );
  return buildDocument(
    { kind: 'policy', to: to ?? info.uuid, id: documentId(`test:${version}:${signer === undefined}`), issuedAt: now(), expiresAt: now() + 1000, payload: signed as unknown as Json, recipientIdentityPublicKey: info.identityPublicKey },
    signer ?? key.privateKeyPkcs8,
  );
}

const applier = (hooks: { onInstalled?: () => void } = {}) => createDocumentApplier({ configDir: laptop, self: readMachine(laptop), now, ...hooks });

describe('createDocumentApplier', () => {
  it('installs a policy once, then says it is already installed for the same document', async () => {
    let installed = 0;
    const apply = applier({ onInstalled: () => void installed++ });
    const document = await policyDocument(1);
    expect(apply(document)).toMatchObject({ status: 'installed', kind: 'policy', id: document.body.id });
    expect(loadNetwork(laptop, now()).policy?.version).toBe(1);
    expect(installed).toBe(1);
    expect(apply(document)).toMatchObject({ status: 'already-installed', kind: 'policy' });
  });

  it('a document signed by another key is unverified (nothing installed, nothing to remember)', async () => {
    const stranger = generateSigningKeyPair();
    const forged = await policyDocument(1, stranger.privateKeyPkcs8);
    expect(applier()(forged)).toMatchObject({ status: 'unverified', reason: 'bad-signature' });
    expect(loadNetwork(laptop, now()).policy).toBeUndefined();
  });

  it('junk is unverified as malformed', () => {
    expect(applier()({ nope: true })).toMatchObject({ status: 'unverified', reason: 'malformed' });
  });

  it('a document addressed to another machine is refused with its reason', async () => {
    const other = '9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345';
    const document = await policyDocument(1, undefined, other);
    expect(applier()(document)).toMatchObject({ status: 'refused', reason: 'wrong-recipient' });
  });

  it('an id that is not the one announced is unverified (id-mismatch)', async () => {
    const document = await policyDocument(1);
    expect(applier()(document, 'AAAAAAAAAAAAAAAAAAAAAA')).toMatchObject({ status: 'unverified', reason: 'id-mismatch' });
  });

  it('a machine that has not pinned an admin key cannot verify anything: not-enrolled', async () => {
    const document = await policyDocument(1);
    const bare = join(root, 'bare');
    mkdirSync(bare);
    await ok(bare, ['init', '--name', 'bare']);
    expect(createDocumentApplier({ configDir: bare, self: readMachine(bare), now })(document)).toMatchObject({ status: 'not-enrolled' });
  });

  it('a policy whose predecessor is missing is waiting, not refused', async () => {
    const document = await policyDocument(3);
    expect(applier()(document)).toMatchObject({ status: 'waiting', reason: 'waiting-predecessor' });
  });

  it('a document that starts in the future is deferred', async () => {
    const key = await unlockAdminKey(adminDir, async () => admin.passphrase);
    const info = exportMachineInfo(laptop);
    const later = now() + 3600;
    const signed = signPolicy({ v: 1, target: info.uuid, version: 1, baseVersion: 0, adminKeyId: admin.adminKeyId, issuedAt: later, notBefore: later, notAfter: later + 1000, defaults: [], peers: {} }, key.privateKeyPkcs8);
    const document = buildDocument({ kind: 'policy', to: info.uuid, id: documentId('later'), issuedAt: later, expiresAt: later + 1000, payload: signed as unknown as Json, recipientIdentityPublicKey: info.identityPublicKey }, key.privateKeyPkcs8);
    expect(applier()(document)).toMatchObject({ status: 'deferred', reason: 'not-yet-valid' });
  });
});
