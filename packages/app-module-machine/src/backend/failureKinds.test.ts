import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFailureView, type FailureKind } from '../../../dsl-lib-machine/src/lib/loadFailure.js';
import register from './index.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

// The page tells a failed source by what it is (dsl-lib-machine lib/loadFailure.ts), but `$sourceErrors` carries only the message and the HTTP status of the answer. So the
// decision reads the words of the REAL backend: this file produces every kind of failure with the real routes (a real config folder, a real fake relay and daemon on
// loopback) and checks how the page classifies the answer. A reworded message of the backend fails HERE, never silently on the page.

const DAEMON_TOKEN = 'daemon-health-token-value';

type Handler = (req: unknown, reply: Reply) => unknown;
interface Reply { code(status: number): Reply; send(body: unknown): unknown }

let configDir: string;
let servers: Server[];
let previous: string | undefined;

beforeEach(() => {
  configDir = makeTempDir('app-module-machine-kinds-');
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

function routes(): Map<string, Handler> {
  const map = new Map<string, Handler>();
  register({ registerRoute: (method: string, path: string, handler: Handler) => { map.set(`${method} ${path}`, handler); } } as never);
  return map;
}

/** What the page receives from `GET <path>`: the status and the message of the error answer. */
async function failureOf(path: string): Promise<{ status: number; message: string }> {
  const handler = routes().get(`GET ${path}`);
  if (handler === undefined) throw new Error(`route not registered: GET ${path}`);
  let status = 200;
  let sent: unknown;
  const reply: Reply = { code(s) { status = s; return reply; }, send(b) { sent = b; return b; } };
  await handler({ headers: {}, params: {}, query: {}, body: undefined }, reply);
  const message = (sent as { message?: unknown } | undefined)?.message;
  if (status < 400 || typeof message !== 'string') throw new Error(`GET ${path} did not fail as expected: ${status} ${JSON.stringify(sent)}`);
  return { status, message };
}

async function listen(handler: (req: { url: string; auth: string | undefined; body: string }, res: { status: number; json?: unknown; text?: string }) => void): Promise<number> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      const out: { status: number; json?: unknown; text?: string } = { status: 200 };
      handler({ url: req.url ?? '', auth: req.headers.authorization, body }, out);
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(out.text ?? JSON.stringify(out.json ?? {}));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

const writeSecret = (name: string, content: string): void => {
  mkdirSync(join(configDir, '_secrets_'), { recursive: true });
  writeFileSync(join(configDir, '_secrets_', name), content);
};
const adminToken = (relayUrl: string): string => JSON.stringify({ relayUrl, token: 'admin-token-1', label: 'desk admin', claimedAt: '2026-11-28T10:00:00.000Z' });

async function withDaemon(handler: Parameters<typeof listen>[0], token = DAEMON_TOKEN): Promise<void> {
  const port = await listen(handler);
  writeFileSync(join(configDir, 'daemon.port.json'), JSON.stringify({ pid: process.pid, port, peerPort: 1 }));
  writeFileSync(join(configDir, 'health_token'), token);
}

const kindOf = async (path: string, subject: string): Promise<{ kind: FailureKind; canLogin: boolean; command: string | undefined; status: number }> => {
  const failure = await failureOf(path);
  const view = loadFailureView(subject, failure);
  return { kind: view.kind, canLogin: view.canLogin, command: view.command, status: failure.status };
};

describe('the relay (GET /candidacies)', () => {
  it('no admin relay token: not configured, and the page can log in', async () => {
    expect(await kindOf('/candidacies', 'the candidacies')).toEqual({ kind: 'not-configured', canLogin: true, command: 'machine admin login', status: 503 });
  });

  it('a damaged token file: setup by hand, the command replaces the file', async () => {
    writeSecret('relay-admin.json', '{not json');
    expect(await kindOf('/candidacies', 'the candidacies')).toEqual({ kind: 'setup-manual', canLogin: false, command: 'machine admin login --force', status: 503 });
  });

  it('a relay URL that is not accepted (plain http to a name): setup by hand', async () => {
    writeSecret('relay-admin.json', adminToken('http://relay.example.net'));
    const out = await kindOf('/candidacies', 'the candidacies');
    expect(out.kind).toBe('setup-manual');
    expect(out.canLogin).toBe(false);
    expect(out.command).toBe('machine admin login --force');
  });

  it('a relay that is not reachable: external, Retry, no command', async () => {
    writeSecret('relay-admin.json', adminToken('http://127.0.0.1:1'));
    expect(await kindOf('/candidacies', 'the candidacies')).toEqual({ kind: 'relay', canLogin: false, command: undefined, status: 502 });
  });

  it('a relay that refuses the token (401): setup by hand with the command that replaces it (the backend answers 502 whatever the relay status, so the words decide)', async () => {
    const port = await listen((_req, res) => { res.status = 401; res.json = { error: 'unauthorized' }; });
    writeSecret('relay-admin.json', adminToken(`http://127.0.0.1:${port}`));
    expect(await kindOf('/candidacies', 'the candidacies')).toEqual({ kind: 'setup-manual', canLogin: false, command: 'machine admin login --force', status: 502 });
  });

  it('a token without the admin scope (403 scope_denied): setup by hand', async () => {
    const port = await listen((_req, res) => { res.status = 403; res.json = { error: 'scope_denied' }; });
    writeSecret('relay-admin.json', adminToken(`http://127.0.0.1:${port}`));
    const out = await kindOf('/candidacies', 'the candidacies');
    expect(out.kind).toBe('setup-manual');
    expect(out.command).toBe('machine admin login --force');
  });

  it('a relay that answers 503 or something that is not a list: external', async () => {
    let answer: { status: number; json: unknown } = { status: 503, json: { message: 'maintenance' } };
    const port = await listen((_req, res) => { res.status = answer.status; res.json = answer.json; });
    writeSecret('relay-admin.json', adminToken(`http://127.0.0.1:${port}`));
    expect((await kindOf('/candidacies', 'the candidacies')).kind).toBe('relay');
    answer = { status: 200, json: { nothing: true } };
    expect((await kindOf('/candidacies', 'the candidacies')).kind).toBe('relay');
  });
});

describe('the machine daemon (GET /machines, /requests, /allowed, /activity)', () => {
  it.each(['/machines', '/requests', '/allowed', '/activity'])('%s with no daemon running: the daemon is to be started', async (path) => {
    const out = await kindOf(path, 'the data');
    expect(out).toEqual({ kind: 'daemon-down', canLogin: false, command: 'machine daemon', status: 503 });
  });

  it('a stale port file (nobody listens): the daemon is to be started', async () => {
    writeFileSync(join(configDir, 'daemon.port.json'), JSON.stringify({ pid: 1, port: 1, peerPort: 1 }));
    writeFileSync(join(configDir, 'health_token'), DAEMON_TOKEN);
    expect((await kindOf('/machines', 'the machines')).kind).toBe('daemon-down');
  });

  it('a port file without its token file: the daemon is to be restarted', async () => {
    writeFileSync(join(configDir, 'daemon.port.json'), JSON.stringify({ pid: process.pid, port: 5, peerPort: 1 }));
    expect((await kindOf('/machines', 'the machines')).kind).toBe('daemon-down');
  });

  it('a daemon that refuses the token (401): restart it, both commands to copy', async () => {
    await withDaemon((req, res) => { if (req.auth !== `Bearer ${DAEMON_TOKEN}`) { res.status = 401; res.json = { error: 'unauthorized' }; } else res.json = { result: {} }; }, 'another-run-token');
    const out = await kindOf('/machines', 'the machines');
    expect(out.kind).toBe('daemon-down');
    expect(out.command).toBe('machine stop\nmachine daemon');
  });

  it('a daemon older than the module (Unknown command): the update is the fix', async () => {
    await withDaemon((req, res) => { res.status = 404; res.json = { error: `Unknown command: ${req.url.slice(1)}` }; });
    const out = await kindOf('/allowed', 'the allow lists');
    expect(out).toEqual({ kind: 'daemon-old', canLogin: false, command: 'machine cli update', status: 502 });
  });

  it('a daemon whose answer of requests is not the one of this version: the update is the fix', async () => {
    await withDaemon((_req, res) => { res.json = { result: { unexpected: true } }; });
    const out = await kindOf('/requests', 'the requests');
    expect(out.kind).toBe('daemon-old');
    expect(out.command).toBe('machine cli update');
  });

  it('a daemon that fails a command (HTTP 500 with a message): an internal error', async () => {
    await withDaemon((_req, res) => { res.status = 500; res.json = { error: 'ENOENT: no such file' }; });
    const out = await kindOf('/machines', 'the machines');
    expect(out).toEqual({ kind: 'internal', canLogin: false, command: undefined, status: 502 });
  });

  it('a machine without identity (the daemon says not initialized): setup by hand, the command to copy', async () => {
    await withDaemon((_req, res) => { res.json = { result: { initialized: false, message: 'this machine has no identity yet: run `machine setup <relay>` (the first machine of a network) or `machine join <relay>` (any other machine), which create it' } }; });
    for (const path of ['/machines', '/requests', '/allowed', '/activity']) {
      const out = await kindOf(path, 'the data');
      expect(out, path).toEqual({ kind: 'setup-manual', canLogin: false, command: 'machine setup <relay>', status: 409 });
    }
  });

  it('an answer the module cannot read (a handler that throws): an internal error, HTTP 500', async () => {
    // `peers` is not a list: the route throws a TypeError while it builds the rows.
    await withDaemon((req, res) => { res.json = { result: req.url === '/list' ? { initialized: true, enrolled: true, self: { uuid: 'u', name: 'n' }, peers: 5 } : {} }; });
    const out = await kindOf('/machines', 'the machines');
    expect(out.kind).toBe('internal');
    expect(out.status).toBe(500);
    expect(out.command).toBeUndefined();
  });
});
