import { mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keyId, newCandidacyRandom, verifyInboxDocument, type SignedDocument, type SignedRegistration } from '@wadeck-app/machine-core';
import { buildRevocation, signBody, type BuiltRevocation } from '@wadeck-app/machine-webcrypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unlockAdminKey } from './admin.js';
import { makeCommands } from './commands.js';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { readMachine } from './identity.js';
import { exportMachineInfo, installedRevocations, loadNetwork } from './network.js';
import { relayAdminFile } from './relayStore.js';
import { createRelayClient, RelayError, type RelayClient } from './relayClient.js';
import { revokeApply, revokeContext, type RevokeApplyAnswer, type RevokeContextOk } from './revokeFromPage.js';
import { cli, makeAdmin, ok, type TestAdmin } from './testing.js';

// Revoke from the page (admin-ui.md, "Revoke from the page"). The BROWSER signs the revocation list and the documents for the peers that stay trusted (machine-webcrypto
// `buildRevocation`); the daemon of the admin machine verifies them against the pinned admin key, installs the list here and delivers the documents with the code of
// `machine admin revoke` / `distribute` (same report, same words). It never receives a passphrase or an unlocked key and signs nothing.

let root: string;
let adminDir: string;
let relay: FakeRelay;
let admin: TestAdmin;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const dirOf = (name: string) => join(root, name);
const uuidOf = (name: string) => readMachine(dirOf(name)).uuid;
const pass = async () => admin.passphrase;
const yes = async () => 'y';

async function enroll(name: string): Promise<void> {
  const info = exportMachineInfo(dirOf(name));
  relay.addCandidacy(`cand-${name}`, { name: info.name, hostname: 'h', identityPublicKey: info.identityPublicKey, random: newCandidacyRandom(), uuid: info.uuid });
  const result = await cli(adminDir, ['admin', 'approve', `cand-${name}`, '--relay', relay.url], pass, { ask: yes });
  expect(result.code, result.err).toBe(0);
}

beforeEach(async () => {
  baseline = 0;
  root = mkdtempSync(join(tmpdir(), 'machine-revokepage-'));
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
let baseline = 0;
const newPuts = () => inboxPuts().slice(baseline);
const deletes = () => relay.requests.filter((q) => q.method === 'DELETE').map((q) => q.path);
const inboxOf = (name: string) => relay.inbox(uuidOf(name)).map((d) => d.document as SignedDocument);
const failure = (answer: { ok: boolean }): { reason: string; message: string } => {
  const a = answer as { ok: boolean; reason?: string; message?: string };
  if (a.ok) throw new Error(`expected a refusal, got ${JSON.stringify(answer)}`);
  return a as { reason: string; message: string };
};
const contextOf = (name: string, dir = adminDir): RevokeContextOk => {
  const context = revokeContext(dir, { uuid: uuidOf(name) }, nowSeconds());
  if (!context.ok) throw new Error(`test: ${context.message}`);
  return context;
};

interface PageRun {
  context: RevokeContextOk;
  built: BuiltRevocation;
  payload: Record<string, unknown>;
}

/** What the page does after one passphrase: the context, then the list and the documents, signed with a non-extractable key. */
async function pageRevokes(name: string, dir = adminDir, passphrase = admin.passphrase): Promise<PageRun> {
  const context = contextOf(name, dir);
  const pair = await unlockAdminKey(dir, async () => passphrase);
  const key = await crypto.subtle.importKey('pkcs8', pair.privateKeyPkcs8 as BufferSource, 'Ed25519', false, ['sign']);
  const built = await buildRevocation({
    adminPrivateKey: key,
    adminPublicKey: pair.publicKey,
    adminUuid: context.adminMachine.uuid,
    revoked: { uuid: context.revoked.uuid, serial: context.revoked.serial },
    held: context.held,
    recipients: context.recipients,
    noticeRecipients: context.noticeRecipients,
    now: nowSeconds(),
  });
  return { context, built, payload: { uuid: context.revoked.uuid, signed: built.signed, documents: built.documents, noticeRecipients: built.noticeRecipients } };
}

const applied = (answer: RevokeApplyAnswer) => {
  if (!answer.ok) throw new Error(`${answer.reason}: ${answer.message}`);
  return answer;
};

describe('revokeContext: what the page needs before it asks the passphrase', () => {
  it('the machine to revoke (name, uuid, highest serial), what is installed, the registrations of the peers that STAY trusted, the stored list of notice recipients', () => {
    const context = contextOf('laptop');
    expect(context.revoked).toMatchObject({ uuid: uuidOf('laptop'), name: 'laptop', serial: expect.any(Number) });
    expect(context.revoked.keyId).toBe(keyId(exportMachineInfo(dirOf('laptop')).identityPublicKey));
    expect(context.adminMachine).toEqual({ uuid: uuidOf('desktop'), name: 'desktop' });
    expect(context.adminPublicKey).toBe(admin.adminPublicKey);
    expect(context.held).toEqual({ entries: [], version: 0 });
    expect(context.recipients.map((r: SignedRegistration) => r.body.uuid)).toEqual([uuidOf('server')]);
    expect(context.noticeRecipients?.body.recipients).toEqual([uuidOf('desktop')]);
  });

  it('refuses this machine itself, a machine it does not trust, a bad payload and a machine without the admin key, each with the way out', () => {
    expect(failure(revokeContext(adminDir, { uuid: uuidOf('desktop') }, nowSeconds()))).toMatchObject({ reason: 'self' });
    expect(failure(revokeContext(adminDir, { uuid: uuidOf('desktop') }, nowSeconds())).message).toMatch(/admin machine itself/);
    const stranger = failure(revokeContext(adminDir, { uuid: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f' }, nowSeconds()));
    expect(stranger.reason).toBe('not-trusted');
    expect(stranger.message).toMatch(/not a trusted peer/);
    expect(failure(revokeContext(adminDir, { uuid: 'nope' }, nowSeconds())).reason).toBe('bad-payload');
    expect(failure(revokeContext(adminDir, { uuid: uuidOf('laptop'), extra: 1 }, nowSeconds())).reason).toBe('bad-payload');
    expect(failure(revokeContext(dirOf('laptop'), { uuid: uuidOf('server') }, nowSeconds())).reason).toBe('no-admin-key');
  });

  it('is served by the daemon command of the same name', () => {
    expect(makeCommands(adminDir, 'test', nowSeconds).revokeContext({ uuid: uuidOf('laptop') })).toMatchObject({ ok: true, revoked: { name: 'laptop' } });
  });
});

describe('revokeApply: verify what the page signed, install it here, tell the peers like machine admin revoke', () => {
  it('installs the list on this machine (the machine leaves the trusted ones), delivers the document to the peer that stays, removes the revoked machine from the relay', async () => {
    const run = await pageRevokes('laptop');
    const answer = applied(await revokeApply(adminDir, run.payload, nowSeconds()));
    expect(answer.failed).toBe(false);
    expect(answer.report.failures).toEqual([]);
    expect(installedRevocations(adminDir)).toEqual([{ uuid: uuidOf('laptop'), serial: run.context.revoked.serial }]);
    expect(loadNetwork(adminDir, nowSeconds()).directory.find(uuidOf('laptop'))).toBeUndefined();
    const delivered = inboxOf('server').map((d) =>
      verifyInboxDocument(d, { adminPublicKey: admin.adminPublicKey, selfUuid: uuidOf('server'), now: nowSeconds(), identityPrivateKeyPkcs8: readMachine(dirOf('server')).identity.privateKeyPkcs8 }),
    );
    const revocation = delivered.find((v) => v.ok && v.kind === 'revocation');
    if (revocation === undefined || !revocation.ok || revocation.kind !== 'revocation') throw new Error('expected a verified revocation document in the inbox of the server');
    expect(revocation.revocation).toEqual(run.built.signed);
    expect(deletes()).toContain(`/api/machines/${uuidOf('laptop')}`);
    // Only the admin token delivers; no document goes to the revoked machine.
    for (const put of newPuts()) expect(put.authorization).toBe(`Bearer ${relay.adminToken}`);
    expect(newPuts().some((p) => p.path.includes(uuidOf('laptop')))).toBe(false);
    expect(answer.machines.map((m) => [m.name, m.state, m.code])).toEqual([['server', 'inbox', 'inbox']]);
    expect(answer.text.out).toMatch(/stored by the relay for 1 machine/);
    expect(answer.retry).toBe(`machine admin distribute ${uuidOf('laptop')}`);
    expect(JSON.stringify(answer)).not.toContain(relay.adminToken);
  });

  it('is served by the daemon command of the same name', async () => {
    const run = await pageRevokes('laptop');
    expect(await makeCommands(adminDir, 'test', nowSeconds).revokeApply(run.payload)).toMatchObject({ ok: true, failed: false });
  });

  it('the CLI retry `machine admin distribute <uuid>` finds the page list as its own: nothing new is signed, the relay already holds the documents', async () => {
    const run = await pageRevokes('laptop');
    applied(await revokeApply(adminDir, run.payload, nowSeconds()));
    const retry = await cli(adminDir, ['admin', 'distribute', uuidOf('laptop')], pass);
    expect(retry.code, retry.err).toBe(0);
    expect(installedRevocations(adminDir)).toEqual([{ uuid: uuidOf('laptop'), serial: run.context.revoked.serial }]);
  });

  it('a retry of the same payload is refused: the machine is revoked already, and the answer names the CLI retry', async () => {
    const run = await pageRevokes('laptop');
    applied(await revokeApply(adminDir, run.payload, nowSeconds()));
    const again = failure(await revokeApply(adminDir, run.payload, nowSeconds()));
    expect(again.reason).toBe('not-trusted');
    expect(again.message).toContain(`machine admin distribute ${uuidOf('laptop')}`);
  });

  it('with no peer left to tell: the list is installed and the relay record removed, no document', async () => {
    await cli(adminDir, ['admin', 'revoke', 'server'], pass, { ask: yes });
    baseline = inboxPuts().length;
    const run = await pageRevokes('laptop');
    expect(run.context.recipients).toEqual([]);
    const answer = applied(await revokeApply(adminDir, run.payload, nowSeconds()));
    expect(answer.machines).toEqual([]);
    expect(answer.text.out).toMatch(/no other peer to inform/);
    expect(newPuts()).toHaveLength(0);
    expect(deletes()).toContain(`/api/machines/${uuidOf('laptop')}`);
  });

  it('refuses a list signed by another admin key: nothing is installed, nothing is delivered', async () => {
    const run = await pageRevokes('laptop');
    mkdirSync(dirOf('other'));
    await ok(dirOf('other'), ['init', '--name', 'other']);
    const other = makeAdmin(dirOf('other'));
    const otherKey = await unlockAdminKey(dirOf('other'), async () => other.passphrase);
    const key = await crypto.subtle.importKey('pkcs8', otherKey.privateKeyPkcs8 as BufferSource, 'Ed25519', false, ['sign']);
    const body = { ...run.built.signed.body, adminKeyId: keyId(otherKey.publicKey) };
    const forged = await signBody('machine/revocation/v1', body as never, key);
    const answer = failure(await revokeApply(adminDir, { ...run.payload, signed: forged }, nowSeconds()));
    expect(answer.reason).toBe('bad-revocation');
    expect(answer.message).toMatch(/Nothing was installed/);
    expect(installedRevocations(adminDir)).toEqual([]);
    expect(newPuts()).toHaveLength(0);
  });

  it('refuses a list that revokes something else than the machine asked for (an extra entry), loudly', async () => {
    const run = await pageRevokes('laptop');
    const pair = await unlockAdminKey(adminDir, pass);
    const key = await crypto.subtle.importKey('pkcs8', pair.privateKeyPkcs8 as BufferSource, 'Ed25519', false, ['sign']);
    const extra = await buildRevocation({ adminPrivateKey: key, adminPublicKey: pair.publicKey, adminUuid: uuidOf('desktop'), revoked: { uuid: uuidOf('laptop'), serial: run.context.revoked.serial }, held: { entries: [{ uuid: uuidOf('server'), serial: 5 }], version: 0 }, recipients: [], noticeRecipients: run.context.noticeRecipients, now: nowSeconds() });
    const answer = failure(await revokeApply(adminDir, { ...run.payload, signed: extra.signed }, nowSeconds()));
    expect(answer.reason).toBe('bad-revocation');
    expect(answer.message).toMatch(/Nothing was installed/);
    expect(installedRevocations(adminDir)).toEqual([]);
  });

  it('refuses a list that does not cover what was revoked meanwhile (the page was stale): reload and revoke again, nothing installed', async () => {
    const run = await pageRevokes('laptop');
    // Another revocation lands between the context and the apply.
    const cliRevoke = await cli(adminDir, ['admin', 'revoke', 'server'], pass, { ask: yes });
    expect(cliRevoke.code, cliRevoke.err).toBe(0);
    baseline = inboxPuts().length;
    const answer = failure(await revokeApply(adminDir, run.payload, nowSeconds()));
    expect(answer.reason).toBe('stale-revocation');
    expect(answer.message).toMatch(/reload the page/);
    expect(installedRevocations(adminDir).map((e) => e.uuid)).toEqual([uuidOf('server')]);
    expect(newPuts()).toHaveLength(0);
  });

  it('refuses a document signed by another key, another id, a stranger, a duplicate: nothing is installed or delivered', async () => {
    const run = await pageRevokes('laptop');
    const original = run.built.documents[0] as SignedDocument;
    const tampered = { ...original, body: { ...original.body, id: 'AAAAAAAAAAAAAAAAAAAAAA' } };
    expect(failure(await revokeApply(adminDir, { ...run.payload, documents: [tampered] }, nowSeconds())).reason).toBe('bad-document');
    const stranger = { ...original, body: { ...original.body, to: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f' } };
    expect(failure(await revokeApply(adminDir, { ...run.payload, documents: [stranger] }, nowSeconds())).reason).toBe('bad-document');
    expect(failure(await revokeApply(adminDir, { ...run.payload, documents: [original, original] }, nowSeconds())).reason).toBe('bad-document');
    expect(installedRevocations(adminDir)).toEqual([]);
    expect(newPuts()).toHaveLength(0);
  });

  it('a document the page did not send is a failure naming the machine and the exact retry command; the revocation stands', async () => {
    const run = await pageRevokes('laptop');
    const documents = run.built.documents.filter((d) => d.body.kind !== 'revocation');
    const answer = applied(await revokeApply(adminDir, { ...run.payload, documents }, nowSeconds()));
    expect(answer.failed).toBe(true);
    expect(answer.text.err).toContain(`machine admin distribute ${uuidOf('laptop')}`);
    expect(answer.machines.find((m) => m.uuid === uuidOf('server'))).toMatchObject({ state: 'failed', code: 'not-stored' });
    expect(installedRevocations(adminDir)).toHaveLength(1);
  });

  it('a relay that refuses is a failure with the retry command, the revocation stands (installed here)', async () => {
    const run = await pageRevokes('laptop');
    const client = { putInboxDocument: async () => { throw new RelayError({ status: 500, message: 'boom' }); }, deleteMachine: async () => undefined } as unknown as RelayClient;
    const answer = applied(await revokeApply(adminDir, run.payload, nowSeconds(), { client }));
    expect(answer.failed).toBe(true);
    expect(answer.text.err).toContain(`machine admin distribute ${uuidOf('laptop')}`);
    expect(answer.text.err).toMatch(/nothing was undone/);
    expect(installedRevocations(adminDir)).toHaveLength(1);
  });

  it('the revoked machine that cannot be removed from the relay is its own line of the answer, with the retry command', async () => {
    const run = await pageRevokes('laptop');
    const real = createRelayClient({ baseUrl: relay.url, token: relay.adminToken });
    const client = { ...real, putInboxDocument: real.putInboxDocument.bind(real), deleteMachine: async () => { throw new RelayError({ status: 500, message: 'boom' }); } } as unknown as RelayClient;
    const answer = applied(await revokeApply(adminDir, run.payload, nowSeconds(), { client }));
    expect(answer.failed).toBe(true);
    const line = answer.machines.find((m) => m.uuid === uuidOf('laptop'));
    expect(line).toMatchObject({ state: 'failed', reason: 'not removed from the relay' });
    expect(line?.next).toContain(`machine admin distribute ${uuidOf('laptop')}`);
    expect(answer.machines.find((m) => m.uuid === uuidOf('server'))?.state).toBe('inbox');
  });

  it('with no admin relay token the revocation is installed HERE anyway (it restricts) and the answer says the others were not told, with the login command', async () => {
    const run = await pageRevokes('laptop');
    unlinkSync(relayAdminFile(adminDir));
    const answer = applied(await revokeApply(adminDir, run.payload, nowSeconds()));
    expect(answer.failed).toBe(true);
    expect(answer.text.err).toMatch(/admin login/);
    expect(answer.text.err).toContain(`machine admin distribute ${uuidOf('laptop')}`);
    expect(installedRevocations(adminDir)).toHaveLength(1);
    expect(answer.machines.map((m) => m.state)).toEqual(['failed']);
    expect(newPuts()).toHaveLength(0);
  });

  it('refuses another shape of payload and a machine without the admin key', async () => {
    const run = await pageRevokes('laptop');
    expect(failure(await revokeApply(adminDir, { ...run.payload, extra: 1 }, nowSeconds())).reason).toBe('bad-payload');
    expect(failure(await revokeApply(adminDir, { uuid: uuidOf('laptop') }, nowSeconds())).reason).toBe('bad-payload');
    expect(failure(await revokeApply(adminDir, { ...run.payload, uuid: 'nope' }, nowSeconds())).reason).toBe('bad-payload');
    expect(failure(await revokeApply(dirOf('laptop'), run.payload, nowSeconds())).reason).toBe('no-admin-key');
    expect(installedRevocations(adminDir)).toEqual([]);
  });
});
