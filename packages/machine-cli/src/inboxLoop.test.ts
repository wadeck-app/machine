import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDocument, documentId, newCandidacyRandom, sealTo, type Json, type SignedDocument, generateSigningKeyPair } from '@wadeck-app/machine-core';
import { unlockAdminKey } from './admin.js';
import { startMachineDaemon } from './daemonEntry.js';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { readMachine } from './identity.js';
import { BoundedSet, HandledIds, startInboxLoop, type InboxLoop, type InboxTimer } from './inboxLoop.js';
import { exportMachineInfo, loadNetwork } from './network.js';
import { createRelayClient } from './relayClient.js';
import { writeRelayConfig } from './relayStore.js';
import { FileAuditLog } from './stores.js';
import { cli, makeAdmin, ok, type TestAdmin } from './testing.js';

let root: string;
let adminDir: string;
let relay: FakeRelay;
let admin: TestAdmin;
let clockOverride: number | undefined;
let logs: string[];
let loops: InboxLoop[];

const yes = async () => 'y';
const pass = async () => admin.passphrase;
const dirOf = (name: string) => join(root, name);
const uuidOf = (name: string) => readMachine(dirOf(name)).uuid;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const adminClient = () => createRelayClient({ baseUrl: relay.url, token: relay.adminToken });
const machineNames = (name: string) =>
  loadNetwork(dirOf(name), nowSeconds())
    .directory.machines()
    .map((m) => m.name)
    .sort();
const auditLines = (name: string) => (existsSync(join(dirOf(name), 'audit.log')) ? readFileSync(join(dirOf(name), 'audit.log'), 'utf8').trim().split('\n').filter(Boolean) : []);
const auditEvents = (name: string) => auditLines(name).map((l) => JSON.parse(l) as { entry?: Record<string, unknown> } & Record<string, unknown>);
// The audit line format wraps the entry; the fields of interest are found wherever they are.
const auditText = (name: string) => auditLines(name).join('\n');

/** A timer that never waits: the test sees the delays that were asked for and fires by hand. */
function fakeTimer(): InboxTimer & { delays: number[]; pending: () => number; fire: () => void } {
  const pending = new Map<number, () => void>();
  const delays: number[] = [];
  let next = 0;
  return {
    set: (fn, ms) => {
      delays.push(ms);
      pending.set(++next, fn);
      return next;
    },
    clear: (handle) => void pending.delete(handle as number),
    delays,
    pending: () => pending.size,
    fire: () => {
      const all = [...pending.values()];
      pending.clear();
      for (const fn of all) fn();
    },
  };
}

async function enroll(name: string): Promise<void> {
  const info = exportMachineInfo(dirOf(name));
  const id = `cand-${name}`;
  relay.addCandidacy(id, { name: info.name, hostname: 'h', identityPublicKey: info.identityPublicKey, random: newCandidacyRandom(), uuid: info.uuid });
  const r = await cli(adminDir, ['admin', 'approve', id, '--relay', relay.url], pass, { ask: yes });
  if (r.code !== 0) throw new Error(`approve ${name} failed: ${r.err}`);
}

/** The machine `laptop` as the daemon sees it: admin key pinned, relay token stored, and it owns its inbox. */
function loopFor(name: string, options: { timer?: ReturnType<typeof fakeTimer>; client?: ReturnType<typeof createRelayClient>; now?: () => number; handledCap?: number; onRevocationInstalled?: () => void; onInstalled?: () => void } = {}) {
  const timer = options.timer ?? fakeTimer();
  const audit = new FileAuditLog(join(dirOf(name), 'audit.log'));
  const loop = startInboxLoop({
    configDir: dirOf(name),
    self: readMachine(dirOf(name)),
    client: options.client ?? createRelayClient({ baseUrl: relay.url, token: relay.token }),
    audit,
    now: options.now ?? (() => clockOverride ?? nowSeconds()),
    log: (line) => logs.push(line),
    timer,
    ...(options.handledCap !== undefined ? { handledCap: options.handledCap } : {}),
    ...(options.onRevocationInstalled ? { onRevocationInstalled: options.onRevocationInstalled } : {}),
    ...(options.onInstalled ? { onInstalled: options.onInstalled } : {}),
  });
  loops.push(loop);
  return { loop, timer };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-inbox-'));
  adminDir = dirOf('desktop');
  for (const name of ['desktop', 'laptop', 'server']) {
    mkdirSync(dirOf(name));
    await ok(dirOf(name), ['init', '--name', name]);
  }
  relay = await startFakeRelay();
  admin = makeAdmin(adminDir);
  await ok(adminDir, ['admin', 'login', '87654321', '--full-access', '--relay', relay.url]);
  await ok(dirOf('laptop'), ['admin', 'pin', join(adminDir, 'admin.json')]);
  writeRelayConfig(dirOf('laptop'), { relayUrl: relay.url, token: relay.token, label: 'laptop', claimedAt: new Date().toISOString() }, false);
  relay.setOwner(uuidOf('laptop'), relay.token);
  clockOverride = undefined;
  logs = [];
  loops = [];
});
afterEach(async () => {
  for (const loop of loops) loop.stop();
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

describe('the inbox loop: documents from the admin', () => {
  it('installs a peer document, deletes it, audits it without the secret, and both sides end with the same pair secret', async () => {
    await enroll('laptop');
    await enroll('server');
    expect(relay.inbox(uuidOf('laptop'))).toHaveLength(1);
    const { loop } = loopFor('laptop');
    await loop.ready;

    expect(machineNames('laptop')).toEqual(['server']);
    expect(relay.inbox(uuidOf('laptop'))).toHaveLength(0);
    const peer = loadNetwork(dirOf('laptop'), nowSeconds()).directory.find(uuidOf('server'));
    expect(peer).toBeDefined();
    const text = auditText('laptop');
    expect(text).toMatch(/document-accepted/);
    expect(text).toMatch(/"kind":"peer"/);
    expect(text).not.toContain(peer?.pairSecret.toString('base64url') as string);

    // The other side opens the same secret from its own document.
    await ok(dirOf('server'), ['admin', 'pin', join(adminDir, 'admin.json')]);
    writeRelayConfig(dirOf('server'), { relayUrl: relay.url, token: relay.token, label: 'server', claimedAt: new Date().toISOString() }, false);
    relay.setOwner(uuidOf('server'), relay.token);
    const second = loopFor('server');
    await second.loop.ready;
    expect(loadNetwork(dirOf('server'), nowSeconds()).directory.find(uuidOf('laptop'))?.pairSecret.toString('base64url')).toBe(peer?.pairSecret.toString('base64url'));
  });

  it('reads the inbox only when the heartbeat says there is something (and once at start)', async () => {
    // The real relay answers a heartbeat 404 until the address record exists: this machine published its record already.
    await createRelayClient({ baseUrl: relay.url, token: relay.adminToken }).putRecord(uuidOf('laptop'), { body: { v: 1, uuid: uuidOf('laptop'), addresses: [{ host: '10.0.0.1', port: 1 }], seq: 1, issuedAt: nowSeconds() }, signature: 's' });
    const { loop } = loopFor('laptop');
    await loop.ready;
    const lists = () => relay.requests.filter((q) => q.method === 'GET' && q.path.endsWith('/inbox')).length;
    expect(lists()).toBe(1);
    await loop.runOnce();
    await loop.runOnce();
    expect(lists()).toBe(1);
    expect(relay.requests.filter((q) => q.method === 'POST' && q.path.endsWith('/heartbeat')).length).toBe(3);
    await enroll('laptop');
    await enroll('server');
    await loop.runOnce();
    expect(lists()).toBe(2);
    expect(machineNames('laptop')).toEqual(['server']);
  });

  describe('a heartbeat before the first address record (the real relay answers 404 not_found until the record exists)', () => {
    const recordOf = (name: string) => ({ body: { v: 1 as const, uuid: uuidOf(name), addresses: [{ host: '10.0.0.1', port: 1 }], seq: 1, issuedAt: nowSeconds() }, signature: 's' });

    it('is not an outage: the heartbeat is asked again once the publisher wrote the record, and what waited in the inbox is installed in the very first round', async () => {
      await enroll('laptop');
      await enroll('server');
      const admin = createRelayClient({ baseUrl: relay.url, token: relay.adminToken });
      const timer = fakeTimer();
      const audit = new FileAuditLog(join(dirOf('laptop'), 'audit.log'));
      const withPublisher = startInboxLoop({
        configDir: dirOf('laptop'),
        self: readMachine(dirOf('laptop')),
        client: createRelayClient({ baseUrl: relay.url, token: relay.token }),
        audit,
        now: () => nowSeconds(),
        log: (line) => logs.push(line),
        timer,
        publisher: { tick: () => admin.putRecord(uuidOf('laptop'), recordOf('laptop')).then(() => undefined) },
      });
      loops.push(withPublisher);
      await withPublisher.ready;
      expect(logs.filter((l) => /not found|No address record/i.test(l))).toEqual([]);
      expect(machineNames('laptop')).toEqual(['server']);
      // No failure was counted: the next round is one heartbeat away, not a backoff.
      expect(timer.delays.at(-1)).toBe(60_000);
    });

    it('without a publisher and without a record the inbox is read anyway (reading needs no record), with no failure logged', async () => {
      await enroll('laptop');
      await enroll('server');
      const { loop } = loopFor('laptop');
      await loop.ready;
      expect(logs.filter((l) => /not found|No address record/i.test(l))).toEqual([]);
      expect(machineNames('laptop')).toEqual(['server']);
    });
  });

  it('rejects a document signed by another key: audited with the reason, deleted, nothing installed', async () => {
    await enroll('laptop');
    await enroll('server');
    const stranger = generateSigningKeyPair();
    const stolen = relay.inbox(uuidOf('laptop'))[0]?.document as SignedDocument;
    const forged = buildDocument({ kind: 'peer', to: uuidOf('laptop'), id: documentId('forged'), issuedAt: stolen.body.issuedAt, expiresAt: stolen.body.expiresAt, payload: stolen.body.payload }, stranger.privateKeyPkcs8);
    relay.setOwner(uuidOf('laptop'), relay.token);
    // The real one is removed so that only the forgery is left.
    await createRelayClient({ baseUrl: relay.url, token: relay.token }).deleteInboxDocument(uuidOf('laptop'), stolen.body.id);
    await adminClient().putInboxDocument(uuidOf('laptop'), forged);
    const { loop } = loopFor('laptop');
    await loop.ready;
    expect(machineNames('laptop')).toEqual([]);
    expect(relay.inbox(uuidOf('laptop'))).toHaveLength(0);
    // Nothing that could not be verified is recorded one by one, and its id is not remembered: one summary line.
    expect(auditText('laptop')).not.toMatch(/document-rejected/);
    expect(auditText('laptop')).toMatch(/documents-unverified/);
    expect(auditText('laptop')).toMatch(/bad-signature/);
    expect(auditText('laptop')).not.toContain(forged.body.id);
    expect(existsSync(join(dirOf('laptop'), 'inbox-state.json'))).toBe(false);
    expect(logs.join(' / ')).toMatch(/failed verification/);
  });

  it('a forgery under the id of a real document is deleted without remembering the id: the real document is installed when it arrives', async () => {
    await enroll('laptop');
    await enroll('server');
    const real = relay.inbox(uuidOf('laptop'))[0]?.document as SignedDocument;
    const machine = createRelayClient({ baseUrl: relay.url, token: relay.token });
    await machine.deleteInboxDocument(uuidOf('laptop'), real.body.id);
    const forged = buildDocument({ kind: 'peer', to: uuidOf('laptop'), id: real.body.id, issuedAt: real.body.issuedAt, expiresAt: real.body.expiresAt, payload: real.body.payload }, generateSigningKeyPair().privateKeyPkcs8);
    await adminClient().putInboxDocument(uuidOf('laptop'), forged);
    const { loop } = loopFor('laptop');
    await loop.ready;
    expect(machineNames('laptop')).toEqual([]);
    expect(relay.inbox(uuidOf('laptop'))).toHaveLength(0);

    await adminClient().putInboxDocument(uuidOf('laptop'), real);
    await loop.runOnce();
    expect(machineNames('laptop')).toEqual(['server']);
  });

  it('an entry whose id is not a canonical id is never used as a key and never sent back in a DELETE', async () => {
    await enroll('laptop');
    const real = { body: { v: 1 }, signature: 'x' };
    const longId = 'A'.repeat(5000);
    relay.force(`/api/machines/${uuidOf('laptop')}/inbox`, 200, { documents: [{ id: longId, document: real, storedAt: '2026-11-15T12:00:00.000Z' }, { id: '../../etc', document: real, storedAt: '2026-11-15T12:00:00.000Z' }], more: false }, {}, 'GET');
    const mark = relay.requests.length;
    const { loop } = loopFor('laptop');
    await loop.ready;
    expect(relay.requests.slice(mark).filter((q) => q.method === 'DELETE')).toHaveLength(0);
    expect(auditText('laptop')).toMatch(/invalid-id/);
    expect(existsSync(join(dirOf('laptop'), 'inbox-state.json'))).toBe(false);
  });

  it('a list entry whose id differs from the id inside the document is rejected (misaddressed id)', async () => {
    await enroll('laptop');
    await enroll('server');
    const real = relay.inbox(uuidOf('laptop'))[0] as { id: string; document: SignedDocument; storedAt: number };
    relay.force(`/api/machines/${uuidOf('laptop')}/inbox`, 200, { documents: [{ id: documentId('another id'), document: real.document, storedAt: new Date(real.storedAt * 1000).toISOString() }], more: false }, {}, 'GET');
    const { loop } = loopFor('laptop');
    await loop.ready;
    expect(machineNames('laptop')).toEqual([]);
    expect(auditText('laptop')).toMatch(/documents-unverified/);
    expect(auditText('laptop')).toMatch(/id-mismatch/);
    // Not remembered: the document under its real id is installed when it comes.
    expect(existsSync(join(dirOf('laptop'), 'inbox-state.json'))).toBe(false);
  });

  it('installs a policy; an old policy replayed afterwards is refused by installPolicy and recorded; the same version again is a no-op', async () => {
    await enroll('laptop');
    const draft = (version: number) => {
      const file = join(root, `draft-${version}.json`);
      writeFileSync(file, JSON.stringify({ v: 1, target: uuidOf('laptop'), version, baseVersion: version - 1, defaults: [{ shell: 'sh', command: `echo v${version}` }], peers: {} }));
      return file;
    };
    await ok(adminDir, ['admin', 'sign-policy', draft(1), '--out', join(root, 'p1.json')], pass);
    const v1 = relay.inbox(uuidOf('laptop'))[0]?.document as SignedDocument;
    const { loop } = loopFor('laptop');
    await loop.ready;
    expect(loadNetwork(dirOf('laptop'), nowSeconds()).policy?.version).toBe(1);

    await ok(adminDir, ['admin', 'sign-policy', draft(2), '--out', join(root, 'p2.json')], pass);
    const v2 = relay.inbox(uuidOf('laptop'))[0]?.document as SignedDocument;
    await loop.runOnce();
    expect(loadNetwork(dirOf('laptop'), nowSeconds()).policy?.version).toBe(2);

    // The first policy comes back in a document with ANOTHER id (the id of the first one is remembered, see the replay tests below).
    const key = await unlockAdminKey(adminDir, pass);
    const again = (source: SignedDocument, label: string) =>
      buildDocument(
        { kind: 'policy', to: uuidOf('laptop'), id: documentId(label), issuedAt: source.body.issuedAt, expiresAt: source.body.expiresAt, payload: source.body.payload },
        key.privateKeyPkcs8,
      );
    await adminClient().putInboxDocument(uuidOf('laptop'), again(v1, 'v1 again'));
    await loop.runOnce();
    expect(loadNetwork(dirOf('laptop'), nowSeconds()).policy?.version).toBe(2);
    expect(auditText('laptop')).toMatch(/document-rejected/);
    expect(auditText('laptop')).toMatch(/policy refused/);
    expect(relay.inbox(uuidOf('laptop'))).toHaveLength(0);

    // The current version delivered a second time in a new document changes nothing and is not an alarm.
    await adminClient().putInboxDocument(uuidOf('laptop'), again(v2, 'v2 again'));
    const before = auditLines('laptop').length;
    await loop.runOnce();
    expect(loadNetwork(dirOf('laptop'), nowSeconds()).policy?.version).toBe(2);
    expect(auditLines('laptop').length).toBe(before + 1);
    expect(auditText('laptop')).toMatch(/already-installed/);
  });

  it('policy mode local: an admin-signed policy from the inbox is refused, audited with the delegate advice and deleted; after `policy delegate` the next one installs', async () => {
    await enroll('laptop');
    const draft = (version: number) => {
      const file = join(root, `draft-local-${version}.json`);
      writeFileSync(file, JSON.stringify({ v: 1, target: uuidOf('laptop'), version, baseVersion: version - 1, defaults: [{ shell: 'sh', command: `echo v${version}` }], peers: {} }));
      return file;
    };
    const localPass = 'local passphrase of the laptop';
    const typed = [localPass, localPass];
    const enable = await cli(dirOf('laptop'), ['policy', 'local', 'enable'], async () => typed.shift() ?? '', { ask: async () => '' });
    expect(enable.code, enable.err).toBe(0);
    await ok(adminDir, ['admin', 'sign-policy', draft(1), '--out', join(root, 'pl1.json')], pass);
    const { loop } = loopFor('laptop');
    await loop.ready;
    expect(loadNetwork(dirOf('laptop'), nowSeconds()).policy).toBeUndefined();
    expect(auditText('laptop')).toMatch(/document-rejected/);
    expect(auditText('laptop')).toContain('this machine manages its own allow list (machine policy delegate to give it back to the admin)');
    expect(relay.inbox(uuidOf('laptop'))).toHaveLength(0);

    const delegate = await cli(dirOf('laptop'), ['policy', 'delegate'], async () => localPass, { ask: yes });
    expect(delegate.code, delegate.err).toBe(0);
    // The admin line has no version yet on this machine: the first admin policy is version 1, edited from 0.
    await ok(adminDir, ['admin', 'sign-policy', draft(1), '--out', join(root, 'pl1b.json')], pass);
    await loop.runOnce();
    expect(loadNetwork(dirOf('laptop'), nowSeconds()).policy?.defaults.map((e) => e.command)).toEqual(['echo v1']);
  });

  it('installs a revocation, after which an old peer document about the revoked machine is refused (revocation-aware)', async () => {
    await enroll('laptop');
    await enroll('server');
    const oldPeerDocument = relay.inbox(uuidOf('laptop'))[0]?.document as SignedDocument;
    const { loop } = loopFor('laptop');
    await loop.ready;
    expect(machineNames('laptop')).toEqual(['server']);

    const r = await cli(adminDir, ['admin', 'revoke', 'server'], pass, { ask: yes });
    expect(r.code, r.err).toBe(0);
    await loop.runOnce();
    expect(loadNetwork(dirOf('laptop'), nowSeconds()).revocations.map((e) => e.uuid)).toEqual([uuidOf('server')]);
    expect(machineNames('laptop')).toEqual([]);

    // The same registration comes again in a NEW document (the id of the first one is remembered): the revocation list refuses it.
    const key = await unlockAdminKey(adminDir, pass);
    const again = buildDocument(
      { kind: 'peer', to: uuidOf('laptop'), id: documentId('peer again'), issuedAt: oldPeerDocument.body.issuedAt, expiresAt: oldPeerDocument.body.expiresAt, payload: oldPeerDocument.body.payload },
      key.privateKeyPkcs8,
    );
    await adminClient().putInboxDocument(uuidOf('laptop'), again);
    await loop.runOnce();
    expect(machineNames('laptop')).toEqual([]);
    expect(auditText('laptop')).toMatch(/"reason":"revoked"/);
  });

  it('tells the daemon when any document changed what this machine trusts or may run (a new peer, a policy), so that it does not keep answering from its cache', async () => {
    await enroll('laptop');
    await enroll('server');
    let calls = 0;
    const { loop } = loopFor('laptop', { onInstalled: () => (calls += 1) });
    await loop.ready;
    // The peer document that waited in the inbox.
    expect(calls).toBe(1);
    const draft = join(root, 'draft-notify.json');
    writeFileSync(draft, JSON.stringify({ v: 1, target: uuidOf('laptop'), version: 1, baseVersion: 0, defaults: [{ shell: 'sh', command: 'echo hi' }], peers: {} }));
    await ok(adminDir, ['admin', 'sign-policy', draft, '--out', join(root, 'p-notify.json')], pass);
    await loop.runOnce();
    expect(calls).toBe(2);
    // Nothing new: no notification.
    await loop.runOnce();
    expect(calls).toBe(2);
  });

  it('tells the daemon when a revocation document was installed (so the open sessions of the revoked peer are closed)', async () => {
    await enroll('laptop');
    await enroll('server');
    let calls = 0;
    const { loop } = loopFor('laptop', { onRevocationInstalled: () => (calls += 1) });
    await loop.ready;
    expect(calls).toBe(0);
    const r = await cli(adminDir, ['admin', 'revoke', 'server'], pass, { ask: yes });
    expect(r.code, r.err).toBe(0);
    await loop.runOnce();
    expect(calls).toBe(1);
    // Replayed list: nothing new, no notification.
    await loop.runOnce();
    expect(calls).toBe(1);
  });

  it('a document that starts in the future is kept (not deleted), recorded once, and installed when the clock reaches it', async () => {
    await enroll('laptop');
    const key = await unlockAdminKey(adminDir, pass);
    const info = exportMachineInfo(dirOf('laptop'));
    // A policy for the machine, valid only later.
    const future = nowSeconds() + 3600;
    const { signPolicy } = await import('@wadeck-app/machine-core');
    const signed = signPolicy(
      { v: 1, target: info.uuid, version: 1, baseVersion: 0, adminKeyId: admin.adminKeyId, issuedAt: future, notBefore: future, notAfter: future + 1000, defaults: [{ shell: 'sh', command: 'echo later' }], peers: {} },
      key.privateKeyPkcs8,
    );
    const doc = buildDocument({ kind: 'policy', to: info.uuid, id: documentId('later'), issuedAt: future, expiresAt: future + 1000, payload: signed as unknown as Json }, key.privateKeyPkcs8);
    await adminClient().putInboxDocument(info.uuid, doc);
    const { loop } = loopFor('laptop');
    await loop.ready;
    await loop.runOnce();
    expect(relay.inbox(info.uuid)).toHaveLength(1);
    expect(loadNetwork(dirOf('laptop'), nowSeconds()).policy).toBeUndefined();
    expect(auditEvents('laptop').filter((e) => JSON.stringify(e).includes('document-deferred'))).toHaveLength(1);
    expect(logs.filter((l) => l.includes(doc.body.id))).toHaveLength(1);

    clockOverride = future + 10;
    await loop.runOnce();
    expect(relay.inbox(info.uuid)).toHaveLength(0);
    expect(auditText('laptop')).toMatch(/document-accepted/);
  });
});

describe('the inbox loop: a clock a little behind the admin one', () => {
  it('inside the tolerance (8 s behind) the document is installed at once: importPeer and the document verification agree', async () => {
    await enroll('laptop');
    await enroll('server');
    clockOverride = nowSeconds() - 8;
    const { loop } = loopFor('laptop');
    await loop.ready;
    expect(machineNames('laptop')).toEqual(['server']);
  });

  it('beyond the tolerance (45 s behind) the document is kept, not rejected, and installed once the clock catches up', async () => {
    await enroll('laptop');
    await enroll('server');
    clockOverride = nowSeconds() - 45;
    const { loop } = loopFor('laptop');
    await loop.ready;
    await loop.runOnce();
    expect(machineNames('laptop')).toEqual([]);
    expect(relay.inbox(uuidOf('laptop'))).toHaveLength(1);
    expect(auditText('laptop')).not.toMatch(/document-rejected/);
    expect(auditEvents('laptop').filter((e) => JSON.stringify(e).includes('document-deferred'))).toHaveLength(1);
    expect(logs.filter((l) => /not valid yet/.test(l))).toHaveLength(1);

    clockOverride = undefined;
    await loop.runOnce();
    expect(machineNames('laptop')).toEqual(['server']);
    expect(relay.inbox(uuidOf('laptop'))).toHaveLength(0);
  });
});

describe('the inbox loop: replays (the relay keeps no tombstone of acknowledged ids)', () => {
  const peersFile = () => join(dirOf('laptop'), '_secrets_', 'peers.json');

  it('a document replayed after its acknowledgement is skipped and acknowledged again, not reinstalled', async () => {
    await enroll('laptop');
    await enroll('server');
    const peerDocument = relay.inbox(uuidOf('laptop'))[0]?.document as SignedDocument;
    const { loop } = loopFor('laptop');
    await loop.ready;
    expect(machineNames('laptop')).toEqual(['server']);

    // Proof that nothing is reinstalled: the file the install wrote is removed, and a replay must not bring it back.
    rmSync(peersFile());
    const auditBefore = auditLines('laptop').length;
    await adminClient().putInboxDocument(uuidOf('laptop'), peerDocument);
    await loop.runOnce();
    expect(existsSync(peersFile())).toBe(false);
    expect(relay.inbox(uuidOf('laptop'))).toHaveLength(0);
    // Not a flood of audit lines for a replay; one log line says what happened.
    expect(auditLines('laptop').length).toBe(auditBefore);
    expect(logs.filter((l) => l.includes(peerDocument.body.id) && /replayed|already handled/.test(l))).toHaveLength(1);

    // The second replay of the same id is not logged again.
    await adminClient().putInboxDocument(uuidOf('laptop'), peerDocument);
    await loop.runOnce();
    expect(logs.filter((l) => l.includes(peerDocument.body.id) && /replayed|already handled/.test(l))).toHaveLength(1);
  });

  it('still skipped after a restart of the daemon (the set of handled ids is on disk)', async () => {
    await enroll('laptop');
    await enroll('server');
    const peerDocument = relay.inbox(uuidOf('laptop'))[0]?.document as SignedDocument;
    const first = loopFor('laptop');
    await first.loop.ready;
    first.loop.stop();
    expect(existsSync(join(dirOf('laptop'), 'inbox-state.json'))).toBe(true);

    rmSync(peersFile());
    await adminClient().putInboxDocument(uuidOf('laptop'), peerDocument);
    const second = loopFor('laptop');
    await second.loop.ready;
    expect(existsSync(peersFile())).toBe(false);
    expect(relay.inbox(uuidOf('laptop'))).toHaveLength(0);
  });

  it('documents that fail verification are summarised once per round, and an identical summary is not audited again within the hour', async () => {
    await enroll('laptop');
    const stranger = generateSigningKeyPair();
    const info = exportMachineInfo(dirOf('laptop'));
    const forged = buildDocument(
      { kind: 'revocation', to: info.uuid, id: documentId('forged'), issuedAt: nowSeconds(), expiresAt: nowSeconds() + 100, payload: { body: { v: 1 }, signature: 'x' } as unknown as Json },
      stranger.privateKeyPkcs8,
    );
    await adminClient().putInboxDocument(info.uuid, forged);
    const { loop } = loopFor('laptop');
    await loop.ready;
    const after = auditLines('laptop').length;
    expect(after).toBeGreaterThan(0);
    await adminClient().putInboxDocument(info.uuid, forged);
    await loop.runOnce();
    expect(auditLines('laptop').length).toBe(after);
    expect(relay.inbox(info.uuid)).toHaveLength(0);
  });

  it('the set of handled ids is bounded, oldest forgotten first, and a damaged file stops the loop with the fix', async () => {
    const file = join(root, 'handled.json');
    const set = new HandledIds(file, 3);
    for (const id of ['a', 'b', 'c', 'd']) set.add(id);
    // One write per round, not one per document.
    expect(existsSync(file)).toBe(false);
    set.flush();
    expect([set.has('a'), set.has('b'), set.has('c'), set.has('d')]).toEqual([false, true, true, true]);
    expect([new HandledIds(file, 3).has('a'), new HandledIds(file, 3).has('d')]).toEqual([false, true]);
    writeFileSync(file, '{ damaged');
    expect(() => new HandledIds(file, 3)).toThrow(/handled\.json.*Delete it/s);
  });
});

describe('the inbox loop: transient causes are kept, permanent ones are refused', () => {
  const policyDocs = async (count: number): Promise<SignedDocument[]> => {
    const docs: SignedDocument[] = [];
    for (let version = 1; version <= count; version++) {
      const file = join(root, `d${version}.json`);
      writeFileSync(file, JSON.stringify({ v: 1, target: uuidOf('laptop'), version, baseVersion: version - 1, defaults: [{ shell: 'sh', command: `echo v${version}` }], peers: {} }));
      await ok(adminDir, ['admin', 'sign-policy', file, '--out', join(root, `p${version}.json`)], pass);
    }
    for (const d of relay.inbox(uuidOf('laptop'))) {
      docs.push(d.document as SignedDocument);
      await createRelayClient({ baseUrl: relay.url, token: relay.token }).deleteInboxDocument(uuidOf('laptop'), d.id);
    }
    return docs;
  };
  const version = () => loadNetwork(dirOf('laptop'), nowSeconds()).policy?.version;

  it('a policy that arrives before its predecessor stays in the inbox (not audited as rejected, not remembered) and installs once the predecessor is there', async () => {
    await enroll('laptop');
    const [v1, v2, v3] = (await policyDocs(3)) as [SignedDocument, SignedDocument, SignedDocument];
    const { loop } = loopFor('laptop');
    await loop.ready;
    await adminClient().putInboxDocument(uuidOf('laptop'), v1);
    await loop.runOnce();
    expect(version()).toBe(1);

    await adminClient().putInboxDocument(uuidOf('laptop'), v3);
    await loop.runOnce();
    await loop.runOnce();
    expect(version()).toBe(1);
    expect(relay.inbox(uuidOf('laptop')).map((d) => d.id)).toEqual([v3.body.id]);
    expect(auditText('laptop')).not.toMatch(/document-rejected/);
    expect(logs.filter((l) => l.includes(v3.body.id) && /waiting/.test(l))).toHaveLength(1);

    await adminClient().putInboxDocument(uuidOf('laptop'), v2);
    await loop.runOnce();
    expect(version()).toBe(3);
    expect(relay.inbox(uuidOf('laptop'))).toHaveLength(0);
  });

  it('in one round: the later policy listed first, its predecessor second, both installed', async () => {
    await enroll('laptop');
    const [v1, v2, v3] = (await policyDocs(3)) as [SignedDocument, SignedDocument, SignedDocument];
    const { loop } = loopFor('laptop');
    await loop.ready;
    await adminClient().putInboxDocument(uuidOf('laptop'), v1);
    await loop.runOnce();
    await adminClient().putInboxDocument(uuidOf('laptop'), v3);
    await adminClient().putInboxDocument(uuidOf('laptop'), v2);
    await loop.runOnce();
    expect(version()).toBe(3);
  });

  it('a sealed secret that cannot be opened keeps the document, says so loudly once, and remembers nothing', async () => {
    await enroll('laptop');
    await enroll('server');
    const real = relay.inbox(uuidOf('laptop'))[0] as { id: string; document: SignedDocument };
    await createRelayClient({ baseUrl: relay.url, token: relay.token }).deleteInboxDocument(uuidOf('laptop'), real.id);
    const key = await unlockAdminKey(adminDir, pass);
    const payload = { ...(real.document.body.payload as Record<string, unknown>), sealedPairSecret: sealTo(generateSigningKeyPair().publicKey, new Uint8Array(32), 'pair-secret:none:x:y') };
    const bad = buildDocument({ kind: 'peer', to: uuidOf('laptop'), id: real.id, issuedAt: real.document.body.issuedAt, expiresAt: real.document.body.expiresAt, payload: payload as unknown as Json }, key.privateKeyPkcs8);
    await adminClient().putInboxDocument(uuidOf('laptop'), bad);
    const { loop } = loopFor('laptop');
    await loop.ready;
    await loop.runOnce();
    expect(relay.inbox(uuidOf('laptop'))).toHaveLength(1);
    expect(machineNames('laptop')).toEqual([]);
    expect(logs.filter((l) => /cannot open the sealed pair secret/.test(l))).toHaveLength(1);
    expect(auditText('laptop')).not.toMatch(/document-rejected|document-accepted/);
    expect(existsSync(join(dirOf('laptop'), 'inbox-state.json'))).toBe(false);
  });

  it('a document about this machine itself is verified and wrong: audited once with its id, deleted, not remembered', async () => {
    await enroll('laptop');
    await enroll('server');
    const real = relay.inbox(uuidOf('laptop'))[0] as { id: string; document: SignedDocument };
    const toServer = relay.inbox(uuidOf('server'))[0]?.document as SignedDocument;
    await createRelayClient({ baseUrl: relay.url, token: relay.token }).deleteInboxDocument(uuidOf('laptop'), real.id);
    // Addressed to laptop but carrying the registration of laptop (the one the document for the server holds).
    const key = await unlockAdminKey(adminDir, pass);
    const selfDoc = buildDocument(
      { kind: 'peer', to: uuidOf('laptop'), id: documentId('self'), issuedAt: real.document.body.issuedAt, expiresAt: real.document.body.expiresAt, payload: toServer.body.payload },
      key.privateKeyPkcs8,
    );
    await adminClient().putInboxDocument(uuidOf('laptop'), selfDoc);
    const { loop } = loopFor('laptop');
    await loop.ready;
    expect(auditText('laptop')).toMatch(/document-rejected/);
    expect(auditText('laptop')).toContain(selfDoc.body.id);
    expect(auditText('laptop')).toMatch(/self-peer/);
    expect(relay.inbox(uuidOf('laptop'))).toHaveLength(0);
    expect(existsSync(join(dirOf('laptop'), 'inbox-state.json'))).toBe(false);
  });

  it('offline for more than 30 days: the expired document is refused (verified, expired), and the admin retry brings the machine back in line', async () => {
    await enroll('laptop');
    await enroll('server');
    clockOverride = nowSeconds() + 31 * 86_400;
    const { loop } = loopFor('laptop');
    await loop.ready;
    expect(machineNames('laptop')).toEqual([]);
    expect(auditText('laptop')).toMatch(/document-rejected/);
    expect(auditText('laptop')).toMatch(/"reason":"expired"/);
    expect(relay.inbox(uuidOf('laptop'))).toHaveLength(0);

    // The clock was the problem: nothing about the expired document was remembered, so the same document can be sent again.
    clockOverride = undefined;
    const retry = await cli(adminDir, ['admin', 'distribute', 'server'], pass);
    expect(retry.code, retry.err).toBe(0);
    await loop.runOnce();
    expect(machineNames('laptop')).toEqual(['server']);
  });
});

describe('the inbox loop: floods and lies of the relay', () => {
  const forgery = (n: number) =>
    buildDocument({ kind: 'revocation', to: uuidOf('laptop'), id: documentId(`forged ${n}`), issuedAt: nowSeconds(), expiresAt: nowSeconds() + 100, payload: { body: { v: 1 }, signature: 'x' } as unknown as Json }, generateSigningKeyPair().privateKeyPkcs8);

  it('sixty forged documents: all deleted, ONE summary line in the audit log, and the same flood again within the hour adds nothing', async () => {
    await enroll('laptop');
    for (let i = 0; i < 60; i++) await adminClient().putInboxDocument(uuidOf('laptop'), forgery(i));
    const { loop } = loopFor('laptop');
    await loop.ready;
    expect(relay.inbox(uuidOf('laptop'))).toHaveLength(0);
    const lines = auditLines('laptop');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('documents-unverified');
    expect(lines[0]).toContain('"count":60');
    expect(existsSync(join(dirOf('laptop'), 'inbox-state.json'))).toBe(false);

    for (let i = 0; i < 60; i++) await adminClient().putInboxDocument(uuidOf('laptop'), forgery(i));
    await loop.runOnce();
    expect(auditLines('laptop')).toHaveLength(1);
    expect(relay.inbox(uuidOf('laptop'))).toHaveLength(0);
  });

  it('a page above 1 MiB is said once, nothing is installed, and the loop goes on', async () => {
    const huge = 'x'.repeat(1024 * 1024 + 10);
    relay.force(`/api/machines/${uuidOf('laptop')}/inbox`, 200, { documents: [{ id: documentId('a'), document: huge, storedAt: '2026-11-15T12:00:00.000Z' }], more: false }, {}, 'GET');
    const { loop, timer } = loopFor('laptop');
    await loop.ready;
    expect(logs.filter((l) => /1 MiB/.test(l))).toHaveLength(1);
    expect(timer.pending()).toBe(1);
  });

  it('a heartbeat that claims a million documents costs one page request, not a million', async () => {
    const { loop } = loopFor('laptop');
    await loop.ready;
    relay.force(`/api/machines/${uuidOf('laptop')}/heartbeat`, 200, { success: true, inbox: { count: 1_000_000 } }, {}, 'POST');
    const lists = () => relay.requests.filter((q) => q.method === 'GET' && q.path.endsWith('/inbox')).length;
    const before = lists();
    await loop.runOnce();
    expect(lists()).toBe(before + 1);
  });

  it('a heartbeat that says 0 while documents wait does not hide them at start: the first round reads the inbox whatever the count says', async () => {
    await enroll('laptop');
    await enroll('server');
    relay.force(`/api/machines/${uuidOf('laptop')}/heartbeat`, 200, { success: true, inbox: { count: 0 } }, {}, 'POST');
    const { loop } = loopFor('laptop');
    await loop.ready;
    expect(machineNames('laptop')).toEqual(['server']);
  });

  it('the sets that remember warnings are bounded', () => {
    const set = new BoundedSet(3);
    for (const k of ['a', 'b', 'c', 'd']) set.add(k);
    expect([set.has('a'), set.has('b'), set.has('d')]).toEqual([false, true, true]);
    expect(set.add('d')).toBe(false);
  });
});

describe('the inbox loop: the handled-id set is bounded, and a replay of an evicted id is harmless for every kind', () => {
  it('peer, policy and revocation documents replayed after their ids were forgotten change nothing', async () => {
    await enroll('laptop');
    await enroll('server');
    const draft = join(root, 'dv1.json');
    writeFileSync(draft, JSON.stringify({ v: 1, target: uuidOf('laptop'), version: 1, baseVersion: 0, defaults: [{ shell: 'sh', command: 'echo v1' }], peers: {} }));
    await ok(adminDir, ['admin', 'sign-policy', draft, '--out', join(root, 'pv1.json')], pass);
    const [peerEntry, policyEntry] = relay.inbox(uuidOf('laptop')) as unknown as [{ document: SignedDocument }, { document: SignedDocument }];
    const { loop } = loopFor('laptop', { handledCap: 1 });
    await loop.ready;
    expect(machineNames('laptop')).toEqual(['server']);
    expect(loadNetwork(dirOf('laptop'), nowSeconds()).policy?.version).toBe(1);

    const revoked = await cli(adminDir, ['admin', 'revoke', 'server'], pass, { ask: yes });
    expect(revoked.code, revoked.err).toBe(0);
    const revocationDoc = relay.inbox(uuidOf('laptop'))[0]?.document as SignedDocument;
    await loop.runOnce();

    const state = () => {
      const n = loadNetwork(dirOf('laptop'), nowSeconds());
      return JSON.stringify({ machines: n.directory.machines(), policy: n.policy?.version, revocations: n.revocations });
    };
    const before = state();
    const remembered = JSON.parse(readFileSync(join(dirOf('laptop'), 'inbox-state.json'), 'utf8')) as { ids: string[] };
    expect(remembered.ids).toEqual([revocationDoc.body.id]);

    // The three ids but the last are forgotten: the relay replays all three documents.
    for (const doc of [peerEntry.document, policyEntry.document, revocationDoc]) await adminClient().putInboxDocument(uuidOf('laptop'), doc);
    await loop.runOnce();
    expect(state()).toBe(before);
    expect(relay.inbox(uuidOf('laptop'))).toHaveLength(0);
  });
});

describe('the inbox loop: the relay misbehaves or is not ready', () => {
  it('never throws on relay errors, warns once per distinct error, backs off, and says when it works again', async () => {
    const { loop, timer } = loopFor('laptop');
    relay.force(`/api/machines/${uuidOf('laptop')}/heartbeat`, 500, { success: false, error: 'store_unavailable', message: 'down' }, {}, 'POST');
    await loop.ready;
    expect(logs.filter((l) => /failed \(500\)/.test(l))).toHaveLength(1);
    expect(timer.delays.at(-1)).toBeGreaterThan(60_000);

    relay.force(`/api/machines/${uuidOf('laptop')}/heartbeat`, 500, { success: false, error: 'store_unavailable', message: 'down' }, {}, 'POST');
    await loop.runOnce();
    expect(logs.filter((l) => /failed \(500\)/.test(l))).toHaveLength(1);

    await loop.runOnce();
    expect(logs.some((l) => /working again|reachable again/i.test(l))).toBe(true);
    // A relay that is down again later is warned about again.
    relay.force(`/api/machines/${uuidOf('laptop')}/heartbeat`, 500, { success: false, error: 'store_unavailable', message: 'down' }, {}, 'POST');
    await loop.runOnce();
    expect(logs.filter((l) => /failed \(500\)/.test(l))).toHaveLength(2);
  });

  it('a relay that cannot be reached is a warning, not a crash', async () => {
    const { loop } = loopFor('laptop', { client: createRelayClient({ baseUrl: 'http://127.0.0.1:1', token: 'x', timeoutMs: 500 }) });
    await loop.ready;
    expect(logs.join('\n')).toMatch(/cannot reach the relay/);
  });

  it('a machine that does not own its inbox says why, once, and keeps trying to read it on every round', async () => {
    // Another token is bound to the uuid (deployed relay: the binding is made at approval).
    relay.setOwner(uuidOf('laptop'), 'tok_another');
    await enroll('laptop');
    await enroll('server');
    const { loop } = loopFor('laptop');
    await loop.ready;
    await loop.runOnce();
    await loop.runOnce();
    const said = logs.filter((l) => /does not own its inbox/.test(l));
    expect(said).toHaveLength(1);
    // The first-writer story is gone: the text says another token is bound and how to fix it.
    expect(said[0]).toMatch(/another token is bound/);
    expect(said[0]).toContain('machine join');
    expect(said[0]).toMatch(/approve/);
    expect(said[0]).not.toMatch(/first machine token|publishes the address record/);
    expect(relay.requests.filter((q) => q.method === 'GET' && q.path.endsWith('/inbox')).length).toBe(3);
    expect(machineNames('laptop')).toEqual([]);

    // Once the relay binds the machine to its token, the waiting documents are installed.
    relay.setOwner(uuidOf('laptop'), relay.token);
    await loop.runOnce();
    expect(machineNames('laptop')).toEqual(['server']);
  });

  it('a relay that does not report the inbox count is said once, and the inbox is then read on every round', async () => {
    const { loop } = loopFor('laptop');
    await loop.ready;
    relay.force(`/api/machines/${uuidOf('laptop')}/heartbeat`, 204, undefined, {}, 'POST');
    relay.force(`/api/machines/${uuidOf('laptop')}/heartbeat`, 204, undefined, {}, 'POST');
    const lists = () => relay.requests.filter((q) => q.method === 'GET' && q.path.endsWith('/inbox')).length;
    const before = lists();
    await loop.runOnce();
    await loop.runOnce();
    expect(lists()).toBe(before + 2);
    expect(logs.filter((l) => /does not report the inbox count/.test(l))).toHaveLength(1);
  });

  it('schedules the next round after the heartbeat period, and stop cancels it', async () => {
    const { loop, timer } = loopFor('laptop');
    await loop.ready;
    expect(timer.delays).toEqual([60_000]);
    expect(timer.pending()).toBe(1);
    loop.stop();
    expect(timer.pending()).toBe(0);
  });
});

describe('the daemon starts the loop only when the machine joined a relay', () => {
  it('with relay.json: the first round runs at start, the documents are installed, stop cancels the timer', async () => {
    await enroll('laptop');
    await enroll('server');
    const timer = fakeTimer();
    const daemon = await startMachineDaemon(dirOf('laptop'), { port: 0, peerPort: 0, peerHost: '127.0.0.1', version: 'v', log: (l) => logs.push(l), inbox: { timer } });
    try {
      expect(daemon.inbox).toBeDefined();
      await daemon.inbox?.ready;
      expect(machineNames('laptop')).toEqual(['server']);
      expect(timer.pending()).toBe(1);
    } finally {
      await daemon.stop();
    }
    expect(timer.pending()).toBe(0);
  });

  it('without relay.json: no loop and no request to any relay', async () => {
    const timer = fakeTimer();
    const mark = relay.requests.length;
    rmSync(join(dirOf('laptop'), '_secrets_', 'relay.json'));
    const daemon = await startMachineDaemon(dirOf('laptop'), { port: 0, peerPort: 0, peerHost: '127.0.0.1', version: 'v', log: (l) => logs.push(l), inbox: { timer } });
    try {
      expect(daemon.inbox).toBeUndefined();
      expect(timer.pending()).toBe(0);
      expect(relay.requests).toHaveLength(mark);
    } finally {
      await daemon.stop();
    }
  });

  it('a corrupt relay.json stops the start with the file named and the fix', async () => {
    writeFileSync(join(dirOf('laptop'), '_secrets_', 'relay.json'), '{ nope');
    await expect(startMachineDaemon(dirOf('laptop'), { port: 0, peerPort: 0, peerHost: '127.0.0.1', version: 'v' })).rejects.toThrow(/relay\.json.*machine join/s);
  });
});
