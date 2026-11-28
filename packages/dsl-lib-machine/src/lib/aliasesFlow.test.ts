import {
  encryptAdminKey,
  generateSigningKeyPair,
  keyId,
  NETWORK_ALIASES_SUBJECT_UUID,
  signRegistration as coreSignRegistration,
  verifyAliases,
  verifyInboxDocument,
  type RegistrationBody,
  type SignedAliases,
  type SignedDocument,
  type SignedRegistration,
} from '@wadeck-app/machine-core';
import { signAliases } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { adminKeyHolder } from './adminKeyHolder.js';
import { ALIASES_SUBJECT_UUID, loadAliasesContext, previewAliasChange, signAndChangeAlias, type AliasesContext } from './aliasesFlow.js';
import type { AllowApi } from './allowFlow.js';

// Network aliases from the page without React: context (after the PIN), a live preview of one change (the plan of the CLI and the local aliases that would win), then ONE
// unlock per change that signs the whole new list and the documents for the machines, the key locked before anything is posted. Real crypto, recording stub server.

const PASSPHRASE = 'correct horse battery staple 7391';
const NOW = Math.floor(Date.now() / 1000);
const admin = generateSigningKeyPair();
const keyFile = JSON.stringify(encryptAdminKey(admin, PASSPHRASE));

const uuid = (n: number): string => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const ADMIN_MACHINE = { uuid: uuid(1), name: 'desktop' };
const LAPTOP = { uuid: uuid(2), name: 'laptop', identity: generateSigningKeyPair() };
const PEER = { uuid: uuid(3), name: 'server', identity: generateSigningKeyPair() };

const registrationOf = (m: { uuid: string; name: string; identity: { publicKey: string } }): SignedRegistration => {
  const body: RegistrationBody = { v: 1, uuid: m.uuid, name: m.name, identityPublicKey: m.identity.publicKey, serial: NOW - 100, validFrom: NOW - 100, validTo: NOW + 90 * 86_400, adminKeyId: keyId(admin.publicKey) };
  return coreSignRegistration(body, admin.privateKeyPkcs8);
};

const listOf = (entries: Array<{ alias: string; uuid: string }>, serial = NOW - 50): SignedAliases =>
  signAliases({ v: 1, adminKeyId: keyId(admin.publicKey), serial, issuedAt: serial, entries }, admin.privateKeyPkcs8);

const context = (over: Partial<AliasesContext> = {}): AliasesContext => ({
  ok: true,
  adminMachine: ADMIN_MACHINE,
  adminPublicKey: admin.publicKey,
  adminKeyId: keyId(admin.publicKey),
  current: null,
  machines: [ADMIN_MACHINE, { uuid: LAPTOP.uuid, name: LAPTOP.name }, { uuid: PEER.uuid, name: PEER.name }],
  revoked: [],
  localAliases: {},
  recipients: [registrationOf(LAPTOP), registrationOf(PEER)],
  ...over,
});

const RETRY = 'machine admin alias send';
const DELIVERED = [
  { uuid: LAPTOP.uuid, name: 'laptop', state: 'delivered', code: 'direct', reason: 'took the documents directly', next: 'nothing to do' },
  { uuid: PEER.uuid, name: 'server', state: 'inbox', code: 'inbox', reason: 'waiting in the relay inbox', next: 'installs by itself at its next check, nothing to do' },
];
const FAILED = [{ uuid: PEER.uuid, name: 'server', state: 'failed', code: 'not-stored', reason: 'documents not stored', next: `run \`${RETRY}\`` }];
const answerOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ok: true,
  serial: NOW,
  entries: [{ alias: 'box', uuid: LAPTOP.uuid, name: 'laptop' }],
  changed: true,
  failed: false,
  report: {},
  text: { out: '[ok] 2 document(s) stored by the relay for 2 machine(s)\n', err: '' },
  machines: DELIVERED,
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

const SET_BOX = { action: 'set', alias: 'box', uuid: LAPTOP.uuid } as const;

describe('loadAliasesContext', () => {
  it('asks for the PIN first, then reads the context', async () => {
    const api = stubApi({ get: { '/aliases-context': context() } });
    const loaded = await loadAliasesContext(api);
    expect(api.elevated).toBe(1);
    expect(api.sent).toEqual([{ method: 'GET', path: '/aliases-context' }]);
    expect(loaded.machines).toHaveLength(3);
  });
  it('refuses an answer that is not a context, with the fix', async () => {
    const api = stubApi({ get: { '/aliases-context': { ok: true } } });
    await expect(loadAliasesContext(api)).rejects.toThrow(/unexpected answer.*update the machine module/s);
  });
  it('a refusal of the module is the error, as it is worded', async () => {
    const api = stubApi({ get: { '/aliases-context': new Error('this machine has no admin key: run this page on the admin machine') } });
    await expect(loadAliasesContext(api)).rejects.toThrow(/no admin key/);
  });
});

describe('previewAliasChange: what the dialog says before the passphrase', () => {
  it('a valid set gives the whole list after the change', () => {
    const p = previewAliasChange(context(), SET_BOX);
    expect(p).toMatchObject({ ok: true, alias: 'box', changed: true, normalized: false, entries: [{ alias: 'box', uuid: LAPTOP.uuid }] });
  });
  it('a typed alias that is made valid says so', () => {
    expect(previewAliasChange(context(), { action: 'set', alias: 'My Box', uuid: LAPTOP.uuid })).toMatchObject({ ok: true, alias: 'my-box', normalized: true });
  });
  it('refuses with the fix: the name of a machine, a lookalike, an alias already used, an unknown machine, a revoked one, a removal of nothing', () => {
    const msg = (p: ReturnType<typeof previewAliasChange>): string => (p as { message: string }).message;
    expect(msg(previewAliasChange(context(), { action: 'set', alias: 'server', uuid: LAPTOP.uuid }))).toMatch(/already the name of machine "server"/);
    expect(msg(previewAliasChange(context(), { action: 'set', alias: 'ser-ver', uuid: LAPTOP.uuid }))).toMatch(/only by hyphens or case/);
    const withBox = context({ current: listOf([{ alias: 'box', uuid: PEER.uuid }]) });
    expect(msg(previewAliasChange(withBox, SET_BOX))).toMatch(/already points to machine.*machine admin alias rm box/);
    expect(msg(previewAliasChange(context(), { action: 'set', alias: 'box', uuid: uuid(9) }))).toMatch(/not a trusted machine/);
    expect(msg(previewAliasChange(context({ revoked: [LAPTOP.uuid] }), SET_BOX))).toMatch(/revoked here/);
    expect(msg(previewAliasChange(context(), { action: 'rm', alias: 'box' }))).toMatch(/no network alias "box"/);
  });
  it('nothing to change when the alias already points there', () => {
    const withBox = context({ current: listOf([{ alias: 'box', uuid: LAPTOP.uuid }]) });
    expect(previewAliasChange(withBox, SET_BOX)).toMatchObject({ ok: true, changed: false });
  });
  it('a local alias of this machine with the same label that points elsewhere is a conflict to tell: the local one wins here', () => {
    const p = previewAliasChange(context({ localAliases: { box: PEER.uuid } }), SET_BOX);
    expect(p).toMatchObject({ ok: true, conflicts: [{ alias: 'box', local: PEER.uuid, network: LAPTOP.uuid }] });
  });
});

describe('signAndChangeAlias: one passphrase, one unlock, the key locked before the network', () => {
  it('posts exactly { signed, documents }; the list verifies and carries the old entries plus the new one; one document per machine; no secret in the bytes', async () => {
    const api = stubApi();
    const events: string[] = [];
    const base = context({ current: listOf([{ alias: 'srv', uuid: PEER.uuid }]) });
    const result = await signAndChangeAlias(api, base, SET_BOX, PASSPHRASE, NOW, { onSigned: () => events.push('signed') });
    expect(api.sent.map((s) => `${s.method} ${s.path}`)).toEqual(['GET /admin-key', 'POST /aliases']);
    expect(events).toEqual(['signed']);
    const posted = api.sent[1]?.body as { signed: SignedAliases; documents: SignedDocument[] };
    expect(Object.keys(posted).sort()).toEqual(['documents', 'signed']);
    expect(verifyAliases(posted.signed, { adminPublicKey: admin.publicKey })).toMatchObject({ ok: true });
    expect(posted.signed.body.entries).toEqual([{ alias: 'box', uuid: LAPTOP.uuid }, { alias: 'srv', uuid: PEER.uuid }]);
    expect(posted.signed.body.serial).toBeGreaterThan(NOW - 50);
    expect(posted.documents.map((d) => d.body.to).sort()).toEqual([LAPTOP.uuid, PEER.uuid].sort());
    for (const d of posted.documents) {
      const target = d.body.to === LAPTOP.uuid ? LAPTOP : PEER;
      expect(d.body.kind).toBe('aliases');
      expect(verifyInboxDocument(d, { adminPublicKey: admin.publicKey, selfUuid: target.uuid, now: NOW, identityPrivateKeyPkcs8: target.identity.privateKeyPkcs8 }).ok).toBe(true);
    }
    const wire = JSON.stringify(api.sent.slice(1));
    expect(wire).not.toContain(PASSPHRASE);
    expect(wire).not.toContain(Buffer.from(admin.privateKeyPkcs8).toString('base64url'));
    expect(result).toMatchObject({ action: 'set', alias: 'box' });
    expect(adminKeyHolder.current()).toBeNull();
  });

  it('a removal signs the list without the alias', async () => {
    const api = stubApi();
    const base = context({ current: listOf([{ alias: 'box', uuid: LAPTOP.uuid }, { alias: 'srv', uuid: PEER.uuid }]) });
    await signAndChangeAlias(api, base, { action: 'rm', alias: 'box' }, PASSPHRASE, NOW);
    const posted = api.sent[1]?.body as { signed: SignedAliases };
    expect(posted.signed.body.entries).toEqual([{ alias: 'srv', uuid: PEER.uuid }]);
  });

  it('a wrong passphrase: loud, nothing posted but the read of the key file', async () => {
    const api = stubApi();
    await expect(signAndChangeAlias(api, context(), SET_BOX, 'not the passphrase', NOW)).rejects.toThrow();
    expect(api.sent.map((s) => s.method)).toEqual(['GET']);
  });

  it('a key that is not the pinned one: refused, nothing posted', async () => {
    const api = stubApi();
    const other = generateSigningKeyPair();
    await expect(signAndChangeAlias(api, context({ adminKeyId: keyId(other.publicKey), adminPublicKey: other.publicKey }), SET_BOX, PASSPHRASE, NOW)).rejects.toThrow(/not the admin key pinned on this machine/);
    expect(api.sent.map((s) => s.method)).toEqual(['GET']);
  });

  it('a change the plan refuses is never signed: nothing is read or posted', async () => {
    const api = stubApi();
    await expect(signAndChangeAlias(api, context(), { action: 'set', alias: 'server', uuid: LAPTOP.uuid }, PASSPHRASE, NOW)).rejects.toThrow(/already the name of machine "server".*Nothing was signed/);
    expect(api.sent).toEqual([]);
  });

  it('a change that changes nothing is not signed either, and says what to do', async () => {
    const api = stubApi();
    const base = context({ current: listOf([{ alias: 'box', uuid: LAPTOP.uuid }]) });
    await expect(signAndChangeAlias(api, base, SET_BOX, PASSPHRASE, NOW)).rejects.toThrow(/already points to.*nothing to sign/);
    expect(api.sent).toEqual([]);
  });

  it('the module or the daemon refuses: its message is the error', async () => {
    const api = stubApi({ post: new Error('the list the page signed does not replace the installed one: reload the page and try again. Nothing was installed') });
    await expect(signAndChangeAlias(api, context(), SET_BOX, PASSPHRASE, NOW)).rejects.toThrow(/reload the page and try again/);
  });

  it('delivered or waiting in the inbox: the headline says what was done and how the machines were told; no retry', async () => {
    const result = await signAndChangeAlias(stubApi(), context(), SET_BOX, PASSPHRASE, NOW);
    expect(result.distribution).toMatchObject({ status: 'delivered', tone: 'success' });
    expect(result.distribution.headline).toMatch(/^Network alias "box" now points to "laptop"\. Documents delivered to 1 machine, 1 waits in the relay inbox\.$/);
    expect(result.retryDelivery).toBeUndefined();
    expect(result.entries).toEqual([{ alias: 'box', uuid: LAPTOP.uuid, name: 'laptop' }]);
  });

  it('a partial delivery keeps the retry command; the retry goes through the reserved subject uuid, with no passphrase', async () => {
    const sent: Array<{ path: string; body: unknown }> = [];
    const base = stubApi({ post: answerOf({ failed: true, text: { out: '', err: '[error] server (x): aliases document not stored: relay down\n' }, machines: FAILED }) });
    const api = { ...base, post: async (path: string, body: unknown) => (path === '/delivery-retry' ? (sent.push({ path, body }), answerOf({ machines: DELIVERED })) : base.post(path, body)) };
    const result = await signAndChangeAlias(api, context(), SET_BOX, PASSPHRASE, NOW);
    expect(result.distribution).toMatchObject({ status: 'partial', retryCommand: RETRY });
    expect(result.distribution.headline).not.toContain('machine admin alias send');
    const again = await (result.retryDelivery as () => Promise<{ status: string }>)();
    expect(sent).toEqual([{ path: '/delivery-retry', body: { uuid: NETWORK_ALIASES_SUBJECT_UUID } }]);
    expect(again.status).toBe('delivered');
  });

  it('removal headline; no machine to tell: only the sentence', async () => {
    const base = context({ current: listOf([{ alias: 'box', uuid: LAPTOP.uuid }]), recipients: [] });
    const result = await signAndChangeAlias(stubApi({ post: answerOf({ machines: [], entries: [], text: { out: '', err: '' } }) }), base, { action: 'rm', alias: 'box' }, PASSPHRASE, NOW);
    expect(result.distribution).toMatchObject({ status: 'none', headline: 'Network alias "box" removed.' });
  });

  it('an answer without the list of machines is loud: the list may be installed, the page says how to check and what to run', async () => {
    const answer = { ok: true, serial: NOW, entries: [], changed: true, failed: false, report: {}, text: { out: '[ok] x\n', err: '' }, retry: RETRY };
    await expect(signAndChangeAlias(stubApi({ post: answer }), context(), SET_BOX, PASSPHRASE, NOW)).rejects.toThrow(/unexpected answer.*Aliases.*update the machine module.*machine admin alias send/s);
  });
});

describe('ALIASES_SUBJECT_UUID', () => {
  it('is the reserved uuid of machine-core (the page cannot import machine-core values: it is copied, and kept equal here)', () => {
    expect(ALIASES_SUBJECT_UUID).toBe(NETWORK_ALIASES_SUBJECT_UUID);
  });
});
