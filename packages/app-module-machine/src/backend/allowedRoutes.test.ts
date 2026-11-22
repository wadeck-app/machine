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
  it('one block per machine: name, version, mode, when signed, the lists and the entries as text', () => {
    const page = allowedPage(daemonAnswer(), NOW);
    expect(page.machine).toEqual(SELF);
    const [self, peer] = page.machines;
    expect(self).toMatchObject({ name: 'desktop', isSelf: true, source: 'installed', mode: 'admin', version: 4, signedText: expect.stringMatching(/10 min ago/) });
    expect(self?.lists[0]?.entries.map((e) => [e.index, e.shell, e.text, e.lifetimeText])).toEqual([[1, 'sh', 'echo 1', 'permanent'], [2, 'sh', 'echo 2', '3 of 5 calls left']]);
    expect(peer).toMatchObject({ name: 'laptop', source: 'signed-here', version: 2, signedText: expect.stringMatching(/2 h ago/) });
    expect(peer?.lists.map((l) => l.title)).toEqual(['Default list (every trusted peer without a list of its own)', 'Only for desktop (its own list, it replaces the default)']);
  });

  it('says the list is what the admin signed here when it is, with the wording of `machine allowed`; says "not shown" with the reason for the calls left of such a list', () => {
    const peer = allowedPage(daemonAnswer(), NOW).machines[1];
    expect(peer?.deliveryNote).toBe(REMOTE_LINE);
    expect(peer?.sourceText).toMatch(/signed here by the admin.*may differ from what is installed on laptop/);
    const limited = peer?.lists[0]?.entries[0];
    expect(limited).toMatchObject({ lifetimeText: '3 calls', limitNote: 'calls left: not shown, the counter is kept on laptop' });
    // An installed list shows the calls left and needs no note.
    expect(allowedPage(daemonAnswer(), NOW).machines[0]?.lists[0]?.entries[1]?.limitNote).toBe('');
  });

  it('counts the entries and the machines that hold a list', () => {
    const page = allowedPage(daemonAnswer(), NOW);
    expect(page).toMatchObject({ entryCount: 4, machineCount: 2, summary: '4 entries on 2 machines' });
    expect(allowedPage(daemonAnswer({ machines: [] }), NOW).summary).toBe('0 entries on 0 machines');
    const single = daemonAnswer();
    (single['machines'] as any[]).splice(1);
    (single['machines'] as any[])[0].policy.lists[0].entries.splice(1);
    expect(allowedPage(single, NOW).summary).toBe('1 entry on 1 machine');
  });

  it('an empty machine says why and gives the exact command that fills it; an unreadable record says its problem instead of looking empty', () => {
    const [, , nas, box] = allowedPage(daemonAnswer(), NOW).machines;
    expect(nas).toMatchObject({ version: null, lists: [], fillCommand: 'machine admin allow nas -- <command>' });
    expect(nas?.emptyText).toMatch(/No policy was signed on this machine for "nas".*only policies signed on this machine are on record/);
    expect(box?.problem).toMatch(/delete it/);
    expect(box?.emptyText).toBe('');
  });

  it('shows the entry text as text, unchanged (the component never renders HTML)', () => {
    expect(allowedPage(daemonAnswer(), NOW).machines[1]?.lists[0]?.entries[0]?.text).toBe('<img src=x onerror=alert(1)>');
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

  it('a list with a peer and an installed policy of mode local says who manages it', () => {
    const answer = daemonAnswer() as any;
    answer.machines[0].mode = 'local';
    expect(allowedPage(answer, NOW).machines[0]?.sourceText).toMatch(/installed on this machine.*mode local/);
  });
});

describe('GET /allowed', () => {
  it('is a plain read route', () => {
    const route = routes().get('GET /allowed');
    expect(route).toBeDefined();
    expect(route?.options === undefined || (route.options as { effect?: string }).effect === 'read').toBe(true);
  });

  it('asks the daemon command allowed once and answers the page, with the one-line note on how to change the list today', async () => {
    const seen = await withDaemon(daemonAnswer());
    const r = await call();
    expect(r.status).toBe(200);
    expect(seen).toEqual(['allowed']);
    expect(r.body.summary).toBe('4 entries on 2 machines');
    expect(r.body.changeNote).toBe('Read-only. To change a list today: `machine admin allow <machine> -- <command>` on the admin machine, `machine policy allow -- <command>` on a machine that manages its own list, or the Requests page for a request that is held.');
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
