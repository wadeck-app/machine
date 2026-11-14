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
