import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import register from './index.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

// Revoke from the page (admin-ui.md, "Revoke from the page"). The BROWSER signed the revocation list and the documents; these routes only check their shape and hand
// them to the daemon of the admin machine (commands revokeContext and revokeApply), which verifies, installs and delivers. They sign nothing and see no passphrase.

const DAEMON_TOKEN = 'daemon-health-token-value';
const HEADER = { 'x-machine-module': '1' };
const PEER_UUID = '0b8a7a52-7f0d-4f0e-8a56-2f0d3a1c9e11';
const OTHER_UUID = '11111111-1111-4111-8111-111111111111';
const CONTEXT = 'GET /revoke-context/:uuid';
const APPLY = 'POST /revoke';

type Handler = (req: unknown, reply: Reply) => unknown;
interface Reply { code(status: number): Reply; send(body: unknown): unknown }
interface Registered { handler: Handler; options: unknown }

let configDir: string;
let servers: Server[];
let previous: string | undefined;
let events: string[];

beforeEach(() => {
  configDir = makeTempDir('app-module-machine-revoke-');
  servers = [];
  events = [];
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

async function call(key: string, req: { headers?: Record<string, string>; params?: Record<string, string>; body?: unknown }): Promise<{ status: number; body: any }> {
  const route = routes().get(key);
  if (route === undefined) throw new Error(`route not registered: ${key}`);
  let status = 200;
  let sent: unknown;
  const reply: Reply = { code(s) { status = s; return reply; }, send(b) { sent = b; return b; } };
  await route.handler({ headers: req.headers ?? {}, params: req.params ?? {}, query: {}, body: req.body }, reply);
  return { status, body: sent };
}

async function startDaemon(answers: Record<string, unknown>): Promise<Array<{ command: string; body: unknown }>> {
  const bodies: Array<{ command: string; body: unknown }> = [];
  const daemon = createServer((req, res) => {
    let text = '';
    req.on('data', (c: Buffer) => { text += c.toString(); });
    req.on('end', () => {
      const command = (req.url ?? '').slice(1);
      events.push(`daemon-${command}`);
      bodies.push({ command, body: text === '' ? undefined : JSON.parse(text) });
      const known = req.headers.authorization === `Bearer ${DAEMON_TOKEN}` && command in answers;
      res.writeHead(known ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(known ? { result: answers[command] } : { error: `Unknown command: ${command}` }));
    });
  });
  servers.push(daemon);
  await new Promise<void>((resolve) => daemon.listen(0, '127.0.0.1', resolve));
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'daemon.port.json'), JSON.stringify({ pid: process.pid, port: (daemon.address() as { port: number }).port, peerPort: 1 }));
  writeFileSync(join(configDir, 'health_token'), DAEMON_TOKEN);
  return bodies;
}

describe('GET /revoke-context/:uuid: what the page needs before it asks the passphrase', () => {
  const context = { ok: true, adminMachine: { uuid: OTHER_UUID, name: 'desk' }, adminPublicKey: 'p', adminKeyId: 'i', revoked: { uuid: PEER_UUID, name: 'laptop', serial: 3, keyId: 'k' }, held: { entries: [], version: 0 }, recipients: [], noticeRecipients: null };

  it('is a sensitive route (the app-core PIN) and needs the module header: 403 without it, no daemon call', async () => {
    expect(routes().get(CONTEXT)?.options).toEqual({ effect: 'sensitive' });
    await startDaemon({ revokeContext: context });
    const out = await call(CONTEXT, { params: { uuid: PEER_UUID } });
    expect(out.status).toBe(403);
    expect(events).toEqual([]);
  });

  it('forwards exactly the uuid to the daemon command revokeContext and answers what it answered', async () => {
    const bodies = await startDaemon({ revokeContext: context });
    const out = await call(CONTEXT, { headers: HEADER, params: { uuid: PEER_UUID } });
    expect(out.status).toBe(200);
    expect(out.body).toEqual(context);
    expect(bodies).toEqual([{ command: 'revokeContext', body: { uuid: PEER_UUID } }]);
  });

  it('a bad uuid in the path is a 400 before any call', async () => {
    await startDaemon({ revokeContext: context });
    const out = await call(CONTEXT, { headers: HEADER, params: { uuid: 'nope' } });
    expect(out.status).toBe(400);
    expect(out.body.kind).toBe('bad_request');
    expect(events).toEqual([]);
  });

  it('a refusal of the daemon keeps its reason and its message (cause and fix), with a status per reason', async () => {
    const cases: Array<[string, number]> = [['bad-payload', 400], ['no-admin-key', 409], ['not-initialized', 409], ['self', 409], ['not-trusted', 409], ['notice-recipients-invalid', 409]];
    for (const [reason, status] of cases) {
      await startDaemon({ revokeContext: { ok: false, reason, message: `cause of ${reason}: fix it` } });
      const out = await call(CONTEXT, { headers: HEADER, params: { uuid: PEER_UUID } });
      expect(out.status, reason).toBe(status);
      expect(out.body.error).toBe(`cause of ${reason}: fix it`);
    }
  });

  it('a daemon that is not running is a loud 503 naming the fix', async () => {
    const out = await call(CONTEXT, { headers: HEADER, params: { uuid: PEER_UUID } });
    expect(out.status).toBe(503);
    expect(out.body.error).toMatch(/daemon/);
  });
});

describe('POST /revoke: the revocation the page signed', () => {
  const doc = (to: string): Record<string, unknown> => ({ body: { v: 2, kind: 'revocation', to, id: 'AAAAAAAAAAAAAAAAAAAAAA', issuedAt: 1, expiresAt: 2, payload: { sealed: 'x' } }, signature: 'sig' });
  const signed = { body: { v: 1, adminKeyId: 'k'.repeat(32), issuedAt: 5, entries: [{ uuid: PEER_UUID, serial: 3 }] }, signature: 'sig' };
  const body = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ uuid: PEER_UUID, signed, documents: [doc(OTHER_UUID)], noticeRecipients: null, ...extra });
  const DONE = { ok: true, revoked: { uuid: PEER_UUID, name: 'laptop' }, failed: false, report: { delivered: 2, alreadyThere: 0, failures: [], aborted: false, machines: 1 }, text: { out: '[ok] 2 document(s)\n', err: '' }, machines: [], retry: `machine admin distribute ${PEER_UUID}` };

  it('is a sensitive route (the app-core PIN): it makes this machine stop trusting a machine and spends the relay token', () => {
    expect(routes().get(APPLY)?.options).toEqual({ effect: 'sensitive' });
  });

  it('without the module header: 403, no daemon call', async () => {
    await startDaemon({ revokeApply: DONE });
    const out = await call(APPLY, { body: body() });
    expect(out.status).toBe(403);
    expect(events).toEqual([]);
  });

  it('the body is exactly { uuid, signed, documents, noticeRecipients }: a missing field, an extra field (a passphrase cannot travel here) or a bad shape is a 400 before any call', async () => {
    await startDaemon({ revokeApply: DONE });
    for (const bad of [undefined, { uuid: PEER_UUID }, body({ passphrase: 'x' }), body({ uuid: 'nope' }), body({ signed: 'x' }), body({ documents: 'x' }), body({ documents: [5] }), body({ noticeRecipients: 'x' })]) {
      const out = await call(APPLY, { headers: HEADER, body: bad });
      expect(out.status, JSON.stringify(bad)).toBe(400);
      expect(out.body.kind).toBe('bad_request');
    }
    expect(events).toEqual([]);
  });

  it('refuses a body larger than the relay can ever store, before any call', async () => {
    await startDaemon({ revokeApply: DONE });
    const out = await call(APPLY, { headers: HEADER, body: body({ documents: Array.from({ length: 80 }, () => ({ ...doc(OTHER_UUID), pad: 'A'.repeat(16 * 1024) })) }) });
    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/too large/);
    expect(events).toEqual([]);
  });

  it('forwards exactly the four fields to the daemon command revokeApply and answers what it answered', async () => {
    const bodies = await startDaemon({ revokeApply: DONE });
    const sent = body({ documents: [doc(OTHER_UUID), doc(PEER_UUID)] });
    const out = await call(APPLY, { headers: HEADER, body: sent });
    expect(out.status).toBe(200);
    expect(out.body).toEqual(DONE);
    expect(bodies).toEqual([{ command: 'revokeApply', body: sent }]);
  });

  it('a refusal of the daemon keeps its reason and its message (cause and fix), with a status per reason', async () => {
    const cases: Array<[string, number]> = [['bad-payload', 400], ['bad-revocation', 422], ['bad-document', 422], ['bad-notice-recipients', 422], ['stale-revocation', 409], ['stale-notice-recipients', 409], ['not-trusted', 409], ['self', 409], ['no-admin-key', 409], ['refused', 409]];
    for (const [reason, status] of cases) {
      await startDaemon({ revokeApply: { ok: false, reason, message: `cause of ${reason}: fix it` } });
      const out = await call(APPLY, { headers: HEADER, body: body() });
      expect(out.status, reason).toBe(status);
      expect(out.body.error).toBe(`cause of ${reason}: fix it`);
    }
  });

  it('a daemon that is not running is a loud 503 naming the fix', async () => {
    const out = await call(APPLY, { headers: HEADER, body: body() });
    expect(out.status).toBe(503);
    expect(out.body.error).toMatch(/daemon/);
  });
});
