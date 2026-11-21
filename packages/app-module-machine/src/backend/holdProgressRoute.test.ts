import { createServer, type Server } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import register from './index.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

// The progress of an Allow (decision 86): the page asks every 2 s whether the held request is still held or how it ended. Read-only: it signs nothing and
// reveals nothing the Requests page does not already show.

const DAEMON_TOKEN = 'daemon-health-token-value';
const REQUEST = '3f1c2d3e-4a5b-4c6d-8e7f-000000000001';
const MACHINE = '9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345';

type Handler = (req: unknown, reply: Reply) => unknown;
interface Reply { code(status: number): Reply; send(body: unknown): unknown }
interface Registered { handler: Handler; options: unknown }

let configDir: string;
let servers: Server[];
let previous: string | undefined;

beforeEach(() => {
  configDir = makeTempDir('app-module-machine-progress-');
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

async function call(key: string, params: Record<string, string>): Promise<{ status: number; body: any }> {
  const route = routes().get(key);
  if (route === undefined) {
    throw new Error(`route not registered: ${key}`);
  }
  let status = 200;
  let sent: unknown;
  const reply: Reply = { code(s) { status = s; return reply; }, send(b) { sent = b; return b; } };
  await route.handler({ headers: {}, params, query: {}, body: undefined }, reply);
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

describe('GET /hold-progress/:machine/:id', () => {
  it('is a plain read route (no PIN): it only says whether a request is held and how it ended', () => {
    const route = routes().get('GET /hold-progress/:machine/:id');
    expect(route).toBeDefined();
    expect(route?.options).toBeUndefined();
  });

  it('asks the daemon for this machine (the word "self") without a machine, and returns its answer', async () => {
    const seen = await withDaemon({ holdProgress: { ok: true, machine: { uuid: MACHINE, name: 'desktop' }, id: REQUEST, state: 'held' } });
    const out = await call('GET /hold-progress/:machine/:id', { machine: 'self', id: REQUEST });
    expect(out).toEqual({ status: 200, body: { ok: true, machine: { uuid: MACHINE, name: 'desktop' }, id: REQUEST, state: 'held' } });
    expect(seen).toEqual([{ command: 'holdProgress', body: { id: REQUEST } }]);
  });

  it('forwards the machine and the request id of another machine, and the outcome it reports', async () => {
    const seen = await withDaemon({ holdProgress: { ok: true, machine: { uuid: MACHINE, name: 'thinkcentre' }, id: REQUEST, state: 'ended', outcome: 'allowed', at: 5 } });
    const out = await call('GET /hold-progress/:machine/:id', { machine: MACHINE, id: REQUEST });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ state: 'ended', outcome: 'allowed' });
    expect(seen).toEqual([{ command: 'holdProgress', body: { id: REQUEST, machine: MACHINE } }]);
  });

  it('refuses a request id or machine that is not shaped like one, before asking the daemon', async () => {
    const seen = await withDaemon({ holdProgress: {} });
    expect((await call('GET /hold-progress/:machine/:id', { machine: 'self', id: 'x;y' })).status).toBe(400);
    expect((await call('GET /hold-progress/:machine/:id', { machine: 'a'.repeat(100), id: REQUEST })).status).toBe(400);
    expect(seen).toEqual([]);
  });

  it('turns a refusal of the daemon into its status with its sentence', async () => {
    await withDaemon({ holdProgress: { ok: false, reason: 'unknown-peer', message: 'no machine named "x" (see `machine list`)' } });
    const out = await call('GET /hold-progress/:machine/:id', { machine: 'x', id: REQUEST });
    expect(out.status).toBe(404);
    expect(out.body).toMatchObject({ kind: 'unknown-peer', error: expect.stringContaining('machine list') });
  });

  it('an older daemon: says to update it', async () => {
    await withDaemon({ status: {} });
    const out = await call('GET /hold-progress/:machine/:id', { machine: 'self', id: REQUEST });
    expect(out.status).toBe(502);
    expect(out.body.error).toMatch(/older than this module.*machine cli update/s);
  });
});
