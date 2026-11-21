import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Json } from '@wadeck-app/machine-core';
import { writeFileAtomic } from './fsutil.js';
import type { MachineIdentity } from './identity.js';
import { createDocumentApplier, safe } from './documentApply.js';
import { pollDelayMs } from './noPolicy.js';
import { RelayError, type InboxEntry, type RelayClient } from './relayClient.js';

// The receiving side of distribution.md. The daemon sends a heartbeat every 60 s; when the relay says documents are waiting (and
// once at start) it reads the inbox, verifies every document against the PINNED admin key and the loaded network (revocation-aware),
// installs it through the existing validators (importPeer, installPolicy, installRevocation), records it in the audit log and
// acknowledges (DELETE) it. The relay is untrusted: nothing here crashes on a relay error, every distinct problem is said once,
// and the work and the memory spent on one round are bounded whatever the relay sends.
//
// What is remembered (inbox-state.json): ONLY the ids of documents that were verified AND installed. A document that failed
// verification is deleted without remembering anything (a forgery must not block the real document that carries the same id),
// and a verified document that was refused is not remembered either (the admin must be able to send it again once the cause is
// gone). A cause that may pass (clock, predecessor policy not installed yet, a secret that cannot be opened) keeps the document
// in the inbox and it is examined again at every round, until it expires.

export const HEARTBEAT_MS = 60_000;
/**
 * Ids of installed documents kept on disk: the relay keeps no tombstone, so a replayed PUT of an acknowledged id is stored again.
 * When the oldest are forgotten, a replay of such a document is harmless: a peer is imported again identically (or refused when
 * revoked), a policy is refused by its version rule, a revocation list only grows.
 */
export const MAX_HANDLED_IDS = 2048;
/** Documents examined in one round (the relay holds at most 256 per inbox). */
export const MAX_EXAMINED_PER_ROUND = 256;
const REMEMBERED_WARNINGS = 64;
const SUMMARY_REPEAT_SECONDS = 3600;

export interface InboxTimer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface AuditWriter {
  write(entry: Record<string, Json>): void;
}

export interface InboxLoopOptions {
  configDir: string;
  self: MachineIdentity;
  /** Client with the token of THIS machine (relay.json). */
  client: RelayClient;
  audit: AuditWriter;
  /** Epoch seconds. */
  now: () => number;
  log: (line: string) => void;
  heartbeatMs?: number;
  /**
   * True while this machine waits for a policy (none installed, decision 70): the loop then runs at FAST_POLL_MS for FAST_POLL_WINDOW_MS after
   * its start, then at the normal cadence. Absent: always the normal cadence. It must not throw; if it does, the normal cadence is used and the error is logged once.
   */
  needsPolicy?: () => boolean;
  /**
   * True while this machine holds at least one request for approval: the loop then runs every HOLD_POLL_MS (5 s) instead of the normal cadence, so an Allow
   * is installed quickly. Only while the previous round succeeded (a failing relay backs off as always). It must not throw; if it does, the normal cadence is used and the error is logged once.
   */
  holdActive?: () => boolean;
  timer?: InboxTimer;
  /** Asked in every round, right AFTER the heartbeat: the address record is published by the same timer (one heartbeat, not two). It must not throw; if it does, the round goes on. */
  publisher?: { tick(): Promise<void> };
  /** Called after a revocation list was installed (the daemon drops its network cache and closes the open sessions of revoked peers). */
  onRevocationInstalled?: () => void;
  /** Called after a document changed what this machine trusts or may run (a new peer, a policy, a revocation): the daemon drops its network cache, so the change applies now and not up to 5 seconds later. */
  onInstalled?: () => void;
  /** Tests: size of the set of installed ids. */
  handledCap?: number;
}

export interface InboxLoop {
  /** Settles when the first round (heartbeat, inbox, installation) is over. */
  ready: Promise<void>;
  /** One round now, after the one in flight (tests, and a way for a command to ask for an immediate check). */
  runOnce(): Promise<void>;
  /**
   * A hold started or ended: the sleeping timer is replaced by one with the cadence that now applies (5 s while a request is held), so a hold that
   * starts just after a round does not wait out a 60 s sleep. Runs no round itself; a round in flight picks the cadence when it ends.
   */
  holdChanged(): void;
  /** Cancels the timer. A round in flight finishes. */
  stop(): void;
}

/** A set that forgets its oldest member beyond `cap`: what remembers warnings must not grow with what a relay sends. */
export class BoundedSet {
  private readonly items = new Set<string>();

  constructor(private readonly cap: number = REMEMBERED_WARNINGS) {}

  has(key: string): boolean {
    return this.items.has(key);
  }

  /** True when the key was not there. */
  add(key: string): boolean {
    if (this.items.has(key)) return false;
    this.items.add(key);
    if (this.items.size > this.cap) this.items.delete(this.items.values().next().value as string);
    return true;
  }

  clear(): void {
    this.items.clear();
  }

  get size(): number {
    return this.items.size;
  }
}

/** Ids of installed documents, kept on disk, bounded (oldest forgotten first), written once per round with `flush`. Not a secret. */
export class HandledIds {
  private ids: string[] = [];
  private dirty = false;

  constructor(
    private readonly file: string,
    private readonly cap: number = MAX_HANDLED_IDS,
  ) {
    if (!existsSync(file)) return;
    const corrupt = (why: string) =>
      new Error(
        `${file} is corrupt or invalid (${why}): it remembers which inbox documents were already installed. Delete it to start again; a replayed document is then looked at again (the policy version and registration serial rules still apply)`,
      );
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw corrupt('not valid JSON');
    }
    const o = raw as { v?: unknown; ids?: unknown } | null;
    if (typeof o !== 'object' || o === null || o.v !== 1 || !Array.isArray(o.ids) || !o.ids.every((i) => typeof i === 'string')) throw corrupt('unexpected shape');
    this.ids = (o.ids as string[]).slice(-cap);
  }

  has(id: string): boolean {
    return this.ids.includes(id);
  }

  add(id: string): void {
    if (this.has(id)) return;
    this.ids.push(id);
    if (this.ids.length > this.cap) this.ids.splice(0, this.ids.length - this.cap);
    this.dirty = true;
  }

  flush(): void {
    if (!this.dirty) return;
    writeFileAtomic(this.file, `${JSON.stringify({ v: 1, ids: this.ids })}\n`, 0o644);
    this.dirty = false;
  }
}

/** An id as `documentId` makes it: 22 characters of canonical base64url. Anything else is never used as a key, in state or in a request. */
const isCanonicalId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{22}$/.test(id) && Buffer.from(id, 'base64url').toString('base64url') === id;

type Outcome = 'installed' | 'waiting' | 'other';

export function startInboxLoop(o: InboxLoopOptions): InboxLoop {
  const heartbeatMs = o.heartbeatMs ?? HEARTBEAT_MS;
  const timer: InboxTimer = o.timer ?? {
    set: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref();
      return handle;
    },
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const selfUuid = o.self.uuid;
  const startedAt = o.now();
  const handled = new HandledIds(join(o.configDir, 'inbox-state.json'), o.handledCap ?? MAX_HANDLED_IDS);
  // Errors of the relay: said once, forgotten at the next success so that a later outage is said again.
  const errorWarned = new BoundedSet();
  // Said once per process.
  const noticed = new Set<string>();
  const said = new BoundedSet();
  let stopped = false;
  let handle: unknown;
  let chain: Promise<void> = Promise.resolve();
  let first = true;
  let failures = 0;
  let notOwner = false;
  let notRegistered = false;
  let lastSummary: { key: string; at: number } | undefined;

  const notice = (key: string, line: string): void => {
    if (noticed.has(key)) return;
    noticed.add(key);
    o.log(line);
  };
  /** Once per key, within the bounded memory of what was said. */
  const sayOnce = (key: string, line: string): void => {
    if (said.add(key)) o.log(line);
  };
  const failed = (message: string): void => {
    failures++;
    if (errorWarned.add(message)) o.log(`inbox: ${safe(message, 600)}`);
  };
  const succeeded = (): void => {
    failures = 0;
    if (errorWarned.size > 0) {
      errorWarned.clear();
      o.log('inbox: the relay is working again');
    }
  };

  const record = (entry: Record<string, Json>): boolean => {
    try {
      o.audit.write({ ts: new Date(o.now() * 1000).toISOString(), ...entry });
      return true;
    } catch (e) {
      failed(`cannot write the audit log (${(e as Error).message}): the document is kept in the inbox and handled again at the next round`);
      return false;
    }
  };

  const acknowledge = async (id: string): Promise<void> => {
    try {
      await o.client.deleteInboxDocument(selfUuid, id);
    } catch (e) {
      failed(`document ${safe(id)} was handled but could not be deleted from the inbox: ${(e as Error).message}`);
    }
  };

  // Per round.
  let unverified = new Map<string, number>();

  /** A document that could not be verified (or is not what the relay says it is): deleted, counted, never remembered or audited one by one. */
  const dropUnverified = async (id: string | undefined, reason: string): Promise<void> => {
    unverified.set(reason, (unverified.get(reason) ?? 0) + 1);
    if (id !== undefined) await acknowledge(id);
  };

  /** A verified document of the admin that this machine refuses for good: audited (once), deleted, NOT remembered (the admin may send it again). */
  const refuse = async (id: string, kind: string, reason: string, detail: string): Promise<void> => {
    if (said.add(`refused:${id}:${reason}`)) {
      o.log(`inbox: document ${id} (${kind}) REFUSED: ${reason}: ${safe(detail)}`);
      if (!record({ event: 'document-rejected', kind, id, reason, detail: safe(detail) })) return;
    }
    await acknowledge(id);
  };

  /** Kept in the inbox, examined again at every round; recorded once. */
  const keep = (id: string, kind: string, reason: string, line: string): void => {
    if (said.add(`kept:${id}:${reason}`)) {
      o.log(line);
      record({ event: 'document-deferred', kind, id, reason, detail: safe(line) });
    }
  };

  const apply = createDocumentApplier({
    configDir: o.configDir,
    self: o.self,
    now: o.now,
    log: o.log,
    ...(o.onInstalled ? { onInstalled: o.onInstalled } : {}),
    ...(o.onRevocationInstalled ? { onRevocationInstalled: o.onRevocationInstalled } : {}),
  });

  const handleEntry = async (entry: InboxEntry): Promise<Outcome> => {
    if (!isCanonicalId(entry.id)) {
      // Never a key, never in a path: the relay named a document with something that is not an id.
      await dropUnverified(undefined, 'invalid-id');
      return 'other';
    }
    if (handled.has(entry.id)) {
      sayOnce(`replay:${entry.id}`, `inbox: document ${entry.id} was already installed (replayed by the relay): skipped and acknowledged without installing it again`);
      await acknowledge(entry.id);
      return 'other';
    }
    // The verification and the installation are the same code as for a document delivered directly by a peer (documentApply.ts).
    const result = apply(entry.document, entry.id);
    switch (result.status) {
      case 'not-enrolled':
        notice('not-enrolled', 'inbox: documents are waiting but this machine has not pinned an admin key yet: nothing can be verified. Finish `machine join` first; the documents are kept in the inbox');
        return 'other';
      case 'blocked':
        notice('invalid-admin-key', `inbox: ${safe(result.message)} The documents are kept in the inbox`);
        return 'other';
      case 'unverified':
        await dropUnverified(entry.id, result.reason);
        return 'other';
      case 'deferred':
        keep(entry.id, result.kind, 'not-yet-valid', `inbox: document ${entry.id} (${result.kind}) is not valid yet: ${safe(result.message)}. It stays in the inbox and is looked at again at every round`);
        return 'other';
      case 'unopenable':
        // Not remembered, not deleted: the admin may be able to fix and send again, and a document that cannot be opened must not vanish quietly.
        sayOnce(`seal:${entry.id}`, `inbox: ${safe(result.message, 600)}. The document stays in the inbox; this machine cannot use it`);
        return 'other';
      case 'waiting':
        keep(
          entry.id,
          result.kind,
          'waiting-predecessor',
          `inbox: document ${entry.id} (policy version ${result.version}) is waiting: version ${result.baseVersion} is not installed here yet. It stays in the inbox until its predecessor arrives or it expires`,
        );
        return 'waiting';
      case 'refused':
        await refuse(entry.id, result.kind, result.reason, result.message);
        return 'other';
      case 'error':
        // Anything else is trouble of this machine (disk, unreadable files): the document is neither deleted nor remembered.
        failed(`document ${entry.id} (${result.kind}) could not be installed: ${result.message}`);
        return 'other';
      case 'installed':
      case 'already-installed': {
        const reason = result.status === 'already-installed' ? 'already-installed' : undefined;
        if (!record({ event: 'document-accepted', kind: result.kind, id: entry.id, ...(reason ? { reason } : {}) })) return 'other';
        handled.add(entry.id);
        o.log(`inbox: document ${entry.id} (${result.kind}) accepted${reason ? ` (${reason})` : ''}`);
        await acknowledge(entry.id);
        return 'installed';
      }
    }
  };

  /** One line per round for everything that failed verification, and the same line again only after an hour. */
  const summarizeUnverified = (): void => {
    if (unverified.size === 0) return;
    const reasons = Object.fromEntries([...unverified.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
    const count = [...unverified.values()].reduce((a, b) => a + b, 0);
    const key = JSON.stringify({ count, reasons });
    const at = o.now();
    if (lastSummary !== undefined && lastSummary.key === key && at - lastSummary.at < SUMMARY_REPEAT_SECONDS) return;
    lastSummary = { key, at };
    o.log(`inbox: ${count} document(s) failed verification and were deleted (${Object.entries(reasons).map(([r, n]) => `${r}: ${n}`).join(', ')}). They were not installed and nothing about them is remembered`);
    record({ event: 'documents-unverified', count, reasons });
  };

  const readInbox = async (): Promise<boolean> => {
    let entries: InboxEntry[];
    try {
      entries = await o.client.listInbox(selfUuid, MAX_EXAMINED_PER_ROUND);
    } catch (e) {
      if (e instanceof RelayError && e.code === 'not_owner') {
        // A state, not an outage: no backoff, but the inbox is tried again at every round so that the machine recovers by itself.
        notOwner = true;
        notice(
          'not-owner',
          'inbox: this machine does not own its inbox on the relay: another token is bound to its uuid (the relay binds a uuid to the token of the candidacy the admin approved), so documents addressed to it cannot be read. Run `machine join --resume` (same token) or `machine join <code> --force` (new token) and ask the admin to approve the new candidacy: approving replaces the binding. The documents wait on the relay',
        );
        return false;
      }
      failed((e as Error).message);
      return false;
    }
    if (notOwner) {
      notOwner = false;
      noticed.delete('not-owner');
      o.log('inbox: this machine now owns its inbox on the relay');
    }
    if (entries.length >= MAX_EXAMINED_PER_ROUND) {
      notice('capped', `inbox: ${MAX_EXAMINED_PER_ROUND} documents or more are waiting: only the oldest ${MAX_EXAMINED_PER_ROUND} are examined in one round, the others wait for the next rounds`);
    }
    unverified = new Map();
    const waiting: InboxEntry[] = [];
    let installed = 0;
    const examine = async (entry: InboxEntry, retry: boolean): Promise<void> => {
      try {
        const outcome = await handleEntry(entry);
        if (outcome === 'installed') installed++;
        else if (outcome === 'waiting' && !retry) waiting.push(entry);
      } catch (e) {
        // Local trouble (unreadable network files, disk): the document stays in the inbox for the next round.
        failed(`document ${safe(entry.id)} could not be handled: ${(e as Error).message}`);
      }
    };
    try {
      for (const entry of entries) {
        if (stopped) break;
        await examine(entry, false);
      }
      // A policy that came before its predecessor in this list gets one more look once something was installed.
      if (installed > 0) for (const entry of waiting) if (!stopped) await examine(entry, true);
    } finally {
      try {
        handled.flush();
      } catch (e) {
        failed(`cannot write ${join(o.configDir, 'inbox-state.json')} (${(e as Error).message}): a replayed document would be looked at again`);
      }
      summarizeUnverified();
    }
    return true;
  };

  const cycle = async (): Promise<void> => {
    // The heartbeat goes FIRST: a slow or failing relay on the address record must never delay presence.
    let count: number | undefined;
    let heartbeatError: Error | undefined;
    try {
      count = (await o.client.heartbeat(selfUuid)).inboxCount;
    } catch (e) {
      heartbeatError = e as Error;
    }
    let ticked = false;
    if (o.publisher !== undefined) {
      try {
        // The first publication binds the inbox to this token: the read below, in the same round, already works.
        await o.publisher.tick();
        ticked = true;
      } catch (e) {
        failed(`address record: unexpected error: ${(e as Error).message}`);
      }
    }
    // The real relay answers a heartbeat 404 until the address record exists (found by the integration tests against the real relay). That is not an
    // outage: the record was just published by the tick above, so ask once more; when there is still none, read the inbox anyway (reading needs no record).
    const noRecord = (e: Error | undefined): boolean => e instanceof RelayError && e.status === 404;
    let countUnknown = false;
    if (noRecord(heartbeatError)) {
      heartbeatError = undefined;
      if (ticked) {
        try {
          count = (await o.client.heartbeat(selfUuid)).inboxCount;
        } catch (e) {
          heartbeatError = e as Error;
        }
      }
      if ((heartbeatError === undefined && count === undefined) || noRecord(heartbeatError)) {
        heartbeatError = undefined;
        countUnknown = true;
      }
    }
    // The real relay refuses the heartbeat of a token that does not own the uuid (not_owner), like the inbox read: read the inbox, which says why (a state, no backoff).
    if (heartbeatError instanceof RelayError && heartbeatError.status === 403 && heartbeatError.code === 'not_owner') {
      heartbeatError = undefined;
      countUnknown = true;
    }
    if (heartbeatError !== undefined) {
      if (heartbeatError instanceof RelayError && heartbeatError.status === 403 && heartbeatError.code === 'not_registered') {
        // Not approved yet (relay that binds a uuid at approval): a state, not an outage; nothing can be read, and the next round is on time.
        notRegistered = true;
        notice('not-registered', `inbox: ${safe(heartbeatError.message, 600)}`);
        failures = 0;
        return;
      }
      failed(heartbeatError.message);
      return;
    }
    if (notRegistered) {
      notRegistered = false;
      noticed.delete('not-registered');
      o.log('inbox: this machine is approved on the relay now');
      // What waited for the approval is read at once.
      first = true;
    }
    if (count === undefined && !countUnknown) {
      notice('no-count', 'inbox: the relay does not report the inbox count in its heartbeat answer (relay not updated to distribution.md?): the inbox is read at every round instead');
    }
    const mustRead = first || countUnknown || count === undefined || count > 0 || notOwner;
    first = false;
    if (mustRead && !(await readInbox())) {
      // not_owner is a state and does not count as a failure of the relay.
      if (notOwner) failures = 0;
      return;
    }
    succeeded();
  };

  const round = (): Promise<void> => {
    const next = chain.then(async () => {
      try {
        await cycle();
      } catch (e) {
        failed(`unexpected error: ${(e as Error).message}`);
      }
    });
    chain = next;
    return next;
  };

  const schedule = (): void => {
    if (stopped) return;
    let needsPolicy = false;
    if (o.needsPolicy !== undefined && failures === 0) {
      try {
        needsPolicy = o.needsPolicy();
      } catch (e) {
        notice('needs-policy', `inbox: cannot tell whether a policy is installed (${safe((e as Error).message)}): the normal cadence is used`);
      }
    }
    let holdActive = false;
    if (o.holdActive !== undefined && failures === 0) {
      try {
        holdActive = o.holdActive();
      } catch (e) {
        notice('hold-active', `inbox: cannot tell whether a request is held (${safe((e as Error).message)}): the normal cadence is used`);
      }
    }
    const delay = pollDelayMs({ normalMs: heartbeatMs, failures, needsPolicy, elapsedMs: (o.now() - startedAt) * 1000, holdActive });
    handle = timer.set(() => void step(), delay);
  };
  let inRound = false;
  const step = async (): Promise<void> => {
    inRound = true;
    try {
      await round();
    } finally {
      inRound = false;
    }
    schedule();
  };

  const ready = step();
  return {
    ready,
    runOnce: round,
    holdChanged: () => {
      if (stopped || inRound || handle === undefined) {
        return;
      }
      timer.clear(handle);
      schedule();
    },
    stop: () => {
      stopped = true;
      if (handle !== undefined) timer.clear(handle);
      handle = undefined;
    },
  };
}
