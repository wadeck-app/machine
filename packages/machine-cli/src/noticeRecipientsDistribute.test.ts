import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newCandidacyRandom, verifyInboxDocument } from '@wadeck-app/machine-core';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { readMachine } from './identity.js';
import { exportMachineInfo } from './network.js';
import { putNoticeRecipients, type DistributionReport, type Sender } from './distribute.js';
import { readAdminPin, unlockAdminKey } from './admin.js';
import { noticeSentFile, readNoticeSent, recordNoticeConfirmed } from './noticeRecipientsSent.js';
import { readNoticeRecipients } from './noticeRecipientsStore.js';
import { makeCommands } from './commands.js';
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

describe('the admin machine records what it sent, and says it', () => {
  it('approve records the list sent to the new machine (serial, time, stored by the relay)', async () => {
    await enroll('laptop');
    const stored = readNoticeRecipients(adminDir, admin.adminPublicKey);
    const entry = readNoticeSent(adminDir)[uuidOf('laptop')];
    expect(entry?.sent).toMatchObject({ serial: stored?.body.serial, stored: true });
    expect(entry?.confirmed).toBeUndefined();
  });

  it('a send the relay refused is recorded as not stored', async () => {
    await enroll('laptop');
    const key = await unlockAdminKey(adminDir, pass);
    const signed = readNoticeRecipients(adminDir, readAdminPin(adminDir).adminPublicKey);
    const client = { putInboxDocument: async () => { throw new Error('relay down'); } } as unknown as Sender['client'];
    const sender: Sender = { client, adminPrivateKeyPkcs8: key.privateKeyPkcs8, adminUuid: uuidOf('desktop'), now: nowSeconds, configDir: adminDir };
    const report: DistributionReport = { delivered: 0, alreadyThere: 0, failures: [], aborted: false, machines: 1 };
    await putNoticeRecipients(sender, report, signed as NonNullable<typeof signed>, [{ uuid: uuidOf('laptop'), name: 'laptop' }]);
    expect(report.failures).toHaveLength(1);
    expect(readNoticeSent(adminDir)[uuidOf('laptop')]?.sent).toMatchObject({ stored: false });
  });

  it('distribute of the only machine says it sent the list, even though there is no other peer to inform', async () => {
    await enroll('laptop');
    const r = await cli(adminDir, ['admin', 'distribute', 'laptop'], pass);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/no other peer to inform/);
    expect(r.out).toMatch(/request notices list.*laptop/);
  });
});

describe('machine admin notify-to --list: who holds the list', () => {
  const listText = async () => {
    const r = await cli(adminDir, ['admin', 'notify-to', '--list'], async () => {
      throw new Error('--list must not ask for a passphrase');
    });
    expect(r.code, r.err).toBe(0);
    return r.out;
  };
  const lineOf = (out: string, name: string) => out.split('\n').find((l) => new RegExp(`^  ${name}\\s`).test(l) && /list|sent|unknown|failed/.test(l)) ?? '';

  it('one line per trusted machine: sent but not confirmed, then confirmed, then an older list, then unknown', async () => {
    await enroll('laptop');
    await enroll('server');
    const serial = readNoticeRecipients(adminDir, admin.adminPublicKey)?.body.serial ?? 0;
    const sentOnly = await listText();
    expect(lineOf(sentOnly, 'laptop')).toMatch(/sent .*, not confirmed/);
    expect(lineOf(sentOnly, 'server')).toMatch(/sent .*, not confirmed/);
    // The hint says what to run, with the recipients of the current list.
    expect(sentOnly).toMatch(/machine admin notify-to desktop/);
    expect(sentOnly).toMatch(/machine requests <machine>/);

    recordNoticeConfirmed(adminDir, uuidOf('laptop'), { serial, at: nowSeconds() + 5 });
    recordNoticeConfirmed(adminDir, uuidOf('server'), { serial: serial - 10, at: nowSeconds() + 5 });
    const confirmed = await listText();
    expect(lineOf(confirmed, 'laptop')).toContain(`has the current list (serial ${serial}`);
    expect(lineOf(confirmed, 'server')).toContain(`has an older list (serial ${serial - 10}`);

    rmSync(noticeSentFile(adminDir));
    const unknown = await listText();
    expect(lineOf(unknown, 'laptop')).toMatch(/unknown \(older build or never asked\)/);
  });

  it('when every machine holds the current list there is nothing to run', async () => {
    await enroll('laptop');
    const serial = readNoticeRecipients(adminDir, admin.adminPublicKey)?.body.serial ?? 0;
    recordNoticeConfirmed(adminDir, uuidOf('laptop'), { serial, at: nowSeconds() + 5 });
    const out = await listText();
    expect(out).toMatch(/every trusted machine holds the current list/);
    expect(out).not.toMatch(/machine admin notify-to desktop/);
  });

  it('a damaged record is a warning with the fix and the recipients are still listed', async () => {
    await enroll('laptop');
    writeFileSync(noticeSentFile(adminDir), '{not json');
    const out = await listText();
    expect(out).toMatch(/Request notices go to/);
    expect(out).toMatch(/\[warn\].*notice-recipients-sent\.json.*Delete it/);
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

describe('the daemon command noticeHolders (the Machines page)', () => {
  it('on the admin machine: the recipients and, per trusted machine, what it holds, in words', async () => {
    await enroll('laptop');
    const answer = makeCommands(adminDir, 'test').noticeHolders();
    expect(answer).toMatchObject({ initialized: true, admin: true, listKnown: true, recipients: [{ uuid: uuidOf('desktop'), name: 'desktop (this machine)' }] });
    const serial = readNoticeRecipients(adminDir, admin.adminPublicKey)?.body.serial;
    expect(answer).toMatchObject({ serial });
    const laptop = (answer as { holders: Array<{ uuid: string; state: string; text: string }> }).holders.find((h) => h.uuid === uuidOf('laptop'));
    expect(laptop).toMatchObject({ state: 'sent' });
    expect(laptop?.text).toMatch(/not confirmed/);
  });

  it('says so when no list is known, instead of an empty table', async () => {
    const answer = makeCommands(adminDir, 'test').noticeHolders();
    expect(answer).toMatchObject({ initialized: true, admin: true, listKnown: false, recipients: [], holders: [] });
    expect((answer as { note: string }).note).toMatch(/machine admin notify-to/);
  });

  it('on a machine that is not the admin: no holders, only what it received', async () => {
    await ok(dirOf('laptop'), ['admin', 'pin', join(adminDir, 'admin.json')]);
    expect(makeCommands(dirOf('laptop'), 'test').noticeHolders()).toMatchObject({ initialized: true, admin: false, listKnown: false, holders: [] });
  });
});
