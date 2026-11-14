import { afterEach, describe, expect, it } from 'vitest';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { createRelayClient, normalizeRelayUrl, RelayError } from './relayClient.js';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const clientWith = (answer: () => Response | Promise<Response>, token = 'SECRET-TOKEN') =>
  createRelayClient({ baseUrl: 'https://relay.example/', token, fetch: (async () => answer()) as typeof fetch });

async function failure(promise: Promise<unknown>): Promise<RelayError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(RelayError);
    return e as RelayError;
  }
  throw new Error('expected the call to fail');
}

const UUID = '00000000-0000-4000-8000-000000000000';

describe('normalizeRelayUrl', () => {
  it('drops the trailing slash and accepts https and loopback http', () => {
    expect(normalizeRelayUrl('https://relay.example.test/')).toBe('https://relay.example.test');
    expect(normalizeRelayUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(normalizeRelayUrl('http://localhost:1')).toBe('http://localhost:1');
  });
  it.each(['http://example.com', 'ftp://x', 'nonsense', 'https://u:p@example.com', 'https://example.com/?a=1'])('refuses %j with a fix', (url) => {
    expect(() => normalizeRelayUrl(url)).toThrow(/relay URL|credentials|query/);
  });
});

describe('error mapping (injected fetch)', () => {
  it('401 on a machine route asks to join again, without the token', async () => {
    const e = await failure(clientWith(() => json(401, { success: false, error: 'unauthorized', message: 'bad token' })).getMachines());
    expect(e.status).toBe(401);
    expect(e.code).toBe('unauthorized');
    expect(e.message).toMatch(/machine join/);
    expect(e.message).not.toContain('SECRET-TOKEN');
  });

  it('pairing 401 uses error as human text and asks for a new code', async () => {
    const e = await failure(clientWith(() => json(401, { success: false, error: 'Invalid or expired code.' })).claimPairing('1234'));
    expect(e.code).toBeUndefined();
    expect(e.humanText).toBe('Invalid or expired code.');
    expect(e.message).toMatch(/new code/);
  });

  it('429 carries Retry-After and says how long to wait', async () => {
    const e = await failure(clientWith(() => json(429, { success: false, error: 'too_many_candidacies', message: 'slow down' }, { 'Retry-After': '42' })).getMachines());
    expect(e.retryAfterSeconds).toBe(42);
    expect(e.message).toMatch(/wait 42 s/);
  });

  it('429 prefers retryAfterSeconds from the body', async () => {
    const e = await failure(clientWith(() => json(429, { success: false, error: 'Too many attempts', retryAfterSeconds: 7 })).claimPairing('1'));
    expect(e.retryAfterSeconds).toBe(7);
  });

  it('412 keeps the current etag', async () => {
    const record = { body: { v: 1 as const, uuid: UUID, addresses: [], seq: 1, issuedAt: 1 }, signature: 's' };
    const e = await failure(clientWith(() => json(412, { success: false, error: 'precondition_failed', message: 'x', currentEtag: 'abc' })).putRecord(UUID, record, 'old'));
    expect(e.status).toBe(412);
    expect(e.currentEtag).toBe('abc');
  });

  it('a network failure names the URL', async () => {
    const c = createRelayClient({
      baseUrl: 'https://relay.example',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    const e = await failure(c.getMachines());
    expect(e.status).toBe(0);
    expect(e.message).toContain('https://relay.example');
  });

  it('a timeout is reported as such', async () => {
    const c = createRelayClient({
      baseUrl: 'https://relay.example',
      timeoutMs: 20,
      fetch: ((_url: string, init: RequestInit) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)))) as unknown as typeof fetch,
    });
    const e = await failure(c.getMachines());
    expect(e.message).toMatch(/did not answer within/);
  });

  it('refuses a claim whose scopes are null or lack "machine"', async () => {
    for (const scopes of [null, ['queue'], []]) {
      const e = await failure(clientWith(() => json(200, { success: true, token: 'FULL-TOKEN', label: 'x', scopes })).claimPairing('1'));
      expect(e.message).toMatch(/NOT saved/);
      expect(e.message).not.toContain('FULL-TOKEN');
    }
  });

  it('getMachine returns undefined on 404', async () => {
    expect(await clientWith(() => json(404, { success: false, error: 'not_found', message: 'x' })).getMachine(UUID)).toBeUndefined();
  });
});

describe('address record errors (injected fetch)', () => {
  const record = { body: { v: 1 as const, uuid: UUID, addresses: [{ host: '10.0.0.1', port: 1 }], seq: 1, issuedAt: 1 }, signature: 's' };

  it('not_registered (a uuid never approved, pending relay change poc-owner #12) says what to do, on a record write, a heartbeat and an inbox read', async () => {
    const answer = () => json(403, { success: false, error: 'not_registered', message: 'uuid not approved' });
    const client = clientWith(answer);
    for (const call of [() => client.putRecord(UUID, record), () => client.heartbeat(UUID), () => client.listInbox(UUID), () => client.deleteInboxDocument(UUID, 'x'.repeat(22))]) {
      const e = await failure(call());
      expect(e.status).toBe(403);
      expect(e.code).toBe('not_registered');
      expect(e.message).toContain('this machine is not approved yet: run machine join and ask the admin to approve it');
      expect(e.message).not.toMatch(/token may lack|scope/);
      expect(e.message).not.toContain('SECRET-TOKEN');
    }
  });

  it('not_registered carries the relay own text when present, plus the hint; the hint alone when the relay sent no text', async () => {
    const own = 'This machine is not registered on the relay: approve this machine first (the admin approves its candidacy, `machine admin approve`), then retry.';
    const withText = await failure(clientWith(() => json(403, { success: false, error: 'not_registered', message: own })).heartbeat(UUID));
    expect(withText.message).toContain(own);
    expect(withText.message).toContain('this machine is not approved yet: run machine join and ask the admin to approve it');
    const bare = await failure(clientWith(() => json(403, { success: false, error: 'not_registered' })).heartbeat(UUID));
    expect(bare.message).toContain('not_registered');
    expect(bare.message).toContain('this machine is not approved yet: run machine join and ask the admin to approve it');
  });

  it('not_owner on a record write says another token is bound to this uuid, and the fix: join again, the admin approves (rebind); no first-writer story', async () => {
    const e = await failure(clientWith(() => json(403, { success: false, error: 'not_owner', message: 'owned by another token' })).putRecord(UUID, record));
    expect(e.code).toBe('not_owner');
    expect(e.message).toContain(UUID);
    expect(e.message).toMatch(/another token is bound/);
    expect(e.message).toContain('machine join');
    expect(e.message).toMatch(/approve/);
    expect(e.message).toMatch(/rebind|replaces the binding/);
    expect(e.message).not.toMatch(/first token|first to write|first machine/);
    expect(e.message).not.toMatch(/lack the "machine" scope/);
    expect(e.message).not.toContain('SECRET-TOKEN');
  });

  it('too_many_machines (429) says the token holds too many records', async () => {
    const e = await failure(clientWith(() => json(429, { success: false, error: 'too_many_machines', message: 'at most 50' })).putRecord(UUID, record));
    expect(e.code).toBe('too_many_machines');
    expect(e.message).toMatch(/too many machine records/);
  });

  it('invalid_body (400) says the record was refused and to update machine', async () => {
    const e = await failure(clientWith(() => json(400, { success: false, error: 'invalid_body', message: 'bad' })).putRecord(UUID, record));
    expect(e.status).toBe(400);
    expect(e.message).toMatch(/address record/);
  });
});

describe('candidacy errors (injected fetch)', () => {
  const candidacy = { name: 'laptop', hostname: 'h', identityPublicKey: 'k', random: 'r', uuid: '11111111-2222-4333-8444-555555555555' };

  it('409 candidacy_uuid_changed on a post: this identity key already has a candidacy with another uuid; wait for it to expire or have the admin reject it, then join --resume', async () => {
    const e = await failure(clientWith(() => json(409, { success: false, error: 'candidacy_uuid_changed', message: 'uuid differs' })).postCandidacy(candidacy));
    expect(e.status).toBe(409);
    expect(e.code).toBe('candidacy_uuid_changed');
    expect(e.message).toMatch(/identity key already has a candidacy with another uuid/);
    expect(e.message).toMatch(/expire|reject/);
    expect(e.message).toContain('machine join --resume');
    expect(e.message).not.toContain('no longer pending');
  });

  it('429 too_many_machines on the decision: the candidacy is still pending, the machines that are gone are removed with forget-relay-record (DELETE /api/machines/<uuid>)', async () => {
    const e = await failure(clientWith(() => json(429, { success: false, error: 'too_many_machines', message: 'at most 50' })).decideCandidacy('id', { decision: 'approve', approval: {} }));
    expect(e.status).toBe(429);
    expect(e.code).toBe('too_many_machines');
    expect(e.message).toMatch(/still pending/);
    expect(e.message).toContain('DELETE /api/machines/<uuid>');
    expect(e.message).toContain('machine admin forget-relay-record <machine>');
    expect(e.message).not.toMatch(/rate limiting/);
  });
});

describe('against the fake relay', () => {
  let relay: FakeRelay | undefined;
  afterEach(async () => {
    await relay?.close();
    relay = undefined;
  });

  it('claims once, then posts and reads a candidacy', async () => {
    relay = await startFakeRelay();
    const claimed = await createRelayClient({ baseUrl: relay.url }).claimPairing('1234-5678');
    expect(claimed).toEqual({ token: relay.token, label: 'machine-pairing', scopes: ['machine'] });
    const client = createRelayClient({ baseUrl: relay.url, token: claimed.token });
    const posted = await client.postCandidacy({ name: 'laptop', hostname: 'h', identityPublicKey: 'k', random: 'r', uuid: '11111111-2222-4333-8444-555555555555' });
    expect(await client.getCandidacy(posted.id)).toEqual({ status: 'pending' });
    const e = await failure(createRelayClient({ baseUrl: relay.url }).claimPairing('12345678'));
    expect(e.status).toBe(401);
  });

  it('a machine token cannot list candidacies (403 full_access_required)', async () => {
    relay = await startFakeRelay();
    const client = createRelayClient({ baseUrl: relay.url, token: relay.token });
    expect((await failure(client.listCandidacies())).code).toBe('full_access_required');
  });

  it('admin calls work with a full-access token and approval is visible to the candidate', async () => {
    relay = await startFakeRelay({ scopes: null });
    const admin = createRelayClient({ baseUrl: relay.url, token: relay.token });
    const posted = await admin.postCandidacy({ name: 'laptop', hostname: 'h', identityPublicKey: 'k', random: 'r', uuid: '11111111-2222-4333-8444-555555555555' });
    expect((await admin.listCandidacies()).map((c) => c.id)).toEqual([posted.id]);
    await admin.decideCandidacy(posted.id, { decision: 'approve', approval: { a: 1 } });
    expect(await admin.getCandidacy(posted.id)).toEqual({ status: 'approved', approval: { a: 1 } });
    expect((await failure(admin.decideCandidacy(posted.id, { decision: 'reject' }))).status).toBe(409);
  });

  it('records: lower-cases the uuid, compare-and-set, heartbeat, listing', async () => {
    relay = await startFakeRelay();
    relay.setOwner('aaaaaaaa-0000-4000-8000-000000000000', relay.token);
    const client = createRelayClient({ baseUrl: relay.url, token: relay.token });
    const upper = 'AAAAAAAA-0000-4000-8000-000000000000';
    const record = { body: { v: 1 as const, uuid: upper.toLowerCase(), addresses: [{ host: '10.0.0.1', port: 1 }], seq: 1, issuedAt: 1 }, signature: 's' };
    const first = await client.putRecord(upper, record);
    expect((await failure(client.putRecord(upper, record, 'stale'))).currentEtag).toBe(first.etag);
    await client.putRecord(upper, record, first.etag);
    await client.heartbeat(upper);
    expect((await client.getMachine(upper))?.uuid).toBe(upper.toLowerCase());
    expect((await client.getMachines()).map((m) => m.uuid)).toEqual([upper.toLowerCase()]);
    expect(relay.requests.some((r) => /[A-F]{8}/.test(r.path))).toBe(false);
  });
});

describe('device login', () => {
  const started = { success: true, deviceCode: 'D'.repeat(43), userCode: 'BCDF-GH23', expiresIn: 300, pollIntervalSeconds: 3, verificationUrl: 'https://relay.example/device' };

  it('start and poll send no Authorization header, even when the client holds a token', async () => {
    const seen: (string | undefined)[] = [];
    const client = createRelayClient({
      baseUrl: 'https://relay.example',
      token: 'SECRET-TOKEN',
      fetch: (async (_url: string, init: RequestInit) => {
        seen.push((init.headers as Record<string, string>).Authorization);
        return json(init.body === JSON.stringify({ label: 'laptop' }) ? 201 : 200, init.body === JSON.stringify({ label: 'laptop' }) ? started : { status: 'pending' });
      }) as unknown as typeof fetch,
    });
    expect((await client.deviceLoginStart('laptop')).userCode).toBe('BCDF-GH23');
    expect(await client.deviceLoginPoll('D'.repeat(43))).toEqual({ status: 'pending' });
    expect(seen).toEqual([undefined, undefined]);
  });

  it('poll: pending, denied, expired and slow_down (429 with a code, or a status)', async () => {
    for (const status of ['pending', 'denied', 'expired'] as const) {
      expect(await clientWith(() => json(200, { status })).deviceLoginPoll('x')).toEqual({ status });
    }
    const slow429 = clientWith(() => json(429, { success: false, error: 'slow_down', message: 'too fast', retryAfterSeconds: 6 }, { 'Retry-After': '6' }));
    expect(await slow429.deviceLoginPoll('x')).toEqual({ status: 'slow_down', retryAfterSeconds: 6 });
    expect(await clientWith(() => json(200, { status: 'slow_down', retryAfterSeconds: 4 })).deviceLoginPoll('x')).toEqual({ status: 'slow_down', retryAfterSeconds: 4 });
  });

  it('poll: another 429 stays an error with its Retry-After', async () => {
    const e = await failure(clientWith(() => json(429, { success: false, error: 'too_many_attempts', message: 'later' }, { 'Retry-After': '40' })).deviceLoginPoll('x'));
    expect(e.status).toBe(429);
    expect(e.retryAfterSeconds).toBe(40);
  });

  it.each([[null], [['machine', 'extra']], [[]], [['other']]])('poll: refuses an approved token with scopes %j and never shows it', async (scopes) => {
    const e = await failure(clientWith(() => json(200, { status: 'approved', token: 'SECRET-DELIVERED', label: 'laptop', scopes })).deviceLoginPoll('DEVICE-SECRET'));
    expect(e.message).toMatch(/NOT saved/);
    expect(e.message).not.toContain('SECRET-DELIVERED');
    expect(e.message).not.toContain('DEVICE-SECRET');
  });

  it('poll: accepts exactly ["machine"] and returns the label of the relay', async () => {
    const r = await clientWith(() => json(200, { status: 'approved', token: 'T', label: 'laptop-2', scopes: ['machine'] })).deviceLoginPoll('x');
    expect(r).toEqual({ status: 'approved', token: 'T', label: 'laptop-2', scopes: ['machine'] });
  });

  it('a relay without the routes (404): says to use a pairing code', async () => {
    const e = await failure(clientWith(() => json(404, { success: false, error: 'not_found', message: 'no such route' })).deviceLoginStart('laptop'));
    expect(e.message).toMatch(/does not offer device login/);
    expect(e.message).toMatch(/machine join <code>/);
  });

  it('a malformed start answer is refused', async () => {
    expect((await failure(clientWith(() => json(201, { success: true })).deviceLoginStart('laptop'))).message).toMatch(/unexpected answer/);
  });
});

describe('inbox (documents distributed through the relay)', () => {
  let relay: FakeRelay | undefined;
  afterEach(async () => {
    await relay?.close();
    relay = undefined;
  });
  const TO = '11111111-1111-4111-8111-111111111111';
  const idOf = (n: number) => `${String(n).padStart(2, '0')}${'A'.repeat(20)}`;
  const doc = (n: number, to = TO) => ({ body: { v: 1, kind: 'peer', to, id: idOf(n), issuedAt: 1, expiresAt: 2, payload: {} }, signature: 's' });
  const clients = async (options: Parameters<typeof startFakeRelay>[0] = {}) => {
    relay = await startFakeRelay(options);
    return { relay, machine: createRelayClient({ baseUrl: relay.url, token: relay.token }), admin: createRelayClient({ baseUrl: relay.url, token: relay.adminToken }) };
  };

  it('the admin PUTs, the owner lists oldest first, deletes, and the heartbeat counts', async () => {
    const { relay: r, machine, admin } = await clients();
    r.setOwner(TO, r.token);
    await admin.putInboxDocument(TO, doc(1));
    await admin.putInboxDocument(TO, doc(2));
    expect((await machine.heartbeat(TO)).inboxCount).toBe(2);
    const listed = await machine.listInbox(TO);
    expect(listed.map((e) => e.id)).toEqual([idOf(1), idOf(2)]);
    expect(listed[0]?.document).toEqual(doc(1));
    expect(typeof listed[0]?.storedAt).toBe('number');
    await machine.deleteInboxDocument(TO, idOf(1));
    // Idempotent: an unknown id is not an error.
    await machine.deleteInboxDocument(TO, idOf(1));
    expect((await machine.heartbeat(TO)).inboxCount).toBe(1);
    expect(r.requests.find((q) => q.method === 'PUT' && q.path.endsWith(`/inbox/${idOf(1)}`))?.authorization).toBe(`Bearer ${r.adminToken}`);
  });

  it('the same document again is accepted (idempotent), another one under the same id is id_conflict', async () => {
    const { admin } = await clients();
    await admin.putInboxDocument(TO, doc(1));
    await admin.putInboxDocument(TO, doc(1));
    const other = { ...doc(1), signature: 'other' };
    const e = await failure(admin.putInboxDocument(TO, other));
    expect(e.status).toBe(409);
    expect(e.code).toBe('id_conflict');
    expect(e.message).toMatch(/id_conflict/);
    expect(e.message).toMatch(new RegExp(idOf(1)));
  });

  it('the list loops over the pages with more and next', async () => {
    const { relay: r, machine, admin } = await clients({ inboxPageSize: 2 });
    r.setOwner(TO, r.token);
    for (let i = 1; i <= 5; i++) await admin.putInboxDocument(TO, doc(i));
    expect((await machine.listInbox(TO)).map((e) => e.id)).toEqual([1, 2, 3, 4, 5].map(idOf));
    expect(r.requests.filter((q) => q.method === 'GET' && q.path.endsWith('/inbox')).length).toBe(3);
  });

  it('a machine token cannot PUT: scope_denied (403), explained as needing a full-access token', async () => {
    const { machine } = await clients();
    const e = await failure(machine.putInboxDocument(TO, doc(1)));
    expect(e.status).toBe(403);
    expect(e.code).toBe('scope_denied');
    expect(e.message).toMatch(/full-access token/);
  });

  it('a token that does not own the inbox gets not_owner on list and delete, with the fix', async () => {
    const { relay: r, machine } = await clients();
    r.setOwner(TO, 'another-token');
    for (const call of [machine.listInbox(TO), machine.deleteInboxDocument(TO, idOf(1))]) {
      const e = await failure(call);
      expect(e.status).toBe(403);
      expect(e.code).toBe('not_owner');
      expect(e.message).toMatch(/does not own the inbox/);
      // The first-writer rule is gone: the text names the binding made at approval and the fix (join again, the admin approves = rebind).
      expect(e.message).toMatch(/another token is bound/);
      expect(e.message).toContain('machine join');
      expect(e.message).toMatch(/approve/);
      expect(e.message).not.toMatch(/first|published its address record/);
      expect(e.message).not.toContain(r.token);
    }
  });

  it('too_many_documents names the machine that does not drain its inbox; the cap is 256 documents', async () => {
    const { admin } = await clients({ inboxLimits: { perInbox: 2 } });
    await admin.putInboxDocument(TO, doc(1));
    await admin.putInboxDocument(TO, doc(2));
    const e = await failure(admin.putInboxDocument(TO, doc(3)));
    expect(e.status).toBe(429);
    expect(e.code).toBe('too_many_documents');
    expect(e.message).toContain(TO);
    expect(e.message).toMatch(/not draining|is not reading|drain/);
  });

  it('relay_inbox_full is the relay as a whole, not one machine', async () => {
    const { admin } = await clients({ inboxLimits: { globalBytes: 100 } });
    const e = await failure(admin.putInboxDocument(TO, doc(1)));
    expect(e.status).toBe(429);
    expect(e.code).toBe('relay_inbox_full');
    expect(e.message).toMatch(/relay owner/);
  });

  it('refuses before sending a document that is not a document of this version (no id)', async () => {
    const { relay: r, admin } = await clients();
    await expect(admin.putInboxDocument(TO, { body: {}, signature: 's' } as never)).rejects.toThrow(/id/);
    expect(r.requests).toHaveLength(0);
  });

  it('deleteMachine: admin only, forgets the inbox, an unknown machine is not an error', async () => {
    const { relay: r, machine, admin } = await clients();
    r.setOwner(TO, r.token);
    await admin.putInboxDocument(TO, doc(1));
    expect((await failure(machine.deleteMachine(TO))).code).toBe('scope_denied');
    await admin.deleteMachine(TO);
    expect(r.inbox(TO)).toEqual([]);
    await admin.deleteMachine(TO);
    await admin.deleteMachine('22222222-2222-4222-8222-222222222222');
  });

  it('canonical lower-case uuids in every path, whatever the caller passes', async () => {
    const { relay: r, admin } = await clients();
    await admin.putInboxDocument(TO.toUpperCase(), doc(1));
    await admin.deleteMachine(TO.toUpperCase());
    expect(r.requests.some((q) => /[A-F]{4}/.test(q.path.replace(/A{20}/g, '')))).toBe(false);
  });

  it('the heartbeat without an inbox count (a relay that is not updated) reports undefined, never 0', async () => {
    const answers = clientWith(() => json(204, undefined));
    expect(await answers.heartbeat(TO)).toEqual({ inboxCount: undefined });
  });

  it('a malformed list answer is refused as an incompatible relay', async () => {
    expect((await failure(clientWith(() => json(200, { documents: 'x' })).listInbox(TO))).message).toMatch(/unexpected answer/);
    // more without next would loop forever
    const e = await failure(clientWith(() => json(200, { documents: [], more: true })).listInbox(TO));
    expect(e.message).toMatch(/unexpected answer/);
  });

  it('a relay that keeps saying more with the same next is stopped, not followed forever', async () => {
    const e = await failure(clientWith(() => json(200, { documents: [{ id: idOf(1), document: {}, storedAt: 1 }], more: true, next: 'same' })).listInbox(TO));
    expect(e.message).toMatch(/unexpected answer/);
  });

  it('deployed relay: a document above 32 KiB is body_too_large (413), an unknown cursor is invalid_cursor (400), a malformed id is invalid_id (400): each explained', async () => {
    const big = clientWith(() => json(413, { success: false, error: 'body_too_large', message: 'too big' }));
    const tooBig = await failure(big.putInboxDocument(TO, doc(1)));
    expect(tooBig.status).toBe(413);
    expect(tooBig.message).toMatch(/32 KiB|too large/);
    const cursor = await failure(clientWith(() => json(400, { success: false, error: 'invalid_cursor', message: 'bad cursor' })).listInbox(TO));
    expect(cursor.code).toBe('invalid_cursor');
    expect(cursor.message).toMatch(/invalid_cursor/);
    const badId = await failure(clientWith(() => json(400, { success: false, error: 'invalid_id', message: 'bad id' })).deleteInboxDocument(TO, 'x'));
    expect(badId.code).toBe('invalid_id');
  });

  it('a real cursor is accepted by the relay, an invented one is refused (invalid_cursor)', async () => {
    const { relay: r, machine, admin } = await clients({ inboxPageSize: 1 });
    r.setOwner(TO, r.token);
    await admin.putInboxDocument(TO, doc(1));
    await admin.putInboxDocument(TO, doc(2));
    expect((await machine.listInbox(TO)).map((e) => e.id)).toEqual([idOf(1), idOf(2)]);
    const raw = await fetch(`${r.url}/api/machines/${TO}/inbox?after=${idOf(9)}`, { headers: { Authorization: `Bearer ${r.token}` } });
    expect(raw.status).toBe(400);
    expect(((await raw.json()) as { error: string }).error).toBe('invalid_cursor');
  });

  it('an inbox written before the approval is readable only after the approval binds the uuid to the token; a machine that was removed is not registered any more', async () => {
    const { relay: r, machine, admin } = await clients();
    await admin.putInboxDocument(TO, doc(1));
    // Not approved: not_registered, and writing a record does not bind anything (the first writer rule is gone).
    expect((await failure(machine.listInbox(TO))).code).toBe('not_registered');
    const record = { body: { v: 1 as const, uuid: TO, addresses: [{ host: '10.0.0.1', port: 1 }], seq: 1, issuedAt: 1 }, signature: 's' };
    expect((await failure(machine.putRecord(TO, record))).code).toBe('not_registered');
    const candidacy = await machine.postCandidacy({ name: 'laptop', hostname: 'h', identityPublicKey: 'k', random: 'r', uuid: TO });
    await admin.decideCandidacy(candidacy.id, { decision: 'approve', approval: { v: 1 } });
    expect((await machine.listInbox(TO)).map((e) => e.id)).toEqual([idOf(1)]);
    // The admin removes the machine: the binding and the inbox are gone, the machine must be approved again.
    await admin.deleteMachine(TO);
    expect(r.inbox(TO)).toEqual([]);
    expect((await failure(machine.listInbox(TO))).code).toBe('not_registered');
  });

  it('no error ever contains the token', async () => {
    for (const [status, code] of [[403, 'not_owner'], [429, 'too_many_documents'], [429, 'relay_inbox_full'], [409, 'id_conflict'], [404, 'not_found'], [500, 'store_unavailable']] as const) {
      const client = clientWith(() => json(status, { success: false, error: code, message: 'text' }));
      for (const call of [client.putInboxDocument(TO, doc(1)), client.listInbox(TO), client.deleteInboxDocument(TO, idOf(1)), client.deleteMachine(TO)]) {
        try {
          await call;
        } catch (e) {
          expect((e as Error).message).not.toContain('SECRET-TOKEN');
        }
      }
    }
  });
});

describe('inbox: sizes and bounds', () => {
  const TO = '11111111-1111-4111-8111-111111111111';
  const entry = (n: number) => ({ id: `${String(n).padStart(2, '0')}${'A'.repeat(20)}`, document: {}, storedAt: 1 });

  it('a page above 1 MiB is a loud error naming the limit, not something that is parsed', async () => {
    const huge = 'x'.repeat(1024 * 1024 + 10);
    const e = await failure(clientWith(() => json(200, { documents: [{ id: 'a', document: huge, storedAt: 1 }], more: false })).listInbox(TO));
    expect(e.message).toMatch(/1 MiB/);
    expect(e.message).not.toContain('SECRET-TOKEN');
  });

  it('stops asking for pages once it has the number of documents it is willing to examine', async () => {
    let calls = 0;
    const client = clientWith(() => {
      calls++;
      return json(200, { documents: [entry(calls * 2), entry(calls * 2 + 1)], more: true, next: `n${calls}` });
    });
    const listed = await client.listInbox(TO, 3);
    expect(listed).toHaveLength(3);
    expect(calls).toBe(2);
  });
});

describe('every answer of the relay is bounded (an untrusted relay cannot make the daemon buffer without limit)', () => {
  const UUID2 = '00000000-0000-4000-8000-000000000000';

  /** A body that never ends: counts the bytes the client actually pulled. */
  function endless(status = 200) {
    const state = { pulled: 0 };
    const chunk = new Uint8Array(16 * 1024).fill(0x20);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        state.pulled += chunk.length;
        controller.enqueue(chunk);
      },
    });
    return { state, response: () => new Response(stream, { status, headers: { 'Content-Type': 'application/json' } }) };
  }

  const cases: Array<[string, number, (c: ReturnType<typeof createRelayClient>) => Promise<unknown>]> = [
    ['getMachine', 4 * 1024, (c) => c.getMachine(UUID2)],
    ['getMachines', 3 * 1024 * 1024, (c) => c.getMachines()],
    ['listCandidacies', 64 * 1024, (c) => c.listCandidacies()],
    ['getCandidacy', 64 * 1024, (c) => c.getCandidacy('abc')],
    ['heartbeat', 64 * 1024, (c) => c.heartbeat(UUID2)],
    ['putRecord', 64 * 1024, (c) => c.putRecord(UUID2, { body: { v: 1, uuid: UUID2, addresses: [], seq: 1, issuedAt: 1 }, signature: 's' })],
    ['claimPairing', 64 * 1024, (c) => c.claimPairing('1234')],
    ['deviceLoginPoll', 64 * 1024, (c) => c.deviceLoginPoll('D'.repeat(43))],
    ['deviceLoginStart', 64 * 1024, (c) => c.deviceLoginStart('laptop')],
    ['postCandidacy', 64 * 1024, (c) => c.postCandidacy({ name: 'a', hostname: 'h', identityPublicKey: 'k', random: 'r', uuid: UUID2 })],
    ['decideCandidacy', 64 * 1024, (c) => c.decideCandidacy('abc', { decision: 'reject' })],
    ['deleteMachine', 64 * 1024, (c) => c.deleteMachine(UUID2)],
    ['deleteInboxDocument', 64 * 1024, (c) => c.deleteInboxDocument(UUID2, 'x'.repeat(22))],
  ];

  it.each(cases)('%s stops reading at its limit and fails loudly, without the token', async (_name, limit, call) => {
    const body = endless();
    const c = createRelayClient({ baseUrl: 'https://relay.example', token: 'SECRET-TOKEN', fetch: (async () => body.response()) as typeof fetch });
    const e = await failure(call(c));
    expect(e.status).toBe(0);
    expect(e.message).toContain('https://relay.example');
    expect(e.message).toMatch(/larger than/);
    expect(e.message).not.toContain('SECRET-TOKEN');
    // Bounded work: not much more than the limit was pulled (one chunk of slack for the stream's own read-ahead).
    expect(body.state.pulled).toBeLessThanOrEqual(limit + 64 * 1024);
  });

  it('an endless ERROR answer is bounded too', async () => {
    const body = endless(500);
    const c = createRelayClient({ baseUrl: 'https://relay.example', token: 'SECRET-TOKEN', fetch: (async () => body.response()) as typeof fetch });
    const e = await failure(c.getMachine(UUID2));
    expect(e.message).toMatch(/larger than/);
  });

  it('the limits are named in the message', async () => {
    const one = endless();
    const e1 = await failure(createRelayClient({ baseUrl: 'https://relay.example', fetch: (async () => one.response()) as typeof fetch }).getMachine(UUID2));
    expect(e1.message).toMatch(/4 KiB/);
    const two = endless();
    const e2 = await failure(createRelayClient({ baseUrl: 'https://relay.example', fetch: (async () => two.response()) as typeof fetch }).getMachines());
    expect(e2.message).toMatch(/3 MiB/);
  });

  it('a declared content-length above the limit is refused before reading', async () => {
    const c = createRelayClient({ baseUrl: 'https://relay.example', fetch: (async () => new Response('{}', { status: 200, headers: { 'content-length': String(10 * 1024 * 1024) } })) as typeof fetch });
    expect((await failure(c.getMachines())).message).toMatch(/3 MiB/);
  });
});
