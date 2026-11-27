import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import register from './index.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

// The Reject button of the Candidacies page: a rejection only restricts (hard rule 4), so no signature and no passphrase, but the route spends the relay
// admin token and is `sensitive` (the app-core PIN). It takes no body: the id of the row is the path, the decision is fixed here.

const TOKEN = 'admin-token-secret-value';

type Handler = (req: unknown, reply: Reply) => unknown;
interface Reply { code(status: number): Reply; send(body: unknown): unknown }
interface Registered { handler: Handler; options: unknown }

let configDir: string;
let servers: Server[];
let previous: string | undefined;

beforeEach(() => {
  configDir = makeTempDir('app-module-machine-reject-');
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

async function call(id: unknown, body?: unknown): Promise<{ status: number; body: any }> {
  const route = routes().get('POST /candidacies/:id/reject');
  if (route === undefined) throw new Error('route not registered: POST /candidacies/:id/reject');
  let status = 200;
  let sent: unknown;
  const reply: Reply = { code(s) { status = s; return reply; }, send(b) { sent = b; return b; } };
  await route.handler({ headers: {}, params: { id }, query: {}, body }, reply);
  return { status, body: sent };
}

async function withRelay(answer: { status: number; body?: unknown }): Promise<Array<{ method?: string; url?: string; body: string }>> {
  const seen: Array<{ method?: string; url?: string; body: string }> = [];
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (c: Buffer) => { text += c.toString(); });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: text });
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(answer.body === undefined ? '' : JSON.stringify(answer.body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  mkdirSync(join(configDir, '_secrets_'), { recursive: true });
  writeFileSync(join(configDir, '_secrets_', 'relay-admin.json'), JSON.stringify({ relayUrl: `http://127.0.0.1:${address.port}`, token: TOKEN, label: 'console', claimedAt: 'x' }));
  return seen;
}

describe('POST /candidacies/:id/reject', () => {
  it('is registered as a sensitive route (the app-core PIN): it spends the relay admin token', () => {
    expect(routes().get('POST /candidacies/:id/reject')?.options).toEqual({ effect: 'sensitive' });
  });

  it('rejects the candidacy at the relay with a fixed decision and answers a message the page shows', async () => {
    const seen = await withRelay({ status: 204 });
    const out = await call('cand-1');
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, id: 'cand-1' });
    expect(out.body.message).toContain('rejected');
    expect(seen).toEqual([{ method: 'PUT', url: '/api/machines/candidacies/cand-1/decision', body: '{"decision":"reject"}' }]);
  });

  it('ignores any body: the decision is not chosen by the caller (this route cannot approve)', async () => {
    const seen = await withRelay({ status: 204 });
    await call('cand-1', { decision: 'approve', approval: { v: 2 } });
    expect(seen[0]?.body).toBe('{"decision":"reject"}');
  });

  it('400 for an id that is not a plain token, before any relay call', async () => {
    const seen = await withRelay({ status: 204 });
    const out = await call('../x');
    expect(out.status).toBe(400);
    expect(out.body.error).toContain('candidacy id');
    expect(seen).toEqual([]);
  });

  it('409 when the relay says it is no longer pending, with the fix', async () => {
    await withRelay({ status: 409, body: { error: 'not_pending' } });
    const out = await call('cand-1');
    expect(out.status).toBe(409);
    expect(out.body.kind).toBe('not_pending');
    expect(out.body.error).toMatch(/no longer pending/);
    expect(out.body.message).toBe(out.body.error);
  });

  it('404 when the relay does not know it', async () => {
    await withRelay({ status: 404, body: { error: 'not_found' } });
    const out = await call('cand-1');
    expect(out.status).toBe(404);
    expect(out.body.kind).toBe('not_found');
    expect(out.body.error).toContain('machine join --resume');
  });

  it('503 without an admin token, naming the fix; 502 when the relay is unreachable or refuses the token; never the token', async () => {
    const none = await call('cand-1');
    expect(none.status).toBe(503);
    expect(none.body.kind).toBe('relay_not_configured');
    expect(none.body.error).toContain('machine admin login');
    await withRelay({ status: 401, body: { error: 'invalid_token' } });
    const refused = await call('cand-1');
    expect(refused.status).toBe(502);
    expect(refused.body.kind).toBe('relay_error');
    expect(JSON.stringify([none.body, refused.body])).not.toContain(TOKEN);
  });
});
