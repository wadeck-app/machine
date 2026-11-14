import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isUuid, verifyAddressRecord, type AddressEntry, type LastSeenRecord } from '@wadeck-app/machine-core';
import { writeFileAtomic } from './fsutil.js';
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

function remember(configDir: string, uuid: string, entry: RememberedRecord): void {
  const all = readPeerRecords(configDir);
  const known = all[uuid];
  // Only a record that moves the state forward is written; the same record again changes nothing.
  if (known !== undefined && known.seq === entry.seq) return;
  all[uuid] = entry;
  writeFileAtomic(peerRecordsFile(configDir), `${JSON.stringify({ v: 1, peers: all }, null, 2)}\n`, 0o644);
}

const lastSeenOf = (known: RememberedRecord | undefined): LastSeenRecord | undefined => (known === undefined ? undefined : { seq: known.seq, signature: known.signature });

export const describeAddress = (a: AddressEntry): string => (a.host.includes(':') ? `[${a.host}]:${a.port}` : `${a.host}:${a.port}`);

const BYPASS = 'pass --address <host:port> to connect without the relay';

type Verified = { ok: true; addresses: AddressEntry[]; seq: number; issuedAt: number } | { ok: false; reason: string; message: string };

/** Verifies one record of the relay against the registration of the peer, and remembers it when it is accepted. */
function accept(configDir: string, peer: PeerRef, record: unknown, now: number, known: RememberedRecord | undefined): Verified {
  const checked = verifyAddressRecord(record, { uuid: peer.uuid, identityPublicKey: peer.identityPublicKey }, now, lastSeenOf(known));
  if (!checked.ok) return { ok: false, reason: checked.reason, message: checked.message };
  remember(configDir, peer.uuid, { seq: checked.body.seq, signature: checked.signature, addresses: checked.body.addresses, issuedAt: checked.body.issuedAt, seenAt: now });
  return { ok: true, addresses: checked.body.addresses, seq: checked.body.seq, issuedAt: checked.body.issuedAt };
}

function refusalMessage(configDir: string, peer: PeerRef, reason: string, message: string): string {
  const rollback = reason === 'rollback' || reason === 'same-seq' ? ` If "${peer.name}" was reinstalled and its counter went back, delete ${peerRecordsFile(configDir)} (every peer is then learned again from the relay).` : '';
  return `the relay gave an address for "${peer.name}" that is refused: ${message}.${rollback} Nothing was connected; ${BYPASS}`;
}

export interface ResolvedPeer {
  addresses: AddressEntry[];
  seq: number;
  issuedAt: number;
  /** What the relay says (informational: the relay can lie or lag). Undefined when it did not say. */
  online: boolean | undefined;
  lastSeen: number | null | undefined;
}

/** The addresses of ONE peer from the relay, verified. Throws a `PeerAddressError` whose message says what happened and what to do. */
export async function resolvePeerAddresses(configDir: string, peer: PeerRef, client: RelayClient, now: number): Promise<ResolvedPeer> {
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
      `the relay has no address record for "${peer.name}" (${peer.uuid}): its daemon has not published one. Check that \`machine daemon\` runs on that machine with a relay (\`machine status\` there, and its daemon log), or ${BYPASS}`,
    );
  }
  const verified = accept(configDir, peer, entry.record, now, known);
  if (!verified.ok) throw new PeerAddressError(refusalMessage(configDir, peer, verified.reason, verified.message));
  return {
    addresses: verified.addresses,
    seq: verified.seq,
    issuedAt: verified.issuedAt,
    online: typeof entry.online === 'boolean' ? entry.online : undefined,
    lastSeen: typeof entry.lastSeen === 'number' || entry.lastSeen === null ? entry.lastSeen : undefined,
  };
}

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
export async function lookupPeerPresence(configDir: string, peers: PeerRef[], client: RelayClient, now: number): Promise<PeerPresence[]> {
  const entries = await client.getMachines();
  const byUuid = new Map(entries.filter((e) => typeof e?.uuid === 'string').map((e) => [e.uuid.toLowerCase(), e]));
  const remembered = readPeerRecords(configDir);
  return peers.map((peer): PeerPresence => {
    const known = remembered[peer.uuid];
    const lastKnown = (problem: string): PeerPresence => (known === undefined ? { uuid: peer.uuid, name: peer.name, addresses: [], source: 'none', problem } : { uuid: peer.uuid, name: peer.name, addresses: known.addresses, source: 'last-known', seq: known.seq, problem });
    const entry = byUuid.get(peer.uuid);
    if (entry === undefined) return lastKnown('no address record on the relay: its daemon has not published one');
    const verified = accept(configDir, peer, entry.record, now, known);
    if (!verified.ok) return lastKnown(`address record refused: ${verified.message}`);
    return {
      uuid: peer.uuid,
      name: peer.name,
      addresses: verified.addresses,
      source: 'relay',
      seq: verified.seq,
      ...(typeof entry.online === 'boolean' ? { online: entry.online } : {}),
      ...(typeof entry.lastSeen === 'number' || entry.lastSeen === null ? { lastSeen: entry.lastSeen } : {}),
    };
  });
}

/** Per-address limit of `machine run`: connecting, the TLS handshake and the pair secret proof. */
export const CONNECT_TIMEOUT_MS = 3000;

/**
 * Tries the addresses in order; the first `connect` that completes wins. Every failure is kept with its address and reason. When none
 * works the error names them all.
 */
export async function connectFirst<T>(addresses: AddressEntry[], connect: (address: AddressEntry) => Promise<T>): Promise<{ session: T; address: AddressEntry; failures: string[] }> {
  const failures: string[] = [];
  for (const address of addresses) {
    try {
      return { session: await connect(address), address, failures };
    } catch (e) {
      failures.push(`${describeAddress(address)}: ${(e as Error).message}`);
    }
  }
  throw new PeerAddressError(
    `could not connect to any of the ${addresses.length} address(es) the peer published: ${failures.join('; ')}. The peer may be off, behind a router (publish a reachable address with \`machine daemon --advertise <host[:port]>\` there), or on another network; ${BYPASS}`,
  );
}
