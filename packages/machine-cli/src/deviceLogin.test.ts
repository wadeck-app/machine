import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { readMachine } from './identity.js';
import { classifyJoinArgument, deviceLabel, MIN_DEVICE_POLL_MS } from './join.js';
import { candidacyFile, readCandidacy, readRelayConfig, relayFile } from './relayStore.js';
import { makeOrchStub, type OrchStub } from './orchStub.js';
import { buildApproval, cli, fakeTiming, makeAdmin, ok } from './testing.js';

let root: string;
let dir: string;
let relay: FakeRelay;

const forbidden = (what: string) => async (): Promise<string> => {
  throw new Error(`${what} must not be asked`);
};
// Headless: any question or hidden prompt fails the test.
const headless = { ask: forbidden('a question') };
const join_ = (args: string[], io: Parameters<typeof cli>[3] = {}) => cli(dir, ['join', '--relay', relay.url, ...args], forbidden('a prompt'), { ...headless, ...io });
const deviceRequests = (path: string) => relay.requests.filter((q) => q.method === 'POST' && q.path === `/api/device-login/${path}`);
const allFiles = (from: string): string[] =>
  readdirSync(from, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(from, e.name)) : [join(from, e.name)]));
const deviceCode = () => [...relay.deviceLogins.keys()][0] as string;
const noSecrets = (...texts: string[]) => {
  const all = texts.join('\n');
  expect(all).not.toContain(relay.token);
  for (const code of relay.deviceLogins.keys()) expect(all).not.toContain(code);
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-device-'));
  dir = join(root, 'cand');
  mkdirSync(dir);
  relay = await startFakeRelay();
  await ok(dir, ['init', '--name', 'laptop']);
});
afterEach(async () => {
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

describe('join argument rule', () => {
  it('digits (with spaces or hyphens) are a pairing code, anything else is a relay', () => {
    expect(classifyJoinArgument('12345678')).toEqual({ kind: 'code', code: '12345678' });
    expect(classifyJoinArgument('1234 5678')).toEqual({ kind: 'code', code: '1234 5678' });
    expect(classifyJoinArgument('1234-5678')).toEqual({ kind: 'code', code: '1234-5678' });
    expect(classifyJoinArgument('relay.example.test')).toEqual({ kind: 'relay', relayUrl: 'https://relay.example.test' });
    expect(classifyJoinArgument('https://relay.example.test/')).toEqual({ kind: 'relay', relayUrl: 'https://relay.example.test/' });
    expect(classifyJoinArgument('http://127.0.0.1:8080')).toEqual({ kind: 'relay', relayUrl: 'http://127.0.0.1:8080' });
    expect(classifyJoinArgument('127.0.0.1:8080')).toEqual({ kind: 'relay', relayUrl: 'https://127.0.0.1:8080' });
    expect(() => classifyJoinArgument('  ')).toThrow(/empty/);
  });

  it('the label is the machine name restricted to the characters the relay accepts', () => {
    expect(deviceLabel('laptop-1')).toBe('laptop-1');
    expect(deviceLabel('a/b\\c')).toBe('a-b-c');
    expect(deviceLabel('x'.repeat(100))).toHaveLength(64);
    expect(deviceLabel('')).toBe('machine');
  });

  it('a positional URL is the relay (device login, no --relay needed)', async () => {
    relay.deviceLogins.clear();
    const timing = fakeTiming((_ms, n) => n === 1 && relay.deviceApprove());
    const r = await cli(dir, ['join', relay.url, '--no-wait'], forbidden('a prompt'), { ...headless, timing });
    expect(r.code, r.err).toBe(0);
    expect(readRelayConfig(dir)?.relayUrl).toBe(relay.url);
    expect(deviceRequests('start')).toHaveLength(1);
  });

  it('a bare host means https://<host>: the error names the URL that was tried', async () => {
    const r = await cli(dir, ['join', '127.0.0.1:1', '--no-wait'], forbidden('a prompt'), headless);
    expect(r.code).toBe(1);
    expect(r.err).toContain('https://127.0.0.1:1');
    expect(readRelayConfig(dir)).toBeUndefined();
  });

  it('a positional of digits stays the pairing code: claim route, no device login', async () => {
    const r = await cli(dir, ['join', '1234 5678', '--relay', relay.url, '--no-wait'], forbidden('a prompt'), headless);
    expect(r.code, r.err).toBe(0);
    expect(relay.requests.some((q) => q.path === '/api/pairings/claim')).toBe(true);
    expect(deviceRequests('start')).toHaveLength(0);
  });

  it('a relay given twice (positional and --relay) is a usage error, nothing sent', async () => {
    const r = await cli(dir, ['join', 'relay.example.test', '--relay', relay.url]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/given twice/);
    expect(relay.requests).toHaveLength(0);
  });

  it('--resume takes no relay or code argument', async () => {
    const r = await cli(dir, ['join', 'relay.example.test', '--resume']);
    expect(r.code).toBe(2);
  });
});

describe('machine join by device login', () => {
  it('approved: shows the code, the page and the instruction on their own lines, polls no faster than 3 s, stores the token, posts the candidacy with the uuid, never prints a secret', async () => {
    const timing = fakeTiming((_ms, n) => n === 3 && relay.deviceApprove());
    const r = await join_(['--no-wait'], { timing });
    expect(r.code, r.err).toBe(0);

    const lines = r.out.split('\n');
    // The relay login code: named, alone on its line, said to be typed on the relay page (decision 55).
    expect(lines).toContain('  BCDF-GH23');
    expect(r.out).toMatch(/Relay login code for "laptop" on [\s\S]*Compare this code with the one in the relay console/);
    expect(lines).toContain('Relay page: https://relay.example/device?code=BCDF-GH23');
    expect(r.out).toContain("check that the source address is this computer, then approve. If the console shows several codes, click this one.");
    expect(timing.sleeps).toHaveLength(3);
    for (const ms of timing.sleeps) expect(ms).toBeGreaterThanOrEqual(MIN_DEVICE_POLL_MS);

    expect(readRelayConfig(dir)).toMatchObject({ relayUrl: relay.url, token: relay.token, label: 'laptop' });
    expect(deviceRequests('start')[0]?.body).toEqual({ label: 'laptop' });
    expect(deviceRequests('poll')).toHaveLength(3);
    const posted = [...relay.candidacies.values()][0] as Record<string, unknown>;
    expect(posted.uuid).toBe(readMachine(dir).uuid);
    noSecrets(r.out, r.err);
    // The token is only in the secrets file, and the deviceCode is nowhere on disk.
    expect(readFileSync(relayFile(dir), 'utf8')).toContain(relay.token);
    for (const file of allFiles(dir)) expect(readFileSync(file, 'utf8')).not.toContain(deviceCode());
  });

  it('public routes: no Authorization header on the device login calls', async () => {
    const timing = fakeTiming((_ms, n) => n === 1 && relay.deviceApprove());
    await join_(['--no-wait'], { timing });
    const calls = [...deviceRequests('start'), ...deviceRequests('poll')];
    expect(calls.length).toBeGreaterThan(1);
    for (const q of calls) expect(q.authorization).toBeUndefined();
  });

  it('the label returned by the relay (suffix) is the one stored', async () => {
    const timing = fakeTiming((_ms, n) => n === 1 && relay.deviceApprove({ label: 'laptop-2' }));
    const r = await join_(['--no-wait'], { timing });
    expect(r.code, r.err).toBe(0);
    expect(readRelayConfig(dir)?.label).toBe('laptop-2');
    expect(r.out).toContain('"laptop-2"');
  });

  it('--json: stdout is one JSON document, the code and the page go to stderr', async () => {
    const timing = fakeTiming((_ms, n) => n === 1 && relay.deviceApprove());
    const r = await join_(['--no-wait', '--json'], { timing });
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ label: 'laptop' });
    expect(r.err.split('\n')).toContain('  BCDF-GH23');
    noSecrets(r.out, r.err);
  });

  it('end to end headless: device login, then the admin approval, the final code compared with --yes-final-code, nothing asked', async () => {
    const admin = makeAdmin(join(root, 'admin'));
    const approval = await buildApproval(admin, dir);
    const timing = fakeTiming((_ms, n) => {
      if (n === 2) relay.deviceApprove();
      else if (n > 2 && relay.pendingIds().length > 0) relay.approve(relay.pendingIds()[0] as string, approval);
    });
    const first = await join_([], { timing, ask: async () => 'y' });
    expect(first.code, first.err).toBe(0);
    expect(first.out).toMatch(/enrolled "laptop"/);
    expect(existsSync(candidacyFile(dir))).toBe(false);
    noSecrets(first.out, first.err);
  });

  it('a wrong click (a decoy of the six codes) denies the request: actionable error, nothing stored', async () => {
    const timing = fakeTiming((_ms, n) => n === 1 && relay.deviceClick(relay.deviceChoices().find((c) => c !== 'BCDF-GH23') as string));
    const r = await join_([], { timing });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/a different code was chosen/);
    expect(r.err).toMatch(/machine join/);
    expect(r.err).toMatch(/approve the request that shows this code/);
    expect(existsSync(relayFile(dir))).toBe(false);
    expect(existsSync(candidacyFile(dir))).toBe(false);
  });

  it('denied: exit 1, says it was denied in the console, nothing stored, no further poll', async () => {
    const timing = fakeTiming((_ms, n) => n === 2 && relay.deviceDeny());
    const r = await join_([], { timing });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/denied in the relay console/);
    expect(r.err).toMatch(/machine join/);
    expect(deviceRequests('poll')).toHaveLength(2);
    expect(existsSync(relayFile(dir))).toBe(false);
    noSecrets(r.out, r.err);
  });

  it('expired: exit 1, says to run `machine join` again, never polls the spent code again, nothing stored', async () => {
    const timing = fakeTiming((_ms, n) => n === 2 && relay.deviceExpire());
    const r = await join_([], { timing });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/expired/);
    expect(r.err).toMatch(/run `machine join <relay-host-or-url>` again/);
    expect(deviceRequests('poll')).toHaveLength(2);
    expect(existsSync(relayFile(dir))).toBe(false);
    noSecrets(r.out, r.err);
  });

  it('a relay that never says expired: stops after the lifetime of the code', async () => {
    const r = await join_([], { timing: fakeTiming() });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/expired before it was approved/);
    expect(existsSync(relayFile(dir))).toBe(false);
  });

  it('slow_down: waits retryAfterSeconds and stays slower afterwards', async () => {
    relay.force('/api/device-login/poll', 429, { success: false, error: 'slow_down', message: 'too fast', retryAfterSeconds: 7 }, { 'Retry-After': '7' });
    const timing = fakeTiming((_ms, n) => n === 3 && relay.deviceApprove());
    const r = await join_(['--no-wait'], { timing });
    expect(r.code, r.err).toBe(0);
    expect(timing.sleeps).toEqual([3000, 7000, 7000]);
    expect(r.out).toMatch(/fewer checks/);
  });

  it('429 with Retry-After: waits that long, then goes on', async () => {
    relay.force('/api/device-login/poll', 429, { success: false, error: 'too_many_attempts', message: 'later' }, { 'Retry-After': '40' });
    const timing = fakeTiming((_ms, n) => n === 2 && relay.deviceApprove());
    const r = await join_(['--no-wait'], { timing });
    expect(r.code, r.err).toBe(0);
    expect(timing.sleeps[1]).toBe(40_000);
    expect(r.out).toMatch(/rate limiting/);
  });

  it('a 503 while waiting is reported and retried', async () => {
    relay.force('/api/device-login/poll', 503, { success: false, error: 'store_unavailable', message: 'down' });
    const timing = fakeTiming((_ms, n) => n === 2 && relay.deviceApprove());
    const r = await join_(['--no-wait'], { timing });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/\[warn\].*retrying/);
  });

  it.each([[null], [['machine', 'extra']], [['admin']]])('a token with scopes %j is refused: nothing stored, no secret printed', async (deviceScopes) => {
    await relay.close();
    relay = await startFakeRelay({ deviceScopes });
    const timing = fakeTiming((_ms, n) => n === 1 && relay.deviceApprove());
    const r = await join_([], { timing });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/NOT saved/);
    expect(existsSync(relayFile(dir))).toBe(false);
    expect(relay.candidacies.size).toBe(0);
    noSecrets(r.out, r.err);
  });

  it('interrupted (Ctrl-C): exit 1, nothing stored, tells the join restarts, no poll after the interruption', async () => {
    const controller = new AbortController();
    const timing = { ...fakeTiming((_ms, n) => n === 2 && controller.abort()), signal: controller.signal };
    const r = await join_([], { timing });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/interrupted/);
    expect(r.err).toMatch(/machine join/);
    expect(deviceRequests('poll')).toHaveLength(1);
    expect(existsSync(join(dir, '_secrets_', 'relay.json'))).toBe(false);
    expect(readCandidacy(dir)).toBeUndefined();
    for (const file of allFiles(dir)) expect(readFileSync(file, 'utf8')).not.toContain(deviceCode());
    noSecrets(r.out, r.err);
  });

  it('already joined: refused before anything is sent, --force replaces', async () => {
    mkdirSync(join(dir, '_secrets_'), { recursive: true });
    writeFileSync(relayFile(dir), JSON.stringify({ relayUrl: relay.url, token: 'old', label: 'old', claimedAt: 'x' }));
    const refused = await join_([]);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/--force/);
    expect(relay.requests).toHaveLength(0);
    const timing = fakeTiming((_ms, n) => n === 1 && relay.deviceApprove());
    const forced = await join_(['--force', '--no-wait'], { timing });
    expect(forced.code, forced.err).toBe(0);
    expect(readRelayConfig(dir)?.token).toBe(relay.token);
  });

  it('a relay without device login (404): points to the pairing code', async () => {
    relay.force('/api/device-login/start', 404, { success: false, error: 'not_found', message: 'no such route' });
    const r = await join_([]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/does not offer device login/);
    expect(r.err).toMatch(/machine join <code>/);
    expect(existsSync(relayFile(dir))).toBe(false);
  });

  it('--resume without init: actionable error before any request', async () => {
    const empty = join(root, 'empty');
    mkdirSync(empty);
    const r = await cli(empty, ['join', '--resume']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/machine init --name/);
    expect(relay.requests).toHaveLength(0);
  });
});

describe('machine join --resume and the candidacy uuid', () => {
  it('a candidacy saved without uuid (older version) is replaced by a new one that carries it', async () => {
    await ok(dir, ['join', '12345678', '--relay', relay.url, '--no-wait']);
    const saved = JSON.parse(readFileSync(candidacyFile(dir), 'utf8')) as Record<string, unknown>;
    delete saved.uuid;
    writeFileSync(candidacyFile(dir), JSON.stringify(saved));
    const posts = () => relay.requests.filter((q) => q.method === 'POST' && q.path === '/api/machines/candidacies');
    expect(posts()).toHaveLength(1);

    const r = await cli(dir, ['join', '--resume', '--no-wait']);
    expect(r.code, r.err).toBe(0);
    expect(posts()).toHaveLength(2);
    expect((posts()[1]?.body as Record<string, unknown>).uuid).toBe(readMachine(dir).uuid);
    expect(readCandidacy(dir)?.uuid).toBe(readMachine(dir).uuid);
  });
});

describe('machine join and the startup at login', () => {
  describe('--auto-startup (orch is a stub, never the real one)', () => {
    let stub: OrchStub;
    const source = { platform: 'linux' as const, execPath: '/usr/bin/node', scriptPath: '/opt/machine.cjs', native: false };
    const auto = (extra: string[] = []) => {
      const timing = fakeTiming((_ms, n) => n === 1 && relay.deviceApprove());
      return join_(['--no-wait', ...extra], { timing, startup: { orch: stub.orch, daemon: source, platform: 'linux' } });
    };
    beforeEach(() => {
      stub = makeOrchStub();
    });
    afterEach(() => {
      rmSync(stub.dir, { recursive: true, force: true });
    });

    it('runs startup enable once the join succeeded (it starts the daemon now), and then no longer suggests it', async () => {
      // The stub plays orch: restart-job writes the port file a started daemon writes (this test process stands for the daemon).
      stub.script({ ensure: { stdout: 'added machine\n' }, 'restart-job': { stdout: '{"started":true}', writeFile: { path: join(dir, 'daemon.port.json'), content: JSON.stringify({ pid: process.pid, port: 1, peerPort: 2 }) } } });
      const r = await auto(['--auto-startup']);
      expect(r.code, r.err).toBe(0);
      expect(stub.calls().map((c) => c.slice(0, 3))).toEqual([['ensure', 'startup', 'machine'], ['restart-job', 'machine', '--json']]);
      expect(r.out).toContain('[ok] startup job "machine" added');
      expect(r.out).toContain('[ok] daemon started (peer port 2)');
      expect(r.out).not.toContain('To start machine at login run');
      expect(readRelayConfig(dir)).toBeDefined();
    });

    it('--no-start registers the job and starts nothing', async () => {
      stub.script({ ensure: { stdout: 'added machine\n' } });
      const r = await auto(['--auto-startup', '--no-start']);
      expect(r.code, r.err).toBe(0);
      expect(stub.calls().map((c) => c[0])).toEqual(['ensure']);
      expect(r.out).toContain('daemon not started (--no-start)');
    });

    it('--no-start without --auto-startup is refused (nothing to start), nothing sent', async () => {
      const r = await auto(['--no-start']);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/--no-start on `machine join` and `machine setup` only has a meaning with --auto-startup/);
      expect(stub.calls()).toEqual([]);
    });

    it('with --json stdout stays one JSON document and the startup text goes to stderr', async () => {
      stub.script({ ensure: { stdout: 'unchanged machine\n' } });
      const r = await auto(['--auto-startup', '--json']);
      expect(r.code, r.err).toBe(0);
      expect(() => JSON.parse(r.out)).not.toThrow();
      expect(r.err).toContain('startup job "machine" unchanged');
    });

    it('a failing enable is reported loudly, makes join exit 1, and does not undo the join', async () => {
      stub.script({ ensure: { code: 2 } });
      const r = await auto(['--auto-startup']);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/joined the relay, but the startup job could not be enabled: the orch daemon could not be started/);
      expect(r.err).toMatch(/machine startup enable/);
      expect(readRelayConfig(dir)).toBeDefined();
      expect(readCandidacy(dir)).toBeDefined();
    });

    it('without the flag orch is never called', async () => {
      const r = await auto();
      expect(r.code, r.err).toBe(0);
      expect(stub.calls()).toEqual([]);
    });

    it('is refused on any other command (usage error), nothing sent', async () => {
      const r = await cli(dir, ['status', '--auto-startup']);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/--auto-startup only applies to `machine join`/);
    });
  });

  it('ends with the suggestion (stderr with --json) and starts nothing by itself', async () => {
    const timing = fakeTiming((_ms, n) => n === 1 && relay.deviceApprove());
    const r = await join_(['--no-wait'], { timing });
    expect(r.code, r.err).toBe(0);
    expect(r.out.trimEnd().split('\n').at(-1)).toBe('To start machine at login run: machine startup enable');

    const dir2 = join(root, 'cand2');
    mkdirSync(dir2);
    await ok(dir2, ['init', '--name', 'second']);
    const t2 = fakeTiming((_ms, n) => n === 1 && relay.deviceApprove());
    const j = await cli(dir2, ['join', '--relay', relay.url, '--no-wait', '--json'], forbidden('a prompt'), { ...headless, timing: t2 });
    expect(j.code, j.err).toBe(0);
    expect(() => JSON.parse(j.out)).not.toThrow();
    expect(j.err).toContain('machine startup enable');
  });
});

describe('no default relay', () => {
  it('join without argument and without stored relay: usage error naming the fix, nothing sent', async () => {
    const r = await cli(dir, ['join']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/machine join needs the relay: `machine join <host>`, for example `machine join relay.example.com`/);
    expect(existsSync(relayFile(dir))).toBe(false);
  });

  it('a pairing code without relay (argument, --relay or stored): same kind of error, nothing sent', async () => {
    const r = await cli(dir, ['join', '12345678']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/a pairing code needs the relay/);
    expect(r.err).toContain('--relay');
    expect(relay.requests).toHaveLength(0);
  });

  it('a pairing code uses the relay stored in relay.json when --relay is absent', async () => {
    mkdirSync(join(dir, '_secrets_'), { recursive: true });
    writeFileSync(relayFile(dir), JSON.stringify({ relayUrl: relay.url, token: 'old', label: 'old', claimedAt: 'x' }));
    const r = await cli(dir, ['join', '12345678', '--force', '--no-wait']);
    expect(r.code, r.err).toBe(0);
    expect(readRelayConfig(dir)?.token).toBe(relay.token);
    expect(readRelayConfig(dir)?.relayUrl).toBe(relay.url);
  });

  it('device login without argument reuses the stored relay (--force)', async () => {
    mkdirSync(join(dir, '_secrets_'), { recursive: true });
    writeFileSync(relayFile(dir), JSON.stringify({ relayUrl: relay.url, token: 'old', label: 'old', claimedAt: 'x' }));
    const timing = fakeTiming((_ms, n) => n === 1 && relay.deviceApprove());
    const r = await cli(dir, ['join', '--force', '--no-wait'], forbidden('a prompt'), { ...headless, timing });
    expect(r.code, r.err).toBe(0);
    expect(readRelayConfig(dir)?.token).toBe(relay.token);
  });

  it('--resume reuses the stored relay without naming it', async () => {
    await ok(dir, ['join', '12345678', '--relay', relay.url, '--no-wait']);
    const r = await cli(dir, ['join', '--resume', '--no-wait']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`resuming on the relay ${relay.url}`);
    expect(readRelayConfig(dir)?.relayUrl).toBe(relay.url);
  });

  it('admin login needs --relay (or a stored admin relay): usage error, no code asked', async () => {
    const r = await cli(dir, ['admin', 'login', '87654321'], forbidden('a prompt'), headless);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/admin login needs the relay/);
    expect(relay.requests).toHaveLength(0);
  });
});

// Found while reading what a first-time user sees against the real relay: after the code and the page, the command went silent.
describe('the wait for the approval in the relay console is announced', () => {
  it('says how long it waits, that Ctrl-C stops it and that nothing is stored meanwhile', async () => {
    const timing = fakeTiming((_ms, n) => n === 1 && relay.deviceApprove());
    const r = await cli(dir, ['join', relay.url, '--no-wait'], forbidden('a prompt'), { ...headless, timing });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/Waiting for the approval in the relay console \(up to 5 min, Ctrl-C stops it and nothing is stored\)/);
    expect(r.out.indexOf('Waiting for the approval')).toBeGreaterThan(r.out.indexOf('type this code to approve'));
    expect(r.out.indexOf('Waiting for the approval')).toBeLessThan(r.out.indexOf('[ok] relay access approved'));
  });
});
