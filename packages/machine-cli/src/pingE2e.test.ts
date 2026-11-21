import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMachineDaemon, type RunningDaemon } from './daemonEntry.js';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import type { InboxTimer } from './inboxLoop.js';
import { readMachine } from './identity.js';
import { SECRETS_DIRNAME } from './paths.js';
import { writeRelayConfig } from './relayStore.js';
import { cli, provision } from './testing.js';

// `machine ping` through the command line, against REAL daemons (two machines, mutual TLS on loopback) and the fake relay.
// A ("desktop") is the admin and the caller, B ("laptop") runs the daemon. The policy of B is EMPTY on purpose: ping must need no allowlist entry.

const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';
const idleTimer: InboxTimer = { set: () => 0, clear: () => undefined };
/** No real second between rounds. */
const fakeTiming = { sleep: async () => undefined, nowMs: () => 0, pollIntervalMs: 1 };

let root: string;
let a: string;
let b: string;
let relay: FakeRelay;
const stoppers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-ping-'));
  a = join(root, 'a');
  b = join(root, 'b');
  await provision(root, a, b, []);
  relay = await startFakeRelay();
});
afterEach(async () => {
  while (stoppers.length > 0) await stoppers.pop()?.();
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

const joinRelay = (dir: string, token: string) => writeRelayConfig(dir, { relayUrl: relay.url, token, label: 'm', claimedAt: new Date().toISOString() }, false);

async function startDaemon(dir: string, advertise: Array<{ host: string; port?: number }>, withRelay: boolean): Promise<RunningDaemon> {
  if (withRelay) {
    const token = relay.addMachineToken();
    relay.setOwner(readMachine(dir).uuid, token);
    joinRelay(dir, token);
  }
  const daemon = await startMachineDaemon(dir, { port: 0, version: 'e2e', peerPort: 0, peerHost: '127.0.0.1', advertise, inbox: { timer: idleTimer }, log: () => undefined });
  stoppers.push(daemon.stop);
  await daemon.inbox?.ready;
  return daemon;
}

const auditOfB = (): string => (existsSync(join(b, 'audit.log')) ? readFileSync(join(b, 'audit.log'), 'utf8') : '');
const ping = (args: string[], extra = {}) => cli(a, ['ping', ...args], undefined, { timing: fakeTiming, allowLoopbackPeers: true, ...extra });

describe('machine ping <machine> over a real channel', () => {
  it('opens the authenticated channel with --address, reports the timings, executes nothing and writes no audit entry on the peer', async () => {
    const daemon = await startDaemon(b, [], false);
    const r = await ping(['laptop', '--address', `127.0.0.1:${daemon.peerPort}`]);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\[ok\] machine: "laptop"/);
    expect(r.out).toMatch(/registration serial \d+ signed by admin key [0-9a-f]{8}\.\.\./);
    expect(r.out).toContain(`--address 127.0.0.1:${daemon.peerPort} (the relay was not asked)`);
    expect(r.out).toMatch(/\[ok\] peer: "laptop" proved the identity key pinned by its registration and the pair secret/);
    expect(r.out).toMatch(/\[ok\] ping 1\/1: 127\.0\.0\.1:\d+ handshake [\d.]+ ms, hello [\d.]+ ms/);
    expect(r.out).toMatch(/revocation lists: same on both machines/);
    expect(r.out).toMatch(/nothing was executed on it/);
    // The peer logged nothing in its audit log: a hello that is answered is not an event (a refusal or a command would be).
    expect(auditOfB()).toBe('');
  });

  it('needs no allowlist entry: the same peer still refuses a command, and the ping did not use up anything', async () => {
    const daemon = await startDaemon(b, [], false);
    const address = `127.0.0.1:${daemon.peerPort}`;
    expect((await ping(['laptop', '--address', address])).code).toBe(0);
    const run = await cli(a, ['run', 'laptop', '--no-wait', '--address', address, '--shell', SHELL, '--', 'echo', 'hi']);
    expect(run.code).toBe(255);
    // B holds a policy with no entry: the ping passed without any, the command is refused.
    expect(run.err).toMatch(/refused by laptop: not-listed/);
  });

  it('--count 3: three rounds and statistics, still no audit entry', async () => {
    const daemon = await startDaemon(b, [], false);
    const r = await ping(['laptop', '--address', `127.0.0.1:${daemon.peerPort}`, '--count', '3']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\[ok\] ping 3\/3:/);
    expect(r.out).toMatch(/3 attempts, 3 answered, 0 failed/);
    expect(r.out).toMatch(/handshake\s+min\/avg\/max = [\d.]+\/[\d.]+\/[\d.]+ ms/);
    expect(r.out).toMatch(/hello\s+min\/avg\/max = /);
    expect(auditOfB()).toBe('');
  });

  it('--json is one document with the rounds, nothing else on stdout', async () => {
    const daemon = await startDaemon(b, [], false);
    const r = await ping(['laptop', '--address', `127.0.0.1:${daemon.peerPort}`, '--count', '2', '--json']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as { ok: boolean; executed: boolean; peer: { name: string; adminKeyId: string }; rounds: Array<{ ok: boolean; handshakeMs: number; helloMs: number }>; summary: { sent: number; handshake: { count: number } } };
    expect(doc).toMatchObject({ ok: true, executed: false, peer: { name: 'laptop' }, summary: { sent: 2, handshake: { count: 2 } } });
    expect(doc.peer.adminKeyId).toMatch(/^[0-9a-f]{32}$/);
    expect(doc.rounds).toHaveLength(2);
    expect(doc.rounds.every((x) => x.ok && x.handshakeMs > 0 && x.helloMs >= 0)).toBe(true);
  });

  it('an alias and a uuid prefix resolve like `machine run`', async () => {
    const daemon = await startDaemon(b, [], false);
    const address = `127.0.0.1:${daemon.peerPort}`;
    expect((await cli(a, ['alias', 'set', 'portable', 'laptop'])).code).toBe(0);
    expect((await ping(['portable', '--address', address])).code).toBe(0);
    expect((await ping([readMachine(b).uuid.slice(0, 8), '--address', address])).code).toBe(0);
  });

  it('through the relay: the address comes from the signed record of the peer, and the line says so', async () => {
    await startDaemon(b, [{ host: '127.0.0.1' }], true);
    joinRelay(a, relay.addMachineToken());
    const r = await ping(['laptop']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\[ok\] address: 1 address\(es\) from the relay record of "laptop" \(seq \d+, published .*; the relay says online/);
    expect(r.out).toMatch(/\[ok\] ping 1\/1: 127\.0\.0\.1:\d+ handshake/);
    expect(auditOfB()).toBe('');
  });

  describe('failure modes', () => {
    it('an unknown machine lists nothing it does not know and exits 3', async () => {
      const r = await ping(['nobody', '--address', '127.0.0.1:1']);
      expect(r.code).toBe(3);
      expect(r.err).toMatch(/nobody/);
      expect(r.out).toBe('');
    });

    it('this machine itself is refused with the way to check the relay path', async () => {
      const r = await ping(['desktop']);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/that is this machine.*machine ping/s);
    });

    it('no record on the relay: names the machine and the command to run there', async () => {
      joinRelay(a, relay.addMachineToken());
      const r = await ping(['laptop']);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/\[fail\] address: the relay has no address record for "laptop"/);
      expect(r.err).toMatch(/On "laptop" run `machine startup enable`/);
      expect(r.err).toMatch(/--address/);
    });

    it('no relay and no --address: both ways out', async () => {
      const r = await ping(['laptop']);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/--address.*machine join/s);
    });

    it('an address nobody listens on: the line names the address, the cause and the fix', async () => {
      const r = await ping(['laptop', '--address', '127.0.0.1:1']);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/\[fail\] ping 1\/1: .*127\.0\.0\.1:1.*ECONNREFUSED.*Nothing listens on that port.*machine startup enable/s);
      expect(r.out).not.toMatch(/\[ok\] ping/);
      expect(r.err).toMatch(/\[fail\] ping: "laptop" answered 0\/1/);
    });

    it('through the relay, every published address is listed with its own error', async () => {
      await startDaemon(b, [{ host: '127.0.0.1', port: 1 }, { host: '127.0.0.1', port: 2 }], true);
      joinRelay(a, relay.addMachineToken());
      const r = await ping(['laptop']);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/no address of "laptop" answered \(2 tried\)/);
      expect(r.err).toMatch(/127\.0\.0\.1:1: .*ECONNREFUSED/);
      expect(r.err).toMatch(/127\.0\.0\.1:2: .*ECONNREFUSED/);
    });

    it('something that is not a machine listens there: it closes the connection and the line says it is not a machine channel or was dropped', async () => {
      const server: Server = createServer((socket) => socket.destroy());
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      stoppers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
      const port = (server.address() as { port: number }).port;
      const r = await ping(['laptop', '--address', `127.0.0.1:${port}`]);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/\[fail\] ping 1\/1:/);
      expect(r.err).toMatch(/machine cli logs|does not speak the machine channel|reset/);
    });

    it('a peer that revoked this machine refuses the handshake: not registered / revoked / clock, and where to look', async () => {
      // B starts without any registration of A (the state of a peer that revoked or never enrolled A): it closes the connection after the TLS handshake.
      rmSync(join(b, SECRETS_DIRNAME, 'peers.json'), { force: true });
      const daemon = await startDaemon(b, [], false);
      const r = await ping(['laptop', '--address', `127.0.0.1:${daemon.peerPort}`]);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/not registered there.*revoked.*clock.*machine cli logs/s);
    });

    it('a pair secret that differs: the line says who sends it again', async () => {
      const daemon = await startDaemon(b, [], false);
      const file = join(a, SECRETS_DIRNAME, 'peers.json');
      const doc = JSON.parse(readFileSync(file, 'utf8')) as { peers: Array<{ pairSecret: string }> };
      for (const p of doc.peers) p.pairSecret = Buffer.alloc(32, 7).toString('base64url');
      writeFileSync(file, JSON.stringify(doc));
      const r = await ping(['laptop', '--address', `127.0.0.1:${daemon.peerPort}`]);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/pair secret/);
      expect(r.err).toMatch(/machine admin distribute laptop|machine cli logs/);
    });

    it('--count out of range, --count without a machine, --address without a machine and a bad --address are usage errors (2)', async () => {
      for (const args of [['laptop', '--count', '0'], ['laptop', '--count', '11'], ['laptop', '--count', 'x'], ['--count', '2'], ['--address', '127.0.0.1:1'], ['laptop', '--address', 'nonsense'], ['laptop', 'extra']]) {
        const r = await ping(args);
        expect(r.code, args.join(' ')).toBe(2);
        expect(r.err).toMatch(/\[fail\]/);
      }
    });

    it('--count on another command is refused instead of ignored', async () => {
      const r = await cli(a, ['status', '--count', '2']);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/--count only applies to `machine ping/);
    });
  });
});

describe('machine ping (the path to the relay)', () => {
  it('every step passes with a joined relay, a running daemon and a published record: exit 0, one line per step', async () => {
    const daemon = await startDaemon(a, [{ host: '192.168.1.20', port: 47921 }], true);
    expect(daemon.inbox).toBeDefined();
    const r = await ping([]);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const lines = r.out.trim().split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^\[ok\] relay\.json: http:\/\/127\.0\.0\.1:\d+ \(token labelled "m"\)$/);
    expect(lines[1]).toMatch(/^\[ok\] relay reachable in [\d.]+ ms .*version 2099\.01\.01-1, up 60 min$/);
    expect(lines[2]).toMatch(/^\[ok\] token accepted in [\d.]+ ms, access level machine \(/);
    expect(lines[3]).toBe('[ok] local daemon is running');
    expect(lines[4]).toMatch(/^\[ok\] address record published: 192\.168\.1\.20:47921 \(seq \d+, now \(/);
    // The token never reaches the output.
    expect(r.out + r.err).not.toContain(relay.token);
  });

  it('the first machine token (machine-admin) is named as such', async () => {
    // A relay whose second token is machine-admin (what `machine setup` stores), another relay for this test.
    const other = await startFakeRelay({ adminScopes: ['machine-admin'] });
    try {
      writeRelayConfig(a, { relayUrl: other.url, token: other.adminToken, label: 'desktop', claimedAt: new Date().toISOString() }, false);
      const r = await ping([]);
      expect(r.out).toMatch(/access level machine-admin \(can approve machines, cannot manage tokens\)/);
    } finally {
      await other.close();
    }
  });

  it('no relay.json: says machine join <relay>, the daemon is still checked, exit 1', async () => {
    const r = await ping([]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/\[fail\] no relay\.json: this machine has not joined a relay\. Run `machine join <relay>`/);
    expect(r.out).toMatch(/\[info\] not run: relay, token and address record \(they need a relay\)/);
    expect(r.err).toMatch(/\[fail\] local daemon is not running/);
    expect(relay.requests).toHaveLength(0);
  });

  it('a token the relay refuses: the line says so and the address record step is skipped', async () => {
    joinRelay(a, 'tok_revoked');
    const r = await ping([]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/\[fail\] the relay .* refused the stored token \(invalid or revoked\).*machine join/);
    expect(r.err).not.toContain('tok_revoked');
  });

  it('a stopped relay: unreachable, with the fix', async () => {
    joinRelay(a, 'tok_any');
    await relay.close();
    const r = await ping([]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/\[fail\] cannot reach the relay/);
    relay = await startFakeRelay();
  });

  it('a joined machine whose daemon never ran: the record step fails and says what publishes it', async () => {
    const token = relay.addMachineToken();
    relay.setOwner(readMachine(a).uuid, token);
    joinRelay(a, token);
    const r = await ping([]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/\[fail\] local daemon is not running/);
    expect(r.err).toMatch(/\[fail\] the relay has no address record for this machine/);
  });

  it('--json is one document with the checks', async () => {
    await startDaemon(a, [{ host: '192.168.1.20', port: 47921 }], true);
    const r = await ping(['--json']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as { ok: boolean; checks: Array<{ id: string; status: string }> };
    expect(doc.ok).toBe(true);
    expect(doc.checks.map((c) => c.id)).toEqual(['relay-config', 'relay', 'token', 'daemon', 'address-record']);
  });
});
