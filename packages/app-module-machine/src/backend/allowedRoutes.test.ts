import { createServer, type Server } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowedPage } from './allowed.js';
import register from './index.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

// The Allowed page: what every machine allows, read-only, through the daemon command `allowed` (the data of `machine allowed <machine>`).

const DAEMON_TOKEN = 'daemon-health-token-value';
const NOW = Math.floor(Date.now() / 1000);
const SELF = { uuid: '11111111-1111-4111-8111-111111111111', name: 'desktop' };
const PEER = { uuid: '22222222-2222-4222-8222-222222222222', name: 'laptop' };
const REMOTE_LINE = 'as installed on laptop: ask there with machine policy allow --list (remote view: machine requests/policy views are not built yet)';

type Handler = (req: unknown, reply: Reply) => unknown;
interface Reply { code(status: number): Reply; send(body: unknown): unknown }
interface Registered { handler: Handler; options: unknown }

let configDir: string;
let servers: Server[];
let previous: string | undefined;

beforeEach(() => {
  configDir = makeTempDir('app-module-machine-allowed-');
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

async function call(): Promise<{ status: number; body: any }> {
  const route = routes().get('GET /allowed');
  if (route === undefined) {
    throw new Error('route not registered: GET /allowed');
  }
  let status = 200;
  let sent: unknown;
  const reply: Reply = { code(s) { status = s; return reply; }, send(b) { sent = b; return b; } };
  await route.handler({ headers: {}, params: {}, query: {}, body: undefined }, reply);
  return { status, body: sent };
}

async function withDaemon(answer: unknown, status = 200): Promise<string[]> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    req.on('data', () => undefined);
    req.on('end', () => {
      const command = (req.url ?? '').slice(1);
      seen.push(command);
      const known = req.headers.authorization === `Bearer ${DAEMON_TOKEN}` && command === 'allowed';
      res.writeHead(known ? status : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(known ? { result: answer } : { error: `Unknown command: ${command}` }));
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

const entry = (index: number, over: Record<string, unknown> = {}) => ({ index, shell: 'sh', text: `echo ${index}`, typed: false, lifetime: 'permanent', ...over });

/** What the daemon answers: this machine with an installed policy, the peer with a policy signed here, a third with nothing, a fourth unreadable. */
function daemonAnswer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    initialized: true,
    ok: true,
    self: SELF,
    now: NOW,
    warnings: [],
    machines: [
      { ...SELF, isSelf: true, source: 'installed', mode: 'admin', fillCommand: 'machine admin allow desktop -- <command>', policy: { version: 4, issuedAt: NOW - 600, lists: [{ scope: 'default', entries: [entry(1), entry(2, { maxCalls: 5, used: 2, lifetime: '3 of 5 calls left' })] }] } },
      { ...PEER, isSelf: false, source: 'signed-here', mode: 'admin', fillCommand: 'machine admin allow laptop -- <command>', remoteViewLine: REMOTE_LINE, policy: { version: 2, issuedAt: NOW - 7200, lists: [{ scope: 'default', entries: [entry(1, { text: '<img src=x onerror=alert(1)>', maxCalls: 3, lifetime: '3 calls' })] }, { scope: 'peer', peer: { uuid: SELF.uuid, name: 'desktop' }, entries: [entry(1, { expiresAt: NOW + 3600, lifetime: 'until 2026-11-22 23:00' })] }] } },
      { uuid: '33333333-3333-4333-8333-333333333333', name: 'nas', isSelf: false, source: 'signed-here', mode: 'admin', fillCommand: 'machine admin allow nas -- <command>', remoteViewLine: 'as installed on nas: ask there', policy: null },
      { uuid: '44444444-4444-4444-8444-444444444444', name: 'box', isSelf: false, source: 'signed-here', mode: 'admin', fillCommand: 'machine admin allow box -- <command>', policy: null, problem: '/x/policies/44.json is not a valid policy record (bad json): delete it, the next policy is then built from nothing' },
    ],
    ...over,
  };
}

describe('allowedPage', () => {
  it('one row per entry, flat per machine (the table of its tab): shell, text as signed, lifetime, the list it belongs to and its place', () => {
    const page = allowedPage(daemonAnswer(), NOW);
    expect(page.machine).toEqual(SELF);
    const [self, peer] = page.machines;
    expect(self).toMatchObject({ name: 'desktop', isSelf: true, source: 'installed', mode: 'admin', version: 4, signedText: expect.stringMatching(/10 min ago/) });
    expect(self?.entries.map((e) => [e.index, e.shell, e.text, e.lifetimeText])).toEqual([[1, 'sh', 'echo 1', 'permanent'], [2, 'sh', 'echo 2', '3 of 5 calls left']]);
    expect(peer?.entries.map((e) => [e.listLabel, e.index])).toEqual([['default', 1], ['only for desktop', 1]]);
    expect(peer?.entries.map((e) => e.key)).toEqual(['0:0', '1:0']);
    expect(peer?.entries[1]?.listTitle).toBe('Only for desktop (its own list, it replaces the default)');
    expect(peer).toMatchObject({ name: 'laptop', source: 'signed-here', version: 2, signedText: expect.stringMatching(/2 h ago/) });
  });

  it('has no summary and no change note any more: the page carries only counts', () => {
    const page = allowedPage(daemonAnswer(), NOW) as unknown as Record<string, unknown>;
    expect(page).toMatchObject({ entryCount: 4, machineCount: 2 });
    expect(page['summary']).toBeUndefined();
    expect(page['changeNote']).toBeUndefined();
  });

  it('a list signed here: the short source line says it may differ, the delivery note is kept for the expansion, and the calls left are not shown with the reason', () => {
    const peer = allowedPage(daemonAnswer(), NOW).machines[1];
    expect(peer?.deliveryNote).toBe(REMOTE_LINE);
    expect(peer?.sourceText).toBe('Signed here, may differ from what laptop has installed until it is delivered');
    expect(peer?.entries[0]).toMatchObject({ lifetimeText: '3 calls', limitNote: 'calls left: not shown, the counter is kept on laptop' });
    expect(allowedPage(daemonAnswer(), NOW).machines[0]?.entries[1]?.limitNote).toBe('');
    expect(allowedPage(daemonAnswer(), NOW).machines[0]?.sourceText).toBe('In force on this machine (mode admin)');
  });

  it('last use of an installed entry: the date (seconds), the age text and a sort key; the sort key of an unknown value is -1 (the oldest)', () => {
    const answer = daemonAnswer() as any;
    answer.machines[0].lastUse = { scanned: 10, damaged: 0, complete: true };
    answer.machines[0].policy.lists[0].entries[0].lastUsedAt = NOW - 7200;
    const [first, second] = allowedPage(answer, NOW).machines[0]?.entries ?? [];
    expect(first).toMatchObject({ lastUsedAt: NOW - 7200, lastUsedSort: NOW - 7200, lastUsedText: '2 h ago', lastUsedNote: '' });
    expect(second).toMatchObject({ lastUsedAt: null, lastUsedSort: -1, lastUsedText: 'never' });
    expect(second?.lastUsedNote).toBe('No accepted use in the audit log of this machine (10 lines read).');
  });

  it('a scan stopped by its bound does not say "never": it says how far it looked', () => {
    const answer = daemonAnswer() as any;
    answer.machines[0].lastUse = { scanned: 400000, damaged: 0, complete: false };
    const second = allowedPage(answer, NOW).machines[0]?.entries[1];
    expect(second?.lastUsedText).toBe('not in the last 400000 lines');
    expect(second?.lastUsedNote).toMatch(/older uses are not read/);
  });

  it('damaged audit lines are said in the note of an unused entry, never skipped silently', () => {
    const answer = daemonAnswer() as any;
    answer.machines[0].lastUse = { scanned: 10, damaged: 2, complete: true };
    expect(allowedPage(answer, NOW).machines[0]?.entries[1]?.lastUsedNote).toMatch(/2 damaged line\(s\) were skipped/);
  });

  it('installed policy without a scan result (audit log unreadable, or an older daemon): "not read", with the two causes and their fix', () => {
    const second = allowedPage(daemonAnswer(), NOW).machines[0]?.entries[1];
    expect(second).toMatchObject({ lastUsedAt: null, lastUsedSort: -1, lastUsedText: 'not read' });
    expect(second?.lastUsedNote).toMatch(/no reading of the audit log.*warnings.*older than this page.*machine cli update/);
  });

  it('a list signed here for another machine: "not known here" with the reason, never a date', () => {
    const entries = allowedPage(daemonAnswer(), NOW).machines[1]?.entries ?? [];
    expect(entries.every((e) => e.lastUsedAt === null && e.lastUsedSort === -1 && e.lastUsedText === 'not known here')).toBe(true);
    expect(entries[0]?.lastUsedNote).toBe('The audit log that records the uses is on laptop: only that machine knows when this command last ran.');
  });

  it('the terminal command that withdraws an entry, today: admin mode names the admin machine, local mode this one, a per-peer list of an admin policy has none', () => {
    const page = allowedPage(daemonAnswer(), NOW);
    expect(page.machines[0]?.entries[1]?.removeCommand).toBe('machine admin allow desktop --remove --index 2');
    expect(page.machines[1]?.entries[0]?.removeCommand).toBe('machine admin allow laptop --remove --index 1');
    expect(page.machines[1]?.entries[1]?.removeCommand).toBe('');
    const local = daemonAnswer() as any;
    local.machines[0].mode = 'local';
    local.machines[0].fillCommand = 'machine policy allow -- <command>';
    local.machines[0].policy.lists.push({ scope: 'peer', peer: { uuid: PEER.uuid, name: 'laptop' }, entries: [entry(1)] });
    const mine = allowedPage(local, NOW).machines[0];
    expect(mine?.entries[1]?.removeCommand).toBe('machine policy allow --remove --index 2');
    expect(mine?.entries[2]?.removeCommand).toBe('machine policy allow --peer laptop --remove --index 1');
  });

  it('an empty machine says why and gives the exact command that fills it; an unreadable record says its problem instead of looking empty', () => {
    const [, , nas, box] = allowedPage(daemonAnswer(), NOW).machines;
    expect(nas).toMatchObject({ version: null, entries: [], fillCommand: 'machine admin allow nas -- <command>' });
    expect(nas?.emptyText).toMatch(/No policy was signed on this machine for "nas".*only policies signed on this machine are on record/);
    expect(box?.problem).toMatch(/delete it/);
    expect(box?.emptyText).toBe('');
  });

  it('shows the entry text as text, unchanged (the component never renders HTML)', () => {
    expect(allowedPage(daemonAnswer(), NOW).machines[1]?.entries[0]?.text).toBe('<img src=x onerror=alert(1)>');
  });

  it('keeps only the fields of the page: a signature, a key or any other field of the daemon answer is not copied', () => {
    const answer = daemonAnswer() as any;
    answer.machines[1].signature = 'SIG-RAW-AAAA';
    answer.machines[1].policy.signature = 'SIG-RAW-BBBB';
    answer.machines[1].policy.lists[0].entries[0].secret = 'SECRET-CCCC';
    answer.adminKey = 'KEY-DDDD';
    const text = JSON.stringify(allowedPage(answer, NOW));
    for (const leak of ['SIG-RAW', 'SECRET-CCCC', 'KEY-DDDD']) {
      expect(text).not.toContain(leak);
    }
  });

  it('refuses an answer that is not the allowed command of this version, with the fix', () => {
    expect(() => allowedPage({ unexpected: true }, NOW)).toThrow(/older version.*machine cli update/);
  });
});

describe('GET /allowed', () => {
  it('is a plain read route', () => {
    const route = routes().get('GET /allowed');
    expect(route).toBeDefined();
    expect(route?.options === undefined || (route.options as { effect?: string }).effect === 'read').toBe(true);
  });

  it('asks the daemon command allowed once and answers the page', async () => {
    const seen = await withDaemon(daemonAnswer());
    const r = await call();
    expect(r.status).toBe(200);
    expect(seen).toEqual(['allowed']);
    expect(r.body).toMatchObject({ entryCount: 4, machineCount: 2 });
    expect(r.body.changeNote).toBeUndefined();
  });

  it('the page never contains the raw policy signature or a secret, even when the daemon answer carries them', async () => {
    const answer = daemonAnswer() as any;
    answer.machines[1].policy.signature = 'SIG-RAW-AAAA';
    answer.adminPrivateKey = 'PRIVATE-KEY-BBBB';
    await withDaemon(answer);
    const r = await call();
    expect(r.status).toBe(200);
    const text = JSON.stringify(r.body);
    expect(text).not.toMatch(/SIG-RAW|PRIVATE-KEY|signature|passphrase|health_token/i);
    expect(text).not.toContain(DAEMON_TOKEN);
  });

  it('not initialized: 409 with the fix', async () => {
    await withDaemon({ initialized: false, message: 'this machine is not initialized: run `machine setup <relay>`' });
    const r = await call();
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ kind: 'not_initialized', error: expect.stringContaining('machine setup') });
  });

  it('daemon not running: 503 with the fix, never an empty list', async () => {
    const r = await call();
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ kind: 'daemon_unreachable', error: expect.stringContaining('machine daemon') });
  });

  it('an older daemon that does not know the command: 502 that says to update it', async () => {
    const server = createServer((req, res) => {
      req.on('data', () => undefined);
      req.on('end', () => { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Unknown command: allowed' })); });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    writeFileSync(join(configDir, 'daemon.port.json'), JSON.stringify({ pid: process.pid, port: address.port, peerPort: 1 }));
    writeFileSync(join(configDir, 'health_token'), DAEMON_TOKEN);
    const r = await call();
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/older than this module.*machine cli update/);
  });
});
