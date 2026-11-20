import type { PolicyBody, PolicyEntry, Shell } from './policy.js';

// Pure edit of a policy (no I/O, no signature): `machine admin allow` and `machine policy allow` build the next version from the current
// one, show the difference, and only then ask for the passphrase. The result is validated and signed by the caller (signPolicy).

/** Window in which the document may be applied (the same default as `admin sign-policy`). */
export const DEFAULT_APPLY_WINDOW_SECONDS = 7 * 24 * 3600;

/** `peer` (a machine UUID) edits the OWN list of that peer instead of the default list. */
export type PolicyChange = { kind: 'allow'; entry: PolicyEntry; peer?: string } | { kind: 'remove'; command: string; shell?: Shell; peer?: string };

export interface EditContext {
  target: string;
  /** The key id of whoever signs: the admin key (mode admin) or the local policy key (mode local). Written in the `adminKeyId` field. */
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
    defaults: change.peer === undefined ? copy : JSON.parse(JSON.stringify(defaults)) as PolicyEntry[],
    peers,
  };
  return { changed: true, body, added, removed, peersWithOwnList: Object.keys(peers), seededPeerList };
}
