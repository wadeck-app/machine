import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newCandidacyRandom, signNoticeRecipients } from '@wadeck-app/machine-core';
import { readAdminPin, unlockAdminKey } from './admin.js';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { readMachine } from './identity.js';
import { exportMachineInfo } from './network.js';
import { installNoticeRecipients, noticeRecipientsFile } from './noticeRecipientsStore.js';
import { cli, makeAdmin, ok, type TestAdmin } from './testing.js';

// request-notices.md, "A missing list is never silent": `machine status` says who receives request notices, or that nobody does yet and the fix.

let root: string;
let adminDir: string;
let relay: FakeRelay;
let admin: TestAdmin;

const yes = async () => 'y';
const pass = async () => admin.passphrase;
const dirOf = (name: string) => join(root, name);
const uuidOf = (name: string) => readMachine(dirOf(name)).uuid;

async function enroll(name: string) {
  const info = exportMachineInfo(dirOf(name));
  const id = `cand-${name}`;
  relay.addCandidacy(id, { name: info.name, hostname: 'h', identityPublicKey: info.identityPublicKey, random: newCandidacyRandom(), uuid: info.uuid });
  const r = await cli(adminDir, ['admin', 'approve', id, '--relay', relay.url], pass, { ask: yes });
  expect(r.code, r.err).toBe(0);
}

/** The text of `machine status` on `name`. */
const statusOf = async (name: string, ...extra: string[]) => {
  const r = await cli(dirOf(name), ['status', ...extra]);
  expect(r.code, r.err).toBe(0);
  return r;
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-notice-status-'));
  adminDir = dirOf('desktop');
  for (const name of ['desktop', 'laptop']) {
    mkdirSync(dirOf(name));
    await ok(dirOf(name), ['init', '--name', name]);
  }
  relay = await startFakeRelay();
  admin = makeAdmin(adminDir);
  await ok(adminDir, ['admin', 'login', '87654321', '--full-access', '--relay', relay.url]);
  await enroll('laptop');
});
afterEach(async () => {
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

describe('machine status: request notices', () => {
  it('a machine without a list says so and names the command that sends it', async () => {
    await ok(dirOf('laptop'), ['admin', 'pin', join(adminDir, 'admin.json')]);
    const r = await statusOf('laptop');
    expect(r.out).toMatch(/request notices: no recipient list yet/);
    expect(r.out).toContain('machine admin distribute laptop');
    expect(r.out).toMatch(/on the admin machine/);
  });

  it('the admin machine, which signed the list at the approval, names itself as the recipient', async () => {
    const r = await statusOf('desktop');
    expect(r.out).toMatch(/request notices: sent to desktop \(this machine\)/);
  });

  it('a peer is named by the name this machine knows it by', async () => {
    await ok(adminDir, ['admin', 'notify-to', 'laptop'], pass);
    expect((await statusOf('desktop')).out).toMatch(/request notices: sent to laptop$/m);
  });

  it('a machine that received the list names the recipients, and --json carries them', async () => {
    await ok(dirOf('laptop'), ['admin', 'pin', join(adminDir, 'admin.json')]);
    const key = await unlockAdminKey(adminDir, pass);
    const pin = readAdminPin(adminDir);
    installNoticeRecipients(dirOf('laptop'), signNoticeRecipients({ v: 1, adminKeyId: pin.adminKeyId, serial: 100, issuedAt: 100, recipients: [uuidOf('laptop')] }, key.privateKeyPkcs8), pin.adminPublicKey);
    const text = await statusOf('laptop');
    expect(text.out).toMatch(/request notices: sent to laptop \(this machine\)/);
    expect(text.out).not.toMatch(/no recipient list yet/);
    const json = JSON.parse((await statusOf('laptop', '--json')).out) as { noticeRecipients: { state: string; recipients: Array<{ uuid: string; name: string }> } };
    expect(json.noticeRecipients.state).toBe('listed');
    expect(json.noticeRecipients.recipients).toEqual([{ uuid: uuidOf('laptop'), name: 'laptop' }]);
  });

  it('an empty list says nobody is notified, and a machine this one does not know is named by its uuid', async () => {
    await ok(dirOf('laptop'), ['admin', 'pin', join(adminDir, 'admin.json')]);
    const key = await unlockAdminKey(adminDir, pass);
    const pin = readAdminPin(adminDir);
    const stranger = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
    installNoticeRecipients(dirOf('laptop'), signNoticeRecipients({ v: 1, adminKeyId: pin.adminKeyId, serial: 100, issuedAt: 100, recipients: [stranger] }, key.privateKeyPkcs8), pin.adminPublicKey);
    expect((await statusOf('laptop')).out).toContain(`${stranger} (not a trusted peer of this machine)`);
    installNoticeRecipients(dirOf('laptop'), signNoticeRecipients({ v: 1, adminKeyId: pin.adminKeyId, serial: 200, issuedAt: 200, recipients: [] }, key.privateKeyPkcs8), pin.adminPublicKey);
    expect((await statusOf('laptop')).out).toMatch(/request notices: nobody \(the list is empty/);
  });

  it('a damaged file is a warning with the path and the fix, and status still succeeds', async () => {
    await ok(dirOf('laptop'), ['admin', 'pin', join(adminDir, 'admin.json')]);
    writeFileSync(noticeRecipientsFile(dirOf('laptop')), '{not json');
    const r = await statusOf('laptop');
    expect(r.out).toMatch(/\[warn\] .*notice-recipients\.json.*machine admin distribute/);
  });

  it('a machine that is not enrolled prints no line (there is no admin to send a list)', async () => {
    const r = await statusOf('laptop');
    expect(r.out).not.toMatch(/request notices/);
  });
});
