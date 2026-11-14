import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyAddressRecord } from '@wadeck-app/machine-core';
import { startMachineDaemon, type RunningDaemon } from './daemonEntry.js';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { readMachine } from './identity.js';
import { startInboxLoop, type InboxTimer } from './inboxLoop.js';
import { createRelayClient } from './relayClient.js';
import { writeRelayConfig } from './relayStore.js';
import { ok, provision } from './testing.js';
import type { NetworkInterfaceInfo } from 'node:os';

let root: string;
let relay: FakeRelay;
let logs: string[];
let daemons: RunningDaemon[];

const dirOf = (name: string) => join(root, name);
const uuidOf = (name: string) => readMachine(dirOf(name)).uuid;

function fakeTimer(): InboxTimer & { delays: number[]; pending: () => number; fire: () => void } {
  const pending = new Map<number, () => void>();
  const delays: number[] = [];
  let next = 0;
  return {
    set: (fn, ms) => {
      delays.push(ms);
      pending.set(++next, fn);
      return next;
    },
    clear: (handle) => void pending.delete(handle as number),
    delays,
    pending: () => pending.size,
    fire: () => {
      const all = [...pending.values()];
      pending.clear();
      for (const fn of all) fn();
    },
  };
}

const iface = (address: string): NetworkInterfaceInfo => ({ address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: `${address}/24` });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-daemon-publish-'));
  mkdirSync(dirOf('desktop'));
  mkdirSync(dirOf('laptop'));
  // desktop is the admin, laptop is enrolled (admin key pinned, desktop trusted).
  await provision(root, dirOf('desktop'), dirOf('laptop'), []);
  relay = await startFakeRelay();
  writeRelayConfig(dirOf('laptop'), { relayUrl: relay.url, token: relay.token, label: 'laptop', claimedAt: new Date().toISOString() }, false);
  // The admin approved laptop with this token: the relay bound its uuid to it (ownership bound at approval).
  relay.setOwner(uuidOf('laptop'), relay.token);
  logs = [];
  daemons = [];
});

afterEach(async () => {
  for (const d of daemons) await d.stop();
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

async function start(options: Partial<Parameters<typeof startMachineDaemon>[1]> = {}, name = 'laptop') {
  const timer = fakeTimer();
  const daemon = await startMachineDaemon(dirOf(name), { port: 0, peerPort: 0, peerHost: '127.0.0.1', version: 'v', log: (l) => logs.push(l), inbox: { timer }, ...options });
  daemons.push(daemon);
  return { daemon, timer };
}

const putsOf = (name: string) => relay.requests.filter((r) => r.method === 'PUT' && r.path === `/api/machines/${uuidOf(name)}`);

describe('the daemon publishes its signed address record', () => {
  it('at start: the record carries --advertise hosts with the real peer port and verifies against the identity key', async () => {
    const { daemon } = await start({ advertise: [{ host: '127.0.0.1' }, { host: 'laptop.example.com', port: 50000 }] });
    await daemon.inbox?.ready;
    const entry = await createRelayClient({ baseUrl: relay.url, token: relay.token }).getMachine(uuidOf('laptop'));
    expect(entry).toBeDefined();
    const self = readMachine(dirOf('laptop'));
    const checked = verifyAddressRecord(entry?.record, { uuid: self.uuid, identityPublicKey: self.identity.publicKey }, Math.floor(Date.now() / 1000));
    expect(checked.ok).toBe(true);
    const addresses = checked.ok ? checked.body.addresses : [];
    expect(addresses).toEqual([
      { host: '127.0.0.1', port: daemon.peerPort },
      { host: 'laptop.example.com', port: 50000 },
    ]);
    expect(logs.join('\n')).toMatch(/address record published \(seq \d{10}\)/);
  });

  it('the approved machine owns its inbox: the very first round reads it without not_owner', async () => {
    const { daemon } = await start({ advertise: [{ host: '127.0.0.1' }] });
    await daemon.inbox?.ready;
    expect(logs.filter((l) => /does not own its inbox|not_owner/.test(l))).toEqual([]);
    await expect(createRelayClient({ baseUrl: relay.url, token: relay.token }).listInbox(uuidOf('laptop'))).resolves.toEqual([]);
  });

  it('discovers the interfaces when the listener is on every interface (injected provider), at the peer port', async () => {
    const { daemon } = await start({ peerHost: '0.0.0.0', interfaces: () => ({ eth0: [iface('192.168.1.20')] }) });
    await daemon.inbox?.ready;
    const entry = await createRelayClient({ baseUrl: relay.url, token: relay.token }).getMachine(uuidOf('laptop'));
    expect(entry?.record.body.addresses).toEqual([{ host: '192.168.1.20', port: daemon.peerPort }]);
  });

  it('a listener bound to loopback with no --advertise: a loud warning, no record, and the loop still runs', async () => {
    const { daemon } = await start();
    await daemon.inbox?.ready;
    expect(putsOf('laptop')).toHaveLength(0);
    expect(logs.join('\n')).toMatch(/address record NOT published.*loopback.*--advertise/s);
    // The heartbeat still goes out.
    expect(relay.requests.some((r) => r.method === 'POST' && r.path.endsWith('/heartbeat'))).toBe(true);
  });

  it('ONE timer drives the heartbeat and the record: the next round is the only pending timer, and a changed set is published in it', async () => {
    let address = '192.168.1.20';
    const { daemon, timer } = await start({ peerHost: '0.0.0.0', interfaces: () => ({ eth0: [iface(address)] }) });
    await daemon.inbox?.ready;
    expect(timer.pending()).toBe(1);
    expect(timer.delays).toEqual([60_000]);
    const first = (await createRelayClient({ baseUrl: relay.url, token: relay.token }).getMachine(uuidOf('laptop')))?.record.body.seq as number;
    const heartbeatsBefore = relay.requests.filter((r) => r.path.endsWith('/heartbeat')).length;
    address = '192.168.1.99';
    timer.fire();
    await daemon.inbox?.runOnce();
    const entry = await createRelayClient({ baseUrl: relay.url, token: relay.token }).getMachine(uuidOf('laptop'));
    expect(entry?.record.body.addresses).toEqual([{ host: '192.168.1.99', port: daemon.peerPort }]);
    expect(entry?.record.body.seq).toBe(first + 1);
    expect(relay.requests.filter((r) => r.path.endsWith('/heartbeat')).length).toBeGreaterThan(heartbeatsBefore);
    expect(timer.pending()).toBeLessThanOrEqual(1);
  });

  it('a machine that did not finish enrolling publishes nothing and says why', async () => {
    mkdirSync(dirOf('fresh'));
    await ok(dirOf('fresh'), ['init', '--name', 'fresh']);
    writeRelayConfig(dirOf('fresh'), { relayUrl: relay.url, token: relay.token, label: 'fresh', claimedAt: new Date().toISOString() }, false);
    const { daemon } = await start({ advertise: [{ host: '127.0.0.1' }] }, 'fresh');
    await daemon.inbox?.ready;
    expect(putsOf('fresh')).toHaveLength(0);
    expect(logs.join('\n')).toMatch(/not enrolled/);
  });

  it('without relay.json nothing is published, and --advertise says it has no effect', async () => {
    const { rmSync: remove } = await import('node:fs');
    remove(join(dirOf('laptop'), '_secrets_', 'relay.json'));
    const mark = relay.requests.length;
    const { daemon } = await start({ advertise: [{ host: '127.0.0.1' }] });
    expect(daemon.inbox).toBeUndefined();
    expect(relay.requests).toHaveLength(mark);
    expect(logs.join('\n')).toMatch(/--advertise has no effect.*machine join/s);
  });
});

describe('the inbox loop calls the publisher from its own round', () => {
  it('the heartbeat goes out BEFORE the publisher tick of every round (a slow relay cannot delay it), and a throwing publisher does not stop the round', async () => {
    const order: string[] = [];
    const client = createRelayClient({
      baseUrl: relay.url,
      token: relay.token,
      fetch: (async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/heartbeat')) order.push('heartbeat');
        return fetch(url, init);
      }) as typeof fetch,
    });
    const timer = fakeTimer();
    let ticks = 0;
    const loop = startInboxLoop({
      configDir: dirOf('laptop'),
      self: readMachine(dirOf('laptop')),
      client,
      audit: { write: () => undefined },
      now: () => Math.floor(Date.now() / 1000),
      log: (l) => logs.push(l),
      timer,
      publisher: {
        tick: async () => {
          order.push('tick');
          if (++ticks === 2) throw new Error('boom');
        },
      },
    });
    await loop.ready;
    timer.fire();
    await loop.runOnce();
    loop.stop();
    expect(order.slice(0, 2)).toEqual(['heartbeat', 'tick']);
    expect(order.filter((o) => o === 'heartbeat').length).toBeGreaterThanOrEqual(2);
    expect(order.filter((o) => o === 'tick').length).toBe(order.filter((o) => o === 'heartbeat').length);
    expect(logs.join('\n')).toMatch(/boom/);
  });
});
