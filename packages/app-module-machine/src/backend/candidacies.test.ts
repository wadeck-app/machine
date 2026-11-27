import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { candidacyCode, generateSigningKeyPair, newCandidacyRandom } from '@wadeck-app/machine-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { ADMIN_TOKEN_WHY, LOGIN_ADVICE, PAIRING_CLICK_PATH, RelayNotConfiguredError, RelayRequestError, listCandidacies } from './candidacies.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

const TOKEN = 'admin-token-secret-value';
const NOW = 1_800_000_000;
const UUID = '0b8a7a52-7f0d-4f0e-8a56-2f0d3a1c9e11';

let configDir: string;
let servers: Server[];

beforeEach(() => {
  configDir = makeTempDir('app-module-machine-relay-');
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  removeTempDir(configDir);
});

interface Seen { method?: string; url?: string; authorization?: string }

async function fakeRelay(answer: () => { status: number; body: unknown }): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    const out = answer();
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { url: `http://127.0.0.1:${address.port}`, seen };
}

function writeAdminConfig(relayUrl: string, token = TOKEN): void {
  mkdirSync(join(configDir, '_secrets_'), { recursive: true });
  writeFileSync(join(configDir, '_secrets_', 'relay-admin.json'), JSON.stringify({ relayUrl, token, label: 'admin console', claimedAt: '2026-11-14T00:00:00.000Z' }));
}

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { publicKey } = generateSigningKeyPair();
  return {
    id: 'cand-1',
    name: 'laptop',
    hostname: 'LAPTOP-01',
    identityPublicKey: publicKey,
    random: newCandidacyRandom(),
    uuid: UUID,
    observedIp: '203.0.113.7',
    createdAt: NOW - 90,
    expiresAt: NOW + 800,
    ...overrides,
  };
}

describe('listCandidacies', () => {
  it('asks the relay with the admin token and returns the fields of the page plus the RECOMPUTED code', async () => {
    const c = candidate({ uuidBound: true, boundTokenLabel: 'laptop token' });
    const relay = await fakeRelay(() => ({ status: 200, body: { candidacies: [c] } }));
    writeAdminConfig(relay.url);
    const views = await listCandidacies(configDir, NOW);
    expect(relay.seen[0]?.method).toBe('GET');
    expect(relay.seen[0]?.url).toBe('/api/machines/candidacies');
    expect(relay.seen[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      id: 'cand-1',
      name: 'laptop',
      hostname: 'LAPTOP-01',
      observedIp: '203.0.113.7',
      ageSeconds: 90,
      uuidBound: true,
      boundTokenLabel: 'laptop token',
      code: candidacyCode(c.identityPublicKey as string, c.random as string),
      problems: [],
    });
  });

  it('returns the status the relay states for a candidacy, and none when it states none (never a made-up "pending")', async () => {
    const relay = await fakeRelay(() => ({ status: 200, body: { candidacies: [candidate({ id: 'a', status: 'approved' }), candidate({ id: 'b' })] } }));
    writeAdminConfig(relay.url);
    const views = await listCandidacies(configDir, NOW);
    expect(views.map((v) => v.relayStatus)).toEqual(['approved', undefined]);
  });

  it('never returns the code the relay sends: a swapped code is replaced by the recomputed one and reported', async () => {
    const c = candidate({ code: 'AAAA-BBBB-CCCC-DDDD' });
    const relay = await fakeRelay(() => ({ status: 200, body: { candidacies: [c] } }));
    writeAdminConfig(relay.url);
    const [view] = await listCandidacies(configDir, NOW);
    expect(view?.code).toBe(candidacyCode(c.identityPublicKey as string, c.random as string));
    expect(JSON.stringify(view)).not.toContain('AAAA-BBBB-CCCC-DDDD');
    expect(view?.problems.join(' ')).toContain('does not match');
  });

  it('does not report a mismatch when the relay code is the same up to case and dashes', async () => {
    const base = candidate();
    const code = candidacyCode(base.identityPublicKey as string, base.random as string);
    const relay = await fakeRelay(() => ({ status: 200, body: { candidacies: [{ ...base, verificationCode: code.toLowerCase().replaceAll('-', ' ') }] } }));
    writeAdminConfig(relay.url);
    const [view] = await listCandidacies(configDir, NOW);
    expect(view?.problems).toEqual([]);
  });

  it('keeps a malformed candidacy visible with a problem and no code, never a made-up code', async () => {
    const relay = await fakeRelay(() => ({ status: 200, body: { candidacies: [candidate({ identityPublicKey: 'not-a-key' })] } }));
    writeAdminConfig(relay.url);
    const [view] = await listCandidacies(configDir, NOW);
    expect(view?.code).toBeUndefined();
    expect(view?.problems.length).toBeGreaterThan(0);
  });

  it('flags a candidacy without uuid and an expired one', async () => {
    const noUuid = candidate({ id: 'a' });
    delete noUuid.uuid;
    const expired = candidate({ id: 'b', expiresAt: NOW - 1 });
    const relay = await fakeRelay(() => ({ status: 200, body: { candidacies: [noUuid, expired] } }));
    writeAdminConfig(relay.url);
    const views = await listCandidacies(configDir, NOW);
    expect(views[0]?.problems.join(' ')).toContain('uuid');
    expect(views[1]?.problems.join(' ')).toContain('expired');
  });

  describe('dates of the relay', () => {
    // The shape of poc-node lib/machines/store.js publicCandidacy: createdAt and expiresAt are ISO 8601 strings (iso(ms)), not numbers.
    const realShape = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
      candidate({ createdAt: new Date((NOW - 90) * 1000).toISOString(), expiresAt: new Date((NOW + 810) * 1000).toISOString(), ...overrides });

    async function listOne(entry: Record<string, unknown>) {
      const relay = await fakeRelay(() => ({ status: 200, body: { candidacies: [entry] } }));
      writeAdminConfig(relay.url);
      const [view] = await listCandidacies(configDir, NOW);
      if (view === undefined) throw new Error('no candidacy listed');
      return view;
    }

    it('reads the ISO 8601 strings of the REAL relay: approvable, epoch seconds, a sensible age', async () => {
      const view = await listOne(realShape());
      expect(view.problems).toEqual([]);
      expect(view.createdAt).toBe(NOW - 90);
      expect(view.expiresAt).toBe(NOW + 810);
      expect(view.ageSeconds).toBe(90);
    });

    it('still reads epoch seconds numbers', async () => {
      const view = await listOne(candidate());
      expect(view.problems).toEqual([]);
      expect(view.createdAt).toBe(NOW - 90);
      expect(view.ageSeconds).toBe(90);
    });

    it('flags an ISO expiresAt in the past as expired', async () => {
      const view = await listOne(realShape({ expiresAt: new Date((NOW - 5) * 1000).toISOString() }));
      expect(view.problems.join(' ')).toContain('expired');
    });

    it.each([
      ['a string that is not a date', 'yesterday', 'string'],
      ['a date without time', '2026-11-20', 'string'],
      ['an ISO-looking string that does not parse', '2026-13-45T99:99:99Z', 'string'],
      ['null', null, 'null'],
      ['a boolean', true, 'boolean'],
      ['an object', { a: 1 }, 'object'],
    ])('flags %s as a problem naming the field and the type received, with no age', async (_label, value, type) => {
      const view = await listOne(realShape({ createdAt: value }));
      expect(view.createdAt).toBeUndefined();
      expect(view.ageSeconds).toBeUndefined();
      const text = view.problems.join(' ');
      expect(text).toContain('"createdAt"');
      expect(text).toContain(type);
      expect(text).not.toContain('1970');
    });

    it('flags a missing createdAt and expiresAt as "sent no"', async () => {
      const entry = realShape();
      delete entry.createdAt;
      delete entry.expiresAt;
      const view = await listOne(entry);
      expect(view.problems.join(' ')).toContain('the relay sent no "createdAt"');
      expect(view.problems.join(' ')).toContain('the relay sent no "expiresAt"');
      expect(view.ageSeconds).toBeUndefined();
    });

    it('flags NaN-like numbers (a JSON number that is not finite cannot exist; a negative one is refused)', async () => {
      const view = await listOne(realShape({ createdAt: -5 }));
      expect(view.createdAt).toBeUndefined();
      expect(view.problems.join(' ')).toContain('"createdAt"');
    });
  });

  it('shows text from the relay with printable ASCII only (no escape sequence reaches the page)', async () => {
    const relay = await fakeRelay(() => ({ status: 200, body: { candidacies: [candidate({ name: 'lap\u001b[31mtop', hostname: 'h\u0007ost' })] } }));
    writeAdminConfig(relay.url);
    const [view] = await listCandidacies(configDir, NOW);
    expect(view?.name).toBe('lap?[31mtop');
    expect(view?.hostname).toBe('h?ost');
  });

  it('reads relay-admin.json at EACH call', async () => {
    const first = await fakeRelay(() => ({ status: 200, body: { candidacies: [] } }));
    const second = await fakeRelay(() => ({ status: 200, body: { candidacies: [candidate()] } }));
    writeAdminConfig(first.url);
    expect(await listCandidacies(configDir, NOW)).toHaveLength(0);
    writeAdminConfig(second.url);
    expect(await listCandidacies(configDir, NOW)).toHaveLength(1);
  });

  it('never puts the token in a returned value', async () => {
    const relay = await fakeRelay(() => ({ status: 200, body: { candidacies: [candidate()] } }));
    writeAdminConfig(relay.url);
    expect(JSON.stringify(await listCandidacies(configDir, NOW))).not.toContain(TOKEN);
  });

  it('says how to log in as admin when relay-admin.json is missing', async () => {
    const error = await listCandidacies(configDir, NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayNotConfiguredError);
    expect((error as Error).message).toContain('machine admin login');
    expect((error as Error).message).toContain('relay-admin.json');
  });

  it('names the file when relay-admin.json is corrupt, without printing its content', async () => {
    mkdirSync(join(configDir, '_secrets_'), { recursive: true });
    writeFileSync(join(configDir, '_secrets_', 'relay-admin.json'), `{"token":"${TOKEN}"`);
    const error = await listCandidacies(configDir, NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayNotConfiguredError);
    expect((error as Error).message).toContain('relay-admin.json');
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it('refuses a plain http relay that is not on loopback, before sending the token', async () => {
    writeAdminConfig('http://relay.example.com');
    const error = await listCandidacies(configDir, NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayNotConfiguredError);
    expect((error as Error).message).toContain('https');
  });

  it('refuses http://localhost (a name is resolved by the system) and says to use 127.0.0.1, before sending the token', async () => {
    writeAdminConfig('http://localhost:8080');
    let called = false;
    const spy = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
    const error = await listCandidacies(configDir, NOW, spy).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayNotConfiguredError);
    expect((error as Error).message).toContain('http://127.0.0.1:<port>');
    expect(called).toBe(false);
  });

  it('accepts plain http on the literal [::1]', async () => {
    writeAdminConfig('http://[::1]:8080');
    let url = '';
    const ok = (async (u: string) => { url = u; return new Response(JSON.stringify({ candidacies: [] }), { status: 200 }); }) as unknown as typeof fetch;
    expect(await listCandidacies(configDir, NOW, ok)).toEqual([]);
    expect(url).toBe('http://[::1]:8080/api/machines/candidacies');
  });

  it('refuses to run under NODE_TLS_REJECT_UNAUTHORIZED=0, naming the variable and the fix, and sends nothing', async () => {
    writeAdminConfig('https://relay.example.com');
    let called = false;
    const spy = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
    const error = await listCandidacies(configDir, NOW, spy, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayNotConfiguredError);
    expect((error as Error).message).toContain('NODE_TLS_REJECT_UNAUTHORIZED');
    expect((error as Error).message).toContain('disables certificate validation for the whole process');
    expect((error as Error).message).toMatch(/unset/i);
    expect((error as Error).message).not.toContain(TOKEN);
    expect(called).toBe(false);
  });

  it('turns a 401 into advice to log in again, with no token in the message', async () => {
    const relay = await fakeRelay(() => ({ status: 401, body: { error: 'invalid_token', message: 'nope' } }));
    writeAdminConfig(relay.url);
    const error = await listCandidacies(configDir, NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayRequestError);
    expect((error as RelayRequestError).status).toBe(401);
    expect((error as Error).message).toContain('machine admin login');
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it('turns a relay 500 into an error carrying the status', async () => {
    const relay = await fakeRelay(() => ({ status: 500, body: { error: 'boom' } }));
    writeAdminConfig(relay.url);
    const error = await listCandidacies(configDir, NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayRequestError);
    expect((error as Error).message).toContain('500');
  });

  it('says the relay is unreachable when it does not answer, with no token in the message', async () => {
    const relay = await fakeRelay(() => ({ status: 200, body: {} }));
    const dead = relay.url;
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    servers = [];
    writeAdminConfig(dead);
    const error = await listCandidacies(configDir, NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayRequestError);
    expect((error as Error).message).toContain('unreachable');
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it('refuses an answer that is not a candidacy list instead of showing an empty list', async () => {
    const relay = await fakeRelay(() => ({ status: 200, body: { something: 'else' } }));
    writeAdminConfig(relay.url);
    const error = await listCandidacies(configDir, NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayRequestError);
    expect((error as Error).message).toContain('candidacies');
  });
});

describe('listCandidacies binding (deployed ownership-at-approval contract)', () => {
  const list = async (overrides: Record<string, unknown>) => {
    const relay = await fakeRelay(() => ({ status: 200, body: { candidacies: [candidate(overrides)] } }));
    writeAdminConfig(relay.url);
    const [view] = await listCandidacies(configDir, NOW);
    if (view === undefined) throw new Error('no view');
    return view;
  };

  it('is a rebind only when the uuid is bound to ANOTHER token, and returns the relay fields', async () => {
    const view = await list({ uuidBound: true, boundToCandidateToken: false, boundTokenLabel: '(revoked token)' });
    expect(view).toMatchObject({ uuidBound: true, boundToCandidateToken: false, boundTokenLabel: '(revoked token)', rebind: true, problems: [] });
  });

  it('is not a rebind when the uuid is bound to the token of the candidacy (re-approval)', async () => {
    const view = await list({ uuidBound: true, boundToCandidateToken: true, boundTokenLabel: 'same' });
    expect(view).toMatchObject({ boundToCandidateToken: true, rebind: false, problems: [] });
  });

  it('is not a rebind when the uuid is not bound', async () => {
    const view = await list({ uuidBound: false });
    expect(view).toMatchObject({ uuidBound: false, rebind: false });
  });

  it('reads a missing boundToCandidateToken as a rebind and says so', async () => {
    const view = await list({ uuidBound: true });
    expect(view.rebind).toBe(true);
    expect(view.boundToCandidateToken).toBeUndefined();
    expect(view.bindingNote).toContain('did not say');
  });

  it('reads a non-boolean boundToCandidateToken as a rebind and reports a problem', async () => {
    const view = await list({ uuidBound: true, boundToCandidateToken: 'yes' });
    expect(view.rebind).toBe(true);
    expect(view.boundToCandidateToken).toBeUndefined();
    expect(view.problems.join(' ')).toContain('boundToCandidateToken');
  });
});

describe('403 for a token that cannot do the admin calls', () => {
  it.each(['full_access_required', 'scope_denied'])('%s: says the saved token is a plain machine token, with the login advice and no token', async (code) => {
    const relay = await fakeRelay(() => ({ status: 403, body: { success: false, error: code, message: 'needs more' } }));
    writeAdminConfig(relay.url);
    const e = await listCandidacies(configDir, NOW).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(RelayRequestError);
    expect((e as RelayRequestError).message).toMatch(/plain machine token/);
    expect((e as RelayRequestError).message).toContain('machine admin login --force');
    expect((e as RelayRequestError).message).not.toContain(TOKEN);
  });
});

describe('403 of the real scope gate (free text, no code)', () => {
  it('is read as a plain machine token: the login advice, the relay text is not the only thing said', async () => {
    const text = 'This token is limited to the scope machine and cannot call GET /api/machines/candidacies: that endpoint needs a full-access token.';
    const relay = await fakeRelay(() => ({ status: 403, body: { success: false, error: text } }));
    writeAdminConfig(relay.url);
    const e = await listCandidacies(configDir, NOW).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(RelayRequestError);
    expect((e as RelayRequestError).message).toMatch(/plain machine token/);
    expect((e as RelayRequestError).message).toContain('machine admin login --force');
    expect((e as RelayRequestError).message).not.toContain(TOKEN);
  });
});

// The advice sentences are copied here and in machine-cli adminAccess.ts (the two packages do not import each other): the click path and the
// login advice must not drift apart. The test reads the real module of machine-cli.
describe('the advice sentences stay in step with machine-cli adminAccess.ts', () => {
  it('ADMIN_TOKEN_WHY, PAIRING_CLICK_PATH and the login advice (with --force) are the same text', async () => {
    const path = join(import.meta.dirname, '..', '..', '..', 'machine-cli', 'src', 'adminAccess.ts');
    const cli = (await import(/* @vite-ignore */ pathToFileURL(path).href)) as {
      ADMIN_TOKEN_WHY: string;
      PAIRING_CLICK_PATH: string;
      adminLoginFix: (o: { force?: boolean }) => string;
    };
    expect(ADMIN_TOKEN_WHY).toBe(cli.ADMIN_TOKEN_WHY);
    expect(PAIRING_CLICK_PATH).toBe(cli.PAIRING_CLICK_PATH);
    expect(LOGIN_ADVICE).toBe(cli.adminLoginFix({ force: true }));
  });
});
