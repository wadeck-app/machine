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
// gates, in this order: signature and addressing, start time, authenticated source, replay, policy, concurrency, audit,
// execution. Anything that fails is refused with its cause and recorded in the audit log. No audit, no execution.

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_MAX_CONCURRENT = 4;
export const DEFAULT_MAX_REFUSALS_PER_SESSION = 20;
/** Client-side deadline: the server's command timeout plus a margin for the network and the output. */
export const DEFAULT_ANSWER_TIMEOUT_MS = DEFAULT_TIMEOUT_MS + 30_000;

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
  /** A session that collects more refusals than this is closed: a registered peer cannot flood the audit log. */
  maxRefusalsPerSession?: number;
  /** Connections refused before authentication (unknown key, wrong secret, flood): report them, never drop silently. */
  onConnectionRejected?: (reason: string) => void;
  /** Failures of the machine's own bookkeeping (audit, counters). Defaults to the error output. */
  onProblem?: (message: string) => void;
}

export type PeerAnswer =
  | { type: 'result'; id: string; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean; outputNotUtf8: boolean; durationMs: number }
  | { type: 'refused'; id?: string; reason: string; message: string };

const NO_POLICY_MESSAGE = 'no policy is installed on this machine: every command is refused until the admin signs and installs one (`machine admin sign-policy`)';

class PeerService {
  private readonly replay = new ReplayCache();
  private readonly startedAt: number;
  private inFlight = 0;

  constructor(private readonly deps: PeerServiceDeps) {
    this.startedAt = deps.now();
  }

  async serve(session: PeerSession): Promise<void> {
    const maxRefusals = this.deps.maxRefusalsPerSession ?? DEFAULT_MAX_REFUSALS_PER_SESSION;
    let refusals = 0;
    for (;;) {
      let message: unknown;
      try {
        message = await session.next();
      } catch (e) {
        const why = (e as Error).message;
        // A plain disconnect is normal; a broken frame or protocol error is something an admin wants to see.
        if (why !== 'connection closed') this.recordQuiet({ event: 'session-error', source: session.peerId, error: why });
        return;
      }
      let answer: PeerAnswer;
      try {
        answer = await this.handle(session, message);
      } catch (e) {
        // Never let one request take the daemon down.
        this.problem(`internal error while handling a request from ${session.peerId}: ${(e as Error).message}`);
        answer = { type: 'refused', reason: 'internal-error', message: `this machine could not process the request (${(e as Error).message}); nothing was run` };
      }
      if (answer.type === 'refused') refusals += 1;
      try {
        session.send(answer);
      } catch {
        return;
      }
      if (refusals > maxRefusals) {
        this.recordQuiet({ event: 'session-closed', source: session.peerId, reason: 'too-many-refusals', refusals });
        session.close();
        return;
      }
    }
  }

  private problem(message: string): void {
    (this.deps.onProblem ?? ((m: string) => process.stderr.write(`[machine] ${m}\n`)))(message);
  }

  private entry(entry: Record<string, Json>): Record<string, Json> {
    return { ts: new Date(this.deps.now() * 1000).toISOString(), ...entry };
  }

  /** Audit that must succeed (the entry guards an execution). */
  private recordStrict(entry: Record<string, Json>): void {
    this.deps.audit.write(this.entry(entry));
  }

  /** Audit that must not break the answer: a failure is reported, not thrown. */
  private recordQuiet(entry: Record<string, Json>): void {
    try {
      this.deps.audit.write(this.entry(entry));
    } catch (e) {
      this.problem(`cannot write the audit log (${(e as Error).message}): ${JSON.stringify(entry.event)}`);
    }
  }

  private refuse(session: PeerSession, id: string | undefined, reason: string, message: string, detail: Record<string, Json> = {}): PeerAnswer {
    this.recordQuiet({ event: 'refused', source: session.peerId, reason, ...(id ? { id } : {}), ...detail });
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

    // The replay cache lives in memory: a request captured before a restart must not be accepted after it.
    if (body.issuedAt < this.startedAt) {
      return this.refuse(session, body.id, 'predates-start', 'request refused: it was issued before this machine\'s daemon started; send it again');
    }
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

    // No audit, no execution: the acceptance is recorded BEFORE the command can run.
    try {
      this.recordStrict({ event: 'accepted', source: session.peerId, id: body.id, shell: body.shell, command: body.command });
    } catch (e) {
      this.problem(`cannot write the audit log (${(e as Error).message}): commands are refused until it works again`);
      return this.refuse(session, body.id, 'audit-unavailable', `this machine cannot write its audit log (${(e as Error).message}); nothing was run. Fix the disk or permissions of the machine's audit log`);
    }
    // A call is counted when it is accepted, before it runs: a crash or a timeout never gives the call back.
    try {
      deps.usage.record(decision.entryKey);
    } catch (e) {
      this.recordQuiet({ event: 'failed', id: body.id, error: `cannot record the call: ${(e as Error).message}` });
      throw e;
    }

    this.inFlight += 1;
    let result: RunResult;
    try {
      result = await (deps.run ?? runCommand)({
        shell: body.shell,
        command: body.command,
        timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxOutputBytes: deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      });
    } catch (e) {
      const why = (e as Error).message;
      this.recordQuiet({ event: 'failed', id: body.id, error: why });
      return { type: 'refused', id: body.id, reason: 'cannot-run', message: why };
    } finally {
      this.inFlight -= 1;
    }
    // The command ran: a bookkeeping failure now is reported to the admin, never turned into "could not run".
    try {
      this.recordStrict({ event: 'completed', id: body.id, exitCode: result.exitCode, timedOut: result.timedOut, truncated: result.truncated, durationMs: result.durationMs });
    } catch (e) {
      this.problem(`the command ${body.id} ran but its completion audit failed (${(e as Error).message})`);
    }
    return { type: 'result', id: body.id, ...result };
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
      service.serve(session).catch((e: unknown) => deps.onProblem?.(`peer session ended with an unexpected error: ${(e as Error).message}`));
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
  /** How long to wait for the answer; defaults to the server's command timeout plus a margin. */
  timeoutMs?: number;
}

/** Ask a connected peer to run one command and return its answer, which may be a refusal with its cause. */
export async function runOnPeer(session: PeerSession, input: RunOnPeerInput): Promise<PeerAnswer> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS;
  const body = newRequest({ source: input.source, target: input.target, shell: input.shell, command: input.command, now: input.now });
  session.send({ type: 'run', request: signRequest(body, input.identity.privateKeyPkcs8) });

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no answer from the peer within ${timeoutMs} ms: it may be busy or unreachable; check \`machine status\` on the peer machine`)),
      timeoutMs,
    );
  });
  let answer: unknown;
  try {
    answer = await Promise.race([session.next(), deadline]);
  } finally {
    clearTimeout(timer);
  }
  if (typeof answer !== 'object' || answer === null) throw new Error('the peer answered with something that is not a machine answer: the peer runs an incompatible version');
  const a = answer as PeerAnswer;
  if ((a.type !== 'result' && a.type !== 'refused') || (a.id !== undefined && a.id !== body.id)) {
    throw new Error('the peer answered with an unexpected message: the peer runs an incompatible version');
  }
  return a;
}
