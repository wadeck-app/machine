import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalize, isRevoked, openPairSecret, verifyInboxDocument, type Json, type VerifiedDocument } from '@wadeck-app/machine-core';
import { readAdminPin } from './admin.js';
import { writeFileAtomic } from './fsutil.js';
import type { MachineIdentity } from './identity.js';
import { importPeer, installPolicy, installRevocation, loadNetwork } from './network.js';
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
const MAX_BACKOFF_MS = 600_000;
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
  timer?: InboxTimer;
  /** Asked in every round, right AFTER the heartbeat: the address record is published by the same timer (one heartbeat, not two). It must not throw; if it does, the round goes on. */
  publisher?: { tick(): Promise<void> };
  /** Tests: size of the set of installed ids. */
  handledCap?: number;
}

export interface InboxLoop {
  /** Settles when the first round (heartbeat, inbox, installation) is over. */
  ready: Promise<void>;
  /** One round now, after the one in flight (tests, and a way for a command to ask for an immediate check). */
  runOnce(): Promise<void>;
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

/** Printable ASCII only and bounded: text that came from the relay or from a document never reaches a log or the audit log raw. */
const safe = (text: string, max = 300): string => text.replace(/[^\x20-\x7e]/g, '?').slice(0, max);

/** An id as `documentId` makes it: 22 characters of canonical base64url. Anything else is never used as a key, in state or in a request. */
const isCanonicalId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{22}$/.test(id) && Buffer.from(id, 'base64url').toString('base64url') === id;

function describeKind(document: unknown): string {
  const kind = (document as { body?: { kind?: unknown } } | null)?.body?.kind;
  return typeof kind === 'string' ? safe(kind, 20) : 'unknown';
}

/** Failures of the installation validators that are verdicts on the document (permanent), as opposed to trouble of this machine. */
const REFUSAL = /^(this machine does not trust that registration|the bundle's pair secret is invalid|policy refused \(|revocation refused \()/;

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

  const install = (verified: VerifiedDocument, networkPolicy: unknown): { reason?: string } => {
    const now = o.now();
    if (verified.kind === 'peer') {
      const pairSecret = openPairSecret(verified, o.self.identity.privateKeyPkcs8);
      importPeer(o.configDir, { registration: verified.signedRegistration, pairSecret }, { now });
      return {};
    }
    if (verified.kind === 'policy') {
      try {
        installPolicy(o.configDir, verified.policy, { now });
      } catch (e) {
        // The same policy again (a second document carrying what is already in force) is not an alarm.
        const sameAsInForce = networkPolicy !== undefined && canonicalize(networkPolicy as Json) === canonicalize(verified.policy.body as unknown as Json);
        if (sameAsInForce && /policy refused \((stale-base|rollback)\)/.test((e as Error).message)) return { reason: 'already-installed' };
        throw e;
      }
      return {};
    }
    if (verified.revocation.body.entries.some((entry) => entry.uuid === selfUuid)) {
      o.log('inbox: THIS machine is on the revocation list of the admin: its peers no longer trust it');
    }
    return installRevocation(o.configDir, verified.revocation).changed ? {} : { reason: 'already-installed' };
  };

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
    const kind = describeKind(entry.document);
    const network = loadNetwork(o.configDir, o.now());
    if (!network.enrolled) {
      notice('not-enrolled', 'inbox: documents are waiting but this machine has not pinned an admin key yet: nothing can be verified. Finish `machine join` first; the documents are kept in the inbox');
      return 'other';
    }
    const verified = verifyInboxDocument(entry.document, {
      adminPublicKey: readAdminPin(o.configDir).adminPublicKey,
      selfUuid,
      now: o.now(),
      isRevoked: (uuid, serial) => isRevoked(network.revocations, uuid, serial),
    });
    if (!verified.ok) {
      if (verified.reason === 'invalid-admin-key') {
        notice('invalid-admin-key', `inbox: ${safe(verified.message)} The documents are kept in the inbox`);
        return 'other';
      }
      if (!verified.signed) {
        await dropUnverified(entry.id, verified.reason);
        return 'other';
      }
      if (verified.reason === 'not-yet-valid') {
        keep(entry.id, kind, 'not-yet-valid', `inbox: document ${entry.id} (${kind}) is not valid yet: ${safe(verified.message)}. It stays in the inbox and is looked at again at every round`);
        return 'other';
      }
      await refuse(entry.id, kind, verified.reason, verified.message);
      return 'other';
    }
    if (verified.body.id !== entry.id) {
      await dropUnverified(entry.id, 'id-mismatch');
      return 'other';
    }
    let outcome: { reason?: string };
    try {
      outcome = install(verified, network.policy);
    } catch (e) {
      const message = (e as Error).message;
      if (/not-yet-valid/.test(message)) {
        keep(entry.id, kind, 'not-yet-valid', `inbox: document ${entry.id} (${kind}) is not valid yet: ${safe(message)}. It stays in the inbox and is looked at again at every round`);
        return 'other';
      }
      if (/^cannot open the sealed pair secret/.test(message)) {
        // Not remembered, not deleted: the admin may be able to fix and send again, and a document that cannot be opened must not vanish quietly.
        sayOnce(`seal:${entry.id}`, `inbox: ${safe(message, 600)}. The document stays in the inbox; this machine cannot use it`);
        return 'other';
      }
      if (verified.kind === 'policy' && /policy refused \(stale-base\)/.test(message) && verified.policy.body.baseVersion > (network.policy?.version ?? 0)) {
        keep(
          entry.id,
          kind,
          'waiting-predecessor',
          `inbox: document ${entry.id} (policy version ${verified.policy.body.version}) is waiting: version ${verified.policy.body.baseVersion} is not installed here yet. It stays in the inbox until its predecessor arrives or it expires`,
        );
        return 'waiting';
      }
      if (REFUSAL.test(message)) {
        await refuse(entry.id, kind, 'install-refused', message);
        return 'other';
      }
      // Anything else is trouble of this machine (disk, unreadable files): the document is neither deleted nor remembered.
      failed(`document ${entry.id} (${kind}) could not be installed: ${message}`);
      return 'other';
    }
    if (!record({ event: 'document-accepted', kind, id: entry.id, ...(outcome.reason ? { reason: outcome.reason } : {}) })) return 'other';
    handled.add(entry.id);
    o.log(`inbox: document ${entry.id} (${kind}) accepted${outcome.reason ? ` (${outcome.reason})` : ''}`);
    await acknowledge(entry.id);
    return 'installed';
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
          'inbox: this machine does not own its inbox on the relay yet, so documents addressed to it cannot be read. The relay binds an inbox to the first machine token that publishes the address record of this machine: look for an "address record" line above (not enrolled, no address to publish, or not_owner after a token change, with its fix). The documents wait on the relay',
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
    if (o.publisher !== undefined) {
      try {
        // The first publication binds the inbox to this token: the read below, in the same round, already works.
        await o.publisher.tick();
      } catch (e) {
        failed(`address record: unexpected error: ${(e as Error).message}`);
      }
    }
    if (heartbeatError !== undefined) {
      failed(heartbeatError.message);
      return;
    }
    if (count === undefined) {
      notice('no-count', 'inbox: the relay does not report the inbox count in its heartbeat answer (relay not updated to distribution.md?): the inbox is read at every round instead');
    }
    const mustRead = first || count === undefined || count > 0 || notOwner;
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
    const delay = failures === 0 ? heartbeatMs : Math.min(heartbeatMs * 2 ** failures, MAX_BACKOFF_MS);
    handle = timer.set(() => void step(), delay);
  };
  const step = async (): Promise<void> => {
    await round();
    schedule();
  };

  const ready = step();
  return {
    ready,
    runOnce: round,
    stop: () => {
      stopped = true;
      if (handle !== undefined) timer.clear(handle);
      handle = undefined;
    },
  };
}
