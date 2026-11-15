import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminLoginLabel } from './adminDeviceLogin.js';
import { startFakeRelay, type FakeRelay, type FakeRelayOptions } from './fakeRelay.js';
import { readRelayAdminConfig, readRelayConfig } from './relayStore.js';
import { cli, fakeTiming, ok } from './testing.js';

// `machine admin login` without a code (decision 59): the admin confirms ONE request in the relay console, nothing to copy, and gets a token
// of the machine-admin scope (it cannot manage tokens). Full access is an explicit opt-in (--full-access); an old relay fails loudly.

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
const approveAt = (n: number) => fakeTiming((_ms, count) => count === n && relay.deviceApprove());

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
  it('names the machine, is distinct from the machine token label, and fits the relay rule', () => {
    expect(adminLoginLabel('desktop')).toBe('desktop admin');
    expect(adminLoginLabel('x'.repeat(100))).toMatch(/^[A-Za-z0-9 _.-]{1,64}$/);
    expect(adminLoginLabel('a/b')).toBe('a-b admin');
  });
});

describe('machine admin login (no code): a token of the machine-admin scope', () => {
  it('shows MACHINE ADMIN and what it cannot do, the code alone on its line, where to confirm; polls no faster than 3 s; saves the token; never prints a secret', async () => {
    const timing = fakeTiming((_ms, n) => n === 2 && relay.deviceApprove());
    const r = await login([], { timing });
    expect(r.code, r.err).toBe(0);

    const lines = r.out.split('\n');
    expect(r.out).toContain('Admin login on ');
    expect(r.out).toContain('(MACHINE ADMIN: can approve machines, cannot manage tokens).');
    expect(lines).toContain('  ADMN-7K42');
    expect(r.out).toContain("Click the code ADMN-7K42 in the relay console (the Tokens page lists the request \"desk admin\", marked MACHINE ADMIN): it must be the same as this one. A different code denies the request.");
    // Clicking, not typing: the console shows six codes.
    expect(r.out).not.toMatch(/[Tt]ype (the|it)/);
    expect(r.out).toMatch(/Waiting for the approval in the relay console \(up to 5 min, Ctrl-C stops it and nothing is stored\)\./);
    expect(r.out).toContain('[ok] machine admin access approved');
    expect(r.out).toMatch(/\[ok\] admin token "desk admin" saved for .* \(MACHINE ADMIN: it cannot manage tokens\)/);
    expect(r.out + r.err).not.toMatch(/FULL ACCESS|WITHOUT/);
    // Blank line between the paragraphs.
    expect(r.out).toMatch(/\n\n {2}ADMN-7K42\n\n/);

    for (const ms of timing.sleeps) expect(ms).toBeGreaterThanOrEqual(3000);
    expect(deviceRequests('start')[0]?.body).toEqual({ label: 'desk admin', access: 'machine-admin' });
    expect(relay.requests.some((q) => q.path === '/api/pairings/claim')).toBe(false);
    // Public routes: no Authorization header.
    for (const q of [...deviceRequests('start'), ...deviceRequests('poll')]) expect(q.authorization).toBeUndefined();

    expect(readRelayAdminConfig(dir)).toMatchObject({ relayUrl: relay.url, token: relay.machineAdminToken, label: 'desk admin' });
    // The admin token is never stored as the machine token by `admin login`: the machine keeps its own.
    expect(readRelayConfig(dir)).toBeUndefined();
    expect(r.out + r.err).not.toContain(relay.machineAdminToken);
    for (const code of relay.deviceLogins.keys()) {
      expect(r.out + r.err).not.toContain(code);
      for (const file of allFiles(dir)) expect(readFileSync(file, 'utf8')).not.toContain(code);
    }
  });

  it('the saved token really is an admin one: it lists the candidacies, and it cannot manage tokens', async () => {
    await ok(dir, ['admin', 'init', '--generate']);
    await login([], { timing: approveAt(1) });
    const r = await cli(dir, ['admin', 'approve', '--relay', relay.url], forbidden('a prompt'), { ask: forbidden('a question') });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/no pending candidacy/);
    const token = readRelayAdminConfig(dir)?.token as string;
    expect((await fetch(`${relay.url}/api/tokens`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
    expect(((await (await fetch(`${relay.url}/api/whoami`, { headers: { authorization: `Bearer ${token}` } })).json()) as { scopes: unknown }).scopes).toEqual(['machine-admin']);
  });

  it('the label uses the machine name when this machine has an identity, and differs from the label of its own token', async () => {
    await ok(dir, ['init', '--name', 'midgard']);
    const r = await login([], { timing: approveAt(1) });
    expect(r.code, r.err).toBe(0);
    expect(deviceRequests('start')[0]?.body).toEqual({ label: 'midgard admin', access: 'machine-admin' });
  });

  it('--json: stdout is one JSON document, the code goes to stderr', async () => {
    const r = await login(['--json'], { timing: approveAt(1) });
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ relayUrl: relay.url, label: 'desk admin', scopes: ['machine-admin'] });
    expect(r.err.split('\n')).toContain('  ADMN-7K42');
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
    await login([], { timing: approveAt(1) });
    relay.requests.length = 0;
    const again = await login([], { timing: fakeTiming() });
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/already holds an admin relay token/);
    expect(again.err).toMatch(/--force/);
    expect(relay.requests).toHaveLength(0);
    const before = readRelayAdminConfig(dir)?.token;
    const forced = await login(['--force'], { timing: approveAt(1) });
    expect(forced.code, forced.err).toBe(0);
    expect(readRelayAdminConfig(dir)?.token).not.toBe(before);
  });

  it('the relay is reused from the saved admin token when --relay is absent', async () => {
    await login([], { timing: approveAt(1) });
    const r = await cli(dir, ['admin', 'login', '--force'], forbidden('a prompt'), { ask: forbidden('a question'), timing: approveAt(1) });
    expect(r.code, r.err).toBe(0);
  });

  it('a machine that already joined keeps its own token: the admin login adds a second one with a distinct label', async () => {
    await ok(dir, ['init', '--name', 'desk']);
    const joined = await cli(dir, ['join', '12345678', '--relay', relay.url, '--no-wait'], forbidden('a prompt'), { ask: forbidden('a question') });
    expect(joined.code, joined.err).toBe(0);
    const own = readRelayConfig(dir);
    await login([], { timing: approveAt(1) });
    expect(readRelayConfig(dir)).toEqual(own);
    expect(readRelayAdminConfig(dir)?.label).toBe('desk admin');
    expect(readRelayAdminConfig(dir)?.label).not.toBe(own?.label);
    expect(readRelayAdminConfig(dir)?.token).not.toBe(own?.token);
  });
});

describe('machine admin login with a code (scripts): the pairing path', () => {
  it('a pairing limited to the machine-admin scope is stored, no [warn]', async () => {
    await start({ adminScopes: ['machine-admin'] });
    const r = await cli(dir, ['admin', 'login', '87654321', '--relay', relay.url], forbidden('a prompt'), { ask: forbidden('a question') });
    expect(r.code, r.err).toBe(0);
    expect(relay.requests.some((q) => q.path === '/api/pairings/claim')).toBe(true);
    expect(deviceRequests('start')).toHaveLength(0);
    expect(r.out).toContain('(MACHINE ADMIN: it cannot manage tokens)');
    expect(r.err).not.toContain('FULL ACCESS');
  });

  it('a full-access pairing is accepted but warned about, with the way to the machine-admin token', async () => {
    const r = await cli(dir, ['admin', 'login', '87654321', '--relay', relay.url], forbidden('a prompt'), { ask: forbidden('a question') });
    expect(r.code, r.err).toBe(0);
    expect(r.err).toMatch(/\[warn\] this admin token has FULL ACCESS: it can also manage tokens/);
    expect(r.err).toMatch(/machine admin login --force/);
    expect(r.out).not.toContain('MACHINE ADMIN');
    expect(readRelayAdminConfig(dir)?.token).toBe(relay.adminToken);
  });

  it('a plain machine pairing is refused and not saved', async () => {
    await start({ adminScopes: ['machine'] });
    const r = await cli(dir, ['admin', 'login', '87654321', '--relay', relay.url], forbidden('a prompt'), { ask: forbidden('a question') });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/NOT saved/);
    expect(readRelayAdminConfig(dir)).toBeUndefined();
  });

  it('--full-access with a code is a usage error (a pairing carries its own access)', async () => {
    const r = await cli(dir, ['admin', 'login', '87654321', '--full-access', '--relay', relay.url], forbidden('a prompt'), { ask: forbidden('a question') });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--full-access/);
    expect(relay.requests).toHaveLength(0);
  });
});

describe('machine admin login (no code): a relay that predates the machine-admin scope', () => {
  const OLD = { machineAdminLogin: 'rejects' } as const;

  it('fails loudly: names the scope and the relay commit, says update and redeploy, lists the explicit choices; nothing stored, no full-access request, no prompt', async () => {
    await start(OLD);
    const r = await login([], { timing: fakeTiming() });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/predates the `machine-admin` scope \(poc-node 78fe5b2\)/);
    expect(r.err).toMatch(/update and redeploy it/);
    expect(r.err).toMatch(/no full-access token was requested/);
    expect(r.err).toContain('`machine admin login --full-access');
    expect(r.err).toContain('`machine admin login <code>');
    expect(r.err).toMatch(/nothing is done by itself/);
    expect(readRelayAdminConfig(dir)).toBeUndefined();
    // Exactly one start, with machine-admin: no second request with access full, no pairing claim, no poll.
    expect(deviceRequests('start').map((q) => (q.body as { access: string }).access)).toEqual(['machine-admin']);
    expect(deviceRequests('poll')).toHaveLength(0);
    expect(relay.requests.some((q) => q.path === '/api/pairings/claim')).toBe(false);
  });

  it('a relay that drops the field and starts a MACHINE login: refused, the pending request is named for denial, nothing stored, never polled', async () => {
    await start({ machineAdminLogin: 'ignores' });
    const r = await login([], { timing: fakeTiming() });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/started a MACHINE login instead/);
    expect(r.err).toMatch(/deny the request "desk admin"/);
    expect(readRelayAdminConfig(dir)).toBeUndefined();
    expect(deviceRequests('poll')).toHaveLength(0);
  });

  it('a relay that approves with a MACHINE token after saying machine-admin: refused, nothing stored, tells to revoke', async () => {
    await start({ machineAdminLogin: 'delivers-machine' });
    const r = await login([], { timing: approveAt(1) });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/NOT saved/);
    expect(r.err).toMatch(/revoke "desk admin"/);
    expect(r.err).not.toContain(relay.token);
    expect(existsSync(join(dir, '_secrets_', 'relay-admin.json'))).toBe(false);
  });

  it('a relay that approves with a FULL-ACCESS token after saying machine-admin: refused, nothing stored', async () => {
    await start({ machineAdminLogin: 'delivers-full' });
    const r = await login([], { timing: approveAt(1) });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/NOT saved/);
    expect(r.err).not.toContain(relay.adminToken);
    expect(existsSync(join(dir, '_secrets_', 'relay-admin.json'))).toBe(false);
  });
});

describe('machine admin login --full-access: the explicit opt-in', () => {
  it('asks for access full, says FULL ACCESS and that it can manage tokens, saves the token, and ends with a [warn]', async () => {
    const r = await login(['--full-access'], { timing: approveAt(1) });
    expect(r.code, r.err).toBe(0);
    expect(deviceRequests('start')[0]?.body).toEqual({ label: 'desk admin', access: 'full' });
    expect(r.out.split('\n')).toContain('  KLMN-PQ23');
    expect(r.out).toContain('(FULL ACCESS: can also manage tokens)');
    expect(r.out).toMatch(/marked FULL ACCESS/);
    expect(r.out).toContain('[ok] full access approved');
    expect(r.out).toMatch(/\[warn\] this admin token has FULL ACCESS: it can also manage tokens/);
    expect(readRelayAdminConfig(dir)).toMatchObject({ token: relay.adminToken, label: 'desk admin' });
    expect(r.out + r.err).not.toContain(relay.adminToken);
  });

  it('on a relay older than the full-access login: a [warn] line, then the pairing code is asked and used', async () => {
    await start({ fullLogin: 'rejects' });
    const asked: string[] = [];
    const r = await cli(dir, ['admin', 'login', '--full-access', '--relay', relay.url], async (label) => (asked.push(label), '87654321'), { timing: fakeTiming(), hostname: () => 'Desk.local' });
    expect(r.code, r.err).toBe(0);
    expect(asked).toEqual(['Full-access pairing code (8 digits): ']);
    expect(r.err + r.out).toContain('[warn] this relay does not support the full-access login yet; falling back to a pairing code');
    expect(r.out).toMatch(/Add token, WITHOUT "Limited to scopes": it shows an 8-digit pairing code\./);
    expect(r.out).toMatch(/\[warn\] this admin token has FULL ACCESS/);
    expect(readRelayAdminConfig(dir)).toMatchObject({ token: relay.adminToken, label: 'admin-pairing' });
  });

  it('on a relay older than the full-access login and no terminal: exit 2, the message names the pairing way, nothing stored', async () => {
    await start({ fullLogin: 'rejects' });
    const r = await cli(dir, ['admin', 'login', '--full-access', '--relay', relay.url], async () => {
      throw new Error('no tty');
    }, { timing: fakeTiming(), hostname: () => 'Desk.local' });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/machine admin login <code>/);
    expect(r.err).toMatch(/WITHOUT "Limited to scopes"/);
    expect(readRelayAdminConfig(dir)).toBeUndefined();
  });

  it('a relay that drops the field and starts a MACHINE login: warns, tells to deny that request, falls back to the pairing code', async () => {
    await start({ fullLogin: 'ignores' });
    const r = await cli(dir, ['admin', 'login', '--full-access', '--relay', relay.url], async () => '87654321', { timing: fakeTiming(), hostname: () => 'Desk.local' });
    expect(r.code, r.err).toBe(0);
    const text = r.out + r.err;
    expect(text).toContain('[warn] this relay does not support the full-access login yet');
    expect(text).toMatch(/started another login named "desk admin" instead: deny that request/);
    expect(readRelayAdminConfig(dir)?.token).toBe(relay.adminToken);
    expect(deviceRequests('poll')).toHaveLength(0);
  });

  it('a relay that approves with a MACHINE token after saying full: refused, nothing stored, tells to revoke', async () => {
    await start({ fullLogin: 'delivers-machine' });
    const r = await login(['--full-access'], { timing: approveAt(1) });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/NOT saved/);
    expect(r.err).toMatch(/older version/);
    expect(r.err).not.toContain(relay.token);
    expect(existsSync(join(dir, '_secrets_', 'relay-admin.json'))).toBe(false);
  });

  it('--full-access elsewhere than on `machine admin login` is a usage error', async () => {
    const r = await cli(dir, ['status', '--full-access']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--full-access only applies to `machine admin login`/);
  });
});

describe('the console shows six codes and the person clicks one (relay 7e0b586)', () => {
  const clickDecoy = () => relay.deviceClick(relay.deviceChoices().find((c) => c !== 'ADMN-7K42') as string);

  it('a wrong click denies the request: exit 1, an actionable message, nothing stored', async () => {
    const r = await login([], { timing: fakeTiming((_ms, n) => n === 1 && clickDecoy()) });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/the request was denied/);
    expect(r.err).toMatch(/a different code was clicked/);
    expect(r.err).toMatch(/run `machine admin login` again/);
    expect(r.err).toMatch(/click the code it shows/);
    expect(readRelayAdminConfig(dir)).toBeUndefined();
    expect(readRelayConfig(dir)).toBeUndefined();
    expect(existsSync(join(dir, '_secrets_', 'relay-admin.json'))).toBe(false);
  });

  it('the same refusal as a 409 request_denied on the poll: the same error, nothing stored', async () => {
    await start({ deniedPoll: 'conflict' });
    const r = await login([], { timing: fakeTiming((_ms, n) => n === 1 && clickDecoy()) });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/a different code was clicked/);
    expect(readRelayAdminConfig(dir)).toBeUndefined();
  });

  it('the right click is accepted', async () => {
    const r = await login([], { timing: fakeTiming((_ms, n) => n === 1 && relay.deviceClick('ADMN-7K42')) });
    expect(r.code, r.err).toBe(0);
    expect(readRelayAdminConfig(dir)?.token).toBe(relay.machineAdminToken);
  });

  it('--full-access keeps the typed code wording (no choices for a full-access request)', async () => {
    const r = await login(['--full-access'], { timing: approveAt(1) });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('Code to type in the relay console');
    expect(r.out).toMatch(/Type this code there/);
    expect([...relay.deviceLogins.values()].map((d) => d.choices)).toEqual([[]]);
  });
});
