import { encryptAdminKey, generateSigningKeyPair, verifyRequestsList } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import type { AllowApi } from './allowFlow.js';
import { elevateForRemote, fetchRemoteRequests } from './remoteRequestsFlow.js';

// The remote part of the Requests page without React: the PIN, the encrypted key, the unlock (passphrase), one read-only `requests-list` document signed
// per peer, locked again, then posted to the module backend. Real crypto (one unlock derives 600 000 PBKDF2 rounds: few tests here).

const PASSPHRASE = 'correct horse battery staple 7391';
const NOW = Math.floor(Date.now() / 1000);
const SELF = '22222222-2222-4222-8222-222222222222';
const THINK = '11111111-1111-4111-8111-111111111111';
const LAPTOP = '33333333-3333-4333-8333-333333333333';
const admin = generateSigningKeyPair();
const keyFile = JSON.stringify(encryptAdminKey(admin, PASSPHRASE));

const page = (name: string) => ({ machine: { uuid: THINK, name }, policyMode: 'admin', allow: { available: true, machine: { uuid: THINK, name }, note: '' }, count: 1, waiting: [], denyNote: '', pending: [], pendingTotal: 0, chainOk: true, chainText: '', notes: [] });

interface Sent { method: string; path: string; body?: unknown }
function stubApi(post: (path: string, body: unknown) => unknown): AllowApi & { sent: Sent[]; elevated: number } {
  const sent: Sent[] = [];
  const api = {
    sent,
    elevated: 0,
    async elevate() { api.elevated++; },
    async get(path: string) {
      sent.push({ method: 'GET', path });
      if (path === '/admin-key') {
        return { file: keyFile };
      }
      throw new Error(`no stub for GET ${path}`);
    },
    async post(path: string, body: unknown) {
      sent.push({ method: 'POST', path, body });
      return post(path, body);
    },
  };
  return api;
}

const first = { uuid: THINK, name: 'thinkcentre' };
const peers = [first, { uuid: LAPTOP, name: 'laptop' }];

describe('elevateForRemote', () => {
  it('asks the PIN and nothing else', async () => {
    const api = stubApi(() => ({}));
    await elevateForRemote(api);
    expect(api.elevated).toBe(1);
    expect(api.sent).toEqual([]);
  });
});

describe('fetchRemoteRequests', () => {
  it('signs ONE read-only document per peer with the admin key, for that peer and from this machine, and posts only {machine, request}', async () => {
    const api = stubApi((_p, body) => page((body as { machine: string }).machine === THINK ? 'thinkcentre' : 'laptop'));
    const out = await fetchRemoteRequests(api, { selfUuid: SELF, peers, passphrase: PASSPHRASE, now: NOW });
    expect(out.map((o) => [o.peer.name, o.ok])).toEqual([['thinkcentre', true], ['laptop', true]]);
    expect(api.sent.filter((s) => s.method === 'GET').map((s) => s.path)).toEqual(['/admin-key']);
    const posts = api.sent.filter((s) => s.method === 'POST');
    expect(posts.map((p) => p.path)).toEqual(['/requests/remote', '/requests/remote']);
    for (const [i, peer] of peers.entries()) {
      const body = posts[i]?.body as { machine: string; request: unknown };
      expect(Object.keys(body).sort()).toEqual(['machine', 'request']);
      expect(body.machine).toBe(peer.uuid);
      // What the peer would check: the admin signature, its own uuid as target, the uuid of this machine as the sender.
      expect(verifyRequestsList(body.request, { adminPublicKey: admin.publicKey, selfUuid: peer.uuid, peerUuid: SELF, now: NOW })).toMatchObject({ ok: true });
    }
    const ids = posts.map((p) => (p.body as { request: { body: { id: string; nonce: string } } }).request.body);
    expect(new Set(ids.map((b) => b.id)).size).toBe(2);
    expect(new Set(ids.map((b) => b.nonce)).size).toBe(2);
  });

  it('never lets the passphrase leave the page: nothing sent contains it', async () => {
    const api = stubApi(() => page('thinkcentre'));
    await fetchRemoteRequests(api, { selfUuid: SELF, peers: [first], passphrase: PASSPHRASE, now: NOW });
    expect(JSON.stringify(api.sent)).not.toContain(PASSPHRASE);
  });

  it('a wrong passphrase stops before anything is posted, and the message is the unlock one', async () => {
    const api = stubApi(() => page('thinkcentre'));
    await expect(fetchRemoteRequests(api, { selfUuid: SELF, peers, passphrase: 'not the passphrase', now: NOW })).rejects.toThrow(/passphrase/i);
    expect(api.sent.filter((s) => s.method === 'POST')).toEqual([]);
  });

  it('a peer that fails is reported with its own reason and the others are still loaded', async () => {
    const api = stubApi((_p, body) => {
      if ((body as { machine: string }).machine === THINK) {
        throw new Error('cannot reach thinkcentre: no address known; run `machine peer connect thinkcentre --address <host:port>`');
      }
      return page('laptop');
    });
    const out = await fetchRemoteRequests(api, { selfUuid: SELF, peers, passphrase: PASSPHRASE, now: NOW });
    expect(out[0]).toMatchObject({ ok: false, message: expect.stringMatching(/cannot reach thinkcentre.*peer connect/) });
    expect(out[1]).toMatchObject({ ok: true });
  });

  it('refuses an answer that is not a requests page, naming the fix (module older than the page)', async () => {
    const api = stubApi(() => ({ nope: 1 }));
    const out = await fetchRemoteRequests(api, { selfUuid: SELF, peers: [first], passphrase: PASSPHRASE, now: NOW });
    expect(out[0]).toMatchObject({ ok: false, message: expect.stringMatching(/unexpected answer.*update the machine module/s) });
  });

  it('no peer to ask is an error that says so, before the key is read', async () => {
    const api = stubApi(() => page('x'));
    await expect(fetchRemoteRequests(api, { selfUuid: SELF, peers: [], passphrase: PASSPHRASE, now: NOW })).rejects.toThrow(/no other trusted machine/);
    expect(api.sent).toEqual([]);
  });
});
