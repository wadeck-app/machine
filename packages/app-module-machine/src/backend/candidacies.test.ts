import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { candidacyCode, generateSigningKeyPair, newCandidacyRandom } from '@wadeck-app/machine-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RelayNotConfiguredError, RelayRequestError, listCandidacies } from './candidacies.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

const TOKEN = 'admin-token-secret-value';
const NOW = 1_800_000_000;
const UUID = '0b8a7a52-7f0d-4f0e-8a56-2f0d3a1c9e11';

let configDir: string;
let servers: Server[];

beforeEach(() => {
  configDir = makeTempDir('app-module-machine-relay-');
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  removeTempDir(configDir);
});

interface Seen { method?: string; url?: string; authorization?: string }

async function fakeRelay(answer: () => { status: number; body: unknown }): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    const out = answer();
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { url: `http://127.0.0.1:${address.port}`, seen };
}

function writeAdminConfig(relayUrl: string, token = TOKEN): void {
  mkdirSync(join(configDir, '_secrets_'), { recursive: true });
  writeFileSync(join(configDir, '_secrets_', 'relay-admin.json'), JSON.stringify({ relayUrl, token, label: 'admin console', claimedAt: '2026-11-14T00:00:00.000Z' }));
}

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { publicKey } = generateSigningKeyPair();
  return {
    id: 'cand-1',
    name: 'laptop',
    hostname: 'LAPTOP-01',
    identityPublicKey: publicKey,
    random: newCandidacyRandom(),
    uuid: UUID,
    observedIp: '203.0.113.7',
    createdAt: NOW - 90,
    expiresAt: NOW + 800,
    ...overrides,
  };
}

describe('listCandidacies', () => {
  it('asks the relay with the admin token and returns the fields of the page plus the RECOMPUTED code', async () => {
    const c = candidate({ uuidBound: true, boundTokenLabel: 'laptop token' });
    const relay = await fakeRelay(() => ({ status: 200, body: { candidacies: [c] } }));
    writeAdminConfig(relay.url);
    const views = await listCandidacies(configDir, NOW);
    expect(relay.seen[0]?.method).toBe('GET');
    expect(relay.seen[0]?.url).toBe('/api/machines/candidacies');
    expect(relay.seen[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      id: 'cand-1',
      name: 'laptop',
      hostname: 'LAPTOP-01',
      observedIp: '203.0.113.7',
      ageSeconds: 90,
      uuidBound: true,
      boundTokenLabel: 'laptop token',
      code: candidacyCode(c.identityPublicKey as string, c.random as string),
      problems: [],
    });
  });

  it('never returns the code the relay sends: a swapped code is replaced by the recomputed one and reported', async () => {
    const c = candidate({ code: 'AAAA-BBBB-CCCC-DDDD' });
    const relay = await fakeRelay(() => ({ status: 200, body: { candidacies: [c] } }));
    writeAdminConfig(relay.url);
    const [view] = await listCandidacies(configDir, NOW);
    expect(view?.code).toBe(candidacyCode(c.identityPublicKey as string, c.random as string));
    expect(JSON.stringify(view)).not.toContain('AAAA-BBBB-CCCC-DDDD');
    expect(view?.problems.join(' ')).toContain('does not match');
  });

  it('does not report a mismatch when the relay code is the same up to case and dashes', async () => {
    const base = candidate();
    const code = candidacyCode(base.identityPublicKey as string, base.random as string);
    const relay = await fakeRelay(() => ({ status: 200, body: { candidacies: [{ ...base, verificationCode: code.toLowerCase().replaceAll('-', ' ') }] } }));
    writeAdminConfig(relay.url);
    const [view] = await listCandidacies(configDir, NOW);
    expect(view?.problems).toEqual([]);
  });

  it('keeps a malformed candidacy visible with a problem and no code, never a made-up code', async () => {
    const relay = await fakeRelay(() => ({ status: 200, body: { candidacies: [candidate({ identityPublicKey: 'not-a-key' })] } }));
    writeAdminConfig(relay.url);
    const [view] = await listCandidacies(configDir, NOW);
    expect(view?.code).toBeUndefined();
    expect(view?.problems.length).toBeGreaterThan(0);
  });

  it('flags a candidacy without uuid and an expired one', async () => {
    const noUuid = candidate({ id: 'a' });
    delete noUuid.uuid;
    const expired = candidate({ id: 'b', expiresAt: NOW - 1 });
    const relay = await fakeRelay(() => ({ status: 200, body: { candidacies: [noUuid, expired] } }));
    writeAdminConfig(relay.url);
    const views = await listCandidacies(configDir, NOW);
    expect(views[0]?.problems.join(' ')).toContain('uuid');
    expect(views[1]?.problems.join(' ')).toContain('expired');
  });

  it('shows text from the relay with printable ASCII only (no escape sequence reaches the page)', async () => {
    const relay = await fakeRelay(() => ({ status: 200, body: { candidacies: [candidate({ name: 'lap\u001b[31mtop', hostname: 'h\u0007ost' })] } }));
    writeAdminConfig(relay.url);
    const [view] = await listCandidacies(configDir, NOW);
    expect(view?.name).toBe('lap?[31mtop');
    expect(view?.hostname).toBe('h?ost');
  });

  it('reads relay-admin.json at EACH call', async () => {
    const first = await fakeRelay(() => ({ status: 200, body: { candidacies: [] } }));
    const second = await fakeRelay(() => ({ status: 200, body: { candidacies: [candidate()] } }));
    writeAdminConfig(first.url);
    expect(await listCandidacies(configDir, NOW)).toHaveLength(0);
    writeAdminConfig(second.url);
    expect(await listCandidacies(configDir, NOW)).toHaveLength(1);
  });

  it('never puts the token in a returned value', async () => {
    const relay = await fakeRelay(() => ({ status: 200, body: { candidacies: [candidate()] } }));
    writeAdminConfig(relay.url);
    expect(JSON.stringify(await listCandidacies(configDir, NOW))).not.toContain(TOKEN);
  });

  it('says how to log in as admin when relay-admin.json is missing', async () => {
    const error = await listCandidacies(configDir, NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayNotConfiguredError);
    expect((error as Error).message).toContain('machine admin login');
    expect((error as Error).message).toContain('relay-admin.json');
  });

  it('names the file when relay-admin.json is corrupt, without printing its content', async () => {
    mkdirSync(join(configDir, '_secrets_'), { recursive: true });
    writeFileSync(join(configDir, '_secrets_', 'relay-admin.json'), `{"token":"${TOKEN}"`);
    const error = await listCandidacies(configDir, NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayNotConfiguredError);
    expect((error as Error).message).toContain('relay-admin.json');
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it('refuses a plain http relay that is not on loopback, before sending the token', async () => {
    writeAdminConfig('http://relay.example.com');
    const error = await listCandidacies(configDir, NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayNotConfiguredError);
    expect((error as Error).message).toContain('https');
  });

  it('turns a 401 into advice to log in again, with no token in the message', async () => {
    const relay = await fakeRelay(() => ({ status: 401, body: { error: 'invalid_token', message: 'nope' } }));
    writeAdminConfig(relay.url);
    const error = await listCandidacies(configDir, NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayRequestError);
    expect((error as RelayRequestError).status).toBe(401);
    expect((error as Error).message).toContain('machine admin login');
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it('turns a relay 500 into an error carrying the status', async () => {
    const relay = await fakeRelay(() => ({ status: 500, body: { error: 'boom' } }));
    writeAdminConfig(relay.url);
    const error = await listCandidacies(configDir, NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayRequestError);
    expect((error as Error).message).toContain('500');
  });

  it('says the relay is unreachable when it does not answer, with no token in the message', async () => {
    const relay = await fakeRelay(() => ({ status: 200, body: {} }));
    const dead = relay.url;
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    servers = [];
    writeAdminConfig(dead);
    const error = await listCandidacies(configDir, NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayRequestError);
    expect((error as Error).message).toContain('unreachable');
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it('refuses an answer that is not a candidacy list instead of showing an empty list', async () => {
    const relay = await fakeRelay(() => ({ status: 200, body: { something: 'else' } }));
    writeAdminConfig(relay.url);
    const error = await listCandidacies(configDir, NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayRequestError);
    expect((error as Error).message).toContain('candidacies');
  });
});

describe('listCandidacies binding (deployed ownership-at-approval contract)', () => {
  const list = async (overrides: Record<string, unknown>) => {
    const relay = await fakeRelay(() => ({ status: 200, body: { candidacies: [candidate(overrides)] } }));
    writeAdminConfig(relay.url);
    const [view] = await listCandidacies(configDir, NOW);
    if (view === undefined) throw new Error('no view');
    return view;
  };

  it('is a rebind only when the uuid is bound to ANOTHER token, and returns the relay fields', async () => {
    const view = await list({ uuidBound: true, boundToCandidateToken: false, boundTokenLabel: '(revoked token)' });
    expect(view).toMatchObject({ uuidBound: true, boundToCandidateToken: false, boundTokenLabel: '(revoked token)', rebind: true, problems: [] });
  });

  it('is not a rebind when the uuid is bound to the token of the candidacy (re-approval)', async () => {
    const view = await list({ uuidBound: true, boundToCandidateToken: true, boundTokenLabel: 'same' });
    expect(view).toMatchObject({ boundToCandidateToken: true, rebind: false, problems: [] });
  });

  it('is not a rebind when the uuid is not bound', async () => {
    const view = await list({ uuidBound: false });
    expect(view).toMatchObject({ uuidBound: false, rebind: false });
  });

  it('reads a missing boundToCandidateToken as a rebind and says so', async () => {
    const view = await list({ uuidBound: true });
    expect(view.rebind).toBe(true);
    expect(view.boundToCandidateToken).toBeUndefined();
    expect(view.bindingNote).toContain('did not say');
  });

  it('reads a non-boolean boundToCandidateToken as a rebind and reports a problem', async () => {
    const view = await list({ uuidBound: true, boundToCandidateToken: 'yes' });
    expect(view.rebind).toBe(true);
    expect(view.boundToCandidateToken).toBeUndefined();
    expect(view.problems.join(' ')).toContain('boundToCandidateToken');
  });
});
