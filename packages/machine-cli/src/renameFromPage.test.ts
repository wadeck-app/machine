import { mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDocument,
  buildRenamedRegistration,
  DOCUMENT_RETENTION_SECONDS,
  documentId,
  newCandidacyRandom,
  signRegistration,
  verifyInboxDocument,
  type SignedDocument,
  type SignedRegistration,
} from '@wadeck-app/machine-core';
import { buildDistribution, buildRename, type BuiltDistribution } from '@wadeck-app/machine-webcrypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unlockAdminKey } from './admin.js';
import { makeCommands } from './commands.js';
import { retainedDelivery, retryDelivery } from './deliveryRetry.js';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { readMachine } from './identity.js';
import { exportMachineInfo, loadNetwork, registeredSerial } from './network.js';
import { createRelayClient, RelayError, type RelayClient } from './relayClient.js';
import { relayAdminFile } from './relayStore.js';
import { renameApply, renameContext, type RenameApplyAnswer, type RenameContextOk } from './renameFromPage.js';
import { cli, makeAdmin, ok, type TestAdmin } from './testing.js';

// Rename from the page (admin-ui.md, "Rename from the page"). The BROWSER signs the re-issued registration and the documents (peer documents, notice lists, the
// self-registration of the renamed machine); the daemon of the admin machine verifies them against the pinned admin key and against what it re-plans itself, installs
// the registration here (keeping the pair secret) and delivers. It never receives a passphrase and signs nothing. Here the page is played with machine-core signing.

let root: string;
let adminDir: string;
let relay: FakeRelay;
let admin: TestAdmin;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const dirOf = (name: string) => join(root, name);
const uuidOf = (name: string) => readMachine(dirOf(name)).uuid;
const pass = async () => admin.passphrase;
const yes = async () => 'y';
const STRANGER = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';

async function enroll(name: string): Promise<void> {
  const info = exportMachineInfo(dirOf(name));
  relay.addCandidacy(`cand-${name}`, { name: info.name, hostname: 'h', identityPublicKey: info.identityPublicKey, random: newCandidacyRandom(), uuid: info.uuid });
  const result = await cli(adminDir, ['admin', 'approve', `cand-${name}`, '--relay', relay.url], pass, { ask: yes });
  expect(result.code, result.err).toBe(0);
}

let baseline = 0;
beforeEach(async () => {
  baseline = 0;
  root = mkdtempSync(join(tmpdir(), 'machine-renamepage-'));
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
  baseline = inboxPuts().length;
});
afterEach(async () => {
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

const inboxPuts = () => relay.requests.filter((q) => q.method === 'PUT' && /\/inbox\//.test(q.path));
const newPuts = () => inboxPuts().slice(baseline);
const inboxOf = (name: string) => relay.inbox(uuidOf(name)).map((d) => d.document as SignedDocument);
const realClient = (): RelayClient => createRelayClient({ baseUrl: relay.url, token: relay.adminToken });
const refusing = (uuids: string[]): RelayClient => {
  const real = realClient();
  return {
    putInboxDocument: async (to: string, document: { body: { id: string } }) => {
      if (uuids.includes(to)) throw new RelayError({ status: 500, message: 'boom' });
      return real.putInboxDocument(to, document);
    },
    deleteMachine: async (uuid: string) => real.deleteMachine(uuid),
  } as unknown as RelayClient;
};
const failure = (answer: { ok: boolean }): { reason: string; message: string } => {
  const a = answer as { ok: boolean; reason?: string; message?: string };
  if (a.ok) throw new Error(`expected a refusal, got ${JSON.stringify(answer)}`);
  return a as { reason: string; message: string };
};
const contextOf = (name: string, dir = adminDir): RenameContextOk => {
  const context = renameContext(dir, { uuid: uuidOf(name) }, nowSeconds());
  if (!context.ok) throw new Error(`test: ${context.message}`);
  return context;
};
const applied = (answer: RenameApplyAnswer) => {
  if (!answer.ok) throw new Error(`${answer.reason}: ${answer.message}`);
  return answer;
};

interface PageRun {
  context: RenameContextOk;
  signed: SignedRegistration;
  built: BuiltDistribution;
  selfDocument: SignedDocument;
  payload: Record<string, unknown>;
}

type Body = SignedRegistration['body'];

/** What the page does after one passphrase: plan, sign the registration, build the documents. `mutate` lets a test tamper with the body that is signed. */
async function pageRenames(name: string, newName: string, mutate: (body: Body) => Body = (b) => b): Promise<PageRun> {
  const context = contextOf(name);
  const pair = await unlockAdminKey(adminDir, pass);
  const key = await crypto.subtle.importKey('pkcs8', pair.privateKeyPkcs8 as BufferSource, 'Ed25519', false, ['sign']);
  const now = nowSeconds();
  const planned = buildRenamedRegistration({
    uuid: context.machine.uuid,
    current: context.current.body,
    newName,
    machines: context.machines,
    aliases: context.aliases,
    networkAliases: context.networkAliases,
    revokedUpTo: context.revokedUpTo ?? undefined,
    now,
  });
  if (!planned.ok) throw new Error(`test: ${planned.message}`);
  const signed = signRegistration(mutate(planned.body), pair.privateKeyPkcs8);
  const built = await buildDistribution({ adminPrivateKey: key, adminPublicKey: pair.publicKey, adminUuid: context.adminMachine.uuid, subject: signed, others: context.others, noticeRecipients: context.noticeRecipients, now });
  const issuedAt = signed.body.validFrom;
  const selfDocument = buildDocument(
    {
      kind: 'self-registration',
      to: signed.body.uuid,
      id: documentId(`v2:self-registration:${signed.body.uuid}:${signed.body.serial}`),
      issuedAt,
      expiresAt: Math.min(issuedAt + DOCUMENT_RETENTION_SECONDS, signed.body.validTo),
      payload: { registration: signed } as never,
      recipientIdentityPublicKey: context.current.body.identityPublicKey,
    },
    pair.privateKeyPkcs8,
  );
  return { context, signed, built, selfDocument, payload: { uuid: signed.body.uuid, signed, documents: [...built.documents, selfDocument], noticeRecipients: built.noticeRecipients } };
}

const adminNames = () => loadNetwork(adminDir, nowSeconds()).directory.machines().map((m) => m.name).sort();
const unchanged = () => {
  expect(adminNames()).toEqual(['laptop', 'server']);
  expect(newPuts()).toHaveLength(0);
};

describe('renameContext: what the page needs before it asks the passphrase', () => {
  it('the trusted registration, the names in use, the local and network aliases, what is revoked, the other registrations and the stored notice list', () => {
    const context = contextOf('laptop');
    expect(context.machine).toMatchObject({ uuid: uuidOf('laptop'), name: 'laptop', serial: context.current.body.serial });
    expect(context.adminMachine).toEqual({ uuid: uuidOf('desktop'), name: 'desktop' });
    expect(context.adminPublicKey).toBe(admin.adminPublicKey);
    expect(context.machines.map((m) => m.name).sort()).toEqual(['desktop', 'laptop', 'server']);
    expect(context.aliases).toEqual({});
    expect(context.networkAliases).toEqual({});
    expect(context.revokedUpTo).toBeNull();
    expect(context.others.map((r: SignedRegistration) => r.body.uuid)).toEqual([uuidOf('server')]);
    expect(context.noticeRecipients?.body.recipients).toEqual([uuidOf('desktop')]);
  });

  it('refuses this machine itself, a stranger, a revoked machine, a bad payload and a machine without the admin key, each with the way out', async () => {
    expect(failure(renameContext(adminDir, { uuid: uuidOf('desktop') }, nowSeconds()))).toMatchObject({ reason: 'self' });
    expect(failure(renameContext(adminDir, { uuid: uuidOf('desktop') }, nowSeconds())).message).toMatch(/admin machine itself/);
    expect(failure(renameContext(adminDir, { uuid: STRANGER }, nowSeconds())).reason).toBe('not-trusted');
    expect(failure(renameContext(adminDir, { uuid: 'nope' }, nowSeconds())).reason).toBe('bad-payload');
    expect(failure(renameContext(adminDir, { uuid: uuidOf('laptop'), extra: 1 }, nowSeconds())).reason).toBe('bad-payload');
    expect(failure(renameContext(dirOf('laptop'), { uuid: uuidOf('server') }, nowSeconds())).reason).toBe('no-admin-key');
    await cli(adminDir, ['admin', 'revoke', 'server'], pass, { ask: yes });
    const gone = failure(renameContext(adminDir, { uuid: uuidOf('server') }, nowSeconds()));
    expect(gone.reason).toBe('revoked');
    expect(gone.message).toMatch(/revoked here.*cannot be renamed/);
  });

  it('carries the local aliases that the planner checks the name against', async () => {
    await ok(adminDir, ['alias', 'set', 'box', 'server']);
    expect(contextOf('laptop').aliases).toEqual({ box: uuidOf('server') });
  });

  it('is served by the daemon command of the same name', () => {
    expect(makeCommands(adminDir, 'test', nowSeconds).renameContext({ uuid: uuidOf('laptop') })).toMatchObject({ ok: true, machine: { name: 'laptop' } });
  });
});

describe('renameApply: verify what the page signed, install it here, tell the machines like machine admin rename', () => {
  it('installs the registration (new name, serial + 1, same pair secret), delivers peer documents, lists and the self-registration', async () => {
    const run = await pageRenames('laptop', 'mac-m2');
    const pairBefore = loadNetwork(adminDir, nowSeconds()).directory.find(uuidOf('laptop'))?.pairSecret.toString('base64url');
    const answer = applied(await renameApply(adminDir, run.payload, nowSeconds()));
    expect(answer.failed).toBe(false);
    expect(answer.report.failures).toEqual([]);
    expect(adminNames()).toEqual(['mac-m2', 'server']);
    expect(registeredSerial(adminDir, uuidOf('laptop'))).toBe(run.context.current.body.serial + 1);
    expect(loadNetwork(adminDir, nowSeconds()).directory.find(uuidOf('laptop'))?.pairSecret.toString('base64url')).toBe(pairBefore);
    expect(answer.subject).toEqual({ uuid: uuidOf('laptop'), name: 'mac-m2' });
    expect(answer.retry).toBe('machine admin rename mac-m2 mac-m2');
    expect(answer.text.out).toMatch(/stored by the relay/);
    const kinds = (name: string) => newPuts().filter((q) => q.path.includes(uuidOf(name))).map((q) => (q.body as { body: { kind: string } }).body.kind).sort();
    expect(kinds('laptop')).toEqual(['notice-recipients', 'peer', 'self-registration']);
    expect(kinds('server')).toEqual(['notice-recipients', 'peer']);
    const self = inboxOf('laptop').find((d) => d.body.kind === 'self-registration') as SignedDocument;
    const verified = verifyInboxDocument(self, { adminPublicKey: admin.adminPublicKey, selfUuid: uuidOf('laptop'), now: nowSeconds(), identityPrivateKeyPkcs8: readMachine(dirOf('laptop')).identity.privateKeyPkcs8 });
    expect(verified.ok).toBe(true);
    for (const put of newPuts()) expect(put.authorization).toBe(`Bearer ${relay.adminToken}`);
    expect(JSON.stringify(answer)).not.toContain(relay.adminToken);
    expect(answer.machines.map((m) => [m.name, m.state]).sort()).toEqual([
      ['mac-m2', 'inbox'],
      ['server', 'inbox'],
    ]);
  });

  it('is served by the daemon command of the same name', async () => {
    const run = await pageRenames('laptop', 'mac-m2');
    expect(await makeCommands(adminDir, 'test', nowSeconds).renameApply(run.payload)).toMatchObject({ ok: true, failed: false });
  });

  it('a relay that refuses one machine: the rename stands, the machine is named with the retry command, and the page retries WITHOUT a passphrase', async () => {
    const run = await pageRenames('laptop', 'mac-m2');
    const first = applied(await renameApply(adminDir, run.payload, nowSeconds(), { client: refusing([uuidOf('server')]) }));
    expect(first.failed).toBe(true);
    expect(adminNames()).toEqual(['mac-m2', 'server']);
    expect(first.text.err).toContain('machine admin rename mac-m2 mac-m2');
    expect(first.machines.find((m) => m.name === 'server')).toMatchObject({ state: 'failed', code: 'not-stored' });
    expect(retainedDelivery(adminDir, uuidOf('laptop'))?.kind).toBe('rename');
    const before = inboxPuts().length;
    const second = await retryDelivery(adminDir, { uuid: uuidOf('laptop') }, nowSeconds());
    if (!second.ok) throw new Error(second.message);
    expect(second.failed).toBe(false);
    expect(second.text.out).toMatch(/stored by the relay/);
    expect(inboxPuts().slice(before).every((p) => p.path.includes(uuidOf('server')))).toBe(true);
    expect(second.machines.map((m) => [m.name, m.state]).sort()).toEqual([
      ['mac-m2', 'inbox'],
      ['server', 'inbox'],
    ]);
    expect(retainedDelivery(adminDir, uuidOf('laptop'))).toBeUndefined();
  });

  it('with no admin relay token the rename is installed HERE anyway and the answer says nobody was told, with the login command', async () => {
    const run = await pageRenames('laptop', 'mac-m2');
    unlinkSync(relayAdminFile(adminDir));
    const answer = applied(await renameApply(adminDir, run.payload, nowSeconds()));
    expect(answer.failed).toBe(true);
    expect(answer.text.err).toMatch(/admin login/);
    expect(answer.text.err).toContain('machine admin rename mac-m2 mac-m2');
    expect(adminNames()).toEqual(['mac-m2', 'server']);
    expect(newPuts()).toHaveLength(0);
    expect(retainedDelivery(adminDir, uuidOf('laptop'))?.items.length).toBeGreaterThan(0);
  });

  it('a document the page did not send is a failure naming the machine; the rename stands', async () => {
    const run = await pageRenames('laptop', 'mac-m2');
    const documents = [...run.built.documents, run.selfDocument].filter((d) => d.body.kind !== 'self-registration');
    const answer = applied(await renameApply(adminDir, { ...run.payload, documents }, nowSeconds()));
    expect(answer.failed).toBe(true);
    expect(answer.text.err).toMatch(/self-registration/);
    expect(answer.machines.find((m) => m.name === 'mac-m2')).toMatchObject({ state: 'failed' });
  });

  it('refuses another shape of payload and a machine without the admin key, nothing installed', async () => {
    const run = await pageRenames('laptop', 'mac-m2');
    expect(failure(await renameApply(adminDir, { ...run.payload, extra: 1 }, nowSeconds())).reason).toBe('bad-payload');
    expect(failure(await renameApply(adminDir, { uuid: uuidOf('laptop') }, nowSeconds())).reason).toBe('bad-payload');
    expect(failure(await renameApply(adminDir, { ...run.payload, uuid: 'nope' }, nowSeconds())).reason).toBe('bad-payload');
    expect(failure(await renameApply(dirOf('laptop'), run.payload, nowSeconds())).reason).toBe('no-admin-key');
    unchanged();
  });

  it('refuses a registration signed by another admin key, nothing installed or delivered', async () => {
    const run = await pageRenames('laptop', 'mac-m2');
    mkdirSync(dirOf('other'));
    await ok(dirOf('other'), ['init', '--name', 'other']);
    const other = makeAdmin(dirOf('other'));
    const otherKey = await unlockAdminKey(dirOf('other'), async () => other.passphrase);
    const forged = signRegistration(run.signed.body, otherKey.privateKeyPkcs8);
    const answer = failure(await renameApply(adminDir, { ...run.payload, signed: forged }, nowSeconds()));
    expect(answer.reason).toBe('bad-registration');
    expect(answer.message).toMatch(/Nothing was installed/);
    unchanged();
  });

  it.each([
    ['a serial that is not the held one + 1', (b: Body): Body => ({ ...b, serial: b.serial + 4 })],
    ['another identity key', (b: Body): Body => ({ ...b, identityPublicKey: 'A'.repeat(43) })],
    ['a longer validity than the held one', (b: Body): Body => ({ ...b, validTo: b.validTo + 86_400 })],
    ['another machine', (b: Body): Body => ({ ...b, uuid: STRANGER })],
  ])('refuses a signed registration that is not exactly the planned rename (%s): nothing installed or delivered', async (_label, mutate) => {
    const run = await pageRenames('laptop', 'mac-m2', mutate);
    const answer = failure(await renameApply(adminDir, run.payload, nowSeconds()));
    expect(['bad-registration', 'bad-payload', 'not-trusted']).toContain(answer.reason);
    expect(answer.message).toMatch(/Nothing was installed/);
    unchanged();
  });

  it('re-plans the rename HERE: a name already used, a lookalike, a local alias of another machine, the same name are refused with the planner sentence', async () => {
    const taken = await pageRenames('laptop', 'mac-m2', (b) => ({ ...b, name: 'server' }));
    const t = failure(await renameApply(adminDir, taken.payload, nowSeconds()));
    expect(t.reason).toBe('refused');
    expect(t.message).toMatch(/already used by machine "server"/);
    const lookalike = await pageRenames('laptop', 'mac-m2', (b) => ({ ...b, name: 'ser-ver' }));
    expect(failure(await renameApply(adminDir, lookalike.payload, nowSeconds())).message).toMatch(/only by hyphens/);
    await ok(adminDir, ['alias', 'set', 'box', 'server']);
    const aliased = await pageRenames('laptop', 'mac-m2', (b) => ({ ...b, name: 'box' }));
    expect(failure(await renameApply(adminDir, aliased.payload, nowSeconds())).message).toMatch(/local alias of another machine/);
    const sameName = await pageRenames('laptop', 'mac-m2', (b) => ({ ...b, name: 'laptop' }));
    expect(failure(await renameApply(adminDir, sameName.payload, nowSeconds())).message).toMatch(/nothing to change/);
    unchanged();
  });

  it('refuses a machine that was revoked, or the admin machine itself, between the context and the apply', async () => {
    const run = await pageRenames('laptop', 'mac-m2');
    await cli(adminDir, ['admin', 'revoke', 'laptop'], pass, { ask: yes });
    baseline = inboxPuts().length;
    expect(failure(await renameApply(adminDir, run.payload, nowSeconds())).reason).toBe('revoked');
    expect(failure(await renameApply(adminDir, { ...run.payload, uuid: uuidOf('desktop') }, nowSeconds())).reason).toBe('self');
    expect(newPuts()).toHaveLength(0);
  });

  it('refuses a document with another id, for a stranger, of another kind, or duplicated: nothing installed or delivered', async () => {
    const run = await pageRenames('laptop', 'mac-m2');
    const original = run.built.documents[0] as SignedDocument;
    const tampered = { ...original, body: { ...original.body, id: 'AAAAAAAAAAAAAAAAAAAAAA' } };
    expect(failure(await renameApply(adminDir, { ...run.payload, documents: [tampered] }, nowSeconds())).reason).toBe('bad-document');
    const stranger = { ...original, body: { ...original.body, to: STRANGER } };
    expect(failure(await renameApply(adminDir, { ...run.payload, documents: [stranger] }, nowSeconds())).reason).toBe('bad-document');
    expect(failure(await renameApply(adminDir, { ...run.payload, documents: [original, original] }, nowSeconds())).reason).toBe('bad-document');
    const otherKind = { ...run.selfDocument, body: { ...run.selfDocument.body, kind: 'revocation' } };
    expect(failure(await renameApply(adminDir, { ...run.payload, documents: [otherKind] }, nowSeconds())).reason).toBe('bad-document');
    unchanged();
  });

  it('refuses a notice list that is not a signed list of this network', async () => {
    const run = await pageRenames('laptop', 'mac-m2');
    expect(failure(await renameApply(adminDir, { ...run.payload, noticeRecipients: { body: {}, signature: 'x' } }, nowSeconds())).reason).toBe('bad-notice-recipients');
    unchanged();
  });
});

describe('renameApply with the real page builder (machine-webcrypto buildRename)', () => {
  it('what the page builds is accepted, installed and delivered as is', async () => {
    const context = contextOf('laptop');
    const pair = await unlockAdminKey(adminDir, pass);
    const key = await crypto.subtle.importKey('pkcs8', pair.privateKeyPkcs8 as BufferSource, 'Ed25519', false, ['sign']);
    const built = await buildRename({
      adminPrivateKey: key,
      adminPublicKey: pair.publicKey,
      adminUuid: context.adminMachine.uuid,
      current: context.current,
      newName: 'Mac M2',
      machines: context.machines,
      aliases: context.aliases,
      networkAliases: context.networkAliases,
      revokedUpTo: context.revokedUpTo ?? undefined,
      others: context.others,
      noticeRecipients: context.noticeRecipients,
      now: nowSeconds(),
    });
    expect(built.failures).toEqual([]);
    const answer = applied(await renameApply(adminDir, { uuid: context.machine.uuid, signed: built.signed, documents: built.documents, noticeRecipients: built.noticeRecipients }, nowSeconds()));
    expect(answer.failed).toBe(false);
    expect(adminNames()).toEqual(['mac-m2', 'server']);
    expect(answer.subject.name).toBe('mac-m2');
  });
});
