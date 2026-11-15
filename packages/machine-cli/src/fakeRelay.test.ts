import { afterEach, describe, expect, it } from 'vitest';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { createRelayClient, RelayError, type SignedAddressRecord } from './relayClient.js';

// The fake relay is a test double, but the daemon, the CLI and the distribution tests rely on its record semantics:
// they are pinned here against relay-api.md (ownership bound at approval, compare-and-set, limits, presence).

let relay: FakeRelay | undefined;
afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

const uuidN = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const recordFor = (uuid: string, seq = 1, host = '10.0.0.1'): SignedAddressRecord => ({ body: { v: 1, uuid, addresses: [{ host, port: 47921 }], seq, issuedAt: 1_800_000_000 }, signature: 's' });
const failure = async (p: Promise<unknown>): Promise<RelayError> => {
  try {
    await p;
  } catch (e) {
    return e as RelayError;
  }
  throw new Error('expected a RelayError');
};

describe('fake relay: address records', () => {
  it('a uuid bound to a token: another machine token gets 403 not_owner on it', async () => {
    relay = await startFakeRelay();
    const second = relay.addMachineToken();
    relay.setOwner(uuidN(1), relay.token);
    relay.setOwner(uuidN(2), second);
    const a = createRelayClient({ baseUrl: relay.url, token: relay.token });
    const b = createRelayClient({ baseUrl: relay.url, token: second });
    await a.putRecord(uuidN(1), recordFor(uuidN(1)));
    const e = await failure(b.putRecord(uuidN(1), recordFor(uuidN(1), 2)));
    expect(e.status).toBe(403);
    expect(e.code).toBe('not_owner');
    // The other token can read it, and write its own uuid.
    expect((await b.getMachine(uuidN(1)))?.record.body.seq).toBe(1);
    await b.putRecord(uuidN(2), recordFor(uuidN(2)));
  });

  it('a full-access token may write any record without taking the ownership', async () => {
    relay = await startFakeRelay();
    const admin = createRelayClient({ baseUrl: relay.url, token: relay.adminToken });
    const machine = createRelayClient({ baseUrl: relay.url, token: relay.token });
    await admin.putRecord(uuidN(1), recordFor(uuidN(1)));
    // Still unbound: the machine token cannot take it, until an approval binds it.
    expect((await failure(machine.putRecord(uuidN(1), recordFor(uuidN(1), 2)))).code).toBe('not_registered');
    relay.setOwner(uuidN(1), relay.token);
    await machine.putRecord(uuidN(1), recordFor(uuidN(1), 2));
    expect((await machine.getMachine(uuidN(1)))?.record.body.seq).toBe(2);
  });

  it('refuses a body whose uuid differs from the path, an unknown field and a record over 2 KiB (400)', async () => {
    relay = await startFakeRelay();
    relay.setOwner(uuidN(1), relay.token);
    const c = createRelayClient({ baseUrl: relay.url, token: relay.token });
    expect((await failure(c.putRecord(uuidN(1), recordFor(uuidN(2))))).code).toBe('invalid_body');
    expect((await failure(c.putRecord(uuidN(1), { ...recordFor(uuidN(1)), extra: 1 } as SignedAddressRecord))).status).toBe(400);
    const big = recordFor(uuidN(1));
    big.signature = 'x'.repeat(2100);
    const e = await failure(c.putRecord(uuidN(1), big));
    expect(e.status).toBe(400);
    expect(e.code).toBe('invalid_body');
  });

  it('keeps the etag when the same bytes are written again, changes it when they differ, answers 412 with the current etag', async () => {
    relay = await startFakeRelay();
    relay.setOwner(uuidN(1), relay.token);
    const c = createRelayClient({ baseUrl: relay.url, token: relay.token });
    const first = await c.putRecord(uuidN(1), recordFor(uuidN(1)));
    expect((await c.putRecord(uuidN(1), recordFor(uuidN(1)), first.etag)).etag).toBe(first.etag);
    const second = await c.putRecord(uuidN(1), recordFor(uuidN(1), 2), first.etag);
    expect(second.etag).not.toBe(first.etag);
    const e = await failure(c.putRecord(uuidN(1), recordFor(uuidN(1), 3), first.etag));
    expect(e.status).toBe(412);
    expect(e.currentEtag).toBe(second.etag);
    expect((await c.getMachine(uuidN(1)))?.etag).toBe(second.etag);
  });

  it('presence: lastSeen is the last PUT or owner heartbeat, online while under 120 s', async () => {
    relay = await startFakeRelay();
    relay.setOwner(uuidN(1), relay.token);
    let now = 1_800_000_000;
    relay.setClock(() => now);
    const c = createRelayClient({ baseUrl: relay.url, token: relay.token });
    await c.putRecord(uuidN(1), recordFor(uuidN(1)));
    expect(await c.getMachine(uuidN(1))).toMatchObject({ lastSeen: 1_800_000_000, online: true });
    now += 119;
    expect(await c.getMachine(uuidN(1))).toMatchObject({ online: true });
    now += 1;
    expect(await c.getMachine(uuidN(1))).toMatchObject({ lastSeen: 1_800_000_000, online: false });
    await c.heartbeat(uuidN(1));
    expect(await c.getMachine(uuidN(1))).toMatchObject({ lastSeen: now, online: true });
    expect((await c.getMachines()).map((m) => [m.uuid, m.online])).toEqual([[uuidN(1), true]]);
  });

  it('a heartbeat of a token that does not own the uuid is refused (403 not_owner) and does not make it look online', async () => {
    relay = await startFakeRelay();
    relay.setOwner(uuidN(1), relay.token);
    let now = 1_800_000_000;
    relay.setClock(() => now);
    const strangerToken = relay.addMachineToken();
    // The stranger is registered for another uuid: its heartbeat on uuid 1 never refreshes the presence of uuid 1.
    relay.setOwner(uuidN(2), strangerToken);
    const stranger = createRelayClient({ baseUrl: relay.url, token: strangerToken });
    await createRelayClient({ baseUrl: relay.url, token: relay.token }).putRecord(uuidN(1), recordFor(uuidN(1)));
    now += 500;
    expect((await failure(stranger.heartbeat(uuidN(1)))).code).toBe('not_owner');
    expect(await stranger.getMachine(uuidN(1))).toMatchObject({ online: false });
  });

  it('DELETE needs a full-access token, removes the record, the binding and the presence', async () => {
    relay = await startFakeRelay();
    relay.setOwner(uuidN(1), relay.token);
    const machine = createRelayClient({ baseUrl: relay.url, token: relay.token });
    const admin = createRelayClient({ baseUrl: relay.url, token: relay.adminToken });
    await machine.putRecord(uuidN(1), recordFor(uuidN(1)));
    expect((await failure(machine.deleteMachine(uuidN(1)))).code).toBe('scope_denied');
    await admin.deleteMachine(uuidN(1));
    expect(await machine.getMachine(uuidN(1))).toBeUndefined();
    // The binding is gone too: the machine must post a new candidacy and be approved again.
    expect((await failure(machine.putRecord(uuidN(1), recordFor(uuidN(1), 9)))).code).toBe('not_registered');
  });

  it('GET of an unknown uuid is 404', async () => {
    relay = await startFakeRelay();
    expect(await createRelayClient({ baseUrl: relay.url, token: relay.token }).getMachine(uuidN(7))).toBeUndefined();
  });
});

describe('fake relay: more pairing codes', () => {
  it('each extra code is claimed once and gives its own machine token with its own label', async () => {
    relay = await startFakeRelay({ moreCodes: ['22223333', '44445555'] });
    const anonymous = createRelayClient({ baseUrl: relay.url });
    const first = await anonymous.claimPairing('12345678');
    const second = await anonymous.claimPairing('2222-3333');
    const third = await anonymous.claimPairing('44445555');
    expect(new Set([first.token, second.token, third.token]).size).toBe(3);
    expect([first.label, second.label, third.label]).toEqual(['machine-pairing', 'machine-pairing-2', 'machine-pairing-3']);
    expect((await failure(anonymous.claimPairing('22223333'))).status).toBe(401);
  });
});

describe('fake relay: ownership bound at approval (deployed, poc-owner 719f36f)', () => {
  const NAME_KEY = { name: 'laptop', hostname: 'host', identityPublicKey: 'k'.repeat(43), random: 'r'.repeat(22) };
  const post = (token: string, uuid: string, key = NAME_KEY.identityPublicKey) => createRelayClient({ baseUrl: (relay as FakeRelay).url, token }).postCandidacy({ ...NAME_KEY, identityPublicKey: key, uuid });
  const admin = () => createRelayClient({ baseUrl: (relay as FakeRelay).url, token: (relay as FakeRelay).adminToken });
  const approveWith = async (id: string) => admin().decideCandidacy(id, { decision: 'approve', approval: { v: 1 } });

  it('a candidacy without uuid is refused (400 invalid_body), with no option needed', async () => {
    relay = await startFakeRelay();
    const res = await fetch(`${relay.url}/api/machines/candidacies`, { method: 'POST', headers: { Authorization: `Bearer ${relay.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(NAME_KEY) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_body');
  });

  it('an unbound uuid: record, heartbeat and inbox read of a machine token are 403 not_registered, and the first writer binds nothing', async () => {
    relay = await startFakeRelay();
    const machine = createRelayClient({ baseUrl: relay.url, token: relay.token });
    for (const call of [() => machine.putRecord(uuidN(1), recordFor(uuidN(1))), () => machine.heartbeat(uuidN(1)), () => machine.listInbox(uuidN(1)), () => machine.deleteInboxDocument(uuidN(1), 'x'.repeat(22))]) {
      const e = await failure(call());
      expect([e.status, e.code]).toEqual([403, 'not_registered']);
    }
    expect((await failure(machine.putRecord(uuidN(1), recordFor(uuidN(1))))).code).toBe('not_registered');
    // A full-access token still writes records.
    await admin().putRecord(uuidN(1), recordFor(uuidN(1)));
  });

  it('the approval binds the uuid to the token that posted the candidacy: it then works for that token only', async () => {
    relay = await startFakeRelay();
    const other = relay.addMachineToken();
    const id = (await post(relay.token, uuidN(1))).id;
    const machine = createRelayClient({ baseUrl: relay.url, token: relay.token });
    expect((await failure(machine.putRecord(uuidN(1), recordFor(uuidN(1))))).code).toBe('not_registered');
    await approveWith(id);
    await machine.putRecord(uuidN(1), recordFor(uuidN(1)));
    expect((await machine.heartbeat(uuidN(1))).inboxCount).toBe(0);
    await expect(machine.listInbox(uuidN(1))).resolves.toEqual([]);
    const e = await failure(createRelayClient({ baseUrl: relay.url, token: other }).putRecord(uuidN(1), recordFor(uuidN(1), 2)));
    expect([e.status, e.code]).toEqual([403, 'not_owner']);
    expect((await failure(createRelayClient({ baseUrl: relay.url, token: other }).putRecord(uuidN(2), recordFor(uuidN(2))))).code).toBe('not_registered');
  });

  it('a bound uuid without a record is not listed by GET /api/machines', async () => {
    relay = await startFakeRelay();
    relay.approve((await post(relay.token, uuidN(1))).id, { v: 1 });
    expect(await createRelayClient({ baseUrl: relay.url, token: relay.token }).getMachines()).toEqual([]);
  });

  it('the test helper approve() binds like the decision route', async () => {
    relay = await startFakeRelay();
    const id = (await post(relay.token, uuidN(1))).id;
    relay.approve(id, { v: 1 });
    await createRelayClient({ baseUrl: relay.url, token: relay.token }).putRecord(uuidN(1), recordFor(uuidN(1)));
  });

  it('the admin list: unbound, bound to the candidate token (re-approval), bound to another token, bound to a revoked token', async () => {
    relay = await startFakeRelay({ moreCodes: ['22223333'] });
    const second = await createRelayClient({ baseUrl: relay.url }).claimPairing('22223333');
    const firstId = (await post(relay.token, uuidN(1))).id;
    const listed = await admin().listCandidacies();
    expect(listed).toMatchObject([{ id: firstId, uuid: uuidN(1), uuidBound: false, boundToCandidateToken: false }]);
    expect(listed[0]).not.toHaveProperty('boundTokenLabel');
    await approveWith(firstId);
    // The same token posts again (a new candidacy of the same machine): bound, but to the candidate token.
    const sameId = (await post(relay.token, uuidN(1), 'a'.repeat(43))).id;
    expect((await admin().listCandidacies()).find((c) => c.id === sameId)).toMatchObject({ uuidBound: true, boundTokenLabel: 'machine-pairing', boundToCandidateToken: true });
    // ANOTHER token posts the same uuid: a rebind.
    const otherId = (await post(second.token, uuidN(1), 'b'.repeat(43))).id;
    expect((await admin().listCandidacies()).find((c) => c.id === otherId)).toMatchObject({ uuidBound: true, boundTokenLabel: 'machine-pairing', boundToCandidateToken: false });
    // The bound token is revoked in the console: the label is the relay's placeholder.
    relay.revokeMachineToken(relay.token);
    expect((await admin().listCandidacies()).find((c) => c.id === otherId)).toMatchObject({ uuidBound: true, boundTokenLabel: '(revoked token)', boundToCandidateToken: false });
    await approveWith(otherId);
    await createRelayClient({ baseUrl: relay.url, token: second.token }).putRecord(uuidN(1), recordFor(uuidN(1)));
  });

  it('the decision answers 429 too_many_machines past the limit per token; the candidacy stays pending', async () => {
    relay = await startFakeRelay({ maxMachinesPerToken: 2 });
    const ids: string[] = [];
    for (const n of [1, 2, 3]) ids.push((await post(relay.token, uuidN(n), String(n).repeat(43))).id);
    await approveWith(ids[0] as string);
    await approveWith(ids[1] as string);
    const e = await failure(approveWith(ids[2] as string));
    expect([e.status, e.code]).toEqual([429, 'too_many_machines']);
    expect(relay.pendingIds()).toEqual([ids[2]]);
    // Approving a uuid the token already holds is not a new machine.
    const again = (await post(relay.token, uuidN(1), 'z'.repeat(43))).id;
    await approveWith(again);
    // The admin forgets a machine that is gone (DELETE): room again.
    await admin().deleteMachine(uuidN(1));
    await approveWith(ids[2] as string);
  });

  it('posting the same identity key with another uuid while the first candidacy is pending is 409 candidacy_uuid_changed; the same uuid is fine', async () => {
    relay = await startFakeRelay();
    await post(relay.token, uuidN(1));
    const e = await failure(post(relay.token, uuidN(2)));
    expect([e.status, e.code]).toEqual([409, 'candidacy_uuid_changed']);
    await post(relay.token, uuidN(1));
    // Once the candidacies are gone (rejected), the key may come back with another uuid.
    for (const id of relay.pendingIds()) relay.reject(id);
    await post(relay.token, uuidN(2));
  });
});

// Found by the integration tests against the REAL relay (poc-node, `npm run test:relay`): it dates a candidacy with ISO 8601 strings.
describe('fake relay: dates as the real relay sends them', () => {
  it('the post answer and the admin list carry ISO 8601 strings, 15 minutes apart', async () => {
    relay = await startFakeRelay({ scopes: null });
    const body = { name: 'laptop', hostname: 'h', identityPublicKey: 'k', random: 'r', uuid: uuidN(1) };
    const post = await fetch(`${relay.url}/api/machines/candidacies`, { method: 'POST', headers: { authorization: `Bearer ${relay.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const posted = (await post.json()) as { createdAt: unknown; expiresAt: unknown };
    expect(posted.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(posted.expiresAt as string) - Date.parse(posted.createdAt as string)).toBe(900_000);
    const list = await fetch(`${relay.url}/api/machines/candidacies`, { headers: { authorization: `Bearer ${relay.token}` } });
    const [entry] = ((await list.json()) as { candidacies: { createdAt: unknown; expiresAt: unknown }[] }).candidacies;
    expect(entry?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry?.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('fake relay: presence and inbox as the real relay answers', () => {
  const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const get = async (path: string, token: string) => {
    const r = await fetch(`${relay?.url}${path}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };

  it('a heartbeat before the first address record is 404 not_found (the record is written first), then 200', async () => {
    relay = await startFakeRelay();
    relay.setOwner(uuidN(1), relay.token);
    const before = await fetch(`${relay.url}/api/machines/${uuidN(1)}/heartbeat`, { method: 'POST', headers: { authorization: `Bearer ${relay.token}` } });
    expect(before.status).toBe(404);
    expect(await before.json()).toMatchObject({ success: false, error: 'not_found', message: 'No address record for this uuid yet: write it first with PUT /api/machines/<uuid>.' });
    await createRelayClient({ baseUrl: relay.url, token: relay.token }).putRecord(uuidN(1), recordFor(uuidN(1)));
    const after = await fetch(`${relay.url}/api/machines/${uuidN(1)}/heartbeat`, { method: 'POST', headers: { authorization: `Bearer ${relay.token}` } });
    expect(after.status).toBe(200);
  });

  it('lastSeen is an ISO string (null before any write) in the list and in one machine', async () => {
    relay = await startFakeRelay();
    relay.setOwner(uuidN(1), relay.token);
    await createRelayClient({ baseUrl: relay.url, token: relay.token }).putRecord(uuidN(1), recordFor(uuidN(1)));
    const list = await get('/api/machines', relay.token);
    expect(list.body.success).toBe(true);
    expect(((list.body.machines as { lastSeen: unknown }[])[0] as { lastSeen: unknown }).lastSeen).toMatch(isoPattern);
    const one = await get(`/api/machines/${uuidN(1)}`, relay.token);
    expect(one.body).toMatchObject({ success: true, uuid: uuidN(1), online: true });
    expect(one.body.lastSeen).toMatch(isoPattern);
  });

  it('an inbox page carries storedAt as an ISO string and next: null on the last page', async () => {
    relay = await startFakeRelay({ scopes: null });
    relay.setOwner(uuidN(1), relay.token);
    const id = 'a'.repeat(22);
    await createRelayClient({ baseUrl: relay.url, token: relay.token }).putInboxDocument(uuidN(1), { body: { id, to: uuidN(1) } } as never);
    const page = await get(`/api/machines/${uuidN(1)}/inbox`, relay.token);
    expect(page.body).toMatchObject({ success: true, more: false, next: null });
    expect(((page.body.documents as { storedAt: unknown }[])[0] as { storedAt: unknown }).storedAt).toMatch(isoPattern);
  });
});
