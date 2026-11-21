import type { PolicyBody, PolicyEntry, SignedDocument, SignedPolicy } from '@wadeck-app/machine-core';
import { buildDocument, DOCUMENT_RETENTION_SECONDS, documentId } from './documents.js';

// What `machine admin allow` does before and after the passphrase, for the page: the next version of a policy (a COPY of machine-core policyEdit.ts,
// kept line for line; policyEdit.test.ts proves it answers the same on fixed and random inputs) and the inbox document that carries it (the rule of
// distributePolicy of machine-cli). The page computes the next body ITSELF from a base it verified: it never signs a body a backend wrote.

/** Window in which the document may be applied (the same default as `admin sign-policy`). */
export const DEFAULT_APPLY_WINDOW_SECONDS = 7 * 24 * 3600;

type Shell = PolicyEntry['shell'];

/** `peer` (a machine UUID) edits the OWN list of that peer instead of the default list. */
export type PolicyChange = { kind: 'allow'; entry: PolicyEntry; peer?: string } | { kind: 'remove'; command: string; shell?: Shell; peer?: string };

export interface EditContext {
  target: string;
  /** The key id of whoever signs: the admin key. Written in the `adminKeyId` field. */
  adminKeyId: string;
  /** Epoch seconds. */
  now: number;
  windowSeconds?: number;
}

export type PolicyEdit =
  | { changed: false; reason: 'already-allowed' | 'not-allowed' }
  | {
      changed: true;
      body: PolicyBody;
      added: PolicyEntry[];
      removed: PolicyEntry[];
      /** Peers that have their own list: a change of the default list does not apply to them. */
      peersWithOwnList: string[];
      /** An allow for a peer without own list created one, seeded with the default entries (a peer with its own list uses ONLY that list). */
      seededPeerList: boolean;
    };

/** The next version of the policy of `ctx.target`: version + 1, edited from the current version (0 when there is none). */
export function nextPolicyBody(current: PolicyBody | undefined, ctx: EditContext, change: PolicyChange): PolicyEdit {
  if (current !== undefined && current.target !== ctx.target) {
    throw new Error(`the current policy is written for another machine (${current.target}), not for ${ctx.target}: it cannot be edited here`);
  }
  const defaults = current?.defaults ?? [];
  const peers = current === undefined ? {} : (JSON.parse(JSON.stringify(current.peers)) as PolicyBody['peers']);
  const hasOwn = change.peer !== undefined && Object.hasOwn(peers, change.peer);
  // The list that is edited: the own list of the peer, or the default list.
  const edited: PolicyEntry[] = change.peer === undefined ? defaults : hasOwn ? (peers[change.peer] as PolicyEntry[]) : defaults;
  let next: PolicyEntry[];
  let added: PolicyEntry[] = [];
  let removed: PolicyEntry[] = [];
  let seededPeerList = false;
  if (change.kind === 'allow') {
    if (edited.some((e) => e.shell === change.entry.shell && e.command === change.entry.command)) return { changed: false, reason: 'already-allowed' };
    // No own list yet: the allow creates one, seeded with the defaults so that the peer keeps what it could run until now.
    seededPeerList = change.peer !== undefined && !hasOwn;
    added = [change.entry];
    next = [...edited, change.entry];
  } else {
    if (change.peer !== undefined && !hasOwn) return { changed: false, reason: 'not-allowed' };
    const gone = (e: PolicyEntry) => e.command === change.command && (change.shell === undefined || e.shell === change.shell);
    removed = edited.filter(gone);
    if (removed.length === 0) return { changed: false, reason: 'not-allowed' };
    next = edited.filter((e) => !gone(e));
  }
  const copy = JSON.parse(JSON.stringify(next)) as PolicyEntry[];
  if (change.peer !== undefined) peers[change.peer] = copy;
  const base = current?.version ?? 0;
  const body: PolicyBody = {
    v: 1,
    target: ctx.target,
    version: base + 1,
    baseVersion: base,
    adminKeyId: ctx.adminKeyId,
    issuedAt: ctx.now,
    notBefore: ctx.now,
    notAfter: ctx.now + (ctx.windowSeconds ?? DEFAULT_APPLY_WINDOW_SECONDS),
    defaults: change.peer === undefined ? copy : (JSON.parse(JSON.stringify(defaults)) as PolicyEntry[]),
    peers,
  };
  return { changed: true, body, added, removed, peersWithOwnList: Object.keys(peers), seededPeerList };
}

/**
 * The inbox document of a policy signed by the admin, built like `distributePolicy` of machine-cli: the id comes from the policy (so a retry is the
 * same document and the relay answers `id_conflict`), it is valid until the policy can no longer be applied (at most the 30 days the relay keeps it).
 * `now` only refuses an already expired one.
 */
export async function policyDocumentFor(signed: SignedPolicy, now: number, adminPrivateKey: CryptoKey): Promise<SignedDocument> {
  const to = signed.body.target;
  const issuedAt = signed.body.issuedAt;
  const expiresAt = Math.min(issuedAt + DOCUMENT_RETENTION_SECONDS, signed.body.notAfter);
  if (expiresAt <= now) throw new Error(`the policy could be applied until ${new Date(signed.body.notAfter * 1000).toISOString()}, which has passed: sign it again`);
  return buildDocument(
    { kind: 'policy', to, id: await documentId(`policy:${to}:${signed.body.version}:${signed.signature}`), issuedAt, expiresAt, payload: signed as never },
    adminPrivateKey,
  );
}
