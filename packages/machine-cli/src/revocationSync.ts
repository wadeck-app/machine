import { canonicalSignedRevocation, parseRevocationHello, shouldSendRevocations, type SignedRevocation } from '@wadeck-app/machine-core';
import type { PeerSession } from '@wadeck-app/machine-transport';

// Revocation catch-up between two peers (threat model T-06, distribution.md). After the mutual TLS and the pair proof, the CLIENT of a
// `machine run` sends `hello` (digest of its merged revocations, version = newest issuedAt, informational) as the first application frame.
// The server answers with its own `hello` and, when the digests differ and it holds signed lists, ONE `revocations` frame with all of them
// (or `unavailable` with a fixed reason). The client then sends its own lists the same way, once. The version never decides who sends:
// two admin machines may each hold a list the other lacks. Every received list goes through the existing validators (pinned admin key,
// grow-only merge): a peer can add what the admin signed, never anything else. No answer follows a `revocations` frame.

export const DEFAULT_CATCHUP_TIMEOUT_MS = 10_000;
/** Lists accepted in one frame: the bound of the set a machine keeps. */
export const MAX_LISTS_PER_FRAME = 32;
/** Exchanges a peer may start per minute on a server (flood guard, T-34). 30: a task project makes several `machine run` per minute, each one is an exchange. */
export const MAX_CATCHUPS_PER_MINUTE = 30;
/** The only text about a failure that is sent to a peer: nothing local (paths, system errors) ever leaves the machine. */
export const UNAVAILABLE_FRAME_MESSAGE = 'the revocation lists of this machine do not fit its frame limit';
export const RATE_LIMITED_MESSAGE = 'too many revocation exchanges from this peer: try again in a minute';

export interface RevocationSyncDeps {
  /** digest of the merged entries, informational version, and the admin-signed lists held (canonical). */
  state(): { digest: string; version: number; lists: SignedRevocation[] };
  /** Verify against the pinned admin key and merge grow-only. Throws an Error with the cause when the list is refused. */
  install(signed: SignedRevocation): { changed: boolean };
  /** Remember what a peer announced at this handshake. */
  seen(peerUuid: string, announced: { version: number; digest: string }): void;
}

export interface CatchUpClientDeps extends RevocationSyncDeps {
  peerId: string;
  /** Name shown in messages. */
  peerLabel: string;
  /** False once the merged revocations cover the peer we are talking to. */
  peerTrusted(): boolean;
}

export interface CatchUpReport {
  /** False when the peer answered the hello as an unknown message: an older build, no catch-up possible. */
  peerSupportsCatchUp: boolean;
  /** Version of the newest list the peer announced. */
  peerVersion?: number;
  /** The peer's lists added revocations here. */
  installed: boolean;
  /** Our lists were sent to the peer (it verifies them itself: acceptance is not acknowledged). */
  sent: boolean;
  warnings: string[];
  /** Milliseconds between sending the hello and reading the first answer (a refusal counts: it is an answer). */
  helloRoundTripMs: number;
  /** The digest of the lists the peer announced, when it answered the hello. */
  peerDigest?: string;
  /** Both sides held the same lists BEFORE the exchange (same digest). Absent when the peer did not answer with a hello. */
  inSync?: boolean;
}

function typeOf(message: unknown): unknown {
  return typeof message === 'object' && message !== null ? (message as { type?: unknown }).type : undefined;
}

async function within<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no ${what} within ${timeoutMs} ms: the peer may be busy or run an incompatible version`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** The lists of a `revocations` frame, rebuilt canonical and bounded. Throws an Error with the cause when the frame is not usable. */
export function listsOfFrame(frame: unknown): SignedRevocation[] {
  const lists = (frame as { lists?: unknown } | null)?.lists;
  if (!Array.isArray(lists)) throw new Error('the revocations frame carries no list array');
  if (lists.length > MAX_LISTS_PER_FRAME) throw new Error(`the revocations frame carries ${lists.length} lists, at most ${MAX_LISTS_PER_FRAME} are accepted`);
  return lists.map((l) => canonicalSignedRevocation(l));
}

/** Client side of the catch-up. Run it right after `connectToPeer`, before the first request. Throws when the peer turns out to be revoked. */
export async function catchUpRevocations(session: PeerSession, deps: CatchUpClientDeps, options: { timeoutMs?: number } = {}): Promise<CatchUpReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CATCHUP_TIMEOUT_MS;
  const warnings: string[] = [];
  const before = deps.state();
  const sentAt = performance.now();
  session.send({ type: 'hello', revocationDigest: before.digest, revocationVersion: before.version });

  const answer = await within(session.next(), timeoutMs, 'answer to the revocation hello');
  const helloRoundTripMs = performance.now() - sentAt;
  if (typeOf(answer) === 'refused') {
    const reason = (answer as { reason?: unknown }).reason;
    if (reason === 'unknown-message') {
      // An older build: served as before, but it cannot hand over or take a revocation list.
      return { peerSupportsCatchUp: false, installed: false, sent: false, helloRoundTripMs, warnings: [`${deps.peerLabel} does not support revocation catch-up (older machine build): update it so that revocations reach it when it connects`] };
    }
    if (reason === 'rate-limited') {
      return { peerSupportsCatchUp: true, installed: false, sent: false, helloRoundTripMs, warnings: [`${deps.peerLabel} refused the revocation exchange: ${RATE_LIMITED_MESSAGE.replace('from this peer', 'from this machine')}`] };
    }
    throw new Error(`${deps.peerLabel} refused the revocation hello (${String(reason)}): ${String((answer as { message?: unknown }).message ?? '')}`);
  }
  if (typeOf(answer) !== 'hello') throw new Error(`${deps.peerLabel} answered the revocation hello with something unexpected: the peer runs an incompatible version`);
  const parsed = parseRevocationHello(answer);
  if (!parsed.ok) throw new Error(`${deps.peerLabel} sent a malformed hello (${parsed.message}): the peer runs an incompatible version`);
  const remote = parsed.hello;
  try {
    deps.seen(deps.peerId, { version: remote.revocationVersion, digest: remote.revocationDigest });
  } catch (e) {
    warnings.push(`cannot record the revocation version of ${deps.peerLabel}: ${(e as Error).message}`);
  }

  let installed = false;
  if (remote.revocationsFollow) {
    const frame = await within(session.next(), timeoutMs, 'revocation lists after the hello');
    if (typeOf(frame) !== 'revocations') throw new Error(`${deps.peerLabel} announced revocation lists but sent something else: the peer runs an incompatible version`);
    const unavailable = (frame as { unavailable?: unknown }).unavailable;
    if (typeof unavailable === 'string') {
      warnings.push(`${deps.peerLabel} could not send its revocation lists: ${unavailable}`);
    } else {
      let lists: SignedRevocation[] = [];
      try {
        lists = listsOfFrame(frame);
      } catch (e) {
        warnings.push(`the revocation lists of ${deps.peerLabel} were refused: ${(e as Error).message}`);
      }
      for (const list of lists) {
        try {
          if (deps.install(list).changed) installed = true;
        } catch (e) {
          warnings.push(`a revocation list of ${deps.peerLabel} was refused: ${(e as Error).message}`);
        }
      }
    }
  }
  if (!deps.peerTrusted()) {
    throw new Error(`${deps.peerLabel} (${deps.peerId}) is revoked: the admin's revocation lists${installed ? ' it just handed over' : ''} cover it, so nothing was sent to it. Ask the admin which machine replaces it`);
  }

  // Once per session, from what this side held BEFORE the exchange: the receiver verifies and merges, so redundancy is harmless.
  let sent = false;
  if (shouldSendRevocations({ digest: before.digest, hasLists: before.lists.length > 0 }, { digest: remote.revocationDigest })) {
    try {
      session.send({ type: 'revocations', lists: before.lists });
      sent = true;
    } catch (e) {
      warnings.push(`cannot send the revocation lists to ${deps.peerLabel}: ${(e as Error).message}`);
    }
  }
  return { peerSupportsCatchUp: true, peerVersion: remote.revocationVersion, peerDigest: remote.revocationDigest, inSync: remote.revocationDigest === before.digest, installed, sent, helloRoundTripMs, warnings };
}
