import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newCandidacyRandom, verifyInboxDocument } from '@wadeck-app/machine-core';
import { createDocumentApplier } from './documentApply.js';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { readMachine } from './identity.js';
import { exportMachineInfo } from './network.js';
import { cli, makeAdmin, ok, type TestAdmin } from './testing.js';

// Decision 116: `machine admin alias set|rm|list|send`: network aliases signed by the admin and sent to every machine.

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

/** Runs `machine admin alias ...`, recording what was asked and how many times the passphrase was typed. */
async function aliasAdmin(args: string[], answer = 'y') {
  const asked: string[] = [];
  let passphrases = 0;
  const result = await cli(
    adminDir,
    ['admin', 'alias', ...args],
    async () => {
      passphrases++;
      return admin.passphrase;
    },
    { ask: async (label) => (asked.push(label), answer) },
  );
  return { ...result, asked, passphrases };
}

let baseline = 0;
const aliasPuts = () => relay.requests.slice(baseline).filter((q) => q.method === 'PUT' && /\/inbox\//.test(q.path) && (q.body as { body?: { kind?: string } } | undefined)?.body?.kind === 'aliases');
const inboxOf = (name: string) => relay.inbox(uuidOf(name)).filter((d) => (d.document as { body: { kind: string } }).body.kind === 'aliases');
const verified = (name: string, document: unknown) =>
  verifyInboxDocument(document, { adminPublicKey: admin.adminPublicKey, selfUuid: uuidOf(name), now: nowSeconds(), identityPrivateKeyPkcs8: readMachine(dirOf(name)).identity.privateKeyPkcs8 });
const applyAll = (name: string) => {
  const apply = createDocumentApplier({ configDir: dirOf(name), self: readMachine(dirOf(name)), now: nowSeconds });
  return inboxOf(name).map((entry) => apply(entry.document));
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-alias-'));
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
  await ok(dirOf('laptop'), ['admin', 'pin', join(adminDir, 'admin.json')]);
  await ok(dirOf('server'), ['admin', 'pin', join(adminDir, 'admin.json')]);
  // Each machine learns its peers from the approvals, as in a real network (the aliases documents come later).
  for (const name of ['laptop', 'server']) {
    const apply = createDocumentApplier({ configDir: dirOf(name), self: readMachine(dirOf(name)), now: nowSeconds });
    for (const entry of relay.inbox(uuidOf(name))) apply(entry.document);
  }
  baseline = relay.requests.length;
});
afterEach(async () => {
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

describe('machine admin alias set: what the admin sees and signs', () => {
  it('shows the alias, the machine and its uuid, asks y/N BEFORE the passphrase, and asks the passphrase once', async () => {
    const r = await aliasAdmin(['set', 'box', 'server']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('box -> server');
    expect(r.out).toContain(uuidOf('server'));
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]).toMatch(/Set the network alias "box" -> "server".*\[y\/N\]/);
    expect(r.passphrases).toBe(1);
    expect(r.out + r.err).not.toContain(admin.passphrase);
  });

  it('a "no" signs nothing, asks no passphrase and sends nothing', async () => {
    const r = await aliasAdmin(['set', 'box', 'server'], 'n');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Nothing was signed/);
    expect(r.passphrases).toBe(0);
    expect(aliasPuts()).toHaveLength(0);
    expect((await aliasAdmin(['list'])).out).toMatch(/no network alias/);
  });

  it('normalizes a typed alias like a machine name, and says so', async () => {
    const r = await aliasAdmin(['set', 'My Box', 'server']);
    expect(r.code, r.err).toBe(0);
    expect(r.out + r.err).toMatch(/\[info\] using the alias "my-box" \(typed: "My Box"/);
  });

  it('sends one sealed aliases document to each OTHER trusted machine, and none to the admin machine itself', async () => {
    const r = await aliasAdmin(['set', 'box', 'server']);
    expect(r.code, r.err).toBe(0);
    expect(aliasPuts()).toHaveLength(2);
    expect(r.out).toMatch(/\[ok\] 2 document\(s\) stored by the relay for 2 machine\(s\)/);
    for (const name of ['laptop', 'server']) {
      const docs = inboxOf(name);
      expect(docs).toHaveLength(1);
      const v = verified(name, docs[0]?.document);
      expect(v).toMatchObject({ ok: true, kind: 'aliases' });
      if (v.ok && v.kind === 'aliases') expect(v.aliases.body.entries).toEqual([{ alias: 'box', uuid: uuidOf('server') }]);
      // The relay never reads an alias.
      expect(JSON.stringify(docs[0]?.document)).not.toContain('"box"');
    }
    expect(r.out + r.err).not.toContain(relay.adminToken);
  });
});

describe('network aliases across the network', () => {
  it('end to end: the receiver installs the list and the alias resolves there, to the machine, by its uuid', async () => {
    expect((await aliasAdmin(['set', 'box', 'server'])).code).toBe(0);
    expect(applyAll('laptop').map((x) => x.status)).toEqual(['installed']);
    const resolved = await cli(dirOf('laptop'), ['resolve', 'box']);
    expect(resolved.code, resolved.err).toBe(0);
    expect(resolved.out).toContain(uuidOf('server'));
    expect(resolved.out).toContain('via network-alias');
    // The admin machine resolves it too, without any document (it signed the list).
    expect((await cli(adminDir, ['resolve', 'box'])).out).toContain(uuidOf('server'));
  });

  it('applying the same document again changes nothing', async () => {
    await aliasAdmin(['set', 'box', 'server']);
    expect(applyAll('laptop').map((x) => x.status)).toEqual(['installed']);
    expect(applyAll('laptop').map((x) => x.status)).toEqual(['already-installed']);
  });

  it('an alias survives a rename of its machine (it points to the uuid)', async () => {
    await aliasAdmin(['set', 'box', 'server']);
    const renamed = await cli(adminDir, ['admin', 'rename', 'server', 'srv'], pass, { ask: yes });
    expect(renamed.code, renamed.err).toBe(0);
    const resolved = await cli(adminDir, ['resolve', 'box']);
    expect(resolved.out).toContain(uuidOf('server'));
    expect(resolved.out).toContain('(srv)');
  });

  it('a local alias wins on the machine that has both, and the output names both machines', async () => {
    await aliasAdmin(['set', 'box', 'server']);
    applyAll('laptop');
    const set = await cli(dirOf('laptop'), ['alias', 'set', 'box', 'laptop']);
    expect(set.code, set.err).toBe(0);
    expect(set.err + set.out).toMatch(/\[warn\].*"box".*network alias.*server.*local alias.*laptop.*local alias wins/s);
    const resolved = await cli(dirOf('laptop'), ['resolve', 'box']);
    expect(resolved.out).toContain(uuidOf('laptop'));
    expect(resolved.err).toMatch(/\[warn\].*"box".*server.*laptop/s);
    const list = await cli(dirOf('laptop'), ['alias', 'list']);
    expect(list.out).toMatch(/box -> .*laptop.*\(local\)/);
    expect(list.out).toMatch(/box -> .*server.*\(network.*shadowed/);
    expect(list.err).toMatch(/\[warn\].*"box"/);
  });

  it('`machine alias list` shows local and network aliases with their origin, `machine list` shows both on the machine', async () => {
    await aliasAdmin(['set', 'box', 'server']);
    applyAll('laptop');
    await ok(dirOf('laptop'), ['alias', 'set', 'home', 'laptop']);
    const list = await cli(dirOf('laptop'), ['alias', 'list']);
    expect(list.out).toMatch(/home -> .*laptop.*\(local\)/);
    expect(list.out).toMatch(/box -> .*server.*\(network, list serial/);
    const machines = await cli(dirOf('laptop'), ['list']);
    expect(machines.out).toMatch(/server .*aliases: box/);
    expect(machines.out).toMatch(/laptop .*aliases: home/);
    const json = await cli(dirOf('laptop'), ['alias', 'list', '--json']);
    expect(JSON.parse(json.out)).toMatchObject({ local: { home: uuidOf('laptop') }, network: [{ alias: 'box', uuid: uuidOf('server') }] });
  });
});

describe('machine admin alias rm and list', () => {
  it('rm signs the new list, sends it, and the alias stops resolving where it was applied', async () => {
    await aliasAdmin(['set', 'box', 'server']);
    applyAll('laptop');
    const r = await aliasAdmin(['rm', 'box']);
    expect(r.code, r.err).toBe(0);
    expect(r.asked[0]).toMatch(/Remove the network alias "box".*\[y\/N\]/);
    expect(inboxOf('laptop')).toHaveLength(2);
    expect(applyAll('laptop').map((x) => x.status)).toEqual(['already-installed', 'installed']);
    expect((await cli(dirOf('laptop'), ['resolve', 'box'])).code).toBe(3);
  });

  it('rm of an alias that does not exist is refused, listing the existing ones, before anything is asked', async () => {
    await aliasAdmin(['set', 'box', 'server']);
    const r = await aliasAdmin(['rm', 'nope']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no network alias "nope".*box/);
    expect(r.asked).toHaveLength(0);
    expect(r.passphrases).toBe(0);
  });

  it('list shows alias, machine name, uuid and serial from the local file, without a passphrase', async () => {
    await aliasAdmin(['set', 'box', 'server']);
    const r = await aliasAdmin(['list']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/box -> server .*/);
    expect(r.out).toContain(uuidOf('server'));
    expect(r.out).toMatch(/serial \d+/);
    expect(r.passphrases).toBe(0);
    expect(r.asked).toHaveLength(0);
  });
});

describe('machine admin alias refuses loudly, before anything is asked or signed', () => {
  async function refused(args: string[], code: number, message: RegExp) {
    const r = await aliasAdmin(args);
    expect(r.code, `${r.out}${r.err}`).toBe(code);
    expect(r.err).toMatch(message);
    expect(r.asked).toHaveLength(0);
    expect(r.passphrases).toBe(0);
    expect(aliasPuts()).toHaveLength(0);
  }

  it('an unknown machine (reference exit code)', () => refused(['set', 'box', 'nobody'], 3, /unknown machine "nobody"/));
  it('an alias equal to the name of a machine', () => refused(['set', 'laptop', 'server'], 1, /already the name of machine "laptop"/));
  it('an alias that looks like the name of a machine', () => refused(['set', 'lap-top', 'server'], 1, /only by hyphens or case/));
  it('an alias that cannot be made valid', () => refused(['set', '!!!', 'server'], 1, /no letter or digit/));
  it('wrong arguments', async () => {
    await refused(['set', 'box'], 2, /usage: machine admin alias set <alias> <machine> \| rm <alias> \| list \| send/);
    await refused(['rm'], 2, /usage: machine admin alias set/);
    await refused([], 2, /usage: machine admin alias/);
  });

  it('an alias already pointing to another machine, saying to remove it first', async () => {
    await aliasAdmin(['set', 'box', 'server']);
    baseline = relay.requests.length;
    await refused(['set', 'box', 'laptop'], 1, /machine admin alias rm box/);
  });

  it('a revoked machine', async () => {
    const revoked = await cli(adminDir, ['admin', 'revoke', 'laptop'], pass, { ask: yes });
    expect(revoked.code, revoked.err).toBe(0);
    baseline = relay.requests.length;
    await refused(['set', 'lap', 'laptop'], 3, /laptop/);
  });

  it('a machine reference that is itself an alias (an alias points to a machine, never to an alias)', async () => {
    await ok(adminDir, ['alias', 'set', 'big', 'server']);
    await refused(['set', 'box', 'big'], 3, /unknown machine "big"/);
  });

  it('a non-admin machine, saying where the admin key is', async () => {
    const r = await cli(dirOf('laptop'), ['admin', 'alias', 'set', 'box', 'server'], pass, { ask: yes });
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/admin key/);
  });
});

describe('machine admin alias: delivery', () => {
  it('a delivery that fails is loud with the exact retry command, the list stands, and `send` finishes the job', async () => {
    relay.force(`/api/machines/${uuidOf('server')}/inbox`, 500, { success: false, error: 'store_unavailable', message: 'disk full' }, {}, 'PUT');
    const r = await aliasAdmin(['set', 'box', 'server']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/server/);
    expect(r.err).toMatch(/disk full/);
    expect(r.err).toContain('machine admin alias send');
    expect(r.err).toMatch(/the network aliases stand/);
    expect((await aliasAdmin(['list'])).out).toContain('box');

    const retry = await aliasAdmin(['send']);
    expect(retry.code, retry.err).toBe(0);
    expect(retry.out).toMatch(/already there/);
    expect(applyAll('server').map((x) => x.status)).toEqual(['installed']);
  });

  it('send without any network alias says there is nothing to send', async () => {
    const r = await aliasAdmin(['send']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no network alias to send/);
    expect(r.passphrases).toBe(0);
  });

  it('without an admin relay token the list stands locally and the output says what to run', async () => {
    rmSync(join(adminDir, '_secrets_', 'relay-admin.json'), { force: true });
    const r = await aliasAdmin(['set', 'box', 'server']);
    expect(r.code).toBe(1);
    expect(r.err + r.out).toMatch(/NOT distributed/);
    expect(r.err + r.out).toContain('machine admin login');
    expect(r.err + r.out).toContain('machine admin alias send');
    expect((await aliasAdmin(['list'])).out).toContain('box');
  });
});

describe('machine admin alias in the help', () => {
  it('`machine admin --help` lists it, and `machine admin alias --help` shows its forms', async () => {
    const group = await cli(adminDir, ['admin', '--help']);
    expect(group.out).toMatch(/alias set <alias> <machine>/);
    const sub = await cli(adminDir, ['admin', 'alias', '--help']);
    expect(sub.code).toBe(0);
    expect(sub.out).toMatch(/set <alias> <machine>/);
    expect(sub.out).toMatch(/rm <alias>/);
    expect(sub.out).toMatch(/send/);
  });
});
