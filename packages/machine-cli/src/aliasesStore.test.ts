import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateSigningKeyPair, keyId, signAliases } from '@wadeck-app/machine-core';
import { unlockAdminKey } from './admin.js';
import { aliasesFile, installAliases, networkAliasMap, readAliasesList, signAliasesFor } from './aliasesStore.js';
import { makeAdmin } from './testing.js';

// Decision 116: <configDir>/aliases.json holds the admin-signed network aliases, re-verified against the pinned admin key on every read.

const A = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const B = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'al-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const admin = generateSigningKeyPair();
const signed = (serial: number, entries: Array<{ alias: string; uuid: string }>) => signAliases({ v: 1, adminKeyId: keyId(admin.publicKey), serial, issuedAt: serial, entries }, admin.privateKeyPkcs8);

describe('aliases store', () => {
  it('no file: no network alias', () => {
    expect(readAliasesList(tmp(), admin.publicKey)).toBeUndefined();
  });

  it('installs a newer list, ignores the same and an older one', () => {
    const dir = tmp();
    expect(installAliases(dir, signed(10, [{ alias: 'box', uuid: A }]), admin.publicKey)).toEqual({ changed: true });
    expect(installAliases(dir, signed(10, [{ alias: 'box', uuid: A }]), admin.publicKey)).toEqual({ changed: false, reason: 'already-installed' });
    expect(installAliases(dir, signed(9, [{ alias: 'old', uuid: B }]), admin.publicKey)).toEqual({ changed: false, reason: 'already-installed' });
    expect(readAliasesList(dir, admin.publicKey)?.body.entries).toEqual([{ alias: 'box', uuid: A }]);
    expect(installAliases(dir, signed(11, []), admin.publicKey)).toEqual({ changed: true });
    expect(readAliasesList(dir, admin.publicKey)?.body.entries).toEqual([]);
  });

  it('refuses a list that does not verify and writes nothing', () => {
    const dir = tmp();
    const other = generateSigningKeyPair();
    expect(() => installAliases(dir, signed(10, [{ alias: 'box', uuid: A }]), other.publicKey)).toThrow(/aliases list refused \(wrong-admin-key\)/);
    expect(readAliasesList(dir, admin.publicKey)).toBeUndefined();
  });

  it('a damaged file stops the reader with the path and the fix', () => {
    const dir = tmp();
    writeFileSync(aliasesFile(dir), '{not json');
    expect(() => readAliasesList(dir, admin.publicKey)).toThrow(new RegExp(`${aliasesFile(dir).replace(/[\\.]/g, '\\$&')}.*machine admin alias set`));
    expect(() => installAliases(dir, signed(10, []), admin.publicKey)).toThrow(/machine admin alias set/);
  });

  it('a stored list that no longer verifies against the pinned key is refused loudly', () => {
    const dir = tmp();
    installAliases(dir, signed(10, [{ alias: 'box', uuid: A }]), admin.publicKey);
    const other = generateSigningKeyPair();
    expect(() => readAliasesList(dir, other.publicKey)).toThrow(/does not verify/);
  });

  it('signAliasesFor signs a serial above the stored one and stores it', () => {
    const dir = tmp();
    installAliases(dir, signed(2_000_000_000, [{ alias: 'box', uuid: A }]), admin.publicKey);
    const next = signAliasesFor(dir, { adminPrivateKeyPkcs8: admin.privateKeyPkcs8, adminPublicKey: admin.publicKey, now: 1_800_000_000, entries: [{ alias: 'box', uuid: A }, { alias: 'tc', uuid: B }] });
    expect(next.body.serial).toBe(2_000_000_001);
    expect(readAliasesList(dir, admin.publicKey)).toEqual(next);
  });

  it('networkAliasMap: empty without a file, the aliases of the verified list otherwise', async () => {
    const dir = tmp();
    const a = makeAdmin(dir);
    expect(networkAliasMap(dir)).toEqual({});
    const key = await unlockAdminKey(dir, async () => a.passphrase);
    signAliasesFor(dir, { adminPrivateKeyPkcs8: key.privateKeyPkcs8, adminPublicKey: a.adminPublicKey, now: 1_800_000_000, entries: [{ alias: 'box', uuid: A }] });
    expect(networkAliasMap(dir)).toEqual({ box: A });
  });
});
