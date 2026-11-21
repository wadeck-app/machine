import { createServer, type Server } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import register from './index.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

// The Deny button of the Requests page: no signature and no passphrase, but sensitive (the app-core PIN): a process that merely reaches the port must not answer the owner's held requests. The route forwards only {id, reason} to the daemon command `deny`.

const DAEMON_TOKEN = 'daemon-health-token-value';
const HEADER = { 'x-machine-module': '1' };

type Handler = (req: unknown, reply: Reply) => unknown;
interface Reply { code(status: number): Reply; send(body: unknown): unknown }
interface Registered { handler: Handler; options: unknown }

let configDir: string;
let servers: Server[];
let previous: string | undefined;

beforeEach(() => {
  configDir = makeTempDir('app-module-machine-deny-');
  servers = [];
  previous = process.env['MACHINE_CONFIG_DIR'];
  process.env['MACHINE_CONFIG_DIR'] = configDir;
});
afterEach(async () => {
  if (previous === undefined) {
    delete process.env['MACHINE_CONFIG_DIR'];
  } else {
    process.env['MACHINE_CONFIG_DIR'] = previous;
  }
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  removeTempDir(configDir);
});

function routes(): Map<string, Registered> {
  const map = new Map<string, Registered>();
  register({ registerRoute: (method: string, path: string, handler: Handler, options?: unknown) => { map.set(`${method} ${path}`, { handler, options }); } } as never);
  return map;
}

async function call(key: string, req: { headers?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const route = routes().get(key);
  if (route === undefined) {
    throw new Error(`route not registered: ${key}`);
  }
  let status = 200;
  let sent: unknown;
  const reply: Reply = { code(s) { status = s; return reply; }, send(b) { sent = b; return b; } };
  await route.handler({ headers: req.headers ?? {}, params: {}, query: {}, body: req.body }, reply);
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
  if (address === null || typeof address === 'string') {
    throw new Error('no port');
  }
  writeFileSync(join(configDir, 'daemon.port.json'), JSON.stringify({ pid: process.pid, port: address.port, peerPort: 1 }));
  writeFileSync(join(configDir, 'health_token'), DAEMON_TOKEN);
  return seen;
}

const DENIED = { ok: true, id: 'abc12345', peer: '11111111-1111-4111-8111-111111111111', shell: 'sh', command: 'ls' };

describe('POST /deny', () => {
  it('is registered and declared effect sensitive (the app-core PIN), like the Allow routes: it signs nothing and asks no passphrase', () => {
    const route = routes().get('POST /deny');
    expect(route).toBeDefined();
    expect(route?.options).toEqual({ effect: 'sensitive' });
  });

  it('without the module header is refused 403 and the daemon is never asked', async () => {
    const seen = await withDaemon({ deny: DENIED });
    const out = await call('POST /deny', { body: { id: 'abc12345' } });
    expect(out.status).toBe(403);
    expect(out.body.kind).toBe('module_header');
    expect(seen).toEqual([]);
  });

  it('forwards only {id, reason} to the daemon command deny and returns its answer', async () => {
    const seen = await withDaemon({ deny: DENIED });
    const out = await call('POST /deny', { headers: HEADER, body: { id: 'abc12345', reason: 'not now' } });
    expect(out).toEqual({ status: 200, body: DENIED });
    expect(seen).toEqual([{ command: 'deny', body: { id: 'abc12345', reason: 'not now' } }]);
  });

  it('forwards no reason key when none was given', async () => {
    const seen = await withDaemon({ deny: DENIED });
    await call('POST /deny', { headers: HEADER, body: { id: 'abc12345' } });
    expect(seen).toEqual([{ command: 'deny', body: { id: 'abc12345' } }]);
  });

  it.each([
    ['no body', undefined, /expected \{"id"/],
    ['an array', [], /expected \{"id"/],
    ['no id', { reason: 'x' }, /"id"/],
    ['an empty id', { id: '' }, /"id"/],
    ['a numeric id', { id: 5 }, /"id"/],
    ['a too long id', { id: 'a'.repeat(65) }, /"id"/],
    ['a reason that is not text', { id: 'abc12345', reason: 5 }, /"reason"/],
    ['a reason over 200 characters', { id: 'abc12345', reason: 'x'.repeat(201) }, /200/],
    ['a reason with a control character', { id: 'abc12345', reason: 'a\nb' }, /printable ASCII/],
    ['a reason with a non-ASCII character', { id: 'abc12345', reason: String.fromCharCode(99, 97, 102, 233) }, /printable ASCII/],
    ['another field (a passphrase must never travel here)', { id: 'abc12345', passphrase: 'TOP-SECRET-VALUE' }, /"passphrase" is not accepted/],
  ])('400 with an actionable message for %s, and the daemon is never asked', async (_name, body, message) => {
    const seen = await withDaemon({ deny: DENIED });
    const out = await call('POST /deny', { headers: HEADER, body });
    expect(out.status).toBe(400);
    expect(out.body.kind).toBe('bad_request');
    expect(out.body.error).toMatch(message);
    expect(JSON.stringify(out.body)).not.toContain('TOP-SECRET-VALUE');
    expect(seen).toEqual([]);
  });

  it.each([
    ['unknown', 404],
    ['ambiguous', 400],
    ['too-short', 400],
    ['bad-reason', 400],
    ['no-daemon', 503],
  ])('maps the daemon reason %s to %i and keeps its message', async (reason, status) => {
    await withDaemon({ deny: { ok: false, reason, message: `why ${reason}` } });
    const out = await call('POST /deny', { headers: HEADER, body: { id: 'abc12345' } });
    expect(out.status).toBe(status);
    expect(out.body).toMatchObject({ status, kind: reason, error: `why ${reason}` });
  });

  it('503 with the way to start the daemon when it is not reachable', async () => {
    const out = await call('POST /deny', { headers: HEADER, body: { id: 'abc12345' } });
    expect(out.status).toBe(503);
    expect(out.body.kind).toBe('daemon_unreachable');
  });

  it('says the daemon is older than the module when it does not know the command', async () => {
    await withDaemon({});
    const out = await call('POST /deny', { headers: HEADER, body: { id: 'abc12345' } });
    expect(out.status).toBe(502);
    expect(out.body.error).toMatch(/machine cli update/);
  });
});

describe('POST /deny with a machine (a request held on another machine, decision 85)', () => {
  const REMOTE = { ok: true, id: '3f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f', peer: { uuid: '22222222-2222-4222-8222-222222222222', name: 'thinkcentre' } };

  it('forwards only {peer, id, reason} to the daemon command denyRemote and returns its answer', async () => {
    const seen = await withDaemon({ denyRemote: REMOTE });
    const out = await call('POST /deny', { headers: HEADER, body: { machine: 'thinkcentre', id: 'abc12345', reason: 'not now' } });
    expect(out).toEqual({ status: 200, body: REMOTE });
    expect(seen).toEqual([{ command: 'denyRemote', body: { peer: 'thinkcentre', id: 'abc12345', reason: 'not now' } }]);
  });

  it('forwards no reason key when none was given', async () => {
    const seen = await withDaemon({ denyRemote: REMOTE });
    await call('POST /deny', { headers: HEADER, body: { machine: 'thinkcentre', id: 'abc12345' } });
    expect(seen).toEqual([{ command: 'denyRemote', body: { peer: 'thinkcentre', id: 'abc12345' } }]);
  });

  it.each([
    ['an empty machine', { machine: '', id: 'abc12345' }],
    ['a machine that is not text', { machine: 7, id: 'abc12345' }],
    ['a too long machine', { machine: 'm'.repeat(65), id: 'abc12345' }],
  ])('400 for %s, and the daemon is never asked', async (_name, body) => {
    const seen = await withDaemon({ denyRemote: REMOTE });
    const out = await call('POST /deny', { headers: HEADER, body });
    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/"machine"/);
    expect(seen).toEqual([]);
  });

  it.each([
    ['not-a-recipient', 403],
    ['recipients-unreadable', 409],
    ['not-held', 404],
    ['ambiguous', 400],
    ['bad-reason', 400],
    ['bad-deny', 400],
    ['unknown-peer', 404],
    ['peer-too-old', 502],
    ['unreachable', 502],
    ['no-answer', 504],
    ['audit-unavailable', 503],
  ])('maps the remote reason %s to %i, keeps the kind and the message of the target', async (reason, status) => {
    await withDaemon({ denyRemote: { ok: false, reason, message: `why ${reason}` } });
    const out = await call('POST /deny', { headers: HEADER, body: { machine: 'thinkcentre', id: 'abc12345' } });
    expect(out.status).toBe(status);
    expect(out.body).toMatchObject({ status, kind: reason, error: `why ${reason}` });
  });
});
