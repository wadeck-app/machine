import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateSigningKeyPair, newCandidacyRandom } from '@wadeck-app/machine-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import register from './index.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

// Approve from the page, lot 4. The BROWSER signed and sealed the approval; this route only checks its shape, makes the admin machine trust the candidate
// (daemon command importCandidate, lot 3) and posts the decision to the relay. It never sees a passphrase, a key or a pair secret in clear.

const TOKEN = 'admin-token-secret-value';
const DAEMON_TOKEN = 'daemon-health-token-value';
const HEADER = { 'x-machine-module': '1' };
const CANDIDATE_UUID = '0b8a7a52-7f0d-4f0e-8a56-2f0d3a1c9e11';
const ADMIN_UUID = '11111111-1111-4111-8111-111111111111';
const ROUTE = 'POST /candidacies/:id/approve';

type Handler = (req: unknown, reply: Reply) => unknown;
interface Reply { code(status: number): Reply; send(body: unknown): unknown }
interface Registered { handler: Handler; options: unknown }

let configDir: string;
let servers: Server[];
let previous: string | undefined;
let events: string[];

beforeEach(() => {
  configDir = makeTempDir('app-module-machine-approve-');
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

async function call(key: string, req: { headers?: Record<string, string>; params?: Record<string, string>; body?: unknown }): Promise<{ status: number; body: any }> {
  const route = routes().get(key);
  if (route === undefined) throw new Error(`route not registered: ${key}`);
  let status = 200;
  let sent: unknown;
  const reply: Reply = { code(s) { status = s; return reply; }, send(b) { sent = b; return b; } };
  await route.handler({ headers: req.headers ?? {}, params: req.params ?? {}, query: {}, body: req.body }, reply);
  return { status, body: sent };
}

const listed = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'cand-1',
  name: 'laptop',
  hostname: 'LAPTOP',
  identityPublicKey: generateSigningKeyPair().publicKey,
  random: newCandidacyRandom(),
  uuid: CANDIDATE_UUID,
  observedIp: '203.0.113.7',
  createdAt: Math.floor(Date.now() / 1000) - 30,
  expiresAt: Math.floor(Date.now() / 1000) + 800,
  ...overrides,
});

interface Setup {
  candidacy: Record<string, unknown>;
  relayDecision?: { status: number; body?: unknown };
  daemon?: Record<string, unknown>;
}

async function start(setup: Setup): Promise<{ decisions: string[]; daemonBodies: Array<{ command: string; body: unknown }> }> {
  const decisions: string[] = [];
  const daemonBodies: Array<{ command: string; body: unknown }> = [];
  const relay = createServer((req, res) => {
    let text = '';
    req.on('data', (c: Buffer) => { text += c.toString(); });
    req.on('end', () => {
      if (req.method === 'GET') {
        events.push('relay-list');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ candidacies: [setup.candidacy] }));
        return;
      }
      events.push('relay-decision');
      decisions.push(text);
      const out = setup.relayDecision ?? { status: 204 };
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(out.body === undefined ? '' : JSON.stringify(out.body));
    });
  });
  const daemon = createServer((req, res) => {
    let text = '';
    req.on('data', (c: Buffer) => { text += c.toString(); });
    req.on('end', () => {
      const command = (req.url ?? '').slice(1);
      events.push(`daemon-${command}`);
      daemonBodies.push({ command, body: text === '' ? undefined : JSON.parse(text) });
      const answers = setup.daemon ?? {};
      const known = req.headers.authorization === `Bearer ${DAEMON_TOKEN}` && command in answers;
      res.writeHead(known ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(known ? { result: answers[command] } : { error: `Unknown command: ${command}` }));
    });
  });
  servers.push(relay, daemon);
  await Promise.all([relay, daemon].map((s) => new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))));
  const port = (s: Server): number => (s.address() as { port: number }).port;
  mkdirSync(join(configDir, '_secrets_'), { recursive: true });
  writeFileSync(join(configDir, '_secrets_', 'relay-admin.json'), JSON.stringify({ relayUrl: `http://127.0.0.1:${port(relay)}`, token: TOKEN, label: 'console', claimedAt: 'x' }));
  writeFileSync(join(configDir, 'daemon.port.json'), JSON.stringify({ pid: process.pid, port: port(daemon), peerPort: 1 }));
  writeFileSync(join(configDir, 'health_token'), DAEMON_TOKEN);
  return { decisions, daemonBodies };
}

const approvalFor = (candidacy: Record<string, unknown>): { v: 2; random: string; sealed: string } => ({ v: 2, random: candidacy['random'] as string, sealed: 'c2VhbGVkLWFwcHJvdmFs' });
const importFor = (candidacy: Record<string, unknown>): Record<string, unknown> => ({
  registration: { body: { uuid: CANDIDATE_UUID }, signature: 'sig' },
  sealedPairSecret: 'c2VhbGVk',
  adminUuid: ADMIN_UUID,
  candidateUuid: CANDIDATE_UUID,
  random: candidacy['random'],
});
const IMPORTED = { ok: true, candidate: { uuid: CANDIDATE_UUID, name: 'laptop' }, serial: 1, warnings: [] };

describe('POST /candidacies/:id/approve: registration and gates', () => {
  it('is a sensitive route (the app-core PIN): it spends the relay token and makes this machine trust a new machine', () => {
    expect(routes().get(ROUTE)?.options).toEqual({ effect: 'sensitive' });
  });

  it('without the module header: 403, no relay, no daemon call', async () => {
    const candidacy = listed();
    await start({ candidacy, daemon: { importCandidate: IMPORTED } });
    const out = await call(ROUTE, { params: { id: 'cand-1' }, body: { approval: approvalFor(candidacy), adminImport: importFor(candidacy) } });
    expect(out.status).toBe(403);
    expect(events).toEqual([]);
  });
});

describe('POST /candidacies/:id/approve: the body is exactly { approval, adminImport }', () => {
  const bad = async (body: unknown, expected: RegExp): Promise<void> => {
    const candidacy = listed();
    await start({ candidacy, daemon: { importCandidate: IMPORTED } });
    const out = await call(ROUTE, { headers: HEADER, params: { id: 'cand-1' }, body });
    expect(out.status).toBe(400);
    expect(out.body.kind).toBe('bad_request');
    expect(out.body.error).toMatch(expected);
    expect(events).toEqual([]);
  };
  const good = listed();

  it('refuses a missing body, a missing field and any extra field (a passphrase cannot travel here)', async () => {
    await bad(undefined, /exactly/);
    await bad({ approval: approvalFor(good) }, /adminImport/);
    await bad({ adminImport: null }, /approval/);
    await bad({ approval: approvalFor(good), adminImport: null, passphrase: 'x' }, /exactly/);
  });

  it('refuses an approval that is not { v: 2, random, sealed } and nothing else', async () => {
    await bad({ approval: { ...approvalFor(good), extra: 1 }, adminImport: null }, /approval/);
    await bad({ approval: { ...approvalFor(good), v: 1 }, adminImport: null }, /version 2/);
    await bad({ approval: { v: 2, random: 5, sealed: 'x' }, adminImport: null }, /approval/);
    await bad({ approval: { v: 2, random: good['random'], sealed: '' }, adminImport: null }, /approval/);
  });

  it('refuses an approval larger than 16 KiB, before any call', async () => {
    await bad({ approval: { v: 2, random: good['random'], sealed: 'A'.repeat(16 * 1024) }, adminImport: null }, /16 KiB/);
  });

  it('refuses an adminImport that is neither null nor an object', async () => {
    await bad({ approval: approvalFor(good), adminImport: 'x' }, /adminImport/);
    await bad({ approval: approvalFor(good), adminImport: [] }, /adminImport/);
  });

  it('refuses an id that is not a plain token, before any call', async () => {
    const candidacy = listed();
    await start({ candidacy });
    const out = await call(ROUTE, { headers: HEADER, params: { id: '../x' }, body: { approval: approvalFor(candidacy), adminImport: null } });
    expect(out.status).toBe(400);
    expect(events).toEqual([]);
  });
});

describe('POST /candidacies/:id/approve: the flow', () => {
  it('lists again, makes the admin machine trust the candidate, THEN posts the approval; answers a message for the page and no secret', async () => {
    const candidacy = listed();
    const seen = await start({ candidacy, daemon: { importCandidate: IMPORTED } });
    const approval = approvalFor(candidacy);
    const out = await call(ROUTE, { headers: HEADER, params: { id: 'cand-1' }, body: { approval, adminImport: importFor(candidacy) } });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, id: 'cand-1', imported: { uuid: CANDIDATE_UUID, name: 'laptop' } });
    expect(out.body.message).toMatch(/approved/);
    expect(events).toEqual(['relay-list', 'daemon-importCandidate', 'relay-decision']);
    expect(JSON.parse(seen.decisions[0] as string)).toEqual({ decision: 'approve', approval });
    expect(seen.daemonBodies[0]?.body).toEqual(importFor(candidacy));
    expect(JSON.stringify(out.body)).not.toContain(TOKEN);
    expect(JSON.stringify(out.body)).not.toContain('c2VhbGVk');
  });

  it('forwards to the daemon only the fields of the import, re-built here', async () => {
    const candidacy = listed();
    const seen = await start({ candidacy, daemon: { importCandidate: IMPORTED } });
    await call(ROUTE, { headers: HEADER, params: { id: 'cand-1' }, body: { approval: approvalFor(candidacy), adminImport: { ...importFor(candidacy), extra: 'x' } } });
    expect(Object.keys(seen.daemonBodies[0]?.body as object).sort()).toEqual(['adminUuid', 'candidateUuid', 'random', 'registration', 'sealedPairSecret']);
  });

  it('409 when the approval answers another candidacy than the one listed now (a random that differs): nothing imported, nothing posted', async () => {
    const candidacy = listed();
    await start({ candidacy, daemon: { importCandidate: IMPORTED } });
    const other = newCandidacyRandom();
    const out = await call(ROUTE, { headers: HEADER, params: { id: 'cand-1' }, body: { approval: { v: 2, random: other, sealed: 'c2VhbGVk' }, adminImport: importFor(candidacy) } });
    expect(out.status).toBe(409);
    expect(out.body.kind).toBe('random_mismatch');
    expect(events).toEqual(['relay-list']);
  });

  it('409 when the adminImport is not for the candidate or the candidacy listed now', async () => {
    const candidacy = listed();
    await start({ candidacy, daemon: { importCandidate: IMPORTED } });
    const approval = approvalFor(candidacy);
    const wrongUuid = await call(ROUTE, { headers: HEADER, params: { id: 'cand-1' }, body: { approval, adminImport: { ...importFor(candidacy), candidateUuid: '33333333-3333-4333-8333-333333333333' } } });
    expect(wrongUuid.status).toBe(409);
    expect(wrongUuid.body.kind).toBe('import_mismatch');
    const wrongRandom = await call(ROUTE, { headers: HEADER, params: { id: 'cand-1' }, body: { approval, adminImport: { ...importFor(candidacy), random: newCandidacyRandom() } } });
    expect(wrongRandom.status).toBe(409);
    expect(events.filter((e) => e === 'daemon-importCandidate')).toEqual([]);
    expect(events.filter((e) => e === 'relay-decision')).toEqual([]);
  });

  it('when the daemon refuses the import: its reason and sentence, nothing is posted to the relay', async () => {
    const candidacy = listed();
    await start({ candidacy, daemon: { importCandidate: { ok: false, reason: 'bad-registration', message: 'this machine does not trust that registration: why. Nothing was imported' } } });
    const out = await call(ROUTE, { headers: HEADER, params: { id: 'cand-1' }, body: { approval: approvalFor(candidacy), adminImport: importFor(candidacy) } });
    expect(out.status).toBe(422);
    expect(out.body.kind).toBe('bad-registration');
    expect(out.body.error).toMatch(/does not trust that registration/);
    expect(events).not.toContain('relay-decision');
  });

  it('when the relay refuses the decision after the import: the error says the candidate was imported here (harmless) and what to do', async () => {
    const candidacy = listed();
    await start({ candidacy, daemon: { importCandidate: IMPORTED }, relayDecision: { status: 409, body: { error: 'not_pending' } } });
    const out = await call(ROUTE, { headers: HEADER, params: { id: 'cand-1' }, body: { approval: approvalFor(candidacy), adminImport: importFor(candidacy) } });
    expect(out.status).toBe(409);
    expect(out.body.kind).toBe('not_pending');
    expect(out.body.error).toMatch(/NOT approved/);
    expect(out.body.error).toMatch(/already added to the peers of this machine/);
  });

  it('404 / 409 when the relay no longer lists it, or lists it with problems or another status: nothing imported', async () => {
    const approved = listed({ status: 'approved' });
    await start({ candidacy: approved, daemon: { importCandidate: IMPORTED } });
    const out = await call(ROUTE, { headers: HEADER, params: { id: 'cand-1' }, body: { approval: approvalFor(approved), adminImport: importFor(approved) } });
    expect(out.status).toBe(409);
    expect(out.body.kind).toBe('not_pending');
    const gone = await call(ROUTE, { headers: HEADER, params: { id: 'other' }, body: { approval: approvalFor(approved), adminImport: importFor(approved) } });
    expect(gone.status).toBe(404);
    expect(gone.body.kind).toBe('not_found');
    expect(events.filter((e) => e.startsWith('daemon-') || e === 'relay-decision')).toEqual([]);
  });

  it('503 without an admin token, 503 without the daemon; never the token', async () => {
    const candidacy = listed();
    const none = await call(ROUTE, { headers: HEADER, params: { id: 'cand-1' }, body: { approval: approvalFor(candidacy), adminImport: importFor(candidacy) } });
    expect(none.status).toBe(503);
    expect(none.body.kind).toBe('relay_not_configured');
    expect(JSON.stringify(none.body)).not.toContain(TOKEN);
  });
});

describe('POST /candidacies/:id/approve: nothing to import (adminImport null)', () => {
  it('allowed only for the first machine approving itself: the daemon says the candidate IS the admin machine; no import is made', async () => {
    const candidacy = listed({ uuid: ADMIN_UUID });
    const seen = await start({ candidacy, daemon: { approveContext: { ok: true, adminMachine: { uuid: ADMIN_UUID, name: 'desk', identityPublicKey: 'k' }, adminPublicKey: 'p', adminKeyId: 'i', candidate: { trusted: false } } } });
    const out = await call(ROUTE, { headers: HEADER, params: { id: 'cand-1' }, body: { approval: approvalFor(candidacy), adminImport: null } });
    expect(out.status).toBe(200);
    expect(events).toEqual(['relay-list', 'daemon-approveContext', 'relay-decision']);
    expect(seen.daemonBodies[0]?.body).toEqual({ candidateUuid: ADMIN_UUID });
  });

  it('409 import_required for any other candidate: without the import this machine would not trust it; nothing is posted', async () => {
    const candidacy = listed();
    await start({ candidacy, daemon: { approveContext: { ok: true, adminMachine: { uuid: ADMIN_UUID, name: 'desk', identityPublicKey: 'k' }, adminPublicKey: 'p', adminKeyId: 'i', candidate: { trusted: false } } } });
    const out = await call(ROUTE, { headers: HEADER, params: { id: 'cand-1' }, body: { approval: approvalFor(candidacy), adminImport: null } });
    expect(out.status).toBe(409);
    expect(out.body.kind).toBe('import_required');
    expect(events).not.toContain('relay-decision');
  });
});

describe('GET /approve-context/:uuid: what the page needs before it asks the passphrase', () => {
  it('is sensitive, needs the module header, and forwards exactly the candidate uuid to the daemon', async () => {
    expect(routes().get('GET /approve-context/:uuid')?.options).toEqual({ effect: 'sensitive' });
    const context = { ok: true, adminMachine: { uuid: ADMIN_UUID, name: 'desk', identityPublicKey: 'k' }, adminPublicKey: 'p', adminKeyId: 'i', candidate: { trusted: false } };
    const seen = await start({ candidacy: listed(), daemon: { approveContext: context } });
    const refused = await call('GET /approve-context/:uuid', { params: { uuid: CANDIDATE_UUID } });
    expect(refused.status).toBe(403);
    const out = await call('GET /approve-context/:uuid', { headers: HEADER, params: { uuid: CANDIDATE_UUID } });
    expect(out.status).toBe(200);
    expect(out.body).toEqual(context);
    expect(seen.daemonBodies).toEqual([{ command: 'approveContext', body: { candidateUuid: CANDIDATE_UUID } }]);
  });

  it('409 with the daemon sentence when this machine holds no admin key', async () => {
    await start({ candidacy: listed(), daemon: { approveContext: { ok: false, reason: 'no-admin-key', message: 'this machine has no admin key: run on the machine that holds it' } } });
    const out = await call('GET /approve-context/:uuid', { headers: HEADER, params: { uuid: CANDIDATE_UUID } });
    expect(out.status).toBe(409);
    expect(out.body.error).toMatch(/holds it/);
  });
});
