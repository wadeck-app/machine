import { createServer, type Server } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import register from './index.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

// The Dismiss and Clear expired buttons of the Requests page (decision 100): a restricting, local action on a display row (no signature, no passphrase, no PIN: it answers nobody and touches no target).
// The route forwards only {machine, id} or {expired: true} to the daemon command `dismissNotice`.

const DAEMON_TOKEN = 'daemon-health-token-value';
const HEADER = { 'x-machine-module': '1' };
const MACHINE = '51319efa-2b66-4b10-ba04-3052fb76be4a';
const ID = '9c87bc4c-5962-4fa5-a980-21c14b62f95e';

type Handler = (req: unknown, reply: Reply) => unknown;
interface Reply { code(status: number): Reply; send(body: unknown): unknown }
interface Registered { handler: Handler; options: unknown }

let configDir: string;
let servers: Server[];
let previous: string | undefined;

beforeEach(() => {
  configDir = makeTempDir('app-module-machine-dismiss-');
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

async function call(req: { headers?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const route = routes().get('POST /dismiss-notice');
  if (route === undefined) {
    throw new Error('route not registered: POST /dismiss-notice');
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

describe('POST /dismiss-notice', () => {
  it('is registered as a plain write route: no PIN (a display row is not an action on the target), unlike Deny and Allow', () => {
    const route = routes().get('POST /dismiss-notice');
    expect(route).toBeDefined();
    expect(route?.options).toEqual({ effect: 'write' });
  });

  it('without the module header is refused 403 and the daemon is never asked', async () => {
    const seen = await withDaemon({ dismissNotice: { ok: true, removed: 1 } });
    const out = await call({ body: { machine: MACHINE, id: ID } });
    expect(out.status).toBe(403);
    expect(out.body.kind).toBe('module_header');
    expect(seen).toEqual([]);
  });

  it('forwards only {machine, id} to the daemon command dismissNotice and returns its answer', async () => {
    const seen = await withDaemon({ dismissNotice: { ok: true, removed: 1 } });
    const out = await call({ headers: HEADER, body: { machine: MACHINE, id: ID } });
    expect(out).toEqual({ status: 200, body: { ok: true, removed: 1 } });
    expect(seen).toEqual([{ command: 'dismissNotice', body: { machine: MACHINE, id: ID } }]);
  });

  it('forwards {expired: true} for Clear expired', async () => {
    const seen = await withDaemon({ dismissNotice: { ok: true, removed: 3 } });
    const out = await call({ headers: HEADER, body: { expired: true } });
    expect(out).toEqual({ status: 200, body: { ok: true, removed: 3 } });
    expect(seen).toEqual([{ command: 'dismissNotice', body: { expired: true } }]);
  });

  it.each([
    ['no body', undefined, /expected \{"machine"/],
    ['an array', [], /expected \{"machine"/],
    ['no id', { machine: MACHINE }, /"id"/],
    ['no machine', { id: ID }, /"machine"/],
    ['a machine that is not a uuid', { machine: 'thinkcentre', id: ID }, /"machine"/],
    ['an id that is not a uuid', { machine: MACHINE, id: 'x' }, /"id"/],
    ['expired false', { expired: false }, /"expired"/],
    ['expired with an id', { expired: true, id: ID }, /"expired"/],
    ['another field (a passphrase must never travel here)', { machine: MACHINE, id: ID, passphrase: 'TOP-SECRET-VALUE' }, /"passphrase" is not accepted/],
  ])('400 with an actionable message for %s, and the daemon is never asked', async (_name, body, message) => {
    const seen = await withDaemon({ dismissNotice: { ok: true, removed: 1 } });
    const out = await call({ headers: HEADER, body });
    expect(out.status).toBe(400);
    expect(out.body.kind).toBe('bad_request');
    expect(out.body.error).toMatch(message);
    expect(JSON.stringify(out.body)).not.toContain('TOP-SECRET-VALUE');
    expect(seen).toEqual([]);
  });

  it.each([
    ['unknown', 404],
    ['none', 404],
    ['live', 409],
  ])('maps the daemon refusal %s to %i and keeps its message (a dismiss of an unknown id is refused, nothing is removed)', async (reason, status) => {
    await withDaemon({ dismissNotice: { ok: false, reason, message: `why ${reason}` } });
    const out = await call({ headers: HEADER, body: { machine: MACHINE, id: ID } });
    expect(out.status).toBe(status);
    expect(out.body).toMatchObject({ status, kind: reason, error: `why ${reason}` });
  });

  it('503 with the way to start the daemon when it is not reachable', async () => {
    const out = await call({ headers: HEADER, body: { machine: MACHINE, id: ID } });
    expect(out.status).toBe(503);
    expect(out.body.kind).toBe('daemon_unreachable');
  });
});
