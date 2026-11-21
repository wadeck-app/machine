import { afterEach, describe, expect, it } from 'vitest';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { createRelayClient, AccessLoginUnsupportedError, normalizeRelayUrl, RelayError } from './relayClient.js';

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
    expect(normalizeRelayUrl('http://[::1]:8080')).toBe('http://[::1]:8080');
  });
  it.each(['http://localhost:1', 'http://LOCALHOST:1', 'http://foo.localhost:1'])('refuses the name %s over plain http and says to use 127.0.0.1', (url) => {
    expect(() => normalizeRelayUrl(url)).toThrow(/http:\/\/127\.0\.0\.1:<port>/);
  });
  it('still accepts https on a name', () => {
    expect(normalizeRelayUrl('https://localhost:1')).toBe('https://localhost:1');
  });
  it.each(['http://example.com', 'ftp://x', 'nonsense', 'https://u:p@example.com', 'https://example.com/?a=1'])('refuses %j with a fix', (url) => {
    expect(() => normalizeRelayUrl(url)).toThrow(/relay URL|credentials|query/);
  });
});

describe('redirects (G5)', () => {
  it('passes redirect: "error" to fetch, so a redirect never carries the token to another host', async () => {
    let init: RequestInit | undefined;
    const client = createRelayClient({
      baseUrl: 'https://relay.example/',
      token: 'SECRET-TOKEN',
      fetch: (async (_u: string, i: RequestInit) => {
        init = i;
        return json(200, { machines: [] });
      }) as unknown as typeof fetch,
    });
    await client.getMachines();
    expect(init?.redirect).toBe('error');
  });

  it('a refused redirect becomes an actionable error naming the redirect and the relay, without the token', async () => {
    const client = createRelayClient({
      baseUrl: 'https://relay.example/',
      token: 'SECRET-TOKEN',
      fetch: (async () => {
        throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
      }) as unknown as typeof fetch,
    });
    const redirectRefused = await failure(client.getMachines());
    expect(redirectRefused.message).toContain('https://relay.example');
    expect(redirectRefused.message).toMatch(/redirect/i);
    expect(redirectRefused.message).toMatch(/--relay|relay URL/);
    expect(redirectRefused.message).not.toContain('SECRET-TOKEN');
  });
});

describe('NODE_TLS_REJECT_UNAUTHORIZED=0 (G9)', () => {
  const make = (env: NodeJS.ProcessEnv) => createRelayClient({ baseUrl: 'https://relay.example/', token: 'SECRET-TOKEN', env, fetch: (async () => json(200, {})) as typeof fetch });
  it('refuses to create a client, naming the variable, the consequence and the fix', () => {
    expect(() => make({ NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toThrow(/NODE_TLS_REJECT_UNAUTHORIZED/);
    expect(() => make({ NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toThrow(/disables certificate validation for the whole process/);
    expect(() => make({ NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toThrow(/unset/);
    expect(() => make({ NODE_TLS_REJECT_UNAUTHORIZED: '0' })).not.toThrow(/SECRET-TOKEN/);
  });
  it.each([undefined, '1', ''])('accepts the value %j', (value) => {
    expect(() => make(value === undefined ? {} : { NODE_TLS_REJECT_UNAUTHORIZED: value })).not.toThrow();
  });
});

const GATE_TEXT =(method: string, path: string) =>
  `This token is limited to the scope machine and cannot call ${method} ${path}: that endpoint needs a full-access token. Use a token of the right scope, or ask the person who runs the relay for a full-access token.`;

describe('the real scope gate answer (403, free text in "error", no code)', () => {
  const ID = 'c'.repeat(22);
  const doc = { body: { v: 2, kind: 'peer', id: ID, to: UUID, payload: { sealed: 'AAAA' } } } as never;
  const calls: Array<[string, (c: ReturnType<typeof createRelayClient>) => Promise<unknown>, string, string]> = [
    ['list candidacies', (c) => c.listCandidacies(), 'GET', '/api/machines/candidacies'],
    ['decide', (c) => c.decideCandidacy(ID, { decision: 'reject' } as never), 'PUT', `/api/machines/candidacies/${ID}/decision`],
    ['write an inbox document', (c) => c.putInboxDocument(UUID, doc), 'PUT', `/api/machines/${UUID}/inbox/${ID}`],
    ['delete a machine', (c) => c.deleteMachine(UUID), 'DELETE', `/api/machines/${UUID}`],
  ];
  it.each(calls)('%s: the advice to run machine admin login, the relay text kept, the token never printed', async (_n, run, method, path) => {
    const text = GATE_TEXT(method, path);
    const e = await failure(run(clientWith(() => json(403, { success: false, error: text }))));
    expect(e.status).toBe(403);
    expect(e.message).toMatch(/cannot approve machines|plain machine token/);
    expect(e.message).toContain('machine admin login');
    expect(e.message).toContain('limited to the scope machine');
    expect(e.message).not.toContain('SECRET-TOKEN');
  });
  it('a known machine code on an admin path keeps its own message (not_owner is not the machine-admin advice)', async () => {
    const e = await failure(clientWith(() => json(403, { success: false, error: 'not_owner', message: 'no' })).putInboxDocument(UUID, doc));
    expect(e.message).toMatch(/does not own the inbox/);
    expect(e.message).not.toMatch(/machine admin login/);
  });
  describe('putInboxDocument never sends a clear document (decision 78): refused here, before any request, whoever built it', () => {
    const sentRequests: string[] = [];
    const recording = () => createRelayClient({ baseUrl: 'https://relay.example/', token: 'SECRET-TOKEN', fetch: (async (url: string) => (sentRequests.push(String(url)), json(204, undefined))) as unknown as typeof fetch });
    const refusal = async (promise: Promise<unknown>): Promise<Error> => {
      try {
        await promise;
      } catch (e) {
        return e as Error;
      }
      throw new Error('expected the document to be refused');
    };
    const clear = { body: { v: 1, kind: 'policy', id: ID, to: UUID, issuedAt: 1, expiresAt: 2, payload: { body: { defaults: [{ shell: 'sh', command: 'echo secret' }] }, signature: 's' } }, signature: 's' } as never;

    it('a version 1 document (clear payload) is refused with the cause and the fix, and nothing is sent', async () => {
      sentRequests.length = 0;
      const clearRefused = await refusal(recording().putInboxDocument(UUID, clear));
      expect(clearRefused.message).toMatch(/PLAINTEXT|plaintext/);
      expect(clearRefused.message).toMatch(/machine cli update/);
      expect(clearRefused.message).not.toContain('echo secret');
      expect(sentRequests).toEqual([]);
    });

    it('a version 2 document whose payload is not exactly one sealed blob is refused too', async () => {
      sentRequests.length = 0;
      const notSealed = { body: { v: 2, kind: 'policy', id: ID, to: UUID, payload: { defaults: [] } }, signature: 's' } as never;
      const notSealedRefused = await refusal(recording().putInboxDocument(UUID, notSealed));
      expect(notSealedRefused.message).toMatch(/sealed/);
      expect(sentRequests).toEqual([]);
    });
  });
  it('the same free text on a path a machine may call is not the admin advice', async () => {
    const e = await failure(clientWith(() => json(403, { success: false, error: GATE_TEXT('GET', '/api/whoami') })).whoami());
    expect(e.message).not.toMatch(/machine admin login/);
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

  it('the relay text is sanitized once at the source: ESC and newline never reach the message, humanText or code; it is capped', async () => {
    const hostile = 'bad\u001b[2J\nforged line\r[ok] done';
    const e = await failure(clientWith(() => json(500, { success: false, error: hostile, message: `${hostile}${'x'.repeat(1000)}` })).getMachines());
    // eslint-disable-next-line no-control-regex
    for (const text of [e.message, e.humanText ?? '', e.code ?? '']) expect(text).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(e.humanText).toContain('bad?[2J?forged line?[ok] done');
    expect((e.humanText ?? '').length).toBeLessThanOrEqual(303);
    const p = await failure(clientWith(() => json(401, { success: false, error: hostile })).claimPairing('1234'));
    // eslint-disable-next-line no-control-regex
    expect(`${p.message}${p.humanText}`).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it('403 full_access_required / scope_denied: the machine-admin advice only on the machine network admin calls, not on any other path', async () => {
    const onMachines = await failure(clientWith(() => json(403, { success: false, error: 'full_access_required', message: 'admin only' })).listCandidacies());
    expect(onMachines.message).toMatch(/machine admin login/);
    const elsewhere = await failure(clientWith(() => json(403, { success: false, error: 'scope_denied', message: 'no' })).whoami());
    expect(elsewhere.status).toBe(403);
    expect(elsewhere.message).not.toMatch(/machine admin login|machine-admin/);
    expect(elsewhere.message).toMatch(/refused this request \(403\)/);
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

  it('too_many_machines (429) on a record quotes the limit of the relay and the forget-relay-record command', async () => {
    const e = await failure(clientWith(() => json(429, { success: false, error: 'too_many_machines', limit: 7, message: 'This token already owns the maximum number of machines (7).' })).putRecord(UUID, record));
    expect(e.code).toBe('too_many_machines');
    expect(e.message).toContain('this token already owns the maximum (7) machines');
    expect(e.message).toContain('machine admin forget-relay-record <machine|uuid>');
    expect(e.message).not.toMatch(/\b50\b/);
  });

  it('too_many_machines (429) on a record, relay-wide cap: the relay itself is full, tell the relay operator', async () => {
    const e = await failure(clientWith(() => json(429, { success: false, error: 'too_many_machines', limit: 1000, message: 'The relay holds 1000 machines already: ask its operator.' })).putRecord(UUID, record));
    expect(e.message).toContain('the relay itself is full (1000 machines)');
    expect(e.message).toContain('relay operator');
    expect(e.message).not.toContain('already owns the maximum');
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

  const decide = (body: unknown) => failure(clientWith(() => json(429, body)).decideCandidacy('id', { decision: 'approve', approval: {} }));

  it('429 too_many_machines on the decision: the candidacy is still pending, the limit of the relay is quoted, machines that are gone are freed with forget-relay-record', async () => {
    const e = await decide({ success: false, error: 'too_many_machines', limit: 2, message: 'This token already owns the maximum number of machines (2).' });
    expect(e.status).toBe(429);
    expect(e.code).toBe('too_many_machines');
    expect(e.message).toMatch(/still pending/);
    expect(e.message).toContain('this token already owns the maximum (2) machines');
    expect(e.message).toContain('machine admin forget-relay-record <machine|uuid>');
    expect(e.message).toContain('machine admin approve <id>');
    expect(e.message).not.toMatch(/rate limiting/);
    expect(e.message).not.toMatch(/\b50\b/);
  });

  it('429 too_many_machines on the decision, relay-wide cap (message prefix "The relay holds"): the relay itself is full, tell the relay operator; still pending', async () => {
    const e = await decide({ success: false, error: 'too_many_machines', limit: 1000, message: 'The relay holds 1000 machines already: ask its operator.' });
    expect(e.message).toContain('the relay itself is full (1000 machines)');
    expect(e.message).toContain('relay operator');
    expect(e.message).toMatch(/still pending/);
    expect(e.message).not.toContain('already owns the maximum');
  });

  it('429 too_many_machines without a limit (an older relay): says the relay did not state it, never guesses a number', async () => {
    const e = await decide({ success: false, error: 'too_many_machines', message: 'at most some' });
    expect(e.message).toContain('did not state its limit');
    expect(e.message).toContain('machine admin forget-relay-record <machine|uuid>');
    expect(e.message).not.toMatch(/\b50\b/);
  });

  it.each([['ten'], [2.5], [0], [-3], [null], [[2]]])('429 too_many_machines with a garbage limit (%j): loud, names the invalid value', async (limit) => {
    const e = await decide({ success: false, error: 'too_many_machines', limit, message: 'x' });
    expect(e.code).toBe('too_many_machines');
    expect(e.message).toContain('invalid limit');
    expect(e.message).toContain(JSON.stringify(limit));
    expect(e.message).toMatch(/still pending/);
  });
});

// The REAL relay (found by the integration tests of `npm run test:relay`) dates candidacies with ISO 8601 strings, not epoch seconds.
describe('dates of a candidacy as the real relay sends them (ISO 8601)', () => {
  const candidacy = { name: 'laptop', hostname: 'h', identityPublicKey: 'k', random: 'r', uuid: '11111111-2222-4333-8444-555555555555' };
  const created = '2026-11-15T12:00:00.000Z';
  const expires = '2026-11-15T12:15:00.000Z';
  const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);

  it('a post is read into epoch seconds', async () => {
    const posted = await clientWith(() => json(201, { success: true, id: 'abc', createdAt: created, expiresAt: expires })).postCandidacy(candidacy);
    expect(posted).toEqual({ id: 'abc', createdAt: seconds(created), expiresAt: seconds(expires) });
  });

  it('the admin list is read into epoch seconds, every other field kept', async () => {
    const entry = { id: 'abc', name: 'laptop', hostname: 'h', uuid: candidacy.uuid, identityPublicKey: 'k', random: 'r', observedIp: '1.2.3.4', createdAt: created, expiresAt: expires, uuidBound: false };
    const listed = await clientWith(() => json(200, { success: true, candidacies: [entry] })).listCandidacies();
    expect(listed).toEqual([{ ...entry, createdAt: seconds(created), expiresAt: seconds(expires) }]);
  });

  it.each([
    ['a number (not what the relay sends)', 1_800_000_000],
    ['text that is not a date', 'tomorrow'],
    ['nothing', undefined],
  ])('%s is refused loudly, naming the field', async (_what, bad) => {
    const e = await failure(clientWith(() => json(201, { success: true, id: 'abc', createdAt: created, expiresAt: bad })).postCandidacy(candidacy));
    expect(e.message).toMatch(/unexpected answer to the candidacy post/);
    expect(e.message).toMatch(/expiresAt/);
  });

  it('a list entry with a bad date is refused loudly, naming the field', async () => {
    const e = await failure(clientWith(() => json(200, { success: true, candidacies: [{ id: 'abc', createdAt: 'nope', expiresAt: expires }] })).listCandidacies());
    expect(e.message).toMatch(/unexpected answer to the candidacy list/);
    expect(e.message).toMatch(/createdAt/);
  });
});

// Same for the inbox (storedAt) and the presence (lastSeen): the real relay sends ISO 8601 strings, the rest of the program counts epoch seconds.
describe('inbox and presence dates as the real relay sends them (ISO 8601)', () => {
  const stored = '2026-11-15T12:00:05.123Z';
  const seen = '2026-11-15T12:01:00.000Z';
  const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  const doc = { body: { v: 1, kind: 'peer', to: UUID, id: 'a'.repeat(22), issuedAt: 1, expiresAt: 2, payload: {} }, signature: 's' };

  it('an inbox page is read with storedAt in epoch seconds', async () => {
    const entries = await clientWith(() => json(200, { success: true, documents: [{ id: 'a'.repeat(22), document: doc, storedAt: stored }], more: false, next: null })).listInbox(UUID);
    expect(entries).toEqual([{ id: 'a'.repeat(22), document: doc, storedAt: seconds(stored) }]);
  });

  it('an inbox entry with a storedAt that is not a date is refused loudly, naming the field', async () => {
    const e = await failure(clientWith(() => json(200, { success: true, documents: [{ id: 'a'.repeat(22), document: doc, storedAt: 12 }], more: false, next: null })).listInbox(UUID));
    expect(e.message).toMatch(/unexpected answer to the inbox list/);
    expect(e.message).toMatch(/storedAt/);
  });

  it('the machine list and one machine are read with lastSeen in epoch seconds (null stays null)', async () => {
    const record = { body: { v: 1, uuid: UUID, addresses: [], seq: 1, issuedAt: 1 }, signature: 's' };
    const listed = await clientWith(() => json(200, { success: true, machines: [{ uuid: UUID, record, lastSeen: seen, online: true }, { uuid: UUID, record, lastSeen: null, online: false }] })).getMachines();
    expect(listed.map((m) => m.lastSeen)).toEqual([seconds(seen), null]);
    const one = await clientWith(() => json(200, { success: true, uuid: UUID, record, etag: '3', lastSeen: seen, online: true })).getMachine(UUID);
    expect(one).toMatchObject({ lastSeen: seconds(seen), etag: '3', online: true });
  });

  it('a lastSeen that is not a date or null is refused loudly, naming the field', async () => {
    const e = await failure(clientWith(() => json(200, { success: true, machines: [{ uuid: UUID, record: {}, lastSeen: 'yesterday', online: false }] })).getMachines());
    expect(e.message).toMatch(/unexpected answer to the machine list/);
    expect(e.message).toMatch(/lastSeen/);
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

  it('a machine token cannot list candidacies (403 with the free text of the real scope gate, read as scope_denied)', async () => {
    relay = await startFakeRelay();
    const client = createRelayClient({ baseUrl: relay.url, token: relay.token });
    expect((await failure(client.listCandidacies())).code).toBe('scope_denied');
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

describe('device login with an admin access (machine setup, machine admin login)', () => {
  const startedAs = (access: string | undefined) => ({ success: true, access, deviceCode: 'D'.repeat(43), userCode: 'ADMN-7K42', expiresIn: 300, pollIntervalSeconds: 3, verificationUrl: 'https://relay.example/device' });
  const delivered = (extra: Record<string, unknown>) => ({ status: 'approved', token: 'SECRET-DELIVERED', label: 'desk admin', ...extra });
  const refused = (what: string, e: RelayError) => {
    expect(e.message, what).toMatch(/NOT saved/);
    expect(e.message, what).not.toContain('SECRET-DELIVERED');
    expect(e.message, what).not.toContain('DEVICE-SECRET');
    // The token already exists on the relay: the admin is told which one to revoke.
    expect(e.message, what).toMatch(/revoke "desk admin"/i);
  };

  it('start puts the asked access in the body (machine-admin, full); a machine start sends the label only (unchanged for every relay)', async () => {
    const bodies: unknown[] = [];
    const client = createRelayClient({
      baseUrl: 'https://relay.example',
      fetch: (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { access?: string };
        bodies.push(body);
        return json(201, startedAs(body.access));
      }) as unknown as typeof fetch,
    });
    expect((await client.deviceLoginStart('desk admin', 'machine-admin')).access).toBe('machine-admin');
    expect((await client.deviceLoginStart('desk admin', 'full')).access).toBe('full');
    await client.deviceLoginStart('desk');
    expect(bodies).toEqual([{ label: 'desk admin', access: 'machine-admin' }, { label: 'desk admin', access: 'full' }, { label: 'desk' }]);
  });

  it('a relay older than the machine-admin scope (400 invalid_body): a dedicated error naming the scope, the relay commit, the fix; nothing falls back to full access', async () => {
    const e = await failure(clientWith(() => json(400, { success: false, error: 'invalid_body', message: 'access must be "machine" (default) or "full"' })).deviceLoginStart('desk admin', 'machine-admin'));
    expect(e).toBeInstanceOf(AccessLoginUnsupportedError);
    expect((e as AccessLoginUnsupportedError).access).toBe('machine-admin');
    expect((e as AccessLoginUnsupportedError).pendingRequest).toBe(false);
    expect(e.message).toMatch(/predates the `machine-admin` scope \(poc-node 78fe5b2\)/);
    expect(e.message).toMatch(/update and redeploy it/);
    expect(e.message).toMatch(/nothing was stored/i);
    expect(e.message).toMatch(/no full-access token was requested/);
  });

  it('a relay older than the full-access login (400 invalid_body): the same error type for access full, pointing at the pairing code', async () => {
    const e = await failure(clientWith(() => json(400, { success: false, error: 'invalid_body', message: 'unexpected field' })).deviceLoginStart('desk admin', 'full'));
    expect(e).toBeInstanceOf(AccessLoginUnsupportedError);
    expect((e as AccessLoginUnsupportedError).access).toBe('full');
    expect(e.message).toMatch(/does not support the full-access login yet/);
    expect(e.message).toMatch(/pairing code/);
  });

  it('a 400 of another kind stays a plain error', async () => {
    const e = await failure(clientWith(() => json(400, { success: false, error: 'something_else', message: 'x' })).deviceLoginStart('desk admin', 'machine-admin'));
    expect(e).not.toBeInstanceOf(AccessLoginUnsupportedError);
  });

  it.each([
    ['machine-admin', 'machine'],
    ['machine-admin', undefined],
    ['full', 'machine'],
    ['full', undefined],
  ] as const)('asked %s, the start answer says %s: an older relay started a MACHINE login, refused, the pending request is named', async (asked, said) => {
    const e = await failure(clientWith(() => json(201, startedAs(said))).deviceLoginStart('desk admin', asked));
    expect(e).toBeInstanceOf(AccessLoginUnsupportedError);
    expect((e as AccessLoginUnsupportedError).pendingRequest).toBe(true);
    expect(e.message).toMatch(/MACHINE login/);
    expect(e.message).toMatch(/deny the request "desk admin"/i);
  });

  it('asked machine-admin, the start answer says full: refused (the console would show a FULL ACCESS request that nobody asked for)', async () => {
    const e = await failure(clientWith(() => json(201, startedAs('full'))).deviceLoginStart('desk admin', 'machine-admin'));
    expect(e).toBeInstanceOf(AccessLoginUnsupportedError);
    expect(e.message).toMatch(/deny the request "desk admin"/i);
  });

  it('poll for machine-admin: accepts access "machine-admin" with scopes exactly ["machine-admin"]', async () => {
    const r = await clientWith(() => json(200, delivered({ access: 'machine-admin', scopes: ['machine-admin'] }))).deviceLoginPoll('x', 'machine-admin');
    expect(r).toEqual({ status: 'approved', token: 'SECRET-DELIVERED', label: 'desk admin', scopes: ['machine-admin'] });
  });

  it.each([
    ['a machine token', { access: 'machine', scopes: ['machine'] }],
    ['a full-access token', { access: 'full', scopes: null }],
    ['no access field', { scopes: ['machine-admin'] }],
    ['access machine-admin with scopes null', { access: 'machine-admin', scopes: null }],
    ['access machine-admin with the machine scope only', { access: 'machine-admin', scopes: ['machine'] }],
    ['access machine-admin with more scopes', { access: 'machine-admin', scopes: ['machine-admin', 'queue'] }],
    ['access machine-admin with no scopes field', { access: 'machine-admin' }],
  ])('poll for machine-admin: refuses %s, never shows it, names the cause and the token to revoke', async (name, extra) => {
    const e = await failure(clientWith(() => json(200, delivered(extra))).deviceLoginPoll('DEVICE-SECRET', 'machine-admin'));
    refused(name, e);
    expect(e.message).toMatch(/machine-admin/);
  });

  it.each(['machine', 'machine-admin'] as const)('poll for %s: a 409 request_denied (a decoy was clicked) is the status denied, not a crash', async (access) => {
    const r = await clientWith(() => json(409, { success: false, error: 'request_denied', message: 'You picked a code the machine does not show' })).deviceLoginPoll('x', access);
    expect(r).toEqual({ status: 'denied' });
  });

  it('poll for full access: accepts access "full" with scopes null', async () => {
    const r = await clientWith(() => json(200, delivered({ access: 'full', scopes: null }))).deviceLoginPoll('x', 'full');
    expect(r).toEqual({ status: 'approved', token: 'SECRET-DELIVERED', label: 'desk admin', scopes: null });
  });

  it.each([
    ['a machine token', { access: 'machine', scopes: ['machine'] }],
    ['a machine-admin token', { access: 'machine-admin', scopes: ['machine-admin'] }],
    ['no access field', { scopes: null }],
    ['access full with scopes', { access: 'full', scopes: ['machine'] }],
  ])('poll for full access: refuses %s, never shows it, names the cause and the token to revoke', async (name, extra) => {
    const e = await failure(clientWith(() => json(200, delivered(extra))).deviceLoginPoll('DEVICE-SECRET', 'full'));
    refused(name, e);
  });

  it.each([
    ['a machine-admin token', { access: 'machine-admin', scopes: ['machine-admin'] }],
    ['a full-access token that says machine', { access: 'machine', scopes: null }],
    ['a full-access token that says full', { access: 'full', scopes: null }],
    ['a token with other scopes', { access: 'machine', scopes: ['machine', 'queue'] }],
  ])('poll for a machine login: refuses %s (a machine join never stores more than ["machine"])', async (_name, extra) => {
    const e = await failure(clientWith(() => json(200, delivered(extra))).deviceLoginPoll('x'));
    expect(e.message).toMatch(/NOT saved/);
    expect(e.message).not.toContain('SECRET-DELIVERED');
  });

  it('poll for a machine login still accepts the answer of a relay that predates the access field (no access, scopes ["machine"])', async () => {
    const r = await clientWith(() => json(200, delivered({ scopes: ['machine'] }))).deviceLoginPoll('x');
    expect(r).toMatchObject({ status: 'approved', scopes: ['machine'] });
  });
});

describe('pairing claim for the admin (machine admin login <code>)', () => {
  const claimed = (scopes: unknown) => json(200, { success: true, token: 'SECRET-CLAIMED', label: 'admin-pairing', scopes });

  it('accepts a token limited to ["machine-admin"] (preferred) and returns its scopes', async () => {
    expect(await clientWith(() => claimed(['machine-admin'])).claimPairing('12345678', 'admin')).toEqual({ token: 'SECRET-CLAIMED', label: 'admin-pairing', scopes: ['machine-admin'] });
  });

  it('a full-access token is accepted only with the explicit opt-in (admin-full) and says so in the returned scopes (null): the caller warns', async () => {
    expect((await clientWith(() => claimed(null)).claimPairing('12345678', 'admin-full')).scopes).toBeNull();
  });

  it('a full-access token is REFUSED without the opt-in: NOT saved, it must be revoked, the explicit way is named', async () => {
    const e = await failure(clientWith(() => claimed(null)).claimPairing('12345678', 'admin'));
    expect(e.message).toMatch(/FULL-ACCESS token/);
    expect(e.message).toMatch(/NOT saved/);
    expect(e.message).toMatch(/revoke it in the relay console/);
    expect(e.message).toContain('--full-access');
    expect(e.message).not.toContain('SECRET-CLAIMED');
  });

  it.each([[['machine']], [['queue']], [['machine', 'machine-admin']], [[]]])('refuses scopes %j: it could not list or decide, NOT saved, the fix is named', async (scopes) => {
    const e = await failure(clientWith(() => claimed(scopes)).claimPairing('12345678', 'admin'));
    expect(e.message).toMatch(/NOT saved/);
    expect(e.message).toMatch(/machine-admin/);
    expect(e.message).not.toContain('SECRET-CLAIMED');
  });

  it('a machine join still refuses an admin or full-access token', async () => {
    for (const scopes of [['machine-admin'], null]) {
      const e = await failure(clientWith(() => claimed(scopes)).claimPairing('12345678'));
      expect(e.message).toMatch(/NOT saved/);
    }
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
  const doc = (n: number, to = TO) => ({ body: { v: 2, kind: 'peer', to, id: idOf(n), issuedAt: 1, expiresAt: 2, payload: { sealed: 'AAAA' } }, signature: 's' });
  const clients = async (options: Parameters<typeof startFakeRelay>[0] = {}) => {
    relay = await startFakeRelay(options);
    return { relay, machine: createRelayClient({ baseUrl: relay.url, token: relay.token }), admin: createRelayClient({ baseUrl: relay.url, token: relay.adminToken }) };
  };

  it('the admin PUTs, the owner lists oldest first, deletes, and the heartbeat counts', async () => {
    const { relay: r, machine, admin } = await clients();
    r.setOwner(TO, r.token);
    await admin.putInboxDocument(TO, doc(1));
    await admin.putInboxDocument(TO, doc(2));
    // The real relay refuses a heartbeat until the address record exists.
    await machine.putRecord(TO, { body: { v: 1, uuid: TO, addresses: [{ host: '10.0.0.1', port: 1 }], seq: 1, issuedAt: 1_800_000_000 }, signature: 's' });
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

  it('a machine token cannot PUT: the scope gate 403 (read as scope_denied), explained with the machine-admin story and the command', async () => {
    const { machine } = await clients();
    const e = await failure(machine.putInboxDocument(TO, doc(1)));
    expect(e.status).toBe(403);
    expect(e.code).toBe('scope_denied');
    expect(e.message).toMatch(/plain machine token/);
    expect(e.message).toMatch(/machine admin login/);
    expect(e.message).toMatch(/machine-admin/);
    expect(e.message).not.toMatch(/FULL ACCESS|WITHOUT/);
  });

  it('a token that does not own the inbox gets not_owner on list and delete, with the fix', async () => {
    const { relay: r, machine } = await clients();
    r.setOwner(TO, 'another-token');
    for (const call of [() => machine.listInbox(TO), () => machine.deleteInboxDocument(TO, idOf(1))]) {
      const e = await failure(call());
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
    const e = await failure(clientWith(() => json(200, { documents: [{ id: idOf(1), document: {}, storedAt: '2026-11-15T12:00:00.000Z' }], more: true, next: 'same' })).listInbox(TO));
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
  const entry = (n: number) => ({ id: `${String(n).padStart(2, '0')}${'A'.repeat(20)}`, document: {}, storedAt: '2026-11-15T12:00:00.000Z' });

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

describe('version and whoami (machine ping)', () => {
  it('getVersion reads the public GET /api/version without sending the token', async () => {
    let seen: { url: string; authorization: string | null } | undefined;
    const c = createRelayClient({
      baseUrl: 'https://relay.example',
      token: 'SECRET-TOKEN',
      fetch: (async (url: string, init: RequestInit) => {
        seen = { url, authorization: new Headers(init.headers).get('authorization') };
        return json(200, { success: true, version: '2026.11.14-144', serverStartedAt: '2026-11-14T10:00:00.000Z', uptimeSeconds: 3600, instanceNonce: 'n' });
      }) as typeof fetch,
    });
    expect(await c.getVersion()).toEqual({ version: '2026.11.14-144', uptimeSeconds: 3600 });
    expect(seen).toEqual({ url: 'https://relay.example/api/version', authorization: null });
  });

  it('getVersion says "no such route" with undefined on a 404 (an older relay, or not a relay at all)', async () => {
    expect(await clientWith(() => json(404, { success: false, error: 'not_found', message: 'no' })).getVersion()).toBeUndefined();
  });

  it('getVersion refuses an answer without a version string, naming the relay', async () => {
    const e = await failure(clientWith(() => json(200, { success: true })).getVersion());
    expect(e.status).toBe(0);
    expect(e.message).toMatch(/unexpected answer to the relay version/);
  });

  it('getVersion reports an unreachable relay with the fix', async () => {
    const c = createRelayClient({ baseUrl: 'https://relay.example', fetch: (async () => { throw new Error('getaddrinfo ENOTFOUND relay.example'); }) as typeof fetch });
    const e = await failure(c.getVersion());
    expect(e.status).toBe(0);
    expect(e.message).toMatch(/cannot reach the relay https:\/\/relay\.example .*ENOTFOUND/);
  });

  it.each([
    [['machine'], ['machine']],
    [['machine-admin'], ['machine-admin']],
    [null, null],
  ])('whoami returns the scopes %j of the token and its label', async (scopes, expected) => {
    const c = clientWith(() => json(200, { success: true, username: 'u', tokenId: 't', label: 'desktop', via: 'bearer', scopes, serverTime: '2026-11-15T10:00:00.000Z', tokenCount: 2 }));
    expect(await c.whoami()).toEqual({ scopes: expected, label: 'desktop' });
  });

  it('whoami sends the token', async () => {
    let authorization: string | null = null;
    const c = createRelayClient({ baseUrl: 'https://relay.example', token: 'SECRET-TOKEN', fetch: (async (_u: string, init: RequestInit) => { authorization = new Headers(init.headers).get('authorization'); return json(200, { success: true, scopes: ['machine'] }); }) as typeof fetch });
    await c.whoami();
    expect(authorization).toBe('Bearer SECRET-TOKEN');
  });

  it('whoami is undefined on a 404 (a relay without /api/whoami)', async () => {
    expect(await clientWith(() => json(404, { success: false })).whoami()).toBeUndefined();
  });

  it('whoami on a revoked token says so and never prints the token', async () => {
    const e = await failure(clientWith(() => json(401, { success: false, error: 'unauthorized', message: 'invalid token' })).whoami());
    expect(e.status).toBe(401);
    expect(e.message).toMatch(/machine join/);
    expect(e.message).not.toContain('SECRET-TOKEN');
  });

  it('whoami refuses scopes that are neither null nor a list of strings', async () => {
    const e = await failure(clientWith(() => json(200, { success: true, scopes: 'machine' })).whoami());
    expect(e.message).toMatch(/unexpected answer to whoami \(scopes\)/);
  });

  it('works against the fake relay: version is public, whoami shows the scopes of each kind of token', async () => {
    const relay = await startFakeRelay();
    try {
      expect((await createRelayClient({ baseUrl: relay.url }).getVersion())?.version).toMatch(/\S/);
      expect(await createRelayClient({ baseUrl: relay.url, token: relay.token }).whoami()).toMatchObject({ scopes: ['machine'] });
      expect(await createRelayClient({ baseUrl: relay.url, token: relay.adminToken }).whoami()).toMatchObject({ scopes: null });
    } finally {
      await relay.close();
    }
  });
});
