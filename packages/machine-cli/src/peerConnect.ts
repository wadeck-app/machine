import { parseAddress, type AddressEntry, type ConnectFailureKind, type SigningKeyPair } from '@wadeck-app/machine-core';
import { connectToPeer, ConnectError, type PeerSession } from '@wadeck-app/machine-transport';
import { whenText } from './humanTime.js';
import { connectFirst, CONNECT_TIMEOUT_MS, PeerAddressError, resolvePeerAddresses } from './peerAddresses.js';
import { createRelayClient, type RelayClient } from './relayClient.js';
import { readRelayConfig } from './relayStore.js';

// How `machine run` and `machine ping` reach a peer: ONE code path. The addresses come from `--address` or from the signed
// address record of the peer on the relay (verified against its registration, T-33); the connection is the mutual TLS 1.3 channel of
// machine-transport, pinned to the identity key of the registration (decision 47). Neither command forks any of it.

/** The peer as the local directory holds it: admin-signed, current, not revoked. */
export interface PeerToReach {
  peerId: string;
  name: string;
  /** The key its registration pins: what the connection must present. */
  identityPublicKey: string;
  pairSecret: Buffer;
}

export interface PeerTarget {
  /** `override`: `--address`, the relay was not asked. `pinned`: the addresses of connections.json (`machine peer connect`), the relay was not asked either and its record is not used. `relay`: the verified address record of the peer. */
  source: 'override' | 'pinned' | 'relay';
  addresses: AddressEntry[];
  /** One line per address of the record that must not be used, with the reason (loopback, unspecified, link-local). */
  refused: string[];
  /** What the relay says (informational: it can lag or lie). Undefined when the relay was not asked or did not say. */
  online?: boolean | undefined;
  lastSeen?: number | null | undefined;
  /** Sequence number and issue time (epoch seconds) of the verified record. */
  seq?: number;
  issuedAt?: number;
}

export interface ResolveOptions {
  /** `--address <host:port>`: connect there, never ask the relay. The caller has validated it. It wins over the pinned addresses. */
  address?: string | undefined;
  /** The addresses pinned for this peer in connections.json: used instead of the relay record (the relay is untrusted, T-33; the user pinned them for a reason). */
  pinned?: AddressEntry[] | undefined;
  /** Epoch seconds. */
  now: number;
  /** Tests only: let a record point to loopback. */
  allowLocal: boolean;
  /** A line for the person (without its `[warn]` marker). */
  warn: (line: string) => void;
  /** Tests only: the relay client (default: the one of relay.json). */
  client?: RelayClient;
}

/** Where to reach `peer`. Throws a `PeerAddressError` whose message says what happened and what to do. */
export async function resolvePeerTarget(configDir: string, peer: PeerToReach, options: ResolveOptions): Promise<PeerTarget> {
  if (options.address) {
    const where = parseAddress(options.address);
    if (!where) throw new PeerAddressError(`invalid --address "${options.address}": expected <host>:<port>, for example 192.168.1.20:47921 or [::1]:47921`);
    return { source: 'override', addresses: [{ host: where.host, port: where.port }], refused: [] };
  }
  if (options.pinned !== undefined && options.pinned.length > 0) {
    return { source: 'pinned', addresses: options.pinned.map((a) => ({ host: a.host, port: a.port })), refused: [] };
  }
  let client = options.client;
  if (client === undefined) {
    const relayConfig = readRelayConfig(configDir);
    if (relayConfig === undefined) {
      throw new PeerAddressError(`no address known for "${peer.name}": pass --address <host:port>, or join a relay (\`machine join <relay>\`) so that the address is learned from the signed address record of the peer`);
    }
    client = createRelayClient({ baseUrl: relayConfig.relayUrl, token: relayConfig.token });
  }
  const found = await resolvePeerAddresses(configDir, { uuid: peer.peerId, name: peer.name, identityPublicKey: peer.identityPublicKey }, client, options.now, { allowLocal: options.allowLocal });
  for (const line of found.refused) options.warn(line);
  // What the relay says about presence is information (it can lag or lie): the addresses are tried anyway.
  if (found.online === false) {
    options.warn(`the relay says "${peer.name}" is offline${typeof found.lastSeen === 'number' ? ` (last seen ${whenText(found.lastSeen, options.now)})` : ''}: trying its published addresses anyway`);
  }
  return { source: 'relay', addresses: found.addresses, refused: found.refused, online: found.online, lastSeen: found.lastSeen, seq: found.seq, issuedAt: found.issuedAt };
}

export interface Connected {
  session: PeerSession;
  /** The address that answered. */
  address: AddressEntry;
  /** The addresses tried before it, each with its reason. */
  failures: string[];
}

/**
 * Opens the authenticated channel (TLS handshake, key pinning, pair secret proof) to the first address that answers. Nothing is sent over it.
 * `--address`: one attempt with the transport's own timeout and its raw error. Relay: addresses in order, `CONNECT_TIMEOUT_MS` each, every failure
 * kept (an `AllAddressesFailedError` when none answers). `onAttempt` is called with each address just before it is tried (timing in `machine ping`).
 * `timeoutMs`: the per-address limit of a wake probe (a short one); absent, the normal limit of the source applies.
 */
export async function connectToTarget(
  identity: SigningKeyPair,
  peer: PeerToReach,
  target: PeerTarget,
  onAttempt?: (address: AddressEntry) => void,
  timeoutMs?: number,
  /** Tests only (WakeIo.simulateFailure): a sleeping peer. */
  simulateFailure?: (address: AddressEntry) => ConnectFailureKind | undefined,
): Promise<Connected> {
  const connect = (address: AddressEntry, handshakeTimeoutMs?: number) => {
    onAttempt?.(address);
    const simulated = simulateFailure?.(address);
    if (simulated !== undefined) return Promise.reject(new ConnectError(`cannot reach ${address.host}:${address.port}: simulated ${simulated} (tests only)`, simulated));
    return connectToPeer({
      identity,
      host: address.host,
      port: address.port,
      expectedPeerPublicKey: peer.identityPublicKey,
      pairSecret: peer.pairSecret,
      ...(handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs } : {}),
    });
  };
  if (target.source === 'override') {
    const address = target.addresses[0] as AddressEntry;
    return { session: await connect(address, timeoutMs), address, failures: [] };
  }
  return await connectFirst(target.addresses, (address) => connect(address, timeoutMs ?? CONNECT_TIMEOUT_MS), target.source === 'pinned' ? { pinnedFor: peer.name } : {});
}
