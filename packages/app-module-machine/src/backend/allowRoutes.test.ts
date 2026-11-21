import { createServer, type Server } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import register from './index.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

// The routes behind the Allow button of the Requests page (decision 76): the encrypted admin key file, the context of a policy edit, and the
// signed result. The browser holds the passphrase and the unlocked key; these routes only carry what is encrypted or already signed.

const DAEMON_TOKEN = 'daemon-health-token-value';
const SELF = '22222222-2222-4222-8222-222222222222';
const HEADER = { 'x-machine-module': '1' };

type Handler = (req: unknown, reply: Reply) => unknown;
interface Reply { code(status: number): Reply; send(body: unknown): unknown }
interface Registered { handler: Handler; options: unknown }

let configDir: string;
let servers: Server[];
let previous: string | undefined;

beforeEach(() => {
  configDir = makeTempDir('app-module-machine-allow-');
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

async function call(map: Map<string, Registered>, key: string, req: { headers?: Record<string, string>; params?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const route = map.get(key);
  if (route === undefined) throw new Error(`route not registered: ${key}`);
  let status = 200;
  let sent: unknown;
  const reply: Reply = { code(s) { status = s; return reply; }, send(b) { sent = b; return b; } };
  await route.handler({ headers: req.headers ?? {}, params: req.params ?? {}, query: {}, body: req.body }, reply);
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

const SIGNED_POLICY = { body: { v: 1, target: SELF, version: 1, baseVersion: 0 }, signature: 'sig' };
const SIGNED_DOCUMENT = { body: { v: 1, kind: 'policy' }, signature: 'sig' };

describe('registration: every route of the Allow flow is sensitive (app-core PIN) and needs the module header', () => {
  it.each(['GET /admin-key', 'GET /allow/:machine', 'POST /allow'])('%s is declared effect sensitive', (key) => {
    const route = routes().get(key);
    expect(route, `${key} is not registered`).toBeDefined();
    expect(route?.options).toEqual({ effect: 'sensitive' });
  });

  it.each([
    ['GET /admin-key', {}],
    ['GET /allow/:machine', { params: { machine: SELF } }],
    ['POST /allow', { body: { policy: SIGNED_POLICY } }],
  ] as const)('%s without the module header is refused 403 and the daemon is never asked', async (key, req) => {
    const seen = await withDaemon({ adminKeyFile: { ok: true, file: '{}' }, allowContext: { ok: true }, submitPolicy: { ok: true } });
    const out = await call(routes(), key, req);
    expect(out.status).toBe(403);
    expect(out.body.kind).toBe('module_header');
    expect(seen).toEqual([]);
  });
});

describe('GET /admin-key', () => {
  it('returns the encrypted file text the daemon read, nothing else', async () => {
    await withDaemon({ adminKeyFile: { ok: true, file: '{"v":1,"ciphertext":"x"}' } });
    const out = await call(routes(), 'GET /admin-key', { headers: HEADER });
    expect(out).toEqual({ status: 200, body: { file: '{"v":1,"ciphertext":"x"}' } });
  });

  it('says there is no admin key here (409) with the daemon words', async () => {
    await withDaemon({ adminKeyFile: { ok: false, reason: 'no-admin-key', message: 'this machine has no admin key' } });
    const out = await call(routes(), 'GET /admin-key', { headers: HEADER });
    expect(out.status).toBe(409);
    expect(out.body).toMatchObject({ kind: 'no-admin-key', error: 'this machine has no admin key' });
  });

  it('503 with the way to start the daemon when it is not reachable', async () => {
    const out = await call(routes(), 'GET /admin-key', { headers: HEADER });
    expect(out.status).toBe(503);
    expect(out.body.kind).toBe('daemon_unreachable');
  });

  it('says the daemon is older than the module when it does not know the command', async () => {
    await withDaemon({});
    const out = await call(routes(), 'GET /admin-key', { headers: HEADER });
    expect(out.status).toBe(502);
    expect(out.body.error).toMatch(/machine cli update/);
  });
});

describe('GET /allow/:machine (the context)', () => {
  it('asks the daemon for that machine and returns the context as it is', async () => {
    const context = { ok: true, target: { uuid: SELF, name: 'desktop' }, toSelf: true, policyMode: 'admin', adminKeyId: 'a'.repeat(32), adminPublicKey: 'k', current: null, source: 'installed on this machine', delivery: 'install' };
    const seen = await withDaemon({ allowContext: context });
    const out = await call(routes(), 'GET /allow/:machine', { headers: HEADER, params: { machine: SELF } });
    expect(out).toEqual({ status: 200, body: context });
    expect(seen).toEqual([{ command: 'allowContext', body: { machine: SELF } }]);
  });

  it.each([
    ['unknown-machine', 404],
    ['mode-local', 409],
    ['no-admin-key', 409],
    ['no-admin-token', 409],
    ['policy-record-invalid', 409],
    ['bad-payload', 400],
  ])('a refusal %s is HTTP %i, with the daemon message as `error`', async (reason, status) => {
    await withDaemon({ allowContext: { ok: false, reason, message: `why ${reason}` } });
    const out = await call(routes(), 'GET /allow/:machine', { headers: HEADER, params: { machine: SELF } });
    expect(out.status).toBe(status);
    expect(out.body).toEqual({ status, kind: reason, error: `why ${reason}` });
  });

  it('a missing machine is a 400 that names the route', async () => {
    const out = await call(routes(), 'GET /allow/:machine', { headers: HEADER, params: {} });
    expect(out.status).toBe(400);
  });
});

describe('POST /allow (the signed policy)', () => {
  it('forwards ONLY the signed policy and document to the daemon, and returns its answer', async () => {
    const seen = await withDaemon({ submitPolicy: { ok: true, target: { uuid: SELF, name: 'desktop' }, version: 1, delivery: 'installed' } });
    const out = await call(routes(), 'POST /allow', { headers: HEADER, body: { policy: SIGNED_POLICY, document: SIGNED_DOCUMENT } });
    expect(out).toEqual({ status: 200, body: { ok: true, target: { uuid: SELF, name: 'desktop' }, version: 1, delivery: 'installed' } });
    expect(seen).toEqual([{ command: 'submitPolicy', body: { policy: SIGNED_POLICY, document: SIGNED_DOCUMENT } }]);
  });

  it('forwards the signed list of notice recipients too, re-built with exactly its two fields', async () => {
    const seen = await withDaemon({ submitPolicy: { ok: true } });
    const list = { signed: { body: { v: 1, serial: 5 }, signature: 'sig' }, document: SIGNED_DOCUMENT };
    const out = await call(routes(), 'POST /allow', { headers: HEADER, body: { policy: SIGNED_POLICY, document: SIGNED_DOCUMENT, noticeRecipients: list } });
    expect(out.status).toBe(200);
    expect(seen).toEqual([{ command: 'submitPolicy', body: { policy: SIGNED_POLICY, document: SIGNED_DOCUMENT, noticeRecipients: list } }]);
  });

  it.each([
    ['text', 'x'],
    ['no document', { signed: { body: {}, signature: 's' } }],
    ['no signature', { signed: { body: {} }, document: { body: {}, signature: 's' } }],
    ['an extra field', { signed: { body: {}, signature: 's' }, document: { body: {}, signature: 's' }, passphrase: 'TOP-SECRET-VALUE' }],
  ])('refuses a malformed noticeRecipients (%s): 400, the daemon is never asked, the value is never echoed', async (_name, noticeRecipients) => {
    const seen = await withDaemon({ submitPolicy: { ok: true } });
    const out = await call(routes(), 'POST /allow', { headers: HEADER, body: { policy: SIGNED_POLICY, document: SIGNED_DOCUMENT, noticeRecipients } });
    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/noticeRecipients/);
    expect(JSON.stringify(out.body)).not.toContain('TOP-SECRET-VALUE');
    expect(seen).toEqual([]);
  });

  it('refuses any other field, so a passphrase or a key can never be forwarded by mistake (400, the daemon is never asked, the value is never echoed)', async () => {
    const seen = await withDaemon({ submitPolicy: { ok: true } });
    const out = await call(routes(), 'POST /allow', { headers: HEADER, body: { policy: SIGNED_POLICY, passphrase: 'TOP-SECRET-VALUE' } });
    expect(out.status).toBe(400);
    expect(out.body.kind).toBe('bad_request');
    expect(JSON.stringify(out.body)).not.toContain('TOP-SECRET-VALUE');
    expect(out.body.error).toMatch(/passphrase/);
    expect(seen).toEqual([]);
  });

  it.each([[undefined], [null], ['text'], [{}], [{ policy: 'x' }], [{ policy: SIGNED_POLICY, document: 'x' }]])('refuses a body that is not {policy, document?} (%j)', async (body) => {
    const seen = await withDaemon({ submitPolicy: { ok: true } });
    const out = await call(routes(), 'POST /allow', { headers: HEADER, body });
    expect(out.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it.each([
    ['bad-signature', 403],
    ['stale-base', 409],
    ['mode-local', 409],
    ['unknown-machine', 404],
    ['bad-document', 400],
    ['bad-notice-recipients', 400],
    ['stale-notice-recipients', 409],
    ['notice-recipients-invalid', 409],
    ['refused', 409],
    ['relay-error', 502],
  ])('a refusal %s is HTTP %i, with the daemon message', async (reason, status) => {
    await withDaemon({ submitPolicy: { ok: false, reason, message: `why ${reason}` } });
    const out = await call(routes(), 'POST /allow', { headers: HEADER, body: { policy: SIGNED_POLICY } });
    expect(out.status).toBe(status);
    expect(out.body).toEqual({ status, kind: reason, error: `why ${reason}` });
  });

  it('503 when the daemon is not running: nothing was stored', async () => {
    const out = await call(routes(), 'POST /allow', { headers: HEADER, body: { policy: SIGNED_POLICY } });
    expect(out.status).toBe(503);
  });
});
