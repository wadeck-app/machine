import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keyId, newCandidacyRandom, verifyInboxDocument, type SignedDocument, type SignedRegistration } from '@wadeck-app/machine-core';
import { buildApproval, buildDistribution, buildRevocation, type BuiltDistribution, type BuiltRevocation } from '@wadeck-app/machine-webcrypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unlockAdminKey } from './admin.js';
import { approveDistribute, type ApproveDistributeAnswer } from './approveDistribute.js';
import { approveContext, importCandidate } from './candidateImport.js';
import { makeCommands } from './commands.js';
import { clearRetainedDeliveries, retainedDelivery, retryDelivery, type RetryDeliveryAnswer } from './deliveryRetry.js';
import type { DirectDelivery } from './directDelivery.js';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { readMachine } from './identity.js';
import { exportMachineInfo, installedRevocations } from './network.js';
import { createRelayClient, RelayError, type RelayClient } from './relayClient.js';
import { relayAdminFile } from './relayStore.js';
import { revokeApply, revokeContext, type RevokeApplyAnswer } from './revokeFromPage.js';
import { cli, makeAdmin, ok, type TestAdmin } from './testing.js';

// Retry delivery: the documents the page signed and the daemon verified are kept in the MEMORY of the daemon when some were not stored, and sent again without a
// passphrase. Same scaffolding as approveDistribute.test.ts and revokeFromPage.test.ts.

let root: string;
let adminDir: string;
let relay: FakeRelay;
let admin: TestAdmin;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const dirOf = (name: string) => join(root, name);
const uuidOf = (name: string) => readMachine(dirOf(name)).uuid;
const pass = async () => admin.passphrase;
const yes = async () => 'y';

beforeEach(async () => {
  clearRetainedDeliveries();
  root = mkdtempSync(join(tmpdir(), 'machine-deliveryretry-'));
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
  clearRetainedDeliveries();
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

async function enroll(name: string): Promise<void> {
  const info = exportMachineInfo(dirOf(name));
  relay.addCandidacy(`cand-${name}`, { name: info.name, hostname: 'h', identityPublicKey: info.identityPublicKey, random: newCandidacyRandom(), uuid: info.uuid });
  const result = await cli(adminDir, ['admin', 'approve', `cand-${name}`, '--relay', relay.url], pass, { ask: yes });
  expect(result.code, result.err).toBe(0);
}

const realClient = (): RelayClient => createRelayClient({ baseUrl: relay.url, token: relay.adminToken });
/** A relay client that refuses the documents of the given machines (500: not an abort) and otherwise is the real one. */
const refusing = (uuids: string[], deleteFails = false): RelayClient => {
  const real = realClient();
  return {
    putInboxDocument: async (to: string, document: { body: { id: string } }) => {
      if (uuids.includes(to)) throw new RelayError({ status: 500, message: 'boom' });
      return real.putInboxDocument(to, document);
    },
    deleteMachine: async (uuid: string) => {
      if (deleteFails) throw new RelayError({ status: 500, message: 'boom' });
      return real.deleteMachine(uuid);
    },
  } as unknown as RelayClient;
};
const inboxPuts = () => relay.requests.filter((q) => q.method === 'PUT' && /\/inbox\//.test(q.path));
const deletes = () => relay.requests.filter((q) => q.method === 'DELETE').map((q) => q.path);
const inboxOf = (name: string) => relay.inbox(uuidOf(name)).map((d) => d.document as SignedDocument);

const okAnswer = (answer: ApproveDistributeAnswer | RevokeApplyAnswer) => {
  if (!answer.ok) throw new Error(`${answer.reason}: ${answer.message}`);
  return answer;
};
const retried = (answer: RetryDeliveryAnswer) => {
  if (!answer.ok) throw new Error(`${answer.reason}: ${answer.message}`);
  return answer;
};
const failure = (answer: { ok: boolean }): { reason: string; message: string } => {
  const a = answer as { ok: boolean; reason?: string; message?: string };
  if (a.ok) throw new Error(`expected a refusal, got ${JSON.stringify(answer)}`);
  return a as { reason: string; message: string };
};
const stateOf = (answer: { machines: Array<{ name: string; state: string; code: string }> }, name: string) => answer.machines.find((m) => m.name === name);

interface ApprovalRun {
  built: BuiltDistribution;
  payload: Record<string, unknown>;
}

/** What the page does after one passphrase: the approval of the server, its import, then the documents. The laptop is a trusted peer already. */
async function pageApprovesServer(): Promise<ApprovalRun> {
  const context = approveContext(adminDir, { candidateUuid: uuidOf('server') }, nowSeconds());
  if (!context.ok) throw new Error(`test: ${context.message}`);
  const pair = await unlockAdminKey(adminDir, pass);
  const key = await crypto.subtle.importKey('pkcs8', pair.privateKeyPkcs8 as BufferSource, 'Ed25519', false, ['sign']);
  const candidate = readMachine(dirOf('server'));
  const now = nowSeconds();
  const approved = await buildApproval({
    adminPrivateKey: key,
    adminPublicKey: pair.publicKey,
    adminKeyId: keyId(pair.publicKey),
    candidate: { uuid: candidate.uuid, name: candidate.name, identityPublicKey: candidate.identity.publicKey, random: newCandidacyRandom() },
    adminMachine: context.adminMachine,
    now,
    validForDays: 90,
  });
  const imported = await importCandidate(adminDir, { ...approved.adminImport }, now);
  expect(imported.ok, JSON.stringify(imported)).toBe(true);
  const built = await buildDistribution({
    adminPrivateKey: key,
    adminPublicKey: pair.publicKey,
    adminUuid: context.adminMachine.uuid,
    subject: approved.registrations.candidate,
    others: context.others as SignedRegistration[],
    noticeRecipients: context.noticeRecipients as never,
    now,
  });
  return { built, payload: { candidateUuid: candidate.uuid, documents: built.documents, noticeRecipients: built.noticeRecipients } };
}

interface RevocationRun {
  built: BuiltRevocation;
  payload: Record<string, unknown>;
}

/** What the page does after one passphrase: the list and the documents for the peers that stay trusted. */
async function pageRevokesLaptop(): Promise<RevocationRun> {
  const context = revokeContext(adminDir, { uuid: uuidOf('laptop') }, nowSeconds());
  if (!context.ok) throw new Error(`test: ${context.message}`);
  const pair = await unlockAdminKey(adminDir, pass);
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
  return { built, payload: { uuid: context.revoked.uuid, signed: built.signed, documents: built.documents, noticeRecipients: built.noticeRecipients } };
}

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile());

describe('retained deliveries after an approval from the page', () => {
  it('a partial failure is kept in memory, then a retry delivers only what is missing; a machine told the first time stays told', async () => {
    await enroll('laptop');
    const run = await pageApprovesServer();
    const first = okAnswer(await approveDistribute(adminDir, run.payload, nowSeconds(), { client: refusing([uuidOf('laptop')]) }));
    expect(first.failed).toBe(true);
    expect(stateOf(first, 'laptop')).toMatchObject({ state: 'failed', code: 'not-stored' });
    expect(stateOf(first, 'server')).toMatchObject({ state: 'inbox' });
    expect(retainedDelivery(adminDir, uuidOf('server'))?.items.map((i) => [i.to.name, i.kind])).toEqual([
      ['laptop', 'peer'],
      ['laptop', 'notice-recipients'],
    ]);

    const before = inboxPuts().length;
    const second = retried(await retryDelivery(adminDir, { uuid: uuidOf('server') }, nowSeconds()));
    expect(second.failed).toBe(false);
    expect(second.subject).toEqual({ uuid: uuidOf('server'), name: 'server' });
    expect(second.retry).toBe(`machine admin distribute ${uuidOf('server')}`);
    expect(second.machines.map((m) => [m.name, m.state, m.code])).toEqual([
      ['laptop', 'inbox', 'inbox'],
      ['server', 'inbox', 'inbox'],
    ]);
    // Only the two documents of the laptop were sent again, to the laptop.
    const sent = inboxPuts().slice(before);
    expect(sent).toHaveLength(2);
    for (const put of sent) expect(put.path).toContain(uuidOf('laptop'));
    const delivered = inboxOf('laptop').map((d) => verifyInboxDocument(d, { adminPublicKey: admin.adminPublicKey, selfUuid: uuidOf('laptop'), now: nowSeconds(), identityPrivateKeyPkcs8: readMachine(dirOf('laptop')).identity.privateKeyPkcs8 }));
    expect(delivered.some((v) => v.ok && v.kind === 'peer' && v.registration.uuid === uuidOf('server'))).toBe(true);
    // Nothing is left: a third click is told so.
    expect(retainedDelivery(adminDir, uuidOf('server'))).toBeUndefined();
    expect(failure(await retryDelivery(adminDir, { uuid: uuidOf('server') }, nowSeconds())).reason).toBe('nothing-retained');
  });

  it('a machine that took the documents directly the first time is still reported delivered after the retry', async () => {
    await enroll('laptop');
    const run = await pageApprovesServer();
    const serverUuid = uuidOf('server');
    const direct: DirectDelivery = async (to) => (to.uuid === serverUuid ? { ok: true, outcome: 'installed', ms: 1 } : { ok: false, code: 'unreachable', cause: 'offline', ms: 1 });
    const first = okAnswer(await approveDistribute(adminDir, run.payload, nowSeconds(), { client: refusing([uuidOf('laptop')]), direct }));
    expect(stateOf(first, 'server')).toMatchObject({ state: 'delivered', code: 'direct' });
    const second = retried(await retryDelivery(adminDir, { uuid: serverUuid }, nowSeconds()));
    expect(second.failed).toBe(false);
    expect(stateOf(second, 'server')).toMatchObject({ state: 'delivered', code: 'direct' });
    expect(stateOf(second, 'laptop')).toMatchObject({ state: 'inbox' });
  });

  it('a retry that still fails reports the machine failed, keeps the documents, and a later retry can finish', async () => {
    await enroll('laptop');
    const run = await pageApprovesServer();
    okAnswer(await approveDistribute(adminDir, run.payload, nowSeconds(), { client: refusing([uuidOf('laptop')]) }));
    const again = retried(await retryDelivery(adminDir, { uuid: uuidOf('server') }, nowSeconds(), { client: refusing([uuidOf('laptop')]) }));
    expect(again.failed).toBe(true);
    expect(stateOf(again, 'laptop')).toMatchObject({ state: 'failed', code: 'not-stored' });
    expect(stateOf(again, 'server')).toMatchObject({ state: 'inbox' });
    expect(again.text.err).toContain(`machine admin distribute ${uuidOf('server')}`);
    expect(retainedDelivery(adminDir, uuidOf('server'))?.items).toHaveLength(2);
    const last = retried(await retryDelivery(adminDir, { uuid: uuidOf('server') }, nowSeconds()));
    expect(last.failed).toBe(false);
  });

  it('a document the page did not send stays a failure in every report, with the CLI command, while the rest is retried', async () => {
    await enroll('laptop');
    const run = await pageApprovesServer();
    const peerToLaptop = run.built.documents.findIndex((d) => d.body.kind === 'peer' && d.body.to === uuidOf('laptop'));
    const documents = run.built.documents.filter((_, i) => i !== peerToLaptop);
    // The server's documents are refused as well, so there is something to retry.
    const first = okAnswer(await approveDistribute(adminDir, { ...run.payload, documents }, nowSeconds(), { client: refusing([uuidOf('server')]) }));
    expect(first.failed).toBe(true);
    const second = retried(await retryDelivery(adminDir, { uuid: uuidOf('server') }, nowSeconds()));
    expect(second.failed).toBe(true);
    expect(second.report.failures.map((f) => f.toUuid)).toEqual([uuidOf('laptop')]);
    expect(second.text.err).toContain(`machine admin distribute ${uuidOf('server')}`);
    expect(stateOf(second, 'laptop')).toMatchObject({ state: 'failed', code: 'not-stored' });
    expect(stateOf(second, 'server')).toMatchObject({ state: 'inbox' });
    // Everything that could be sent was sent: no retry is offered any more.
    expect(failure(await retryDelivery(adminDir, { uuid: uuidOf('server') }, nowSeconds())).reason).toBe('nothing-retained');
  });

  it('a run that delivered everything retains nothing and forgets an older entry of the same subject', async () => {
    await enroll('laptop');
    const run = await pageApprovesServer();
    okAnswer(await approveDistribute(adminDir, run.payload, nowSeconds(), { client: refusing([uuidOf('laptop')]) }));
    expect(retainedDelivery(adminDir, uuidOf('server'))).toBeDefined();
    okAnswer(await approveDistribute(adminDir, run.payload, nowSeconds()));
    expect(retainedDelivery(adminDir, uuidOf('server'))).toBeUndefined();
  });

  it('keeps the documents in memory only: no file of the config directory holds them', async () => {
    await enroll('laptop');
    const run = await pageApprovesServer();
    okAnswer(await approveDistribute(adminDir, run.payload, nowSeconds(), { client: refusing([uuidOf('laptop')]) }));
    const kept = retainedDelivery(adminDir, uuidOf('server'))?.items ?? [];
    expect(kept.length).toBeGreaterThan(0);
    const listing = filesUnder(adminDir).sort();
    for (const file of listing) {
      const text = readFileSync(file, 'utf8');
      for (const item of kept) expect(text, file).not.toContain(item.document.signature);
    }
    // A refusal of the retry writes nothing either.
    await retryDelivery(adminDir, { uuid: uuidOf('laptop') }, nowSeconds());
    expect(filesUnder(adminDir).sort()).toEqual(listing);
  });

  it('refuses with nothing-retained when the daemon holds nothing, naming the memory-only rule and the CLI command', async () => {
    const answer = failure(await retryDelivery(adminDir, { uuid: uuidOf('server') }, nowSeconds()));
    expect(answer.reason).toBe('nothing-retained');
    expect(answer.message).toMatch(/only in memory/);
    expect(answer.message).toMatch(/restarts/);
    expect(answer.message).toContain(`machine admin distribute ${uuidOf('server')}`);
    expect(answer.message).toMatch(/passphrase/);
  });

  it('refuses an expired kept document (bad-document) with the CLI command, sends nothing and forgets it', async () => {
    await enroll('laptop');
    const run = await pageApprovesServer();
    okAnswer(await approveDistribute(adminDir, run.payload, nowSeconds(), { client: refusing([uuidOf('laptop')]) }));
    const before = inboxPuts().length;
    const answer = failure(await retryDelivery(adminDir, { uuid: uuidOf('server') }, nowSeconds() + 60 * 24 * 3600));
    expect(answer.reason).toBe('bad-document');
    expect(answer.message).toContain(`machine admin distribute ${uuidOf('server')}`);
    expect(inboxPuts()).toHaveLength(before);
    expect(failure(await retryDelivery(adminDir, { uuid: uuidOf('server') }, nowSeconds())).reason).toBe('nothing-retained');
  });

  it('with no admin relay token: no-admin-token naming the login command, the documents are kept', async () => {
    await enroll('laptop');
    const run = await pageApprovesServer();
    okAnswer(await approveDistribute(adminDir, run.payload, nowSeconds(), { client: refusing([uuidOf('laptop')]) }));
    unlinkSync(relayAdminFile(adminDir));
    const answer = failure(await retryDelivery(adminDir, { uuid: uuidOf('server') }, nowSeconds()));
    expect(answer.reason).toBe('no-admin-token');
    expect(answer.message).toMatch(/admin login/);
    expect(retainedDelivery(adminDir, uuidOf('server'))).toBeDefined();
  });

  it('refuses a machine without the admin key and any payload other than exactly { uuid }', async () => {
    expect(failure(await retryDelivery(dirOf('laptop'), { uuid: uuidOf('server') }, nowSeconds())).reason).toBe('no-admin-key');
    for (const payload of [undefined, null, [], {}, { uuid: 'nope' }, { uuid: uuidOf('server'), extra: 1 }, { uuid: 5 }]) {
      expect(failure(await retryDelivery(adminDir, payload, nowSeconds())).reason).toBe('bad-payload');
    }
  });

  it('is served by the daemon command of the same name', async () => {
    await enroll('laptop');
    const run = await pageApprovesServer();
    const commands = makeCommands(adminDir, 'test', nowSeconds);
    okAnswer(await approveDistribute(adminDir, run.payload, nowSeconds(), { client: refusing([uuidOf('laptop')]) }));
    expect(await commands.retryDelivery({ uuid: uuidOf('server') })).toMatchObject({ ok: true, failed: false });
  });
});

describe('retained deliveries after a revocation from the page', () => {
  it('a revoked machine that could not be removed from the relay is retried, the documents already delivered are not sent again', async () => {
    await enroll('laptop');
    await enroll('server');
    const run = await pageRevokesLaptop();
    const first = okAnswer(await revokeApply(adminDir, run.payload, nowSeconds(), { client: refusing([], true) }));
    expect(first.failed).toBe(true);
    expect(stateOf(first, 'laptop')).toMatchObject({ state: 'failed', reason: 'not removed from the relay' });
    const before = inboxPuts().length;
    const second = retried(await retryDelivery(adminDir, { uuid: uuidOf('laptop') }, nowSeconds()));
    expect(second.failed).toBe(false);
    expect(second.subject).toEqual({ uuid: uuidOf('laptop'), name: 'laptop' });
    expect(second.machines.map((m) => [m.name, m.state])).toEqual([['server', 'inbox']]);
    expect(inboxPuts()).toHaveLength(before);
    expect(deletes().some((p) => p.includes(uuidOf('laptop')))).toBe(true);
    expect(installedRevocations(adminDir)).toHaveLength(1);
    expect(retainedDelivery(adminDir, uuidOf('laptop'))).toBeUndefined();
  });

  it('a peer whose documents were refused is retried together with the removal of the revoked machine', async () => {
    await enroll('laptop');
    await enroll('server');
    const run = await pageRevokesLaptop();
    const first = okAnswer(await revokeApply(adminDir, run.payload, nowSeconds(), { client: refusing([uuidOf('server')]) }));
    expect(stateOf(first, 'server')).toMatchObject({ state: 'failed', code: 'not-stored' });
    const second = retried(await retryDelivery(adminDir, { uuid: uuidOf('laptop') }, nowSeconds()));
    expect(second.failed).toBe(false);
    expect(stateOf(second, 'server')).toMatchObject({ state: 'inbox' });
    expect(inboxOf('server').some((d) => d.body.kind === 'revocation')).toBe(true);
    expect(retainedDelivery(adminDir, uuidOf('laptop'))).toBeUndefined();
  });

  it('a revocation applied with no admin token is kept whole: after the login, the retry tells the peers and removes the machine', async () => {
    await enroll('laptop');
    await enroll('server');
    const run = await pageRevokesLaptop();
    const saved = readFileSync(relayAdminFile(adminDir));
    unlinkSync(relayAdminFile(adminDir));
    const first = okAnswer(await revokeApply(adminDir, run.payload, nowSeconds()));
    expect(first.failed).toBe(true);
    expect(failure(await retryDelivery(adminDir, { uuid: uuidOf('laptop') }, nowSeconds())).reason).toBe('no-admin-token');
    writeFileSync(relayAdminFile(adminDir), saved);
    const second = retried(await retryDelivery(adminDir, { uuid: uuidOf('laptop') }, nowSeconds()));
    expect(second.failed).toBe(false);
    expect(deletes().some((p) => p.includes(uuidOf('laptop')))).toBe(true);
    expect(inboxOf('server').some((d) => d.body.kind === 'revocation')).toBe(true);
  });
});
