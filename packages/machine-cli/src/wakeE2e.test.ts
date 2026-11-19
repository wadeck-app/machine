import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LocalInterface, WakeMethod } from '@wadeck-app/machine-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMachineDaemon, type RunningDaemon } from './daemonEntry.js';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import type { InboxTimer } from './inboxLoop.js';
import { readMachine } from './identity.js';
import { writeRelayConfig } from './relayStore.js';
import { cli, provision } from './testing.js';
import { wakeAuditFile } from './wakeAudit.js';
import type { WakeSender } from './wakeSender.js';

// Wake-on-LAN through the command line, against REAL daemons (mutual TLS on loopback). Nothing is sent to a network: the sender is a fake, and the
// "LAN" is a fake interface 127.0.0.2/24 that shares the subnet of the peer at 127.0.0.1. A ("desktop") is the admin and the caller, B ("laptop")
// is the peer that is "asleep" until the fake sender is called: then its daemon starts.

const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';
const idleTimer: InboxTimer = { set: () => 0, clear: () => undefined };
const FAKE_LAN: LocalInterface = { name: 'lo-test', address: '127.0.0.2', netmask: '255.255.255.0', internal: false };

let root: string;
let a: string;
let b: string;
let relay: FakeRelay | undefined;
const stoppers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-wake-e2e-'));
  a = join(root, 'a');
  b = join(root, 'b');
  await provision(root, a, b, [{ shell: SHELL, command: 'echo hi' }]);
});
afterEach(async () => {
  while (stoppers.length > 0) await stoppers.pop()?.();
  await relay?.close();
  relay = undefined;
  rmSync(root, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function startDaemon(dir: string, peerPort: number, advertise: Array<{ host: string }> = []): Promise<RunningDaemon> {
  const daemon = await startMachineDaemon(dir, { port: 0, version: 'e2e', peerPort, peerHost: '127.0.0.1', advertise, inbox: { timer: idleTimer }, log: () => undefined });
  stoppers.push(daemon.stop);
  await daemon.inbox?.ready;
  return daemon;
}

interface Wakeable {
  sent: WakeMethod[];
  io: { wake: { sender: WakeSender; interfaces: () => LocalInterface[]; sleep: (ms: number) => Promise<void>; nowMs: () => number; simulateFailure: () => 'timeout' | undefined }; allowLoopbackPeers: true };
  /** Fake time, in ms. */
  now: () => number;
}

/**
 * A fake sender that "wakes" the peer (starts its daemon) at the `wakeAt`-th packet (1 = the first); never when `wakeAt` is undefined. While the
 * peer is asleep every connection attempt fails with an injected `timeout` (a refused loopback port is a host that answered: it is never woken).
 * `asleep: false`: the real network answers (a running daemon, another key, or a refusal).
 */
function wakeWorld(options: { wakeAt?: number; start?: () => Promise<unknown>; asleep?: boolean } = {}): Wakeable {
  let awake = options.asleep === false;
  let t = 0;
  const sent: WakeMethod[] = [];
  const sender: WakeSender = {
    send: async (method, packet, routes) => {
      expect(packet.length).toBe(102);
      sent.push(method);
      if (options.wakeAt === sent.length) {
        await options.start?.();
        awake = true;
      }
      return { destinations: routes.map((r) => ({ method, to: method === 'unicast' ? (r.unicast[0] as string) : r.broadcast, from: r.localAddress, ok: true })) };
    },
  };
  return {
    sent,
    now: () => t,
    io: {
      allowLoopbackPeers: true,
      wake: {
        sender,
        interfaces: () => [FAKE_LAN],
        sleep: async (ms) => {
          t += ms;
        },
        nowMs: () => t,
        simulateFailure: () => (awake ? undefined : 'timeout'),
      },
    },
  };
}

const run = (world: Wakeable, args: string[] = []) => cli(a, ['run', 'laptop', ...args, '--shell', SHELL, '--', 'echo hi'], undefined, world.io);
const auditOfB = (): string => (existsSync(join(b, 'audit.log')) ? readFileSync(join(b, 'audit.log'), 'utf8') : '');
const auditEntries = (): Array<Record<string, unknown>> => (existsSync(wakeAuditFile(a)) ? readFileSync(wakeAuditFile(a), 'utf8').trimEnd().split('\n').map((l) => (JSON.parse(l) as { entry: Record<string, unknown> }).entry) : []);

describe('machine run with a sleeping peer', () => {
  it('the first connection fails (nothing listens), the fake sender is called, the daemon starts, the retry succeeds and the command runs', async () => {
    const port = await freePort();
    expect((await cli(a, ['peer', 'connect', 'laptop', '--address', `127.0.0.1:${port}`, '--wake-mac', 'aa:bb:cc:dd:ee:01'])).code).toBe(0);
    const world = wakeWorld({ wakeAt: 1, start: () => startDaemon(b, port) });
    const r = await run(world);
    expect(r.err).toMatch(/\[info\] "laptop" is unreachable/);
    expect(r.err).toMatch(/\[info\] sending magic packets for aa:bb:cc:dd:ee:01: unicast to 127\.0\.0\.1 and broadcast to 127\.0\.0\.255/);
    expect(r.err).toMatch(/\[info\] \[1\/8\] unicast to 127\.0\.0\.1/);
    expect(r.err).toMatch(/\[ok\] "laptop" answered after [\d.]+ s, woken by unicast \(probe window 1/);
    expect(r.out).toContain('hi');
    expect(r.code).toBe(0);
    // Unicast first, and the answer came during its probe window: no broadcast.
    expect(world.sent).toEqual(['unicast']);
    // The caller's wake audit: who woke what, how many packets, never "woke".
    const entries = auditEntries();
    expect(entries.map((e) => e.event)).toEqual(['wake.packet', 'wake.result']);
    expect(entries[0]).toMatchObject({ requestedBy: 'run', sourceName: 'desktop', peerName: 'laptop', peerUuid: readMachine(b).uuid, method: 'unicast', n: 1, total: 8, to: ['127.0.0.1'] });
    expect(entries[1]).toMatchObject({ outcome: 'answered', packets: 1, followedBy: 'unicast' });
    // The peer audits the command only: nothing about the wake.
    expect(auditOfB()).toMatch(/"echo hi"|echo hi/);
    expect(auditOfB()).not.toMatch(/wake/);
  });

  it('wakes with a broadcast when the unicast was not enough: unicast, probe, broadcast, probe, and the answer follows the broadcast', async () => {
    const port = await freePort();
    await cli(a, ['peer', 'connect', 'laptop', '--address', `127.0.0.1:${port}`, '--wake-mac', 'aa:bb:cc:dd:ee:01', '--wake-probe', '2']);
    const world = wakeWorld({ wakeAt: 2, start: () => startDaemon(b, port) });
    const r = await run(world);
    expect(r.code).toBe(0);
    expect(world.sent).toEqual(['unicast', 'broadcast']);
    expect(r.err).toMatch(/\[ok\] "laptop" answered after [\d.]+ s, woken by broadcast \(probe window 2/);
  });

  it('an authentication failure never wakes: another key answers at the pinned address', async () => {
    const port = await freePort();
    // The daemon of A itself answers: its key is not the one registered for "laptop".
    await startDaemon(a, port);
    await cli(a, ['peer', 'connect', 'laptop', '--address', `127.0.0.1:${port}`, '--wake-mac', 'aa:bb:cc:dd:ee:01']);
    const world = wakeWorld({ asleep: false, wakeAt: 1, start: async () => { throw new Error('a packet must not be sent'); } });
    const r = await run(world);
    expect(r.code).toBe(255);
    expect(world.sent).toEqual([]);
    expect(r.err).toMatch(/\[info\] not waking "laptop"/);
    expect(r.err).toMatch(/presented key .* pinned registration/);
    expect(existsSync(wakeAuditFile(a))).toBe(false);
  });

  it('a REFUSED connection never wakes (the host is up, no daemon listens): no packet, no audit, the message says to start the daemon', async () => {
    // A closed loopback port is a real ECONNREFUSED: the host answered at TCP level.
    const port = await freePort();
    await cli(a, ['peer', 'connect', 'laptop', '--address', `127.0.0.1:${port}`, '--wake-mac', 'aa:bb:cc:dd:ee:01']);
    const world = wakeWorld({ asleep: false, wakeAt: 1, start: async () => { throw new Error('a packet must not be sent'); } });
    const r = await run(world);
    expect(r.code).toBe(255);
    expect(world.sent).toEqual([]);
    expect(r.err).toContain(`[info] "laptop" is reachable but nothing listens on 127.0.0.1:${port}: it is awake, so a magic packet would not help. Start the daemon there (\`machine startup enable\` on that machine), then run the command again`);
    expect(r.err).toMatch(/\[fail\] .*ECONNREFUSED/);
    expect(existsSync(wakeAuditFile(a))).toBe(false);
  });

  it('--no-wake forbids the wake of a peer configured to be woken; the error names the pinned addresses', async () => {
    const port = await freePort();
    await cli(a, ['peer', 'connect', 'laptop', '--address', `127.0.0.1:${port}`, '--wake-mac', 'aa:bb:cc:dd:ee:01']);
    const world = wakeWorld({ wakeAt: 1, start: () => startDaemon(b, port) });
    const r = await run(world, ['--no-wake']);
    expect(r.code).toBe(255);
    expect(world.sent).toEqual([]);
    expect(r.err).toMatch(/pinned address\(es\) of "laptop"/);
  });

  it('--wake wakes a peer whose type is direct (the settings hold the MAC)', async () => {
    const port = await freePort();
    await cli(a, ['peer', 'connect', 'laptop', '--address', `127.0.0.1:${port}`, '--wake-mac', 'aa:bb:cc:dd:ee:01', '--type', 'direct']);
    const noFlag = wakeWorld({ wakeAt: 1, start: () => startDaemon(b, port) });
    expect((await run(noFlag)).code).toBe(255);
    expect(noFlag.sent).toEqual([]);
    const world = wakeWorld({ wakeAt: 1, start: () => startDaemon(b, port) });
    const r = await run(world, ['--wake']);
    expect(r.code).toBe(0);
    expect(world.sent).toEqual(['unicast']);
  });

  it('--wake with no MAC configured fails before any connection, with the command to run', async () => {
    const world = wakeWorld();
    const r = await run(world, ['--wake', '--address', '127.0.0.1:1']);
    expect(r.code).toBe(255);
    expect(r.err).toMatch(/--wake needs the MAC address of "laptop".*machine peer connect laptop --wake-mac/);
    expect(world.sent).toEqual([]);
  });

  it('a peer that never wakes: at most 4 unicast and 4 broadcast packets, then exit 255 with the numbers and the fixes', async () => {
    const port = await freePort();
    await cli(a, ['peer', 'connect', 'laptop', '--address', `127.0.0.1:${port}`, '--wake-mac', 'aa:bb:cc:dd:ee:01', '--wake-wait', '30', '--wake-probe', '2']);
    const world = wakeWorld();
    const r = await run(world);
    expect(r.code).toBe(255);
    expect(world.sent).toEqual(['unicast', 'broadcast', 'unicast', 'broadcast', 'unicast', 'broadcast', 'unicast', 'broadcast']);
    expect(r.err).toMatch(/no answer from "laptop" after 30 s and 8 packets \(4 unicast, 4 broadcast\)/);
    expect(r.err).toMatch(/--wake-wait 60/);
    expect(auditEntries().at(-1)).toMatchObject({ event: 'wake.result', outcome: 'no-answer', packets: 8 });
  });

  it('a second run within the cooldown sends no packet but still waits for the peer', async () => {
    const port = await freePort();
    await cli(a, ['peer', 'connect', 'laptop', '--address', `127.0.0.1:${port}`, '--wake-mac', 'aa:bb:cc:dd:ee:01', '--wake-wait', '10', '--wake-probe', '2']);
    expect((await run(wakeWorld())).code).toBe(255);
    // The daemon would start at the first packet of this fake sender: it is never called during the cooldown, so the peer stays down.
    const again = wakeWorld({ wakeAt: 1, start: () => startDaemon(b, port) });
    const r = await run(again);
    expect(r.code).toBe(255);
    expect(again.sent).toEqual([]);
    expect(r.err).toMatch(/was woken [\d.]+ s ago from this machine: no new packet for another \d+ s/);
    expect(r.err).toMatch(/after 10 s and 0 packets/);
  });
});

describe('machine ping --wake and machine peer wake', () => {
  it('peer wake ignores the cooldown that a run just started; run and ping still respect it', async () => {
    const port = await freePort();
    await cli(a, ['peer', 'connect', 'laptop', '--address', `127.0.0.1:${port}`, '--wake-mac', 'aa:bb:cc:dd:ee:01', '--wake-wait', '10', '--wake-probe', '2']);
    expect((await run(wakeWorld())).code).toBe(255);
    const viaRun = wakeWorld();
    expect((await run(viaRun)).code).toBe(255);
    expect(viaRun.sent).toEqual([]);
    const explicit = wakeWorld({ wakeAt: 1, start: () => startDaemon(b, port) });
    const r = await cli(a, ['peer', 'wake', 'laptop'], undefined, explicit.io);
    expect(r.code).toBe(0);
    expect(explicit.sent).toEqual(['unicast']);
    expect(r.err).not.toMatch(/cooldown/);
  });

  it('ping wakes a peer configured for it, reports the wake in --json, and the peer audits nothing', async () => {
    const port = await freePort();
    await cli(a, ['peer', 'connect', 'laptop', '--address', `127.0.0.1:${port}`, '--wake-mac', 'aa:bb:cc:dd:ee:01']);
    const world = wakeWorld({ wakeAt: 1, start: () => startDaemon(b, port) });
    const r = await cli(a, ['ping', 'laptop', '--json'], undefined, { ...world.io, timing: { sleep: async () => undefined, nowMs: () => 0, pollIntervalMs: 1 } });
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as { ok: boolean; target: { source: string }; wake: { outcome: string; followedBy: string; window: number } };
    expect(doc).toMatchObject({ ok: true, target: { source: 'pinned' }, wake: { outcome: 'answered', followedBy: 'unicast', window: 1 } });
    expect(world.sent).toEqual(['unicast']);
    expect(auditOfB()).toBe('');
  });

  it('ping --no-wake fails without a packet', async () => {
    const port = await freePort();
    await cli(a, ['peer', 'connect', 'laptop', '--address', `127.0.0.1:${port}`, '--wake-mac', 'aa:bb:cc:dd:ee:01']);
    const world = wakeWorld({ wakeAt: 1, start: () => startDaemon(b, port) });
    const r = await cli(a, ['ping', 'laptop', '--no-wake'], undefined, { ...world.io, timing: { sleep: async () => undefined, nowMs: () => 0, pollIntervalMs: 1 } });
    expect(r.code).toBe(1);
    expect(world.sent).toEqual([]);
  });

  it('peer wake sends now, waits, prints the measured time, and an awake peer gets no packet', async () => {
    const port = await freePort();
    await cli(a, ['peer', 'connect', 'laptop', '--address', `127.0.0.1:${port}`, '--wake-mac', 'aa:bb:cc:dd:ee:01']);
    const world = wakeWorld({ wakeAt: 1, start: () => startDaemon(b, port) });
    const r = await cli(a, ['peer', 'wake', 'laptop'], undefined, world.io);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\[ok\] "laptop" answered after [\d.]+ s, woken by unicast \(probe window 1, [\d.]+ s into its 5 s\)/);
    expect(world.sent).toEqual(['unicast']);
    const awake = wakeWorld({ asleep: false });
    const again = await cli(a, ['peer', 'wake', 'laptop'], undefined, awake.io);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/\[ok\] "laptop" already answers on 127\.0\.0\.1:\d+: no packet was sent/);
    expect(awake.sent).toEqual([]);
  });

  it('peer wake of a peer that never answers: exit 1 with the cause and the fixes', async () => {
    const port = await freePort();
    await cli(a, ['peer', 'connect', 'laptop', '--address', `127.0.0.1:${port}`, '--wake-mac', 'aa:bb:cc:dd:ee:01', '--wake-wait', '10', '--wake-probe', '2']);
    const r = await cli(a, ['peer', 'wake', 'laptop'], undefined, wakeWorld().io);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/\[fail\] no answer from "laptop" after 10 s and 5 packets/);
  });
});

describe('pinned addresses win over the relay record', () => {
  it('the relay publishes a working address, the pinned one is dead: the pinned one is used and the failure names it; unpinned, the relay record works', async () => {
    relay = await startFakeRelay();
    const token = relay.addMachineToken();
    relay.setOwner(readMachine(b).uuid, token);
    writeRelayConfig(b, { relayUrl: relay.url, token, label: 'b', claimedAt: new Date().toISOString() }, false);
    const daemon = await startMachineDaemon(b, { port: 0, version: 'e2e', peerPort: 0, peerHost: '127.0.0.1', advertise: [{ host: '127.0.0.1' }], inbox: { timer: idleTimer }, log: () => undefined });
    stoppers.push(daemon.stop);
    await daemon.inbox?.ready;
    writeRelayConfig(a, { relayUrl: relay.url, token: relay.addMachineToken(), label: 'a', claimedAt: new Date().toISOString() }, false);

    const dead = await freePort();
    await cli(a, ['peer', 'connect', 'laptop', '--address', `127.0.0.1:${dead}`]);
    const world = wakeWorld({ asleep: false });
    const pinned = await run(world);
    expect(pinned.code).toBe(255);
    expect(pinned.err).toMatch(/pinned address\(es\) of "laptop"/);
    expect(pinned.err).toContain(`127.0.0.1:${dead}`);

    expect((await cli(a, ['peer', 'connect', 'laptop', '--remove'])).code).toBe(0);
    const viaRelay = await run(wakeWorld({ asleep: false }));
    expect(viaRelay.err).toBe('');
    expect(viaRelay.code).toBe(0);
    expect(viaRelay.out).toContain('hi');
  });
});
