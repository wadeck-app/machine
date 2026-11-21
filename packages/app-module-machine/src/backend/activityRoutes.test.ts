import { createServer, type Server } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildActivity, type RunLogEntry } from '@wadeck-app/machine-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activityPage, activityQueryOf } from './activity.js';
import register from './index.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

// The Activity page (run-log.md): the commands this machine sent and received, through the daemon command `activity`.

const DAEMON_TOKEN = 'daemon-health-token-value';
const SELF = { name: 'desktop', uuid: '11111111-1111-4111-8111-111111111111' };
const PEER = { name: 'laptop', uuid: '22222222-2222-4222-8222-222222222222' };
const NOW = Math.floor(Date.now() / 1000);

type Handler = (req: unknown, reply: Reply) => unknown;
interface Reply { code(status: number): Reply; send(body: unknown): unknown }
interface Registered { handler: Handler; options: unknown }

let configDir: string;
let servers: Server[];
let previous: string | undefined;

beforeEach(() => {
  configDir = makeTempDir('app-module-machine-activity-');
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

async function call(query: Record<string, unknown> = {}): Promise<{ status: number; body: any }> {
  const route = routes().get('GET /activity');
  if (route === undefined) {
    throw new Error('route not registered: GET /activity');
  }
  let status = 200;
  let sent: unknown;
  const reply: Reply = { code(s) { status = s; return reply; }, send(b) { sent = b; return b; } };
  await route.handler({ headers: {}, params: {}, query, body: undefined }, reply);
  return { status, body: sent };
}

async function withDaemon(answer: unknown): Promise<Array<{ command: string; body: unknown }>> {
  const seen: Array<{ command: string; body: unknown }> = [];
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (c: Buffer) => { text += c.toString(); });
    req.on('end', () => {
      const command = (req.url ?? '').slice(1);
      seen.push({ command, body: text === '' ? undefined : JSON.parse(text) });
      const known = req.headers.authorization === `Bearer ${DAEMON_TOKEN}` && command === 'activity';
      res.writeHead(known ? 200 : 404, { 'content-type': 'application/json' });
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

function sent(minutesAgo: number, over: Partial<RunLogEntry> = {}): RunLogEntry {
  return { v: 1, ts: new Date((NOW - minutesAgo * 60) * 1000).toISOString(), runId: `run-${minutesAgo}`, from: SELF, to: PEER, shell: 'sh', command: 'ls -l', truncated: false, waitMode: 'default', onRefusal: 'wait', waitSeconds: 600, waitedSeconds: 0, outcome: 'ran', exitCode: 0, durationMs: 1500, ...over };
}

/** What the daemon answers: the real reader of machine-core over a few sent runs. */
function daemonAnswer(entries: RunLogEntry[], filter = {}): unknown {
  const page = buildActivity({ self: SELF, sent: entries, auditLines: [], nameOf: () => undefined, filter });
  return { initialized: true, ok: true, self: SELF, now: NOW, page, runLog: { dir: '/x/run-log', files: 1, damagedLines: 0 }, auditLogFile: '/x/audit.log', auditLogPresent: false, machines: ['laptop'] };
}

describe('activityQueryOf', () => {
  it('keeps the known text fields and drops the empty ones', () => {
    expect(activityQueryOf({ direction: 'sent', machine: '', outcome: 'ran', since: '7d', text: 'ls', limit: '25', offset: '50' })).toEqual({ direction: 'sent', outcome: 'ran', since: '7d', text: 'ls', limit: '25', offset: '50' });
  });

  it('refuses a field it does not know, naming it (a typo in a filter is not ignored)', () => {
    expect(() => activityQueryOf({ directon: 'sent' })).toThrow(/"directon".*direction, machine, outcome, since, text, limit, offset/);
  });

  it('refuses a repeated field (an array)', () => {
    expect(() => activityQueryOf({ outcome: ['ran', 'denied'] })).toThrow(/"outcome".*once/);
  });
});

describe('activityPage', () => {
  it('turns the timeline into rows a page can show: who to whom, ages, outcome with its tone', () => {
    const page = activityPage(daemonAnswer([sent(5), sent(10, { outcome: 'refused', reason: 'not-listed' }), sent(20, { outcome: 'ran', exitCode: 3 })]), NOW);
    expect(page.rows.map((r) => [r.fromText, r.toText, r.directionText, r.outcomeText, r.tone])).toEqual([
      ['desktop', 'laptop', 'Sent', 'ran (exit 0)', 'success'],
      ['desktop', 'laptop', 'Sent', 'refused (not-listed)', 'warning'],
      ['desktop', 'laptop', 'Sent', 'ran (exit 3)', 'warning'],
    ]);
    expect(page.rows[0]).toMatchObject({ whenText: '5 min ago', shell: 'sh', command: 'ls -l', detailText: expect.stringContaining('1.5 s') });
    expect(page).toMatchObject({ total: 3, offset: 0, hasMore: false, counts: { sent: 3, received: 0 }, machines: ['laptop'], machine: SELF });
  });

  it('gives the previous and next offsets of a window', () => {
    const many = Array.from({ length: 12 }, (_, i) => sent(i + 1));
    const page = activityPage(daemonAnswer(many, { limit: 5, offset: 5 }), NOW);
    expect(page).toMatchObject({ total: 12, offset: 5, limit: 5, hasMore: true, nextOffset: 10, prevOffset: 0 });
  });

  it('notes a damaged run log and a broken audit chain', () => {
    const answer = daemonAnswer([sent(1)]) as { runLog: { damagedLines: number }; page: { chain: unknown } };
    answer.runLog.damagedLines = 2;
    answer.page.chain = { ok: false, line: 4, message: 'line 4 was modified', trustedEntries: 3, unverifiedEntries: 5, unreadableLines: 0 };
    const page = activityPage(answer, NOW);
    expect(page.notes.join(' ')).toMatch(/2 damaged line\(s\).*skipped/);
    expect(page.chainText).toMatch(/broken at line 4/);
  });

  it('says what is empty and why', () => {
    expect(activityPage(daemonAnswer([]), NOW).emptyMessage).toMatch(/No activity yet/);
    const filtered = activityPage(daemonAnswer([sent(1)], { outcome: 'denied' }), NOW);
    expect(filtered.rows).toEqual([]);
    expect(filtered.emptyMessage).toMatch(/No entry matches/);
  });

  it('refuses an answer that is not the activity command of this version, with the fix', () => {
    expect(() => activityPage({ unexpected: true }, NOW)).toThrow(/older version.*machine cli update/);
  });
});

describe('GET /activity', () => {
  it('is a plain read route: GET, no PIN, no header', () => {
    const route = routes().get('GET /activity');
    expect(route).toBeDefined();
    expect(route?.options === undefined || (route.options as { effect?: string }).effect === 'read').toBe(true);
  });

  it('forwards the query to the daemon as text and answers the page', async () => {
    const seen = await withDaemon(daemonAnswer([sent(5)]));
    const r = await call({ direction: 'sent', outcome: 'ran', since: '24h', limit: '25', machine: '' });
    expect(r.status).toBe(200);
    expect(seen).toEqual([{ command: 'activity', body: { direction: 'sent', outcome: 'ran', since: '24h', limit: '25' } }]);
    expect(r.body.rows).toHaveLength(1);
  });

  it('answers 400 with the daemon sentence when the query is wrong', async () => {
    await withDaemon({ initialized: true, ok: false, reason: 'bad-query', message: 'outcome "x" is not a choice: use ran, refused' });
    const r = await call({ outcome: 'x' });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ status: 400, kind: 'bad_query', error: expect.stringContaining('outcome "x" is not a choice') });
  });

  it('answers 400 for a field it does not know, before asking the daemon', async () => {
    const seen = await withDaemon(daemonAnswer([]));
    const r = await call({ colour: 'red' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/"colour"/);
    expect(seen).toEqual([]);
  });

  it('answers 409 when the machine is not initialized and 503 when no daemon runs, each with its fix', async () => {
    expect((await call()).status).toBe(503);
    await withDaemon({ initialized: false, message: 'this machine is not initialized: run `machine setup <relay>`' });
    const r = await call();
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ kind: 'not_initialized' });
  });

  it('answers 500 with the cause when a log cannot be read', async () => {
    await withDaemon({ initialized: true, ok: false, reason: 'run-log-unreadable', message: 'cannot read the run log folder /x: EACCES. Fix its permissions' });
    const r = await call();
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ kind: 'run_log_unreadable', error: expect.stringContaining('Fix its permissions') });
  });
});
