import { buildRequestDeny, parseRequestDeny, printable, resolveMachineRef } from '@wadeck-app/machine-core';
import type { PeerSession } from '@wadeck-app/machine-transport';
import { pinnedOf } from './cliWake.js';
import { ConnectionsError, readConnections } from './connectionsStore.js';
import { readMachine } from './identity.js';
import { loadNetwork } from './network.js';
import { connectToTarget, resolvePeerTarget } from './peerConnect.js';
import { networkAliasMap } from './aliasesStore.js';
import { readAliases } from './state.js';

// The sender side of `request-deny` (decision 85): this machine is named in the notice-recipients list of a target and refuses a request that target
// holds. Restricting only: no signature, no passphrase. The target decides from the authenticated connection; this side never claims an identity.

export const DENY_ANSWER_TIMEOUT_MS = 10_000;
/** Per address, as the request notices: a target that does not answer within this is unreachable. */
export const DENY_CONNECT_MS = 3000;

export const PEER_TOO_OLD_DENY_MESSAGE = (name: string): string => `${name} is too old to accept a remote deny (it does not know the request-deny message): run \`machine cli update\` on ${name}, or run \`machine requests --deny <id>\` ON ${name}`;

export type DenyOnPeerResult = { ok: true; id: string } | { ok: false; reason: string; message: string };

export async function denyOnPeer(session: Pick<PeerSession, 'send' | 'next'>, input: { id: string; reason?: string; peerName: string; timeoutMs?: number }): Promise<DenyOnPeerResult> {
  const timeoutMs = input.timeoutMs ?? DENY_ANSWER_TIMEOUT_MS;
  const frame = buildRequestDeny({ id: input.id, ...(input.reason !== undefined ? { reason: input.reason } : {}) });
  const checked = parseRequestDeny(frame);
  if (!checked.ok) {
    return { ok: false, reason: 'bad-deny', message: checked.message };
  }
  session.send(frame);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer from ${input.peerName} within ${timeoutMs} ms: it may be busy or unreachable; the request may still be held, check \`machine status\` on ${input.peerName}`)), timeoutMs);
  });
  let answer: unknown;
  try {
    answer = await Promise.race([session.next(), deadline]);
  } catch (e) {
    return { ok: false, reason: 'no-answer', message: (e as Error).message.startsWith('no answer') ? (e as Error).message : `the connection to ${input.peerName} broke before it answered (${(e as Error).message}): the request may still be held, check \`machine requests ${input.peerName}\`` };
  } finally {
    clearTimeout(timer);
  }
  const a = (typeof answer === 'object' && answer !== null ? answer : {}) as { type?: unknown; id?: unknown; reason?: unknown; message?: unknown };
  if (a.type === 'deny-ack' && typeof a.id === 'string') {
    return { ok: true, id: printable(a.id, 64) };
  }
  if (a.type === 'refused') {
    const reason = typeof a.reason === 'string' ? a.reason : 'refused';
    // An older build refuses any message it does not know as `unknown-message`.
    if (reason === 'unknown-message') {
      return { ok: false, reason: 'peer-too-old', message: PEER_TOO_OLD_DENY_MESSAGE(input.peerName) };
    }
    // The text comes from the peer: bounded printable ASCII only.
    return { ok: false, reason: printable(reason, 40), message: typeof a.message === 'string' ? printable(a.message, 600) : `${input.peerName} refused the deny` };
  }
  return { ok: false, reason: 'unexpected-answer', message: `${input.peerName} answered something that is not a deny acknowledgement: it runs an incompatible version; run \`machine cli update\` on both machines` };
}

const fail = (reason: string, message: string): DenyOnPeerResult => ({ ok: false, reason, message });

/** The daemon command `denyRemote`: `{ peer, id, reason? }`. Connects to the trusted peer (pinned addresses, else the relay lookup; no wake) and sends one frame. */
export async function denyRemoteCommand(configDir: string, payload: unknown, now: number, options: { allowLocal?: boolean; address?: string } = {}): Promise<DenyOnPeerResult & { peer?: { uuid: string; name: string } }> {
  const p = typeof payload === 'object' && payload !== null ? (payload as { peer?: unknown; id?: unknown; reason?: unknown }) : {};
  if (typeof p.peer !== 'string' || typeof p.id !== 'string' || (p.reason !== undefined && typeof p.reason !== 'string')) {
    return fail('bad-payload', 'expected {"peer": "<machine>", "id": "<request id>", "reason": "<optional text>"}');
  }
  const self = readMachine(configDir);
  const network = loadNetwork(configDir, now);
  const resolved = resolveMachineRef(p.peer, [{ uuid: self.uuid, name: self.name }, ...network.directory.machines()], readAliases(configDir), networkAliasMap(configDir));
  if (!resolved.ok) {
    return fail('unknown-peer', resolved.message);
  }
  const peer = network.directory.find(resolved.uuid);
  if (resolved.uuid === self.uuid || peer === undefined) {
    return fail('unknown-peer', `"${p.peer}" is not a trusted peer of this machine: to deny a request held on THIS machine use \`machine requests --deny <id>\`; see \`machine list\``);
  }
  const early = parseRequestDeny(buildRequestDeny({ id: p.id, ...(p.reason !== undefined ? { reason: p.reason } : {}) }));
  if (!early.ok) {
    return fail('bad-deny', early.message);
  }

  let connection;
  try {
    connection = readConnections(configDir).peers[peer.peerId];
  } catch (e) {
    if (e instanceof ConnectionsError) {
      return fail('unreachable', e.message);
    }
    throw e;
  }
  const warnings: string[] = [];
  let session: PeerSession;
  try {
    const target = await resolvePeerTarget(configDir, peer, { ...(options.address !== undefined ? { address: options.address } : {}), pinned: pinnedOf(connection), now, allowLocal: options.allowLocal === true, warn: (line) => warnings.push(line) });
    ({ session } = await connectToTarget(self.identity, peer, target, undefined, DENY_CONNECT_MS));
  } catch (e) {
    return fail('unreachable', `cannot reach ${peer.name} to deny the request: ${(e as Error).message}${warnings.length > 0 ? ` (${warnings.join('; ')})` : ''}. The request stays held there until its deadline; try again when ${peer.name} is online, or run \`machine requests --deny <id>\` ON ${peer.name}`);
  }
  try {
    const result = await denyOnPeer(session, { id: p.id, ...(p.reason !== undefined ? { reason: p.reason } : {}), peerName: peer.name });
    return { ...result, peer: { uuid: peer.peerId, name: peer.name } };
  } finally {
    session.close();
  }
}
