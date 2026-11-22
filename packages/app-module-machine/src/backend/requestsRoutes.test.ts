import { createServer, type Server } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendAudit, GENESIS_HASH, summarizeRequests, type Json } from '@wadeck-app/machine-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import register from './index.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

const DAEMON_TOKEN = 'daemon-health-token-value';
const PEER = '11111111-1111-4111-8111-111111111111';
const SELF = '22222222-2222-4222-8222-222222222222';
const NOW = Math.floor(Date.now() / 1000);
const iso = (offset: number) => new Date((NOW + offset) * 1000).toISOString();

type Handler = (req: unknown, reply: Reply) => unknown;
interface Reply { code(status: number): Reply; send(body: unknown): unknown }
interface Registered { handler: Handler; options: unknown }

let configDir: string;
let servers: Server[];
let previous: string | undefined;

beforeEach(() => {
  configDir = makeTempDir('app-module-machine-requests-');
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

async function call(map: Map<string, Registered>, key: string, req: { headers?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const route = map.get(key);
  if (route === undefined) throw new Error(`route not registered: ${key}`);
  let status = 200;
  let sent: unknown;
  const reply: Reply = { code(s) { status = s; return reply; }, send(b) { sent = b; return b; } };
  await route.handler({ headers: req.headers ?? {}, params: {}, query: {}, body: req.body }, reply);
  return { status, body: sent };
}

/** A fake daemon that answers named commands and records what it received (command and JSON body). */
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

function realLog(): string[] {
  const entries: Array<Record<string, Json>> = [
    { ts: iso(-300), event: 'refused', source: PEER, reason: 'not-listed', id: 'a', shell: 'sh', command: 'ls' },
    { ts: iso(-100), event: 'refused', source: PEER, reason: 'not-listed', id: 'b', shell: 'sh', command: 'ls' },
    { ts: iso(-50), event: 'accepted', source: PEER, id: 'c', shell: 'sh', command: 'uptime' },
    { ts: iso(-49), event: 'completed', id: 'c', exitCode: 0, timedOut: false, truncated: false, durationMs: 1000 },
  ];
  const out: string[] = [];
  let prev = GENESIS_HASH;
  entries.forEach((entry, seq) => {
    const r = appendAudit({ prevHash: prev, seq, entry });
    out.push(r.line);
    prev = r.hash;
  });
  return out;
}

const localAnswer = (): unknown => {
  const summary = summarizeRequests(realLog(), { now: NOW, isAllowed: () => false, nameOf: () => 'thinkcentre' });
  return { initialized: true, ok: true, self: { uuid: SELF, name: 'target' }, policyMode: 'admin', adminKeyHere: true, logFile: '/x', logPresent: true, now: NOW, summary, problems: [] };
};

describe('GET /requests', () => {
  it('is a plain read route (GET, no PIN, no header): the page and its tab count read it', () => {
    const route = routes().get('GET /requests');
    expect(route).toBeDefined();
    expect(route?.options).toBeUndefined();
  });

  it('answers the pending list and the history of the local machine, with humanized ages', async () => {
    await withDaemon({ requests: localAnswer() });
    const out = await call(routes(), 'GET /requests');
    expect(out.status).toBe(200);
    expect(out.body.count).toBe(1);
    expect(out.body.pending[0]).toMatchObject({ peerText: 'thinkcentre', countText: '2 times', nextCommand: 'machine admin allow target --shell sh -- ls' });
    // Newest first (the run is the latest entry of the audit).
    expect(out.body.history.map((h: { kind: string }) => h.kind)).toEqual(['run', 'refused', 'refused']);
  });

  it('answers 503 with the way to start the daemon when it is not reachable', async () => {
    const out = await call(routes(), 'GET /requests');
    expect(out.status).toBe(503);
    expect(out.body.kind).toBe('daemon_unreachable');
  });

  it('says the daemon is older than the module when it does not know the command', async () => {
    await withDaemon({});
    const out = await call(routes(), 'GET /requests');
    expect(out.status).toBe(502);
    expect(out.body.error).toMatch(/machine cli update/);
  });

  it('answers 409 when this machine is not initialized', async () => {
    await withDaemon({ requests: { initialized: false, message: 'run `machine init --name <name>`' } });
    const out = await call(routes(), 'GET /requests');
    expect(out.status).toBe(409);
    expect(out.body.error).toMatch(/machine init/);
  });
});

describe('POST /requests/remote (a request signed in the browser with the admin key, forwarded to a peer by the daemon)', () => {
  const signed = { body: { v: 1, id: 'x', nonce: 'n', source: SELF, target: PEER, limit: 100, issuedAt: NOW, expiresAt: NOW + 30 }, signature: 'sig' };
  const header = { 'x-machine-module': '1' };
  const peerAnswer = { ok: true, answer: { type: 'requests-list', id: 'x', machine: { uuid: PEER, name: 'laptop' }, policyMode: 'admin', now: NOW, chain: { ok: true }, pendingTotal: 1, allowedNow: 0, truncated: false, waiting: [], pending: [{ peer: SELF, peerName: 'desktop', shell: 'sh', command: 'ls', count: 1, firstSeen: NOW - 60, lastSeen: NOW - 60, reason: 'not-listed' }] } };

  it('is declared sensitive (the PIN of app-core), because it makes the daemon contact another machine', () => {
    expect(routes().get('POST /requests/remote')?.options).toEqual({ effect: 'sensitive' });
  });

  it('refuses a call that does not come from the pages of the module', async () => {
    await withDaemon({ remoteRequests: peerAnswer });
    const out = await call(routes(), 'POST /requests/remote', { body: { machine: 'laptop', request: signed } });
    expect(out.status).toBe(403);
  });

  it('refuses a body without a machine or a signed request, naming what is expected', async () => {
    await withDaemon({ remoteRequests: peerAnswer });
    const out = await call(routes(), 'POST /requests/remote', { headers: header, body: { machine: 'laptop' } });
    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/machine.*request/s);
  });

  it('forwards the document as is to the daemon and answers the peer rows', async () => {
    const seen = await withDaemon({ remoteRequests: peerAnswer });
    const out = await call(routes(), 'POST /requests/remote', { headers: header, body: { machine: 'laptop', request: signed } });
    expect(seen).toEqual([{ command: 'remoteRequests', body: { peer: 'laptop', request: signed } }]);
    expect(out.status).toBe(200);
    expect(out.body.machine.name).toBe('laptop');
    expect(out.body.pending[0]).toMatchObject({ peerText: 'desktop', nextCommand: 'machine admin allow laptop --shell sh -- ls' });
  });

  it.each([
    ['unknown-peer', 404],
    ['bad-payload', 400],
    ['wrong-target', 400],
    ['source-mismatch', 400],
    ['unreachable', 502],
    ['peer-too-old', 502],
    ['bad-signature', 403],
  ])('maps the failure "%s" to %i and keeps its message', async (reason, status) => {
    await withDaemon({ remoteRequests: { ok: false, reason, message: `because ${reason}` } });
    const out = await call(routes(), 'POST /requests/remote', { headers: header, body: { machine: 'laptop', request: signed } });
    expect(out.status).toBe(status);
    expect(out.body.kind).toBe(reason);
    expect(out.body.error).toBe(`because ${reason}`);
  });
});
