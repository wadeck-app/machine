import { buildRequestNotice, buildRequestNoticeEnd, type Json, type NoticeOutcome, type Shell, type WaitingRenewal } from '@wadeck-app/machine-core';
import type { PeerToReach } from './peerConnect.js';

// The sender side of request notices (request-notices.md, decision 83): when this machine HOLDS a request, refuses one that no Allow can be
// waiting for, or when a hold ends, it tells the notice recipients over the direct mutual-TLS channel. Best effort and NEVER part of the request:
// fire and forget, every error caught and named in the audit log, nothing awaited by the caller. A notice carries no secret.

export type NoticePeer = PeerToReach;

/** The part of a peer session the notifier uses (a `PeerSession` fits). */
export interface NotifierSession {
  send(message: unknown): void;
  next(): Promise<unknown>;
  close(): void;
}

export interface NoticeRequest {
  id: string;
  /** The machine that asked, as this target knows it. */
  peer: string;
  peerName: string;
  shell: Shell;
  command: string;
  /** Epoch seconds when the hold ends by itself (held notices only). */
  deadline?: number;
  /** The request waits for the renewal of an exhausted or expired entry (held notices only). */
  renewal?: WaitingRenewal;
}

export interface RequestNotifier {
  /** A request is held (called after the `held` audit line). */
  held(request: NoticeRequest & { deadline: number }): void;
  /** A request was refused and no Allow is expected to be waited for. */
  refused(request: NoticeRequest): void;
  /** A hold ended. */
  ended(id: string, outcome: NoticeOutcome): void;
  /** Tests: resolves when every delivery in progress is over. */
  whenIdle(): Promise<void>;
  /** The daemon stops: no further attempt. */
  close(): void;
}

export interface RequestNotifierDeps {
  self: { uuid: string; name: string };
  /** The uuids of the signed notice-recipients list; undefined when this machine holds none. May throw (damaged file): reported, nobody notified. */
  recipients: () => string[] | undefined;
  /** The trusted peer of that uuid right now, or undefined. */
  peerOf: (uuid: string) => NoticePeer | undefined;
  /** Opens the authenticated channel to the peer (the path of `machine run`). Rejects with a message that names the cause. */
  connect: (peer: NoticePeer) => Promise<NotifierSession>;
  audit: (entry: Record<string, Json>) => void;
  problem: (message: string) => void;
  /** Epoch seconds. */
  now: () => number;
  /** Waits between two attempts (default: an unreferenced timer). */
  sleep?: (ms: number) => Promise<void>;
  /** Longest wait for the answer of the recipient (default 3 s). */
  ackTimeoutMs?: number;
  /** Safety net around the whole connection (address lookup included); the transport has its own per-address limit (default 10 s). */
  connectTimeoutMs?: number;
  /** Delay between attempts (default 30 s). */
  retryMs?: number;
  /** Attempts per notice (default 3). */
  maxAttempts?: number;
  /** Notices pending per recipient (default 16). */
  maxPending?: number;
}

export const NOTICE_ACK_TIMEOUT_MS = 3000;
export const NOTICE_CONNECT_TIMEOUT_MS = 10_000;
export const NOTICE_RETRY_MS = 30_000;
export const NOTICE_MAX_ATTEMPTS = 3;
export const NOTICE_MAX_PENDING = 16;
/** An older recipient (it answered `unknown-message`) is left alone this long. */
export const OUTDATED_SECONDS = 3600;
const ENDED_MEMORY = 512;

type Kind = 'request-notice' | 'request-notice-end';
type Attempt = { ok: true } | { ok: false; cause: string; outdated?: boolean };

interface Task {
  cancelled: boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

export function createRequestNotifier(deps: RequestNotifierDeps): RequestNotifier {
  const sleep = deps.sleep ?? defaultSleep;
  const ackTimeoutMs = deps.ackTimeoutMs ?? NOTICE_ACK_TIMEOUT_MS;
  const connectTimeoutMs = deps.connectTimeoutMs ?? NOTICE_CONNECT_TIMEOUT_MS;
  const retryMs = deps.retryMs ?? NOTICE_RETRY_MS;
  const maxAttempts = deps.maxAttempts ?? NOTICE_MAX_ATTEMPTS;
  const maxPending = deps.maxPending ?? NOTICE_MAX_PENDING;

  let closed = false;
  let noRecipientAudited = false;
  const notPeerAudited = new Set<string>();
  const problemsSeen = new Set<string>();
  const outdatedUntil = new Map<string, number>();
  const pending = new Map<string, Task[]>();
  const tails = new Map<string, Promise<void>>();
  const ended = new Set<string>();
  const running = new Set<Promise<void>>();

  const audit = (entry: Record<string, Json>): void => {
    try {
      deps.audit(entry);
    } catch (e) {
      deps.problem(`cannot write the audit log (${(e as Error).message}): ${JSON.stringify(entry.event)}`);
    }
  };
  const reportOnce = (message: string): void => {
    if (!problemsSeen.has(message)) {
      problemsSeen.add(message);
      deps.problem(message);
    }
  };

  const recipientUuids = (): string[] => {
    let list: string[] | undefined;
    try {
      list = deps.recipients();
    } catch (e) {
      reportOnce(`request notices are not sent: ${(e as Error).message}`);
      return [];
    }
    if (list === undefined) {
      if (!noRecipientAudited) {
        noRecipientAudited = true;
        audit({
          event: 'notice-no-recipient',
          message: `no notice-recipients list on this machine: nobody is told about held or refused requests. Run \`machine admin distribute ${deps.self.name}\` on the admin machine, or \`machine cli update\` here and on the admin machine (an older build does not send or keep the list)`,
        });
      }
      return [];
    }
    return list.filter((uuid) => uuid !== deps.self.uuid);
  };

  /** One connection, one frame, one answer. Never throws. */
  const attempt = async (peer: NoticePeer, frame: { type: Kind; id: string }): Promise<Attempt> => {
    let session: NotifierSession | undefined;
    let timer: NodeJS.Timeout | undefined;
    const limit = <T>(ms: number, what: string, work: Promise<T>): Promise<T> =>
      Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timeout: ${what} did not answer within ${ms} ms`)), ms);
        }),
      ]).finally(() => clearTimeout(timer));
    try {
      const opening = deps.connect(peer);
      try {
        session = await limit(connectTimeoutMs, 'the connection', opening);
      } catch (e) {
        // A connection that finishes after the limit is closed, never leaked.
        void opening.then((late) => late.close(), () => undefined);
        const message = (e as Error).message;
        return { ok: false, cause: message.startsWith('timeout:') ? message : `unreachable: ${message}` };
      }
      session.send(frame);
      let answer: unknown;
      try {
        answer = await limit(ackTimeoutMs, `${peer.name} (the notice was sent)`, session.next());
      } catch (e) {
        return { ok: false, cause: (e as Error).message.startsWith('timeout:') ? (e as Error).message : `connection-failed: ${(e as Error).message}` };
      }
      const a = (typeof answer === 'object' && answer !== null ? answer : {}) as { type?: unknown; id?: unknown; reason?: unknown };
      if (a.type === 'notice-ack' && a.id === frame.id) {
        return { ok: true };
      }
      if (a.type === 'refused') {
        const reason = typeof a.reason === 'string' ? a.reason.slice(0, 64) : 'unknown';
        return reason === 'unknown-message' ? { ok: false, cause: 'refused: unknown-message', outdated: true } : { ok: false, cause: `refused: ${reason}` };
      }
      return { ok: false, cause: 'unexpected-answer: the recipient answered something that is not a notice-ack: it runs an incompatible version' };
    } catch (e) {
      return { ok: false, cause: `error: ${(e as Error).message}` };
    } finally {
      try {
        session?.close();
      } catch {
        // The connection is going away anyway.
      }
    }
  };

  const lock = <T>(uuid: string, work: () => Promise<T>): Promise<T> => {
    const run = (tails.get(uuid) ?? Promise.resolve()).then(work);
    tails.set(
      uuid,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  };

  const isOutdated = (uuid: string): boolean => {
    const until = outdatedUntil.get(uuid);
    if (until === undefined) {
      return false;
    }
    if (deps.now() >= until) {
      outdatedUntil.delete(uuid);
      return false;
    }
    return true;
  };

  const deliver = async (uuid: string, kind: Kind, id: string, frame: () => { type: Kind; id: string }, wanted: () => boolean, task: Task): Promise<void> => {
    let cause = 'unknown';
    let name = uuid.slice(0, 8);
    let attempts = 0;
    for (let n = 1; n <= maxAttempts; n++) {
      if (closed || task.cancelled || isOutdated(uuid) || !wanted()) {
        return;
      }
      const peer = deps.peerOf(uuid);
      if (peer === undefined) {
        cause = 'recipient-not-a-peer';
        attempts = n;
        break;
      }
      name = peer.name;
      attempts = n;
      const result = await lock(uuid, async () => {
        if (closed || task.cancelled || isOutdated(uuid)) {
          return { ok: true } as Attempt;
        }
        return await attempt(peer, frame());
      });
      if (result.ok) {
        return;
      }
      cause = result.cause;
      if (result.outdated === true) {
        if (!isOutdated(uuid)) {
          outdatedUntil.set(uuid, deps.now() + OUTDATED_SECONDS);
          audit({ event: 'notice-recipient-outdated', recipient: uuid, recipientName: name, message: `${name} runs an older machine build that does not understand request notices: run \`machine cli update\` on ${name}; no notice is sent to it for ${OUTDATED_SECONDS / 60} minutes` });
        }
        return;
      }
      if (n < maxAttempts) {
        await sleep(retryMs);
      }
    }
    if (closed || task.cancelled) {
      return;
    }
    audit({ event: 'notice-undelivered', recipient: uuid, recipientName: name, id, kind, cause, attempts });
  };

  const enqueue = (uuid: string, kind: Kind, id: string, frame: () => { type: Kind; id: string }, wanted: () => boolean): void => {
    const peer = deps.peerOf(uuid);
    if (peer === undefined) {
      if (!notPeerAudited.has(uuid)) {
        notPeerAudited.add(uuid);
        audit({ event: 'notice-undelivered', recipient: uuid, id, kind, cause: 'recipient-not-a-peer', message: 'the notice-recipients list names a machine that is not a trusted peer of this machine: run `machine admin distribute` on the admin machine, or fix the list with `machine admin notify-to`' });
      }
      return;
    }
    const list = pending.get(uuid) ?? [];
    pending.set(uuid, list);
    if (list.length >= maxPending) {
      const oldest = list.shift() as Task & { id?: string; kind?: Kind };
      oldest.cancelled = true;
      audit({ event: 'notice-undelivered', recipient: uuid, recipientName: peer.name, id: oldest.id ?? '', kind: oldest.kind ?? kind, cause: 'too-many-pending', message: `more than ${maxPending} notices wait for ${peer.name}: the oldest was dropped` });
    }
    const task: Task & { id: string; kind: Kind } = { cancelled: false, id, kind };
    list.push(task);
    const work = deliver(uuid, kind, id, frame, wanted, task)
      .catch((e: unknown) => reportOnce(`request notice to ${peer.name} failed: ${(e as Error).message}`))
      .finally(() => {
        const at = list.indexOf(task);
        if (at >= 0) {
          list.splice(at, 1);
        }
        running.delete(work);
      });
    running.add(work);
  };

  const guarded = (action: () => void): void => {
    try {
      action();
    } catch (e) {
      reportOnce(`request notices: ${(e as Error).message}`);
    }
  };

  return {
    held(request) {
      guarded(() => {
        for (const uuid of recipientUuids()) {
          enqueue(
            uuid,
            'request-notice',
            request.id,
            () => buildRequestNotice({ id: request.id, peer: request.peer, peerName: request.peerName, shell: request.shell, command: request.command, state: 'held', deadline: request.deadline, now: deps.now(), ...(request.renewal !== undefined ? { renewal: request.renewal } : {}) }),
            () => !ended.has(request.id),
          );
        }
      });
    },
    refused(request) {
      guarded(() => {
        for (const uuid of recipientUuids()) {
          enqueue(
            uuid,
            'request-notice',
            request.id,
            () => buildRequestNotice({ id: request.id, peer: request.peer, peerName: request.peerName, shell: request.shell, command: request.command, state: 'refused', deadline: null, now: deps.now() }),
            () => true,
          );
        }
      });
    },
    ended(id, outcome) {
      guarded(() => {
        ended.add(id);
        if (ended.size > ENDED_MEMORY) {
          ended.delete(ended.values().next().value as string);
        }
        for (const uuid of recipientUuids()) {
          enqueue(uuid, 'request-notice-end', id, () => buildRequestNoticeEnd({ id, outcome, now: deps.now() }), () => true);
        }
      });
    },
    async whenIdle() {
      while (running.size > 0) {
        await Promise.all([...running]);
      }
    },
    close() {
      closed = true;
    },
  };
}
