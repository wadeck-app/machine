import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newCandidacyRandom, verifyInboxDocument } from '@wadeck-app/machine-core';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { readMachine } from './identity.js';
import { exportMachineInfo } from './network.js';
import { readNoticeRecipients } from './noticeRecipientsStore.js';
import { cli, makeAdmin, ok, type TestAdmin } from './testing.js';

// request-notices.md, phase 1: the list of notice recipients rides every distribution, and `machine admin notify-to` chooses it.

let root: string;
let adminDir: string;
let relay: FakeRelay;
let admin: TestAdmin;

const yes = async () => 'y';
const pass = async () => admin.passphrase;
const dirOf = (name: string) => join(root, name);
const uuidOf = (name: string) => readMachine(dirOf(name)).uuid;
const nowSeconds = () => Math.floor(Date.now() / 1000);

async function enroll(name: string) {
  const info = exportMachineInfo(dirOf(name));
  const id = `cand-${name}`;
  relay.addCandidacy(id, { name: info.name, hostname: 'h', identityPublicKey: info.identityPublicKey, random: newCandidacyRandom(), uuid: info.uuid });
  const r = await cli(adminDir, ['admin', 'approve', id, '--relay', relay.url], pass, { ask: yes });
  expect(r.code, r.err).toBe(0);
  return r;
}

/** The lists the inbox of `name` holds, opened with its own identity key. */
const listsOf = (name: string) =>
  relay
    .inbox(uuidOf(name))
    .map((d) => verifyInboxDocument(d.document, { adminPublicKey: admin.adminPublicKey, selfUuid: uuidOf(name), now: nowSeconds(), identityPrivateKeyPkcs8: readMachine(dirOf(name)).identity.privateKeyPkcs8 }))
    .flatMap((v) => (v.ok && v.kind === 'notice-recipients' ? [v.noticeRecipients] : []));

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-notice-recipients-'));
  adminDir = dirOf('desktop');
  for (const name of ['desktop', 'laptop', 'server']) {
    mkdirSync(dirOf(name));
    await ok(dirOf(name), ['init', '--name', name]);
  }
  relay = await startFakeRelay();
  admin = makeAdmin(adminDir);
  await ok(adminDir, ['admin', 'login', '87654321', '--full-access', '--relay', relay.url]);
});
afterEach(async () => {
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

describe('the list of notice recipients rides the distributions the admin already makes', () => {
  it('approve: each machine concerned gets a sealed list naming the admin machine, in the same passphrase unlock', async () => {
    await enroll('laptop');
    const second = await enroll('server');
    for (const name of ['laptop', 'server']) {
      const lists = listsOf(name);
      expect(lists, name).toHaveLength(1);
      expect(lists[0]?.body.recipients).toEqual([uuidOf('desktop')]);
    }
    // The admin machine keeps what it signed, and there is no sixth step for the user: approve printed no extra prompt.
    expect(readNoticeRecipients(adminDir, admin.adminPublicKey)?.body.recipients).toEqual([uuidOf('desktop')]);
    expect(second.out).not.toMatch(/notify/i);
  });

  it('the same list is reused, not re-signed, by the next distribution (same serial and signature)', async () => {
    await enroll('laptop');
    const first = listsOf('laptop')[0];
    await enroll('server');
    expect(readNoticeRecipients(adminDir, admin.adminPublicKey)?.signature).toBe(first?.signature);
  });

  it('a policy signed for a machine also sends the list', async () => {
    await enroll('laptop');
    const draft = join(root, 'draft.json');
    writeFileSync(draft, JSON.stringify({ v: 1, target: uuidOf('laptop'), version: 1, baseVersion: 0, defaults: [{ shell: 'sh', command: 'echo hi' }], peers: {} }));
    const r = await cli(adminDir, ['admin', 'sign-policy', draft, '--out', join(root, 'p.json')], pass);
    expect(r.code, r.err).toBe(0);
    expect(listsOf('laptop')).toHaveLength(1);
  });

  it('a revocation also sends the list to the machines that remain, and never to the revoked one', async () => {
    await enroll('laptop');
    await enroll('server');
    const r = await cli(adminDir, ['admin', 'revoke', 'server'], pass, { ask: yes });
    expect(r.code, r.err).toBe(0);
    expect(listsOf('laptop')).toHaveLength(1);
  });
});

describe('machine admin notify-to', () => {
  it('signs a new list with a higher serial, sends it to every trusted peer, and --list reads it', async () => {
    await enroll('laptop');
    await enroll('server');
    const before = readNoticeRecipients(adminDir, admin.adminPublicKey);
    const r = await cli(adminDir, ['admin', 'notify-to', 'laptop', 'desktop'], pass);
    expect(r.code, r.err).toBe(0);
    const stored = readNoticeRecipients(adminDir, admin.adminPublicKey);
    expect(stored?.body.recipients).toEqual([uuidOf('desktop'), uuidOf('laptop')].sort());
    expect(stored?.body.serial).toBeGreaterThan(before?.body.serial ?? 0);
    expect(r.out).toContain('laptop');
    // The new list is in the inbox of every trusted peer, next to the older one: the replace-newer rule picks the newest.
    for (const name of ['laptop', 'server']) {
      expect(listsOf(name).some((l) => l.body.serial === stored?.body.serial), name).toBe(true);
    }
    const listed = await cli(adminDir, ['admin', 'notify-to', '--list'], async () => {
      throw new Error('--list must not ask for a passphrase');
    });
    expect(listed.code, listed.err).toBe(0);
    expect(listed.out).toMatch(/laptop/);
    expect(listed.out).toMatch(/desktop.*this machine/);
  });

  it('an unknown machine is refused before the passphrase is asked, naming the fix', async () => {
    await enroll('laptop');
    const r = await cli(adminDir, ['admin', 'notify-to', 'nobody'], async () => {
      throw new Error('no passphrase for an unknown machine');
    });
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/nobody/);
    expect(r.err).toMatch(/machine status/);
  });

  it('needs a machine or --list, and refuses both', async () => {
    expect((await cli(adminDir, ['admin', 'notify-to'], pass)).err).toMatch(/usage: machine admin notify-to/);
    expect((await cli(adminDir, ['admin', 'notify-to', '--list', 'laptop'], pass)).err).toMatch(/usage: machine admin notify-to/);
  });

  it('--list without a stored list says what to run', async () => {
    const r = await cli(adminDir, ['admin', 'notify-to', '--list'], pass);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/no notice recipients are known/);
    expect(r.out).toMatch(/machine admin distribute/);
  });
});
