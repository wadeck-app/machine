import {
  approvalSealContext,
  candidacyCode,
  encryptAdminKey,
  finalCode as coreFinalCode,
  generateSigningKeyPair,
  importCandidateSealContext,
  keyId,
  newCandidacyRandom,
  openSealed,
  signRegistration as coreSignRegistration,
  verifyInboxDocument,
  type RegistrationBody,
  type SignedDocument,
  type SignedRegistration,
} from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { adminKeyHolder } from './adminKeyHolder.js';
import type { AllowApi } from './allowFlow.js';
import { checkApprovable, loadApproveContext, recordApprovalCode, signAndApprove, type ApproveContext, type ApproveRow } from './approveFlow.js';

// The approval from the page without React: context (after the PIN), the checks that need no passphrase, then ONE unlock that signs the approval and the
// documents for the other peers, the key locked before anything is posted. Real crypto (each unlock derives 600 000 PBKDF2 rounds: a few in this file).
// The server side is a recording stub, so the tests read EVERY byte that leaves the page.

const PASSPHRASE = 'correct horse battery staple 7391';
const NOW = Math.floor(Date.now() / 1000);

const admin = generateSigningKeyPair();
const ADMIN_KEY_ID = keyId(admin.publicKey);
const keyFile = JSON.stringify(encryptAdminKey(admin, PASSPHRASE));

const uuid = (n: number): string => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const ADMIN_MACHINE = { uuid: uuid(1), name: 'desktop', identity: generateSigningKeyPair() };
const CANDIDATE = { uuid: uuid(2), name: 'laptop', identity: generateSigningKeyPair() };
const PEER = { uuid: uuid(3), name: 'server', identity: generateSigningKeyPair() };

const registrationOf = (m: { uuid: string; name: string; identity: { publicKey: string } }, signer = admin): SignedRegistration => {
  const body: RegistrationBody = { v: 1, uuid: m.uuid, name: m.name, identityPublicKey: m.identity.publicKey, serial: NOW - 100, validFrom: NOW - 100, validTo: NOW + 90 * 86_400, adminKeyId: keyId(signer.publicKey) };
  return coreSignRegistration(body, signer.privateKeyPkcs8);
};

const RANDOM = newCandidacyRandom();
const row = (over: Partial<ApproveRow> = {}): ApproveRow => ({
  id: 'cand-1',
  name: CANDIDATE.name,
  hostname: 'LAPTOP',
  uuid: CANDIDATE.uuid,
  observedIp: '203.0.113.7',
  identityPublicKey: CANDIDATE.identity.publicKey,
  random: RANDOM,
  code: candidacyCode(CANDIDATE.identity.publicKey, RANDOM),
  rebind: false,
  problems: [],
  ...over,
});

const context = (over: Partial<ApproveContext> = {}): ApproveContext => ({
  ok: true,
  adminMachine: { uuid: ADMIN_MACHINE.uuid, name: ADMIN_MACHINE.name, identityPublicKey: ADMIN_MACHINE.identity.publicKey },
  adminPublicKey: admin.publicKey,
  adminKeyId: ADMIN_KEY_ID,
  candidate: { trusted: false },
  others: [registrationOf(PEER)],
  noticeRecipients: null,
  ...over,
});

// What the daemon answers per machine (machine-cli `deliveryMachines`): the structure the page shows, so it never parses the text of the CLI.
const DELIVERED_SERVER = { uuid: PEER.uuid, name: 'server', state: 'delivered', code: 'direct', reason: 'took the documents directly', next: 'nothing to do' };
const INBOX_LAPTOP = { uuid: CANDIDATE.uuid, name: 'laptop', state: 'inbox', code: 'unreachable', reason: 'offline', next: 'installs by itself when it is back, nothing to do' };
const FAILED_SERVER = { uuid: PEER.uuid, name: 'server', state: 'failed', code: 'not-stored', reason: 'documents not stored', next: `run \`machine admin distribute ${CANDIDATE.uuid}\`` };

interface Sent { method: string; path: string; body?: unknown }
function stubApi(answers: { post?: Record<string, unknown | Error>; get?: Record<string, unknown | Error> } = {}): AllowApi & { sent: Sent[]; elevated: number } {
  const sent: Sent[] = [];
  const api = {
    sent,
    elevated: 0,
    async elevate() { api.elevated++; },
    async get(path: string) {
      sent.push({ method: 'GET', path });
      const answer = answers.get?.[path] ?? (path === '/admin-key' ? { ok: true, file: keyFile } : undefined);
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw new Error(`no stub for GET ${path}`);
      return answer;
    },
    async post(path: string, body: unknown) {
      sent.push({ method: 'POST', path, body });
      const answer = answers.post?.[path] ?? (path.endsWith('/approve') ? { ok: true, id: 'cand-1', message: 'approved' } : { ok: true, subject: { uuid: CANDIDATE.uuid, name: 'laptop' }, failed: false, report: {}, text: { out: '[ok] 2 document(s) stored by the relay for 1 machine(s)\n', err: '' }, machines: [DELIVERED_SERVER, INBOX_LAPTOP], retry: `machine admin distribute ${CANDIDATE.uuid}` });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return api;
}

describe('loadApproveContext', () => {
  it('asks for the PIN first, then reads the context of the candidate', async () => {
    const api = stubApi({ get: { [`/approve-context/${CANDIDATE.uuid}`]: context() } });
    const loaded = await loadApproveContext(api, row());
    expect(api.elevated).toBe(1);
    expect(api.sent).toEqual([{ method: 'GET', path: `/approve-context/${CANDIDATE.uuid}` }]);
    expect(loaded.adminMachine.name).toBe('desktop');
  });

  it('a row without a uuid cannot be approved: said before anything is asked', async () => {
    const api = stubApi();
    await expect(loadApproveContext(api, row({ uuid: undefined }))).rejects.toThrow(/no uuid/);
    expect(api.elevated).toBe(0);
  });

  it('refuses an answer that is not a context, with the fix (an older module backend)', async () => {
    const api = stubApi({ get: { [`/approve-context/${CANDIDATE.uuid}`]: { ok: true } } });
    await expect(loadApproveContext(api, row())).rejects.toThrow(/unexpected answer.*update the machine module/s);
  });
});

describe('checkApprovable: everything that needs no passphrase', () => {
  it('recomputes the candidacy code from the key and random as received and returns the final code of machine-core', async () => {
    const out = await checkApprovable(row(), context());
    expect(out.finalCode).toBe(coreFinalCode(CANDIDATE.identity.publicKey, admin.publicKey, RANDOM));
    expect(out.warnings).toEqual([]);
    expect(out.peersToInform.map((p) => p.name)).toEqual(['server']);
  });

  it('a machine revoked here earlier was enrolled before: its admin key is already pinned there, so there is no security code to compare (noCode); a first enrollment has one', async () => {
    const before = await checkApprovable(row(), context({ candidate: { trusted: false, revokedSerial: 3 } }));
    expect(before.noCode).toBe(true);
    expect((await checkApprovable(row(), context())).noCode).toBe(false);
  });

  it('REFUSES when the code of the list does not match the key and random (a relay that swapped the key): nothing is asked', async () => {
    await expect(checkApprovable(row({ identityPublicKey: generateSigningKeyPair().publicKey }), context())).rejects.toThrow(/does not match/);
  });

  it('refuses a candidacy with problems, a missing key and a missing code, naming the fix', async () => {
    await expect(checkApprovable(row({ problems: ['the relay sent a verification code that does not match'] }), context())).rejects.toThrow(/cannot be approved.*does not match.*Reject/s);
    await expect(checkApprovable(row({ identityPublicKey: undefined }), context())).rejects.toThrow(/no usable key or random/);
    await expect(checkApprovable(row({ code: undefined }), context())).rejects.toThrow(/no code to cross-check/);
  });

  it('refuses a uuid already trusted here with ANOTHER identity key, as the daemon would, before the passphrase', async () => {
    const trusted = context({ candidate: { trusted: true, name: 'laptop', identityPublicKey: generateSigningKeyPair().publicKey } });
    await expect(checkApprovable(row(), trusted)).rejects.toThrow(/already trusted.*machine admin approve/s);
  });

  it('a renewal of the same key is fine; a machine revoked earlier is a warning, a rebind of the relay uuid binding is a warning', async () => {
    const out = await checkApprovable(row({ rebind: true, bindingNote: undefined, boundTokenLabel: 'old laptop' }), context({ candidate: { trusted: true, name: 'laptop', identityPublicKey: CANDIDATE.identity.publicKey, revokedSerial: 12 } }));
    expect(out.warnings.join('\n')).toMatch(/REVOKED here earlier \(serial 12\)/);
    expect(out.warnings.join('\n')).toMatch(/old laptop.*replaces/s);
  });

  it('the admin machine renewing ITSELF while it has peers is refused (the peers could not be informed from the page): the CLI command is named', async () => {
    const self = row({ name: ADMIN_MACHINE.name, uuid: ADMIN_MACHINE.uuid, identityPublicKey: ADMIN_MACHINE.identity.publicKey, code: candidacyCode(ADMIN_MACHINE.identity.publicKey, RANDOM) });
    await expect(checkApprovable(self, context())).rejects.toThrow(/machine admin approve cand-1/);
    const alone = await checkApprovable(self, context({ others: [] }));
    expect(alone.selfApproval).toBe(true);
    expect(alone.peersToInform).toEqual([]);
  });
});

describe('signAndApprove: one passphrase, one unlock, the key locked before the network', () => {
  it('reads the key file, then posts the approval, THEN the documents; the body of each is exactly what the route accepts and no secret is in them', async () => {
    const api = stubApi();
    const events: string[] = [];
    const result = await signAndApprove(api, context(), row(), PASSPHRASE, NOW, { onSigned: () => events.push('signed'), onApproved: () => events.push('approved') });
    expect(api.sent.map((s) => `${s.method} ${s.path}`)).toEqual(['GET /admin-key', 'POST /candidacies/cand-1/approve', 'POST /approve-distribute']);
    expect(events).toEqual(['signed', 'approved']);

    const approve = api.sent[1]?.body as { approval: { v: number; random: string; sealed: string }; adminImport: Record<string, unknown> };
    expect(Object.keys(approve).sort()).toEqual(['adminImport', 'approval']);
    expect(Object.keys(approve.adminImport).sort()).toEqual(['adminUuid', 'candidateUuid', 'random', 'registration', 'sealedPairSecret']);
    // The candidate opens its approval; the admin machine opens its import (the pair secret is the same one).
    const inner = JSON.parse(new TextDecoder().decode(openSealed(CANDIDATE.identity.privateKeyPkcs8, approve.approval.sealed, approvalSealContext(CANDIDATE.uuid, RANDOM)))) as { admin: { adminPublicKey: string } };
    expect(inner.admin.adminPublicKey).toBe(admin.publicKey);
    expect(openSealed(ADMIN_MACHINE.identity.privateKeyPkcs8, approve.adminImport['sealedPairSecret'] as string, importCandidateSealContext(ADMIN_MACHINE.uuid, CANDIDATE.uuid, RANDOM))).toHaveLength(32);

    const distribute = api.sent[2]?.body as { candidateUuid: string; documents: SignedDocument[]; noticeRecipients: unknown };
    expect(Object.keys(distribute).sort()).toEqual(['candidateUuid', 'documents', 'noticeRecipients']);
    expect(distribute.candidateUuid).toBe(CANDIDATE.uuid);
    const toPeer = distribute.documents.filter((d) => d.body.to === PEER.uuid);
    expect(toPeer).toHaveLength(2);
    const opened = toPeer.map((d) => verifyInboxDocument(d, { adminPublicKey: admin.publicKey, selfUuid: PEER.uuid, now: NOW, identityPrivateKeyPkcs8: PEER.identity.privateKeyPkcs8 }));
    expect(opened.every((o) => o.ok)).toBe(true);

    // Neither the passphrase nor any key text leaves the page.
    const wire = JSON.stringify(api.sent.slice(1));
    expect(wire).not.toContain(PASSPHRASE);
    expect(wire).not.toContain(Buffer.from(admin.privateKeyPkcs8).toString('base64url'));
    expect(result.finalCode).toBe(coreFinalCode(CANDIDATE.identity.publicKey, admin.publicKey, RANDOM));
    expect(result.distribution).toMatchObject({ status: 'delivered' });
    // No unlock window: nothing is kept by the holder.
    expect(adminKeyHolder.current()).toBeNull();
  });

  it('a wrong passphrase: loud, nothing posted but the read of the key file', async () => {
    const api = stubApi();
    await expect(signAndApprove(api, context(), row(), 'not the passphrase', NOW, {})).rejects.toThrow();
    expect(api.sent.map((s) => s.method)).toEqual(['GET']);
  });

  it('a key that is not the pinned one: refused, nothing posted', async () => {
    const api = stubApi();
    const other = generateSigningKeyPair();
    await expect(signAndApprove(api, context({ adminKeyId: keyId(other.publicKey), adminPublicKey: other.publicKey }), row(), PASSPHRASE, NOW, {})).rejects.toThrow(/not the admin key pinned on this machine/);
    expect(api.sent.map((s) => s.method)).toEqual(['GET']);
  });

  it('a registration of another peer that the admin key did not sign: refused before anything is posted', async () => {
    const api = stubApi();
    const forged = registrationOf(PEER, generateSigningKeyPair());
    await expect(signAndApprove(api, context({ others: [forged] }), row(), PASSPHRASE, NOW, {})).rejects.toThrow(/not signed by the admin key/);
    expect(api.sent.map((s) => s.method)).toEqual(['GET']);
  });

  it('the approval is refused by the backend: its message is the error, nothing about the other peers is posted', async () => {
    const api = stubApi({ post: { '/candidacies/cand-1/approve': new Error('the candidacy is no longer pending. Nothing was approved') } });
    await expect(signAndApprove(api, context(), row(), PASSPHRASE, NOW, {})).rejects.toThrow(/no longer pending/);
    expect(api.sent.map((s) => `${s.method} ${s.path}`)).toEqual(['GET /admin-key', 'POST /candidacies/cand-1/approve']);
  });

  it('the documents fail AFTER the approval: the approval stands, the code is still returned, the exact retry command is named', async () => {
    const api = stubApi({ post: { '/approve-distribute': new Error('the daemon is not running') } });
    const result = await signAndApprove(api, context(), row(), PASSPHRASE, NOW, {});
    expect(result.finalCode).toMatch(/\d/);
    expect(result.distribution.status).toBe('failed');
    expect(result.distribution.text).toMatch(/the daemon is not running/);
    expect(result.distribution.text).toContain(`machine admin distribute ${CANDIDATE.uuid}`);
    expect(result.distribution.text).toMatch(/approval stands/);
    expect(result.distribution).toMatchObject({ tone: 'danger', machines: [], waiting: 0, headline: `The other machines were NOT told. Run \`machine admin distribute ${CANDIDATE.uuid}\` on this machine; it is safe to run again.` });
  });

  it('a delivery that partly failed keeps the report of the daemon and says so', async () => {
    const answer = { ok: true, subject: { uuid: CANDIDATE.uuid, name: 'laptop' }, failed: true, report: {}, text: { out: '', err: '[error] server (x): peer document not stored: relay down\n[warn] the approval stands: nothing was undone. Run `machine admin distribute y`\n' }, machines: [FAILED_SERVER, INBOX_LAPTOP], retry: `machine admin distribute ${CANDIDATE.uuid}` };
    const result = await signAndApprove(stubApi({ post: { '/approve-distribute': answer } }), context(), row(), PASSPHRASE, NOW, {});
    expect(result.distribution.status).toBe('partial');
    expect(result.distribution.text).toContain('relay down');
    expect(result.distribution.machines).toEqual([FAILED_SERVER, INBOX_LAPTOP]);
    expect(result.distribution).toMatchObject({ tone: 'warning', waiting: 1, headline: `Documents wait in the relay inbox of 1 machine, 1 NOT told. Run \`machine admin distribute ${CANDIDATE.uuid}\`.` });
  });

  it('the structure of the daemon answer is what the page shows: a headline, a tone, the machines, how many wait in the inbox; the raw text is kept for the Details, without repeated lines', async () => {
    const answer = { ok: true, subject: { uuid: CANDIDATE.uuid, name: 'laptop' }, failed: false, report: {}, text: { out: '[ok] a\n[info] sealed\n', err: '[info] sealed\n' }, machines: [DELIVERED_SERVER, INBOX_LAPTOP], retry: `machine admin distribute ${CANDIDATE.uuid}` };
    const result = await signAndApprove(stubApi({ post: { '/approve-distribute': answer } }), context(), row(), PASSPHRASE, NOW, {});
    expect(result.distribution).toMatchObject({ status: 'delivered', tone: 'success', waiting: 1, headline: 'Documents delivered to 1 machine, 1 waits in the relay inbox.', machines: [DELIVERED_SERVER, INBOX_LAPTOP] });
    expect(result.distribution.text).toBe('[ok] a\n[info] sealed');
  });

  it('an answer without the list of machines (an older daemon or module) is loud: the page and the module are not the same version, the documents are reported as NOT confirmed with the retry command', async () => {
    const answer = { ok: true, subject: { uuid: CANDIDATE.uuid, name: 'laptop' }, failed: false, report: {}, text: { out: '[ok] x\n', err: '' }, retry: 'machine admin distribute z' };
    const result = await signAndApprove(stubApi({ post: { '/approve-distribute': answer } }), context(), row(), PASSPHRASE, NOW, {});
    expect(result.distribution.status).toBe('failed');
    expect(result.distribution.text).toMatch(/unexpected answer.*update the machine module/s);
    expect(result.distribution.headline).toContain(`machine admin distribute ${CANDIDATE.uuid}`);
  });

  it('a machine entry of another shape is refused the same way', async () => {
    const answer = { ok: true, subject: { uuid: CANDIDATE.uuid, name: 'laptop' }, failed: false, report: {}, text: { out: '', err: '' }, machines: [{ name: 'server', state: 'weird' }], retry: 'x' };
    const result = await signAndApprove(stubApi({ post: { '/approve-distribute': answer } }), context(), row(), PASSPHRASE, NOW, {});
    expect(result.distribution.status).toBe('failed');
  });

  it('the approval hook receives the security code (the only moment the page can hand it over: the relay purges the random once approved)', async () => {
    const codes: string[] = [];
    const result = await signAndApprove(stubApi(), context(), row(), PASSPHRASE, NOW, { onApproved: (code) => codes.push(code) });
    expect(codes).toEqual([result.finalCode]);
    expect(codes[0]).toMatch(/^\d{5}( \d{5}){4}$/);
  });

  it('the first machine approving itself: no import, no documents, and it says there is nobody to inform', async () => {
    const api = stubApi();
    const self = row({ name: ADMIN_MACHINE.name, uuid: ADMIN_MACHINE.uuid, identityPublicKey: ADMIN_MACHINE.identity.publicKey, code: candidacyCode(ADMIN_MACHINE.identity.publicKey, RANDOM) });
    const result = await signAndApprove(api, context({ others: [] }), self, PASSPHRASE, NOW, {});
    expect(api.sent.map((s) => `${s.method} ${s.path}`)).toEqual(['GET /admin-key', 'POST /candidacies/cand-1/approve']);
    expect((api.sent[1]?.body as { adminImport: unknown }).adminImport).toBeNull();
    expect(result.distribution).toMatchObject({ status: 'none', tone: 'success', machines: [], waiting: 0, headline: 'No other machine to tell: this is the first machine of the network.' });
  });
});

describe('recordApprovalCode: the code is kept by the module so it can be read again after the dialog is closed', () => {
  it('posts exactly the uuid, the name and the code (public values), nothing else', async () => {
    const api = stubApi({ post: { '/approval-codes': { ok: true } } });
    await recordApprovalCode(api, { uuid: CANDIDATE.uuid, name: 'laptop' }, '12345 67890 12345 67890 12345');
    expect(api.sent).toEqual([{ method: 'POST', path: '/approval-codes', body: { uuid: CANDIDATE.uuid, name: 'laptop', code: '12345 67890 12345 67890 12345' } }]);
  });

  it('a refusal is loud: it says the code was not kept, that it is still on screen, and why', async () => {
    const api = stubApi({ post: { '/approval-codes': new Error('approval-codes.json is damaged: delete it') } });
    await expect(recordApprovalCode(api, { uuid: CANDIDATE.uuid, name: 'laptop' }, '12345 67890 12345 67890 12345')).rejects.toThrow(/could not be kept.*damaged.*note it now/s);
  });
});
