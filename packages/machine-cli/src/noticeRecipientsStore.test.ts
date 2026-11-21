import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateSigningKeyPair, keyId, signNoticeRecipients } from '@wadeck-app/machine-core';
import { installNoticeRecipients, noticeRecipientsFile, readNoticeRecipients, signNoticeRecipientsFor } from './noticeRecipientsStore.js';

const A = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const B = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'nr-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const admin = generateSigningKeyPair();
const signed = (serial: number, recipients: string[]) =>
  signNoticeRecipients({ v: 1, adminKeyId: keyId(admin.publicKey), serial, issuedAt: serial, recipients }, admin.privateKeyPkcs8);

describe('notice recipients store', () => {
  it('no file: no recipients', () => {
    expect(readNoticeRecipients(tmp(), admin.publicKey)).toBeUndefined();
  });

  it('installs a newer list, ignores the same and an older one', () => {
    const dir = tmp();
    expect(installNoticeRecipients(dir, signed(10, [A]), admin.publicKey)).toEqual({ changed: true });
    expect(installNoticeRecipients(dir, signed(10, [A]), admin.publicKey)).toEqual({ changed: false, reason: 'already-installed' });
    expect(installNoticeRecipients(dir, signed(9, [B]), admin.publicKey)).toEqual({ changed: false, reason: 'already-installed' });
    expect(readNoticeRecipients(dir, admin.publicKey)?.body.recipients).toEqual([A]);
    expect(installNoticeRecipients(dir, signed(11, [A, B].sort()), admin.publicKey)).toEqual({ changed: true });
    expect(readNoticeRecipients(dir, admin.publicKey)?.body.serial).toBe(11);
  });

  it('refuses a list that does not verify and writes nothing', () => {
    const dir = tmp();
    const other = generateSigningKeyPair();
    expect(() => installNoticeRecipients(dir, signed(10, [A]), other.publicKey)).toThrow(/notice-recipients list refused \(wrong-admin-key\)/);
    expect(readNoticeRecipients(dir, admin.publicKey)).toBeUndefined();
  });

  it('a damaged file stops the reader with the path and the fix', () => {
    const dir = tmp();
    writeFileSync(noticeRecipientsFile(dir), '{not json');
    expect(() => readNoticeRecipients(dir, admin.publicKey)).toThrow(new RegExp(`${noticeRecipientsFile(dir).replace(/[\\.]/g, '\\$&')}.*machine admin distribute`));
    // The writer does not overwrite a damaged file silently.
    expect(() => installNoticeRecipients(dir, signed(10, [A]), admin.publicKey)).toThrow(/machine admin distribute/);
  });

  it('a stored list that no longer verifies against the pinned key is refused loudly', () => {
    const dir = tmp();
    installNoticeRecipients(dir, signed(10, [A]), admin.publicKey);
    const other = generateSigningKeyPair();
    expect(() => readNoticeRecipients(dir, other.publicKey)).toThrow(/does not verify/);
  });
});

describe('signNoticeRecipientsFor (admin side)', () => {
  it('signs [this machine] when no list is stored, then reuses the stored one', () => {
    const dir = tmp();
    const first = signNoticeRecipientsFor(dir, { adminPrivateKeyPkcs8: admin.privateKeyPkcs8, adminPublicKey: admin.publicKey, selfUuid: A, now: 100 });
    expect(first.body.recipients).toEqual([A]);
    expect(first.body.serial).toBe(100);
    const again = signNoticeRecipientsFor(dir, { adminPrivateKeyPkcs8: admin.privateKeyPkcs8, adminPublicKey: admin.publicKey, selfUuid: A, now: 200 });
    expect(again).toEqual(first);
    expect(JSON.parse(readFileSync(noticeRecipientsFile(dir), 'utf8')).signed).toEqual(first);
  });

  it('an explicit list replaces the stored one with a serial above it', () => {
    const dir = tmp();
    signNoticeRecipientsFor(dir, { adminPrivateKeyPkcs8: admin.privateKeyPkcs8, adminPublicKey: admin.publicKey, selfUuid: A, now: 100 });
    const next = signNoticeRecipientsFor(dir, { adminPrivateKeyPkcs8: admin.privateKeyPkcs8, adminPublicKey: admin.publicKey, selfUuid: A, now: 50, recipients: [B, A] });
    expect(next.body.recipients).toEqual([A, B].sort());
    expect(next.body.serial).toBe(101);
  });
});
