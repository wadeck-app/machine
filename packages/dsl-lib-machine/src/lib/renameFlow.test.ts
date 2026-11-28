import {
  encryptAdminKey,
  generateSigningKeyPair,
  keyId,
  signRegistration as coreSignRegistration,
  verifyInboxDocument,
  verifyRegistration,
  type RegistrationBody,
  type SignedDocument,
  type SignedRegistration,
} from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { adminKeyHolder } from './adminKeyHolder.js';
import type { AllowApi } from './allowFlow.js';
import { loadRenameContext, previewRename, signAndRename, type RenameContext, type RenameRow } from './renameFlow.js';

// Rename from the page without React: context (after the PIN), a live preview of the new name, then ONE unlock that signs the re-issued registration and the documents
// for the other peers and the renamed machine, the key locked before anything is posted. Real crypto; the server side is a recording stub that reads every byte sent.

const PASSPHRASE = 'correct horse battery staple 7391';
const NOW = Math.floor(Date.now() / 1000);
const admin = generateSigningKeyPair();
const keyFile = JSON.stringify(encryptAdminKey(admin, PASSPHRASE));

const uuid = (n: number): string => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const ADMIN_MACHINE = { uuid: uuid(1), name: 'desktop' };
const LAPTOP = { uuid: uuid(2), name: 'laptop', identity: generateSigningKeyPair() };
const PEER = { uuid: uuid(3), name: 'server', identity: generateSigningKeyPair() };

const registrationOf = (m: { uuid: string; name: string; identity: { publicKey: string } }, signer = admin): SignedRegistration => {
  const body: RegistrationBody = { v: 1, uuid: m.uuid, name: m.name, identityPublicKey: m.identity.publicKey, serial: NOW - 100, validFrom: NOW - 100, validTo: NOW + 90 * 86_400, adminKeyId: keyId(signer.publicKey) };
  return coreSignRegistration(body, signer.privateKeyPkcs8);
};

const row: RenameRow = { uuid: LAPTOP.uuid, name: LAPTOP.name };

const context = (over: Partial<RenameContext> = {}): RenameContext => ({
  ok: true,
  adminMachine: ADMIN_MACHINE,
  adminPublicKey: admin.publicKey,
  adminKeyId: keyId(admin.publicKey),
  machine: { uuid: LAPTOP.uuid, name: LAPTOP.name, serial: NOW - 100, keyId: keyId(LAPTOP.identity.publicKey) },
  current: registrationOf(LAPTOP),
  machines: [ADMIN_MACHINE, { uuid: LAPTOP.uuid, name: LAPTOP.name }, { uuid: PEER.uuid, name: PEER.name }],
  aliases: {},
  networkAliases: {},
  revokedUpTo: null,
  others: [registrationOf(PEER)],
  noticeRecipients: null,
  ...over,
});

const RETRY = 'machine admin rename box box';
const INBOX = { uuid: PEER.uuid, name: 'server', state: 'inbox', code: 'inbox', reason: 'waiting in the relay inbox', next: 'installs by itself at its next check, nothing to do' };
const DELIVERED = { uuid: PEER.uuid, name: 'server', state: 'delivered', code: 'direct', reason: 'took the documents directly', next: 'nothing to do' };
const FAILED = { uuid: PEER.uuid, name: 'server', state: 'failed', code: 'not-stored', reason: 'documents not stored', next: `run \`${RETRY}\`` };
const answerOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ok: true,
  subject: { uuid: LAPTOP.uuid, name: 'box' },
  failed: false,
  report: {},
  text: { out: '[ok] 4 document(s) stored by the relay for 2 machine(s)\n', err: '' },
  machines: [INBOX],
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

describe('loadRenameContext', () => {
  it('asks for the PIN first, then reads the context of the machine', async () => {
    const api = stubApi({ get: { [`/rename-context/${LAPTOP.uuid}`]: context() } });
    const loaded = await loadRenameContext(api, row);
    expect(api.elevated).toBe(1);
    expect(api.sent).toEqual([{ method: 'GET', path: `/rename-context/${LAPTOP.uuid}` }]);
    expect(loaded.machine.name).toBe('laptop');
  });

  it('refuses an answer that is not a context, with the fix (an older module backend)', async () => {
    const api = stubApi({ get: { [`/rename-context/${LAPTOP.uuid}`]: { ok: true } } });
    await expect(loadRenameContext(api, row)).rejects.toThrow(/unexpected answer.*update the machine module/s);
  });

  it('a refusal of the module is the error, as it is worded', async () => {
    const api = stubApi({ get: { [`/rename-context/${LAPTOP.uuid}`]: new Error('this machine is revoked here: enroll it again') } });
    await expect(loadRenameContext(api, row)).rejects.toThrow(/revoked here/);
  });
});

describe('previewRename: what the dialog says before the passphrase', () => {
  it('nothing typed: no message, nothing to sign', () => {
    expect(previewRename(context(), '', NOW)).toEqual({ ok: false, message: '' });
  });
  it('a valid name is accepted as typed', () => {
    expect(previewRename(context(), 'box', NOW)).toMatchObject({ ok: true, name: 'box', normalized: false, serial: NOW - 99 });
  });
  it('a typed name that is made valid says what it will be', () => {
    expect(previewRename(context(), 'My Box', NOW)).toMatchObject({ ok: true, name: 'my-box', normalized: true });
  });
  it('a name with no letter or digit is refused with an example', () => {
    const p = previewRename(context(), '---', NOW);
    expect(p.ok).toBe(false);
    expect((p as { message: string }).message).toMatch(/no letter or digit/);
  });
  it('the same name, a name taken, a lookalike and a local alias of another machine are refused with the fix', () => {
    expect((previewRename(context(), 'laptop', NOW) as { message: string }).message).toMatch(/nothing to change/);
    expect((previewRename(context(), 'server', NOW) as { message: string }).message).toMatch(/already used by machine "server".*pick another name/);
    expect((previewRename(context(), 'ser-ver', NOW) as { message: string }).message).toMatch(/only by hyphens/);
    expect((previewRename(context({ aliases: { box: PEER.uuid } }), 'box', NOW) as { message: string }).message).toMatch(/local alias.*machine alias remove box/);
    expect((previewRename(context({ networkAliases: { box: PEER.uuid } }), 'box', NOW) as { message: string }).message).toMatch(/network alias.*machine admin alias rm box/);
  });
});

describe('signAndRename: one passphrase, one unlock, the key locked before the network', () => {
  it('reads the key file, then posts exactly { uuid, signed, documents, noticeRecipients }; the registration and the documents verify; no secret is in the bytes', async () => {
    const api = stubApi();
    const events: string[] = [];
    const result = await signAndRename(api, context(), 'box', PASSPHRASE, NOW, { onSigned: () => events.push('signed') });
    expect(api.sent.map((s) => `${s.method} ${s.path}`)).toEqual(['GET /admin-key', 'POST /rename']);
    expect(events).toEqual(['signed']);
    const posted = api.sent[1]?.body as { uuid: string; signed: SignedRegistration; documents: SignedDocument[]; noticeRecipients: unknown };
    expect(Object.keys(posted).sort()).toEqual(['documents', 'noticeRecipients', 'signed', 'uuid']);
    expect(posted.uuid).toBe(LAPTOP.uuid);
    expect(verifyRegistration(posted.signed, { adminPublicKey: admin.publicKey, now: NOW })).toMatchObject({ ok: true });
    expect(posted.signed.body).toMatchObject({ uuid: LAPTOP.uuid, name: 'box', serial: NOW - 99, identityPublicKey: LAPTOP.identity.publicKey });
    const toSelf = posted.documents.filter((d) => d.body.to === LAPTOP.uuid);
    expect(toSelf.map((d) => d.body.kind)).toContain('self-registration');
    for (const d of posted.documents.filter((x) => x.body.to === PEER.uuid)) {
      expect(verifyInboxDocument(d, { adminPublicKey: admin.publicKey, selfUuid: PEER.uuid, now: NOW, identityPrivateKeyPkcs8: PEER.identity.privateKeyPkcs8 }).ok).toBe(true);
    }
    const wire = JSON.stringify(api.sent.slice(1));
    expect(wire).not.toContain(PASSPHRASE);
    expect(wire).not.toContain(Buffer.from(admin.privateKeyPkcs8).toString('base64url'));
    expect(result.oldName).toBe('laptop');
    expect(result.newName).toBe('box');
    expect(adminKeyHolder.current()).toBeNull();
  });

  it('a wrong passphrase: loud, nothing posted but the read of the key file', async () => {
    const api = stubApi();
    await expect(signAndRename(api, context(), 'box', 'not the passphrase', NOW)).rejects.toThrow();
    expect(api.sent.map((s) => s.method)).toEqual(['GET']);
  });

  it('a key that is not the pinned one: refused, nothing posted', async () => {
    const api = stubApi();
    const other = generateSigningKeyPair();
    await expect(signAndRename(api, context({ adminKeyId: keyId(other.publicKey), adminPublicKey: other.publicKey }), 'box', PASSPHRASE, NOW)).rejects.toThrow(/not the admin key pinned on this machine/);
    expect(api.sent.map((s) => s.method)).toEqual(['GET']);
  });

  it('a name the plan refuses is never signed: the message of the plan, nothing posted, not even the key file read', async () => {
    const api = stubApi();
    await expect(signAndRename(api, context(), 'server', PASSPHRASE, NOW)).rejects.toThrow(/already used by machine "server".*Nothing was signed/);
    expect(api.sent).toEqual([]);
  });

  it('a peer registration the admin key did not sign: refused before anything is posted', async () => {
    const api = stubApi();
    await expect(signAndRename(api, context({ others: [registrationOf(PEER, generateSigningKeyPair())] }), 'box', PASSPHRASE, NOW)).rejects.toThrow(/not signed by the admin key/);
    expect(api.sent.map((s) => s.method)).toEqual(['GET']);
  });

  it('the module or the daemon refuses: its message is the error', async () => {
    const api = stubApi({ post: new Error('another registration of this machine was installed since the page read it: reload the page and rename again. Nothing was installed') });
    await expect(signAndRename(api, context(), 'box', PASSPHRASE, NOW)).rejects.toThrow(/reload the page and rename again/);
  });

  it('delivered: the headline says the new name and how the others were told', async () => {
    const result = await signAndRename(stubApi({ post: answerOf({ machines: [DELIVERED] }) }), context(), 'box', PASSPHRASE, NOW);
    expect(result.distribution).toMatchObject({ status: 'delivered', tone: 'success', machines: [DELIVERED], headline: '"laptop" is now "box". Documents delivered to 1 machine.' });
    expect(result.retryDelivery).toBeUndefined();
  });

  it('a partial delivery keeps the report, a danger tone and the exact retry command (not in the headline); it can be retried with the uuid only', async () => {
    const sent: Array<{ path: string; body: unknown }> = [];
    const first = answerOf({ failed: true, text: { out: '', err: '[error] server (x): peer document not stored: relay down\n' }, machines: [FAILED] });
    const base = stubApi({ post: first });
    const api = { ...base, post: async (path: string, body: unknown) => (path === '/delivery-retry' ? (sent.push({ path, body }), answerOf({ machines: [DELIVERED] })) : base.post(path, body)) };
    const result = await signAndRename(api, context(), 'box', PASSPHRASE, NOW);
    expect(result.distribution).toMatchObject({ status: 'partial', tone: 'danger', retryCommand: RETRY });
    expect(result.distribution.text).toContain('relay down');
    expect(result.distribution.headline).not.toContain('machine admin rename');
    const again = await (result.retryDelivery as () => Promise<{ status: string; headline: string }>)();
    expect(sent).toEqual([{ path: '/delivery-retry', body: { uuid: LAPTOP.uuid } }]);
    expect(again.status).toBe('delivered');
  });

  it('no machine to tell: the rename alone is the headline', async () => {
    const result = await signAndRename(stubApi({ post: answerOf({ machines: [], text: { out: '', err: '' } }) }), context({ others: [] }), 'box', PASSPHRASE, NOW);
    expect(result.distribution).toMatchObject({ status: 'none', headline: '"laptop" is now "box".' });
  });

  it('an answer without the list of machines is loud: the rename may be installed, the page says how to check and what to run', async () => {
    const answer = { ok: true, subject: { uuid: LAPTOP.uuid, name: 'box' }, failed: false, report: {}, text: { out: '[ok] x\n', err: '' }, retry: RETRY };
    await expect(signAndRename(stubApi({ post: answer }), context(), 'box', PASSPHRASE, NOW)).rejects.toThrow(/unexpected answer.*Machines page.*update the machine module.*machine admin rename box box/s);
  });
});
