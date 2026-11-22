import { buildDeliverDocument, clockSkewProblem, parseDeliverAck, peerClock, printable, type DeliverOutcome, type SignedDocument } from '@wadeck-app/machine-core';
import { readMachine } from './identity.js';
import { loadNetwork } from './network.js';
import { makeNoticeConnect } from './noticeWiring.js';
import type { PeerToReach } from './peerConnect.js';

// The admin side of `deliver-document` (decision 86, distribution.md "Direct delivery first"): before a document goes to the relay inbox, the admin
// machine hands the SAME sealed, signed document straight to its addressee over the authenticated mutual-TLS channel. ONE attempt (3 s to connect,
// no wake-on-LAN); only an acknowledgement `installed` or `already-installed` counts as delivered. Every other outcome returns a cause for the person
// and the caller stores the document in the inbox exactly as before. Nothing here signs or reads a secret: it carries a document that is already sealed.

/** Connection limit per address (as the request notices and `machine run`), and the whole lookup-and-connect safety net. */
export const DIRECT_CONNECT_MS = 3000;
export const DIRECT_OVERALL_MS = 4000;
/** The target applies the document before it answers: a local, quick operation. */
export const DIRECT_ACK_TIMEOUT_MS = 5000;

/** The part of a peer session the delivery uses (a `PeerSession` fits). */
export interface DeliverSession {
  send(message: unknown): void;
  next(): Promise<unknown>;
  close(): void;
}

export type DirectCode = 'unknown-peer' | 'unreachable' | 'no-answer' | 'peer-too-old' | 'refused' | 'unexpected-answer';

/** `peerNow`: the clock of the target (epoch seconds) when it said so in its answer; absent for an older build. */
export type DirectAttempt = { ok: true; outcome: DeliverOutcome; ms: number; peerNow?: number } | { ok: false; code: DirectCode; cause: string; ms: number; peerNow?: number };

/** Delivers one document to one machine; never throws. */
export type DirectDelivery = (to: { uuid: string; name: string }, document: SignedDocument) => Promise<DirectAttempt>;

export interface DirectDeliveryDeps {
  /** The trusted peer of that uuid right now, with what a connection needs; undefined when this machine does not trust it. */
  peerOf: (uuid: string) => PeerToReach | undefined;
  /** Opens the authenticated channel (the path of `machine run`). Rejects with a message that names the cause. */
  connect: (peer: PeerToReach) => Promise<DeliverSession>;
  /** Monotonic milliseconds. */
  clock?: () => number;
  /** Epoch seconds of this machine, to measure the skew with the clock the target reports (default: the system clock). */
  now?: () => number;
  /** Longest wait for the acknowledgement (default 5 s). */
  ackTimeoutMs?: number;
}

export const PEER_TOO_OLD_DELIVER_MESSAGE = (name: string): string => `${name} runs an older build that does not know the deliver-document message: run \`machine cli update\` on ${name}`;

/** One delivery function per command: a target that could not be reached is not tried again by the same command (a distribution sends several documents). */
export function createDirectDelivery(deps: DirectDeliveryDeps): DirectDelivery {
  const clock = deps.clock ?? (() => performance.now());
  const ackTimeoutMs = deps.ackTimeoutMs ?? DIRECT_ACK_TIMEOUT_MS;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const skipped = new Map<string, { code: DirectCode; cause: string }>();

  return async (to, document) => {
    const started = clock();
    const fail = (code: DirectCode, cause: string, remember = false): DirectAttempt => {
      if (remember) {
        skipped.set(to.uuid, { code, cause });
      }
      return { ok: false, code, cause, ms: Math.round(clock() - started) };
    };
    const known = skipped.get(to.uuid);
    if (known !== undefined) {
      return fail(known.code, known.cause);
    }
    const peer = deps.peerOf(to.uuid);
    if (peer === undefined) {
      return fail('unknown-peer', `this machine does not trust ${to.name} as a peer, so there is no channel to it`, true);
    }
    let session: DeliverSession;
    try {
      session = await deps.connect(peer);
    } catch (e) {
      return fail('unreachable', printable((e as Error).message, 400), true);
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      session.send(buildDeliverDocument(document));
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer from ${peer.name} within ${ackTimeoutMs} ms`)), ackTimeoutMs);
      });
      let answer: unknown;
      try {
        answer = await Promise.race([session.next(), deadline]);
      } catch (e) {
        const message = (e as Error).message;
        return fail('no-answer', message.startsWith('no answer') ? message : `the connection to ${peer.name} broke before it answered (${printable(message, 200)})`);
      }
      const ack = parseDeliverAck(answer);
      if (ack.ok) {
        if (ack.id !== document.body.id) {
          return fail('unexpected-answer', `${peer.name} acknowledged another document than the one sent: it runs an incompatible version, run \`machine cli update\` on both machines`);
        }
        return { ok: true, outcome: ack.outcome, ms: Math.round(clock() - started), ...(ack.peerNow !== undefined ? { peerNow: ack.peerNow } : {}) };
      }
      const a = (typeof answer === 'object' && answer !== null ? answer : {}) as { type?: unknown; reason?: unknown; message?: unknown; peerNow?: unknown };
      if (a.type === 'refused') {
        const reason = typeof a.reason === 'string' ? printable(a.reason, 40) : 'refused';
        // An older build refuses any message it does not know as `unknown-message`.
        if (reason === 'unknown-message') {
          return fail('peer-too-old', PEER_TOO_OLD_DELIVER_MESSAGE(peer.name), true);
        }
        const text = typeof a.message === 'string' ? printable(a.message, 500) : 'no detail';
        const peerNow = peerClock(a.peerNow);
        // A refusal for the date of the document, with the clock of the target: say which clock is off and by how much, not just "check the clocks".
        const skew = reason === 'not-yet-valid' ? clockSkewProblem(peer.name, peerNow, now()) : undefined;
        const failed = fail('refused', skew !== undefined ? `${peer.name} refused the document (not-yet-valid): ${skew}` : `${peer.name} refused the document (${reason}): ${text}`);
        return peerNow !== undefined ? { ...failed, peerNow } : failed;
      }
      return fail('unexpected-answer', `${peer.name} answered something that is not an acknowledgement of the document: it runs an incompatible version, run \`machine cli update\` on both machines`);
    } finally {
      clearTimeout(timer);
      session.close();
    }
  };
}

/** The sentence a person reads for one attempt (CLI line and page message): the success colour for a delivery, the warning colour for a fallback. */
/** The success sentence; `what` is the outcome (or a count of documents), `ms` the time it took. */
export function describeDirect(name: string, what: string, ms: number): string {
  return `Delivered directly to ${name} (${what}, ${(ms / 1000).toFixed(1)} s)`;
}

export function describeAttempt(name: string, attempt: DirectAttempt): string {
  if (attempt.ok) {
    return describeDirect(name, attempt.outcome, attempt.ms);
  }
  const where = `stored in the relay inbox, it installs it when it comes back (next poll within 60 s, or 5 s while it holds a request)`;
  if (attempt.code === 'unreachable' || attempt.code === 'unknown-peer' || attempt.code === 'no-answer') {
    return `${name} is not reachable directly: ${where}. Cause: ${attempt.cause}`;
  }
  return `${name} did not take the document directly: ${where}. Cause: ${attempt.cause}`;
}

export interface DirectOptions {
  /** Tests only: let a record point to loopback. */
  allowLocal?: boolean;
  now?: () => number;
}

/** The real thing for a config directory: the trusted peers of this machine, the pinned addresses or the signed address record, the mutual-TLS channel. */
export function directDeliveryFor(configDir: string, options: DirectOptions = {}): DirectDelivery {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  // Read at the first delivery: a machine without identity says so as the cause of the fallback instead of failing the command that asked.
  let connect: ReturnType<typeof makeNoticeConnect> | undefined;
  return createDirectDelivery({
    now,
    peerOf: (uuid) => loadNetwork(configDir, now()).directory.find(uuid),
    connect: async (peer) => {
      // The lookup plus the connection is bounded as a whole; a connection that finishes after the limit is closed.
      let timer: NodeJS.Timeout | undefined;
      let late = false;
      const limit = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          late = true;
          reject(new Error(`no connection to ${peer.name} within ${DIRECT_OVERALL_MS} ms (address lookup and handshake)`));
        }, DIRECT_OVERALL_MS);
      });
      connect ??= makeNoticeConnect(configDir, readMachine(configDir), now, options.allowLocal === true);
      const connecting = connect(peer);
      connecting.then(
        (s) => {
          if (late) {
            s.close();
          }
        },
        () => undefined,
      );
      try {
        return await Promise.race([connecting, limit]);
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
