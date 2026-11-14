import type { AddressEntry } from '@wadeck-app/machine-core';
import type { ListAnswer } from './commands.js';
import { loadNetwork } from './network.js';
import { PeerAddressError, describeAddress, lookupPeerPresence, readPeerRecords, type PeerPresence, type PeerRef, type UseOptions } from './peerAddresses.js';
import { RelayError, createRelayClient, type RelayClient } from './relayClient.js';
import { readRelayConfig } from './relayStore.js';

// What `machine list` adds when this machine has a relay: for each peer the last known addresses and whether the relay says it is online.
// A relay that cannot be reached or a peer record that does not verify is a visible warning, never an error of `list`.

/** The `relay` field of a peer in `machine list --json`. */
export interface PeerRelayInfo {
  source: PeerPresence['source'];
  addresses: AddressEntry[];
  seq?: number;
  /** What the relay says (informational: the relay can lag or lie). */
  online?: boolean;
  lastSeen?: number | null;
  problem?: string;
}

export interface ListWithRelay extends Omit<ListAnswer, 'peers'> {
  peers: Array<ListAnswer['peers'][number] & { relay?: PeerRelayInfo }>;
  /** One line: why the relay information is missing or partial. Absent when everything worked. */
  relayWarning?: string;
}

const info = (p: PeerPresence): PeerRelayInfo => ({
  source: p.source,
  addresses: p.addresses,
  ...(p.seq !== undefined ? { seq: p.seq } : {}),
  ...(p.online !== undefined ? { online: p.online } : {}),
  ...(p.lastSeen !== undefined ? { lastSeen: p.lastSeen } : {}),
  ...(p.problem !== undefined ? { problem: p.problem } : {}),
});

/** Adds the relay view to the answer of the daemon. Never throws: every problem becomes `relayWarning` or a `problem` on one peer. */
export async function addRelayView(configDir: string, answer: ListAnswer, now: number, injected?: RelayClient, options: UseOptions = {}): Promise<ListWithRelay> {
  if (answer.peers.length === 0) return answer;
  let client: RelayClient;
  try {
    const config = readRelayConfig(configDir);
    if (config === undefined) return answer;
    client = injected ?? createRelayClient({ baseUrl: config.relayUrl, token: config.token });
  } catch (e) {
    return { ...answer, relayWarning: `the relay information is not shown: ${(e as Error).message}` };
  }
  const network = loadNetwork(configDir, now);
  const refs: PeerRef[] = [];
  for (const p of answer.peers) {
    const found = network.directory.find(p.uuid);
    if (found) refs.push({ uuid: p.uuid, name: p.name, identityPublicKey: found.identityPublicKey });
  }
  let rows: PeerPresence[];
  let relayWarning: string | undefined;
  try {
    rows = await lookupPeerPresence(configDir, refs, client, now, options);
  } catch (e) {
    if (!(e instanceof RelayError) && !(e instanceof PeerAddressError)) throw e;
    relayWarning = `the relay could not be asked, the addresses shown are the last known ones: ${e.message}`;
    let remembered: ReturnType<typeof readPeerRecords> = {};
    try {
      remembered = readPeerRecords(configDir);
    } catch (inner) {
      relayWarning += ` ${(inner as Error).message}`;
    }
    rows = refs.map((ref): PeerPresence => {
      const known = remembered[ref.uuid];
      return known === undefined ? { uuid: ref.uuid, name: ref.name, addresses: [], source: 'none' } : { uuid: ref.uuid, name: ref.name, addresses: known.addresses, source: 'last-known', seq: known.seq };
    });
  }
  const byUuid = new Map(rows.map((r) => [r.uuid, r]));
  return {
    ...answer,
    peers: answer.peers.map((p) => {
      const row = byUuid.get(p.uuid);
      return row === undefined ? p : { ...p, relay: info(row) };
    }),
    ...(relayWarning !== undefined ? { relayWarning } : {}),
  };
}

/** The text of one peer under its line: what the relay says, or why it says nothing. */
export function relayLines(relay: PeerRelayInfo | undefined): string[] {
  if (relay === undefined) return [];
  const addresses = relay.addresses.map(describeAddress).join(', ');
  const lines: string[] = [];
  if (relay.source === 'relay') {
    const presence = relay.online === undefined ? 'presence unknown' : relay.online ? 'online' : `offline${typeof relay.lastSeen === 'number' ? ` (last seen ${new Date(relay.lastSeen * 1000).toISOString()})` : ''}`;
    lines.push(`  relay: ${presence}, ${addresses}`);
  } else if (relay.source === 'last-known') {
    lines.push(`  relay: last known addresses (not confirmed now): ${addresses}`);
  }
  if (relay.problem !== undefined) lines.push(`  relay: ${relay.problem}`);
  return lines;
}
