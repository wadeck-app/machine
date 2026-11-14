import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newCandidacyRandom, openPairSecret, verifyInboxDocument, type SignedRegistration } from '@wadeck-app/machine-core';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { readMachine } from './identity.js';
import { exportMachineInfo, loadNetwork } from './network.js';
import { cli, makeAdmin, ok, type TestAdmin } from './testing.js';

let root: string;
let adminDir: string;
let relay: FakeRelay;
let admin: TestAdmin;

const yes = async () => 'y';
const pass = async () => admin.passphrase;
const dirOf = (name: string) => join(root, name);
const uuidOf = (name: string) => readMachine(dirOf(name)).uuid;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const approveArgs = (id: string) => ['admin', 'approve', id, '--relay', relay.url];

/** The relay lists a candidacy the machine in `name` would have posted (the admin side does not need the join itself). */
async function enroll(name: string, options: { ask?: (l: string) => Promise<string> } = {}) {
  const info = exportMachineInfo(dirOf(name));
  const id = `cand-${name}`;
  relay.addCandidacy(id, { name: info.name, hostname: 'h', identityPublicKey: info.identityPublicKey, random: newCandidacyRandom(), uuid: info.uuid });
  return { id, result: await cli(adminDir, approveArgs(id), pass, { ask: options.ask ?? yes }) };
}

const inboxOf = (name: string) => relay.inbox(uuidOf(name));
const verified = (name: string, document: unknown) => verifyInboxDocument(document, { adminPublicKey: admin.adminPublicKey, selfUuid: uuidOf(name), now: nowSeconds() });
const inboxPuts = () => relay.requests.filter((q) => q.method === 'PUT' && /\/inbox\//.test(q.path));

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-distribute-'));
  adminDir = dirOf('desktop');
  for (const name of ['desktop', 'laptop', 'server']) {
    mkdirSync(dirOf(name));
    await ok(dirOf(name), ['init', '--name', name]);
  }
  relay = await startFakeRelay();
  admin = makeAdmin(adminDir);
  await ok(adminDir, ['admin', 'login', '87654321', '--relay', relay.url]);
});
afterEach(async () => {
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

describe('machine admin approve distributes the new machine to the existing peers', () => {
  it('the first machine of a network has nobody to tell: no document, and the output says so', async () => {
    const { result } = await enroll('laptop');
    expect(result.code, result.err).toBe(0);
    expect(inboxPuts()).toHaveLength(0);
    expect(result.out).toMatch(/no other peer/i);
  });

  it('the second machine: one peer document to each side, sealed to the right key, with the same pair secret, after the decision', async () => {
    await enroll('laptop');
    const { id, result } = await enroll('server');
    expect(result.code, result.err).toBe(0);

    const toLaptop = inboxOf('laptop');
    const toServer = inboxOf('server');
    expect(toLaptop).toHaveLength(1);
    expect(toServer).toHaveLength(1);
    // Never to the admin machine itself, never a third copy.
    expect(inboxOf('desktop')).toHaveLength(0);

    const aboutServer = verified('laptop', toLaptop[0]?.document);
    const aboutLaptop = verified('server', toServer[0]?.document);
    if (!aboutServer.ok || aboutServer.kind !== 'peer' || !aboutLaptop.ok || aboutLaptop.kind !== 'peer') throw new Error('expected two verified peer documents');
    expect(aboutServer.registration.uuid).toBe(uuidOf('server'));
    expect(aboutServer.registration.identityPublicKey).toBe(exportMachineInfo(dirOf('server')).identityPublicKey);
    expect(aboutLaptop.registration.uuid).toBe(uuidOf('laptop'));
    expect(aboutServer.adminUuid).toBe(uuidOf('desktop'));
    // Each side opens its own sealed secret with its own identity key, and both get the same secret.
    const secretOfLaptop = openPairSecret(aboutServer, readMachine(dirOf('laptop')).identity.privateKeyPkcs8);
    const secretOfServer = openPairSecret(aboutLaptop, readMachine(dirOf('server')).identity.privateKeyPkcs8);
    expect(secretOfLaptop).toBe(secretOfServer);
    expect(Buffer.from(secretOfLaptop, 'base64url')).toHaveLength(32);
    // The secret is NOT the pair secret the admin shares with either machine.
    const adminNetwork = loadNetwork(adminDir, nowSeconds());
    expect(adminNetwork.directory.find(uuidOf('laptop'))?.pairSecret.toString('base64url')).not.toBe(secretOfLaptop);

    // After the decision, never before; and with the admin token only.
    const decisionIndex = relay.requests.findIndex((q) => q.method === 'PUT' && q.path === `/api/machines/candidacies/${id}/decision`);
    const firstPut = relay.requests.findIndex((q) => q.method === 'PUT' && q.path.includes('/inbox/'));
    expect(firstPut).toBeGreaterThan(decisionIndex);
    for (const put of inboxPuts()) expect(put.authorization).toBe(`Bearer ${relay.adminToken}`);
    expect(result.out).toMatch(/1 machine/);
    // Neither the secret nor a token reaches the output.
    expect(result.out + result.err).not.toContain(secretOfLaptop);
    expect(result.out + result.err).not.toContain(relay.adminToken);
  });

  it('ids, issuedAt and expiry are stable: they come from the registrations, not from the clock', async () => {
    await enroll('laptop');
    await enroll('server');
    const doc = inboxOf('laptop')[0]?.document as { body: { id: string; issuedAt: number; expiresAt: number } };
    const registration = (verified('laptop', doc) as unknown as { registration: SignedRegistration['body'] }).registration;
    expect(doc.body.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(doc.body.issuedAt).toBe(registration.validFrom);
    expect(doc.body.expiresAt).toBeGreaterThan(doc.body.issuedAt);
    expect(doc.body.expiresAt - doc.body.issuedAt).toBeLessThanOrEqual(30 * 86_400);
  });

  it('nothing is sent when the decision itself fails (the approval did not happen)', async () => {
    await enroll('laptop');
    relay.addCandidacy('cand-server', { name: 'server', hostname: 'h', identityPublicKey: exportMachineInfo(dirOf('server')).identityPublicKey, random: newCandidacyRandom(), uuid: uuidOf('server') });
    relay.force('/api/machines/candidacies/cand-server/decision', 500, { success: false, error: 'store_unavailable', message: 'down' }, {}, 'PUT');
    const r = await cli(adminDir, approveArgs('cand-server'), pass, { ask: yes });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/NOT approved/);
    expect(inboxPuts()).toHaveLength(0);
  });

  it('a failed delivery is loud, names the machine and the exact retry command, and does NOT undo the approval', async () => {
    await enroll('laptop');
    relay.force(`/api/machines/${uuidOf('laptop')}/inbox`, 500, { success: false, error: 'store_unavailable', message: 'disk full' }, {}, 'PUT');
    const { id, result } = await enroll('server');
    expect(result.code).toBe(1);
    expect(result.err).toContain('laptop');
    expect(result.err).toContain(uuidOf('laptop'));
    expect(result.err).toMatch(/disk full|failed \(500\)/);
    expect(result.err).toContain(`machine admin distribute ${uuidOf('server')}`);
    expect(result.err).toMatch(/approval (stands|is kept|was not undone)/i);
    // The approval stands and the final code was printed.
    expect(relay.candidacies.get(id)?.status).toBe('approved');
    expect(result.out).toMatch(/Final code/);
    // The other direction was delivered, this one was not.
    expect(inboxOf('server')).toHaveLength(1);
    expect(inboxOf('laptop')).toHaveLength(0);

    const retry = await cli(adminDir, ['admin', 'distribute', uuidOf('server')], pass, { ask: yes });
    expect(retry.code, retry.err).toBe(0);
    expect(inboxOf('laptop')).toHaveLength(1);
    expect(inboxOf('server')).toHaveLength(1);
    // The one already there is reported, not an error.
    expect(retry.out).toMatch(/already/i);
  });

  it('a second `distribute` changes nothing: same ids, no duplicate, exit 0', async () => {
    await enroll('laptop');
    await enroll('server');
    const before = inboxOf('laptop').map((d) => d.id);
    const again = await cli(adminDir, ['admin', 'distribute', 'server'], pass);
    expect(again.code, again.err).toBe(0);
    expect(inboxOf('laptop').map((d) => d.id)).toEqual(before);
    expect(inboxOf('server')).toHaveLength(1);
  });

  it('stops at the first sign that the relay cannot be used (revoked admin token) instead of repeating the error for every peer', async () => {
    await enroll('laptop');
    relay.force(`/api/machines/${uuidOf('laptop')}/inbox`, 401, { success: false, error: 'unauthorized', message: 'revoked' }, {}, 'PUT');
    const { result } = await enroll('server');
    expect(result.code).toBe(1);
    expect(inboxPuts()).toHaveLength(1);
    expect(result.err).toMatch(/machine admin login/);
    expect(result.err).toContain(`machine admin distribute ${uuidOf('server')}`);
  });
});

describe('machine admin distribute', () => {
  it('needs the machine, a known one, and the admin relay token', async () => {
    expect((await cli(adminDir, ['admin', 'distribute'])).code).toBe(2);
    const unknown = await cli(adminDir, ['admin', 'distribute', 'nobody'], pass);
    expect(unknown.code).toBe(3);
    rmSync(join(adminDir, '_secrets_', 'relay-admin.json'));
    const noToken = await cli(adminDir, ['admin', 'distribute', 'laptop'], pass);
    expect(noToken.code).toBe(1);
    expect(noToken.err).toMatch(/machine admin login/);
  });

  it('a wrong passphrase sends nothing', async () => {
    await enroll('laptop');
    await enroll('server');
    const before = inboxPuts().length;
    const r = await cli(adminDir, ['admin', 'distribute', 'server'], async () => 'wrong passphrase');
    expect(r.code).toBe(1);
    expect(inboxPuts().length).toBe(before);
  });

  it('the passphrase prompt obeys --prompt-timeout like the other admin commands', async () => {
    await enroll('laptop');
    await enroll('server');
    const r = await cli(adminDir, ['admin', 'distribute', 'server', '--prompt-timeout', '5'], pass);
    expect(r.code, r.err).toBe(0);
    const never = await cli(adminDir, ['admin', 'distribute', 'server', '--prompt-timeout', '0'], pass);
    expect(never.code).toBe(2);
  });
});

describe('machine admin revoke distributes the revocation', () => {
  async function threeMachines() {
    await enroll('laptop');
    await enroll('server');
  }

  it('PUTs a revocation to every other machine, then removes the revoked machine from the relay', async () => {
    await threeMachines();
    relay.setOwner(uuidOf('server'), relay.token);
    const serverUuid = uuidOf('server');
    const mark = relay.requests.length;
    const r = await cli(adminDir, ['admin', 'revoke', 'server'], pass, { ask: yes });
    expect(r.code, r.err).toBe(0);

    const documents = inboxOf('laptop').map((d) => d.document);
    const revocations = documents.map((d) => verified('laptop', d)).filter((v) => v.ok && v.kind === 'revocation');
    expect(revocations).toHaveLength(1);
    const first = revocations[0];
    if (!first || !first.ok || first.kind !== 'revocation') throw new Error('expected a revocation document');
    expect(first.revocation.body.entries.map((e) => e.uuid)).toEqual([serverUuid]);
    // Not to the revoked machine, nor to the admin machine itself.
    expect(inboxOf('server').filter((d) => (d.document as { body: { kind: string } }).body.kind === 'revocation')).toHaveLength(0);
    expect(inboxOf('desktop')).toHaveLength(0);

    const after = relay.requests.slice(mark).map((q) => `${q.method} ${q.path}`);
    const lastPut = after.map((x, i) => (x.startsWith('PUT ') && x.includes('/inbox/') ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    const deleteAt = after.indexOf(`DELETE /api/machines/${serverUuid}`);
    expect(lastPut).toBeGreaterThanOrEqual(0);
    expect(deleteAt).toBeGreaterThan(lastPut);
    expect(relay.inbox(serverUuid)).toEqual([]);
    // The old "known limit" is gone: the output says who was informed.
    expect(r.out).not.toMatch(/THIS machine only/);
    expect(r.out).toMatch(/1 (other )?machine/);
  });

  it('a failure is loud with the retry command, the local revocation stands, and the retry finishes the job', async () => {
    await threeMachines();
    relay.force(`/api/machines/${uuidOf('laptop')}/inbox`, 500, { success: false, error: 'store_unavailable', message: 'disk full' }, {}, 'PUT');
    const r = await cli(adminDir, ['admin', 'revoke', 'server'], pass, { ask: yes });
    expect(r.code).toBe(1);
    expect(r.err).toContain('laptop');
    expect(r.err).toContain(`machine admin distribute ${uuidOf('server')}`);
    // Revoked locally all the same.
    expect(loadNetwork(adminDir, nowSeconds()).revocations.map((e) => e.uuid)).toEqual([uuidOf('server')]);
    expect(inboxOf('laptop').filter((d) => (d.document as { body: { kind: string } }).body.kind === 'revocation')).toHaveLength(0);

    // The revoked machine is not in the directory any more: the retry takes its uuid.
    const retry = await cli(adminDir, ['admin', 'distribute', uuidOf('server')], pass);
    expect(retry.code, retry.err).toBe(0);
    expect(inboxOf('laptop').filter((d) => (d.document as { body: { kind: string } }).body.kind === 'revocation')).toHaveLength(1);
    expect(relay.requests.some((q) => q.method === 'DELETE' && q.path === `/api/machines/${uuidOf('server')}`)).toBe(true);
  });

  it('without an admin relay token: revoked locally, one clear line says the others were not told and how to do it', async () => {
    await threeMachines();
    rmSync(join(adminDir, '_secrets_', 'relay-admin.json'));
    const mark = relay.requests.length;
    const r = await cli(adminDir, ['admin', 'revoke', 'server'], pass, { ask: yes });
    expect(r.code, r.err).toBe(0);
    expect(relay.requests.length).toBe(mark);
    expect(r.out + r.err).toMatch(/NOT distributed/);
    expect(r.out + r.err).toContain('machine admin login');
    expect(r.out + r.err).toContain(`machine admin distribute ${uuidOf('server')}`);
  });
});

describe('policies signed by the admin', () => {
  const draft = () => {
    const file = join(root, 'draft.json');
    writeFileSync(file, JSON.stringify({ v: 1, target: uuidOf('laptop'), version: 1, baseVersion: 0, defaults: [{ shell: 'sh', command: 'echo hi' }], peers: {} }));
    return file;
  };

  it('sign-policy also PUTs a policy document to its target when the admin holds relay credentials', async () => {
    const out = join(root, 'policy.json');
    const r = await cli(adminDir, ['admin', 'sign-policy', draft(), '--out', out], pass);
    expect(r.code, r.err).toBe(0);
    const docs = inboxOf('laptop');
    expect(docs).toHaveLength(1);
    const v = verified('laptop', docs[0]?.document);
    if (!v.ok || v.kind !== 'policy') throw new Error('expected a policy document');
    expect(v.policy.body.version).toBe(1);
    expect(v.body.issuedAt).toBe(v.policy.body.issuedAt);
    // One passphrase for the signature and the document.
    expect(r.err + r.out).toMatch(/stored by the relay/);
    expect(r.err + r.out).not.toMatch(/delivered/);
  });

  it('without relay credentials: the file is written, ONE line says the policy was not distributed and how to do it', async () => {
    rmSync(join(adminDir, '_secrets_', 'relay-admin.json'));
    const out = join(root, 'policy.json');
    const mark = relay.requests.length;
    const r = await cli(adminDir, ['admin', 'sign-policy', draft(), '--out', out], pass);
    expect(r.code, r.err).toBe(0);
    expect(relay.requests.length).toBe(mark);
    const lines = (r.err + r.out).split('\n').filter((l) => /not distributed/i.test(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('machine admin login');
    expect(lines[0]).toContain('machine admin distribute --policy');
  });

  it('`admin distribute --policy <file>` sends a policy that was signed earlier, and the same file again is idempotent (byte for byte)', async () => {
    // The pairing code of the fake relay is single-use: the stored token is put aside and put back.
    const tokenFile = join(adminDir, '_secrets_', 'relay-admin.json');
    const saved = readFileSync(tokenFile, 'utf8');
    rmSync(tokenFile);
    const out = join(root, 'policy.json');
    await ok(adminDir, ['admin', 'sign-policy', draft(), '--out', out], pass);
    expect(inboxOf('laptop')).toHaveLength(0);
    writeFileSync(tokenFile, saved);
    const r = await cli(adminDir, ['admin', 'distribute', '--policy', out], pass);
    expect(r.code, r.err).toBe(0);
    expect(inboxOf('laptop')).toHaveLength(1);
    const again = await cli(adminDir, ['admin', 'distribute', '--policy', out], pass);
    expect(again.code, again.err).toBe(0);
    expect(inboxOf('laptop')).toHaveLength(1);
  });

  it('a policy too large for a document is refused with the reason, the signed file is still written', async () => {
    const entries = Array.from({ length: 150 }, (_, i) => ({ shell: 'sh', command: `echo ${String(i).padStart(4, '0')} ${'x'.repeat(100)}` }));
    const peers: Record<string, unknown> = {};
    for (let i = 0; i < 3; i++) peers[`00000000-0000-4000-8000-00000000000${i}`] = entries;
    const file = join(root, 'big.json');
    writeFileSync(file, JSON.stringify({ v: 1, target: uuidOf('laptop'), version: 1, baseVersion: 0, defaults: entries, peers }));
    const out = join(root, 'big-policy.json');
    const r = await cli(adminDir, ['admin', 'sign-policy', file, '--out', out], pass);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/too large|16 KiB/);
    expect(inboxOf('laptop')).toHaveLength(0);
  });
});

describe('HELP', () => {
  it('names distribute, and says that approve, revoke and sign-policy use the relay', async () => {
    const r = await cli(adminDir, ['--help']);
    expect(r.out).toMatch(/admin distribute <machine\|uuid>/);
    expect(r.out).toMatch(/admin distribute --policy <signed\.json>/);
    expect(r.out).toMatch(/other peers are told about the new machine through the\s+relay/);
    expect(r.out).toMatch(/removes the revoked\s+machine from the relay/);
  });
});

describe('what the admin is told', () => {
  it('says "stored by the relay", never "delivered": the relay holds the document until the machine reads it', async () => {
    await enroll('laptop');
    const { result } = await enroll('server');
    expect(result.out).toMatch(/document\(s\) stored by the relay for 1 machine/);
    expect(result.out).not.toMatch(/delivered/i);
  });
});
