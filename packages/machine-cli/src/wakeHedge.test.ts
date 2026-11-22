import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressEntry, ConnectFailureKind, LocalInterface, WakeConfig, WakeMethod, WakeRoute } from '@wadeck-app/machine-core';
import type { PeerSession } from '@wadeck-app/machine-transport';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AllAddressesFailedError } from './peerAddresses.js';
import type { Connected, PeerTarget, PeerToReach } from './peerConnect.js';
import { readWakeState, recordWake, wakeStateFile } from './wakeState.js';
import { wakeAuditFile } from './wakeAudit.js';
import { WakeError, connectWithWake, settingsFromConfig, type WakeEnv } from './wakeConnect.js';
import type { SendReport, WakeSender } from './wakeSender.js';

// Hedged first packet (decision 97). The clock is virtual: a sleep is a timer that fires, earliest first, once every other promise has settled.
// No real waiting anywhere.

const UUID = '3f2a9c10-1b2c-4d3e-8f40-0123456789ab';
const PEER: PeerToReach = { peerId: UUID, name: 'linux-box', identityPublicKey: 'key', pairSecret: Buffer.alloc(32) };
const EPOCH0 = 1_000_000;
const MAC = 'aa:bb:cc:dd:ee:01';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'machine-wake-hedge-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const lan: LocalInterface = { name: 'eth0', address: '192.168.1.10', netmask: '255.255.255.0', internal: false };
const target = (): PeerTarget => ({ source: 'pinned', addresses: [{ host: '192.168.1.40', port: 47921 }], refused: [] });
const settings = (wake: Partial<WakeConfig> = {}) => {
  const s = settingsFromConfig('linux-box', { mac: MAC, ...wake });
  if (!s.ok) throw new Error(s.message);
  return s.settings;
};

interface Options {
  /** The FIRST attempt takes `ms` (virtual) and then connects ('up') or fails with these kinds. */
  first: { ms: number; then: 'up' | ConnectFailureKind[] };
  /** Later attempts: each costs this, and connects from `upAtMs` on. */
  costMs?: number;
  upAtMs?: number;
  interfaces?: LocalInterface[];
}

function world(options: Options) {
  let t = 0;
  const log = {
    sends: [] as Array<{ method: WakeMethod; at: number }>,
    connects: [] as Array<{ at: number; timeoutMs: number | undefined }>,
    info: [] as string[],
    sleeps: [] as number[],
  };
  const timers: Array<{ at: number; resolve: () => void }> = [];
  let draining = false;
  const drain = (): void => {
    if (draining) return;
    draining = true;
    setImmediate(() => {
      draining = false;
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift();
      if (next === undefined) return;
      t = Math.max(t, next.at);
      next.resolve();
      if (timers.length > 0) drain();
    });
  };
  const sleepVirtual = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = { at: t + ms, resolve };
      timers.push(timer);
      signal?.addEventListener('abort', () => {
        const i = timers.indexOf(timer);
        if (i >= 0) timers.splice(i, 1);
        resolve();
      });
      drain();
    });
  const failure = (address: AddressEntry, kinds: ConnectFailureKind[]): AllAddressesFailedError =>
    new AllAddressesFailedError(
      `could not connect to any of the 1 address(es): ${address.host}:${address.port}: down`,
      kinds.map((kind) => ({ address, reason: `cannot reach ${address.host}:${address.port}: ${kind}`, kind })),
    );
  const sender: WakeSender = {
    send: async (method, _packet, routes: readonly WakeRoute[]): Promise<SendReport> => {
      log.sends.push({ method, at: t });
      return { destinations: routes.flatMap((r) => (method === 'unicast' ? r.unicast : [r.broadcast]).map((to) => ({ method, to, from: r.localAddress, ok: true }))) };
    },
  };
  const session = { close: () => undefined } as unknown as PeerSession;
  const env: WakeEnv = {
    configDir: dir,
    self: { uuid: '11111111-2222-4333-8444-555555555555', name: 'desktop' },
    peer: PEER,
    requestedBy: 'run',
    epochSeconds: () => EPOCH0 + Math.floor(t / 1000),
    nowMs: () => t,
    sleep: async (ms, signal) => {
      log.sleeps.push(ms);
      await sleepVirtual(ms, signal);
    },
    interfaces: () => options.interfaces ?? [lan],
    sender,
    info: (line) => log.info.push(line),
    ok: (line) => log.info.push(line),
    warn: (line) => log.info.push(line),
    resolveTarget: async () => target(),
    connect: async (tg, opts): Promise<Connected> => {
      const address = tg.addresses[0] as AddressEntry;
      log.connects.push({ at: t, timeoutMs: opts.timeoutMs });
      if (log.connects.length === 1) {
        await sleepVirtual(options.first.ms);
        if (options.first.then === 'up') return { session, address, failures: [] };
        throw failure(address, options.first.then);
      }
      if (options.upAtMs !== undefined && t >= options.upAtMs) return { session, address, failures: [] };
      t += options.costMs ?? 0;
      throw failure(address, ['unreachable']);
    },
  };
  return { env, log, now: () => t };
}

const auditEntries = (): Array<Record<string, unknown>> =>
  existsSync(wakeAuditFile(dir)) ? readFileSync(wakeAuditFile(dir), 'utf8').trimEnd().split('\n').map((l) => (JSON.parse(l) as { entry: Record<string, unknown> }).entry) : [];
const sends = (w: ReturnType<typeof world>): string[] => w.log.sends.map((s) => `${s.method}@${s.at}`);
const said = (w: ReturnType<typeof world>): string => w.log.info.join('\n');

describe('hedged first packet (decision 97): the first magic packet leaves while the first attempt is still pending', () => {
  it('defaults to 500 ms, 0 disables', () => {
    expect(settings().tuning.values.hedgeMs).toBe(500);
    expect(settings({ hedgeMs: 0 }).tuning.values.hedgeMs).toBe(0);
  });

  it('an awake peer that answers within 500 ms receives NO packet, and the hedge timer is cancelled', async () => {
    const w = world({ first: { ms: 300, then: 'up' } });
    const r = await connectWithWake(w.env, target(), settings());
    expect(r.wake).toBeUndefined();
    expect(w.log.sends).toEqual([]);
    expect(w.log.info).toEqual([]);
    expect(existsSync(wakeAuditFile(dir))).toBe(false);
    expect(existsSync(wakeStateFile(dir))).toBe(false);
    // The clock stopped at the answer: the 500 ms timer did not fire later.
    expect(w.now()).toBe(300);
  });

  it('a peer that is awake but slow (800 ms) receives ONE harmless packet at 500 ms, with no second attempt; the timeline says so', async () => {
    const w = world({ first: { ms: 800, then: 'up' } });
    const r = await connectWithWake(w.env, target(), settings());
    expect(sends(w)).toEqual(['broadcast@500']);
    expect(w.log.connects.length).toBe(1);
    expect(r.wake).toMatchObject({ outcome: 'answered', packets: 1, hedged: true, firstPacketAtSeconds: 0.5, answeredAtSeconds: 0.8 });
    expect(said(w)).toContain('first attempt at 0.0 s, first packet at 0.5 s (hedged, attempt still pending), answered at 0.8 s');
    expect(said(w)).toMatch(/woken by broadcast \(probe window 1, 0\.3 s into its 5 s\)/);
    expect(auditEntries().map((e) => e.event)).toEqual(['wake.packet', 'wake.result']);
    expect(auditEntries()[0]).toMatchObject({ method: 'broadcast', n: 1, hedged: true });
    expect(readWakeState(dir).peers[UUID]).toEqual({ lastWakeAt: EPOCH0 });
  });

  it('a sleeping peer: packet 1 at 500 ms while the attempt times out at 3 s, then the sequence goes on from packet 1 (packet 2 five seconds after it)', async () => {
    const w = world({ first: { ms: 3000, then: ['timeout'] }, upAtMs: 9000, costMs: 500 });
    const r = await connectWithWake(w.env, target(), settings({ connectTimeoutMs: 500 }));
    expect(sends(w)).toEqual(['broadcast@500', 'unicast@5500']);
    // The first attempt keeps the normal limit; the probes after it use the probe limit; there is no second "first attempt".
    expect(w.log.connects[0]?.timeoutMs).toBeUndefined();
    expect(w.log.connects.slice(1).every((c) => c.timeoutMs === 500)).toBe(true);
    expect(r.wake).toMatchObject({ packets: 2, hedged: true, firstPacketAtSeconds: 0.5, followedBy: 'unicast', window: 2 });
    expect(said(w)).toMatch(/first attempt at 0\.0 s, first packet at 0\.5 s \(hedged, attempt still pending\), answered at \d+(\.\d)? s/);
    expect(said(w)).toMatch(/\[1\/8\] broadcast to 192\.168\.1\.255/);
    expect(said(w)).toMatch(/"linux-box" is unreachable/);
  });

  it('the packet limits are unchanged: the hedged packet is packet 1 of the maximum', async () => {
    const w = world({ first: { ms: 3000, then: ['timeout'] }, costMs: 1000 });
    const e = await connectWithWake(w.env, target(), settings({ waitSeconds: 10, probeSeconds: 5, maxUnicast: 1, maxBroadcast: 1 })).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(WakeError);
    expect(sends(w).length).toBe(2);
    expect((e as Error).message).toMatch(/2 packets \(1 unicast, 1 broadcast\)/);
  });

  it('a refused connection that arrives BEFORE 500 ms: no packet', async () => {
    const w = world({ first: { ms: 100, then: ['refused'] } });
    await expect(connectWithWake(w.env, target(), settings())).rejects.toBeInstanceOf(AllAddressesFailedError);
    expect(w.log.sends).toEqual([]);
    expect(existsSync(wakeAuditFile(dir))).toBe(false);
    expect(said(w)).toMatch(/reachable but nothing listens/);
  });

  it.each(['refused', 'auth-closed', 'pair-proof', 'pin-mismatch', 'bad-certificate', 'protocol', 'unresolved', 'unknown'] as ConnectFailureKind[])(
    '%s that arrives AFTER the hedge: the packet already left (said honestly), the original error is rethrown, nothing more is sent',
    async (kind) => {
      const w = world({ first: { ms: 900, then: [kind] } });
      await expect(connectWithWake(w.env, target(), settings())).rejects.toBeInstanceOf(AllAddressesFailedError);
      expect(sends(w)).toEqual(['broadcast@500']);
      expect(said(w)).toMatch(/one magic packet was already sent at 0\.5 s/);
      expect(said(w)).toMatch(/still pending after 500 ms/);
    },
  );

  it.each(['auth-closed', 'pin-mismatch', 'protocol'] as ConnectFailureKind[])('%s that arrives BEFORE the hedge: no packet at all', async (kind) => {
    const w = world({ first: { ms: 100, then: [kind] } });
    await expect(connectWithWake(w.env, target(), settings())).rejects.toBeInstanceOf(AllAddressesFailedError);
    expect(w.log.sends).toEqual([]);
    expect(said(w)).not.toMatch(/already sent/);
  });

  it('never fires without wake settings (no MAC pinned, --no-wake): no timer, no packet', async () => {
    const w = world({ first: { ms: 2000, then: ['timeout'] } });
    await expect(connectWithWake(w.env, target(), undefined)).rejects.toBeInstanceOf(AllAddressesFailedError);
    expect(w.log.sends).toEqual([]);
    expect(w.log.sleeps).toEqual([]);
  });

  it('hedgeMs 0 restores the old behaviour: no timer, the first packet leaves when the first attempt has failed', async () => {
    const w = world({ first: { ms: 3000, then: ['timeout'] }, upAtMs: 9000, costMs: 500 });
    const r = await connectWithWake(w.env, target(), settings({ hedgeMs: 0, connectTimeoutMs: 500 }));
    expect(sends(w)[0]).toBe('broadcast@3000');
    expect(w.log.sleeps.includes(500) && w.log.sleeps[0] === 500).toBe(false);
    expect(r.wake).toMatchObject({ hedged: false, firstPacketAtSeconds: 3 });
    expect(said(w)).toMatch(/first attempt at 0\.0 s, first packet at 3\.0 s \(after the attempt failed\), answered at \d+(\.\d)? s/);
  });

  it('a custom hedgeMs is honoured (1000 ms): answered at 800 ms sends nothing, at 1200 ms the packet leaves at 1000 ms', async () => {
    const quick = world({ first: { ms: 800, then: 'up' } });
    await connectWithWake(quick.env, target(), settings({ hedgeMs: 1000 }));
    expect(quick.log.sends).toEqual([]);
    const slow = world({ first: { ms: 1200, then: 'up' } });
    await connectWithWake(slow.env, target(), settings({ hedgeMs: 1000 }));
    expect(sends(slow)).toEqual(['broadcast@1000']);
  });

  it('the cooldown is respected: no hedged packet within 60 s of the last wake', async () => {
    recordWake(dir, UUID, EPOCH0 - 10);
    const w = world({ first: { ms: 900, then: 'up' } });
    const r = await connectWithWake(w.env, target(), settings());
    expect(w.log.sends).toEqual([]);
    expect(r.wake).toBeUndefined();
    expect(existsSync(wakeAuditFile(dir))).toBe(false);
  });

  it('the cooldown also holds when the slow attempt then fails: the usual cooldown message, no packet', async () => {
    recordWake(dir, UUID, EPOCH0 - 10);
    const w = world({ first: { ms: 900, then: ['timeout'] }, costMs: 1000 });
    const e = await connectWithWake(w.env, target(), settings({ waitSeconds: 10 })).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(WakeError);
    expect(w.log.sends).toEqual([]);
    expect(said(w)).toMatch(/no new packet for another/);
  });

  it('a network that is not the LAN of the peer: no hedged packet, the usual explanation when the attempt fails', async () => {
    const w = world({ first: { ms: 900, then: ['timeout'] }, interfaces: [{ name: 'tun0', address: '10.8.0.5', netmask: '255.255.255.0', internal: false }] });
    const e = await connectWithWake(w.env, target(), settings()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(WakeError);
    expect((e as Error).message).toMatch(/not on the same network as linux-box/);
    expect(w.log.sends).toEqual([]);
  });

  it('with no packet at all (cooldown) the timeline says no packet was sent', async () => {
    recordWake(dir, UUID, EPOCH0 - 10);
    const w = world({ first: { ms: 900, then: ['timeout'] }, upAtMs: 3000, costMs: 500 });
    const r = await connectWithWake(w.env, target(), settings({ connectTimeoutMs: 500 }));
    expect(r.wake).toMatchObject({ packets: 0, hedged: false });
    expect(said(w)).toMatch(/first attempt at 0\.0 s, no packet sent by this run, answered at \d+(\.\d)? s/);
  });
});
