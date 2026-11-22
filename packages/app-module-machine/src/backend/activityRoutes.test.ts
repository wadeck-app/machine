import { createServer, type Server } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildActivity, type ActivityFilter, type RunLogEntry } from '@wadeck-app/machine-core';
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

/** What the daemon answers: the real reader of machine-core over a few sent runs (the run log, newest line first). */
function daemonAnswer(entries: RunLogEntry[], filter: ActivityFilter = {}): unknown {
  const lines = [...entries].sort((a, b) => Date.parse(a.ts) + a.durationMs - (Date.parse(b.ts) + b.durationMs)).map((e) => JSON.stringify(e)).reverse();
  const page = buildActivity({ self: SELF, sources: { sentLines: () => lines, auditLines: () => [] }, nameOf: () => undefined, filter });
  return { initialized: true, ok: true, self: SELF, now: NOW, page, runLog: { dir: '/x/run-log', files: 1, damagedLines: 0, recounted: [] }, auditDamagedLines: 0, auditLogFile: '/x/audit.log', auditLogPresent: false, machines: ['laptop'] };
}

describe('activityQueryOf', () => {
  it('keeps the known text fields and drops the empty ones', () => {
    expect(activityQueryOf({ direction: 'sent', machine: '', outcome: 'ran', since: '7d', text: 'ls', limit: '25', offset: '50', page: '2', pageSize: '50' })).toEqual({ direction: 'sent', outcome: 'ran', since: '7d', text: 'ls', limit: '25', offset: '50', page: '2', pageSize: '50' });
  });

  it('refuses a field it does not know, naming it (a typo in a filter is not ignored)', () => {
    expect(() => activityQueryOf({ directon: 'sent' })).toThrow(/"directon".*direction, machine, outcome, since, text, limit, offset, page, pageSize/);
  });

  it('refuses a repeated field (an array)', () => {
    expect(() => activityQueryOf({ outcome: ['ran', 'denied'] })).toThrow(/"outcome".*once/);
  });
});

describe('activityPage', () => {
  it('turns the timeline into rows a page can show: who to whom, ages, result with its tone', () => {
    const page = activityPage(daemonAnswer([sent(5), sent(10, { outcome: 'refused', reason: 'not-listed' }), sent(20, { outcome: 'ran', exitCode: 3 })]), NOW);
    expect(page.rows.map((r) => [r.fromText, r.toText, r.directionText, r.resultText, r.tone])).toEqual([
      ['desktop', 'laptop', 'Sent', 'ran', 'success'],
      ['desktop', 'laptop', 'Sent', 'refused (not-listed)', 'warning'],
      ['desktop', 'laptop', 'Sent', 'ran', 'warning'],
    ]);
    expect(page.rows[0]).toMatchObject({ whenText: '5 min ago', shell: 'sh', command: 'ls -l' });
    expect(page).toMatchObject({ total: 3, totalExact: true, page: 1, pageSize: 50, pageCount: 1, counts: { sent: 3, received: 0 }, machines: ['laptop'], machine: SELF });
  });

  it('gives the exit code its own cell: green for 0, red for any other code, a timeout or a kill, a dash when nothing ran', () => {
    const page = activityPage(daemonAnswer([
      sent(1, { exitCode: 0 }),
      sent(2, { exitCode: 127 }),
      sent(3, { exitCode: null, timedOut: true }),
      sent(4, { exitCode: null }),
      sent(5, { outcome: 'denied', reason: 'denied', exitCode: undefined }),
    ]), NOW);
    expect(page.rows.map((r) => [r.exitText, r.exitTone])).toEqual([['0', 'ok'], ['127', 'fail'], ['timed out', 'fail'], ['killed', 'fail'], ['-', 'none']]);
  });

  it('shows the run time of the command apart from the wait, and marks an estimate', () => {
    const page = activityPage(daemonAnswer([
      sent(1, { durationMs: 107_300, waitedSeconds: 107, execMs: 312 }),
      sent(2, { durationMs: 107_300, waitedSeconds: 107 }),
      sent(3, { durationMs: 1_500 }),
      sent(4, { outcome: 'refused', reason: 'not-listed', exitCode: undefined, durationMs: 90_000, waitedSeconds: 90 }),
    ]), NOW);
    const [recorded, derived, quick, refused] = page.rows;
    expect(recorded).toMatchObject({ ranText: '312 ms', ranDerived: false, waitedText: '1 min 47 s' });
    expect(recorded?.ranTitle).toMatch(/Run time of the command.*whole run 1 min 47 s/);
    expect(derived).toMatchObject({ ranText: '~300 ms', ranDerived: true, waitedText: '1 min 47 s' });
    expect(derived?.ranTitle).toMatch(/Estimated.*whole run minus the wait/);
    expect(quick).toMatchObject({ ranText: '~1.5 s', waitedText: '-' });
    expect(refused).toMatchObject({ ranText: '-', waitedText: '1 min 30 s' });
  });

  it('gives the page, the page size and the page count, and says when the total is a lower bound', () => {
    const many = Array.from({ length: 12 }, (_, i) => sent(i + 1));
    const page = activityPage(daemonAnswer(many, { limit: 5, offset: 5, page: 2 }), NOW);
    expect(page).toMatchObject({ total: 12, totalExact: true, page: 2, pageSize: 5, pageCount: 3, pageSizes: [25, 50, 100] });
    const answer = daemonAnswer(many, { limit: 5 }) as { page: { totalExact: boolean } };
    answer.page.totalExact = false;
    expect(activityPage(answer, NOW).totalExact).toBe(false);
  });

  it('notes a damaged run log, damaged audit lines, a recount and a broken audit chain', () => {
    const answer = daemonAnswer([sent(1)]) as { runLog: { damagedLines: number; recounted: string[] }; auditDamagedLines: number; page: { chain: unknown } };
    answer.runLog.damagedLines = 2;
    answer.runLog.recounted = ['the run log file /x changed other than by appending: its entries were recounted from the start'];
    answer.auditDamagedLines = 1;
    answer.page.chain = { scope: 'window', ok: false, line: 4, message: 'audit log line 4 was modified', checkedLines: 9 };
    const page = activityPage(answer, NOW);
    expect(page.notes.join(' ')).toMatch(/2 damaged line\(s\).*skipped/);
    expect(page.notes.join(' ')).toMatch(/1 damaged line\(s\) of the audit log/);
    expect(page.notes.join(' ')).toMatch(/recounted/);
    expect(page.chainText).toMatch(/broken at line 4.*9 lines read for this page/);
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
    const r = await call({ direction: 'sent', outcome: 'ran', since: '24h', page: '2', pageSize: '50', machine: '' });
    expect(r.status).toBe(200);
    expect(seen).toEqual([{ command: 'activity', body: { direction: 'sent', outcome: 'ran', since: '24h', page: '2', pageSize: '50' } }]);
    expect(r.body.rows).toHaveLength(1);
    expect(r.body).toMatchObject({ total: 1, totalExact: true, page: 1, pageSize: 50 });
  });

  it('asks for pages of 25 when the query names no size, so a page never depends on the daemon default', async () => {
    const seen = await withDaemon(daemonAnswer([sent(5)]));
    await call({ outcome: 'ran' });
    expect(seen).toEqual([{ command: 'activity', body: { outcome: 'ran', pageSize: '25' } }]);
  });

  it('answers 400 naming the last page when a page past the end is asked', async () => {
    await withDaemon({ initialized: true, ok: false, reason: 'bad-query', message: 'page 9 is beyond the last page (2): 30 entries match at 25 per page. Ask for a page from 1 to 2' });
    const r = await call({ page: '9', pageSize: '25' });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ kind: 'bad_query', error: expect.stringContaining('beyond the last page (2)') });
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
