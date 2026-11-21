import {
  ReplayCache,
  MAX_REQUESTS_LISTS_PER_MINUTE,
  buildRequestsListAnswer,
  verifyRequestsList,
  parseRevocationHello,
  shouldSendRevocations,
  type RequestsListAnswer,
  type RequestsListData,
  authorize,
  newRequest,
  signRequest,
  verifyRequest,
  type Json,
  type PolicyBody,
  type PolicyMode,
  type SignedRevocation,
  type Shell,
  type SigningKeyPair,
} from '@wadeck-app/machine-core';
import { runCommand, type RunOptions, type RunResult } from '@wadeck-app/machine-exec';
import { DEFAULT_MAX_FRAME_BYTES, listenForPeers, type PeerListener, type PeerSession } from '@wadeck-app/machine-transport';
import type { PeerRecord } from './directory.js';
import type { MachineIdentity } from './identity.js';
import { MAX_CATCHUPS_PER_MINUTE, RATE_LIMITED_MESSAGE, UNAVAILABLE_FRAME_MESSAGE, listsOfFrame, type RevocationSyncDeps } from './revocationSync.js';
import { MAX_FUTURE_SECONDS } from './network.js';
import { noPolicyMessage } from './noPolicy.js';

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
  /** Who manages the allow list of this machine; only the wording of a refusal depends on it. Absent: the admin. */
  policyMode?: () => PolicyMode;
  /** The platform of THIS machine: reserved device names are refused for a `name` value on `windows`. Absent: this process's platform. */
  platform?: 'windows' | 'posix';
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
  /** Revocation catch-up between peers (revocationSync.ts). Absent: a `hello` is an unknown message, as with an older build. */
  revocation?: RevocationSyncDeps;
  /** Frame cap of the peer channel (default: the transport's). Also bounds the revocation list a peer can hand over. */
  maxFrameBytes?: number;
  /** The read-only `requests-list` exchange (decision 74). Absent: it is an unknown message, as with an older build. */
  requests?: RequestsListDeps;
}

export interface RequestsListDeps {
  /** The pinned admin public key; undefined when this machine is not enrolled. */
  adminPublicKey: () => string | undefined;
  /** The pending groups of this machine's audit log, at most `limit` (the reader of machine-core, over audit.log). */
  list: (limit: number) => Omit<RequestsListData, 'id' | 'now'>;
}

export type PeerAnswer =
  | { type: 'result'; id: string; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean; outputNotUtf8: boolean; decodedFrom?: string; durationMs: number }
  | { type: 'refused'; id?: string; reason: string; message: string; allowedShells?: string[] };

/** What the service sends: the answer of a `run`, or the answer of a `requests-list` (read-only, decision 74).*/
type ServiceAnswer = PeerAnswer | RequestsListAnswer;


interface SyncState {
  helloSeen: boolean;
  listReceived: boolean;
}

class PeerService {
  private readonly replay = new ReplayCache();
  private readonly startedAt: number;
  private inFlight = 0;
  /** Peers that sent no hello, already audited once in this process. */
  private readonly helloMissing = new Set<string>();

  constructor(private readonly deps: PeerServiceDeps) {
    this.startedAt = deps.now();
  }

  async serve(session: PeerSession): Promise<void> {
    const maxRefusals = this.deps.maxRefusalsPerSession ?? DEFAULT_MAX_REFUSALS_PER_SESSION;
    let refusals = 0;
    const sync: SyncState = { helloSeen: false, listReceived: false };
    this.open.add(session);
    try {
      await this.serveLoop(session, maxRefusals, sync, refusals);
    } finally {
      this.open.delete(session);
    }
  }

  private async serveLoop(session: PeerSession, maxRefusals: number, sync: SyncState, initialRefusals: number): Promise<void> {
    let refusals = initialRefusals;
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
      // Every message re-checks the peer: revoked or removed since the session began means refused, then closed.
      if (!this.deps.directory.lookup(session.peerPublicKey)) {
        this.recordQuiet({ event: 'session-closed', source: session.peerId, reason: 'peer-revoked' });
        try {
          session.send({ type: 'refused', reason: 'peer-revoked', message: 'this machine no longer trusts you: your registration was revoked or removed' });
        } catch {
          // The session is going away anyway.
        }
        // The answer must leave before the socket is destroyed.
        setTimeout(() => session.close(), 50);
        return;
      }
      const type = typeof message === 'object' && message !== null ? (message as { type?: unknown }).type : undefined;
      if (this.deps.revocation && (type === 'hello' || type === 'revocations')) {
        const step = this.revocationFrame(session, message, type, sync, this.deps.revocation);
        if (step.refused) refusals += 1;
        for (const reply of step.replies) {
          try {
            session.send(reply);
          } catch (e) {
            if ((reply as { type?: unknown }).type !== 'revocations') return;
            // The list does not fit the frame cap: say so instead of leaving the peer waiting for it.
            this.recordQuiet({ event: 'revocation-catchup-unavailable', source: session.peerId, error: (e as Error).message });
            try {
              session.send({ type: 'revocations', unavailable: UNAVAILABLE_FRAME_MESSAGE });
            } catch {
              return;
            }
          }
        }
        if (step.close) {
          session.close();
          return;
        }
        if (refusals > maxRefusals) {
          this.recordQuiet({ event: 'session-closed', source: session.peerId, reason: 'too-many-refusals', refusals });
          session.close();
          return;
        }
        continue;
      }
      if (this.deps.revocation && type === 'run' && !sync.helloSeen && !this.helloMissing.has(session.peerId)) {
        // An older build: served as before, the absence is recorded once so the admin knows which machine cannot catch up.
        this.helloMissing.add(session.peerId);
        this.recordQuiet({ event: 'revocation-hello-missing', source: session.peerId });
      }
      let answer: ServiceAnswer;
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

  /** Starts of catch-up exchanges per peer in the last minute, and the minute in which a rate limit was last audited. */
  private readonly exchanges = new Map<string, number[]>();
  private readonly rateAudited = new Map<string, number>();
  /** Open authenticated sessions: when a peer becomes revoked, every one of its sessions is closed. */
  private readonly open = new Set<PeerSession>();

  /** Close every open session whose peer is no longer in the directory (revoked, expired, removed). Returns how many were closed. */
  revalidate(): number {
    let closed = 0;
    for (const session of [...this.open]) {
      if (this.deps.directory.lookup(session.peerPublicKey)) continue;
      this.recordQuiet({ event: 'session-closed', source: session.peerId, reason: 'peer-revoked' });
      this.open.delete(session);
      session.close();
      closed += 1;
    }
    return closed;
  }

  private rateLimited(peerId: string): boolean {
    const now = this.deps.now();
    const recent = (this.exchanges.get(peerId) ?? []).filter((t) => now - t < 60);
    if (recent.length >= MAX_CATCHUPS_PER_MINUTE) {
      this.exchanges.set(peerId, recent);
      const last = this.rateAudited.get(peerId);
      if (last === undefined || now - last >= 60) {
        this.rateAudited.set(peerId, now);
        this.recordQuiet({ event: 'revocation-catchup-rate-limited', source: peerId, limit: MAX_CATCHUPS_PER_MINUTE });
      }
      return true;
    }
    recent.push(now);
    this.exchanges.set(peerId, recent);
    return false;
  }

  /** The revocation frames of a session: `hello` (answered with ours, then ALL our lists when the digests differ) and `revocations` (no answer). */
  private revocationFrame(session: PeerSession, message: unknown, type: unknown, sync: SyncState, revocation: RevocationSyncDeps): { replies: unknown[]; refused?: boolean; close?: boolean } {
    const refused = (reason: string, text: string) => ({ replies: [this.refuse(session, undefined, reason, text)], refused: true });
    if (type === 'hello') {
      if (sync.helloSeen) return refused('duplicate-hello', 'a session carries one hello: the peer runs an incompatible version');
      const parsed = parseRevocationHello(message);
      if (!parsed.ok) return refused('bad-hello', parsed.message);
      if (this.rateLimited(session.peerId)) return refused('rate-limited', RATE_LIMITED_MESSAGE);
      let local;
      try {
        local = revocation.state();
      } catch (e) {
        // The detail stays in the local log: the peer only learns that catch-up is unavailable.
        this.problem(`cannot read the revocation state (${(e as Error).message}): revocation catch-up is unavailable`);
        return refused('revocation-state-unavailable', 'this machine cannot read its revocation state: revocation catch-up is unavailable; its admin must fix it');
      }
      sync.helloSeen = true;
      try {
        revocation.seen(session.peerId, { version: parsed.hello.revocationVersion, digest: parsed.hello.revocationDigest });
      } catch (e) {
        this.problem(`cannot record the revocation version of ${session.peerId}: ${(e as Error).message}`);
      }
      const follow = shouldSendRevocations({ digest: local.digest, hasLists: local.lists.length > 0 }, { digest: parsed.hello.revocationDigest });
      const replies: unknown[] = [{ type: 'hello', revocationDigest: local.digest, revocationVersion: local.version, revocationsFollow: follow }];
      if (follow) replies.push({ type: 'revocations', lists: local.lists });
      return { replies };
    }
    if (!sync.helloSeen) return refused('revocations-before-hello', 'a revocation list is accepted only after the hello of the session');
    if (sync.listReceived) return refused('duplicate-revocations', 'a session carries one revocation frame');
    sync.listReceived = true;
    let lists: SignedRevocation[] = [];
    let firstProblem: { reason: string; message: string } | undefined;
    try {
      lists = listsOfFrame(message);
    } catch (e) {
      firstProblem = { reason: 'rejected', message: (e as Error).message.slice(0, 300) };
    }
    let accepted = 0;
    let refusedCount = 0;
    let changed = false;
    for (const list of lists) {
      const issuedAt = list.body?.issuedAt;
      try {
        // A list dated far ahead of this clock is dropped (it would sit above every later list); an older one is merged like any other.
        if (typeof issuedAt === 'number' && issuedAt > this.deps.now() + MAX_FUTURE_SECONDS) {
          throw Object.assign(new Error(`revocation refused (future): the list is dated ${issuedAt}, more than a day in the future of this machine's clock: check the clock of the machine that signed it`), { reason: 'future' });
        }
        if (revocation.install(list).changed) changed = true;
        accepted += 1;
      } catch (e) {
        refusedCount += 1;
        firstProblem ??= { reason: (e as { reason?: string }).reason ?? 'rejected', message: (e as Error).message.slice(0, 300) };
      }
    }
    if (accepted === 0 && firstProblem) {
      this.recordQuiet({ event: 'revocation-catchup-refused', source: session.peerId, ...firstProblem, lists: lists.length });
    } else {
      this.recordQuiet({ event: 'revocation-catchup', source: session.peerId, lists: lists.length, accepted, refused: refusedCount, changed, ...(firstProblem ? { firstProblem: firstProblem.message } : {}) });
    }
    // Merged lists can revoke the peer on this very session, or another peer with open sessions.
    this.revalidate();
    return { replies: [] };
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

  private refuse(session: PeerSession, id: string | undefined, reason: string, message: string, detail: Record<string, Json> = {}, allowedShells?: string[]): PeerAnswer {
    this.recordQuiet({ event: 'refused', source: session.peerId, reason, ...(id ? { id } : {}), ...detail });
    return { type: 'refused', ...(id ? { id } : {}), reason, message, ...(allowedShells !== undefined ? { allowedShells } : {}) };
  }

  /** Starts of `requests-list` exchanges per peer in the last minute, and the minute in which a limit was last audited. */
  private readonly listExchanges = new Map<string, number[]>();
  private readonly listRateAudited = new Map<string, number>();

  private listRateLimited(peerId: string): boolean {
    const now = this.deps.now();
    const recent = (this.listExchanges.get(peerId) ?? []).filter((t) => now - t < 60);
    if (recent.length >= MAX_REQUESTS_LISTS_PER_MINUTE) {
      this.listExchanges.set(peerId, recent);
      const last = this.listRateAudited.get(peerId);
      if (last === undefined || now - last >= 60) {
        this.listRateAudited.set(peerId, now);
        this.recordQuiet({ event: 'requests-list-rate-limited', source: peerId, limit: MAX_REQUESTS_LISTS_PER_MINUTE });
      }
      return true;
    }
    recent.push(now);
    this.listExchanges.set(peerId, recent);
    return false;
  }

  /** The gates of a `requests-list` request: admin signature, target, connection, start time, replay, rate, audit, then the read. */
  private requestsList(session: PeerSession, message: unknown, requests: RequestsListDeps): ServiceAnswer {
    const now = this.deps.now();
    const request = (message as { request?: unknown }).request;
    const claimedId = (request as { body?: { id?: unknown } } | null)?.body?.id;
    const id = typeof claimedId === 'string' ? claimedId : undefined;
    const adminPublicKey = requests.adminPublicKey();
    if (adminPublicKey === undefined) return this.refuse(session, id, 'no-admin', 'this machine has no admin key pinned: it cannot tell who may list its requests');
    const verified = verifyRequestsList(request, { adminPublicKey, selfUuid: this.deps.self.uuid, peerUuid: session.peerId, now });
    if (!verified.ok) return this.refuse(session, id, verified.reason, verified.message);
    const { body } = verified;
    if (body.issuedAt < this.startedAt) return this.refuse(session, body.id, 'predates-start', 'request refused: it was issued before this machine\'s daemon started; send it again');
    const fresh = this.replay.accept(session.peerId, body.nonce, body.expiresAt, now);
    if (!fresh.ok) return this.refuse(session, body.id, fresh.reason, fresh.message);
    if (this.listRateLimited(session.peerId)) return this.refuse(session, body.id, 'rate-limited', `too many requests lists from this peer (limit ${MAX_REQUESTS_LISTS_PER_MINUTE} per minute): try again in a minute`);
    // No audit, no disclosure: the exchange is recorded BEFORE the log is read. The commands are not recorded here (they are already in the log).
    try {
      this.recordStrict({ event: 'requests-list', source: session.peerId, id: body.id, limit: body.limit });
    } catch (e) {
      this.problem(`cannot write the audit log (${(e as Error).message}): the requests list is refused until it works again`);
      return this.refuse(session, body.id, 'audit-unavailable', 'this machine cannot write its audit log; nothing was sent. Fix the disk or permissions of the machine\'s audit log');
    }
    return buildRequestsListAnswer({ id: body.id, now, ...requests.list(body.limit) }, (this.deps.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES) - 1024);
  }

  private async handle(session: PeerSession, message: unknown): Promise<ServiceAnswer> {
    const { deps } = this;
    const now = deps.now();
    // `requests-list` (decision 74): read-only, admin-signed. Without `deps.requests` it is an unknown message, exactly as for an older build.
    if (deps.requests && typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'requests-list') {
      return this.requestsList(session, message, deps.requests);
    }
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
    const policyMode = deps.policyMode?.() ?? 'admin';
    // The shell and the command are recorded (they passed verifyRequest: known shell, 1 to 2048 printable ASCII): `machine requests` lists them.
    if (!policy) return this.refuse(session, body.id, 'no-policy', noPolicyMessage(policyMode === 'local' ? 'local' : 'admin', deps.self.name), { shell: body.shell, command: body.command });

    const platform = deps.platform ?? (process.platform === 'win32' ? 'windows' : 'posix');
    const decision = authorize(policy, body.source, { shell: body.shell, command: body.command }, now, (key) => deps.usage.count(key), policyMode, deps.self.name, platform);
    if (!decision.allowed) {
      // `decision.detail` (the closest typed entry, the token and the rule that failed) goes to the LOCAL audit log only, never to the caller.
      const logged: Record<string, Json> = { shell: body.shell, command: body.command };
      if (decision.detail !== undefined) {
        logged.detail = decision.detail;
      }
      return this.refuse(session, body.id, decision.reason, decision.message, logged, decision.allowedShells);
    }
    if (this.inFlight >= (deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT)) {
      return this.refuse(session, body.id, 'busy', 'this machine is already running its maximum number of commands; retry shortly');
    }

    // No audit, no execution: the acceptance is recorded BEFORE the command can run.
    try {
      // A typed entry that matched is named (its template as signed), so the log says which rule let this command through.
      this.recordStrict({ event: 'accepted', source: session.peerId, id: body.id, shell: body.shell, command: body.command, ...(decision.template !== undefined ? { template: decision.template } : {}) });
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

/** The peer listener plus `revalidate`: tell it that revocations were installed, so the open sessions of revoked peers are closed now. */
export interface ServicedPeerListener extends PeerListener {
  revalidate(): number;
}

export async function startPeerListener(deps: PeerServiceDeps, where: { host: string; port: number }): Promise<ServicedPeerListener> {
  const service = new PeerService(deps);
  const listener = await listenForPeers({
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
    ...(deps.maxFrameBytes !== undefined ? { maxFrameBytes: deps.maxFrameBytes } : {}),
  });
  return { port: listener.port, close: () => listener.close(), revalidate: () => service.revalidate() };
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
