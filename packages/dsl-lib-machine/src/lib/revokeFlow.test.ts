import {
  encryptAdminKey,
  generateSigningKeyPair,
  keyId,
  signRegistration as coreSignRegistration,
  verifyInboxDocument,
  verifyRevocation,
  type RegistrationBody,
  type SignedDocument,
  type SignedRegistration,
} from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { adminKeyHolder } from './adminKeyHolder.js';
import type { AllowApi } from './allowFlow.js';
import { loadRevokeContext, signAndRevoke, type RevokeContext, type RevokeRow } from './revokeFlow.js';

// Revoke from the page without React: context (after the PIN), then ONE unlock that signs the revocation list and the documents for the peers that stay trusted, the
// key locked before anything is posted. Real crypto. The server side is a recording stub, so the tests read EVERY byte that leaves the page.

const PASSPHRASE = 'correct horse battery staple 7391';
const NOW = Math.floor(Date.now() / 1000);

const admin = generateSigningKeyPair();
const keyFile = JSON.stringify(encryptAdminKey(admin, PASSPHRASE));

const uuid = (n: number): string => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const ADMIN_MACHINE = { uuid: uuid(1), name: 'desktop' };
const REVOKED = { uuid: uuid(2), name: 'laptop', identity: generateSigningKeyPair() };
const PEER = { uuid: uuid(3), name: 'server', identity: generateSigningKeyPair() };

const registrationOf = (m: { uuid: string; name: string; identity: { publicKey: string } }, signer = admin): SignedRegistration => {
  const body: RegistrationBody = { v: 1, uuid: m.uuid, name: m.name, identityPublicKey: m.identity.publicKey, serial: NOW - 100, validFrom: NOW - 100, validTo: NOW + 90 * 86_400, adminKeyId: keyId(signer.publicKey) };
  return coreSignRegistration(body, signer.privateKeyPkcs8);
};

const row: RevokeRow = { uuid: REVOKED.uuid, name: REVOKED.name };

const context = (over: Partial<RevokeContext> = {}): RevokeContext => ({
  ok: true,
  adminMachine: ADMIN_MACHINE,
  adminPublicKey: admin.publicKey,
  adminKeyId: keyId(admin.publicKey),
  revoked: { uuid: REVOKED.uuid, name: REVOKED.name, serial: NOW - 100, keyId: keyId(REVOKED.identity.publicKey) },
  held: { entries: [], version: 0 },
  recipients: [registrationOf(PEER)],
  noticeRecipients: null,
  ...over,
});

const RETRY = `machine admin distribute ${REVOKED.uuid}`;
const INBOX_SERVER = { uuid: PEER.uuid, name: 'server', state: 'inbox', code: 'inbox', reason: 'waiting in the relay inbox', next: 'installs by itself at its next check, nothing to do' };
const DELIVERED_SERVER = { uuid: PEER.uuid, name: 'server', state: 'delivered', code: 'direct', reason: 'took the documents directly', next: 'nothing to do' };
const FAILED_SERVER = { uuid: PEER.uuid, name: 'server', state: 'failed', code: 'not-stored', reason: 'documents not stored', next: `run \`${RETRY}\`` };
const answerOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ok: true,
  revoked: { uuid: REVOKED.uuid, name: 'laptop' },
  failed: false,
  report: {},
  text: { out: '[ok] 2 document(s) stored by the relay for 1 machine(s)\n', err: '' },
  machines: [INBOX_SERVER],
  retry: RETRY,
  ...over,
});

interface Sent { method: string; path: string; body?: unknown }
function stubApi(answers: { post?: unknown | Error; get?: Record<string, unknown | Error> } = {}): AllowApi & { sent: Sent[]; elevated: number } {
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
      const answer = answers.post ?? answerOf();
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return api;
}

describe('loadRevokeContext', () => {
  it('asks for the PIN first, then reads the context of the machine', async () => {
    const api = stubApi({ get: { [`/revoke-context/${REVOKED.uuid}`]: context() } });
    const loaded = await loadRevokeContext(api, row);
    expect(api.elevated).toBe(1);
    expect(api.sent).toEqual([{ method: 'GET', path: `/revoke-context/${REVOKED.uuid}` }]);
    expect(loaded.adminMachine.name).toBe('desktop');
    expect(loaded.revoked.name).toBe('laptop');
  });

  it('refuses an answer that is not a context, with the fix (an older module backend)', async () => {
    const api = stubApi({ get: { [`/revoke-context/${REVOKED.uuid}`]: { ok: true } } });
    await expect(loadRevokeContext(api, row)).rejects.toThrow(/unexpected answer.*update the machine module/s);
  });

  it('a refusal of the module is the error, as it is worded (cause and fix)', async () => {
    const api = stubApi({ get: { [`/revoke-context/${REVOKED.uuid}`]: new Error('this machine has no admin key: run this page on the admin machine') } });
    await expect(loadRevokeContext(api, row)).rejects.toThrow(/no admin key/);
  });
});

describe('signAndRevoke: one passphrase, one unlock, the key locked before the network', () => {
  it('reads the key file, then posts exactly { uuid, signed, documents, noticeRecipients }; the list and the documents verify; no secret is in the bytes', async () => {
    const api = stubApi();
    const events: string[] = [];
    const result = await signAndRevoke(api, context(), PASSPHRASE, NOW, { onSigned: () => events.push('signed') });
    expect(api.sent.map((s) => `${s.method} ${s.path}`)).toEqual(['GET /admin-key', 'POST /revoke']);
    expect(events).toEqual(['signed']);
    const posted = api.sent[1]?.body as { uuid: string; signed: Parameters<typeof verifyRevocation>[0]; documents: SignedDocument[]; noticeRecipients: unknown };
    expect(Object.keys(posted).sort()).toEqual(['documents', 'noticeRecipients', 'signed', 'uuid']);
    expect(posted.uuid).toBe(REVOKED.uuid);
    expect(verifyRevocation(posted.signed, { adminPublicKey: admin.publicKey })).toMatchObject({ ok: true });
    expect(posted.signed.body.entries).toEqual([{ uuid: REVOKED.uuid, serial: NOW - 100 }]);
    const toPeer = posted.documents.filter((d) => d.body.to === PEER.uuid);
    expect(toPeer.map((d) => d.body.kind).sort()).toEqual(['notice-recipients', 'revocation']);
    for (const d of toPeer) {
      expect(verifyInboxDocument(d, { adminPublicKey: admin.publicKey, selfUuid: PEER.uuid, now: NOW, identityPrivateKeyPkcs8: PEER.identity.privateKeyPkcs8 }).ok).toBe(true);
    }
    // Neither the passphrase nor any key text leaves the page.
    const wire = JSON.stringify(api.sent.slice(1));
    expect(wire).not.toContain(PASSPHRASE);
    expect(wire).not.toContain(Buffer.from(admin.privateKeyPkcs8).toString('base64url'));
    expect(result.distribution.status).toBe('delivered');
    // No unlock window: nothing is kept by the holder.
    expect(adminKeyHolder.current()).toBeNull();
  });

  it('a wrong passphrase: loud, nothing posted but the read of the key file', async () => {
    const api = stubApi();
    await expect(signAndRevoke(api, context(), 'not the passphrase', NOW)).rejects.toThrow();
    expect(api.sent.map((s) => s.method)).toEqual(['GET']);
  });

  it('a key that is not the pinned one: refused, nothing posted', async () => {
    const api = stubApi();
    const other = generateSigningKeyPair();
    await expect(signAndRevoke(api, context({ adminKeyId: keyId(other.publicKey), adminPublicKey: other.publicKey }), PASSPHRASE, NOW)).rejects.toThrow(/not the admin key pinned on this machine/);
    expect(api.sent.map((s) => s.method)).toEqual(['GET']);
  });

  it('a registration of a peer that the admin key did not sign: refused before anything is posted', async () => {
    const api = stubApi();
    await expect(signAndRevoke(api, context({ recipients: [registrationOf(PEER, generateSigningKeyPair())] }), PASSPHRASE, NOW)).rejects.toThrow(/not signed by the admin key/);
    expect(api.sent.map((s) => s.method)).toEqual(['GET']);
  });

  it('the module or the daemon refuses: its message is the error', async () => {
    const api = stubApi({ post: new Error('another revocation was installed since the page read it: reload the page and revoke again. Nothing was installed') });
    await expect(signAndRevoke(api, context(), PASSPHRASE, NOW)).rejects.toThrow(/reload the page and revoke again/);
  });

  it('delivered: the headline says the machine is revoked and how the others were told, the structure is the one of the daemon, the raw text loses its repeated lines', async () => {
    const answer = answerOf({ text: { out: '[ok] a\n[info] sealed\n', err: '[info] sealed\n' }, machines: [DELIVERED_SERVER] });
    const result = await signAndRevoke(stubApi({ post: answer }), context(), PASSPHRASE, NOW);
    expect(result.distribution).toMatchObject({ status: 'delivered', tone: 'success', waiting: 0, machines: [DELIVERED_SERVER], headline: 'Documents delivered to 1 machine.' });
    expect(result.distribution.text).toBe('[ok] a\n[info] sealed');
  });

  it('a delivery that partly failed keeps the report of the daemon, a warning tone and the exact retry command', async () => {
    const answer = answerOf({ failed: true, text: { out: '', err: '[error] server (x): revocation document not stored: relay down\n' }, machines: [FAILED_SERVER] });
    const result = await signAndRevoke(stubApi({ post: answer }), context(), PASSPHRASE, NOW);
    expect(result.distribution.status).toBe('partial');
    expect(result.distribution.text).toContain('relay down');
    expect(result.distribution.headline).toContain(RETRY);
    expect(result.distribution.tone).toBe('danger');
  });

  it('no other peer: one line, no machine', async () => {
    const result = await signAndRevoke(stubApi({ post: answerOf({ machines: [], text: { out: '[ok] no other peer to inform\n', err: '' } }) }), context({ recipients: [] }), PASSPHRASE, NOW);
    expect(result.distribution).toMatchObject({ status: 'none', tone: 'success', machines: [], headline: 'No other machine to tell.' });
  });

  it('an answer without the list of machines (an older daemon or module) is loud: the revocation may be installed, the page says how to check and what to run', async () => {
    const answer = { ok: true, revoked: { uuid: REVOKED.uuid, name: 'laptop' }, failed: false, report: {}, text: { out: '[ok] x\n', err: '' }, retry: RETRY };
    await expect(signAndRevoke(stubApi({ post: answer }), context(), PASSPHRASE, NOW)).rejects.toThrow(/unexpected answer.*Machines page.*update the machine module.*machine admin distribute/s);
  });
});
