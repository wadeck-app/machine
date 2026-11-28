import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import register from './index.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

// Retry delivery (admin-ui.md, "Result and progress UX"): the daemon sends again the documents it kept in memory after an approval or a revocation from the page. The
// route carries only the uuid of the subject: no document, no passphrase, nothing signed.

const DAEMON_TOKEN = 'daemon-health-token-value';
const HEADER = { 'x-machine-module': '1' };
const SUBJECT = '0b8a7a52-7f0d-4f0e-8a56-2f0d3a1c9e11';
const RETRY = 'POST /delivery-retry';

type Handler = (req: unknown, reply: Reply) => unknown;
interface Reply { code(status: number): Reply; send(body: unknown): unknown }
interface Registered { handler: Handler; options: unknown }

let configDir: string;
let servers: Server[];
let previous: string | undefined;
let events: string[];

beforeEach(() => {
  configDir = makeTempDir('app-module-machine-delivery-retry-');
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

async function call(key: string, req: { headers?: Record<string, string>; body?: unknown }): Promise<{ status: number; body: any }> {
  const route = routes().get(key);
  if (route === undefined) throw new Error(`route not registered: ${key}`);
  let status = 200;
  let sent: unknown;
  const reply: Reply = { code(s) { status = s; return reply; }, send(b) { sent = b; return b; } };
  await route.handler({ headers: req.headers ?? {}, params: {}, query: {}, body: req.body }, reply);
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

describe('POST /delivery-retry: send again what an approval or a revocation could not store', () => {
  const DONE = { ok: true, subject: { uuid: SUBJECT, name: 'laptop' }, failed: false, report: { delivered: 2, alreadyThere: 0, failures: [], aborted: false, machines: 1 }, text: { out: '[ok] 2 document(s)\n', err: '' }, machines: [], retry: `machine admin distribute ${SUBJECT}` };

  it('is a sensitive route (the app-core PIN): it spends the relay admin token', () => {
    expect(routes().get(RETRY)?.options).toEqual({ effect: 'sensitive' });
  });

  it('accepts the reserved subject of the network aliases and names the rename and the aliases in its rule', async () => {
    const bodies = await startDaemon({ retryDelivery: DONE });
    const out = await call(RETRY, { headers: HEADER, body: { uuid: '00000000-0000-4000-8000-0000000a11a5' } });
    expect(out.status).toBe(200);
    expect(bodies).toEqual([{ command: 'retryDelivery', body: { uuid: '00000000-0000-4000-8000-0000000a11a5' } }]);
    const bad = await call(RETRY, { headers: HEADER, body: {} });
    expect(bad.body.error).toMatch(/rename.*network aliases/);
  });

  it('without the module header: 403, no daemon call', async () => {
    await startDaemon({ retryDelivery: DONE });
    const out = await call(RETRY, { body: { uuid: SUBJECT } });
    expect(out.status).toBe(403);
    expect(events).toEqual([]);
  });

  it('the body is exactly { uuid }: anything else (a document, a passphrase, a bad uuid) is a 400 naming the rule, before any call', async () => {
    await startDaemon({ retryDelivery: DONE });
    for (const bad of [undefined, null, [], {}, { uuid: 'nope' }, { uuid: 5 }, { uuid: SUBJECT, passphrase: 'x' }, { uuid: SUBJECT, documents: [] }]) {
      const out = await call(RETRY, { headers: HEADER, body: bad });
      expect(out.status, JSON.stringify(bad)).toBe(400);
      expect(out.body.kind).toBe('bad_request');
      expect(out.body.error).toContain('{"uuid"');
    }
    expect(events).toEqual([]);
  });

  it('forwards exactly the uuid to the daemon command retryDelivery and answers what it answered', async () => {
    const bodies = await startDaemon({ retryDelivery: DONE });
    const out = await call(RETRY, { headers: HEADER, body: { uuid: SUBJECT } });
    expect(out.status).toBe(200);
    expect(out.body).toEqual(DONE);
    expect(bodies).toEqual([{ command: 'retryDelivery', body: { uuid: SUBJECT } }]);
  });

  it('a refusal of the daemon keeps its reason and its message (cause and fix), with a status per reason', async () => {
    const cases: Array<[string, number]> = [['bad-payload', 400], ['nothing-retained', 409], ['no-admin-key', 409], ['no-admin-token', 409], ['not-initialized', 409], ['bad-document', 422]];
    for (const [reason, status] of cases) {
      await startDaemon({ retryDelivery: { ok: false, reason, message: `cause of ${reason}: fix it` } });
      const out = await call(RETRY, { headers: HEADER, body: { uuid: SUBJECT } });
      expect(out.status, reason).toBe(status);
      expect(out.body.error).toBe(`cause of ${reason}: fix it`);
    }
  });

  it('a daemon that is not running is a loud 503 naming the fix', async () => {
    const out = await call(RETRY, { headers: HEADER, body: { uuid: SUBJECT } });
    expect(out.status).toBe(503);
    expect(out.body.error).toMatch(/daemon/);
  });
});
