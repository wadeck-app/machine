import type { PolicyBody, PolicyEntry, Shell } from './policy.js';

// Pure edit of a policy (no I/O, no signature): `machine admin allow` builds the next version from the current one, shows
// the difference, and only then asks for the admin passphrase. The result is validated and signed by the caller (signPolicy).

/** Window in which the document may be applied (the same default as `admin sign-policy`). */
export const DEFAULT_APPLY_WINDOW_SECONDS = 7 * 24 * 3600;

export type PolicyChange = { kind: 'allow'; entry: PolicyEntry } | { kind: 'remove'; command: string; shell?: Shell };

export interface EditContext {
  target: string;
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
    };

/** The next version of the policy of `ctx.target`: version + 1, edited from the current version (0 when there is none). */
export function nextPolicyBody(current: PolicyBody | undefined, ctx: EditContext, change: PolicyChange): PolicyEdit {
  if (current !== undefined && current.target !== ctx.target) {
    throw new Error(`the current policy is written for another machine (${current.target}), not for ${ctx.target}: it cannot be edited here`);
  }
  const defaults = current?.defaults ?? [];
  let next: PolicyEntry[];
  let added: PolicyEntry[] = [];
  let removed: PolicyEntry[] = [];
  if (change.kind === 'allow') {
    if (defaults.some((e) => e.shell === change.entry.shell && e.command === change.entry.command)) return { changed: false, reason: 'already-allowed' };
    added = [change.entry];
    next = [...defaults, change.entry];
  } else {
    const gone = (e: PolicyEntry) => e.command === change.command && (change.shell === undefined || e.shell === change.shell);
    removed = defaults.filter(gone);
    if (removed.length === 0) return { changed: false, reason: 'not-allowed' };
    next = defaults.filter((e) => !gone(e));
  }
  const base = current?.version ?? 0;
  const peers = current === undefined ? {} : (JSON.parse(JSON.stringify(current.peers)) as PolicyBody['peers']);
  const body: PolicyBody = {
    v: 1,
    target: ctx.target,
    version: base + 1,
    baseVersion: base,
    adminKeyId: ctx.adminKeyId,
    issuedAt: ctx.now,
    notBefore: ctx.now,
    notAfter: ctx.now + (ctx.windowSeconds ?? DEFAULT_APPLY_WINDOW_SECONDS),
    defaults: JSON.parse(JSON.stringify(next)) as PolicyEntry[],
    peers,
  };
  return { changed: true, body, added, removed, peersWithOwnList: Object.keys(peers) };
}
