import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDocument, DOCUMENT_DOMAIN, documentId, generateSigningKeyPair, keyId, nextPolicyBody, signDocument, signPolicy, verifyInboxDocument, type PolicyBody, type SignedPolicy, type SignedDocument } from '@wadeck-app/machine-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unlockAdminKey } from './admin.js';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { readMachine } from './identity.js';
import { adminKeyText, allowContext, submitPolicy } from './policyWeb.js';
import { readPolicyRecord } from './adminAllow.js';
import { cli, fakeTiming, ok } from './testing.js';
import { createRelayClient, RelayError, type RelayClient } from './relayClient.js';

// The daemon side of the Allow button of the Requests page (decision 76). The BROWSER signs; these tests sign with machine-core (the browser
// package is proven byte for byte equal to it in machine-webcrypto/policyEdit.test.ts) and check what the daemon refuses and what it stores.

const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';
const MACHINE_CODE = '12345678';
const SECOND_CODE = '22223333';
const ADMIN_CODE = '87654321';
const yes = async () => 'y';
const now = () => Math.floor(Date.now() / 1000);

let root: string;
let a: string;
let b: string;
let relay: FakeRelay;
let passphrase: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-policyweb-'));
  a = join(root, 'a');
  b = join(root, 'b');
  mkdirSync(a);
  mkdirSync(b);
  relay = await startFakeRelay({ code: MACHINE_CODE, moreCodes: [SECOND_CODE], adminCode: ADMIN_CODE });
});
afterEach(async () => {
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

/** The admin machine "desktop" and a second machine "laptop", both enrolled through the fake relay. */
async function twoMachines(): Promise<void> {
  await ok(a, ['init', '--name', 'desktop']);
  const init = await ok(a, ['admin', 'init', '--generate']);
  passphrase = /passphrase[^\n]*\n\s*([A-Z0-9 -]{20,})/i.exec(init.err)?.[1]?.trim() ?? '';
  await ok(a, ['admin', 'login', ADMIN_CODE, '--full-access', '--relay', relay.url]);
  const first = await cli(a, ['join', MACHINE_CODE, '--relay', relay.url], async () => passphrase, { timing: fakeTiming() });
  expect(first.code, first.err).toBe(0);
  await ok(b, ['init', '--name', 'laptop']);
  await ok(b, ['join', SECOND_CODE, '--relay', relay.url, '--no-wait']);
  const approved = await cli(a, ['admin', 'approve', '--relay', relay.url], async () => passphrase, { ask: yes });
  expect(approved.code, approved.err).toBe(0);
  const joined = await cli(b, ['join', '--resume'], undefined, { timing: fakeTiming(), ask: yes });
  expect(joined.code, joined.err).toBe(0);
}

/** What the page does after the passphrase: next body from the context, signature, inbox document. Same rules as the browser build. */
async function browserSigns(machine: string, command: string, opts: { current?: SignedPolicy | null; edit?: 'allow' | 'remove'; shell?: string } = {}): Promise<{ policy: SignedPolicy; document: SignedDocument; body: PolicyBody }> {
  const context = allowContext(a, { machine }, now());
  if (!context.ok) throw new Error(`context: ${context.message}`);
  const pair = await unlockAdminKey(a, async () => passphrase);
  const current = opts.current === undefined ? context.current : opts.current;
  const change = opts.edit === 'remove' ? ({ kind: 'remove', command } as const) : ({ kind: 'allow', entry: { shell: (opts.shell ?? SHELL) as 'cmd', command } } as const);
  const edit = nextPolicyBody(current?.body, { target: context.target.uuid, adminKeyId: context.adminKeyId, now: now() }, change);
  if (!edit.changed) throw new Error(`no change: ${edit.reason}`);
  const policy = signPolicy(edit.body, pair.privateKeyPkcs8);
  // Sealed to the identity key of the target that the context gave (decision 78): the daemon cannot open it, the target can.
  const recipient = context.target.identityPublicKey;
  if (recipient === undefined) throw new Error('context: no identity key for the target');
  const document = buildDocument(
    { kind: 'policy', to: policy.body.target, id: documentId(`v2:policy:${policy.body.target}:${policy.body.version}:${policy.signature}`), issuedAt: policy.body.issuedAt, expiresAt: Math.min(policy.body.issuedAt + 30 * 86400, policy.body.notAfter), payload: policy as never, recipientIdentityPublicKey: recipient },
    pair.privateKeyPkcs8,
  );
  return { policy, document, body: edit.body };
}

/** Mode local on machine a: a valid mode file (the public key of a local policy key). */
function makeLocal(): void {
  const pair = generateSigningKeyPair();
  writeFileSync(join(a, 'policy-mode.json'), JSON.stringify({ v: 1, mode: 'local', localPublicKey: pair.publicKey, localKeyId: keyId(pair.publicKey), since: 1 }));
}

const policyDocs = (uuid: string) => relay.inbox(uuid).filter((d) => (d.document as unknown as { body: { kind: string } }).body.kind === 'policy');

describe('adminKeyText: the encrypted admin key file for the page', () => {
  it('serves the file as it is on disk (encrypted, passphrase hint included) and never anything else', async () => {
    await twoMachines();
    const answer = adminKeyText(a);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    const onDisk = readFileSync(join(a, '_secrets_', 'admin.key.json'), 'utf8');
    expect(answer.file).toBe(onDisk);
    const parsed = JSON.parse(answer.file) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(expect.arrayContaining(['cipher', 'ciphertext', 'kdf', 'publicKey', 'v']));
  });

  it('says there is no admin key here, and what to do', async () => {
    await ok(b, ['init', '--name', 'laptop']);
    const answer = adminKeyText(b);
    expect(answer).toMatchObject({ ok: false, reason: 'no-admin-key' });
    expect((answer as { message: string }).message).toMatch(/machine admin init|machine that holds the admin key/);
  });

  it('refuses to serve a file that is not an encrypted admin key (a plain private key must never leave the disk)', async () => {
    await twoMachines();
    writeFileSync(join(a, '_secrets_', 'admin.key.json'), JSON.stringify({ v: 1, publicKey: 'x', privateKey: 'AAAA' }));
    const answer = adminKeyText(a);
    expect(answer).toMatchObject({ ok: false, reason: 'key-file-invalid' });
    expect(JSON.stringify(answer)).not.toContain('AAAA');
  });

  it('refuses a damaged (non JSON) file with the file name and the fix', async () => {
    await twoMachines();
    writeFileSync(join(a, '_secrets_', 'admin.key.json'), 'not json');
    const answer = adminKeyText(a);
    expect(answer).toMatchObject({ ok: false, reason: 'key-file-invalid' });
    expect((answer as { message: string }).message).toMatch(/admin\.key\.json.*Copy the admin key file again from another machine/s);
  });
});

describe('allowContext: what the page needs before it asks the passphrase', () => {
  it('for this machine (the admin machine): no policy yet, installed here, nothing else needed', async () => {
    await twoMachines();
    const context = allowContext(a, { machine: readMachine(a).uuid }, now());
    expect(context).toMatchObject({ ok: true, toSelf: true, policyMode: 'admin', current: null, delivery: 'install', target: { name: 'desktop' } });
    expect((context as { adminKeyId: string }).adminKeyId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('for a peer: the policy recorded here (verified), delivered through the relay inbox', async () => {
    await twoMachines();
    const first = await browserSigns('laptop', 'echo one');
    expect((await submitPolicy(a, { policy: first.policy, document: first.document }, now())).ok).toBe(true);
    const context = allowContext(a, { machine: 'laptop' }, now());
    expect(context).toMatchObject({ ok: true, toSelf: false, delivery: 'inbox', target: { name: 'laptop' } });
    expect((context as { current: SignedPolicy }).current).toEqual(first.policy);
  });

  it('gives the identity key of the target (from the registration this admin holds): the page seals the inbox document to it', async () => {
    await twoMachines();
    expect(allowContext(a, { machine: 'laptop' }, now())).toMatchObject({ ok: true, target: { name: 'laptop', identityPublicKey: readMachine(b).identity.publicKey } });
    expect(allowContext(a, { machine: readMachine(a).uuid }, now())).toMatchObject({ ok: true, target: { name: 'desktop', identityPublicKey: readMachine(a).identity.publicKey } });
  });

  it('for a peer without the admin relay token: refused BEFORE any passphrase, with the login command', async () => {
    await twoMachines();
    rmSync(join(a, '_secrets_', 'relay-admin.json'));
    const context = allowContext(a, { machine: 'laptop' }, now());
    expect(context).toMatchObject({ ok: false, reason: 'no-admin-token' });
    expect((context as { message: string }).message).toMatch(/machine admin login <code> --relay/);
  });

  it('an unknown machine is named as such, with `machine list`', async () => {
    await twoMachines();
    const context = allowContext(a, { machine: 'nothere' }, now());
    expect(context).toMatchObject({ ok: false, reason: 'unknown-machine' });
    expect((context as { message: string }).message).toMatch(/nothere/);
  });

  it('a machine without the admin key says so and points to the admin machine', async () => {
    await twoMachines();
    const context = allowContext(b, { machine: readMachine(b).uuid }, now());
    expect(context).toMatchObject({ ok: false, reason: 'no-admin-key' });
    expect((context as { message: string }).message).toMatch(/holds the admin key/);
  });

  it('a machine in policy mode local points to `machine policy allow` on that machine', async () => {
    await twoMachines();
    makeLocal();
    const context = allowContext(a, { machine: readMachine(a).uuid }, now());
    expect(context).toMatchObject({ ok: false, reason: 'mode-local' });
    expect((context as { message: string }).message).toMatch(/machine policy allow/);
  });

  it('a policy recorded here that does not match the admin key is reported, not used as a base', async () => {
    await twoMachines();
    mkdirSync(join(a, 'policies'), { recursive: true });
    writeFileSync(join(a, 'policies', `${readMachine(b).uuid}.json`), '{"nope":1}');
    const context = allowContext(a, { machine: 'laptop' }, now());
    expect(context).toMatchObject({ ok: false, reason: 'policy-record-invalid' });
    expect((context as { message: string }).message).toMatch(/delete it/);
  });

  it('a bad request names the field', () => {
    expect(allowContext(a, {}, now())).toMatchObject({ ok: false, reason: 'bad-payload' });
  });
});

describe('submitPolicy: the signed document the browser produced', () => {
  it('this machine: verifies, installs it (machine status shows the version) and records it like `admin allow` does', async () => {
    await twoMachines();
    const self = readMachine(a).uuid;
    const signed = await browserSigns(self, 'echo mine');
    const answer = await submitPolicy(a, { policy: signed.policy }, now());
    expect(answer).toMatchObject({ ok: true, delivery: 'installed', version: 1, target: { name: 'desktop' } });
    expect(JSON.parse((await ok(a, ['status', '--json'])).out)).toMatchObject({ policyVersion: 1 });
    expect(readPolicyRecord(a, self, JSON.parse(readFileSync(join(a, 'admin.json'), 'utf8')).adminPublicKey)?.body.version).toBe(1);
    // The next edit of the page starts from what is installed.
    const next = await browserSigns(self, 'echo again');
    expect(next.body.version).toBe(2);
    expect((await submitPolicy(a, { policy: next.policy }, now())).ok).toBe(true);
    expect(JSON.parse((await ok(a, ['status', '--json'])).out)).toMatchObject({ policyVersion: 2 });
  });

  it('a peer: stores the policy document in its relay inbox exactly like `machine admin allow`, and the peer installs it', async () => {
    await twoMachines();
    const signed = await browserSigns('laptop', 'echo hello');
    const answer = await submitPolicy(a, { policy: signed.policy, document: signed.document }, now());
    expect(answer).toMatchObject({ ok: true, delivery: 'inbox', version: 1, target: { name: 'laptop' } });
    const docs = policyDocs(readMachine(b).uuid);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.document).toEqual(signed.document);
    // Sealed: the relay (and this daemon) cannot read the entries, the target opens it with its identity key and finds the policy that was signed.
    expect(JSON.stringify(docs[0]?.document)).not.toContain('echo hello');
    const opened = verifyInboxDocument(docs[0]?.document, { adminPublicKey: JSON.parse(readFileSync(join(a, 'admin.json'), 'utf8')).adminPublicKey, selfUuid: readMachine(b).uuid, now: now(), identityPrivateKeyPkcs8: readMachine(b).identity.privateKeyPkcs8 });
    expect(opened.ok && opened.kind === 'policy' ? opened.policy : undefined).toEqual(signed.policy);
    // The target accepts it as it is: signature, target, base version.
    const file = join(root, 'v1.json');
    writeFileSync(file, JSON.stringify(signed.policy));
    expect((await cli(b, ['policy', 'install', file])).code).toBe(0);
    expect(JSON.parse((await ok(b, ['status', '--json'])).out)).toMatchObject({ policyVersion: 1 });
  });

  it('sending the same document again is not an error: the relay already holds it', async () => {
    await twoMachines();
    const signed = await browserSigns('laptop', 'echo hello');
    await submitPolicy(a, { policy: signed.policy, document: signed.document }, now());
    const again = await submitPolicy(a, { policy: signed.policy, document: signed.document }, now());
    // The fake relay takes the same bytes again without a conflict (the real one may answer `id_conflict`, which is reported as alreadyThere).
    expect(again).toMatchObject({ ok: true, delivery: 'inbox' });
    expect(policyDocs(readMachine(b).uuid)).toHaveLength(1);
  });

  it('a relay that answers id_conflict already holds the document: reported as alreadyThere', async () => {
    await twoMachines();
    const signed = await browserSigns('laptop', 'echo hello');
    const conflict = { ...createRelayClient({ baseUrl: relay.url, token: 'x' }), putInboxDocument: async () => { throw new RelayError({ status: 409, code: 'id_conflict', message: 'conflict' }); } } as RelayClient;
    expect(await submitPolicy(a, { policy: signed.policy, document: signed.document }, now(), { client: conflict })).toMatchObject({ ok: true, delivery: 'inbox', alreadyThere: true });
  });

  it('this machine: submitting the very policy that is installed (page clicked twice) is not an error and changes nothing', async () => {
    await twoMachines();
    const signed = await browserSigns(readMachine(a).uuid, 'echo mine');
    expect((await submitPolicy(a, { policy: signed.policy }, now())).ok).toBe(true);
    expect(await submitPolicy(a, { policy: signed.policy }, now())).toMatchObject({ ok: true, delivery: 'installed', alreadyThere: true, version: 1 });
  });

  it('refuses a policy signed by another key (nothing is stored, nothing is sent)', async () => {
    await twoMachines();
    const signed = await browserSigns('laptop', 'echo hello');
    const other = generateSigningKeyPair();
    const forged = signPolicy(signed.body, other.privateKeyPkcs8);
    const answer = await submitPolicy(a, { policy: forged, document: signed.document }, now());
    expect(answer).toMatchObject({ ok: false, reason: 'bad-signature' });
    expect((answer as { message: string }).message).toMatch(/admin key pinned on this machine/);
    expect(policyDocs(readMachine(b).uuid)).toHaveLength(0);
    expect(() => readFileSync(join(a, 'policies', `${readMachine(b).uuid}.json`))).toThrow();
  });

  it('refuses a stale base: the policy changed since the page read it (compare-and-set), and says to reload', async () => {
    await twoMachines();
    const stale = await browserSigns('laptop', 'echo one');
    const fresh = await browserSigns('laptop', 'echo two');
    expect((await submitPolicy(a, { policy: fresh.policy, document: fresh.document }, now())).ok).toBe(true);
    const answer = await submitPolicy(a, { policy: stale.policy, document: stale.document }, now());
    expect(answer).toMatchObject({ ok: false, reason: 'stale-base' });
    expect((answer as { message: string }).message).toMatch(/version 1.*reload/s);
    expect(policyDocs(readMachine(b).uuid)).toHaveLength(1);
  });

  it('refuses a policy for a machine that is not a trusted peer', async () => {
    await twoMachines();
    const signed = await browserSigns('laptop', 'echo hello');
    const pair = await unlockAdminKey(a, async () => passphrase);
    const stranger = signPolicy({ ...signed.body, target: '33333333-3333-4333-8333-333333333333' }, pair.privateKeyPkcs8);
    const answer = await submitPolicy(a, { policy: stranger, document: signed.document }, now());
    expect(answer).toMatchObject({ ok: false, reason: 'unknown-machine' });
  });

  it('refuses a document that does not carry this policy, or is addressed to someone else, or is not signed by the admin', async () => {
    await twoMachines();
    const one = await browserSigns('laptop', 'echo one');
    const two = await browserSigns('laptop', 'echo two');
    expect(await submitPolicy(a, { policy: one.policy, document: two.document }, now())).toMatchObject({ ok: false, reason: 'bad-document' });
    expect(await submitPolicy(a, { policy: one.policy }, now())).toMatchObject({ ok: false, reason: 'bad-document' });
    const tampered = { ...one.document, body: { ...one.document.body, to: readMachine(a).uuid } };
    expect(await submitPolicy(a, { policy: one.policy, document: tampered as SignedDocument }, now())).toMatchObject({ ok: false, reason: 'bad-document' });
    expect(policyDocs(readMachine(b).uuid)).toHaveLength(0);
  });

  it('refuses a plaintext (version 1) document and a sealed one bound to another id, with the reason and nothing sent', async () => {
    await twoMachines();
    const one = await browserSigns('laptop', 'echo one');
    const pair = await unlockAdminKey(a, async () => passphrase);
    // A document signed with the old clear envelope (what an old page would build): refused, the relay must never carry the entries in clear.
    const clear = { v: 1, kind: 'policy', to: one.policy.body.target, id: one.document.body.id, issuedAt: one.policy.body.issuedAt, expiresAt: one.document.body.expiresAt, payload: one.policy };
    const plain = { body: clear, signature: signDocument(DOCUMENT_DOMAIN, clear as never, pair.privateKeyPkcs8) };
    const plainAnswer = await submitPolicy(a, { policy: one.policy, document: plain }, now());
    expect(plainAnswer).toMatchObject({ ok: false, reason: 'bad-document' });
    expect((plainAnswer as { message: string }).message).toMatch(/plaintext/);
    // Sealed and signed by the admin, but its id is not the one of this policy: it cannot be the document that carries it.
    const other = buildDocument(
      { kind: 'policy', to: one.policy.body.target, id: documentId('something else'), issuedAt: one.policy.body.issuedAt, expiresAt: one.document.body.expiresAt, payload: one.policy as never, recipientIdentityPublicKey: readMachine(b).identity.publicKey },
      pair.privateKeyPkcs8,
    );
    const otherAnswer = await submitPolicy(a, { policy: one.policy, document: other }, now());
    expect(otherAnswer).toMatchObject({ ok: false, reason: 'bad-document' });
    expect((otherAnswer as { message: string }).message).toMatch(/does not carry the policy/);
    expect(policyDocs(readMachine(b).uuid)).toHaveLength(0);
  });

  it('a relay that refuses is reported with the exact command that finishes the job; the policy stays recorded', async () => {
    await twoMachines();
    const signed = await browserSigns('laptop', 'echo hello');
    const dead = createRelayClient({ baseUrl: 'http://127.0.0.1:9', token: 'x' });
    const answer = await submitPolicy(a, { policy: signed.policy, document: signed.document }, now(), { client: dead });
    expect(answer).toMatchObject({ ok: false, reason: 'relay-error', recorded: true });
    expect((answer as { message: string }).message).toMatch(/machine admin distribute --policy .*policies/);
    expect(readPolicyRecord(a, readMachine(b).uuid, JSON.parse(readFileSync(join(a, 'admin.json'), 'utf8')).adminPublicKey)?.body.version).toBe(1);
  });

  it('mode local on this machine: an admin signature is refused with the right command', async () => {
    await twoMachines();
    const self = readMachine(a).uuid;
    const signed = await browserSigns(self, 'echo mine');
    makeLocal();
    const answer = await submitPolicy(a, { policy: signed.policy }, now());
    expect(answer).toMatchObject({ ok: false, reason: 'mode-local' });
  });

  it('removing an entry works through the same path', async () => {
    await twoMachines();
    const first = await browserSigns('laptop', 'echo one');
    await submitPolicy(a, { policy: first.policy, document: first.document }, now());
    const removal = await browserSigns('laptop', 'echo one', { edit: 'remove' });
    expect(removal.body.defaults).toEqual([]);
    expect(await submitPolicy(a, { policy: removal.policy, document: removal.document }, now())).toMatchObject({ ok: true, version: 2 });
  });

  it('a malformed payload says what was expected, and never echoes it', async () => {
    await twoMachines();
    const answer = await submitPolicy(a, { policy: { body: { secret: 'S3CRET' }, signature: 'x' } }, now());
    expect(answer).toMatchObject({ ok: false, reason: 'bad-payload' });
    expect(JSON.stringify(answer)).not.toContain('S3CRET');
    expect(await submitPolicy(a, undefined, now())).toMatchObject({ ok: false, reason: 'bad-payload' });
  });
});
