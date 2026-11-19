import { describe, expect, it } from 'vitest';
import {
  WAKE_COOLDOWN_SECONDS,
  WAKE_PORT,
  WAKE_TUNING_DEFAULTS,
  WAKE_TUNING_FIELDS,
  WAKE_TUNING_LIMITS,
  buildMagicPacket,
  checkTuning,
  cooldownRemainingSeconds,
  describeAnswer,
  directedBroadcast,
  formatMac,
  isWakeableFailure,
  parseMac,
  planWakeSteps,
  resolveTuning,
  selectWakeRoutes,
  type ConnectFailureKind,
  type LocalInterface,
} from './wake.js';

describe('parseMac', () => {
  it('accepts colons and dashes, any case, and normalises to lowercase with colons', () => {
    for (const text of ['AA:BB:CC:DD:EE:01', 'aa-bb-cc-dd-ee-01', 'aA:bB:cC:dD:eE:01']) {
      const r = parseMac(text);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.mac).toBe('aa:bb:cc:dd:ee:01');
        expect(Array.from(r.bytes)).toEqual([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x01]);
      }
    }
  });

  it.each([
    ['aabbccddee01', 'no separators'],
    ['aa:bb:cc:dd:ee', 'five octets'],
    ['aa:bb:cc:dd:ee:01:02', 'seven octets'],
    ['aa:bb:cc:dd:ee:0g', 'not hexadecimal'],
    ['aa.bb.cc.dd.ee.01', 'dots'],
    ['aa:bb-cc:dd-ee:01', 'mixed separators'],
    ['aabb.ccdd.ee01', 'Cisco notation'],
    [' aa:bb:cc:dd:ee:01', 'leading space'],
    ['', 'empty'],
  ])('refuses %j (%s) and says what is expected', (text) => {
    const r = parseMac(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/aa:bb:cc:dd:ee:ff|six/);
  });

  it('refuses the all-zero, broadcast and multicast addresses: they are not the address of one network card', () => {
    for (const text of ['00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff', '01:00:5e:00:00:01']) {
      const r = parseMac(text);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/one network card/);
    }
  });

  it('formatMac is the inverse', () => {
    expect(formatMac(Uint8Array.from([1, 2, 3, 0xaa, 0xbb, 0xff]))).toBe('01:02:03:aa:bb:ff');
  });
});

describe('buildMagicPacket', () => {
  it('is 6 bytes of 0xFF followed by the MAC 16 times: 102 bytes', () => {
    const r = parseMac('aa:bb:cc:dd:ee:01');
    if (!r.ok) throw new Error('setup');
    const p = buildMagicPacket(r.bytes);
    expect(p.length).toBe(102);
    expect(Array.from(p.subarray(0, 6))).toEqual([255, 255, 255, 255, 255, 255]);
    for (let i = 0; i < 16; i++) expect(Array.from(p.subarray(6 + i * 6, 12 + i * 6))).toEqual([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x01]);
  });

  it('refuses a MAC that is not 6 bytes (a builder must never send a wrong packet)', () => {
    expect(() => buildMagicPacket(Uint8Array.from([1, 2, 3]))).toThrow(/6 bytes/);
  });

  it('uses the discard port 9', () => {
    expect(WAKE_PORT).toBe(9);
  });
});

describe('directedBroadcast', () => {
  it.each([
    ['192.168.1.40', '255.255.255.0', '192.168.1.255'],
    ['10.1.2.3', '255.0.0.0', '10.255.255.255'],
    ['172.16.5.9', '255.255.252.0', '172.16.7.255'],
    ['192.168.1.130', '255.255.255.128', '192.168.1.255'],
  ])('%s / %s -> %s', (address, mask, expected) => {
    expect(directedBroadcast(address, mask)).toBe(expected);
  });

  it('is undefined for a /31, a /32, a non contiguous mask or a bad address (no broadcast domain)', () => {
    expect(directedBroadcast('192.168.1.1', '255.255.255.254')).toBeUndefined();
    expect(directedBroadcast('192.168.1.1', '255.255.255.255')).toBeUndefined();
    expect(directedBroadcast('192.168.1.1', '255.0.255.0')).toBeUndefined();
    expect(directedBroadcast('192.168.1', '255.255.255.0')).toBeUndefined();
    expect(directedBroadcast('192.168.1.1', '0.0.0.0')).toBeUndefined();
  });
});

const nic = (name: string, address: string, netmask: string, internal = false): LocalInterface => ({ name, address, netmask, internal });

describe('selectWakeRoutes', () => {
  const lan = nic('Ethernet', '192.168.1.10', '255.255.255.0');
  const vpn = nic('tun0', '10.8.0.5', '255.255.255.0');

  it('keeps only the interfaces whose subnet contains a known address of the target, with their directed broadcast and the target address to unicast to', () => {
    const r = selectWakeRoutes([lan, vpn, nic('lo', '127.0.0.1', '255.0.0.0', true)], ['192.168.1.40'], undefined);
    expect(r).toEqual({ ok: true, routes: [{ interfaceName: 'Ethernet', localAddress: '192.168.1.10', broadcast: '192.168.1.255', unicast: ['192.168.1.40'] }] });
  });

  it('never unicasts to a name, an IPv6 address, the network or broadcast address, this machine, or an address outside the subnet', () => {
    const r = selectWakeRoutes([lan], ['192.168.1.40', 'box.example.net', '2001:db8::1', '192.168.1.255', '192.168.1.0', '192.168.1.10', '8.8.8.8'], undefined);
    expect(r.ok && r.routes[0]?.unicast).toEqual(['192.168.1.40']);
  });

  it('a subnet shared only through the broadcast or network address of the target list gives a broadcast-only route', () => {
    const r = selectWakeRoutes([lan], ['192.168.1.255'], undefined);
    expect(r.ok && r.routes[0]?.unicast).toEqual([]);
  });

  it('stops with not-on-lan when no interface shares the subnet: no blind broadcast', () => {
    const r = selectWakeRoutes([vpn], ['192.168.1.40'], undefined, 'linux-box');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('not-on-lan');
      expect(r.message).toContain('linux-box');
      expect(r.message).toContain('192.168.1.40');
      expect(r.message).toContain('10.8.0.5/24');
      expect(r.message).toMatch(/nothing was sent/);
    }
  });

  it('ignores loopback interfaces, even for a loopback target', () => {
    const r = selectWakeRoutes([nic('lo', '127.0.0.1', '255.0.0.0', true)], ['127.0.0.1'], undefined);
    expect(r.ok).toBe(false);
  });

  it('with no IPv4 address known and no explicit broadcast: stops, nothing is sent blindly', () => {
    const r = selectWakeRoutes([lan], ['box.example.net', '2001:db8::1'], undefined, 'box');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('no-ipv4-target');
      expect(r.message).toMatch(/machine peer connect box --address/);
      expect(r.message).toMatch(/--wake-broadcast/);
    }
  });

  it('with no IPv4 address known, an explicit broadcast that is the directed broadcast of a local network gives a broadcast-only route', () => {
    const r = selectWakeRoutes([lan, vpn], ['box.example.net'], '192.168.1.255');
    expect(r).toEqual({ ok: true, routes: [{ interfaceName: 'Ethernet', localAddress: '192.168.1.10', broadcast: '192.168.1.255', unicast: [] }] });
  });

  it('with no IPv4 address known, an explicit broadcast that is not one of this machine\'s networks is refused', () => {
    const r = selectWakeRoutes([lan], [], '10.255.255.255');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('broadcast-not-allowed');
  });

  it('accepts an explicit broadcast only when it is the directed broadcast of a qualifying interface', () => {
    const ok = selectWakeRoutes([lan], ['192.168.1.40'], '192.168.1.255');
    expect(ok.ok).toBe(true);
    for (const wrong of ['255.255.255.255', '8.8.8.8', '192.168.2.255', '192.168.1.40']) {
      const r = selectWakeRoutes([lan], ['192.168.1.40'], wrong);
      expect(r.ok, wrong).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('broadcast-not-allowed');
        expect(r.message).toContain('192.168.1.255');
      }
    }
  });

  it('with several qualifying interfaces keeps each, and an override narrows to its own', () => {
    const wifi = nic('Wi-Fi', '192.168.1.11', '255.255.255.0');
    const two = selectWakeRoutes([lan, wifi], ['192.168.1.40'], undefined);
    expect(two.ok && two.routes.length).toBe(2);
    const wide = nic('Wide', '10.0.0.2', '255.0.0.0');
    const mixed = selectWakeRoutes([lan, wide], ['192.168.1.40', '10.9.9.9'], '10.255.255.255');
    expect(mixed.ok && mixed.routes.map((x) => x.interfaceName)).toEqual(['Wide']);
  });
});

describe('tuning', () => {
  it('has the documented defaults', () => {
    expect(WAKE_TUNING_DEFAULTS).toEqual({ probeSeconds: 5, waitSeconds: 90, maxUnicast: 4, maxBroadcast: 4, connectTimeoutMs: 3000, settleSeconds: 0 });
    expect(WAKE_COOLDOWN_SECONDS).toBe(60);
    expect(WAKE_PORT).toBe(9);
  });

  it('has the documented hard bounds, never more than 8 packets per method', () => {
    expect(WAKE_TUNING_LIMITS.probeSeconds).toMatchObject({ min: 1, max: 60 });
    expect(WAKE_TUNING_LIMITS.waitSeconds).toMatchObject({ min: 10, max: 600 });
    expect(WAKE_TUNING_LIMITS.maxUnicast).toMatchObject({ min: 0, max: 8 });
    expect(WAKE_TUNING_LIMITS.maxBroadcast).toMatchObject({ min: 0, max: 8 });
    expect(WAKE_TUNING_LIMITS.connectTimeoutMs).toMatchObject({ min: 200, max: 10_000 });
    expect(WAKE_TUNING_LIMITS.settleSeconds).toMatchObject({ min: 0, max: 120 });
  });

  it.each(WAKE_TUNING_FIELDS)('%s: the bounds are accepted, one beyond each is refused with the field name and the range', (field) => {
    const { min, max } = WAKE_TUNING_LIMITS[field];
    expect(checkTuning(field, min)).toEqual({ ok: true, value: min });
    expect(checkTuning(field, max)).toEqual({ ok: true, value: max });
    expect(checkTuning(field, String(max))).toEqual({ ok: true, value: max });
    for (const bad of [min - 1, max + 1, 1.5, '1.5', 'abc', '', -1, Number.NaN, null, undefined, true]) {
      const r = checkTuning(field, bad);
      expect(r.ok, `${field} ${String(bad)}`).toBe(false);
      if (!r.ok) {
        expect(r.message).toContain(field);
        expect(r.message).toContain(`from ${min} to ${max}`);
      }
    }
  });

  it('resolveTuning applies the configured values over the defaults and says which fields are defaulted', () => {
    const r = resolveTuning({ probeSeconds: 12, maxUnicast: 0 });
    expect(r.values).toEqual({ probeSeconds: 12, waitSeconds: 90, maxUnicast: 0, maxBroadcast: 4, connectTimeoutMs: 3000, settleSeconds: 0 });
    expect(r.defaulted).toEqual(['waitSeconds', 'maxBroadcast', 'connectTimeoutMs', 'settleSeconds']);
    expect(resolveTuning({}).defaulted).toEqual([...WAKE_TUNING_FIELDS]);
  });

  it('refuses a configuration that sends nothing', () => {
    expect(() => resolveTuning({ maxUnicast: 0, maxBroadcast: 0 })).toThrow(/no packet would ever be sent/);
  });
});

describe('planWakeSteps', () => {
  const base = { canUnicast: true, maxUnicast: 4, maxBroadcast: 4, probeMs: 5000, waitMs: 90_000 };

  it('alternates unicast, probe window, broadcast, probe window, ... with at most 4 of each by default: 8 packets, never more', () => {
    const steps = planWakeSteps(base);
    expect(steps.map((s) => s.method)).toEqual(['unicast', 'broadcast', 'unicast', 'broadcast', 'unicast', 'broadcast', 'unicast', 'broadcast']);
    expect(steps.map((s) => s.atMs)).toEqual([0, 5000, 10_000, 15_000, 20_000, 25_000, 30_000, 35_000]);
  });

  it('broadcast only when there is no address to unicast to: said by the caller, 4 broadcasts', () => {
    const steps = planWakeSteps({ ...base, canUnicast: false });
    expect(steps.map((s) => s.method)).toEqual(['broadcast', 'broadcast', 'broadcast', 'broadcast']);
    expect(steps.map((s) => s.atMs)).toEqual([0, 5000, 10_000, 15_000]);
  });

  it('skips an exhausted method and keeps the other: 2 unicast + 4 broadcast', () => {
    const steps = planWakeSteps({ ...base, maxUnicast: 2 });
    expect(steps.map((s) => s.method)).toEqual(['unicast', 'broadcast', 'unicast', 'broadcast', 'broadcast', 'broadcast']);
  });

  it('maxUnicast 0 is broadcast only, maxBroadcast 0 is unicast only', () => {
    expect(planWakeSteps({ ...base, maxUnicast: 0 }).every((s) => s.method === 'broadcast')).toBe(true);
    expect(planWakeSteps({ ...base, maxBroadcast: 0 }).every((s) => s.method === 'unicast')).toBe(true);
  });

  it('the hard cap is 8 per method: 16 packets at most', () => {
    expect(planWakeSteps({ ...base, maxUnicast: 8, maxBroadcast: 8, probeMs: 1000, waitMs: 600_000 }).length).toBe(16);
  });

  it('drops the steps that would start after the wait budget, and uses the probe window of the peer', () => {
    const steps = planWakeSteps({ ...base, probeMs: 20_000, waitMs: 50_000 });
    expect(steps.map((s) => s.atMs)).toEqual([0, 20_000, 40_000]);
  });

  it('plans nothing when nothing can be sent', () => {
    expect(planWakeSteps({ ...base, canUnicast: false, maxBroadcast: 0 })).toEqual([]);
  });
});

describe('describeAnswer', () => {
  const step = { n: 3, method: 'unicast' as const, atMs: 10_000 };

  it('names the method that followed, the window, the measured time and the time into the window', () => {
    expect(describeAnswer({ elapsedMs: 14_200, lastStep: step, probeMs: 5000 })).toEqual({ followedBy: 'unicast', window: 3, elapsedSeconds: 14.2, intoWindowSeconds: 4.2, tight: true });
  });

  it('is not tight when the answer came early in its window (80% is the limit)', () => {
    expect(describeAnswer({ elapsedMs: 12_000, lastStep: step, probeMs: 5000 }).tight).toBe(false);
    expect(describeAnswer({ elapsedMs: 14_000, lastStep: step, probeMs: 5000 }).tight).toBe(false);
    expect(describeAnswer({ elapsedMs: 14_100, lastStep: step, probeMs: 5000 }).tight).toBe(true);
  });

  it('with no packet sent (cooldown, or the peer came up on its own) there is no window and no method', () => {
    expect(describeAnswer({ elapsedMs: 3000, lastStep: undefined, probeMs: 5000 })).toEqual({ followedBy: undefined, window: 0, elapsedSeconds: 3, intoWindowSeconds: 3, tight: false });
  });
});

describe('cooldown', () => {
  it('cooldownRemainingSeconds counts down from the last wake and is 0 when none or past', () => {
    expect(cooldownRemainingSeconds(undefined, 1000)).toBe(0);
    expect(cooldownRemainingSeconds(1000, 1000)).toBe(60);
    expect(cooldownRemainingSeconds(1000, 1045)).toBe(15);
    expect(cooldownRemainingSeconds(1000, 1060)).toBe(0);
    expect(cooldownRemainingSeconds(1000, 5000)).toBe(0);
  });

  it('a last wake in the future (clock moved back) still waits at most the cooldown', () => {
    expect(cooldownRemainingSeconds(5000, 1000)).toBe(60);
  });
});

describe('isWakeableFailure', () => {
  const kinds: ConnectFailureKind[] = ['unreachable', 'refused', 'timeout', 'unresolved', 'pin-mismatch', 'bad-certificate', 'auth-closed', 'pair-proof', 'protocol', 'unknown'];
  it.each(kinds)('%s', (kind) => {
    expect(isWakeableFailure([kind])).toBe(kind === 'unreachable' || kind === 'timeout');
  });

  it('wakes only when EVERY failure is unreachable or timeout', () => {
    expect(isWakeableFailure(['unreachable', 'timeout'])).toBe(true);
    expect(isWakeableFailure(['unreachable', 'auth-closed'])).toBe(false);
    expect(isWakeableFailure(['timeout', 'pair-proof'])).toBe(false);
    // A refusal means something answered at TCP level: the host is awake.
    expect(isWakeableFailure(['timeout', 'refused'])).toBe(false);
  });

  it('never wakes on an empty list: no failure is no reason', () => {
    expect(isWakeableFailure([])).toBe(false);
  });
});
