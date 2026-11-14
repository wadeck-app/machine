import { afterEach, describe, expect, it } from 'vitest';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { createRelayClient, RelayError, type SignedAddressRecord } from './relayClient.js';

// The fake relay is a test double, but the daemon, the CLI and the distribution tests rely on its record semantics:
// they are pinned here against relay-api.md (owner rule, compare-and-set, limits, presence).

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
  it('the first machine token to PUT a uuid owns it; another machine token gets 403 not_owner', async () => {
    relay = await startFakeRelay();
    const second = relay.addMachineToken();
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
    // Still unowned: the machine token claims it.
    await machine.putRecord(uuidN(1), recordFor(uuidN(1), 2));
    expect((await machine.getMachine(uuidN(1)))?.record.body.seq).toBe(2);
  });

  it('refuses a body whose uuid differs from the path, an unknown field and a record over 2 KiB (400)', async () => {
    relay = await startFakeRelay();
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

  it('a heartbeat of a token that does not own the uuid does not make it look online', async () => {
    relay = await startFakeRelay();
    let now = 1_800_000_000;
    relay.setClock(() => now);
    const stranger = createRelayClient({ baseUrl: relay.url, token: relay.addMachineToken() });
    await createRelayClient({ baseUrl: relay.url, token: relay.token }).putRecord(uuidN(1), recordFor(uuidN(1)));
    now += 500;
    await stranger.heartbeat(uuidN(1));
    expect(await stranger.getMachine(uuidN(1))).toMatchObject({ online: false });
  });

  it('at most 50 records per token (429 too_many_machines)', async () => {
    relay = await startFakeRelay();
    const c = createRelayClient({ baseUrl: relay.url, token: relay.token });
    for (let i = 1; i <= 50; i++) await c.putRecord(uuidN(i), recordFor(uuidN(i)));
    const e = await failure(c.putRecord(uuidN(51), recordFor(uuidN(51))));
    expect(e.status).toBe(429);
    expect(e.code).toBe('too_many_machines');
    // Writing a record the token already owns is still fine.
    await c.putRecord(uuidN(1), recordFor(uuidN(1), 2));
  });

  it('DELETE needs a full-access token, removes the record, the owner and the presence', async () => {
    relay = await startFakeRelay();
    const machine = createRelayClient({ baseUrl: relay.url, token: relay.token });
    const admin = createRelayClient({ baseUrl: relay.url, token: relay.adminToken });
    await machine.putRecord(uuidN(1), recordFor(uuidN(1)));
    expect((await failure(machine.deleteMachine(uuidN(1)))).code).toBe('scope_denied');
    await admin.deleteMachine(uuidN(1));
    expect(await machine.getMachine(uuidN(1))).toBeUndefined();
    // Free again: a different token may now own it.
    await createRelayClient({ baseUrl: relay.url, token: relay.addMachineToken() }).putRecord(uuidN(1), recordFor(uuidN(1), 9));
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

describe('fake relay: bindOwnershipAtApproval (pending relay change, poc-owner #12)', () => {
  const NAME_KEY = { name: 'laptop', hostname: 'host', identityPublicKey: 'k'.repeat(43), random: 'r'.repeat(22) };
  const post = (token: string, uuid: string) => createRelayClient({ baseUrl: (relay as FakeRelay).url, token }).postCandidacy({ ...NAME_KEY, uuid });
  const admin = () => createRelayClient({ baseUrl: (relay as FakeRelay).url, token: (relay as FakeRelay).adminToken });
  const approveWith = async (id: string) => admin().decideCandidacy(id, { decision: 'approve', approval: { v: 1 } });

  it('a candidacy without uuid is refused (400 invalid_body)', async () => {
    relay = await startFakeRelay({ bindOwnershipAtApproval: true });
    const res = await fetch(`${relay.url}/api/machines/candidacies`, { method: 'POST', headers: { Authorization: `Bearer ${relay.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(NAME_KEY) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_body');
  });

  it('without the flag nothing changes: a candidacy without uuid is stored and the first writer owns the uuid', async () => {
    relay = await startFakeRelay();
    const res = await fetch(`${relay.url}/api/machines/candidacies`, { method: 'POST', headers: { Authorization: `Bearer ${relay.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(NAME_KEY) });
    expect(res.status).toBe(201);
    await createRelayClient({ baseUrl: relay.url, token: relay.token }).putRecord(uuidN(1), recordFor(uuidN(1)));
    const listed = await admin().listCandidacies();
    expect(listed[0]).not.toHaveProperty('uuidBound');
  });

  it('an unbound uuid: record, heartbeat and inbox read of a machine token are 403 not_registered, and the first writer binds nothing', async () => {
    relay = await startFakeRelay({ bindOwnershipAtApproval: true });
    const machine = createRelayClient({ baseUrl: relay.url, token: relay.token });
    for (const call of [() => machine.putRecord(uuidN(1), recordFor(uuidN(1))), () => machine.heartbeat(uuidN(1)), () => machine.listInbox(uuidN(1)), () => machine.deleteInboxDocument(uuidN(1), 'x'.repeat(22))]) {
      const e = await failure(call());
      expect([e.status, e.code]).toEqual([403, 'not_registered']);
    }
    // Still unbound afterwards.
    expect((await failure(machine.putRecord(uuidN(1), recordFor(uuidN(1))))).code).toBe('not_registered');
    // A full-access token still writes records.
    await admin().putRecord(uuidN(1), recordFor(uuidN(1)));
  });

  it('the approval binds the uuid to the token that posted the candidacy: it then works for that token only', async () => {
    relay = await startFakeRelay({ bindOwnershipAtApproval: true });
    const other = relay.addMachineToken();
    const id = (await post(relay.token, uuidN(1))).id;
    const machine = createRelayClient({ baseUrl: relay.url, token: relay.token });
    // Pending is not approved: still not registered.
    expect((await failure(machine.putRecord(uuidN(1), recordFor(uuidN(1))))).code).toBe('not_registered');
    await approveWith(id);
    await machine.putRecord(uuidN(1), recordFor(uuidN(1)));
    expect((await machine.heartbeat(uuidN(1))).inboxCount).toBe(0);
    await expect(machine.listInbox(uuidN(1))).resolves.toEqual([]);
    const e = await failure(createRelayClient({ baseUrl: relay.url, token: other }).putRecord(uuidN(1), recordFor(uuidN(1), 2)));
    expect([e.status, e.code]).toEqual([403, 'not_owner']);
    // The other token has no binding for its own uuid either.
    expect((await failure(createRelayClient({ baseUrl: relay.url, token: other }).putRecord(uuidN(2), recordFor(uuidN(2))))).code).toBe('not_registered');
  });

  it('the test helper approve() binds like the decision route', async () => {
    relay = await startFakeRelay({ bindOwnershipAtApproval: true });
    const id = (await post(relay.token, uuidN(1))).id;
    relay.approve(id, { v: 1 });
    await createRelayClient({ baseUrl: relay.url, token: relay.token }).putRecord(uuidN(1), recordFor(uuidN(1)));
  });

  it('the admin list says whether the uuid is already bound and to which token label; approving again replaces the binding', async () => {
    relay = await startFakeRelay({ bindOwnershipAtApproval: true, moreCodes: ['22223333'] });
    const anonymous = createRelayClient({ baseUrl: relay.url });
    const second = await anonymous.claimPairing('22223333');
    const firstId = (await post(relay.token, uuidN(1))).id;
    expect(await admin().listCandidacies()).toMatchObject([{ id: firstId, uuidBound: false }]);
    expect((await admin().listCandidacies())[0]).not.toHaveProperty('boundTokenLabel');
    await approveWith(firstId);
    // The same uuid is posted again by ANOTHER token (a rogue token, or the real machine with a new token).
    const secondId = (await post(second.token, uuidN(1))).id;
    expect(await admin().listCandidacies()).toMatchObject([{ id: secondId, uuid: uuidN(1), uuidBound: true, boundTokenLabel: 'machine-pairing' }]);
    await approveWith(secondId);
    await createRelayClient({ baseUrl: relay.url, token: second.token }).putRecord(uuidN(1), recordFor(uuidN(1)));
    expect((await failure(createRelayClient({ baseUrl: relay.url, token: relay.token }).putRecord(uuidN(1), recordFor(uuidN(1), 2)))).code).toBe('not_owner');
  });
});
