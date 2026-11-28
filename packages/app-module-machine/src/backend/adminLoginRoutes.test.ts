import { createServer, type Server } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import register from './index.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

// The relay login started from the page (admin-ui.md, "A failed source: three cases"): the Candidacies page offers a button instead of the command `machine admin login`.
// The routes only carry the daemon commands adminLoginStart / adminLoginStatus / adminLoginCancel. The start spends nothing but makes the daemon contact the relay and
// create a pending request the admin must confirm in the relay console: `sensitive` (the app-core PIN) plus the module header, like every route that makes the machine act.

const DAEMON_TOKEN = 'daemon-health-token-value';
const HEADER = { 'x-machine-module': '1' };

type Handler = (req: unknown, reply: Reply) => unknown;
interface Reply { code(status: number): Reply; send(body: unknown): unknown }
interface Registered { handler: Handler; options: unknown }

let configDir: string;
let servers: Server[];
let previous: string | undefined;

beforeEach(() => {
  configDir = makeTempDir('app-module-machine-adminlogin-');
  servers = [];
  previous = process.env['MACHINE_CONFIG_DIR'];
  process.env['MACHINE_CONFIG_DIR'] = configDir;
});
afterEach(async () => {
  if (previous === undefined) delete process.env['MACHINE_CONFIG_DIR'];
  else process.env['MACHINE_CONFIG_DIR'] = previous;
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  removeTempDir(configDir);
});

function routes(): Map<string, Registered> {
  const map = new Map<string, Registered>();
  register({ registerRoute: (method: string, path: string, handler: Handler, options?: unknown) => { map.set(`${method} ${path}`, { handler, options }); } } as never);
  return map;
}

async function call(route: string, req: { headers?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const found = routes().get(route);
  if (found === undefined) throw new Error(`route not registered: ${route}`);
  let status = 200;
  let sent: unknown;
  const reply: Reply = { code(s) { status = s; return reply; }, send(b) { sent = b; return b; } };
  await found.handler({ headers: req.headers ?? {}, params: {}, query: {}, body: req.body }, reply);
  return { status, body: sent };
}

async function withDaemon(answers: Record<string, unknown>): Promise<Array<{ command: string; body: unknown }>> {
  const seen: Array<{ command: string; body: unknown }> = [];
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (c: Buffer) => { text += c.toString(); });
    req.on('end', () => {
      const command = (req.url ?? '').slice(1);
      seen.push({ command, body: text === '' ? undefined : JSON.parse(text) });
      const known = req.headers.authorization === `Bearer ${DAEMON_TOKEN}` && command in answers;
      res.writeHead(known ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(known ? { result: answers[command] } : { error: `Unknown command: ${command}` }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  writeFileSync(join(configDir, 'daemon.port.json'), JSON.stringify({ pid: process.pid, port: address.port, peerPort: 1 }));
  writeFileSync(join(configDir, 'health_token'), DAEMON_TOKEN);
  return seen;
}

const WAITING = { ok: true, state: 'waiting', userCode: 'ADMN-7K42', verificationUrl: 'https://relay.example.net/console', label: 'desk admin', relayUrl: 'https://relay.example.net', expiresAt: 1_800_000_300, consoleHint: 'compare' };

describe('POST /admin-login (start)', () => {
  it('is sensitive (the app-core PIN) and needs the module header', async () => {
    expect(routes().get('POST /admin-login')?.options).toEqual({ effect: 'sensitive' });
    const seen = await withDaemon({ adminLoginStart: WAITING });
    const out = await call('POST /admin-login', {});
    expect(out.status).toBe(403);
    expect(out.body.kind).toBe('module_header');
    expect(seen).toEqual([]);
  });

  it('asks the daemon command adminLoginStart with NO payload (nothing of the request reaches it) and answers what the page shows', async () => {
    const seen = await withDaemon({ adminLoginStart: WAITING });
    const out = await call('POST /admin-login', { headers: HEADER, body: { relay: 'https://evil.example', token: 'TOP-SECRET-VALUE' } });
    expect(out).toEqual({ status: 200, body: WAITING });
    expect(seen).toEqual([{ command: 'adminLoginStart', body: undefined }]);
  });

  it.each([
    ['already-configured', 409],
    ['token-file-invalid', 409],
    ['no-relay', 409],
    ['relay-error', 502],
    ['relay-unsupported', 502],
  ])('the refusal %s is HTTP %i and keeps the daemon sentence (cause and fix)', async (reason, status) => {
    await withDaemon({ adminLoginStart: { ok: false, reason, message: `why ${reason}` } });
    const out = await call('POST /admin-login', { headers: HEADER });
    expect(out.status).toBe(status);
    expect(out.body).toMatchObject({ status, kind: reason, error: `why ${reason}`, message: `why ${reason}` });
  });

  it('an older daemon (unknown command) says to update it, never a silent failure', async () => {
    await withDaemon({});
    const out = await call('POST /admin-login', { headers: HEADER });
    expect(out.status).toBe(502);
    expect(out.body.error).toMatch(/older than this module.*machine cli update/);
  });
});

describe('GET /admin-login (status)', () => {
  it('is a plain read route (the code is not a secret, the page polls it) and answers the daemon state', async () => {
    expect(routes().get('GET /admin-login')?.options).toBeUndefined();
    const seen = await withDaemon({ adminLoginStatus: WAITING });
    const out = await call('GET /admin-login');
    expect(out).toEqual({ status: 200, body: WAITING });
    expect(seen).toEqual([{ command: 'adminLoginStatus', body: undefined }]);
  });

  it('the daemon down is the usual 503 with its fix', async () => {
    const out = await call('GET /admin-login');
    expect(out.status).toBe(503);
    expect(out.body.kind).toBe('daemon_unreachable');
  });
});

describe('POST /admin-login/cancel', () => {
  it('is sensitive plus the module header, and stops the wait through the daemon', async () => {
    expect(routes().get('POST /admin-login/cancel')?.options).toEqual({ effect: 'sensitive' });
    const seen = await withDaemon({ adminLoginCancel: { ok: true, state: 'idle' } });
    expect((await call('POST /admin-login/cancel', {})).status).toBe(403);
    const out = await call('POST /admin-login/cancel', { headers: HEADER });
    expect(out).toEqual({ status: 200, body: { ok: true, state: 'idle' } });
    expect(seen).toEqual([{ command: 'adminLoginCancel', body: undefined }]);
  });
});
