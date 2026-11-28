import { mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDocument,
  DOCUMENT_RETENTION_SECONDS,
  documentId,
  keyId,
  NETWORK_ALIASES_SUBJECT_UUID,
  newCandidacyRandom,
  planAliasChange,
  signAliases,
  verifyInboxDocument,
  type AliasChange,
  type AliasEntry,
  type SignedAliases,
  type SignedDocument,
} from '@wadeck-app/machine-core';
import { buildAliases } from '@wadeck-app/machine-webcrypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unlockAdminKey } from './admin.js';
import { aliasesApply, aliasesContext, type AliasesApplyAnswer, type AliasesContextOk } from './aliasesFromPage.js';
import { networkAliasMap, readAliasesList } from './aliasesStore.js';
import { makeCommands } from './commands.js';
import { retainedDelivery, retryDelivery } from './deliveryRetry.js';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { readMachine } from './identity.js';
import { exportMachineInfo } from './network.js';
import { createRelayClient, RelayError, type RelayClient } from './relayClient.js';
import { relayAdminFile } from './relayStore.js';
import { cli, makeAdmin, ok, type TestAdmin } from './testing.js';

// Network aliases from the page (decision 116, admin-ui.md). The BROWSER signs the new list (one alias added or removed) and the `aliases` documents for the trusted
// machines; the daemon of the admin machine verifies them against the pinned admin key and against the change it re-plans itself, installs the list here and delivers
// like `machine admin alias send`. It never receives a passphrase and signs nothing. Here the page is played with machine-core signing.

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
const RETRY = 'machine admin alias send';

async function enroll(name: string): Promise<void> {
  const info = exportMachineInfo(dirOf(name));
  relay.addCandidacy(`cand-${name}`, { name: info.name, hostname: 'h', identityPublicKey: info.identityPublicKey, random: newCandidacyRandom(), uuid: info.uuid });
  const result = await cli(adminDir, ['admin', 'approve', `cand-${name}`, '--relay', relay.url], pass, { ask: yes });
  expect(result.code, result.err).toBe(0);
}

let baseline = 0;
beforeEach(async () => {
  baseline = 0;
  root = mkdtempSync(join(tmpdir(), 'machine-aliasespage-'));
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
const contextOf = (dir = adminDir): AliasesContextOk => {
  const context = aliasesContext(dir, {}, nowSeconds());
  if (!context.ok) throw new Error(`test: ${context.message}`);
  return context;
};
const applied = (answer: AliasesApplyAnswer) => {
  if (!answer.ok) throw new Error(`${answer.reason}: ${answer.message}`);
  return answer;
};
const stored = (): AliasEntry[] => networkAliasMapEntries();
const networkAliasMapEntries = (): AliasEntry[] => Object.entries(networkAliasMap(adminDir)).map(([alias, uuid]) => ({ alias, uuid }));

interface PageRun {
  context: AliasesContextOk;
  signed: SignedAliases;
  documents: SignedDocument[];
  payload: Record<string, unknown>;
}

/** What the page does after one passphrase: plan the change, sign the list, seal one document per machine. `entries` replaces the planned entries (a tampered list). */
async function pageChanges(change: AliasChange, entries?: AliasEntry[]): Promise<PageRun> {
  const context = contextOf();
  const pair = await unlockAdminKey(adminDir, pass);
  const now = nowSeconds();
  const planned = planAliasChange({ change, current: context.current?.body.entries ?? [], machines: context.machines, revoked: context.revoked });
  if (!planned.ok) throw new Error(`test: ${planned.message}`);
  const serial = Math.max(now, (context.current?.body.serial ?? 0) + 1);
  const signed = signAliases({ v: 1, adminKeyId: keyId(pair.publicKey), serial, issuedAt: now, entries: entries ?? planned.entries }, pair.privateKeyPkcs8);
  const documents = context.recipients.map((r) =>
    buildDocument(
      {
        kind: 'aliases',
        to: r.body.uuid,
        id: documentId(`v2:aliases:${r.body.uuid}:${signed.body.serial}:${signed.signature}`),
        issuedAt: now,
        expiresAt: now + DOCUMENT_RETENTION_SECONDS,
        payload: signed as never,
        recipientIdentityPublicKey: r.body.identityPublicKey,
      },
      pair.privateKeyPkcs8,
    ),
  );
  return { context, signed, documents, payload: { signed, documents } };
}
const setAlias = (alias: string, name: string): AliasChange => ({ action: 'set', alias, uuid: uuidOf(name) });
const unchanged = (before: AliasEntry[] = []) => {
  expect(stored()).toEqual(before);
  expect(newPuts()).toHaveLength(0);
};

describe('aliasesContext: what the page needs before it asks the passphrase', () => {
  it('no list yet: the machines, the revoked ones, the local aliases and the registrations of the machines to tell', () => {
    const context = contextOf();
    expect(context.adminMachine).toEqual({ uuid: uuidOf('desktop'), name: 'desktop' });
    expect(context.adminPublicKey).toBe(admin.adminPublicKey);
    expect(context.current).toBeNull();
    expect(context.machines.map((m) => m.name).sort()).toEqual(['desktop', 'laptop', 'server']);
    expect(context.revoked).toEqual([]);
    expect(context.localAliases).toEqual({});
    expect(context.recipients.map((r) => r.body.name).sort()).toEqual(['laptop', 'server']);
  });

  it('carries the signed list in force, the local aliases and the revoked machines', async () => {
    await cli(adminDir, ['admin', 'alias', 'set', 'box', 'server'], pass, { ask: yes });
    await ok(adminDir, ['alias', 'set', 'lap', 'laptop']);
    const gone = uuidOf('laptop');
    await cli(adminDir, ['admin', 'revoke', 'laptop'], pass, { ask: yes });
    const context = contextOf();
    expect(context.current?.body.entries).toEqual([{ alias: 'box', uuid: uuidOf('server') }]);
    expect(context.localAliases).toEqual({ lap: gone });
    expect(context.revoked).toEqual([gone]);
    expect(context.recipients.map((r) => r.body.name)).toEqual(['server']);
  });

  it('refuses a payload with a field, and a machine without the admin key, each with the way out', () => {
    expect(failure(aliasesContext(adminDir, { x: 1 }, nowSeconds())).reason).toBe('bad-payload');
    expect(failure(aliasesContext(dirOf('laptop'), {}, nowSeconds())).reason).toBe('no-admin-key');
  });

  it('is served by the daemon command of the same name', () => {
    expect(makeCommands(adminDir, 'test', nowSeconds).aliasesContext({})).toMatchObject({ ok: true, current: null });
  });
});

describe('aliasesApply: verify what the page signed, install it here, send it like machine admin alias send', () => {
  it('installs the list (same file as the CLI) and delivers one sealed document to each other machine, none to this one', async () => {
    const run = await pageChanges(setAlias('box', 'server'));
    const answer = applied(await aliasesApply(adminDir, run.payload, nowSeconds()));
    expect(answer.failed).toBe(false);
    expect(answer.changed).toBe(true);
    expect(answer.serial).toBe(run.signed.body.serial);
    expect(answer.entries).toEqual([{ alias: 'box', uuid: uuidOf('server'), name: 'server' }]);
    expect(answer.retry).toBe(RETRY);
    expect(readAliasesList(adminDir, admin.adminPublicKey)).toEqual(run.signed);
    expect(networkAliasMap(adminDir)).toEqual({ box: uuidOf('server') });
    expect(answer.machines.map((m) => [m.name, m.state]).sort()).toEqual([
      ['laptop', 'inbox'],
      ['server', 'inbox'],
    ]);
    expect(newPuts().map((q) => q.path.includes(uuidOf('desktop')))).not.toContain(true);
    expect(newPuts()).toHaveLength(2);
    const doc = relay.inbox(uuidOf('server')).map((d) => d.document as SignedDocument).find((d) => d.body.kind === 'aliases') as SignedDocument;
    const verified = verifyInboxDocument(doc, { adminPublicKey: admin.adminPublicKey, selfUuid: uuidOf('server'), now: nowSeconds(), identityPrivateKeyPkcs8: readMachine(dirOf('server')).identity.privateKeyPkcs8 });
    expect(verified.ok).toBe(true);
    for (const put of newPuts()) expect(put.authorization).toBe(`Bearer ${relay.adminToken}`);
    expect(JSON.stringify(answer)).not.toContain(relay.adminToken);
    // The CLI sees the same list, and its retry is idempotent: the relay already holds the documents.
    const send = await cli(adminDir, ['admin', 'alias', 'send'], pass, { ask: yes });
    expect(send.code, send.err).toBe(0);
  });

  it('is served by the daemon command of the same name', async () => {
    const run = await pageChanges(setAlias('box', 'server'));
    expect(await makeCommands(adminDir, 'test', nowSeconds).aliasesApply(run.payload)).toMatchObject({ ok: true, failed: false });
  });

  it('removes an alias (a list with one entry less, possibly empty)', async () => {
    await cli(adminDir, ['admin', 'alias', 'set', 'box', 'server'], pass, { ask: yes });
    baseline = inboxPuts().length;
    const run = await pageChanges({ action: 'rm', alias: 'box' });
    const answer = applied(await aliasesApply(adminDir, run.payload, nowSeconds()));
    expect(answer.entries).toEqual([]);
    expect(networkAliasMap(adminDir)).toEqual({});
    expect(newPuts()).toHaveLength(2);
  });

  it('a relay that refuses one machine: the list stands, the machine is named with the retry command, and the page retries WITHOUT a passphrase', async () => {
    const run = await pageChanges(setAlias('box', 'server'));
    const first = applied(await aliasesApply(adminDir, run.payload, nowSeconds(), { client: refusing([uuidOf('laptop')]) }));
    expect(first.failed).toBe(true);
    expect(networkAliasMap(adminDir)).toEqual({ box: uuidOf('server') });
    expect(first.text.err).toContain(RETRY);
    expect(first.machines.find((m) => m.name === 'laptop')).toMatchObject({ state: 'failed', code: 'not-stored' });
    expect(retainedDelivery(adminDir, NETWORK_ALIASES_SUBJECT_UUID)?.kind).toBe('aliases');
    const before = inboxPuts().length;
    const second = await retryDelivery(adminDir, { uuid: NETWORK_ALIASES_SUBJECT_UUID }, nowSeconds());
    if (!second.ok) throw new Error(second.message);
    expect(second.failed).toBe(false);
    expect(second.retry).toBe(RETRY);
    expect(inboxPuts().slice(before)).toHaveLength(1);
    expect(second.machines.map((m) => [m.name, m.state]).sort()).toEqual([
      ['laptop', 'inbox'],
      ['server', 'inbox'],
    ]);
    expect(retainedDelivery(adminDir, NETWORK_ALIASES_SUBJECT_UUID)).toBeUndefined();
  });

  it('with no admin relay token the list is installed HERE anyway and the answer says nobody was told, with the login command', async () => {
    const run = await pageChanges(setAlias('box', 'server'));
    unlinkSync(relayAdminFile(adminDir));
    const answer = applied(await aliasesApply(adminDir, run.payload, nowSeconds()));
    expect(answer.failed).toBe(true);
    expect(answer.text.err).toMatch(/admin login/);
    expect(answer.text.err).toContain(RETRY);
    expect(networkAliasMap(adminDir)).toEqual({ box: uuidOf('server') });
    expect(newPuts()).toHaveLength(0);
    expect(retainedDelivery(adminDir, NETWORK_ALIASES_SUBJECT_UUID)?.items).toHaveLength(2);
  });

  it('a document the page did not send is a failure naming the machine; the list stands', async () => {
    const run = await pageChanges(setAlias('box', 'server'));
    const answer = applied(await aliasesApply(adminDir, { ...run.payload, documents: run.documents.slice(0, 1) }, nowSeconds()));
    expect(answer.failed).toBe(true);
    expect(answer.text.err).toMatch(/aliases document/);
    expect(answer.machines.filter((m) => m.state === 'failed')).toHaveLength(1);
  });

  it('refuses another shape of payload and a machine without the admin key, nothing installed', async () => {
    const run = await pageChanges(setAlias('box', 'server'));
    expect(failure(await aliasesApply(adminDir, { ...run.payload, extra: 1 }, nowSeconds())).reason).toBe('bad-payload');
    expect(failure(await aliasesApply(adminDir, { signed: run.signed }, nowSeconds())).reason).toBe('bad-payload');
    expect(failure(await aliasesApply(dirOf('laptop'), run.payload, nowSeconds())).reason).toBe('no-admin-key');
    unchanged();
  });

  it('refuses a list signed by another admin key, nothing installed or delivered', async () => {
    const run = await pageChanges(setAlias('box', 'server'));
    mkdirSync(dirOf('other'));
    await ok(dirOf('other'), ['init', '--name', 'other']);
    const other = makeAdmin(dirOf('other'));
    const otherKey = await unlockAdminKey(dirOf('other'), async () => other.passphrase);
    const forged = signAliases({ ...run.signed.body, adminKeyId: keyId(otherKey.publicKey) }, otherKey.privateKeyPkcs8);
    const answer = failure(await aliasesApply(adminDir, { ...run.payload, signed: forged }, nowSeconds()));
    expect(answer.reason).toBe('bad-aliases');
    expect(answer.message).toMatch(/Nothing was installed/);
    unchanged();
  });

  it('refuses a list that changes two aliases at once, or an alias that is neither added nor removed', async () => {
    const both = await pageChanges(setAlias('box', 'server'), [
      { alias: 'box', uuid: uuidOf('server') },
      { alias: 'lap', uuid: uuidOf('laptop') },
    ]);
    const two = failure(await aliasesApply(adminDir, both.payload, nowSeconds()));
    expect(two.reason).toBe('bad-aliases');
    expect(two.message).toMatch(/exactly one alias/);
    unchanged();
    // The list a page signed before another one landed: the serial no longer replaces the stored one.
    const stale = await pageChanges(setAlias('box', 'server'));
    await cli(adminDir, ['admin', 'alias', 'set', 'lap', 'laptop'], pass, { ask: yes });
    baseline = inboxPuts().length;
    const old = failure(await aliasesApply(adminDir, stale.payload, nowSeconds()));
    expect(old.reason).toBe('stale-aliases');
    expect(old.message).toMatch(/[Rr]eload the page/);
    expect(stored()).toEqual([{ alias: 'lap', uuid: uuidOf('laptop') }]);
    expect(newPuts()).toHaveLength(0);
  });

  it('refuses a replay of the same list: it is not newer than the one installed', async () => {
    const run = await pageChanges(setAlias('box', 'server'));
    applied(await aliasesApply(adminDir, run.payload, nowSeconds()));
    baseline = inboxPuts().length;
    expect(failure(await aliasesApply(adminDir, run.payload, nowSeconds())).reason).toBe('stale-aliases');
    expect(newPuts()).toHaveLength(0);
  });

  it('re-plans the change HERE: an alias with the name of a machine, a lookalike, an unknown machine, a revoked machine are refused with the planner sentence', async () => {
    const named = await pageChanges(setAlias('box', 'server'), [{ alias: 'laptop', uuid: uuidOf('server') }]);
    const n = failure(await aliasesApply(adminDir, named.payload, nowSeconds()));
    expect(n.reason).toBe('refused');
    expect(n.message).toMatch(/already the name of machine "laptop"/);
    const lookalike = await pageChanges(setAlias('box', 'server'), [{ alias: 'lap-top', uuid: uuidOf('server') }]);
    expect(failure(await aliasesApply(adminDir, lookalike.payload, nowSeconds())).message).toMatch(/only by hyphens or case/);
    const unknown = await pageChanges(setAlias('box', 'server'), [{ alias: 'box', uuid: STRANGER }]);
    expect(failure(await aliasesApply(adminDir, unknown.payload, nowSeconds())).message).toMatch(/not a trusted machine/);
    unchanged();
    const run = await pageChanges(setAlias('box', 'laptop'));
    await cli(adminDir, ['admin', 'revoke', 'laptop'], pass, { ask: yes });
    baseline = inboxPuts().length;
    const gone = failure(await aliasesApply(adminDir, run.payload, nowSeconds()));
    expect(gone.reason).toBe('refused');
    expect(gone.message).toMatch(/revoked|not a trusted machine/);
    expect(stored()).toEqual([]);
    expect(newPuts()).toHaveLength(0);
  });

  it('refuses a list of more than 64 aliases (a list no machine would read), nothing installed', async () => {
    const run = await pageChanges(setAlias('box', 'server'));
    const entries = Array.from({ length: 65 }, (_, i) => ({ alias: `box-${String(i).padStart(2, 'x')}`, uuid: uuidOf('server') }));
    const forged = { body: { ...run.signed.body, entries }, signature: run.signed.signature };
    const answer = failure(await aliasesApply(adminDir, { ...run.payload, signed: forged }, nowSeconds()));
    expect(answer.reason).toBe('bad-aliases');
    expect(answer.message).toMatch(/too many aliases/);
    unchanged();
  });

  it('refuses a document with another id, for a stranger, of another kind, or duplicated: nothing installed or delivered', async () => {
    const run = await pageChanges(setAlias('box', 'server'));
    const original = run.documents[0] as SignedDocument;
    const tampered = { ...original, body: { ...original.body, id: 'AAAAAAAAAAAAAAAAAAAAAA' } };
    expect(failure(await aliasesApply(adminDir, { ...run.payload, documents: [tampered] }, nowSeconds())).reason).toBe('bad-document');
    const stranger = { ...original, body: { ...original.body, to: STRANGER } };
    expect(failure(await aliasesApply(adminDir, { ...run.payload, documents: [stranger] }, nowSeconds())).reason).toBe('bad-document');
    expect(failure(await aliasesApply(adminDir, { ...run.payload, documents: [original, original] }, nowSeconds())).reason).toBe('bad-document');
    const otherKind = { ...original, body: { ...original.body, kind: 'revocation' } };
    expect(failure(await aliasesApply(adminDir, { ...run.payload, documents: [otherKind] }, nowSeconds())).reason).toBe('bad-document');
    unchanged();
  });
});

describe('aliasesApply with the real page builder (machine-webcrypto buildAliases)', () => {
  it('what the page builds is accepted, installed and delivered as is, for a set then a remove', async () => {
    const pair = await unlockAdminKey(adminDir, pass);
    const key = await crypto.subtle.importKey('pkcs8', pair.privateKeyPkcs8 as BufferSource, 'Ed25519', false, ['sign']);
    for (const change of [setAlias('Box', 'server'), { action: 'rm', alias: 'box' } as AliasChange]) {
      const context = contextOf();
      const built = await buildAliases({ adminPrivateKey: key, adminPublicKey: pair.publicKey, adminUuid: context.adminMachine.uuid, change, current: context.current, machines: context.machines, revoked: context.revoked, recipients: context.recipients, now: nowSeconds() });
      expect(built.failures).toEqual([]);
      const answer = applied(await aliasesApply(adminDir, { signed: built.signed, documents: built.documents }, nowSeconds()));
      expect(answer.failed).toBe(false);
    }
    expect(networkAliasMap(adminDir)).toEqual({});
  });
});
