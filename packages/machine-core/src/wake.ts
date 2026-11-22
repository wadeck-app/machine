import { isIPv4 } from 'node:net';

// Wake-on-LAN, caller side (decision 62, connectivity.md phase A). Pure: no socket, no clock, no file. The CLI injects them.

/** Why a connection to a peer failed, as a type (never a string match). Only `unreachable` and `timeout` can be cured by waking the peer. */
export type ConnectFailureKind =
  /** The socket failed before any TLS byte: no route, network down, host unreachable. */
  | 'unreachable'
  /** The host answered at TCP level (connection refused): it is awake and no daemon listens on that port. A magic packet cannot fix it. */
  | 'refused'
  /** Nothing answered within the limit. */
  | 'timeout'
  /** The host name did not resolve (DNS): a magic packet cannot fix it. */
  | 'unresolved'
  /** Another key answered at that address. */
  | 'pin-mismatch'
  | 'bad-certificate'
  /** The peer closed the connection during authentication (not registered there, revoked, clocks). */
  | 'auth-closed'
  | 'pair-proof'
  /** TLS or framing error: another service, or an incompatible version. */
  | 'protocol'
  | 'unknown';

/** The peer is woken only when EVERY failure says it could not be reached. Authentication, registration, revocation and protocol failures never wake. */
export function isWakeableFailure(kinds: readonly ConnectFailureKind[]): boolean {
  return kinds.length > 0 && kinds.every((k) => k === 'unreachable' || k === 'timeout');
}

/** Magic packets go to UDP port 9 (discard). No other port is used or configurable. */
export const WAKE_PORT = 9;
/** Between two wake runs for the same peer, no new packet is sent. */
export const WAKE_COOLDOWN_SECONDS = 60;

/**
 * Every timing of a wake is configurable PER PEER (resume times differ a lot between machines). Defaults and hard bounds: a typo cannot create a
 * storm (at most 8 packets per method) or a wait of hours. UNVERIFIED on real hardware: the defaults are a starting point to tune with
 * `machine wake`, which prints the measured time.
 */
export const WAKE_TUNING_FIELDS = ['probeSeconds', 'waitSeconds', 'maxUnicast', 'maxBroadcast', 'connectTimeoutMs', 'settleSeconds', 'hedgeMs'] as const;
export type WakeTuningField = (typeof WAKE_TUNING_FIELDS)[number];
export type WakeTuning = Record<WakeTuningField, number>;

export const WAKE_TUNING_DEFAULTS: Readonly<WakeTuning> = { probeSeconds: 5, waitSeconds: 90, maxUnicast: 4, maxBroadcast: 4, connectTimeoutMs: 3000, settleSeconds: 0, hedgeMs: 500 };
export const WAKE_TUNING_LIMITS: Readonly<Record<WakeTuningField, { min: number; max: number; unit: string; meaning: string }>> = {
  probeSeconds: { min: 1, max: 60, unit: 's', meaning: 'how long the connection is probed after each packet before the next one' },
  waitSeconds: { min: 10, max: 600, unit: 's', meaning: 'total time to wait for the peer to answer' },
  maxUnicast: { min: 0, max: 8, unit: '', meaning: 'unicast packets at most (0 = none)' },
  maxBroadcast: { min: 0, max: 8, unit: '', meaning: 'broadcast packets at most (0 = none)' },
  connectTimeoutMs: { min: 200, max: 10_000, unit: 'ms', meaning: 'limit of one probe attempt (connect and handshake; a host that just resumed answers TCP late and TLS later)' },
  settleSeconds: { min: 0, max: 120, unit: 's', meaning: 'pause after the peer answered, before the command (a host whose network answers before its daemon is ready)' },
  hedgeMs: { min: 0, max: 5000, unit: 'ms', meaning: 'the first magic packet is sent when the first connection attempt has not answered after this long, while it continues (0 = off: the packet waits for the attempt to fail)' },
};

export type TuningValue = { ok: true; value: number } | { ok: false; message: string };

/** One tuning value (a number, or the text of a flag): an integer within the bounds of its field. Refused, never clamped. */
export function checkTuning(field: WakeTuningField, value: unknown): TuningValue {
  const { min, max, unit } = WAKE_TUNING_LIMITS[field];
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    return { ok: false, message: `${field} must be a whole number from ${min} to ${max}${unit === '' ? '' : ` ${unit}`} (${WAKE_TUNING_LIMITS[field].meaning}), got ${JSON.stringify(value)}` };
  }
  return { ok: true, value: n };
}

export interface EffectiveTuning {
  values: WakeTuning;
  /** The fields nobody set for this peer. */
  defaulted: WakeTuningField[];
}

/** The configured values over the defaults. Cross-field rule: something must be sent (maxUnicast + maxBroadcast >= 1). */
export function resolveTuning(configured: Partial<WakeTuning>): EffectiveTuning {
  const values = { ...WAKE_TUNING_DEFAULTS };
  const defaulted: WakeTuningField[] = [];
  for (const field of WAKE_TUNING_FIELDS) {
    const v = configured[field];
    if (v === undefined) defaulted.push(field);
    else values[field] = v;
  }
  if (values.maxUnicast + values.maxBroadcast < 1) throw new Error('maxUnicast and maxBroadcast are both 0: no packet would ever be sent. Raise one of them (--wake-max-unicast, --wake-max-broadcast)');
  return { values, defaulted };
}

export type WakeMethod = 'unicast' | 'broadcast';

export interface WakeStep {
  method: WakeMethod;
  /** Milliseconds after the first connection failure. */
  atMs: number;
}

/**
 * The packets in order: broadcast, a probe window, unicast, a probe window, and so on, alternating (the one that is exhausted or impossible is
 * skipped). Broadcast first since 2026-11-22: on the one box measured, the unicast packet never woke it and the broadcast did. A step that would start after the wait budget is dropped. Never more than `maxUnicast` + `maxBroadcast` steps.
 */
export function planWakeSteps(options: { canUnicast: boolean; maxUnicast: number; maxBroadcast: number; probeMs: number; waitMs: number }): WakeStep[] {
  let unicast = options.canUnicast ? options.maxUnicast : 0;
  let broadcast = options.maxBroadcast;
  const steps: WakeStep[] = [];
  let next: WakeMethod = 'broadcast';
  while (unicast + broadcast > 0) {
    if (next === 'unicast' && unicast === 0) next = 'broadcast';
    if (next === 'broadcast' && broadcast === 0) next = 'unicast';
    const atMs = steps.length * options.probeMs;
    if (atMs >= options.waitMs) break;
    steps.push({ method: next, atMs });
    if (next === 'unicast') unicast--;
    else broadcast--;
    next = next === 'unicast' ? 'broadcast' : 'unicast';
  }
  return steps;
}

/** Seconds left before another wake run is allowed for a peer (0 when none). A last wake in the future (clock moved back) never waits more than the cooldown. */
export function cooldownRemainingSeconds(lastWakeAt: number | undefined, now: number): number {
  if (lastWakeAt === undefined) return 0;
  const left = lastWakeAt + WAKE_COOLDOWN_SECONDS - now;
  if (left <= 0) return 0;
  return Math.min(left, WAKE_COOLDOWN_SECONDS);
}

// ---- MAC and packet ----

export type MacResult = { ok: true; mac: string; bytes: Uint8Array } | { ok: false; message: string };

const MAC_FORMAT = 'expected six hexadecimal octets separated by ":" or "-", for example aa:bb:cc:dd:ee:ff';

/** A MAC typed by the user. Normalised to lowercase with colons. */
export function parseMac(text: string): MacResult {
  const m = /^([0-9a-fA-F]{2})([:-])([0-9a-fA-F]{2})\2([0-9a-fA-F]{2})\2([0-9a-fA-F]{2})\2([0-9a-fA-F]{2})\2([0-9a-fA-F]{2})$/.exec(text);
  if (!m) return { ok: false, message: `invalid MAC address ${JSON.stringify(text)}: ${MAC_FORMAT}` };
  const bytes = Uint8Array.from([m[1], m[3], m[4], m[5], m[6], m[7]].map((h) => Number.parseInt(h as string, 16)));
  const mac = formatMac(bytes);
  if (bytes.every((b) => b === 0) || ((bytes[0] as number) & 1) === 1) {
    return { ok: false, message: `MAC address ${mac} cannot be woken: it is the all-zero, broadcast or a multicast address, not the address of one network card (find the real one with \`ip link\`, \`ifconfig\` or \`ipconfig /all\` on that machine)` };
  }
  return { ok: true, mac, bytes };
}

export function formatMac(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(':');
}

/** 6 bytes of 0xFF then the MAC 16 times: 102 bytes. */
export function buildMagicPacket(mac: Uint8Array): Buffer {
  if (mac.length !== 6) throw new Error(`a MAC address has 6 bytes, got ${mac.length}: no packet was built`);
  const packet = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) packet.set(mac, 6 + i * 6);
  return packet;
}

// ---- Subnet checks ----

const ipv4ToInt = (text: string): number | undefined => {
  if (!isIPv4(text)) return undefined;
  return text.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
};

const intToIpv4 = (n: number): string => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

/** Prefix length of a contiguous netmask, or undefined. */
function prefixOf(netmask: string): number | undefined {
  const m = ipv4ToInt(netmask);
  if (m === undefined) return undefined;
  let ones = 0;
  while (ones < 32 && ((m >>> (31 - ones)) & 1) === 1) ones++;
  // Contiguous: the rest of the bits are zeros.
  const expected = ones === 0 ? 0 : (0xffffffff << (32 - ones)) >>> 0;
  return m === expected ? ones : undefined;
}

/** The directed broadcast address of `address`/`netmask`, or undefined when there is none (a /31, a /32, a /0, a mask that is not contiguous, a bad address). */
export function directedBroadcast(address: string, netmask: string): string | undefined {
  const a = ipv4ToInt(address);
  const prefix = prefixOf(netmask);
  if (a === undefined || prefix === undefined || prefix < 1 || prefix > 30) return undefined;
  const host = 2 ** (32 - prefix) - 1;
  const network = Math.floor(a / 2 ** (32 - prefix)) * 2 ** (32 - prefix);
  return intToIpv4(network + host);
}

/** One IPv4 interface of this machine (the CLI filters `os.networkInterfaces()` to the IPv4 entries). */
export interface LocalInterface {
  name: string;
  address: string;
  netmask: string;
  internal: boolean;
}

export interface WakeRoute {
  interfaceName: string;
  /** The packets leave from this local address (the socket is bound to it). */
  localAddress: string;
  /** Directed broadcast of the shared subnet. */
  broadcast: string;
  /** Known IPv4 addresses of the target inside this subnet (never a name, never the network or broadcast address, never this machine). Empty: broadcast only. */
  unicast: string[];
}

export type WakeRoutes = { ok: true; routes: WakeRoute[] } | { ok: false; code: 'no-ipv4-target' | 'not-on-lan' | 'broadcast-not-allowed'; message: string };

const sameNetwork = (a: number, b: number, prefix: number): boolean => Math.floor(a / 2 ** (32 - prefix)) === Math.floor(b / 2 ** (32 - prefix));

/**
 * The only places a magic packet may go: (unicast) a known IPv4 address of the target inside the subnet of a local, non-loopback IPv4 interface, and
 * (broadcast) the directed broadcast of that subnet. `override` (`wake.broadcast`) must equal a directed broadcast of a local interface. No limited
 * broadcast (255.255.255.255), no other destination. With no known IPv4 address of the target, only an explicit `override` that names a local
 * network allows a broadcast-only wake; otherwise it stops (no blind broadcast).
 */
export function selectWakeRoutes(interfaces: readonly LocalInterface[], targetHosts: readonly string[], override: string | undefined, label = 'the peer'): WakeRoutes {
  const targets = targetHosts.map((h) => ({ host: h, n: ipv4ToInt(h) })).filter((t): t is { host: string; n: number } => t.n !== undefined);
  if (targets.length === 0 && override === undefined) {
    return {
      ok: false,
      code: 'no-ipv4-target',
      message: `cannot tell whether this machine is on the LAN of ${label}: its known addresses (${targetHosts.join(', ') || 'none'}) include no IPv4 address, and a name or an IPv6 address says nothing about the subnet. Nothing was sent. Pin its IPv4 address with \`machine peer connect ${label} --address <ipv4>:<port>\`, or name the broadcast of your LAN with --wake-broadcast`,
    };
  }
  const routes: WakeRoute[] = [];
  const networks: string[] = [];
  for (const nic of interfaces) {
    if (nic.internal) continue;
    const a = ipv4ToInt(nic.address);
    const prefix = prefixOf(nic.netmask);
    const broadcast = directedBroadcast(nic.address, nic.netmask);
    if (a === undefined || prefix === undefined) continue;
    networks.push(`${nic.address}/${prefix}`);
    if (broadcast === undefined) continue;
    // With no known IPv4 address of the target, the explicit broadcast is the proof of the network: it must be one of this machine's own.
    if (targets.length === 0) {
      if (broadcast !== override) continue;
      routes.push({ interfaceName: nic.name, localAddress: nic.address, broadcast, unicast: [] });
      continue;
    }
    const sharing = targets.filter((t) => sameNetwork(a, t.n, prefix));
    if (sharing.length === 0) continue;
    const network = intToIpv4(Math.floor(a / 2 ** (32 - prefix)) * 2 ** (32 - prefix));
    const unicast = sharing.map((t) => t.host).filter((h) => h !== broadcast && h !== network && h !== nic.address);
    routes.push({ interfaceName: nic.name, localAddress: nic.address, broadcast, unicast: [...new Set(unicast)] });
  }
  if (routes.length === 0) {
    if (targets.length === 0) {
      return {
        ok: false,
        code: 'broadcast-not-allowed',
        message: `the broadcast address ${override ?? ''} is not the directed broadcast of any network of this machine (${networks.join(', ') || 'no IPv4 network'}), and no IPv4 address of ${label} is known to check the subnet: nothing was sent. Fix it with \`machine peer connect ${label} --wake-broadcast <broadcast>\``,
      };
    }
    return {
      ok: false,
      code: 'not-on-lan',
      message: `this machine is not on the same network as ${label} (known address ${targets.map((t) => t.host).join(', ')}; this machine is on ${networks.join(', ') || 'no IPv4 network'}): a Wake-on-LAN packet only works inside the LAN of the target, so nothing was sent. Run this from a machine on that network (a waker machine for the other cases is not available yet), or fix the pinned address with \`machine peer connect ${label} --address <ipv4>:<port>\``,
    };
  }
  if (override === undefined) return { ok: true, routes };
  const kept = routes.filter((r) => r.broadcast === override);
  if (kept.length === 0) {
    return {
      ok: false,
      code: 'broadcast-not-allowed',
      message: `the broadcast address ${override} is not allowed: a magic packet only goes to the directed broadcast of a local network shared with ${label}, here ${routes.map((r) => r.broadcast).join(', ')}. Nothing was sent. Fix it with \`machine peer connect ${label} --wake-broadcast ${routes[0]?.broadcast ?? '<broadcast>'}\` or set the connection again without it`,
    };
  }
  return { ok: true, routes: kept };
}

export interface AnswerReport {
  /** The method of the last packet sent before the answer. A packet gives no acknowledgement: this is what FOLLOWED, not proof of cause. */
  followedBy: WakeMethod | undefined;
  /** Probe window of that packet, 1-based (the window after packet n). 0: no packet was sent (cooldown, or the peer came up by itself). */
  window: number;
  /** Seconds since the first failure, and since the last packet (one decimal). */
  elapsedSeconds: number;
  intoWindowSeconds: number;
  /** True when the answer came after more than 80% of the window: a slower resume would be missed. */
  tight: boolean;
}

/** What to tell the person about a successful wake, for tuning `probeSeconds`. */
export function describeAnswer(options: { elapsedMs: number; lastStep: (WakeStep & { n: number }) | undefined; probeMs: number }): AnswerReport {
  const { elapsedMs, lastStep, probeMs } = options;
  const round = (ms: number): number => Math.round(ms / 100) / 10;
  if (lastStep === undefined) return { followedBy: undefined, window: 0, elapsedSeconds: round(elapsedMs), intoWindowSeconds: round(elapsedMs), tight: false };
  const into = Math.max(0, elapsedMs - lastStep.atMs);
  return { followedBy: lastStep.method, window: lastStep.n, elapsedSeconds: round(elapsedMs), intoWindowSeconds: round(into), tight: into > 0.8 * probeMs };
}
