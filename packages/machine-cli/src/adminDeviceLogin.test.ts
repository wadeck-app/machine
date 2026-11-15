import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminLoginLabel } from './adminDeviceLogin.js';
import { startFakeRelay, type FakeRelay, type FakeRelayOptions } from './fakeRelay.js';
import { readRelayAdminConfig, readRelayConfig } from './relayStore.js';
import { cli, fakeTiming, ok } from './testing.js';

// `machine admin login` without a code (decision 58): the admin confirms a request in the relay console, nothing to copy.

let root: string;
let dir: string;
let relay: FakeRelay;

const forbidden = (what: string) => async (): Promise<string> => {
  throw new Error(`${what} must not be asked`);
};
const deviceRequests = (path: string) => relay.requests.filter((q) => q.method === 'POST' && q.path === `/api/device-login/${path}`);
const allFiles = (from: string): string[] => readdirSync(from, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(from, e.name)) : [join(from, e.name)]));
const start = async (options: FakeRelayOptions = {}) => {
  await relay?.close();
  relay = await startFakeRelay(options);
};
const login = (args: string[] = [], io: Parameters<typeof cli>[3] = {}) => cli(dir, ['admin', 'login', '--relay', relay.url, ...args], forbidden('a prompt'), { ask: forbidden('a question'), hostname: () => 'Desk.local', ...io });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-adminlogin-'));
  dir = join(root, 'a');
  mkdirSync(dir);
  relay = await startFakeRelay();
});
afterEach(async () => {
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

describe('the label of the request', () => {
  it('names the machine and fits the relay rule', () => {
    expect(adminLoginLabel('desktop')).toBe('machine admin on desktop');
    expect(adminLoginLabel('x'.repeat(100))).toMatch(/^[A-Za-z0-9 _.-]{1,64}$/);
    expect(adminLoginLabel('a/b')).toBe('machine admin on a-b');
  });
});

describe('machine admin login (no code): the relay supports the full-access login', () => {
  it('shows FULL ACCESS, the code alone on its line, where to confirm; polls no faster than 3 s; saves the admin token (scopes null); never prints a secret', async () => {
    const timing = fakeTiming((_ms, n) => n === 2 && relay.deviceApprove());
    const r = await login([], { timing });
    expect(r.code, r.err).toBe(0);

    // The prompt text (stdout): FULL ACCESS, the code on a line of its own, the console path, the label.
    const lines = r.out.split('\n');
    expect(r.out).toMatch(/Admin login on \S+ \(FULL ACCESS\): approving a machine needs a full-access relay token/);
    expect(lines).toContain('  KLMN-PQ23');
    expect(r.out).toMatch(/open Tokens: the request "machine admin on desk" is listed there, marked FULL ACCESS\. Type the code and approve it\./);
    expect(r.out).toMatch(/Waiting for the approval in the relay console \(up to 5 min, Ctrl-C stops it and nothing is stored\)\./);
    expect(r.out).toContain('[ok] full access approved');
    expect(r.out).toMatch(/\[ok\] admin token "machine admin on desk" saved for /);
    // Blank line between the paragraphs.
    expect(r.out).toMatch(/\n\n {2}KLMN-PQ23\n\n/);

    for (const ms of timing.sleeps) expect(ms).toBeGreaterThanOrEqual(3000);
    expect(deviceRequests('start')[0]?.body).toEqual({ label: 'machine admin on desk', access: 'full' });
    expect(relay.requests.some((q) => q.path === '/api/pairings/claim')).toBe(false);
    // Public routes: no Authorization header.
    for (const q of [...deviceRequests('start'), ...deviceRequests('poll')]) expect(q.authorization).toBeUndefined();

    expect(readRelayAdminConfig(dir)).toMatchObject({ relayUrl: relay.url, token: relay.adminToken, label: 'machine admin on desk' });
    // A full-access token is never stored as the machine token.
    expect(readRelayConfig(dir)).toBeUndefined();
    expect(r.out + r.err).not.toContain(relay.adminToken);
    for (const code of relay.deviceLogins.keys()) {
      expect(r.out + r.err).not.toContain(code);
      for (const file of allFiles(dir)) expect(readFileSync(file, 'utf8')).not.toContain(code);
    }
  });

  it('the saved token really is a full-access one: it lists the candidacies', async () => {
    await ok(dir, ['admin', 'init', '--generate']);
    await login([], { timing: fakeTiming((_ms, n) => n === 1 && relay.deviceApprove()) });
    const r = await cli(dir, ['admin', 'approve', '--relay', relay.url], forbidden('a prompt'), { ask: forbidden('a question') });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/no pending candidacy/);
  });

  it('the label uses the machine name when this machine has an identity', async () => {
    await ok(dir, ['init', '--name', 'midgard']);
    const r = await login([], { timing: fakeTiming((_ms, n) => n === 1 && relay.deviceApprove()) });
    expect(r.code, r.err).toBe(0);
    expect(deviceRequests('start')[0]?.body).toEqual({ label: 'machine admin on midgard', access: 'full' });
  });

  it('--json: stdout is one JSON document, the code goes to stderr', async () => {
    const r = await login(['--json'], { timing: fakeTiming((_ms, n) => n === 1 && relay.deviceApprove()) });
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ relayUrl: relay.url, label: 'machine admin on desk' });
    expect(r.err.split('\n')).toContain('  KLMN-PQ23');
  });

  it('denied in the console: exit 1, nothing stored', async () => {
    const r = await login([], { timing: fakeTiming((_ms, n) => n === 1 && relay.deviceDeny()) });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/denied in the relay console/);
    expect(r.err).toMatch(/machine admin login/);
    expect(readRelayAdminConfig(dir)).toBeUndefined();
  });

  it('expired: exit 1, says to run it again, nothing stored', async () => {
    const r = await login([], { timing: fakeTiming((_ms, n) => n === 1 && relay.deviceExpire()) });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/expired/);
    expect(r.err).toMatch(/machine admin login/);
    expect(readRelayAdminConfig(dir)).toBeUndefined();
  });

  it('interrupted (Ctrl-C): nothing stored', async () => {
    const controller = new AbortController();
    const timing = { ...fakeTiming(), signal: controller.signal, sleep: async () => controller.abort() };
    const r = await login([], { timing });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/interrupted: nothing was stored/);
    expect(readRelayAdminConfig(dir)).toBeUndefined();
  });

  it('already holds an admin token: refused before anything is sent; --force replaces it', async () => {
    await login([], { timing: fakeTiming((_ms, n) => n === 1 && relay.deviceApprove()) });
    relay.requests.length = 0;
    const again = await login([], { timing: fakeTiming() });
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/already holds an admin relay token/);
    expect(again.err).toMatch(/--force/);
    expect(relay.requests).toHaveLength(0);
    const forced = await login(['--force'], { timing: fakeTiming((_ms, n) => n === 1 && relay.deviceApprove()) });
    expect(forced.code, forced.err).toBe(0);
  });

  it('the relay is reused from the saved admin token when --relay is absent', async () => {
    await login([], { timing: fakeTiming((_ms, n) => n === 1 && relay.deviceApprove()) });
    const r = await cli(dir, ['admin', 'login', '--force'], forbidden('a prompt'), { ask: forbidden('a question'), timing: fakeTiming((_ms, n) => n === 1 && relay.deviceApprove()) });
    expect(r.code, r.err).toBe(0);
  });

  it('with a code it is still the pairing path (scripts): claim route, no device login', async () => {
    const r = await cli(dir, ['admin', 'login', '87654321', '--relay', relay.url], forbidden('a prompt'), { ask: forbidden('a question') });
    expect(r.code, r.err).toBe(0);
    expect(relay.requests.some((q) => q.path === '/api/pairings/claim')).toBe(true);
    expect(deviceRequests('start')).toHaveLength(0);
  });
});

describe('machine admin login (no code): a relay that predates the full-access login', () => {
  it('400 invalid_body to the access field: a [warn] line says so, then the pairing code is asked and used', async () => {
    await start({ fullLogin: 'rejects' });
    const asked: string[] = [];
    const withTerminal = await cli(dir, ['admin', 'login', '--relay', relay.url], async (label) => (asked.push(label), '87654321'), { timing: fakeTiming(), hostname: () => 'Desk.local' });
    expect(withTerminal.code, withTerminal.err).toBe(0);
    expect(asked).toEqual(['Full-access pairing code (8 digits): ']);
    const warn = withTerminal.err + withTerminal.out;
    expect(warn).toContain('[warn] this relay does not support the full-access login yet; falling back to a pairing code');
    expect(withTerminal.out).toMatch(/Add token, WITHOUT "Limited to scopes": it shows an 8-digit pairing code\./);
    expect(deviceRequests('start')).toHaveLength(1);
    expect(relay.requests.some((q) => q.path === '/api/pairings/claim')).toBe(true);
    expect(readRelayAdminConfig(dir)).toMatchObject({ token: relay.adminToken, label: 'admin-pairing' });
  });

  it('no terminal to ask the pairing code: exit 2, the message names both ways, nothing stored', async () => {
    await start({ fullLogin: 'rejects' });
    const r = await cli(dir, ['admin', 'login', '--relay', relay.url], async () => {
      throw new Error('no tty');
    }, { timing: fakeTiming(), hostname: () => 'Desk.local' });
    expect(r.code).toBe(2);
    expect(r.err + r.out).toContain('[warn] this relay does not support the full-access login yet');
    expect(r.err).toMatch(/machine admin login <code>/);
    expect(r.err).toMatch(/WITHOUT "Limited to scopes"/);
    expect(readRelayAdminConfig(dir)).toBeUndefined();
  });

  it('a relay that drops the field and starts a MACHINE login: warns, tells to deny that request, falls back', async () => {
    await start({ fullLogin: 'ignores' });
    const r = await cli(dir, ['admin', 'login', '--relay', relay.url], async () => '87654321', { timing: fakeTiming(), hostname: () => 'Desk.local' });
    expect(r.code, r.err).toBe(0);
    const text = r.out + r.err;
    expect(text).toContain('[warn] this relay does not support the full-access login yet');
    expect(text).toMatch(/started a MACHINE login named "machine admin on desk" instead: deny that request/);
    expect(readRelayAdminConfig(dir)?.token).toBe(relay.adminToken);
    // The machine login that stayed pending is never polled, so its token was never delivered.
    expect(deviceRequests('poll')).toHaveLength(0);
  });

  it('a relay that approves with a MACHINE token after saying full: refused, nothing stored, tells to revoke', async () => {
    await start({ fullLogin: 'delivers-machine' });
    const r = await login([], { timing: fakeTiming((_ms, n) => n === 1 && relay.deviceApprove()) });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/NOT saved/);
    expect(r.err).toMatch(/older version/);
    expect(r.err).not.toContain(relay.token);
    expect(readRelayAdminConfig(dir)).toBeUndefined();
    expect(existsSync(join(dir, '_secrets_', 'relay-admin.json'))).toBe(false);
  });
});
