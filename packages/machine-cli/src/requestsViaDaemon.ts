import { resolveMachineRef, type SignedRequestsList } from '@wadeck-app/machine-core';
import { ConnectionsError, readConnections } from './connectionsStore.js';
import { readMachine } from './identity.js';
import { loadNetwork } from './network.js';
import { connectToTarget, resolvePeerTarget } from './peerConnect.js';
import { pinnedOf } from './cliWake.js';
import { sendSignedRequestsList, type ListRequestsResult } from './requestsRemote.js';
import { readAliases } from './state.js';

// What the daemon does for the module backend (decision 74): it forwards a `requests-list` request that the BROWSER signed with the admin key
// to the peer and returns the answer. The daemon never holds the admin key and signs nothing: the signature is checked by the peer, and this
// side only refuses what cannot succeed (wrong target, wrong source) before opening a connection. Read-only; no wake is attempted.

export type RemoteRequestsAnswer = ListRequestsResult;

const fail = (reason: string, message: string): RemoteRequestsAnswer => ({ ok: false, reason, message });

export async function remoteRequestsCommand(configDir: string, payload: unknown, now: number): Promise<RemoteRequestsAnswer> {
  const p = typeof payload === 'object' && payload !== null ? (payload as { peer?: unknown; request?: unknown }) : {};
  const body = (p.request as { body?: { source?: unknown; target?: unknown } } | null | undefined)?.body;
  if (typeof p.peer !== 'string' || typeof body !== 'object' || body === null || typeof (p.request as { signature?: unknown }).signature !== 'string') {
    return fail('bad-payload', 'expected {"peer": "<machine>", "request": {"body": ..., "signature": ...}}: the request is the requests-list document signed with the admin key');
  }
  const self = readMachine(configDir);
  const network = loadNetwork(configDir, now);
  const resolved = resolveMachineRef(p.peer, [{ uuid: self.uuid, name: self.name }, ...network.directory.machines()], readAliases(configDir));
  if (!resolved.ok) return fail('unknown-peer', resolved.message);
  const peer = network.directory.find(resolved.uuid);
  if (resolved.uuid === self.uuid || peer === undefined) return fail('unknown-peer', `"${p.peer}" is not a trusted peer of this machine: see \`machine list\``);
  if (body.target !== peer.peerId) return fail('wrong-target', `the request is not addressed to ${peer.name}: sign a request for its uuid ${peer.peerId}`);
  if (body.source !== self.uuid) return fail('source-mismatch', `the request must name this machine (${self.uuid}) as its source: the peer only accepts it on the connection of that machine`);

  let connection;
  try {
    connection = readConnections(configDir).peers[peer.peerId];
  } catch (e) {
    if (e instanceof ConnectionsError) return fail('unreachable', e.message);
    throw e;
  }
  const warnings: string[] = [];
  let session;
  try {
    const target = await resolvePeerTarget(configDir, peer, { pinned: pinnedOf(connection), now, allowLocal: false, warn: (line) => warnings.push(line) });
    ({ session } = await connectToTarget(self.identity, peer, target));
  } catch (e) {
    return fail('unreachable', `cannot reach ${peer.name}: ${(e as Error).message}${warnings.length > 0 ? ` (${warnings.join('; ')})` : ''}`);
  }
  try {
    return await sendSignedRequestsList(session, p.request as SignedRequestsList);
  } catch (e) {
    return fail('no-answer', (e as Error).message);
  } finally {
    session.close();
  }
}
