import { encryptAdminKey, generateSigningKeyPair, keyId, signPolicy as coreSignPolicy, verifyDocument, POLICY_DOMAIN, type PolicyBody, type PolicyEntry, type SignedPolicy } from '@wadeck-app/machine-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminKeyHolder } from './adminKeyHolder.js';
import type { AllowApi, AllowContext } from './allowFlow.js';
import { lifetimeWidens, prepareEdit, signAndSubmitEdit, type EditRef } from './allowedEdit.js';

// The delete and the change of lifetime of the Allowed page, without React: the next policy is computed HERE from a base whose signature is verified
// against the pinned admin key (decision 76), and signed with the admin key exactly like Allow. Real crypto, a recording stub for the server.

const PASSPHRASE = 'correct horse battery staple 7391';
const NOW = Math.floor(Date.now() / 1000);
const TARGET = '22222222-2222-4222-8222-222222222222';
const PEER = '11111111-1111-4111-8111-111111111111';

const admin = generateSigningKeyPair();
const ADMIN_KEY_ID = keyId(admin.publicKey);
const keyFile = JSON.stringify(encryptAdminKey(admin, PASSPHRASE));
const exact = (command: string, limits?: PolicyEntry['limits']): PolicyEntry => ({ shell: 'sh', command, ...(limits === undefined ? {} : { limits }) });

const signedBase = (version: number, defaults: PolicyEntry[], peers: PolicyBody['peers'] = {}, key = admin): SignedPolicy =>
  coreSignPolicy({ v: 1, target: TARGET, version, baseVersion: version - 1, adminKeyId: ADMIN_KEY_ID, issuedAt: NOW - 60, notBefore: NOW - 60, notAfter: NOW + 86400, defaults, peers }, key.privateKeyPkcs8);

const policy = (): SignedPolicy => signedBase(4, [exact('a'), exact('b', { maxCalls: 2 }), exact('c'), exact('d', { expiresAt: NOW + 600 })], { [PEER]: [exact('p1'), exact('p2', { maxCalls: 3 })] });

function context(over: Partial<AllowContext> = {}): AllowContext {
  return { ok: true, target: { uuid: TARGET, name: 'desktop' }, toSelf: true, policyMode: 'admin', adminKeyId: ADMIN_KEY_ID, adminPublicKey: admin.publicKey, current: policy(), source: 'installed on this machine', delivery: 'install', ...over };
}

const ref = (index: number, text: string, peerUuid = ''): EditRef => ({ shell: 'sh', text, index, peerUuid });

interface Sent { method: string; path: string; body?: unknown }
function stubApi(post: unknown = { ok: true, target: { uuid: TARGET, name: 'desktop' }, version: 5, delivery: 'installed' }): AllowApi & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    async elevate() { /* no PIN in a test */ },
    async get(path: string) {
      sent.push({ method: 'GET', path });
      if (path === '/admin-key') {
        return { file: keyFile };
      }
      throw new Error(`no stub for GET ${path}`);
    },
    async post(path: string, body: unknown) {
      sent.push({ method: 'POST', path, body });
      if (post instanceof Error) {
        throw post;
      }
      return post;
    },
  };
}

beforeEach(() => {
  adminKeyHolder.reset();
});

describe('prepareEdit: what the confirmation shows, before any passphrase', () => {
  it('a deletion of three entries of two lists: ONE version, the entries named as they are in the verified base, nobody else touched', async () => {
    const prepared = await prepareEdit(context(), 4, [ref(1, 'a'), ref(3, 'c'), ref(2, 'p2', PEER)], { kind: 'delete' }, NOW);
    expect(prepared).toMatchObject({ fromVersion: 4, toVersion: 5, kind: 'delete', widening: false, emptiedDefaults: false, emptiedPeerLists: [] });
    expect(prepared.entries.map((e) => [e.ref.text, e.before.command])).toEqual([['a', 'a'], ['c', 'c'], ['p2', 'p2']]);
    expect(prepared.body.defaults.map((e) => e.command)).toEqual(['b', 'd']);
    expect(prepared.body.peers[PEER]?.map((e) => e.command)).toEqual(['p1']);
    expect(prepared.defaultCount).toBe(2);
  });

  it('deleting the last entry of an own list is said: that peer then runs nothing', async () => {
    const prepared = await prepareEdit(context(), 4, [ref(1, 'p1', PEER), ref(2, 'p2', PEER)], { kind: 'delete' }, NOW);
    expect(prepared.emptiedPeerLists).toEqual([PEER]);
  });

  it('REFUSES when the policy moved since the page was read: the page shows version 3, it is 4 now; nothing is built', async () => {
    await expect(prepareEdit(context(), 3, [ref(1, 'a')], { kind: 'delete' }, NOW)).rejects.toThrow(/version 3.*version 4|changed since this page was read/s);
    await expect(prepareEdit(context(), 3, [ref(1, 'a')], { kind: 'delete' }, NOW)).rejects.toThrow(/Refresh the page/);
  });

  it('REFUSES an entry that is not where the page read it (same version number, another policy), with the fix', async () => {
    await expect(prepareEdit(context(), 4, [ref(1, 'zzz')], { kind: 'delete' }, NOW)).rejects.toThrow(/changed since it was read.*Refresh the page/s);
  });

  it('REFUSES a base the pinned admin key did not sign (a hostile backend must not slip entries into what the admin signs)', async () => {
    const forger = generateSigningKeyPair();
    const forged = signedBase(4, [exact('a')], {}, forger);
    await expect(prepareEdit(context({ current: forged }), 4, [ref(1, 'a')], { kind: 'delete' }, NOW)).rejects.toThrow(/not signed by the admin key pinned on this machine/);
  });

  it('says there is no policy to edit when none is on record', async () => {
    await expect(prepareEdit(context({ current: null }), 0, [ref(1, 'a')], { kind: 'delete' }, NOW)).rejects.toThrow(/no policy/);
  });

  it('a new lifetime: each entry shows its old and its new lifetime in words, the body is a renewal (limits replaced, generation up)', async () => {
    const prepared = await prepareEdit(context(), 4, [ref(2, 'b'), ref(1, 'a')], { kind: 'lifetime', lifetime: { times: '5' } }, NOW);
    expect(prepared.kind).toBe('lifetime');
    expect(prepared.entries.map((e) => [e.ref.text, e.before.limits?.maxCalls ?? 'none', e.after?.limits?.maxCalls])).toEqual([['b', 2, 5], ['a', 'none', 5]]);
    expect(prepared.entries[0]?.lifetimeBefore).toMatch(/2 calls/);
    expect(prepared.entries[0]?.lifetimeAfter).toMatch(/5 calls/);
    expect(prepared.body.defaults[1]).toEqual({ shell: 'sh', command: 'b', limits: { maxCalls: 5, renewals: 1 } });
    expect(prepared.body.v).toBe(2);
  });

  it('flags a widening: longer, more calls, or permanent; a stricter lifetime is not flagged', async () => {
    const toPermanent = await prepareEdit(context(), 4, [ref(2, 'b')], { kind: 'lifetime', lifetime: {} }, NOW);
    expect(toPermanent.widening).toBe(true);
    expect(toPermanent.entries[0]?.widens).toBe(true);
    const moreCalls = await prepareEdit(context(), 4, [ref(2, 'b')], { kind: 'lifetime', lifetime: { times: '9' } }, NOW);
    expect(moreCalls.widening).toBe(true);
    const longer = await prepareEdit(context(), 4, [ref(4, 'd')], { kind: 'lifetime', lifetime: { for: '1h' } }, NOW);
    expect(longer.widening).toBe(true);
    const stricter = await prepareEdit(context(), 4, [ref(2, 'b')], { kind: 'lifetime', lifetime: { times: '1' } }, NOW);
    expect(stricter.widening).toBe(false);
    const fromPermanent = await prepareEdit(context(), 4, [ref(1, 'a')], { kind: 'lifetime', lifetime: { times: '1' } }, NOW);
    expect(fromPermanent.widening).toBe(false);
  });

  it('a mixed selection is flagged as soon as ONE entry widens, and says which', async () => {
    const prepared = await prepareEdit(context(), 4, [ref(1, 'a'), ref(2, 'b')], { kind: 'lifetime', lifetime: { times: '3' } }, NOW);
    expect(prepared.widening).toBe(true);
    expect(prepared.entries.map((e) => e.widens)).toEqual([false, true]);
  });

  it('refuses an invalid lifetime with the parser sentence, and a lifetime that changes nothing (permanent to permanent)', async () => {
    await expect(prepareEdit(context(), 4, [ref(1, 'a')], { kind: 'lifetime', lifetime: { for: '99999d' } }, NOW)).rejects.toThrow(/at most 365 days/);
    await expect(prepareEdit(context(), 4, [ref(1, 'a'), ref(3, 'c')], { kind: 'lifetime', lifetime: {} }, NOW)).rejects.toThrow(/already permanent/);
  });
});

describe('lifetimeWidens', () => {
  it.each([
    ['permanent to permanent', undefined, undefined, false],
    ['permanent to once', undefined, { maxCalls: 1 }, false],
    ['once to permanent', { maxCalls: 1 }, undefined, true],
    ['3 calls to 4', { maxCalls: 3 }, { maxCalls: 4 }, true],
    ['3 calls to 3', { maxCalls: 3 }, { maxCalls: 3 }, false],
    ['3 calls to 2', { maxCalls: 3 }, { maxCalls: 2 }, false],
    ['a date to a later one', { expiresAt: 100 }, { expiresAt: 200 }, true],
    ['a date to an earlier one', { expiresAt: 200 }, { expiresAt: 100 }, false],
    ['calls to a date (the calls limit goes away)', { maxCalls: 2 }, { expiresAt: 100 }, true],
    ['a date to calls (the end date goes away)', { expiresAt: 100 }, { maxCalls: 2 }, true],
    ['calls and a date to a smaller of both', { maxCalls: 5, expiresAt: 200 }, { maxCalls: 4, expiresAt: 100 }, false],
  ] as const)('%s', (_name, before, after, expected) => {
    expect(lifetimeWidens(before, after)).toBe(expected);
  });
});

describe('signAndSubmitEdit: signs in the page and posts only signed documents', () => {
  it('a deletion with the passphrase: ONE policy, signed by the admin key, version + 1, edited from the verified base, and nothing else posted', async () => {
    const api = stubApi();
    const prepared = await prepareEdit(context(), 4, [ref(1, 'a'), ref(3, 'c')], { kind: 'delete' }, NOW);
    let signed = 0;
    const result = await signAndSubmitEdit(api, context(), prepared, PASSPHRASE, NOW, () => { signed++; });
    expect(result).toMatchObject({ ok: true, version: 5 });
    expect(signed).toBe(1);
    const posts = api.sent.filter((s) => s.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.path).toBe('/allow');
    const body = posts[0]?.body as { policy: SignedPolicy; document?: unknown };
    expect(Object.keys(body)).toEqual(['policy']);
    expect(verifyDocument(POLICY_DOMAIN, body.policy.body as never, admin.publicKey, body.policy.signature)).toBe(true);
    expect(body.policy.body).toMatchObject({ version: 5, baseVersion: 4, target: TARGET, adminKeyId: ADMIN_KEY_ID });
    expect(body.policy.body.defaults.map((e) => e.command)).toEqual(['b', 'd']);
    expect(JSON.stringify(posts)).not.toContain(PASSPHRASE);
  });

  it('a new lifetime for a selection signs ONE renewal policy; for another machine the sealed inbox document rides with it', async () => {
    const peerKeys = generateSigningKeyPair();
    const other = context({ toSelf: false, delivery: 'inbox', target: { uuid: TARGET, name: 'laptop', identityPublicKey: peerKeys.publicKey }, noticeRecipients: { selfUuid: PEER, current: null } });
    const api = stubApi({ ok: true, target: { uuid: TARGET, name: 'laptop' }, version: 5, delivery: 'inbox' });
    const prepared = await prepareEdit(other, 4, [ref(1, 'a'), ref(2, 'b')], { kind: 'lifetime', lifetime: { times: '7' } }, NOW);
    await signAndSubmitEdit(api, other, prepared, PASSPHRASE, NOW);
    const posts = api.sent.filter((s) => s.method === 'POST');
    expect(posts).toHaveLength(1);
    const body = posts[0]?.body as { policy: SignedPolicy; document?: unknown; noticeRecipients?: unknown };
    expect(body.document).toBeDefined();
    expect(body.policy.body.defaults.slice(0, 2)).toEqual([{ shell: 'sh', command: 'a', limits: { maxCalls: 7, renewals: 1 } }, { shell: 'sh', command: 'b', limits: { maxCalls: 7, renewals: 1 } }]);
  });

  it('signs with the key held in the page (no passphrase) and a locked key is refused with the fix, nothing posted', async () => {
    const api = stubApi();
    const prepared = await prepareEdit(context(), 4, [ref(1, 'a')], { kind: 'delete' }, NOW);
    await expect(signAndSubmitEdit(api, context(), prepared, null, NOW)).rejects.toThrow(/admin key is locked.*Nothing was signed/s);
    expect(api.sent.filter((s) => s.method === 'POST')).toEqual([]);
  });

  it('the daemon refusing a stale base is thrown as it is (it names the fix)', async () => {
    const api = stubApi(new Error('the policy of "desktop" is at version 5, and this one was edited from version 4: reload the page and allow it again. Nothing was stored or sent'));
    const prepared = await prepareEdit(context(), 4, [ref(1, 'a')], { kind: 'delete' }, NOW);
    await expect(signAndSubmitEdit(api, context(), prepared, PASSPHRASE, NOW)).rejects.toThrow(/reload the page/);
  });

  it('a wrong passphrase signs and posts nothing', async () => {
    const api = stubApi();
    const prepared = await prepareEdit(context(), 4, [ref(1, 'a')], { kind: 'delete' }, NOW);
    await expect(signAndSubmitEdit(api, context(), prepared, 'not the passphrase', NOW)).rejects.toThrow();
    expect(api.sent.filter((s) => s.method === 'POST')).toEqual([]);
  });
});
