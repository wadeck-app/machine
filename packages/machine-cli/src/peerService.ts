import {
  ReplayCache,
  authorize,
  newRequest,
  signRequest,
  verifyRequest,
  type Json,
  type PolicyBody,
  type Shell,
  type SigningKeyPair,
} from '@wadeck-app/machine-core';
import { runCommand, type RunOptions, type RunResult } from '@wadeck-app/machine-exec';
import { listenForPeers, type PeerListener, type PeerSession } from '@wadeck-app/machine-transport';
import type { PeerRecord } from './directory.js';
import type { MachineIdentity } from './identity.js';

// The peer service: what a machine does with an authenticated peer connection. Every request goes through the same
// gates, in this order: signature and addressing, authenticated source, replay, policy, concurrency, then execution.
// Anything that fails is refused with its cause and recorded in the audit log.

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_MAX_CONCURRENT = 4;

export interface UsageStore {
  count(key: string): number;
  record(key: string): void;
}

export interface AuditSink {
  write(entry: Record<string, Json>): void;
}

export interface PeerServiceDeps {
  self: MachineIdentity;
  directory: { lookup(identityPublicKey: string): PeerRecord | undefined };
  /** The policy currently in force on this machine, if any. */
  policy: () => PolicyBody | undefined;
  usage: UsageStore;
  audit: AuditSink;
  /** Epoch seconds. */
  now: () => number;
  run?: (options: RunOptions) => Promise<RunResult>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxConcurrent?: number;
  /** Connections refused before authentication (unknown key, wrong secret, flood): report them, never drop silently. */
  onConnectionRejected?: (reason: string) => void;
}

export type PeerAnswer =
  | { type: 'result'; id: string; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean; outputNotUtf8: boolean; durationMs: number }
  | { type: 'refused'; id?: string; reason: string; message: string };

const NO_POLICY_MESSAGE = 'no policy is installed on this machine: every command is refused until the admin signs and installs one (`machine admin sign-policy`)';

class PeerService {
  private readonly replay = new ReplayCache();
  private inFlight = 0;

  constructor(private readonly deps: PeerServiceDeps) {}

  async serve(session: PeerSession): Promise<void> {
    for (;;) {
      let message: unknown;
      try {
        message = await session.next();
      } catch {
        return;
      }
      const answer = await this.handle(session, message);
      try {
        session.send(answer);
      } catch {
        return;
      }
    }
  }

  private record(entry: Record<string, Json>): void {
    this.deps.audit.write({ ts: new Date(this.deps.now() * 1000).toISOString(), ...entry });
  }

  private refuse(session: PeerSession, id: string | undefined, reason: string, message: string, detail: Record<string, Json> = {}): PeerAnswer {
    this.record({ event: 'refused', source: session.peerId, reason, ...(id ? { id } : {}), ...detail });
    return { type: 'refused', ...(id ? { id } : {}), reason, message };
  }

  private async handle(session: PeerSession, message: unknown): Promise<PeerAnswer> {
    const { deps } = this;
    const now = deps.now();
    if (typeof message !== 'object' || message === null || (message as { type?: unknown }).type !== 'run') {
      return this.refuse(session, undefined, 'unknown-message', 'this machine only understands {"type":"run"} requests');
    }
    const request = (message as { request?: unknown }).request;
    const claimedId = (request as { body?: { id?: unknown } } | null)?.body?.id;
    const id = typeof claimedId === 'string' ? claimedId : undefined;

    const verified = verifyRequest(request, { sourcePublicKey: session.peerPublicKey, selfUuid: deps.self.uuid, now });
    if (!verified.ok) return this.refuse(session, id, verified.reason, verified.message);
    const { body } = verified;

    if (body.source !== session.peerId) {
      return this.refuse(session, body.id, 'source-mismatch', 'request refused: it claims to come from another machine than the one authenticated on this connection');
    }
    const fresh = this.replay.accept(body.source, body.nonce, body.expiresAt, now);
    if (!fresh.ok) return this.refuse(session, body.id, fresh.reason, fresh.message);

    const policy = deps.policy();
    if (!policy) return this.refuse(session, body.id, 'no-policy', NO_POLICY_MESSAGE);

    const decision = authorize(policy, body.source, { shell: body.shell, command: body.command }, now, (key) => deps.usage.count(key));
    if (!decision.allowed) {
      return this.refuse(session, body.id, decision.reason, decision.message, { shell: body.shell, command: body.command });
    }
    if (this.inFlight >= (deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT)) {
      return this.refuse(session, body.id, 'busy', 'this machine is already running its maximum number of commands; retry shortly');
    }

    // A call is counted when it is accepted, before it runs: a crash or a timeout never gives the call back.
    deps.usage.record(decision.entryKey);
    this.record({ event: 'accepted', source: session.peerId, id: body.id, shell: body.shell, command: body.command });
    this.inFlight += 1;
    try {
      const run = deps.run ?? runCommand;
      const result = await run({
        shell: body.shell,
        command: body.command,
        timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxOutputBytes: deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      });
      this.record({ event: 'completed', id: body.id, exitCode: result.exitCode, timedOut: result.timedOut, truncated: result.truncated, durationMs: result.durationMs });
      return { type: 'result', id: body.id, ...result };
    } catch (e) {
      const message = (e as Error).message;
      this.record({ event: 'failed', id: body.id, error: message });
      return { type: 'refused', id: body.id, reason: 'cannot-run', message };
    } finally {
      this.inFlight -= 1;
    }
  }
}

export async function startPeerListener(deps: PeerServiceDeps, where: { host: string; port: number }): Promise<PeerListener> {
  const service = new PeerService(deps);
  return listenForPeers({
    identity: deps.self.identity,
    host: where.host,
    port: where.port,
    resolvePeer: (key) => {
      const peer = deps.directory.lookup(key);
      return peer ? { peerId: peer.peerId, pairSecret: peer.pairSecret } : undefined;
    },
    onSession: (session) => {
      void service.serve(session);
    },
    onRejected: (reason) => deps.onConnectionRejected?.(reason),
  });
}

export interface RunOnPeerInput {
  identity: SigningKeyPair;
  source: string;
  target: string;
  shell: Shell;
  command: string;
  /** Epoch seconds. */
  now: number;
}

/** Ask a connected peer to run one command and return its answer, which may be a refusal with its cause. */
export async function runOnPeer(session: PeerSession, input: RunOnPeerInput): Promise<PeerAnswer> {
  const body = newRequest({ source: input.source, target: input.target, shell: input.shell, command: input.command, now: input.now });
  session.send({ type: 'run', request: signRequest(body, input.identity.privateKeyPkcs8) });
  const answer = await session.next();
  if (typeof answer !== 'object' || answer === null) throw new Error('the peer answered with something that is not a machine answer: the peer runs an incompatible version');
  const a = answer as PeerAnswer;
  if ((a.type !== 'result' && a.type !== 'refused') || (a.id !== undefined && a.id !== body.id)) {
    throw new Error('the peer answered with an unexpected message: the peer runs an incompatible version');
  }
  return a;
}
