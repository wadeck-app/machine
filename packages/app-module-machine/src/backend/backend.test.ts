import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateSigningKeyPair, newCandidacyRandom } from '@wadeck-app/machine-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ageText } from './candidacies.js';
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
  it('registers the seven read-only GET routes (the Activity page, run-log; the Allowed page, decision 104), the Deny post and the sensitive ones (remote requests list, decision 74; admin key file, allow context and allow post, decision 76)', () => {
    expect([...routes().keys()].sort()).toEqual(['GET /activity', 'GET /admin-key', 'GET /allow/:machine', 'GET /allowed', 'GET /approve-context/:uuid', 'GET /candidacies', 'GET /health', 'GET /hold-progress/:machine/:id', 'GET /machines', 'GET /requests', 'GET /status', 'POST /allow', 'POST /candidacies/:id/approve', 'POST /candidacies/:id/reject', 'POST /deny', 'POST /dismiss-notice', 'POST /requests/remote']);
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
      { uuid: UUID, name: 'alpha', self: true, role: 'this machine', aliasesText: '', reachableState: 'self', reachable: 'this machine' },
      { uuid: '11111111-1111-4111-8111-111111111111', name: 'beta', self: false, role: 'peer', aliasesText: 'b, bee', reachableState: 'unknown', reachable: 'unknown' },
    ]);
    expect(out.body.enrolled).toBe(true);
    expect(out.body.count).toBe(2);
    // The daemon list carries no presence or address: the answer says so instead of leaving the page to guess.
    expect(out.body.presenceNote).toContain('not shown');
  });

  it('adds who receives request notices and which machine holds the list, from the daemon noticeHolders', async () => {
    const BETA = '11111111-1111-4111-8111-111111111111';
    await withDaemon({
      list: { initialized: true, enrolled: true, self: { uuid: UUID, name: 'alpha' }, peers: [{ uuid: BETA, name: 'beta', aliases: [] }] },
      noticeHolders: {
        initialized: true,
        admin: true,
        listKnown: true,
        serial: 42,
        recipients: [{ uuid: UUID, name: 'alpha (this machine)' }],
        holders: [{ uuid: BETA, name: 'beta', state: 'sent', text: 'sent 2026-11-21T10:00:00.000Z, not confirmed' }],
      },
    });
    const out = await call(routes(), 'GET /machines');
    expect(out.status).toBe(200);
    expect(out.body.machines).toEqual([
      { uuid: UUID, name: 'alpha', self: true, role: 'this machine', aliasesText: '', receivesNotices: 'yes', listHeldText: '', reachableState: 'self', reachable: 'this machine' },
      { uuid: BETA, name: 'beta', self: false, role: 'peer', aliasesText: '', receivesNotices: 'no', listHeldText: 'sent 2026-11-21T10:00:00.000Z, not confirmed', reachableState: 'unknown', reachable: 'unknown' },
    ]);
    expect(out.body.noticesText).toBe('Request notices go to alpha (this machine) (list serial 42).');
    expect(out.body.noticesNote).toBeUndefined();
  });

  it('adds whether each peer is reachable DIRECTLY now (decision 86), in the words of the CLI, and says the same of this machine as itself', async () => {
    const BETA = '11111111-1111-4111-8111-111111111111';
    const GAMMA = '22222222-2222-4222-8222-222222222222';
    await withDaemon({
      list: { initialized: true, enrolled: true, self: { uuid: UUID, name: 'alpha' }, peers: [{ uuid: BETA, name: 'beta', aliases: [] }, { uuid: GAMMA, name: 'gamma', aliases: [] }] },
      reachability: {
        initialized: true,
        intervalSeconds: 30,
        machines: [
          { uuid: BETA, name: 'beta', state: 'direct', ms: 12, checkedAt: 100, text: 'direct now (12 ms, checked 8 s ago)' },
          { uuid: GAMMA, name: 'gamma', state: 'not-direct', checkedAt: 100, text: 'not reachable directly (last seen 2 h ago; relay inbox only)' },
        ],
      },
    });
    const out = await call(routes(), 'GET /machines');
    expect(out.status).toBe(200);
    const byName = Object.fromEntries((out.body.machines as Array<{ name: string }>).map((m) => [m.name, m]));
    expect(byName['alpha']).toMatchObject({ reachableState: 'self', reachable: 'this machine' });
    expect(byName['beta']).toMatchObject({ reachableState: 'direct', reachable: 'direct now (12 ms, checked 8 s ago)' });
    expect(byName['gamma']).toMatchObject({ reachableState: 'not-direct', reachable: 'not reachable directly (last seen 2 h ago; relay inbox only)' });
    expect(out.body.reachableNote).toBeUndefined();
  });

  it('says why when the daemon does not know reachability (an older daemon): a note with the fix, the column stays unknown', async () => {
    await withDaemon({ list: { initialized: true, enrolled: true, self: { uuid: UUID, name: 'alpha' }, peers: [{ uuid: '11111111-1111-4111-8111-111111111111', name: 'beta', aliases: [] }] } });
    const out = await call(routes(), 'GET /machines');
    expect(out.body.reachableNote).toMatch(/older than this module.*machine cli update/s);
    expect(out.body.machines[1]).toMatchObject({ reachableState: 'unknown', reachable: 'unknown' });
  });

  it('says why when the daemon cannot tell (older daemon, or no list yet), instead of leaving the columns empty', async () => {
    await withDaemon({ list: { initialized: true, enrolled: true, self: { uuid: UUID, name: 'alpha' }, peers: [] } });
    const older = await call(routes(), 'GET /machines');
    expect(older.status).toBe(200);
    expect(older.body.noticesNote).toMatch(/older than this module/);
    expect(older.body.noticesNote).toMatch(/machine cli update/);
    expect(older.body.machines[0]).not.toHaveProperty('receivesNotices');
  });

  it('passes the note of a daemon that holds no list yet along', async () => {
    await withDaemon({
      list: { initialized: true, enrolled: true, self: { uuid: UUID, name: 'alpha' }, peers: [] },
      noticeHolders: { initialized: true, admin: true, listKnown: false, recipients: [], holders: [], note: 'no list of request-notice recipients is signed here yet: run `machine admin notify-to <machine>...`' },
    });
    const out = await call(routes(), 'GET /machines');
    expect(out.body.noticesNote).toMatch(/machine admin notify-to/);
    expect(out.body.machines[0]).toMatchObject({ receivesNotices: 'no' });
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

  it('canDecide (the Reject button) is true only for a pending, unexpired candidacy with a usable id', async () => {
    const now = Math.floor(Date.now() / 1000);
    await withRelay([pending(), { ...pending(), id: 'c2', status: 'approved' }, { ...pending(), id: 'c3', expiresAt: now - 5 }, { ...pending(), id: 'c4', status: 'rejected' }]);
    const rows = (await call(routes(), 'GET /candidacies')).body.candidacies;
    expect(rows.map((r: { id: string; canDecide: boolean }) => [r.id, r.canDecide])).toEqual([['c1', true], ['c2', false], ['c3', false], ['c4', false]]);
  });

  it('the row expansion says what the page can do (Reject) and what stays in the CLI (approve), never "read-only"', async () => {
    await withRelay([pending()]);
    const row = (await call(routes(), 'GET /candidacies')).body.candidacies[0];
    expect(row.bindingText).toContain('Reject');
    expect(row.bindingText).toContain('machine admin approve');
    expect(row.bindingText).not.toMatch(/read-only/i);
  });

  it('answers the timeline of the oldest pending candidacy, with one source for the step texts', async () => {
    await withRelay([{ ...pending(), id: 'new', name: 'newer', createdAt: Math.floor(Date.now() / 1000) - 10 }, { ...pending(), id: 'old', name: 'older', createdAt: Math.floor(Date.now() / 1000) - 300 }]);
    const out = await call(routes(), 'GET /candidacies');
    const byId = Object.fromEntries(out.body.timeline.map((s: { id: string; status: string }) => [s.id, s.status]));
    expect(byId).toEqual({ received: 'done', checked: 'current', signed: 'todo', 'final-code': 'todo', distributed: 'todo' });
    expect(out.body.timelineNote).toContain('older');
  });

  it('answers a timeline with every step to do, and no note, when there is no candidacy', async () => {
    await withRelay([]);
    const out = await call(routes(), 'GET /candidacies');
    expect(out.body.timeline.map((s: { status: string }) => s.status)).toEqual(['todo', 'todo', 'todo', 'todo', 'todo']);
    expect(out.body.timelineNote).toBe('');
  });

  it('shows the status the relay states instead of "Pending" for an approved candidacy', async () => {
    await withRelay([{ ...pending(), status: 'approved' }]);
    const out = await call(routes(), 'GET /candidacies');
    expect(out.body.candidacies[0].statusText).toBe('Approved by the admin (relay status: approved)');
    expect(out.body.timeline.find((s: { id: string }) => s.id === 'signed').status).toBe('done');
  });

  it('gives a plain pending candidacy useful details in the row expansion (never empty)', async () => {
    await withRelay([{ ...pending(), hostname: 'MACBOOK-PRO', observedIp: '198.51.100.2', uuidBound: false }]);
    const row = (await call(routes(), 'GET /candidacies')).body.candidacies[0];
    expect(row.bindingText).not.toBe('');
    for (const part of ['laptop', 'MACBOOK-PRO', UUID, '198.51.100.2', 'not bound yet', 'machine admin approve']) expect(row.bindingText).toContain(part);
    expect(row.bindingText).toMatch(/expires in \d+ min/);
    // Decision 55: the candidacy code is not displayed
    expect(row.bindingText).not.toContain(row.code);
  });

  it('does not claim the uuid is unbound when the relay did not say', async () => {
    await withRelay([pending()]);
    const row = (await call(routes(), 'GET /candidacies')).body.candidacies[0];
    expect(row.bindingText).toContain('The relay did not say whether the uuid is already bound');
    expect(row.bindingText).not.toContain('not bound yet');
  });

  it('keeps the rebind warning in the details of a rebind, next to the plain details', async () => {
    await withRelay([{ ...pending(), uuidBound: true, boundToCandidateToken: false, boundTokenLabel: 'old laptop' }]);
    const row = (await call(routes(), 'GET /candidacies')).body.candidacies[0];
    expect(row.bindingText).toContain('old laptop');
    expect(row.bindingText).toContain('machine admin approve');
    expect(row.bindingText).not.toContain('not bound yet');
  });

  it('says what the relay did not send instead of leaving a blank (no uuid, no expiry)', async () => {
    await withRelay([{ ...pending(), uuid: undefined, expiresAt: undefined }]);
    const row = (await call(routes(), 'GET /candidacies')).body.candidacies[0];
    expect(row.bindingText).toContain('uuid: unknown');
    expect(row.bindingText).toContain('expires: unknown');
  });

  it('adds flat display fields for the page (age text, binding warning text, problems text)', async () => {
    await withRelay([{ ...pending(), uuidBound: true, boundToCandidateToken: false, boundTokenLabel: 'old laptop' }]);
    const out = await call(routes(), 'GET /candidacies');
    const row = out.body.candidacies[0];
    expect(row.ageText).toMatch(/s$/);
    expect(row.bindingText).toContain('old laptop');
    expect(row.statusText).toContain('bound');
  });

  it('shows the age of a candidacy dated with the ISO strings of the real relay, and never a number of minutes since 1970', async () => {
    const now = Date.now();
    await withRelay([{ ...pending(), createdAt: new Date(now - 3 * 60_000).toISOString(), expiresAt: new Date(now + 12 * 60_000).toISOString() }]);
    const row = (await call(routes(), 'GET /candidacies')).body.candidacies[0];
    expect(row.ageText).toBe('3 min');
    expect(row.statusText).toBe('Pending');
  });

  it('says "unknown" for the age and keeps the problem when the date of the relay is unusable', async () => {
    await withRelay([{ ...pending(), createdAt: 'yesterday' }]);
    const row = (await call(routes(), 'GET /candidacies')).body.candidacies[0];
    expect(row.ageText).toBe('unknown');
    expect(row.statusText).toContain('Cannot be approved');
    expect(row.statusText).toContain('"createdAt"');
  });

  it.each([
    [2, 'now'],
    [45, '45 s'],
    [119, '119 s'],
    [600, '10 min'],
    [3 * 3600, '3 h'],
    [3 * 86_400, '3 days'],
  ])('formats an age of %i s as "%s" (wording of machine-cli humanTime)', async (seconds, text) => {
    expect(ageText(seconds)).toBe(text);
  });

  it('formats no age as "unknown"', () => {
    expect(ageText(undefined)).toBe('unknown');
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
