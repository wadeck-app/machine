import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateSigningKeyPair, newCandidacyRandom } from '@wadeck-app/machine-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import register from './index.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

const DAEMON_TOKEN = 'daemon-health-token-value';
const ADMIN_TOKEN = 'admin-token-secret-value';
const UUID = '0b8a7a52-7f0d-4f0e-8a56-2f0d3a1c9e11';

type Handler = (req: unknown, reply: Reply) => unknown;
interface Reply { code(status: number): Reply; send(body: unknown): unknown }
interface Sent { status: number; body: any }

let configDir: string;
let servers: Server[];
let previousConfigDir: string | undefined;

beforeEach(() => {
  configDir = makeTempDir('app-module-machine-routes-');
  servers = [];
  previousConfigDir = process.env['MACHINE_CONFIG_DIR'];
  process.env['MACHINE_CONFIG_DIR'] = configDir;
});

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env['MACHINE_CONFIG_DIR'];
  else process.env['MACHINE_CONFIG_DIR'] = previousConfigDir;
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  removeTempDir(configDir);
});

function routes(): Map<string, Handler> {
  const map = new Map<string, Handler>();
  register({ registerRoute: (method: string, path: string, handler: Handler) => { map.set(`${method} ${path}`, handler); } } as never);
  return map;
}

async function call(map: Map<string, Handler>, key: string, headers: Record<string, string> = {}): Promise<Sent> {
  const handler = map.get(key);
  if (handler === undefined) throw new Error(`route not registered: ${key}`);
  let status = 200;
  let sent: unknown;
  const reply: Reply = { code(s) { status = s; return reply; }, send(b) { sent = b; return b; } };
  await handler({ headers, params: {}, query: {} }, reply);
  return { status, body: sent };
}

async function listen(handler: (url: string, auth: string | undefined) => { status: number; body: unknown }): Promise<number> {
  const server = createServer((req, res) => {
    const out = handler(req.url ?? '', req.headers.authorization);
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

async function withDaemon(answers: Record<string, unknown>): Promise<void> {
  const port = await listen((url, auth) => {
    if (auth !== `Bearer ${DAEMON_TOKEN}`) return { status: 401, body: { error: 'Unauthorized' } };
    const name = url.slice(1);
    return name in answers ? { status: 200, body: { result: answers[name] } } : { status: 404, body: { error: 'Unknown command' } };
  });
  writeFileSync(join(configDir, 'daemon.port.json'), JSON.stringify({ pid: process.pid, port, peerPort: 1 }));
  writeFileSync(join(configDir, 'health_token'), DAEMON_TOKEN);
}

async function withRelay(candidacies: unknown[]): Promise<string> {
  const port = await listen((_url, auth) => (auth === `Bearer ${ADMIN_TOKEN}` ? { status: 200, body: { candidacies } } : { status: 401, body: { error: 'invalid_token' } }));
  mkdirSync(join(configDir, '_secrets_'), { recursive: true });
  writeFileSync(join(configDir, '_secrets_', 'relay-admin.json'), JSON.stringify({ relayUrl: `http://127.0.0.1:${port}`, token: ADMIN_TOKEN, label: 'console', claimedAt: 'x' }));
  return `http://127.0.0.1:${port}`;
}

describe('route registration', () => {
  it('registers exactly the three read-only GET routes of this slice', () => {
    expect([...routes().keys()].sort()).toEqual(['GET /candidacies', 'GET /machines', 'GET /status']);
  });
});

describe('GET /status', () => {
  it('answers the status of the local daemon', async () => {
    const status = { initialized: true, uuid: UUID, name: 'alpha', version: '1', enrolled: true, peers: 2, problems: [], configDir };
    await withDaemon({ status });
    const out = await call(routes(), 'GET /status');
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ initialized: true, name: 'alpha', peers: 2 });
  });

  it('answers 503 with an actionable error body when the daemon is not reachable, never an empty 200', async () => {
    const out = await call(routes(), 'GET /status');
    expect(out.status).toBe(503);
    expect(out.body.error).toContain('daemon.port.json');
    expect(out.body.kind).toBe('daemon_unreachable');
  });

  it('answers 502 and a distinct kind when the daemon refuses the token', async () => {
    await withDaemon({ status: {} });
    writeFileSync(join(configDir, 'health_token'), 'a-wrong-token');
    const out = await call(routes(), 'GET /status');
    expect(out.status).toBe(502);
    expect(out.body.kind).toBe('daemon_token_refused');
    expect(JSON.stringify(out.body)).not.toContain('a-wrong-token');
  });

  it('answers 409 with the message of the daemon when this machine has no identity', async () => {
    await withDaemon({ status: { initialized: false, message: 'this machine has no identity yet: run `machine init --name <name>` first' } });
    const out = await call(routes(), 'GET /status');
    expect(out.status).toBe(409);
    expect(out.body.error).toContain('machine init');
    expect(out.body.kind).toBe('not_initialized');
  });

  it('reads the daemon port file at each request', async () => {
    await withDaemon({ status: { initialized: true, name: 'one' } });
    const map = routes();
    expect((await call(map, 'GET /status')).body.name).toBe('one');
    await withDaemon({ status: { initialized: true, name: 'two' } });
    expect((await call(map, 'GET /status')).body.name).toBe('two');
  });
});

describe('GET /machines', () => {
  it('lists this machine and its peers as flat rows for the page, with the honest presence gap', async () => {
    await withDaemon({
      list: {
        initialized: true,
        enrolled: true,
        self: { uuid: UUID, name: 'alpha' },
        peers: [{ uuid: '11111111-1111-4111-8111-111111111111', name: 'beta', aliases: ['b', 'bee'] }],
      },
    });
    const out = await call(routes(), 'GET /machines');
    expect(out.status).toBe(200);
    expect(out.body.machines).toEqual([
      { uuid: UUID, name: 'alpha', self: true, role: 'this machine', aliasesText: '' },
      { uuid: '11111111-1111-4111-8111-111111111111', name: 'beta', self: false, role: 'peer', aliasesText: 'b, bee' },
    ]);
    expect(out.body.enrolled).toBe(true);
    expect(out.body.count).toBe(2);
    // The daemon list carries no presence or address: the answer says so instead of leaving the page to guess.
    expect(out.body.presenceNote).toContain('not shown');
  });

  it('passes the note of an unenrolled daemon along', async () => {
    await withDaemon({ list: { initialized: true, enrolled: false, self: { uuid: UUID, name: 'alpha' }, peers: [], note: 'not enrolled: pin the admin key' } });
    const out = await call(routes(), 'GET /machines');
    expect(out.body.note).toBe('not enrolled: pin the admin key');
  });

  it('answers 503 when the daemon is down', async () => {
    const out = await call(routes(), 'GET /machines');
    expect(out.status).toBe(503);
    expect(out.body.kind).toBe('daemon_unreachable');
  });
});

describe('GET /candidacies', () => {
  function pending(): Record<string, unknown> {
    return { id: 'c1', name: 'laptop', hostname: 'H', identityPublicKey: generateSigningKeyPair().publicKey, random: newCandidacyRandom(), uuid: UUID, observedIp: '198.51.100.2', createdAt: Math.floor(Date.now() / 1000) - 30, expiresAt: Math.floor(Date.now() / 1000) + 600 };
  }

  it('lists the candidacies with the count the tab indicator reads', async () => {
    await withRelay([pending(), { ...pending(), id: 'c2' }]);
    const out = await call(routes(), 'GET /candidacies');
    expect(out.status).toBe(200);
    expect(out.body.count).toBe(2);
    expect(out.body.candidacies.map((c: { id: string }) => c.id)).toEqual(['c1', 'c2']);
    expect(out.body.candidacies[0].code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  });

  it('adds flat display fields for the page (age text, binding warning text, problems text)', async () => {
    await withRelay([{ ...pending(), uuidBound: true, boundToCandidateToken: false, boundTokenLabel: 'old laptop' }]);
    const out = await call(routes(), 'GET /candidacies');
    const row = out.body.candidacies[0];
    expect(row.ageText).toMatch(/s$/);
    expect(row.bindingText).toContain('old laptop');
    expect(row.statusText).toContain('bound');
  });

  it('returns the binding fields and shows no rebind warning for a re-approval (bound to the token of the candidacy)', async () => {
    await withRelay([{ ...pending(), uuidBound: true, boundToCandidateToken: true, boundTokenLabel: 'same laptop' }]);
    const out = await call(routes(), 'GET /candidacies');
    const row = out.body.candidacies[0];
    expect(row).toMatchObject({ uuidBound: true, boundToCandidateToken: true, boundTokenLabel: 'same laptop', rebind: false });
    expect(row.bindingText).toContain('re-approval');
    expect(row.statusText).toBe('Pending');
  });

  it('warns of a rebind when the uuid is bound to another token or the relay does not say', async () => {
    await withRelay([{ ...pending(), uuidBound: true, boundToCandidateToken: false, boundTokenLabel: '(revoked token)' }, { ...pending(), id: 'c2', uuidBound: true }]);
    const out = await call(routes(), 'GET /candidacies');
    const [a, b] = out.body.candidacies;
    expect(a.rebind).toBe(true);
    expect(a.bindingText).toContain('(revoked token)');
    expect(a.statusText).toContain('bound');
    expect(b.rebind).toBe(true);
    expect(b.bindingText).toContain('did not say');
  });

  it('never carries the admin token in the answer', async () => {
    await withRelay([pending()]);
    const out = await call(routes(), 'GET /candidacies');
    expect(JSON.stringify(out.body)).not.toContain(ADMIN_TOKEN);
  });

  it('answers 503 and how to log in when there is no admin token', async () => {
    const out = await call(routes(), 'GET /candidacies');
    expect(out.status).toBe(503);
    expect(out.body.kind).toBe('relay_not_configured');
    expect(out.body.error).toContain('machine admin login');
  });

  it('answers 502 when the relay refuses the token', async () => {
    const relayUrl = await withRelay([]);
    writeFileSync(join(configDir, '_secrets_', 'relay-admin.json'), JSON.stringify({ relayUrl, token: 'revoked-token', label: 'x', claimedAt: 'x' }));
    const out = await call(routes(), 'GET /candidacies');
    expect(out.status).toBe(502);
    expect(out.body.kind).toBe('relay_error');
    expect(JSON.stringify(out.body)).not.toContain('revoked-token');
  });
});

describe('local API guard (documented limit)', () => {
  it('read-only routes answer without the x-machine-module header: DSL sources and the tab count cannot send custom headers; the guard is for the routes that sign or spend the token', async () => {
    await withDaemon({ status: { initialized: true, name: 'alpha' } });
    const out = await call(routes(), 'GET /status', {});
    expect(out.status).toBe(200);
  });
});
