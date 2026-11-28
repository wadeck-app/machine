import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { derivePairSecretV2, newCandidacyRandom, openPairSecret, verifyInboxDocument } from '@wadeck-app/machine-core';
import { unlockAdminKey } from './admin.js';
import { createDocumentApplier } from './documentApply.js';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { readMachine } from './identity.js';
import { exportMachineInfo, loadNetwork, registeredSerial } from './network.js';
import { cli, makeAdmin, ok, type TestAdmin } from './testing.js';

// Decision 114: `machine admin rename <machine> <new-name>`.

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
  const result = await cli(adminDir, ['admin', 'approve', id, '--relay', relay.url], pass, { ask: yes });
  if (result.code !== 0) throw new Error(`approve ${name} failed: ${result.err}`);
}

/** Runs `machine admin rename`, recording what was asked and how many times the passphrase was typed. */
async function rename(args: string[], answer = 'y') {
  const asked: string[] = [];
  let passphrases = 0;
  const result = await cli(
    adminDir,
    ['admin', 'rename', ...args],
    async () => {
      passphrases++;
      return admin.passphrase;
    },
    { ask: async (label) => (asked.push(label), answer) },
  );
  return { ...result, asked, passphrases };
}

// The inbox PUTs made by the command under test: the enrollments of the setup are before `baseline`.
let baseline = 0;
const inboxPuts = () => relay.requests.slice(baseline).filter((q) => q.method === 'PUT' && /\/inbox\//.test(q.path) && (q.body as { body?: { kind?: string } } | undefined)?.body?.kind !== 'notice-recipients');
const inboxOf = (name: string) => relay.inbox(uuidOf(name)).filter((d) => (d.document as { body: { kind: string } }).body.kind !== 'notice-recipients');
const verified = (name: string, document: unknown) =>
  verifyInboxDocument(document, { adminPublicKey: admin.adminPublicKey, selfUuid: uuidOf(name), now: nowSeconds(), identityPrivateKeyPkcs8: readMachine(dirOf(name)).identity.privateKeyPkcs8 });
const adminNames = () => loadNetwork(adminDir, nowSeconds()).directory.machines().map((m) => m.name).sort();

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-rename-'));
  adminDir = dirOf('desktop');
  for (const name of ['desktop', 'laptop', 'server']) {
    mkdirSync(dirOf(name));
    await ok(dirOf(name), ['init', '--name', name]);
  }
  relay = await startFakeRelay();
  admin = makeAdmin(adminDir);
  await ok(adminDir, ['admin', 'login', '87654321', '--full-access', '--relay', relay.url]);
  await enroll('laptop');
  await enroll('server');
  baseline = relay.requests.length;
});
afterEach(async () => {
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

describe('machine admin rename: what the admin sees and signs', () => {
  it('shows old name, new name, uuid and serial, asks y/N BEFORE the passphrase, and asks the passphrase once', async () => {
    const serial = registeredSerial(adminDir, uuidOf('laptop')) as number;
    const r = await rename(['laptop', 'mac-m2']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('laptop -> mac-m2');
    expect(r.out).toContain(uuidOf('laptop'));
    expect(r.out).toMatch(new RegExp(`serial\\s+${serial} -> ${serial + 1}`));
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]).toMatch(/Rename "laptop" to "mac-m2".*\[y\/N\]/);
    expect(r.passphrases).toBe(1);
    expect(r.out + r.err).not.toContain(admin.passphrase);
  });

  it('a "no" signs nothing, asks no passphrase, sends nothing, and keeps the old name', async () => {
    const r = await rename(['laptop', 'mac-m2'], 'n');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Nothing was signed/);
    expect(r.passphrases).toBe(0);
    expect(inboxPuts()).toHaveLength(0);
    expect(adminNames()).toEqual(['laptop', 'server']);
  });

  it('normalizes a typed name like `init --name` does, and says so', async () => {
    const r = await rename(['laptop', 'Mac-M2']);
    expect(r.code, r.err).toBe(0);
    expect(r.err + r.out).toMatch(/\[info\] using the name "mac-m2" \(typed: "Mac-M2"/);
    expect(adminNames()).toEqual(['mac-m2', 'server']);
  });
});

describe('machine admin rename: the trust store of the admin machine', () => {
  it('replaces the registration (same key, same expiry, serial + 1) and keeps the pair secret of this machine with it', async () => {
    const before = loadNetwork(adminDir, nowSeconds()).directory.find(uuidOf('laptop'));
    const serial = registeredSerial(adminDir, uuidOf('laptop')) as number;
    const r = await rename(['laptop', 'mac-m2']);
    expect(r.code, r.err).toBe(0);
    const after = loadNetwork(adminDir, nowSeconds()).directory.find(uuidOf('laptop'));
    expect(after?.name).toBe('mac-m2');
    expect(after?.identityPublicKey).toBe(before?.identityPublicKey);
    expect(after?.pairSecret.toString('base64url')).toBe(before?.pairSecret.toString('base64url'));
    expect(registeredSerial(adminDir, uuidOf('laptop'))).toBe(serial + 1);
    expect(adminNames()).toEqual(['mac-m2', 'server']);
  });

  it('the old name stops resolving, the new name, the uuid and an alias set before keep working', async () => {
    await ok(adminDir, ['alias', 'set', 'lap', 'laptop']);
    await rename(['laptop', 'mac-m2']);
    expect((await cli(adminDir, ['admin', 'distribute', 'laptop'], pass)).code).toBe(3);
    expect((await cli(adminDir, ['admin', 'distribute', 'lap'], pass)).code).toBe(0);
    expect((await cli(adminDir, ['admin', 'distribute', 'mac-m2'], pass)).code).toBe(0);
    expect((await cli(adminDir, ['admin', 'distribute', uuidOf('laptop').slice(0, 8)], pass)).code).toBe(0);
  });

  it('says precisely what changes and what does not', async () => {
    const r = await rename(['laptop', 'mac-m2']);
    expect(r.out).toMatch(/policies, local aliases, connection settings and notice recipients refer to the machine by its uuid/);
    expect(r.out).toMatch(/`machine run laptop` and every other reference by the old name stop working/);
    expect(r.out).toMatch(/lines already written in the run log keep the old name/);
  });
});

describe('machine admin rename: what is sent', () => {
  it('the other peer learns the new registration, the renamed machine learns its own, with the pair secrets derived from the new serial', async () => {
    const serial = registeredSerial(adminDir, uuidOf('laptop')) as number;
    const mark = inboxPuts().length;
    const r = await rename(['laptop', 'mac-m2']);
    expect(r.code, r.err).toBe(0);
    expect(inboxPuts().length).toBeGreaterThan(mark);

    const toServer = inboxOf('server').map((d) => verified('server', d.document)).filter((v) => v.ok && v.kind === 'peer' && v.registration.uuid === uuidOf('laptop') && v.registration.name === 'mac-m2');
    expect(toServer).toHaveLength(1);
    const aboutLaptop = toServer[0];
    if (!aboutLaptop || !aboutLaptop.ok || aboutLaptop.kind !== 'peer') throw new Error('expected a peer document about the renamed machine');
    expect(aboutLaptop.registration.serial).toBe(serial + 1);

    const toLaptop = inboxOf('laptop').map((d) => verified('laptop', d.document));
    const selfDocuments = toLaptop.filter((v) => v.ok && v.kind === 'self-registration');
    expect(selfDocuments).toHaveLength(1);
    const self = selfDocuments[0];
    if (!self || !self.ok || self.kind !== 'self-registration') throw new Error('expected a self-registration document');
    expect(self.registration).toMatchObject({ uuid: uuidOf('laptop'), name: 'mac-m2', serial: serial + 1 });
    expect(self.registration.identityPublicKey).toBe(exportMachineInfo(dirOf('laptop')).identityPublicKey);

    // Both sides of the pair hold the same secret, derived from the NEW serial.
    const key = await unlockAdminKey(adminDir, pass);
    const expected = derivePairSecretV2(key.privateKeyPkcs8, { uuid: uuidOf('laptop'), serial: serial + 1 }, { uuid: uuidOf('server'), serial: registeredSerial(adminDir, uuidOf('server')) as number });
    expect(openPairSecret(aboutLaptop, readMachine(dirOf('server')).identity.privateKeyPkcs8)).toBe(expected);
    const newestAboutServer = toLaptop.filter((v) => v.ok && v.kind === 'peer' && v.registration.uuid === uuidOf('server')).at(-1);
    if (!newestAboutServer || !newestAboutServer.ok || newestAboutServer.kind !== 'peer') throw new Error('expected a peer document about the other machine');
    expect(openPairSecret(newestAboutServer, readMachine(dirOf('laptop')).identity.privateKeyPkcs8)).toBe(expected);
    // Nothing secret in the output.
    expect(r.out + r.err).not.toContain(expected);
    expect(r.out + r.err).not.toContain(relay.adminToken);
  });

  it('end to end: the documents applied on each machine give the renamed machine its new name and its peers the new registration', async () => {
    await ok(dirOf('laptop'), ['admin', 'pin', join(adminDir, 'admin.json')]);
    await ok(dirOf('server'), ['admin', 'pin', join(adminDir, 'admin.json')]);
    const r = await rename(['laptop', 'mac-m2']);
    expect(r.code, r.err).toBe(0);
    for (const name of ['laptop', 'server']) {
      const apply = createDocumentApplier({ configDir: dirOf(name), self: readMachine(dirOf(name)), now: nowSeconds });
      for (const entry of inboxOf(name)) {
        const result = apply(entry.document);
        expect(['installed', 'already-installed'], `${name}: ${JSON.stringify(result)}`).toContain(result.status);
      }
    }
    expect(readMachine(dirOf('laptop')).name).toBe('mac-m2');
    expect(loadNetwork(dirOf('server'), nowSeconds()).directory.find(uuidOf('laptop'))?.name).toBe('mac-m2');
    const status = await cli(dirOf('laptop'), ['status']);
    expect(status.out).toContain('mac-m2');
  });

  it('a delivery that fails is loud with the exact retry command, the rename stands, and the retry finishes the job', async () => {
    const serial = (registeredSerial(adminDir, uuidOf('laptop')) as number) + 1;
    relay.force(`/api/machines/${uuidOf('server')}/inbox`, 500, { success: false, error: 'store_unavailable', message: 'disk full' }, {}, 'PUT');
    const r = await rename(['laptop', 'mac-m2']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/server/);
    expect(r.err).toMatch(/disk full/);
    expect(r.err).toContain('machine admin rename mac-m2 mac-m2');
    expect(r.err).toMatch(/the rename stands/);
    expect(adminNames()).toEqual(['mac-m2', 'server']);

    const retry = await rename(['mac-m2', 'mac-m2']);
    expect(retry.code, retry.err).toBe(0);
    expect(retry.out).toMatch(/already named "mac-m2": sending the documents of the rename again/);
    expect(retry.out).toMatch(/already there/);
    expect(inboxOf('server').some((d) => verified('server', d.document).ok)).toBe(true);
    // Nothing was signed again: the serial is still the one of the rename.
    expect(registeredSerial(adminDir, uuidOf('laptop'))).toBe(serial);
  });

  it('without an admin relay token the rename stands locally and the output says what to run', async () => {
    rmSync(join(adminDir, '_secrets_', 'relay-admin.json'), { force: true });
    const r = await rename(['laptop', 'mac-m2']);
    expect(r.code).toBe(1);
    expect(r.err + r.out).toMatch(/NOT distributed/);
    expect(r.err + r.out).toContain('machine admin login');
    expect(r.err + r.out).toContain('machine admin rename mac-m2 mac-m2');
    expect(adminNames()).toEqual(['mac-m2', 'server']);
  });
});

describe('machine admin rename refuses loudly, before anything is asked or signed', () => {
  async function refused(args: string[], code: number, message: RegExp) {
    const r = await rename(args);
    expect(r.code, `${r.out}${r.err}`).toBe(code);
    expect(r.err).toMatch(message);
    expect(r.asked).toHaveLength(0);
    expect(r.passphrases).toBe(0);
    expect(inboxPuts()).toHaveLength(0);
    expect(adminNames()).toEqual(['laptop', 'server']);
  }

  it('an unknown machine (reference exit code)', () => refused(['nobody', 'x1'], 3, /unknown machine "nobody"/));
  it('a name used by another machine', () => refused(['laptop', 'server'], 1, /already used by machine "server"/));
  it('a name that cannot be made valid', () => refused(['laptop', '!!!'], 1, /--name|letter or digit|name/i));
  it('the admin machine itself (not supported in this version), saying what to do', () => refused(['desktop', 'main'], 1, /admin machine itself.*not supported/s));
  it('wrong arguments', () => refused(['laptop'], 2, /usage: machine admin rename <machine> <new-name>/));

  it('a revoked machine', async () => {
    const revoked = await cli(adminDir, ['admin', 'revoke', 'laptop'], pass, { ask: yes });
    expect(revoked.code, revoked.err).toBe(0);
    const r = await rename(['laptop', 'mac-m2']);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/revoked/);
    expect(r.passphrases).toBe(0);
  });

  it('a name that is a local alias of another machine', async () => {
    await ok(adminDir, ['alias', 'set', 'big', 'server']);
    await refused(['laptop', 'big'], 1, /local alias of another machine/);
  });
});

describe('machine admin rename in the help', () => {
  it('`machine --help` and `machine admin --help` list it with its arguments', async () => {
    const top = await cli(adminDir, ['--help']);
    expect(top.out).toMatch(/admin rename <machine> <new-name>/);
    const group = await cli(adminDir, ['admin', '--help']);
    expect(group.out).toMatch(/rename <machine> <new-name>/);
    const sub = await cli(adminDir, ['admin', 'rename', '--help']);
    expect(sub.code).toBe(0);
    expect(sub.out).toMatch(/signed registration/);
  });
});
