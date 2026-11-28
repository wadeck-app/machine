import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDocument, documentId, generateSigningKeyPair, signRegistration, type Json, type RegistrationBody, type SignedDocument } from '@wadeck-app/machine-core';
import { unlockAdminKey } from './admin.js';
import { createDocumentApplier } from './documentApply.js';
import { identityFile, readMachine } from './identity.js';
import { exportMachineInfo } from './network.js';
import { cli, makeAdmin, ok, type TestAdmin } from './testing.js';

// Decision 114: the renamed machine learns its new name from a `self-registration` document; the identity file is the one place a machine keeps its own name.

let root: string;
let adminDir: string;
let laptop: string;
let admin: TestAdmin;
const now = () => Math.floor(Date.now() / 1000);

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-selfreg-'));
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

async function selfDocument(over: Partial<RegistrationBody> = {}, options: { to?: string; id?: string } = {}): Promise<SignedDocument> {
  const key = await unlockAdminKey(adminDir, async () => admin.passphrase);
  const info = exportMachineInfo(laptop);
  const body: RegistrationBody = {
    v: 1,
    uuid: info.uuid,
    name: 'mac-m2',
    identityPublicKey: info.identityPublicKey,
    serial: now() + 1,
    validFrom: now() - 5,
    validTo: now() + 86_400,
    adminKeyId: admin.adminKeyId,
    ...over,
  };
  const registration = signRegistration(body, key.privateKeyPkcs8);
  return buildDocument(
    { kind: 'self-registration', to: options.to ?? info.uuid, id: documentId(options.id ?? `self:${body.serial}:${body.name}`), issuedAt: now() - 5, expiresAt: now() + 1000, payload: { registration } as unknown as Json, recipientIdentityPublicKey: info.identityPublicKey },
    key.privateKeyPkcs8,
  );
}

const applier = (hooks: { onInstalled?: () => void } = {}, self = readMachine(laptop)) => createDocumentApplier({ configDir: laptop, self, now, ...hooks });

describe('a self-registration document renames the machine that receives it', () => {
  it('installs the new name in the identity file, keeps uuid, keys and creation date, and tells the daemon', async () => {
    const before = readMachine(laptop);
    const raw = JSON.parse(readFileSync(identityFile(laptop), 'utf8')) as Record<string, unknown>;
    let installed = 0;
    const result = applier({ onInstalled: () => void installed++ })(await selfDocument());
    expect(result).toMatchObject({ status: 'installed', kind: 'self-registration' });
    expect(installed).toBe(1);
    const after = readMachine(laptop);
    expect(after.name).toBe('mac-m2');
    expect(after.uuid).toBe(before.uuid);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.identity.publicKey).toBe(before.identity.publicKey);
    expect(Buffer.from(after.identity.privateKeyPkcs8)).toEqual(Buffer.from(before.identity.privateKeyPkcs8));
    const written = JSON.parse(readFileSync(identityFile(laptop), 'utf8')) as Record<string, unknown>;
    expect(written.privateKey).toBe(raw.privateKey);
    expect(written.publicKey).toBe(raw.publicKey);
  });

  it('the identity object the daemon holds is updated in place, so its refusals and notices use the new name without a restart', async () => {
    const self = readMachine(laptop);
    applier({}, self)(await selfDocument());
    expect(self.name).toBe('mac-m2');
  });

  it('`machine status` and `machine list` on the renamed machine show the new name', async () => {
    applier()(await selfDocument());
    const status = await cli(laptop, ['status']);
    expect(status.code, status.err).toBe(0);
    expect(status.out + status.err).toContain('mac-m2');
    expect(status.out + status.err).not.toMatch(/^laptop \(/m);
    const list = await cli(laptop, ['list']);
    expect(list.out).toContain('mac-m2');
  });

  it('the same document again changes nothing (already installed), and the daemon is not told twice', async () => {
    let installed = 0;
    const apply = applier({ onInstalled: () => void installed++ });
    const document = await selfDocument();
    expect(apply(document)).toMatchObject({ status: 'installed' });
    expect(apply(document)).toMatchObject({ status: 'already-installed', kind: 'self-registration' });
    expect(installed).toBe(1);
  });

  it('an OLDER serial after a newer one is refused and the name stays', async () => {
    const apply = applier();
    const base = now();
    expect(apply(await selfDocument({ serial: base + 5, name: 'third' }))).toMatchObject({ status: 'installed' });
    const older = apply(await selfDocument({ serial: base + 2, name: 'second' }));
    expect(older).toMatchObject({ status: 'refused', reason: 'install-refused' });
    expect((older as { message: string }).message).toMatch(/serial/);
    expect(readMachine(laptop).name).toBe('third');
  });

  it('a registration with ANOTHER identity key for this uuid is refused: a rename never changes the key', async () => {
    const other = generateSigningKeyPair();
    const result = applier()(await selfDocument({ identityPublicKey: other.publicKey }));
    expect(result).toMatchObject({ status: 'refused', reason: 'install-refused' });
    expect((result as { message: string }).message).toMatch(/never changes the key/);
    expect(readMachine(laptop).name).toBe('laptop');
  });

  it('a registration of ANOTHER machine inside a document for this one is refused and the name stays', async () => {
    const result = applier()(await selfDocument({ uuid: '9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345' }));
    expect(result).toMatchObject({ status: 'refused', reason: 'invalid-payload' });
    expect(readMachine(laptop).name).toBe('laptop');
  });

  it('a name this build would not accept as its own (uppercase) is refused WITHOUT touching the identity file', async () => {
    const raw = readFileSync(identityFile(laptop), 'utf8');
    const result = applier()(await selfDocument({ name: 'Mac-M2' }));
    expect(result).toMatchObject({ status: 'refused', reason: 'install-refused' });
    expect((result as { message: string }).message).toMatch(/lowercase/);
    expect(readFileSync(identityFile(laptop), 'utf8')).toBe(raw);
    expect(readMachine(laptop).name).toBe('laptop');
  });

  it('a document signed by another admin key is unverified and changes nothing', async () => {
    const stranger = generateSigningKeyPair();
    const info = exportMachineInfo(laptop);
    const registration = signRegistration(
      { v: 1, uuid: info.uuid, name: 'evil', identityPublicKey: info.identityPublicKey, serial: now() + 1, validFrom: now() - 5, validTo: now() + 86_400, adminKeyId: admin.adminKeyId },
      stranger.privateKeyPkcs8,
    );
    const forged = buildDocument(
      { kind: 'self-registration', to: info.uuid, id: documentId('forged'), issuedAt: now() - 5, expiresAt: now() + 1000, payload: { registration } as unknown as Json, recipientIdentityPublicKey: info.identityPublicKey },
      stranger.privateKeyPkcs8,
    );
    expect(applier()(forged)).toMatchObject({ status: 'unverified', reason: 'bad-signature' });
    expect(readMachine(laptop).name).toBe('laptop');
  });

  it('a machine that has not pinned an admin key cannot apply one: not-enrolled', async () => {
    const bare = join(root, 'bare');
    mkdirSync(bare);
    await ok(bare, ['init', '--name', 'bare']);
    const document = await selfDocument();
    expect(createDocumentApplier({ configDir: bare, self: readMachine(bare), now })(document)).toMatchObject({ status: 'not-enrolled' });
    expect(readMachine(bare).name).toBe('bare');
  });
});
