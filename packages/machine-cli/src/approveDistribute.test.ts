import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { derivePairSecretV2, keyId, newCandidacyRandom, openPairSecret, verifyInboxDocument, type SignedDocument, type SignedRegistration } from '@wadeck-app/machine-core';
import { buildApproval, buildDistribution, type BuiltDistribution } from '@wadeck-app/machine-webcrypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unlockAdminKey } from './admin.js';
import { approveContext, importCandidate, type ApproveContextOk } from './candidateImport.js';
import { approveDistribute, type ApproveDistributeAnswer } from './approveDistribute.js';
import { makeCommands } from './commands.js';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { readMachine } from './identity.js';
import { exportMachineInfo } from './network.js';
import { readNoticeRecipients } from './noticeRecipientsStore.js';
import { RelayError, type RelayClient } from './relayClient.js';
import { cli, makeAdmin, ok, type TestAdmin } from './testing.js';

// Approve from the page, lot 5: the documents that tell the other peers about the new machine. The BROWSER builds and signs them (machine-webcrypto
// `buildDistribution`, with the same unlocked key as the approval); the daemon of the admin machine verifies them against the pinned admin key and the
// ids it derives itself, then delivers them through the same code as `machine admin distribute`. Nothing here asks for a passphrase of the daemon.

let root: string;
let adminDir: string;
let relay: FakeRelay;
let admin: TestAdmin;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const dirOf = (name: string) => join(root, name);
const uuidOf = (name: string) => readMachine(dirOf(name)).uuid;
const pass = async () => admin.passphrase;

beforeEach(async () => {
  baseline = 0;
  root = mkdtempSync(join(tmpdir(), 'machine-approvedistribute-'));
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

/** The laptop is approved the existing way (the CLI): it is a trusted peer of the admin machine when the page approves the server. */
async function laptopEnrolled(): Promise<void> {
  const info = exportMachineInfo(dirOf('laptop'));
  relay.addCandidacy('cand-laptop', { name: info.name, hostname: 'h', identityPublicKey: info.identityPublicKey, random: newCandidacyRandom(), uuid: info.uuid });
  const result = await cli(adminDir, ['admin', 'approve', 'cand-laptop', '--relay', relay.url], pass, { ask: async () => 'y' });
  expect(result.code, result.err).toBe(0);
  baseline = inboxPuts().length;
}

interface PageRun {
  context: ApproveContextOk;
  built: BuiltDistribution;
  subject: SignedRegistration;
  payload: Record<string, unknown>;
}

/** What the page does after one passphrase: the approval, its import, then the documents, all with the same non-extractable key. */
async function pageApprovesServer(dir = adminDir, passphrase = admin.passphrase): Promise<PageRun> {
  const context = approveContext(dir, { candidateUuid: uuidOf('server') }, nowSeconds());
  if (!context.ok) throw new Error(`test: ${context.message}`);
  const pair = await unlockAdminKey(dir, async () => passphrase);
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
  const imported = await importCandidate(dir, { ...approved.adminImport }, now);
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
  const payload = { candidateUuid: candidate.uuid, documents: built.documents, noticeRecipients: built.noticeRecipients };
  return { context, built, subject: approved.registrations.candidate, payload };
}

const inboxOf = (name: string) => relay.inbox(uuidOf(name)).map((d) => d.document as SignedDocument);
const verified = (name: string, document: unknown) =>
  verifyInboxDocument(document, { adminPublicKey: admin.adminPublicKey, selfUuid: uuidOf(name), now: nowSeconds(), identityPrivateKeyPkcs8: readMachine(dirOf(name)).identity.privateKeyPkcs8 });
const inboxPuts = () => relay.requests.filter((q) => q.method === 'PUT' && /\/inbox\//.test(q.path));
let baseline = 0;
const newPuts = () => inboxPuts().slice(baseline);
const failure = (answer: ApproveDistributeAnswer): { reason: string; message: string } => {
  if (answer.ok) throw new Error(`expected a refusal, got ${JSON.stringify(answer)}`);
  return answer;
};

describe('approveContext carries what the page needs to inform the other peers', () => {
  it('the registrations of the OTHER trusted peers (never the candidate, never this machine) and the stored list of notice recipients (null when none)', async () => {
    await laptopEnrolled();
    const context = approveContext(adminDir, { candidateUuid: uuidOf('server') }, nowSeconds());
    if (!context.ok) throw new Error('refused');
    expect(context.others.map((r) => r.body.uuid)).toEqual([uuidOf('laptop')]);
    // The CLI approval of the laptop signed and stored the list of this admin machine.
    expect(context.noticeRecipients?.body.recipients).toEqual([uuidOf('desktop')]);
    expect(readNoticeRecipients(adminDir, admin.adminPublicKey)?.signature).toBe(context.noticeRecipients?.signature);
  });

  it('the first machine of a network has no other peer', async () => {
    const context = approveContext(adminDir, { candidateUuid: uuidOf('laptop') }, nowSeconds());
    if (!context.ok) throw new Error('refused');
    expect(context.others).toEqual([]);
    expect(context.noticeRecipients).toBeNull();
  });

  it('is served by the daemon command of the same name', async () => {
    await laptopEnrolled();
    const commands = makeCommands(adminDir, 'test', nowSeconds);
    expect(commands.approveContext({ candidateUuid: uuidOf('server') })).toMatchObject({ ok: true, others: [{ body: { uuid: uuidOf('laptop') } }] });
  });
});

describe('approveDistribute: verify what the page signed, deliver it like machine admin distribute', () => {
  it('delivers a peer document to each side and the list of notice recipients to both, sealed to the right keys with the pair secret V2 of the admin key', async () => {
    await laptopEnrolled();
    const before = inboxOf('laptop').length;
    const run = await pageApprovesServer();
    const answer = await approveDistribute(adminDir, run.payload, nowSeconds());
    if (!answer.ok) throw new Error(answer.message);
    expect(answer.failed).toBe(false);
    expect(answer.report.failures).toEqual([]);
    expect(answer.text.out).toMatch(/2 document\(s\) stored by the relay for 1 machine\(s\)/);

    const toLaptop = inboxOf('laptop').slice(before);
    const toServer = inboxOf('server');
    const aboutServer = toLaptop.map((d) => verified('laptop', d)).find((v) => v.ok && v.kind === 'peer');
    const aboutLaptop = toServer.map((d) => verified('server', d)).find((v) => v.ok && v.kind === 'peer');
    if (!aboutServer?.ok || aboutServer.kind !== 'peer' || !aboutLaptop?.ok || aboutLaptop.kind !== 'peer') throw new Error('expected two verified peer documents');
    expect(aboutServer.registration.uuid).toBe(uuidOf('server'));
    expect(aboutLaptop.registration.uuid).toBe(uuidOf('laptop'));
    const secretOfLaptop = openPairSecret(aboutServer, readMachine(dirOf('laptop')).identity.privateKeyPkcs8);
    expect(secretOfLaptop).toBe(openPairSecret(aboutLaptop, readMachine(dirOf('server')).identity.privateKeyPkcs8));
    const pair = await unlockAdminKey(adminDir, pass);
    expect(secretOfLaptop).toBe(derivePairSecretV2(pair.privateKeyPkcs8, { uuid: uuidOf('server'), serial: run.subject.body.serial }, { uuid: uuidOf('laptop'), serial: run.context.others[0]!.body.serial }));
    for (const name of ['laptop', 'server']) {
      expect(relay.inbox(uuidOf(name)).some((d) => (d.document as SignedDocument).body.kind === 'notice-recipients')).toBe(true);
    }
    // Only the admin token delivers, and neither the secret nor a token reaches the answer.
    for (const put of inboxPuts()) expect(put.authorization).toBe(`Bearer ${relay.adminToken}`);
    expect(JSON.stringify(answer)).not.toContain(secretOfLaptop);
    expect(JSON.stringify(answer)).not.toContain(relay.adminToken);
  });

  it('a retry is safe: the relay already holds the documents, nothing fails', async () => {
    await laptopEnrolled();
    const run = await pageApprovesServer();
    expect((await approveDistribute(adminDir, run.payload, nowSeconds())).ok).toBe(true);
    const again = await approveDistribute(adminDir, run.payload, nowSeconds());
    if (!again.ok) throw new Error(again.message);
    expect(again.failed).toBe(false);
    expect(again.report.delivered + again.report.alreadyThere).toBe(2);
  });

  it('is served by the daemon command of the same name', async () => {
    await laptopEnrolled();
    const run = await pageApprovesServer();
    const answer = await makeCommands(adminDir, 'test', nowSeconds).approveDistribute(run.payload);
    expect(answer).toMatchObject({ ok: true, failed: false });
  });

  it('never replaces the stored list of notice recipients: the page reuses it, signs nothing new', async () => {
    await laptopEnrolled();
    const run = await pageApprovesServer();
    // The CLI already stored a list: the page reuses it and signs nothing new.
    expect(run.built.noticeRecipients).toBeNull();
    expect((await approveDistribute(adminDir, run.payload, nowSeconds())).ok).toBe(true);
    expect(readNoticeRecipients(adminDir, admin.adminPublicKey)?.body.recipients).toEqual([uuidOf('desktop')]);
  });

  it('refuses a document signed by another admin key: nothing is delivered', async () => {
    await laptopEnrolled();
    const run = await pageApprovesServer();
    const other = makeAdmin(dirOf('server'));
    const otherKey = await unlockAdminKey(dirOf('server'), async () => other.passphrase);
    const key = await crypto.subtle.importKey('pkcs8', otherKey.privateKeyPkcs8 as BufferSource, 'Ed25519', false, ['sign']);
    const { signBody } = await import('@wadeck-app/machine-webcrypto');
    const forged = (await signBody('machine/document/v2', (run.built.documents[0] as SignedDocument).body as never, key)) as unknown as SignedDocument;
    const answer = failure(await approveDistribute(adminDir, { ...run.payload, documents: [forged, ...run.built.documents.slice(1)] }, nowSeconds()));
    expect(answer.reason).toBe('bad-document');
    expect(answer.message).toMatch(/Nothing was delivered/);
    expect(newPuts()).toHaveLength(0);
  });

  it('refuses a document that is not one this approval needs (another id, a policy, a machine this one does not trust)', async () => {
    await laptopEnrolled();
    const run = await pageApprovesServer();
    const original = run.built.documents[0] as SignedDocument;
    const tampered = { ...original, body: { ...original.body, id: 'AAAAAAAAAAAAAAAAAAAAAA' } };
    expect(failure(await approveDistribute(adminDir, { ...run.payload, documents: [tampered] }, nowSeconds())).reason).toBe('bad-document');
    const stranger = { ...original, body: { ...original.body, to: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f' } };
    expect(failure(await approveDistribute(adminDir, { ...run.payload, documents: [stranger] }, nowSeconds())).reason).toBe('bad-document');
    expect(failure(await approveDistribute(adminDir, { ...run.payload, documents: [original, original] }, nowSeconds())).reason).toBe('bad-document');
    expect(newPuts()).toHaveLength(0);
  });

  it('a document the page did not send is a failure naming the machine and the exact retry command; the others are delivered', async () => {
    await laptopEnrolled();
    const run = await pageApprovesServer();
    const peerToLaptop = run.built.documents.findIndex((d) => d.body.kind === 'peer' && d.body.to === uuidOf('laptop'));
    const documents = run.built.documents.filter((_, i) => i !== peerToLaptop);
    const answer = await approveDistribute(adminDir, { ...run.payload, documents }, nowSeconds());
    if (!answer.ok) throw new Error(answer.message);
    expect(answer.failed).toBe(true);
    expect(answer.report.failures.map((f) => f.toUuid)).toEqual([uuidOf('laptop')]);
    expect(answer.text.err).toContain(`machine admin distribute ${uuidOf('server')}`);
    expect(answer.text.err).toMatch(/laptop/);
  });

  it('a relay that refuses is a failure with the retry command, the approval stands', async () => {
    await laptopEnrolled();
    const run = await pageApprovesServer();
    const client = { putInboxDocument: async () => { throw new RelayError({ status: 500, message: 'boom' }); } } as unknown as RelayClient;
    const answer = await approveDistribute(adminDir, run.payload, nowSeconds(), { client });
    if (!answer.ok) throw new Error(answer.message);
    expect(answer.failed).toBe(true);
    expect(answer.text.err).toContain(`machine admin distribute ${uuidOf('server')}`);
    expect(answer.text.err).toMatch(/nothing was undone/);
  });

  it('refuses a payload with another shape, an unknown candidate and a machine without the admin key', async () => {
    await laptopEnrolled();
    const run = await pageApprovesServer();
    expect(failure(await approveDistribute(adminDir, { ...run.payload, extra: 1 }, nowSeconds())).reason).toBe('bad-payload');
    expect(failure(await approveDistribute(adminDir, { candidateUuid: uuidOf('server') }, nowSeconds())).reason).toBe('bad-payload');
    expect(failure(await approveDistribute(adminDir, { ...run.payload, candidateUuid: 'nope' }, nowSeconds())).reason).toBe('bad-payload');
    expect(failure(await approveDistribute(adminDir, { ...run.payload, candidateUuid: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f' }, nowSeconds())).reason).toBe('not-imported');
    expect(failure(await approveDistribute(dirOf('laptop'), run.payload, nowSeconds())).reason).toBe('no-admin-key');
    expect(newPuts()).toHaveLength(0);
  });

  it('with no admin relay token on this machine: loud, actionable, nothing delivered', async () => {
    // A second admin machine that never ran `machine admin login`.
    mkdirSync(dirOf('desk2'));
    await ok(dirOf('desk2'), ['init', '--name', 'desk2']);
    const second = makeAdmin(dirOf('desk2'));
    const secondRun = await pageApprovesServer(dirOf('desk2'), second.passphrase);
    const answer = failure(await approveDistribute(dirOf('desk2'), secondRun.payload, nowSeconds()));
    expect(answer.reason).toBe('no-admin-token');
    expect(answer.message).toMatch(/admin login/);
    expect(newPuts()).toHaveLength(0);
  });
});
