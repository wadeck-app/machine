import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { destinationProblem, isUuid, verifyAddressRecord, type AddressEntry, type ConnectFailureKind, type LastSeenRecord } from '@wadeck-app/machine-core';
import { ConnectError } from '@wadeck-app/machine-transport';
import { withFileLock, writeFileAtomic } from './fsutil.js';
import { RelayError, type RelayClient } from './relayClient.js';

// The addresses of the peers, learned from the relay (relay-api.md "Machines resource", threat T-33). The relay is untrusted: a record is used
// only after it verifies against the identity key of the admin-signed registration the caller already holds, and never goes back in time:
// the highest seq seen per peer is kept in <configDir>/peer-records.json (not a secret: public records).

export const peerRecordsFile = (configDir: string): string => join(configDir, 'peer-records.json');

export interface PeerRef {
  uuid: string;
  name: string;
  /** The identity key of the registration of the peer in the local directory (admin-signed, not revoked). */
  identityPublicKey: string;
}

export interface RememberedRecord {
  seq: number;
  signature: string;
  addresses: AddressEntry[];
  issuedAt: number;
  /** Epoch seconds on this machine. */
  seenAt: number;
}

/** A problem to tell the person: the message is complete (cause and way out). */
export class PeerAddressError extends Error {}

/** No published address answered: `attempts` keeps each address with its own reason (the message already lists them all). */
export class AllAddressesFailedError extends PeerAddressError {
  constructor(
    message: string,
    readonly attempts: Array<{ address: AddressEntry; reason: string; kind: ConnectFailureKind }>,
  ) {
    super(message);
  }
}

const corrupt = (file: string, why: string): PeerAddressError =>
  new PeerAddressError(
    `${file} is corrupt or invalid (${why}): it remembers the highest address record seen per peer, which protects against a relay serving an old record. Delete it to start again: every peer is then learned again from the relay`,
  );

export function readPeerRecords(configDir: string): Record<string, RememberedRecord> {
  const file = peerRecordsFile(configDir);
  if (!existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw corrupt(file, 'not valid JSON');
  }
  const o = raw as { v?: unknown; peers?: unknown } | null;
  if (typeof o !== 'object' || o === null || Array.isArray(o) || o.v !== 1 || typeof o.peers !== 'object' || o.peers === null || Array.isArray(o.peers)) throw corrupt(file, 'unexpected shape');
  const out: Record<string, RememberedRecord> = {};
  for (const [uuid, value] of Object.entries(o.peers as Record<string, unknown>)) {
    const r = value as Partial<RememberedRecord> | null;
    const okAddresses = Array.isArray(r?.addresses) && r.addresses.every((a) => typeof a?.host === 'string' && Number.isInteger(a?.port));
    if (!isUuid(uuid) || typeof r !== 'object' || r === null || !Number.isSafeInteger(r.seq) || (r.seq as number) < 1 || typeof r.signature !== 'string' || !okAddresses || typeof r.issuedAt !== 'number' || typeof r.seenAt !== 'number') {
      throw corrupt(file, `the entry of ${uuid} is invalid`);
    }
    out[uuid] = { seq: r.seq as number, signature: r.signature, addresses: r.addresses as AddressEntry[], issuedAt: r.issuedAt, seenAt: r.seenAt };
  }
  return out;
}

function writeAll(configDir: string, all: Record<string, RememberedRecord>): void {
  writeFileAtomic(peerRecordsFile(configDir), `${JSON.stringify({ v: 1, peers: all }, null, 2)}
`, 0o644);
}

/**
 * Remembers verified records, in ONE locked read-modify-write for the whole batch: what another command or the daemon wrote meanwhile is
 * kept, and a record never replaces one with a higher or equal seq (nothing moves backwards).
 */
export function commitRecords(configDir: string, entries: Record<string, RememberedRecord>): void {
  if (Object.keys(entries).length === 0) return;
  withFileLock(peerRecordsFile(configDir), () => {
    const all = readPeerRecords(configDir);
    let changed = false;
    for (const [uuid, entry] of Object.entries(entries)) {
      const known = all[uuid];
      if (known !== undefined && known.seq >= entry.seq) continue;
      all[uuid] = entry;
      changed = true;
    }
    if (changed) writeAll(configDir, all);
  });
}

/** Forgets what was remembered of ONE peer (see `machine peer forget-record`). True when there was something. */
export function forgetPeerRecord(configDir: string, uuid: string): boolean {
  return withFileLock(peerRecordsFile(configDir), () => {
    const all = readPeerRecords(configDir);
    if (!(uuid in all)) return false;
    delete all[uuid];
    writeAll(configDir, all);
    return true;
  });
}

const lastSeenOf = (known: RememberedRecord | undefined): LastSeenRecord | undefined => (known === undefined ? undefined : { seq: known.seq, signature: known.signature });

export const describeAddress = (a: AddressEntry): string => (a.host.includes(':') ? `[${a.host}]:${a.port}` : `${a.host}:${a.port}`);

const BYPASS = 'pass --address <host:port> to connect without the relay';

/** `allowLocal`: tests only, for peers on loopback. */
export interface UseOptions {
  allowLocal?: boolean;
}

type Verified = { ok: true; addresses: AddressEntry[]; refused: string[]; seq: number; issuedAt: number; entry: RememberedRecord } | { ok: false; reason: string; message: string };

/** Splits the addresses of a record into the ones this machine may connect to and the refused ones with the reason (loopback, unspecified, link-local). */
function usable(addresses: AddressEntry[], options: UseOptions): { addresses: AddressEntry[]; refused: string[] } {
  if (options.allowLocal === true) return { addresses, refused: [] };
  const kept: AddressEntry[] = [];
  const refused: string[] = [];
  for (const address of addresses) {
    const problem = destinationProblem(address.host);
    if (problem === undefined) kept.push(address);
    else refused.push(`${describeAddress(address)} refused: ${problem}`);
  }
  return { addresses: kept, refused };
}

/** Verifies one record of the relay against the registration of the peer. The caller remembers an accepted one (`commitRecords`). */
function accept(configDir: string, peer: PeerRef, record: unknown, now: number, known: RememberedRecord | undefined, options: UseOptions): Verified {
  const checked = verifyAddressRecord(record, { uuid: peer.uuid, identityPublicKey: peer.identityPublicKey }, now, lastSeenOf(known));
  if (!checked.ok) return { ok: false, reason: checked.reason, message: checked.message };
  const entry: RememberedRecord = { seq: checked.body.seq, signature: checked.signature, addresses: checked.body.addresses, issuedAt: checked.body.issuedAt, seenAt: now };
  return { ok: true, ...usable(checked.body.addresses, options), seq: checked.body.seq, issuedAt: checked.body.issuedAt, entry };
}

function refusalMessage(peer: PeerRef, reason: string, message: string): string {
  const rollback =
    reason === 'rollback' || reason === 'same-seq'
      ? ` If "${peer.name}" was really reinstalled and lost its counter, and you confirmed it out of band (phone, in person, ssh), run \`machine peer forget-record ${peer.name}\` to forget what was seen of that peer only; otherwise the relay is replaying an old record.`
      : '';
  return `the relay gave an address for "${peer.name}" that is refused: ${message}.${rollback} Nothing was connected; ${BYPASS}`;
}

export interface ResolvedPeer {
  addresses: AddressEntry[];
  /** One line per address of the record that must not be used, with the reason. */
  refused: string[];
  seq: number;
  issuedAt: number;
  /** What the relay says (informational: the relay can lie or lag). Undefined when it did not say. */
  online: boolean | undefined;
  lastSeen: number | null | undefined;
}

/** The addresses of ONE peer from the relay, verified. Throws a `PeerAddressError` whose message says what happened and what to do. */
export async function resolvePeerAddresses(configDir: string, peer: PeerRef, client: RelayClient, now: number, options: UseOptions = {}): Promise<ResolvedPeer> {
  const known = readPeerRecords(configDir)[peer.uuid];
  let entry;
  try {
    entry = await client.getMachine(peer.uuid);
  } catch (e) {
    if (e instanceof RelayError) throw new PeerAddressError(`cannot get the address of "${peer.name}" from the relay: ${e.message}. ${BYPASS[0]?.toUpperCase()}${BYPASS.slice(1)}`);
    throw e;
  }
  if (entry === undefined) {
    throw new PeerAddressError(
      `the relay has no address record for "${peer.name}" (${peer.uuid}): no record published yet. The relay lists a machine only once its daemon has published its address record, which is normal for a machine approved a moment ago or whose daemon is not running. ${startDaemonHint(peer.name)}, wait a minute (its daemon log: \`machine cli logs\` there), or ${BYPASS}`,
    );
  }
  const verified = accept(configDir, peer, entry.record, now, known, options);
  if (!verified.ok) throw new PeerAddressError(refusalMessage(peer, verified.reason, verified.message));
  commitRecords(configDir, { [peer.uuid]: verified.entry });
  if (verified.addresses.length === 0) {
    throw new PeerAddressError(`the record of "${peer.name}" is valid but all ${verified.refused.length} addresses it publishes are refused: ${verified.refused.join('; ')}. A peer is never reached through a local or metadata address; ${BYPASS}`);
  }
  return {
    addresses: verified.addresses,
    refused: verified.refused,
    seq: verified.seq,
    issuedAt: verified.issuedAt,
    online: typeof entry.online === 'boolean' ? entry.online : undefined,
    lastSeen: typeof entry.lastSeen === 'number' || entry.lastSeen === null ? entry.lastSeen : undefined,
  };
}

/** Which machine must do what when the relay has no address record of a peer (the daemon of that machine publishes it). */
export const startDaemonHint = (peerName: string): string =>
  `On "${peerName}" run \`machine startup enable\` (starts its daemon at login; needs orch) or leave \`machine daemon\` running in a terminal`;

export interface PeerPresence {
  uuid: string;
  name: string;
  addresses: AddressEntry[];
  /** `relay`: verified just now. `last-known`: remembered from an earlier verified record (the relay had nothing usable). `none`. */
  source: 'relay' | 'last-known' | 'none';
  seq?: number;
  online?: boolean;
  lastSeen?: number | null;
  /** Why no fresh address is shown for this peer. */
  problem?: string;
}

/**
 * What `machine list` shows for every peer with ONE request. A peer whose record is missing or refused gets a `problem`; the others are
 * unaffected. An unreachable relay throws the `RelayError` (the caller prints one warning line and still lists the peers).
 */
export async function lookupPeerPresence(configDir: string, peers: PeerRef[], client: RelayClient, now: number, options: UseOptions = {}): Promise<PeerPresence[]> {
  const entries = await client.getMachines();
  const byUuid = new Map(entries.filter((e) => typeof e?.uuid === 'string').map((e) => [e.uuid.toLowerCase(), e]));
  const remembered = readPeerRecords(configDir);
  const toCommit: Record<string, RememberedRecord> = {};
  const rows = peers.map((peer): PeerPresence => {
    const known = remembered[peer.uuid];
    const lastKnown = (problem: string): PeerPresence => (known === undefined ? { uuid: peer.uuid, name: peer.name, addresses: [], source: 'none', problem } : { uuid: peer.uuid, name: peer.name, addresses: known.addresses, source: 'last-known', seq: known.seq, problem });
    const entry = byUuid.get(peer.uuid);
    if (entry === undefined) return lastKnown(`no record published yet: the relay lists a machine only once its daemon has published its address. ${startDaemonHint(peer.name)}, wait about a minute, then run \`machine list\` again here`);
    const verified = accept(configDir, peer, entry.record, now, known, options);
    if (!verified.ok) return lastKnown(`address record refused: ${verified.message}`);
    toCommit[peer.uuid] = verified.entry;
    return {
      uuid: peer.uuid,
      name: peer.name,
      addresses: verified.addresses,
      source: 'relay',
      seq: verified.seq,
      ...(typeof entry.online === 'boolean' ? { online: entry.online } : {}),
      ...(typeof entry.lastSeen === 'number' || entry.lastSeen === null ? { lastSeen: entry.lastSeen } : {}),
      ...(verified.refused.length > 0 ? { problem: `${verified.refused.length} address(es) refused: ${verified.refused.join('; ')}` } : {}),
    };
  });
  // One locked write for the whole list.
  commitRecords(configDir, toCommit);
  return rows;
}

/** Per-address limit of `machine run`: connecting, the TLS handshake and the pair secret proof. */
export const CONNECT_TIMEOUT_MS = 3000;

/**
 * Tries the addresses in order; the first `connect` that completes wins. Every failure is kept with its address, reason and kind. When none
 * works the error names them all. `pinnedFor`: the addresses come from connections.json (`machine peer connect`), not from the relay record.
 */
export async function connectFirst<T>(
  addresses: AddressEntry[],
  connect: (address: AddressEntry) => Promise<T>,
  origin: { pinnedFor?: string } = {},
): Promise<{ session: T; address: AddressEntry; failures: string[] }> {
  const failures: string[] = [];
  const attempts: Array<{ address: AddressEntry; reason: string; kind: ConnectFailureKind }> = [];
  for (const address of addresses) {
    try {
      return { session: await connect(address), address, failures };
    } catch (e) {
      failures.push(`${describeAddress(address)}: ${(e as Error).message}`);
      attempts.push({ address, reason: (e as Error).message, kind: e instanceof ConnectError ? e.kind : 'unknown' });
    }
  }
  const name = origin.pinnedFor;
  const message =
    name === undefined
      ? `could not connect to any of the ${addresses.length} address(es) the peer published: ${failures.join('; ')}. The peer may be off, behind a router (publish a reachable address with \`machine daemon --advertise <host[:port]>\` there), or on another network; ${BYPASS}`
      : `could not connect to any of the ${addresses.length} pinned address(es) of "${name}": ${failures.join('; ')}. The relay record is not used while addresses are pinned: check them with \`machine peer connect ${name} --show\`, change them with \`machine peer connect ${name} --address <host:port>\` or unpin them with \`machine peer connect ${name} --remove\``;
  throw new AllAddressesFailedError(message, attempts);
}

/** The typed failure kinds of whatever a connection attempt threw: one per address for a total failure, one for a single failure, `unknown` for anything else (which never wakes). */
export function kindsOfConnectFailure(error: unknown): ConnectFailureKind[] {
  if (error instanceof AllAddressesFailedError) return error.attempts.map((a) => a.kind);
  if (error instanceof ConnectError) return [error.kind];
  return ['unknown'];
}
