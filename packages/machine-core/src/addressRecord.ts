import { isIPv4, isIPv6 } from 'node:net';
import type { Json } from './canonical.js';
import { signDocument, verifyDocument } from './signed.js';

// The signed address record of a machine (relay-api.md, "Machines resource", threat T-33). The machine signs the places where it can
// be reached with its identity key; the relay stores the record as is and cannot judge it; the peers verify it against the
// admin-signed registration they hold. No I/O.

export const ADDRESS_RECORD_DOMAIN = 'machine/address-record/v1';
/** More addresses than this are never published nor read: a record is a short list of ways to reach one machine. */
export const MAX_ADDRESSES = 8;
/** What the relay accepts for one record (JSON of `{ body, signature }`). */
export const MAX_ADDRESS_RECORD_BYTES = 2048;
export const ADDRESS_RECORD_SKEW_SECONDS = 30;
/** A record older than this is ignored: a machine that is gone must not keep an address alive forever. A daemon publishes again well before. */
export const MAX_ADDRESS_RECORD_AGE_SECONDS = 30 * 86_400;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
// WHATWG URL "ends in a number": such a last label is read as a (possibly hexadecimal or octal) IPv4 number by URL parsers and resolvers.
const NUMERIC_LABEL = /^(0[xX][0-9a-fA-F]*|[0-9]+)$/;

export interface AddressEntry {
  host: string;
  port: number;
}

export interface AddressRecordBody {
  v: 1;
  uuid: string;
  addresses: AddressEntry[];
  /** Strictly increasing per machine: a peer never accepts a lower one (rollback), see `verifyAddressRecord`. */
  seq: number;
  /** Epoch seconds. */
  issuedAt: number;
}

export interface SignedAddressRecord {
  body: AddressRecordBody;
  signature: string;
}

/** Why a host cannot be published or connected to, or undefined when it is an IPv4 or IPv6 literal or a DNS name. */
export function hostProblem(host: string): string | undefined {
  if (host.length === 0) return 'the host is empty';
  if (host.includes('%')) return 'an IPv6 zone identifier ("%...") is not accepted: it only means something on the machine that wrote it';
  if (isIPv4(host) || isIPv6(host)) return undefined;
  const invalid = `"${host.length > 80 ? `${host.slice(0, 80)}...` : host}" is not an IPv4 address, an IPv6 address or a valid DNS name (letters, digits and "-" in labels of 1 to 63 characters, 253 in total; no scheme, path, user or port)`;
  if (host.length > 253) return invalid;
  const labels = host.split('.');
  if (!labels.every((label) => DNS_LABEL.test(label))) return invalid;
  // "1.2.3", "256.1.1.1", "0x7f.1" or "0x7f000001" are (mis)read as IPv4 numbers by many parsers: a name does not end with a number.
  if (NUMERIC_LABEL.test(labels[labels.length - 1] as string)) return invalid;
  return undefined;
}

/** The 4 (IPv4) or 16 (IPv6) bytes of an IP literal, whatever its spelling; undefined for anything else. IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) forms give the 4 bytes of the embedded address. */
function ipBytes(host: string): number[] | undefined {
  if (isIPv4(host)) return host.split('.').map(Number);
  if (!isIPv6(host) || host.includes('%')) return undefined;
  let text = host.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail, extra] = text.split('::');
  if (extra !== undefined) return undefined;
  const groups = (part: string | undefined): number[] => (part === undefined || part === '' ? [] : part.split(':').map((g) => Number.parseInt(g, 16)));
  const first = groups(head);
  const last = groups(tail);
  const fill = tail === undefined ? 0 : 8 - first.length - last.length;
  const all = tail === undefined ? first : [...first, ...Array.from({ length: fill }, () => 0), ...last];
  if (all.length !== 8 || all.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return undefined;
  const bytes = all.flatMap((g) => [g >> 8, g & 0xff]);
  const zeros = (from: number, to: number) => bytes.slice(from, to).every((b) => b === 0);
  const mapped = zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff;
  // ::a.b.c.d (deprecated IPv4-compatible) is read as the embedded address too, except :: and ::1 themselves.
  const compatible = zeros(0, 12) && !(zeros(12, 15) && (bytes[15] === 0 || bytes[15] === 1));
  return mapped || compatible ? bytes.slice(12) : bytes;
}

export type HostClass = 'loopback' | 'unspecified' | 'link-local' | 'other';

/** Where a host points, whatever its spelling (case, expanded IPv6, IPv4-mapped IPv6). Names are only classified when they are "localhost". */
export function hostClass(host: string): HostClass {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (name === 'localhost' || name.endsWith('.localhost')) return 'loopback';
  const bytes = ipBytes(host);
  if (bytes === undefined) return 'other';
  if (bytes.length === 4) {
    if (bytes[0] === 127) return 'loopback';
    if (bytes[0] === 0) return 'unspecified';
    if (bytes[0] === 169 && bytes[1] === 254) return 'link-local';
    return 'other';
  }
  if (bytes.slice(0, 15).every((b) => b === 0)) return bytes[15] === 0 ? 'unspecified' : bytes[15] === 1 ? 'loopback' : 'other';
  if (bytes[0] === 0xfe && ((bytes[1] as number) & 0xc0) === 0x80) return 'link-local';
  return 'other';
}

const REASONS: Record<Exclude<HostClass, 'other'>, string> = {
  loopback: 'a loopback address (it would make this machine connect to itself)',
  unspecified: 'an unspecified address (0.0.0.0 or ::)',
  'link-local': 'a link-local address (169.254/16, fe80::/10: it includes the cloud metadata service 169.254.169.254)',
};

/** Why a machine must not connect to a host found in a record that ANOTHER machine published, or undefined. */
export function destinationProblem(host: string): string | undefined {
  const c = hostClass(host);
  return c === 'other' ? undefined : `${host} is ${REASONS[c]}`;
}

/** Why a host cannot be advertised by this machine for itself. Loopback and link-local stay possible (an SSH tunnel, a redirect), 0.0.0.0 and :: never mean a place. */
export function advertisedProblem(host: string): string | undefined {
  return hostClass(host) === 'unspecified' ? `${host} is ${REASONS.unspecified}: it is not a place where anybody can connect` : undefined;
}

/** `host:port`, a name or an IPv4 address, or a bracketed IPv6 address such as `[::1]:47921`. Undefined when it is anything else. */
export function parseAddress(address: string): AddressEntry | undefined {
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([^:\s[\]]+)):(\d{1,5})$/.exec(address);
  if (!m) return undefined;
  const port = Number(m[3]);
  const host = m[1] ?? m[2];
  if (host === undefined || !(port >= 1 && port <= 65535)) return undefined;
  if (m[1] !== undefined && !isIPv6(host)) return undefined;
  return hostProblem(host) === undefined ? { host, port } : undefined;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function assertKeys(o: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(o)) if (!allowed.includes(key)) throw new Error(`${where}: unknown field "${key}"`);
  for (const key of allowed) if (!(key in o)) throw new Error(`${where}: missing field "${key}"`);
}

/** Throws an Error naming the first problem; the message is meant to be shown to the user. */
export function assertAddressRecordBody(value: unknown): asserts value is AddressRecordBody {
  if (!isObject(value)) throw new Error('address record: the body must be an object');
  assertKeys(value, ['v', 'uuid', 'addresses', 'seq', 'issuedAt'], 'address record');
  if (value.v !== 1) throw new Error(`address record: unsupported version ${String(value.v)} (this build reads version 1): run \`machine cli update\` on this machine`);
  if (typeof value.uuid !== 'string' || !UUID_V4.test(value.uuid)) throw new Error('address record: uuid must be a lowercase version 4 UUID');
  if (typeof value.seq !== 'number' || !Number.isSafeInteger(value.seq) || value.seq < 1) throw new Error('address record: seq must be a positive integer');
  if (typeof value.issuedAt !== 'number' || !Number.isSafeInteger(value.issuedAt) || value.issuedAt < 1) throw new Error('address record: issuedAt must be epoch seconds');
  if (!Array.isArray(value.addresses)) throw new Error('address record: addresses must be a list');
  if (value.addresses.length === 0) throw new Error('address record: it needs at least one address');
  if (value.addresses.length > MAX_ADDRESSES) throw new Error(`address record: at most ${MAX_ADDRESSES} addresses are accepted (got ${value.addresses.length})`);
  value.addresses.forEach((entry: unknown, i) => {
    const where = `address record: address ${i + 1}`;
    if (!isObject(entry)) throw new Error(`${where} must be an object { host, port }`);
    assertKeys(entry, ['host', 'port'], where);
    if (typeof entry.host !== 'string') throw new Error(`${where}: host must be text`);
    const problem = hostProblem(entry.host);
    if (problem !== undefined) throw new Error(`${where}: host ${problem}`);
    if (typeof entry.port !== 'number' || !Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) throw new Error(`${where}: port must be a whole number from 1 to 65535`);
  });
}

function sizeOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** Machine side: build and sign a record with the identity key. Refuses to sign what no peer would accept. */
export function buildAddressRecord(body: Omit<AddressRecordBody, 'v'>, identityPrivateKeyPkcs8: Uint8Array): SignedAddressRecord {
  const full: AddressRecordBody = { v: 1, uuid: body.uuid, addresses: body.addresses.map((a) => ({ host: a.host, port: a.port })), seq: body.seq, issuedAt: body.issuedAt };
  assertAddressRecordBody(full);
  const record: SignedAddressRecord = { body: full, signature: signDocument(ADDRESS_RECORD_DOMAIN, full as unknown as Json, identityPrivateKeyPkcs8) };
  const size = sizeOf(record);
  if (size > MAX_ADDRESS_RECORD_BYTES) throw new Error(`the address record is ${size} bytes, the relay accepts at most ${MAX_ADDRESS_RECORD_BYTES}: advertise fewer or shorter addresses`);
  return record;
}

export type AddressRecordFailure = 'malformed' | 'too-large' | 'wrong-uuid' | 'bad-signature' | 'rollback' | 'same-seq' | 'not-yet-valid' | 'expired';

export type AddressRecordResult = { ok: true; body: AddressRecordBody; signature: string } | { ok: false; reason: AddressRecordFailure; message: string };

/** What a machine remembers of the highest record it accepted for a peer. */
export interface LastSeenRecord {
  seq: number;
  signature: string;
}

/**
 * Reader side. `registered` is what the admin-signed registration says about the machine the record claims to be from.
 * Order: size, shape, uuid, signature, seq, time. The relay is never asked: it cannot judge a record.
 *
 * `seq` must be strictly greater than the highest seen; the same seq is accepted only with the very same bytes (Ed25519 is
 * deterministic, so equal signatures mean an identical record), anything lower is a rollback by the relay or a replay.
 */
export function verifyAddressRecord(
  record: unknown,
  registered: { uuid: string; identityPublicKey: string },
  now: number,
  lastSeen?: LastSeenRecord,
  skewSeconds: number = ADDRESS_RECORD_SKEW_SECONDS,
): AddressRecordResult {
  const fail = (reason: AddressRecordFailure, message: string): AddressRecordResult => ({ ok: false, reason, message });
  let size: number;
  try {
    size = sizeOf(record);
  } catch {
    return fail('malformed', 'address record refused: it cannot be serialized');
  }
  if (size > MAX_ADDRESS_RECORD_BYTES) return fail('too-large', `address record refused: ${size} bytes, the limit is ${MAX_ADDRESS_RECORD_BYTES} bytes (2 KiB)`);
  if (!isObject(record) || typeof record.signature !== 'string' || !isObject(record.body)) {
    return fail('malformed', 'address record refused: it is not a signed record ({ body, signature })');
  }
  try {
    assertKeys(record, ['body', 'signature'], 'address record');
    assertAddressRecordBody(record.body);
  } catch (e) {
    return fail('malformed', `address record refused: ${(e as Error).message}`);
  }
  const body = record.body as unknown as AddressRecordBody;
  if (body.uuid !== registered.uuid) {
    return fail('wrong-uuid', `address record refused: it is written for machine ${body.uuid}, not for ${registered.uuid} (the machine it was fetched for)`);
  }
  if (!verifyDocument(ADDRESS_RECORD_DOMAIN, body as unknown as Json, registered.identityPublicKey, record.signature)) {
    return fail('bad-signature', `address record of ${body.uuid} refused: its signature does not match the registered identity key of that machine; it was altered, or not written by that machine`);
  }
  if (lastSeen !== undefined) {
    if (body.seq < lastSeen.seq) {
      return fail('rollback', `address record of ${body.uuid} refused: it has seq ${body.seq} but seq ${lastSeen.seq} was already seen (the relay serves an older record, or replays one)`);
    }
    if (body.seq === lastSeen.seq && record.signature !== lastSeen.signature) {
      return fail('same-seq', `address record of ${body.uuid} refused: it has seq ${body.seq}, the same as the last record seen, but different content`);
    }
  }
  if (now + skewSeconds < body.issuedAt) {
    return fail('not-yet-valid', `address record of ${body.uuid} is dated ${new Date(body.issuedAt * 1000).toISOString()}, in the future; check the clock of this machine and of that machine`);
  }
  if (now - body.issuedAt > MAX_ADDRESS_RECORD_AGE_SECONDS) {
    return fail('expired', `address record of ${body.uuid} was issued ${new Date(body.issuedAt * 1000).toISOString()}, more than 30 days ago: that machine has not published for a long time (its daemon is not running?), or check the clock of this machine`);
  }
  return { ok: true, body, signature: record.signature };
}
