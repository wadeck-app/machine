import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSigningKeyPair, verifyAuditChain, type AddressEntry, type ConnectFailureKind, type LocalInterface, type WakeConfig, type WakeMethod, type WakeRoute } from '@wadeck-app/machine-core';
import { ConnectError, type PeerSession } from '@wadeck-app/machine-transport';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AllAddressesFailedError, PeerAddressError } from './peerAddresses.js';
import type { Connected, PeerTarget, PeerToReach } from './peerConnect.js';
import { readWakeState, recordWake, wakeStateFile } from './wakeState.js';
import { wakeAuditFile } from './wakeAudit.js';
import { WakeError, connectWithWake, settingsFromConfig, wakeEnabled, type WakeEnv } from './wakeConnect.js';
import type { SendReport, WakeSender } from './wakeSender.js';

const UUID = '3f2a9c10-1b2c-4d3e-8f40-0123456789ab';
const PEER: PeerToReach = { peerId: UUID, name: 'linux-box', identityPublicKey: 'key', pairSecret: Buffer.alloc(32) };
const EPOCH0 = 1_000_000;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'machine-wake-connect-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const lan: LocalInterface = { name: 'eth0', address: '192.168.1.10', netmask: '255.255.255.0', internal: false };
const target = (host = '192.168.1.40', source: PeerTarget['source'] = 'pinned'): PeerTarget => ({ source, addresses: [{ host, port: 47921 }], refused: [] });
const MAC = 'aa:bb:cc:dd:ee:01';
const settings = (wake: Partial<WakeConfig> = {}) => {
  const s = settingsFromConfig('linux-box', { mac: MAC, ...wake });
  if (!s.ok) throw new Error(s.message);
  return s.settings;
};

interface Options {
  /** The peer answers from this fake time on. */
  upAtMs?: number;
  /** What a connection attempt costs while the peer is down (the very first one, before any wake, is free: the clock starts at the first failure). */
  costMs?: number;
  /** What the successful attempt costs (the handshake of a woken machine). */
  upCostMs?: number;
  down?: ConnectFailureKind[];
  /** After the peer is up, fail with this instead of connecting. */
  afterUp?: ConnectFailureKind[];
  /** With `afterUp`: the daemon listens from this fake time on (the peer connects). */
  daemonAtMs?: number;
  interfaces?: LocalInterface[];
  sendFails?: boolean;
  resolveTo?: PeerTarget;
}

function world(options: Options = {}) {
  let t = 0;
  const log = {
    sends: [] as Array<{ method: WakeMethod; at: number; routes: WakeRoute[] }>,
    connects: [] as Array<{ at: number; host: string; timeoutMs: number | undefined }>,
    info: [] as string[],
    warn: [] as string[],
    sleeps: [] as number[],
    resolved: 0,
  };
  const sender: WakeSender = {
    send: async (method, packet, routes): Promise<SendReport> => {
      if (options.sendFails) throw new Error('could not send the packet: ENETUNREACH');
      expect(packet.length).toBe(102);
      log.sends.push({ method, at: t, routes: [...routes] });
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
    sleep: async (ms) => {
      log.sleeps.push(ms);
      t += ms;
    },
    interfaces: () => options.interfaces ?? [lan],
    sender,
    info: (line) => log.info.push(line),
    ok: (line) => log.info.push(line),
    warn: (line) => log.warn.push(line),
    resolveTarget: async () => {
      log.resolved++;
      return options.resolveTo ?? target('192.168.1.40', 'relay');
    },
    connect: async (tg, opts): Promise<Connected> => {
      const address = tg.addresses[0] as AddressEntry;
      log.connects.push({ at: t, host: address.host, timeoutMs: opts.timeoutMs });
      const up = options.upAtMs !== undefined && t >= options.upAtMs;
      if (up && (options.afterUp === undefined || (options.daemonAtMs !== undefined && t >= options.daemonAtMs))) {
        t += options.upCostMs ?? 0;
        return { session, address, failures: [] };
      }
      const kinds = up ? (options.afterUp as ConnectFailureKind[]) : (options.down ?? ['unreachable']);
      if (log.connects.length > 1) t += options.costMs ?? 0;
      throw new AllAddressesFailedError(
        `could not connect to any of the 1 address(es): ${address.host}:${address.port}: down`,
        kinds.map((kind) => ({ address, reason: `cannot reach ${address.host}:${address.port}: ${kind}`, kind })),
      );
    },
  };
  return { env, log, now: () => t };
}

const auditEntries = (): Array<Record<string, unknown>> =>
  existsSync(wakeAuditFile(dir)) ? readFileSync(wakeAuditFile(dir), 'utf8').trimEnd().split('\n').map((l) => (JSON.parse(l) as { entry: Record<string, unknown> }).entry) : [];

describe('wakeEnabled: which connections may wake', () => {
  const wake = { mac: MAC };
  it('follows the configured type; flags override it', () => {
    expect(wakeEnabled({ connection: undefined, wake: false, noWake: false, peerName: 'x' })).toEqual({ ok: true, enabled: false });
    expect(wakeEnabled({ connection: { type: 'direct' }, wake: false, noWake: false, peerName: 'x' })).toEqual({ ok: true, enabled: false });
    expect(wakeEnabled({ connection: { type: 'ping-if-not-reachable-magic-packet', wake }, wake: false, noWake: false, peerName: 'x' })).toEqual({ ok: true, enabled: true });
    expect(wakeEnabled({ connection: { type: 'ping-if-not-reachable-magic-packet', wake }, wake: false, noWake: true, peerName: 'x' })).toEqual({ ok: true, enabled: false });
    expect(wakeEnabled({ connection: { type: 'direct', wake }, wake: true, noWake: false, peerName: 'x' })).toEqual({ ok: true, enabled: true });
  });

  it('--wake with no MAC configured says how to set it; --wake with --no-wake is a usage error', () => {
    const r = wakeEnabled({ connection: { type: 'direct' }, wake: true, noWake: false, peerName: 'linux-box' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/machine peer connect linux-box --wake-mac aa:bb:cc:dd:ee:ff/);
    const both = wakeEnabled({ connection: undefined, wake: true, noWake: true, peerName: 'x' });
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.message).toMatch(/--wake and --no-wake/);
  });
});

describe('settingsFromConfig', () => {
  it('parses the MAC and resolves the tuning over the defaults', () => {
    const s = settings({ probeSeconds: 8 });
    expect(s.mac).toBe(MAC);
    expect(s.macBytes.length).toBe(6);
    expect(s.tuning.values.probeSeconds).toBe(8);
    expect(s.tuning.defaulted).toContain('waitSeconds');
  });

  it('refuses a bad MAC and a configuration that sends nothing, with the fix', () => {
    const bad = settingsFromConfig('box', { mac: 'zz' });
    expect(bad.ok).toBe(false);
    const none = settingsFromConfig('box', { mac: MAC, maxUnicast: 0, maxBroadcast: 0 });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.message).toMatch(/no packet would ever be sent/);
  });
});

describe('connectWithWake', () => {
  it('connects at once: no packet, no audit, no state, no output', async () => {
    const w = world({ upAtMs: 0 });
    const r = await connectWithWake(w.env, target(), settings());
    expect(r.wake).toBeUndefined();
    expect(w.log.sends).toEqual([]);
    expect(w.log.info).toEqual([]);
    expect(existsSync(wakeAuditFile(dir))).toBe(false);
    expect(existsSync(wakeStateFile(dir))).toBe(false);
  });

  it('without wake settings a failure is rethrown unchanged and nothing is sent', async () => {
    const w = world({ costMs: 3000 });
    await expect(connectWithWake(w.env, target(), undefined)).rejects.toBeInstanceOf(AllAddressesFailedError);
    expect(w.log.sends).toEqual([]);
  });

  it('sends broadcast, probes, sends unicast, probes, alternating; success after the third packet stops it and is measured', async () => {
    // 1000 ms attempts (the fake attempt costs 1000 ms): one probe per second.
    const w = world({ upAtMs: 12_000, costMs: 1000 });
    const r = await connectWithWake(w.env, target(), settings({ connectTimeoutMs: 1000 }));
    expect(w.log.sends.map((s) => `${s.method}@${s.at}`)).toEqual(['broadcast@0', 'unicast@5000', 'broadcast@10000']);
    expect(w.log.sends[0]?.routes[0]).toMatchObject({ unicast: ['192.168.1.40'], broadcast: '192.168.1.255', localAddress: '192.168.1.10' });
    // Probes between the packets: about one attempt per second, each with the limit of the peer settings.
    const between = w.log.connects.filter((c) => c.at > 0 && c.at < 5000);
    expect(between.length).toBeGreaterThanOrEqual(3);
    expect(between.every((c) => c.timeoutMs === 1000)).toBe(true);
    // The first attempt (before any wake) keeps the normal limit.
    expect(w.log.connects[0]?.timeoutMs).toBeUndefined();
    expect(r.wake).toMatchObject({ outcome: 'answered', packets: 3, followedBy: 'broadcast', window: 3, elapsedSeconds: 12 });
    const said = w.log.info.join('\n');
    expect(said).toMatch(/"linux-box" is unreachable/);
    expect(said).toMatch(/\[1\/8\] broadcast to 192\.168\.1\.255/);
    expect(said).toMatch(/still unreachable after 5 s: \[2\/8\] unicast to 192\.168\.1\.40/);
    expect(said).toMatch(/answered after 12 s, woken by broadcast \(probe window 3, 2 s into its 5 s\)/);
    expect(said).toMatch(/no acknowledgement/);
    // Early in its window (2 s of 5): no tuning hint.
    expect(said).not.toMatch(/--wake-probe/);
  });

  it('an answer right after the first broadcast packet sends no unicast at all', async () => {
    const w = world({ upAtMs: 1000, costMs: 1000 });
    const r = await connectWithWake(w.env, target(), settings());
    expect(w.log.sends.map((s) => s.method)).toEqual(['broadcast']);
    expect(r.wake?.followedBy).toBe('broadcast');
  });

  it('prints the measured time and, when it took more than 80% of a window, the hint to raise probeSeconds for that peer', async () => {
    const w = world({ upAtMs: 14_000, upCostMs: 200, costMs: 1000 });
    await connectWithWake(w.env, target(), settings({ connectTimeoutMs: 1000 }));
    const said = w.log.info.join('\n');
    expect(said).toMatch(/answered after 14\.2 s, woken by broadcast \(probe window 3, 4\.2 s into its 5 s\)/);
    expect(said).toMatch(/4\.2 s into a 5 s probe window/);
    expect(said).toMatch(/machine peer connect linux-box --wake-probe 10/);
  });

  it('records one audit entry per packet (before it is sent) and one result: who, what, which method, how many', async () => {
    const w = world({ upAtMs: 7000, costMs: 1000 });
    await connectWithWake(w.env, target(), settings());
    const entries = auditEntries();
    expect(entries.map((e) => e.event)).toEqual(['wake.packet', 'wake.packet', 'wake.result']);
    expect(entries[0]).toMatchObject({
      requestedBy: 'run',
      sourceUuid: '11111111-2222-4333-8444-555555555555',
      sourceName: 'desktop',
      peerUuid: UUID,
      peerName: 'linux-box',
      mac: MAC,
      method: 'broadcast',
      n: 1,
      total: 8,
      to: ['192.168.1.255'],
    });
    expect(entries[1]).toMatchObject({ method: 'unicast', n: 2, to: ['192.168.1.40'] });
    expect(entries[2]).toMatchObject({ outcome: 'answered', packets: 2, followedBy: 'unicast', window: 2 });
    expect(verifyAuditChain(readFileSync(wakeAuditFile(dir), 'utf8').trimEnd().split('\n'))).toMatchObject({ ok: true, entries: 3 });
    // Never "woke": a packet that was sent is "sent".
    expect(JSON.stringify(entries)).not.toMatch(/"woke"/);
  });

  it('an explicit wake (bypassCooldown) sends packets even when the last wake was seconds ago; the packet limits still apply', async () => {
    recordWake(dir, UUID, EPOCH0 - 5);
    const run = world({ costMs: 1000 });
    const err = await connectWithWake(run.env, target(), settings({ waitSeconds: 10, probeSeconds: 2 })).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(WakeError);
    expect(run.log.sends).toEqual([]);
    expect((err as Error).message).toMatch(/cooldown/);
    const explicit = world({ costMs: 1000 });
    explicit.env.bypassCooldown = true;
    const again = await connectWithWake(explicit.env, target(), settings({ waitSeconds: 10, probeSeconds: 2, maxUnicast: 2, maxBroadcast: 1 })).catch((x: unknown) => x);
    expect(again).toBeInstanceOf(WakeError);
    expect(explicit.log.sends.map((s) => s.method)).toEqual(['broadcast', 'unicast', 'unicast']);
    expect(explicit.log.info.join('\n')).not.toMatch(/cooldown/);
  });

  it('writes the cooldown state when the first packet goes', async () => {
    const w = world({ upAtMs: 2000, costMs: 1000 });
    await connectWithWake(w.env, target(), settings());
    expect(readWakeState(dir).peers[UUID]).toEqual({ lastWakeAt: EPOCH0 });
  });

  describe('never wakes for a failure that is not "unreachable" or "timeout"', () => {
    it.each(['auth-closed', 'pair-proof', 'pin-mismatch', 'bad-certificate', 'protocol', 'unresolved', 'unknown'] as ConnectFailureKind[])('%s: rethrown, no packet, no audit, one info line', async (kind) => {
      const w = world({ down: [kind], costMs: 100 });
      await expect(connectWithWake(w.env, target(), settings())).rejects.toBeInstanceOf(AllAddressesFailedError);
      expect(w.log.sends).toEqual([]);
      expect(existsSync(wakeAuditFile(dir))).toBe(false);
      expect(existsSync(wakeStateFile(dir))).toBe(false);
      expect(w.log.info.join('\n')).toMatch(/not waking "linux-box"/);
    });

    it('a refused connection (the host answered, no daemon listens): no packet, and the message says to start the daemon', async () => {
      const w = world({ down: ['refused'], costMs: 100 });
      await expect(connectWithWake(w.env, target(), settings())).rejects.toBeInstanceOf(AllAddressesFailedError);
      expect(w.log.sends).toEqual([]);
      expect(existsSync(wakeAuditFile(dir))).toBe(false);
      expect(existsSync(wakeStateFile(dir))).toBe(false);
      const said = w.log.info.join('\n');
      expect(said).toContain('"linux-box" is reachable but nothing listens on 192.168.1.40:47921: it is awake, so a magic packet would not help. Start the daemon there (`machine startup enable` on that machine), then run the command again');
    });

    it('a refusal mixed with a timeout is still a refusal: the host is up', async () => {
      const w = world({ down: ['timeout', 'refused'], costMs: 100 });
      await expect(connectWithWake(w.env, target(), settings())).rejects.toBeInstanceOf(AllAddressesFailedError);
      expect(w.log.sends).toEqual([]);
      expect(w.log.info.join('\n')).toMatch(/reachable but nothing listens on 192\.168\.1\.40:47921/);
    });

    it('one address unreachable and another refusing authentication: not woken (the peer is up)', async () => {
      const w = world({ down: ['unreachable', 'auth-closed'], costMs: 100 });
      await expect(connectWithWake(w.env, target(), settings())).rejects.toBeInstanceOf(AllAddressesFailedError);
      expect(w.log.sends).toEqual([]);
    });

    it('an error that is not a connection failure (no address record, relay down) is rethrown untouched', async () => {
      const w = world();
      w.env.connect = async () => {
        throw new PeerAddressError('the relay has no address record for "linux-box"');
      };
      await expect(connectWithWake(w.env, target(), settings())).rejects.toThrow(/no address record/);
      expect(w.log.sends).toEqual([]);
    });

    it('an authentication failure that appears WHILE waiting stops the sequence and says the peer is up', async () => {
      const w = world({ upAtMs: 6000, costMs: 1000, afterUp: ['auth-closed'] });
      const e = await connectWithWake(w.env, target(), settings()).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(WakeError);
      expect((e as Error).message).toMatch(/reachable but .*authentication|answers, but the connection fails for another reason/i);
      expect(w.log.sends.length).toBe(2);
      expect(auditEntries().at(-1)).toMatchObject({ event: 'wake.result', outcome: 'aborted' });
    });

    it('a refusal that appears WHILE waiting (the host resumed, no daemon): no more packet, the probes go on to the end of the wait, then the daemon message', async () => {
      const w = world({ upAtMs: 6000, costMs: 1000, afterUp: ['refused'] });
      const e = await connectWithWake(w.env, target(), settings()).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(WakeError);
      expect((e as Error).message).toContain('"linux-box" is reachable but nothing listens on 192.168.1.40:47921: it is awake, so a magic packet would not help. Start the daemon there (`machine startup enable` on that machine), then run the command again');
      expect((e as Error).message).toMatch(/still refused after 90 s of probing/);
      // Two packets before the refusal at 6 s, none after; the probes went on to the 90 s of the wait.
      expect(w.log.sends.length).toBe(2);
      expect(w.log.connects.filter((c) => c.at > 20_000).length).toBeGreaterThan(20);
      expect(w.now()).toBeGreaterThanOrEqual(90_000);
      expect(auditEntries().at(-1)).toMatchObject({ event: 'wake.result', outcome: 'refused', packets: 2 });
    });

    it('a daemon that starts a few seconds after the host resumed is a success: the answer says the host was awake and how long the daemon took', async () => {
      const w = world({ upAtMs: 6000, costMs: 1000, afterUp: ['refused'], daemonAtMs: 20_000 });
      const r = await connectWithWake(w.env, target(), settings({ connectTimeoutMs: 1000 }));
      expect(r.wake).toMatchObject({ outcome: 'answered', packets: 2, elapsedSeconds: 20 });
      expect(r.wake?.awakeAfterSeconds).toBeGreaterThanOrEqual(5);
      expect(r.wake?.daemonTookSeconds).toBeGreaterThanOrEqual(10);
      expect(w.log.info.join(' | ')).toMatch(/answered after 20 s \(the host was awake, the daemon took 1\d(\.\d)? s to listen\)/);
      expect(auditEntries().at(-1)).toMatchObject({ event: 'wake.result', outcome: 'answered' });
    });
  });

  describe('where a packet may go', () => {
    it('this machine is not on the LAN of the peer: nothing is sent, no audit, and the message says why and what to do', async () => {
      const w = world({ costMs: 3000, interfaces: [{ name: 'tun0', address: '10.8.0.5', netmask: '255.255.255.0', internal: false }] });
      const e = await connectWithWake(w.env, target(), settings()).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(WakeError);
      expect((e as Error).message).toMatch(/"linux-box" is unreachable/);
      expect((e as Error).message).toMatch(/not on the same network as linux-box/);
      expect((e as Error).message).toMatch(/nothing was sent/);
      expect(w.log.sends).toEqual([]);
      expect(existsSync(wakeAuditFile(dir))).toBe(false);
      expect(existsSync(wakeStateFile(dir))).toBe(false);
    });

    it('no IPv4 address known but a configured broadcast of this LAN: broadcast only, and the output says so', async () => {
      const w = world({ upAtMs: 9000, costMs: 1000 });
      await connectWithWake(w.env, target('box.example.net'), settings({ broadcast: '192.168.1.255', connectTimeoutMs: 1000 }));
      expect(w.log.sends.every((s) => s.method === 'broadcast')).toBe(true);
      expect(w.log.sends.length).toBe(2);
      expect(w.log.info.join('\n')).toMatch(/no known IPv4 address of "linux-box" on this network: broadcast only/);
    });

    it('no IPv4 address known and no configured broadcast: stops, no blind broadcast', async () => {
      const w = world({ costMs: 3000 });
      await expect(connectWithWake(w.env, target('box.example.net'), settings())).rejects.toThrow(/cannot tell whether this machine is on the LAN/);
      expect(w.log.sends).toEqual([]);
    });

    it('a configured broadcast that is not the broadcast of this LAN is refused', async () => {
      const w = world({ costMs: 3000 });
      await expect(connectWithWake(w.env, target(), settings({ broadcast: '255.255.255.255' }))).rejects.toThrow(/broadcast address 255\.255\.255\.255 is not allowed/);
      expect(w.log.sends).toEqual([]);
    });

    it('the pinned address decides the subnet check, not the relay (the relay was not asked)', async () => {
      const w = world({ upAtMs: 1000, costMs: 1000 });
      await connectWithWake(w.env, target('192.168.1.40', 'pinned'), settings());
      expect(w.log.resolved).toBe(0);
    });
  });

  describe('limits', () => {
    it('never more than 4 unicast and 4 broadcast packets, probing on until the wait budget is used, then a message with the numbers and the fixes', async () => {
      const w = world({ costMs: 1000 });
      const e = await connectWithWake(w.env, target(), settings()).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(WakeError);
      const message = (e as Error).message;
      expect(message).toMatch(/no answer from "linux-box" after 90 s and 8 packets \(4 unicast, 4 broadcast\)/);
      expect(message).toMatch(/no acknowledgement/);
      expect(message).toMatch(/BIOS/);
      expect(message).toMatch(/suspend|sleep/i);
      expect(message).toMatch(/machine startup enable/);
      expect(message).toMatch(/--wake-wait 180/);
      expect(message).toMatch(/--wake-probe/);
      expect(w.log.sends.length).toBe(8);
      expect(w.log.sends.filter((s) => s.method === 'unicast').length).toBe(4);
      expect(w.now()).toBeGreaterThanOrEqual(90_000);
      expect(auditEntries().at(-1)).toMatchObject({ event: 'wake.result', outcome: 'no-answer', packets: 8 });
    });

    it('timings come from the settings of the peer: 2 s windows, 1 unicast + 2 broadcast, 20 s wait', async () => {
      const w = world({ costMs: 500 });
      await connectWithWake(w.env, target(), settings({ probeSeconds: 2, maxUnicast: 1, maxBroadcast: 2, waitSeconds: 20, connectTimeoutMs: 500 })).catch(() => undefined);
      expect(w.log.sends.map((s) => `${s.method}@${s.at}`)).toEqual(['broadcast@0', 'unicast@2000', 'broadcast@4000']);
      expect(w.now()).toBeGreaterThanOrEqual(20_000);
      expect(w.now()).toBeLessThan(21_500);
      expect(w.log.connects.slice(1).every((c) => c.timeoutMs === 500)).toBe(true);
    });

    it('a probe that fails fast is retried every 500 ms, not every connectTimeoutMs: the answer is noticed early, and the attempts stay bounded', async () => {
      // costMs 0: the fake attempt fails at once (the real one can, e.g. no route right after a resume). connectTimeoutMs stays 3000 (the limit of ONE attempt).
      const w = world({ costMs: 0, upAtMs: 7300 });
      const r = await connectWithWake(w.env, target(), settings());
      expect(w.log.connects.slice(1).filter((c) => c.at < 5000).map((c) => c.at)).toEqual([0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500]);
      expect(w.log.connects.every((c) => c.timeoutMs === undefined || c.timeoutMs === 3000)).toBe(true);
      expect(r.wake?.elapsedSeconds).toBe(7.5);
      // Never faster than every 500 ms: at most 2 attempts per second.
      expect(w.log.sleeps.every((ms) => ms > 0 && ms <= 500)).toBe(true);
    });

    it('a short connectTimeoutMs below 500 ms keeps the retry interval at that value (the attempts still start about one limit apart)', async () => {
      const w = world({ costMs: 0 });
      await connectWithWake(w.env, target(), settings({ connectTimeoutMs: 200, waitSeconds: 5, probeSeconds: 5 })).catch(() => undefined);
      expect(w.log.connects.slice(1, 5).map((c) => c.at)).toEqual([0, 200, 400, 600]);
    });

    it('cooldown: a wake sent less than 60 s ago sends no packet but still waits and answers if the peer comes up', async () => {
      recordWake(dir, UUID, EPOCH0 - 20);
      const w = world({ upAtMs: 6000, costMs: 1000 });
      const r = await connectWithWake(w.env, target(), settings());
      expect(w.log.sends).toEqual([]);
      expect(r.wake).toMatchObject({ outcome: 'answered', packets: 0 });
      const said = w.log.info.join('\n');
      expect(said).toMatch(/woken 20 s ago from this machine: no new packet for another 40 s/);
      // The state is not extended by a run that sent nothing.
      expect(readWakeState(dir).peers[UUID]).toEqual({ lastWakeAt: EPOCH0 - 20 });
    });

    it('cooldown, peer still down at the end: an honest message (no packet was sent this time)', async () => {
      recordWake(dir, UUID, EPOCH0 - 5);
      const w = world({ costMs: 1000 });
      const e = await connectWithWake(w.env, target(), settings({ waitSeconds: 10 })).catch((x: unknown) => x);
      expect((e as Error).message).toMatch(/no answer from "linux-box" after 10 s and 0 packets/);
      expect((e as Error).message).toMatch(/cooldown/);
      expect(w.log.sends).toEqual([]);
    });
  });

  describe('failing loudly', () => {
    it('a send that fails ends the wake with the cause, not a silent wait', async () => {
      const w = world({ costMs: 1000, sendFails: true });
      const e = await connectWithWake(w.env, target(), settings()).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(WakeError);
      expect((e as Error).message).toMatch(/ENETUNREACH/);
      expect((e as Error).message).toMatch(/no packet was sent/i);
      expect(w.now()).toBeLessThan(5000);
    });

    it('a wake audit log that cannot be written (edited) means NO packet', async () => {
      writeFileSync(wakeAuditFile(dir), 'not a chain\n');
      const w = world({ costMs: 1000 });
      const e = await connectWithWake(w.env, target(), settings()).catch((x: unknown) => x);
      expect((e as Error).message).toMatch(/wake audit log/);
      expect(w.log.sends).toEqual([]);
    });

    it('a corrupt cooldown file stops before anything is sent, naming the file', async () => {
      writeFileSync(wakeStateFile(dir), '{');
      const w = world({ costMs: 1000 });
      await expect(connectWithWake(w.env, target(), settings())).rejects.toThrow(/wake-state\.json/);
      expect(w.log.sends).toEqual([]);
    });
  });

  describe('settle and refresh', () => {
    it('settleSeconds pauses after the answer, before the command, and says so', async () => {
      const w = world({ upAtMs: 2000, costMs: 1000 });
      await connectWithWake(w.env, target(), settings({ settleSeconds: 3 }));
      expect(w.log.sleeps.at(-1)).toBe(3000);
      expect(w.log.info.join('\n')).toMatch(/waiting 3 s before the command \(settleSeconds: /);
    });

    it('no settle by default', async () => {
      const w = world({ upAtMs: 2000, costMs: 1000 });
      await connectWithWake(w.env, target(), settings());
      expect(w.log.info.join('\n')).not.toMatch(/settleSeconds/);
    });

    it('with the relay record the address is read again about every 10 s, and the new address is the one unicast to', async () => {
      const w = world({ costMs: 1000, resolveTo: target('192.168.1.41', 'relay') });
      await connectWithWake(w.env, target('192.168.1.40', 'relay'), settings({ waitSeconds: 40 })).catch(() => undefined);
      expect(w.log.resolved).toBeGreaterThanOrEqual(3);
      const unicasts = w.log.sends.filter((s) => s.method === 'unicast');
      expect(unicasts[0]?.routes[0]?.unicast).toEqual(['192.168.1.40']);
      expect(unicasts.at(-1)?.routes[0]?.unicast).toEqual(['192.168.1.41']);
    });

    it('pinned addresses are never replaced by the relay', async () => {
      const w = world({ costMs: 1000, resolveTo: target('192.168.1.99', 'relay') });
      await connectWithWake(w.env, target('192.168.1.40', 'pinned'), settings({ waitSeconds: 20 })).catch(() => undefined);
      expect(w.log.resolved).toBe(0);
      expect(w.log.sends.every((s) => s.routes[0]?.unicast.every((u) => u === '192.168.1.40'))).toBe(true);
    });
  });
});

void generateSigningKeyPair;
