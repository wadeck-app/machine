import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMachineDaemon, type RunningDaemon } from './daemonEntry.js';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { peerRecordsFile, readPeerRecords } from './peerAddresses.js';
import { readMachine } from './identity.js';
import { writeRelayConfig } from './relayStore.js';
import { cli, provision } from './testing.js';
import { existsSync } from 'node:fs';
import type { InboxTimer } from './inboxLoop.js';

// `machine run <peer>` without --address and `machine list`: the addresses come from the signed record of the peer on the relay.
// Machine A ("desktop") is the admin and the caller, B ("laptop") runs the daemon, both on loopback with a fake relay.

const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';
const idleTimer: InboxTimer = { set: () => 0, clear: () => undefined };

let root: string;
let a: string;
let b: string;
let relay: FakeRelay;
const stoppers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-run-relay-'));
  a = join(root, 'a');
  b = join(root, 'b');
  await provision(root, a, b, [{ shell: SHELL, command: 'echo hello from laptop' }]);
  relay = await startFakeRelay();
});
afterEach(async () => {
  while (stoppers.length > 0) await stoppers.pop()?.();
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

const joinRelay = (dir: string, token: string) => writeRelayConfig(dir, { relayUrl: relay.url, token, label: 'm', claimedAt: new Date().toISOString() }, false);

/** B's daemon with its own relay token, publishing `advertise` (the port defaults to its peer port). */
async function startLaptop(advertise: Array<{ host: string; port?: number }>): Promise<RunningDaemon> {
  // The relay bound the uuid of B to its token when the admin approved it.
  const token = relay.addMachineToken();
  relay.setOwner(readMachine(b).uuid, token);
  joinRelay(b, token);
  const daemon = await startMachineDaemon(b, { port: 0, version: 'e2e', peerPort: 0, peerHost: '127.0.0.1', advertise, inbox: { timer: idleTimer }, log: () => undefined });
  stoppers.push(daemon.stop);
  await daemon.inbox?.ready;
  return daemon;
}

// The peers of these tests live on loopback, which a record may not point to: tests say so explicitly (there is no such option on the command line).
const runHello = () => cli(a, ['run', 'laptop', '--shell', SHELL, '--', 'echo', 'hello', 'from', 'laptop'], undefined, { allowLoopbackPeers: true });
const getsOfLaptop = () => relay.requests.filter((r) => r.method === 'GET' && r.path === `/api/machines/${readMachine(b).uuid}`);

describe('machine run without --address', () => {
  it('finds the peer through its signed address record on the relay and runs the command', async () => {
    await startLaptop([{ host: '127.0.0.1' }]);
    joinRelay(a, relay.addMachineToken());
    const r = await runHello();
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe('hello from laptop');
    // The highest seq seen is remembered.
    expect(readPeerRecords(a)[readMachine(b).uuid]?.seq).toBeGreaterThan(1_000_000_000);
  });

  it('tries the addresses in order: a dead first address is reported and the second wins', async () => {
    await startLaptop([{ host: '127.0.0.1', port: 1 }, { host: '127.0.0.1' }]);
    joinRelay(a, relay.addMachineToken());
    const r = await runHello();
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe('hello from laptop');
    expect(r.err).toMatch(/\[warn\].*127\.0\.0\.1:1:/);
  });

  it('when no published address answers, exit 255 lists each address with its reason and the way around the relay', async () => {
    await startLaptop([{ host: '127.0.0.1', port: 1 }, { host: '127.0.0.1', port: 2 }]);
    joinRelay(a, relay.addMachineToken());
    const r = await runHello();
    expect(r.code).toBe(255);
    expect(r.err).toMatch(/127\.0\.0\.1:1: /);
    expect(r.err).toMatch(/127\.0\.0\.1:2: /);
    expect(r.err).toContain('--address');
    expect(r.out).toBe('');
  });

  it('says so when the relay has no record of the peer (its daemon never published)', async () => {
    joinRelay(a, relay.addMachineToken());
    const r = await runHello();
    expect(r.code).toBe(255);
    expect(r.err).toMatch(/no address record for "laptop"/);
    expect(r.err).toMatch(/no record published yet/);
    expect(r.err).toContain('--address');
  });

  it('refuses an address record signed by another machine (a stolen relay token) and connects nowhere', async () => {
    const daemon = await startLaptop([{ host: '127.0.0.1' }]);
    joinRelay(a, relay.addMachineToken());
    // The relay (or a thief) replaces B's record with one signed by A's key, pointing at the right port: still refused.
    const { buildAddressRecord } = await import('@wadeck-app/machine-core');
    const wrong = buildAddressRecord({ uuid: readMachine(b).uuid, addresses: [{ host: '127.0.0.1', port: daemon.peerPort }], seq: 99, issuedAt: Math.floor(Date.now() / 1000) }, readMachine(a).identity.privateKeyPkcs8);
    const { createRelayClient } = await import('./relayClient.js');
    await createRelayClient({ baseUrl: relay.url, token: relay.adminToken }).putRecord(readMachine(b).uuid, wrong);
    const r = await runHello();
    expect(r.code).toBe(255);
    expect(r.err).toMatch(/registered identity key/);
    expect(r.out).toBe('');
  });

  it('--address stays an explicit override: the relay is not asked', async () => {
    const daemon = await startLaptop([{ host: '127.0.0.1' }]);
    joinRelay(a, relay.addMachineToken());
    const mark = relay.requests.length;
    const r = await cli(a, ['run', 'laptop', '--address', `127.0.0.1:${daemon.peerPort}`, '--shell', SHELL, '--', 'echo', 'hello', 'from', 'laptop']);
    expect(r.code).toBe(0);
    expect(relay.requests.length).toBe(mark);
  });

  it('without a relay and without --address: names both ways out', async () => {
    const r = await runHello();
    expect(r.code).toBe(255);
    expect(r.err).toMatch(/--address/);
    expect(r.err).toMatch(/machine join/);
    expect(relay.requests).toHaveLength(0);
  });

  it('an unreachable relay is said with the relay, and --address as the way around', async () => {
    joinRelay(a, 'tok_any');
    await relay.close();
    const r = await runHello();
    expect(r.code).toBe(255);
    expect(r.err).toMatch(/cannot reach the relay/);
    expect(r.err).toContain('--address');
    relay = await startFakeRelay();
  });

  it('an unknown machine never reaches the relay', async () => {
    joinRelay(a, relay.addMachineToken());
    const r = await cli(a, ['run', 'nas', '--shell', SHELL, '--', 'echo', 'hello']);
    expect(r.code).toBe(255);
    expect(r.err).toMatch(/unknown machine "nas"/);
    expect(relay.requests).toHaveLength(0);
  });

  it('warns when the relay says the peer is offline but still tries it', async () => {
    await startLaptop([{ host: '127.0.0.1' }]);
    joinRelay(a, relay.addMachineToken());
    // The relay clock moves on: no heartbeat for more than 120 s.
    const base = Math.floor(Date.now() / 1000);
    relay.setClock(() => base + 600);
    const r = await runHello();
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/\[warn\].*laptop.*offline/);
    // Local time with a relative hint, never an ISO string in UTC.
    expect(r.err).not.toMatch(/20\d\d-\d\d-\d\dT/);
    expect(r.err).toMatch(/offline \(last seen .*\(\d\d:\d\d\)\)/);
  });

  it('a damaged peer-records.json stops the run with the file and the fix', async () => {
    await startLaptop([{ host: '127.0.0.1' }]);
    joinRelay(a, relay.addMachineToken());
    const { writeFileSync } = await import('node:fs');
    writeFileSync(peerRecordsFile(a), '{oops');
    // The daemon of B asked the relay when it published: only what the CALLER asks counts.
    const asked = getsOfLaptop().length;
    const r = await runHello();
    expect(r.code).toBe(255);
    expect(r.err).toContain('peer-records.json');
    expect(existsSync(peerRecordsFile(a))).toBe(true);
    expect(getsOfLaptop()).toHaveLength(asked);
  });
});

describe('a record may not aim machine run at this machine or at the metadata service', () => {
  it('a record that only points to loopback is refused with the reason, nothing is connected', async () => {
    await startLaptop([{ host: '127.0.0.1' }]);
    joinRelay(a, relay.addMachineToken());
    // No test hook: this is what a user gets.
    const r = await cli(a, ['run', 'laptop', '--shell', SHELL, '--', 'echo', 'hello', 'from', 'laptop']);
    expect(r.code).toBe(255);
    expect(r.err).toMatch(/all 1 addresses/);
    expect(r.err).toMatch(/127.0.0.1.*loopback/);
    expect(r.err).toContain('--address');
    expect(r.out).toBe('');
  });

  it('a refused address is a warning and the next usable one is tried', async () => {
    const daemon = await startLaptop([{ host: '169.254.169.254', port: 80 }, { host: '127.0.0.1' }]);
    joinRelay(a, relay.addMachineToken());
    const r = await cli(a, ['run', 'laptop', '--shell', SHELL, '--', 'echo', 'hello', 'from', 'laptop'], undefined, { allowLoopbackPeers: false });
    expect(r.code).toBe(255);
    expect(r.err).toMatch(/169.254.169.254:80.*link-local/);
    void daemon;
  });
});

describe('machine list with a relay', () => {
  it('shows each peer with its last known addresses and what the relay says about presence', async () => {
    const daemon = await startLaptop([{ host: '127.0.0.1' }]);
    joinRelay(a, relay.addMachineToken());
    const r = await cli(a, ['list'], undefined, { allowLoopbackPeers: true });
    expect(r.code).toBe(0);
    expect(r.out).toContain('laptop');
    expect(r.out).toContain(`127.0.0.1:${daemon.peerPort}`);
    expect(r.out).toMatch(/online/);
    expect(r.err).toBe('');
  });

  it('--json carries the addresses, the online flag and the seq', async () => {
    const daemon = await startLaptop([{ host: '127.0.0.1' }]);
    joinRelay(a, relay.addMachineToken());
    const r = await cli(a, ['list', '--json'], undefined, { allowLoopbackPeers: true });
    const parsed = JSON.parse(r.out) as { peers: Array<{ name: string; relay?: { addresses: Array<{ host: string; port: number }>; online: boolean; seq: number; source: string } }> };
    expect(parsed.peers[0]?.relay).toMatchObject({ addresses: [{ host: '127.0.0.1', port: daemon.peerPort }], online: true, seq: expect.any(Number), source: 'relay' });
  });

  it('shows offline when the relay says so', async () => {
    await startLaptop([{ host: '127.0.0.1' }]);
    joinRelay(a, relay.addMachineToken());
    const base = Math.floor(Date.now() / 1000);
    relay.setClock(() => base + 600);
    const r = await cli(a, ['list'], undefined, { allowLoopbackPeers: true });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/offline/);
  });

  it('an unreachable relay is ONE visible warning line, the list is still printed and the exit code is 0; last known addresses stay visible', async () => {
    await startLaptop([{ host: '127.0.0.1' }]);
    joinRelay(a, relay.addMachineToken());
    await cli(a, ['list'], undefined, { allowLoopbackPeers: true });
    await relay.close();
    const r = await cli(a, ['list'], undefined, { allowLoopbackPeers: true });
    expect(r.code).toBe(0);
    expect(r.out).toContain('laptop');
    expect(r.err.trim().split('\n')).toHaveLength(1);
    expect(r.err).toMatch(/^\[warn\] .*cannot reach the relay/);
    expect(r.out).toMatch(/last known/);
    relay = await startFakeRelay();
  });

  it('a peer whose record is missing is a note on that peer, not an error', async () => {
    joinRelay(a, relay.addMachineToken());
    const r = await cli(a, ['list']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/laptop.*\n.*no record published yet/);
    expect(r.out).toMatch(/On "laptop" run `machine startup enable`/);
    // Not a warning and not an error: the line is a plain note.
    expect(r.err).toBe('');
  });

  it('a refused record is a warning for that peer, exit 0', async () => {
    const daemon = await startLaptop([{ host: '127.0.0.1' }]);
    joinRelay(a, relay.addMachineToken());
    const { buildAddressRecord } = await import('@wadeck-app/machine-core');
    const { createRelayClient } = await import('./relayClient.js');
    const wrong = buildAddressRecord({ uuid: readMachine(b).uuid, addresses: [{ host: '10.66.66.66', port: daemon.peerPort }], seq: 99, issuedAt: Math.floor(Date.now() / 1000) }, readMachine(a).identity.privateKeyPkcs8);
    await createRelayClient({ baseUrl: relay.url, token: relay.adminToken }).putRecord(readMachine(b).uuid, wrong);
    const r = await cli(a, ['list']);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('10.66.66.66');
    expect(r.out + r.err).toMatch(/refused/);
  });

  it('without a relay: the list is what it was, no warning and no request', async () => {
    const r = await cli(a, ['list']);
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    expect(r.out).not.toMatch(/online|offline|last known/);
    expect(relay.requests).toHaveLength(0);
  });
});
