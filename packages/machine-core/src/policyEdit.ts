import { hasTypedEntry, entryText, isTyped, type Limits, type PolicyBody, type PolicyEntry, type Shell } from './policy.js';
import { limitsEqual } from './lifetime.js';
import { canonicalEntry, hasAngleBracket, parseEntryText, parseTemplate, type EntryText } from './template.js';
import { TemplateError } from './typedParams.js';

// Pure edit of a policy (no I/O, no signature): `machine admin allow` and `machine policy allow` build the next version from the current
// one, show the difference, and only then ask for the passphrase. The result is validated and signed by the caller (signPolicy).

/** Window in which the document may be applied (the same default as `admin sign-policy`). */
export const DEFAULT_APPLY_WINDOW_SECONDS = 7 * 24 * 3600;

/** `peer` (a machine UUID) edits the OWN list of that peer instead of the default list. */
export type PolicyChange =
  | { kind: 'allow'; entry: PolicyEntry; peer?: string }
  /**
   * `command`: the text of the entry as shown by `machine allowed` (the command, or the template as signed), narrowed by `shell`.
   * `index`: the 1-based position in the edited list, as shown by `machine allowed`; it wins over `command`.
   */
  | { kind: 'remove'; command?: string; shell?: Shell; index?: number; peer?: string };

export interface EditContext {
  target: string;
  /** The key id of whoever signs: the admin key (mode admin) or the local policy key (mode local). Written in the `adminKeyId` field. */
  adminKeyId: string;
  /** Epoch seconds. */
  now: number;
  windowSeconds?: number;
}

export type PolicyEdit =
  | { changed: false; reason: 'already-allowed' | 'not-allowed' | 'bad-index' }
  | { changed: false; reason: 'ambiguous'; candidates: Array<{ index: number; entry: PolicyEntry }> }
  | {
      changed: true;
      body: PolicyBody;
      added: PolicyEntry[];
      removed: PolicyEntry[];
      /** An allow of an entry that exists with other limits: its limits were replaced ("limits updated"). */
      renewed: Array<{ before: PolicyEntry; after: PolicyEntry }>;
      /** Peers that have their own list: a change of the default list does not apply to them. */
      peersWithOwnList: string[];
      /** An allow for a peer without own list created one, seeded with the permanent default entries (a peer with its own list uses ONLY that list). */
      seededPeerList: boolean;
      /** The default entries that have limits and were NOT copied into a new per-peer list: the peer loses them. */
      leftOut: PolicyEntry[];
    };

const parsed = (entry: PolicyEntry): EntryText => (isTyped(entry) ? { kind: 'typed', template: parseTemplate(entry.template, entry.shell) } : { kind: 'exact', command: entry.command });
const canonicalOf = (entry: PolicyEntry): string => canonicalEntry(entry.shell, parsed(entry));
const hasLimits = (entry: PolicyEntry): boolean => entry.limits !== undefined && (entry.limits.maxCalls !== undefined || entry.limits.expiresAt !== undefined);

/**
 * The entry of a signing request. A text without angle bracket is an exact entry; a text with one must be a complete typed entry, otherwise
 * a TemplateError names the token (it is never kept as an exact entry).
 */
export function entryFromText(text: string, shell: Shell, limits?: Limits): PolicyEntry {
  const kind = parseEntryText(text, shell);
  const lifetime = limits === undefined ? {} : { limits };
  return kind.kind === 'exact' ? { shell, command: kind.command, ...lifetime } : { shell, template: kind.template.text, ...lifetime };
}

/** Refuses an entry that is not signable: an exact entry with an angle bracket, a template that does not parse. */
function assertSignable(entry: PolicyEntry): void {
  if (isTyped(entry)) {
    parseTemplate(entry.template, entry.shell);
    return;
  }
  if (hasAngleBracket(entry.command)) {
    throw new TemplateError(`an exact entry cannot hold an angle bracket (${JSON.stringify(entry.command)}): ${parseEntryText(entry.command, entry.shell).kind === 'typed' ? 'write it as a typed entry (template)' : 'remove it'}`);
  }
}

/** The next version of the policy of `ctx.target`: version + 1, edited from the current version (0 when there is none). */
export function nextPolicyBody(current: PolicyBody | undefined, ctx: EditContext, change: PolicyChange): PolicyEdit {
  if (current !== undefined && current.target !== ctx.target) {
    throw new Error(`the current policy is written for another machine (${current.target}), not for ${ctx.target}: it cannot be edited here`);
  }
  const defaults = current?.defaults ?? [];
  const peers = current === undefined ? {} : (JSON.parse(JSON.stringify(current.peers)) as PolicyBody['peers']);
  const hasOwn = change.peer !== undefined && Object.hasOwn(peers, change.peer);
  const fromDefaults = change.peer !== undefined && !hasOwn;
  // The list that is edited: the own list of the peer, or the default list.
  const edited: PolicyEntry[] = change.peer === undefined ? defaults : hasOwn ? (peers[change.peer as string] as PolicyEntry[]) : defaults;
  let next: PolicyEntry[];
  let added: PolicyEntry[] = [];
  let removed: PolicyEntry[] = [];
  let renewed: Array<{ before: PolicyEntry; after: PolicyEntry }> = [];
  let seededPeerList = false;
  let leftOut: PolicyEntry[] = [];
  if (change.kind === 'allow') {
    assertSignable(change.entry);
    // No own list yet: the allow creates one, seeded with the PERMANENT default entries so that the peer keeps what it could run until now.
    // An entry with limits is not copied: its counter belongs to the default list and is never carried to another scope.
    seededPeerList = fromDefaults;
    const base = fromDefaults ? edited.filter((e) => !hasLimits(e)) : edited;
    if (fromDefaults) {
      leftOut = edited.filter(hasLimits);
    }
    const wanted = canonicalOf(change.entry);
    const at = base.findIndex((e) => canonicalOf(e) === wanted);
    if (at >= 0) {
      const existing = base[at] as PolicyEntry;
      if (limitsEqual(existing.limits, change.entry.limits) && entryText(existing) === entryText(change.entry)) {
        return { changed: false, reason: 'already-allowed' };
      }
      if (limitsEqual(existing.limits, change.entry.limits)) {
        // Same entry, other labels only: nothing to sign.
        return { changed: false, reason: 'already-allowed' };
      }
      renewed = [{ before: existing, after: change.entry }];
      next = base.map((e, i) => (i === at ? change.entry : e));
    } else {
      added = [change.entry];
      next = [...base, change.entry];
    }
  } else {
    if (change.peer !== undefined && !hasOwn) return { changed: false, reason: 'not-allowed' };
    if (change.index !== undefined) {
      if (!Number.isInteger(change.index) || change.index < 1 || change.index > edited.length) {
        return { changed: false, reason: 'bad-index' };
      }
      removed = [edited[change.index - 1] as PolicyEntry];
      next = edited.filter((_, i) => i !== (change.index as number) - 1);
    } else {
      const wanted = (e: PolicyEntry): boolean => entryText(e) === change.command && (change.shell === undefined || e.shell === change.shell);
      const found = edited.flatMap((entry, i) => (wanted(entry) ? [{ index: i + 1, entry }] : []));
      if (found.length === 0) {
        return { changed: false, reason: 'not-allowed' };
      }
      if (found.length > 1) {
        return { changed: false, reason: 'ambiguous', candidates: found };
      }
      removed = [(found[0] as { entry: PolicyEntry }).entry];
      next = edited.filter((e) => e !== removed[0]);
    }
  }
  const copy = JSON.parse(JSON.stringify(next)) as PolicyEntry[];
  if (change.peer !== undefined) peers[change.peer] = copy;
  const base = current?.version ?? 0;
  const newDefaults = change.peer === undefined ? copy : (JSON.parse(JSON.stringify(defaults)) as PolicyEntry[]);
  const body: PolicyBody = {
    // Version 2 only when a typed entry exists: an exact-only policy stays readable by an older target.
    v: hasTypedEntry([newDefaults, ...Object.values(peers)]) ? 2 : 1,
    target: ctx.target,
    version: base + 1,
    baseVersion: base,
    adminKeyId: ctx.adminKeyId,
    issuedAt: ctx.now,
    notBefore: ctx.now,
    notAfter: ctx.now + (ctx.windowSeconds ?? DEFAULT_APPLY_WINDOW_SECONDS),
    defaults: newDefaults,
    peers,
  };
  return { changed: true, body, added, removed, renewed, peersWithOwnList: Object.keys(peers), seededPeerList, leftOut };
}
