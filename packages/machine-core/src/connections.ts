import { isIPv4 } from 'node:net';
import { MAX_ADDRESSES, hostProblem, type AddressEntry } from './addressRecord.js';
import { isUuid } from './reference.js';
import { WAKE_TUNING_DEFAULTS, WAKE_TUNING_FIELDS, WAKE_TUNING_LIMITS, checkTuning, parseMac } from './wake.js';

// `<configDir>/connections.json` (decision 62): how THIS machine reaches each peer. Local, unsigned, public data (no secret): a strategy decides how
// bytes reach an address, never who is trusted (the key is pinned by the admin-signed registration).

export const CONNECTION_TYPES = ['direct', 'ping-if-not-reachable-magic-packet'] as const;
export type ConnectionType = (typeof CONNECTION_TYPES)[number];

export interface WakeConfig {
  /** Lowercase, colon separated. Typed by the user, never learned from the relay. */
  mac: string;
  /** Must equal the directed broadcast of a local network shared with the peer. */
  broadcast?: string;
  /** Timings (see WAKE_TUNING_LIMITS for the bounds and WAKE_TUNING_DEFAULTS for what an absent field means). Per peer: resume times differ. */
  probeSeconds?: number;
  waitSeconds?: number;
  maxUnicast?: number;
  maxBroadcast?: number;
  connectTimeoutMs?: number;
  settleSeconds?: number;
}

export interface PeerConnection {
  type: ConnectionType;
  /** Pinned addresses: they win over the relay record. Absent or empty: the relay record is used. */
  addresses?: AddressEntry[];
  wake?: WakeConfig;
}

export interface Connections {
  v: 1;
  /** Keyed by the peer uuid. */
  peers: Record<string, PeerConnection>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function assertKeys(o: Record<string, unknown>, required: string[], optional: string[], where: string): void {
  for (const key of Object.keys(o)) if (![...required, ...optional].includes(key)) throw new Error(`${where}: unknown field "${key}" (allowed: ${[...required, ...optional].join(', ')})`);
  for (const key of required) if (!(key in o)) throw new Error(`${where}: missing field "${key}"`);
}

function parseAddresses(value: unknown, where: string): AddressEntry[] {
  if (!Array.isArray(value)) throw new Error(`${where}.addresses: expected a list of { host, port }`);
  if (value.length > MAX_ADDRESSES) throw new Error(`${where}.addresses: at most ${MAX_ADDRESSES} addresses, got ${value.length}`);
  return value.map((entry, i) => {
    const at = `${where}.addresses[${i}]`;
    if (!isObject(entry)) throw new Error(`${at}: expected { host, port }`);
    assertKeys(entry, ['host', 'port'], [], at);
    const { host, port } = entry;
    if (typeof host !== 'string') throw new Error(`${at}.host: expected a string`);
    const problem = hostProblem(host);
    if (problem !== undefined) throw new Error(`${at}.host: ${problem}`);
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${at}.port: expected a port number from 1 to 65535, got ${JSON.stringify(port)}`);
    return { host, port };
  });
}

function parseWake(value: unknown, where: string): WakeConfig {
  if (!isObject(value)) throw new Error(`${where}.wake: expected { mac, broadcast?, waitSeconds? }`);
  assertKeys(value, ['mac'], ['broadcast', ...WAKE_TUNING_FIELDS], `${where}.wake`);
  if (typeof value.mac !== 'string') throw new Error(`${where}.wake.mac: expected a string such as aa:bb:cc:dd:ee:ff`);
  const mac = parseMac(value.mac);
  if (!mac.ok) throw new Error(`${where}.wake.mac: ${mac.message}`);
  const wake: WakeConfig = { mac: mac.mac };
  if (value.broadcast !== undefined) {
    if (typeof value.broadcast !== 'string' || !isIPv4(value.broadcast)) throw new Error(`${where}.wake.broadcast: expected an IPv4 address such as 192.168.1.255, got ${JSON.stringify(value.broadcast)}`);
    wake.broadcast = value.broadcast;
  }
  for (const field of WAKE_TUNING_FIELDS) {
    const v = value[field];
    if (v === undefined) continue;
    // A number only: "90" in a JSON file is a typo to report, not a value to guess.
    const checked = typeof v === 'number' ? checkTuning(field, v) : { ok: false as const, message: `${field} must be a number, got ${JSON.stringify(v)} (allowed ${WAKE_TUNING_LIMITS[field].min} to ${WAKE_TUNING_LIMITS[field].max})` };
    if (!checked.ok) throw new Error(`${where}.wake.${field}: ${checked.message}`);
    wake[field] = checked.value;
  }
  const { maxUnicast, maxBroadcast } = { ...WAKE_TUNING_DEFAULTS, ...wake };
  if (maxUnicast + maxBroadcast < 1) throw new Error(`${where}.wake: maxUnicast and maxBroadcast are both 0, so no packet would ever be sent: raise one of them`);
  return wake;
}

/** Validates the content of connections.json. Throws an Error naming the first bad field (the CLI adds the file and the way out). */
export function parseConnections(raw: unknown): Connections {
  if (!isObject(raw)) throw new Error('top level: expected an object { "v": 1, "peers": { ... } }');
  for (const key of Object.keys(raw)) if (key !== 'v' && key !== 'peers') throw new Error(`top level: unknown field "${key}"`);
  if (raw.v !== 1) throw new Error(`"v": expected 1, got ${JSON.stringify(raw.v)}`);
  if (!isObject(raw.peers)) throw new Error('"peers": expected an object keyed by peer uuid');
  const peers: Record<string, PeerConnection> = {};
  for (const [uuid, value] of Object.entries(raw.peers)) {
    if (!isUuid(uuid)) throw new Error(`peers: the key "${uuid}" is not a machine uuid`);
    const where = `peers.${uuid}`;
    if (!isObject(value)) throw new Error(`${where}: expected an object`);
    assertKeys(value, ['type'], ['addresses', 'wake'], where);
    if (!(CONNECTION_TYPES as readonly unknown[]).includes(value.type)) throw new Error(`${where}.type: unknown type ${JSON.stringify(value.type)}, expected one of ${CONNECTION_TYPES.join(', ')}`);
    const connection: PeerConnection = { type: value.type as ConnectionType };
    if (value.addresses !== undefined) connection.addresses = parseAddresses(value.addresses, where);
    if (value.wake !== undefined) connection.wake = parseWake(value.wake, where);
    if (connection.type === 'ping-if-not-reachable-magic-packet' && connection.wake === undefined) {
      throw new Error(`${where}: the type "ping-if-not-reachable-magic-packet" needs "wake" with the MAC address of the peer (wake.mac)`);
    }
    peers[uuid.toLowerCase()] = connection;
  }
  return { v: 1, peers };
}

/** Peers sorted by uuid, a trailing newline. */
export function serializeConnections(connections: Connections): string {
  const peers: Record<string, PeerConnection> = {};
  for (const uuid of Object.keys(connections.peers).sort()) peers[uuid] = connections.peers[uuid] as PeerConnection;
  return `${JSON.stringify({ v: 1, peers }, null, 2)}\n`;
}
