import { createServer, type Server } from 'node:http';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import register from './index.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

const MACHINE_TOKEN = 'machine-token-secret-value';
const ADMIN_TOKEN = 'admin-token-secret-value';
const DAEMON_TOKEN = 'daemon-health-token-value';

type Handler = (req: unknown, reply: Reply) => unknown;
interface Reply { code(status: number): Reply; send(body: unknown): unknown }
interface Check { name: string; ok: boolean; detail?: string }
interface Health { ok: boolean; checks: Check[] }

let root: string;
let configDir: string;
let servers: Server[];
let previousConfigDir: string | undefined;

beforeEach(() => {
  root = makeTempDir('app-module-machine-health-');
  configDir = join(root, 'cfg');
  mkdirSync(configDir);
  servers = [];
  previousConfigDir = process.env['MACHINE_CONFIG_DIR'];
  process.env['MACHINE_CONFIG_DIR'] = configDir;
});

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env['MACHINE_CONFIG_DIR'];
  else process.env['MACHINE_CONFIG_DIR'] = previousConfigDir;
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); })));
  removeTempDir(root);
});

async function health(): Promise<{ status: number; body: Health }> {
  const map = new Map<string, Handler>();
  register({ registerRoute: (m: string, p: string, h: Handler) => { map.set(`${m} ${p}`, h); } } as never);
  const handler = map.get('GET /health');
  if (handler === undefined) throw new Error('route not registered: GET /health');
  let status = 200;
  let sent: unknown;
  const reply: Reply = { code(s) { status = s; return reply; }, send(b) { sent = b; return b; } };
  await handler({ headers: {}, params: {}, query: {} }, reply);
  return { status, body: sent as Health };
}

const check = (h: Health, name: string): Check => {
  const found = h.checks.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no check "${name}" in ${JSON.stringify(h)}`);
  return found;
};

async function listen(handler: (url: string, auth: string | undefined) => { status: number; body: unknown } | 'hang'): Promise<number> {
  const server = createServer((req, res) => {
    const out = handler(req.url ?? '', req.headers.authorization);
    if (out === 'hang') return;
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

const secrets = (): string => join(configDir, '_secrets_');
function writeSecret(file: string, content: string): void {
  mkdirSync(secrets(), { recursive: true });
  writeFileSync(join(secrets(), file), content);
}
const tokenFile = (relayUrl: string, token: string): string => JSON.stringify({ relayUrl, token, label: 'l', claimedAt: 'x' });
const identity = (): string => JSON.stringify({ v: 1, uuid: 'u', name: 'alpha', createdAt: 'x', publicKey: 'PUBKEY-VALUE', privateKey: 'PRIVATE-KEY-SECRET' });

/** Every file under `dir` with its size and mtime: a read-only route leaves this unchanged. */
function listing(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(`${p}|${statSync(p).size}|${statSync(p).mtimeMs}`);
    }
  };
  walk(dir);
  return out.sort();
}

describe('GET /health', () => {
  it('is registered and answers 200', async () => {
    expect((await health()).status).toBe(200);
  });

  it('answers the ok case: a configured machine with a relay that answers and no daemon running', async () => {
    const port = await listen((url, auth) => (url === '/api/whoami' && auth === `Bearer ${MACHINE_TOKEN}` ? { status: 200, body: { scopes: ['machine'] } } : { status: 401, body: {} }));
    const url = `http://127.0.0.1:${port}`;
    writeSecret('identity.json', identity());
    writeSecret('relay.json', tokenFile(url, MACHINE_TOKEN));
    writeSecret('relay-admin.json', tokenFile(url, MACHINE_TOKEN));
    const { status, body } = await health();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.checks.map((c) => c.name)).toEqual(['config-dir', 'identity', 'config-files', 'relay', 'admin-token', 'daemon']);
    expect(check(body, 'identity').detail).toContain('alpha');
    expect(check(body, 'relay').detail).toContain('reachable');
    expect(check(body, 'admin-token').detail).toContain('machine');
    expect(check(body, 'daemon').detail).toContain('not running');
    for (const c of body.checks) expect(c.ok).toBe(true);
  });

  it('config-dir: a missing folder is ok:false with `machine setup`, and the module still answers', async () => {
    removeTempDir(configDir);
    const { status, body } = await health();
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(check(body, 'config-dir').ok).toBe(false);
    expect(check(body, 'config-dir').detail).toContain('machine setup');
    expect(check(body, 'config-dir').detail).toContain(configDir);
  });

  it('config-dir: a path that is a file is ok:false', async () => {
    removeTempDir(configDir);
    writeFileSync(configDir, 'x');
    const { body } = await health();
    expect(check(body, 'config-dir').ok).toBe(false);
    expect(check(body, 'config-dir').detail).toContain('not a directory');
  });

  it('identity: missing is ok:false with `machine setup`', async () => {
    const { body } = await health();
    expect(check(body, 'identity').ok).toBe(false);
    expect(check(body, 'identity').detail).toContain('machine setup');
  });

  it('identity: a corrupt file is ok:false naming the file, and no key material is printed', async () => {
    writeSecret('identity.json', '{ nope PRIVATE-KEY-SECRET');
    const { body } = await health();
    expect(check(body, 'identity').ok).toBe(false);
    expect(check(body, 'identity').detail).toContain(join(secrets(), 'identity.json'));
    expect(JSON.stringify(body)).not.toContain('PRIVATE-KEY-SECRET');
  });

  it('identity: a name that is not a string is ok:false', async () => {
    writeSecret('identity.json', JSON.stringify({ name: 3 }));
    expect(check((await health()).body, 'identity').ok).toBe(false);
  });

  it('relay: no relay.json is ok:true "not joined" (informational)', async () => {
    writeSecret('identity.json', identity());
    const { body } = await health();
    expect(check(body, 'relay').ok).toBe(true);
    expect(check(body, 'relay').detail).toContain('not joined');
    expect(body.ok).toBe(true);
  });

  it('relay: a corrupt relay.json is ok:false with the path and the fix, and the overall answer is ok:false', async () => {
    writeSecret('identity.json', identity());
    writeSecret('relay.json', '{ not json');
    const { body } = await health();
    expect(body.ok).toBe(false);
    expect(check(body, 'relay').ok).toBe(false);
    expect(check(body, 'relay').detail).toContain(join(secrets(), 'relay.json'));
    expect(check(body, 'relay').detail).toContain('machine join');
  });

  it('relay: a relay.json without token is ok:false', async () => {
    writeSecret('relay.json', JSON.stringify({ relayUrl: 'https://example.invalid' }));
    expect(check((await health()).body, 'relay').ok).toBe(false);
  });

  it('relay: a relay that is down is ok:true with "relay unreachable: <cause>" (an update cannot fix it)', async () => {
    const port = await listen(() => ({ status: 200, body: {} }));
    const url = `http://127.0.0.1:${port}`;
    await new Promise<void>((resolve) => { (servers.pop() as Server).close(() => resolve()); });
    writeSecret('identity.json', identity());
    writeSecret('relay.json', tokenFile(url, MACHINE_TOKEN));
    const { body } = await health();
    expect(check(body, 'relay').ok).toBe(true);
    expect(check(body, 'relay').detail).toMatch(/^relay unreachable: /);
    expect(body.ok).toBe(true);
    expect(JSON.stringify(body)).not.toContain(MACHINE_TOKEN);
  });

  it('relay: a relay that does not answer within the short timeout is ok:true "relay unreachable", and the route stays fast', async () => {
    const port = await listen(() => 'hang');
    writeSecret('identity.json', identity());
    writeSecret('relay.json', tokenFile(`http://127.0.0.1:${port}`, MACHINE_TOKEN));
    const started = Date.now();
    const { body } = await health();
    expect(Date.now() - started).toBeLessThan(4000);
    expect(check(body, 'relay').ok).toBe(true);
    expect(check(body, 'relay').detail).toMatch(/^relay unreachable: /);
  });

  it('relay: a refused token is ok:true with the advice (an update cannot fix it)', async () => {
    const port = await listen(() => ({ status: 401, body: { error: 'invalid_token' } }));
    writeSecret('identity.json', identity());
    writeSecret('relay.json', tokenFile(`http://127.0.0.1:${port}`, MACHINE_TOKEN));
    const { body } = await health();
    expect(check(body, 'relay').ok).toBe(true);
    expect(check(body, 'relay').detail).toContain('refused');
  });

  it('relay: a relay without /api/whoami (404) is reachable', async () => {
    const port = await listen(() => ({ status: 404, body: {} }));
    writeSecret('relay.json', tokenFile(`http://127.0.0.1:${port}`, MACHINE_TOKEN));
    expect(check((await health()).body, 'relay').detail).toContain('reachable');
  });

  it('admin-token: absent is informational', async () => {
    const { body } = await health();
    expect(check(body, 'admin-token').ok).toBe(true);
    expect(check(body, 'admin-token').detail).toContain('machine admin login');
  });

  it('admin-token: shows the scopes the relay reports, never the token', async () => {
    const port = await listen((_u, auth) => (auth === `Bearer ${ADMIN_TOKEN}` ? { status: 200, body: { scopes: ['machine-admin'] } } : { status: 401, body: {} }));
    writeSecret('relay-admin.json', tokenFile(`http://127.0.0.1:${port}`, ADMIN_TOKEN));
    const { body } = await health();
    expect(check(body, 'admin-token').ok).toBe(true);
    expect(check(body, 'admin-token').detail).toContain('machine-admin');
    expect(JSON.stringify(body)).not.toContain(ADMIN_TOKEN);
  });

  it('admin-token: full access (scopes null) is said so', async () => {
    const port = await listen(() => ({ status: 200, body: { scopes: null } }));
    writeSecret('relay-admin.json', tokenFile(`http://127.0.0.1:${port}`, ADMIN_TOKEN));
    expect(check((await health()).body, 'admin-token').detail).toContain('full access');
  });

  it('admin-token: a corrupt file is ok:false with the path and the fix', async () => {
    writeSecret('relay-admin.json', '[]');
    const { body } = await health();
    expect(body.ok).toBe(false);
    expect(check(body, 'admin-token').ok).toBe(false);
    expect(check(body, 'admin-token').detail).toContain(join(secrets(), 'relay-admin.json'));
    expect(check(body, 'admin-token').detail).toContain('machine admin login');
  });

  it('admin-token: a relay url over plain http to a remote host is ok:false (invalid config)', async () => {
    writeSecret('relay-admin.json', tokenFile('http://example.invalid', ADMIN_TOKEN));
    expect(check((await health()).body, 'admin-token').ok).toBe(false);
  });

  it('config-files: a corrupt network file is ok:false with its path and the fix', async () => {
    writeSecret('identity.json', identity());
    writeSecret('peers.json', '{ broken');
    writeFileSync(join(configDir, 'policy.json'), 'also broken');
    const { body } = await health();
    expect(body.ok).toBe(false);
    const c = check(body, 'config-files');
    expect(c.ok).toBe(false);
    expect(c.detail).toContain(join(secrets(), 'peers.json'));
    expect(c.detail).toContain(join(configDir, 'policy.json'));
    expect(c.detail).toContain('machine');
  });

  it('config-files: absent network files are fine', async () => {
    expect(check((await health()).body, 'config-files').ok).toBe(true);
  });

  it('daemon: the answer is information and never fails the health', async () => {
    const port = await listen((url, auth) => (auth === `Bearer ${DAEMON_TOKEN}` && url === '/status' ? { status: 200, body: { result: { initialized: true, name: 'alpha', peers: 2 } } } : { status: 401, body: {} }));
    writeFileSync(join(configDir, 'daemon.port.json'), JSON.stringify({ pid: 1, port }));
    writeFileSync(join(configDir, 'health_token'), DAEMON_TOKEN);
    const up = check((await health()).body, 'daemon');
    expect(up.ok).toBe(true);
    expect(up.detail).toContain('answers');
    expect(JSON.stringify(up)).not.toContain(DAEMON_TOKEN);
    writeFileSync(join(configDir, 'health_token'), 'wrong');
    const refused = check((await health()).body, 'daemon');
    expect(refused.ok).toBe(true);
    expect(refused.detail).toContain('refused');
  });

  it('writes nothing: the config folder listing (names, sizes, mtimes) is the same after the call', async () => {
    const port = await listen(() => ({ status: 200, body: { scopes: ['machine'] } }));
    const url = `http://127.0.0.1:${port}`;
    writeSecret('identity.json', identity());
    writeSecret('relay.json', tokenFile(url, MACHINE_TOKEN));
    writeSecret('relay-admin.json', tokenFile(url, ADMIN_TOKEN));
    writeSecret('peers.json', '{ broken');
    const before = listing(configDir);
    const contents = readFileSync(join(secrets(), 'relay.json'), 'utf8');
    await health();
    expect(listing(configDir)).toEqual(before);
    expect(readFileSync(join(secrets(), 'relay.json'), 'utf8')).toBe(contents);
  });

  it('creates nothing when the config folder is missing', async () => {
    removeTempDir(configDir);
    await health();
    expect(() => statSync(configDir)).toThrow();
  });

  it('never contains any secret value, whatever the state', async () => {
    const port = await listen(() => ({ status: 200, body: { scopes: ['machine'], token: 'RELAY-ECHO-SECRET' } }));
    const url = `http://127.0.0.1:${port}`;
    writeSecret('identity.json', identity());
    writeSecret('relay.json', tokenFile(url, MACHINE_TOKEN));
    writeSecret('relay-admin.json', tokenFile(url, ADMIN_TOKEN));
    const text = JSON.stringify((await health()).body);
    for (const secret of [MACHINE_TOKEN, ADMIN_TOKEN, 'PRIVATE-KEY-SECRET', 'PUBKEY-VALUE', 'RELAY-ECHO-SECRET']) expect(text).not.toContain(secret);
  });
});
