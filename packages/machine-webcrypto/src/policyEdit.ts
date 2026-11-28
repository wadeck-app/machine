import type { Limits, PolicyBody, PolicyEntry } from '@wadeck-app/machine-core';
import { inputEqual } from './inputDeclaration.js';
import { limitsEqual } from './lifetime.js';
import { canonicalEntry, hasAngleBracket, parseEntryText, parseTemplate, type EntryText } from './template.js';
import { TemplateError } from './typedParams.js';

// What `machine admin allow` does before and after the passphrase, for the page: the next version of a policy (a COPY of machine-core policyEdit.ts,
// kept line for line; policyEdit.test.ts proves it answers the same on fixed and random inputs). The inbox document that carries it is
// `sealedPolicyDocument` (documents.ts, sealed to the target, decision 78). The page computes the next body ITSELF from a base it verified: it never signs a body a backend wrote.

/** Window in which the document may be applied (the same default as `admin sign-policy`). */
export const DEFAULT_APPLY_WINDOW_SECONDS = 7 * 24 * 3600;

type Shell = PolicyEntry['shell'];

// The three helpers of machine-core policy.ts that this copy needs (that module reads node:crypto, so it cannot be imported in a browser).
const entryText = (entry: PolicyEntry): string => (entry.template !== undefined ? entry.template : (entry.command as string));
const isTyped = (entry: PolicyEntry): entry is Extract<PolicyEntry, { template: string }> => entry.template !== undefined;
const hasTypedEntry = (lists: PolicyEntry[][]): boolean => lists.some((list) => list.some(isTyped));
const hasInputEntry = (lists: PolicyEntry[][]): boolean => lists.some((list) => list.some((e) => e.input !== undefined));
/** machine-core `policyBodyVersion`: 1 exact entries, 2 a typed entry or a renewal, 3 an input declaration. */
const policyBodyVersion = (lists: PolicyEntry[][]): 1 | 2 | 3 => (hasInputEntry(lists) ? 3 : hasTypedEntry(lists) || lists.some((list) => list.some((e) => e.limits?.renewals !== undefined)) ? 2 : 1);

/** `peer` (a machine UUID) edits the OWN list of that peer instead of the default list. */
export type PolicyChange =
  /**
   * `renew`: the Allow of an exhausted or expired entry (hold-for-approval.md, "Renewal"). The entry of the same shell and text is replaced even when its
   * limits are the same, and the generation `limits.renewals` goes up by one, so the counter of the replaced entry starts again.
   */
  | { kind: 'allow'; entry: PolicyEntry; peer?: string; renew?: boolean }
  /**
   * `command`: the text of the entry as shown by `machine allowed` (the command, or the template as signed), narrowed by `shell`.
   * `index`: the 1-based position in the edited list, as shown by `machine allowed`; it wins over `command`.
   */
  | { kind: 'remove'; command?: string; shell?: Shell; index?: number; peer?: string };

export interface EditContext {
  target: string;
  /** The key id of whoever signs: the admin key. Written in the `adminKeyId` field. */
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

const parsed = (entry: PolicyEntry): EntryText => (isTyped(entry) ? { kind: 'typed', template: parseTemplate(entry.template, entry.shell) } : { kind: 'exact', command: entry.command as string });
const canonicalOf = (entry: PolicyEntry): string => canonicalEntry(entry.shell, parsed(entry));
const withGeneration = (entry: PolicyEntry, renewals: number): PolicyEntry => {
  const { limits, ...rest } = entry;
  if (limits === undefined || (limits.maxCalls === undefined && limits.expiresAt === undefined)) {
    return rest as PolicyEntry;
  }
  return { ...rest, limits: { ...(limits.maxCalls !== undefined ? { maxCalls: limits.maxCalls } : {}), ...(limits.expiresAt !== undefined ? { expiresAt: limits.expiresAt } : {}), renewals } } as PolicyEntry;
};
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
  const command = entry.command as string;
  if (hasAngleBracket(command)) {
    throw new TemplateError(`an exact entry cannot hold an angle bracket (${JSON.stringify(command)}): ${parseEntryText(command, entry.shell).kind === 'typed' ? 'write it as a typed entry (template)' : 'remove it'}`);
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
      if (change.renew === true) {
        const after = withGeneration(change.entry, (existing.limits?.renewals ?? 0) + 1);
        renewed = [{ before: existing, after }];
        next = base.map((e, i) => (i === at ? after : e));
      } else if (limitsEqual(existing.limits, change.entry.limits) && inputEqual(existing.input, change.entry.input) && entryText(existing) === entryText(change.entry)) {
        return { changed: false, reason: 'already-allowed' };
      } else if (limitsEqual(existing.limits, change.entry.limits) && inputEqual(existing.input, change.entry.input)) {
        // Same entry, other labels only: nothing to sign.
        return { changed: false, reason: 'already-allowed' };
      } else {
        renewed = [{ before: existing, after: change.entry }];
        next = base.map((e, i) => (i === at ? change.entry : e));
      }
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
    // Version 2 only when a typed entry or a renewal generation exists: an exact-only policy stays readable by an older target.
    v: policyBodyVersion([newDefaults, ...Object.values(peers)]),
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

/** The most entries one list of a policy holds (policy.ts `assertPolicyBody`): a batch that would exceed it is refused before anything is signed. */
export const POLICY_MAX_ENTRIES_PER_LIST = 200;

export type PolicyEditMany =
  | { changed: false; reason: 'already-allowed' }
  | {
      changed: true;
      /** ONE version (current + 1) holding every entry that was new or renewed. */
      body: PolicyBody;
      added: PolicyEntry[];
      renewed: Array<{ before: PolicyEntry; after: PolicyEntry }>;
      /** Entries left out because the list already holds them (or an identical one given earlier in the same batch). */
      skipped: PolicyEntry[];
      peersWithOwnList: string[];
    };

/**
 * Several allows of the DEFAULT list in one version: the owner selects several requests and signs once. Entries are applied in order; one that is
 * already allowed (or a duplicate of an earlier one) is skipped; one the typed grammar refuses throws and nothing is built (no entry is signed without
 * the others). More entries than a list can hold throws with the numbers.
 */
export function nextPolicyBodyMany(current: PolicyBody | undefined, ctx: EditContext, entries: PolicyEntry[]): PolicyEditMany {
  if (entries.length === 0) {
    throw new Error('nothing to sign: give at least one entry');
  }
  let working = current;
  const added: PolicyEntry[] = [];
  const renewed: Array<{ before: PolicyEntry; after: PolicyEntry }> = [];
  const skipped: PolicyEntry[] = [];
  let peersWithOwnList: string[] = [];
  for (const entry of entries) {
    const edit = nextPolicyBody(working, ctx, { kind: 'allow', entry });
    if (!edit.changed) {
      skipped.push(entry);
      continue;
    }
    working = edit.body;
    added.push(...edit.added);
    renewed.push(...edit.renewed);
    peersWithOwnList = edit.peersWithOwnList;
  }
  if (working === undefined || working === current) {
    return { changed: false, reason: 'already-allowed' };
  }
  if (working.defaults.length > POLICY_MAX_ENTRIES_PER_LIST) {
    throw new Error(`the list would hold ${working.defaults.length} entries and a policy list holds at most ${POLICY_MAX_ENTRIES_PER_LIST}: allow fewer requests at once, or remove entries first (machine allowed lists them). Nothing was signed`);
  }
  const base = current?.version ?? 0;
  return { changed: true, body: { ...working, version: base + 1, baseVersion: base }, added, renewed, skipped, peersWithOwnList };
}

/**
 * One entry of one list, named by its place (1-based, as `machine allowed` shows it) AND by what must be there (shell and text). The text is checked
 * against the list the edit starts from: a list that moved since the person read it is refused, never edited at the wrong place.
 */
export interface EntryRef {
  index: number;
  shell: Shell;
  /** The command, or the template of a typed entry, as signed. */
  text: string;
  /** A machine UUID: the own list of that peer. Absent: the default list. */
  peer?: string;
}

export interface PolicyEditEntries {
  /** ONE version (current + 1) holding every change. */
  body: PolicyBody;
  /** The entries as they were before a removal, in the order of the selection (de-duplicated). */
  removed: PolicyEntry[];
  /** A new lifetime only: the entry as it was, and as it is now (new limits, generation + 1). */
  renewed: Array<{ before: PolicyEntry; after: PolicyEntry }>;
  /** Peers whose own list is now EMPTY: the default list does not apply to them, so they may run nothing. */
  emptiedPeerLists: string[];
  /** The default list is now empty. */
  emptiedDefaults: boolean;
  peersWithOwnList: string[];
}

const MOVED = 'changed since it was read. Refresh the page and select the entries again. Nothing was signed';

/** The entries the references name, from the list they start from; throws (with the fix) when one is not where it was read. */
function resolveRefs(current: PolicyBody | undefined, ctx: EditContext, refs: EntryRef[]): Array<{ ref: EntryRef; entry: PolicyEntry }> {
  if (refs.length === 0) {
    throw new Error('nothing to sign: give at least one entry');
  }
  if (current === undefined) {
    throw new Error('this machine has no policy yet: there is nothing to edit. Nothing was signed');
  }
  if (current.target !== ctx.target) {
    throw new Error(`the current policy is written for another machine (${current.target}), not for ${ctx.target}: it cannot be edited here`);
  }
  const seen = new Set<string>();
  const resolved: Array<{ ref: EntryRef; entry: PolicyEntry }> = [];
  for (const ref of refs) {
    const where = ref.peer === undefined ? 'the default list' : `the own list of ${ref.peer}`;
    if (ref.peer !== undefined && !Object.hasOwn(current.peers, ref.peer)) {
      throw new Error(`${ref.peer} has no list of its own in this policy: the policy ${MOVED}`);
    }
    const list = ref.peer === undefined ? current.defaults : (current.peers[ref.peer] as PolicyEntry[]);
    if (!Number.isInteger(ref.index) || ref.index < 1 || ref.index > list.length) {
      throw new Error(`${where} has ${list.length} entries, there is no #${ref.index}: the list ${MOVED}`);
    }
    const entry = list[ref.index - 1] as PolicyEntry;
    if (entry.shell !== ref.shell || entryText(entry) !== ref.text) {
      throw new Error(`#${ref.index} of ${where} is no longer ${ref.shell} ${JSON.stringify(ref.text)}: the list ${MOVED}`);
    }
    const id = `${ref.peer ?? ''}:${ref.index}`;
    if (!seen.has(id)) {
      seen.add(id);
      resolved.push({ ref, entry });
    }
  }
  return resolved;
}

/** The next version built from lists already edited (the same fields, dates and policy version rule as nextPolicyBody). */
function editedBody(current: PolicyBody, ctx: EditContext, defaults: PolicyEntry[], peers: PolicyBody['peers']): PolicyBody {
  const lists = [defaults, ...Object.values(peers)];
  return {
    v: policyBodyVersion(lists),
    target: ctx.target,
    version: current.version + 1,
    baseVersion: current.version,
    adminKeyId: ctx.adminKeyId,
    issuedAt: ctx.now,
    notBefore: ctx.now,
    notAfter: ctx.now + (ctx.windowSeconds ?? DEFAULT_APPLY_WINDOW_SECONDS),
    defaults,
    peers,
  };
}

/**
 * Several entries removed in ONE version (the Allowed page: select rows, delete, sign once). The indexes are those of the list the edit starts from
 * (no shift between two removals of one list). An entry that is not where it was read throws with the fix; nothing is built. A removal only restricts.
 */
export function nextPolicyBodyRemoveMany(current: PolicyBody | undefined, ctx: EditContext, refs: EntryRef[]): PolicyEditEntries {
  const resolved = resolveRefs(current, ctx, refs);
  const base = current as PolicyBody;
  const without = (list: PolicyEntry[], peer: string | undefined): PolicyEntry[] => {
    const gone = new Set(resolved.filter((r) => r.ref.peer === peer).map((r) => r.ref.index));
    return (JSON.parse(JSON.stringify(list)) as PolicyEntry[]).filter((_, i) => !gone.has(i + 1));
  };
  const defaults = without(base.defaults, undefined);
  const peers = Object.fromEntries(Object.entries(base.peers).map(([peer, list]) => [peer, without(list, peer)])) as PolicyBody['peers'];
  const touched = new Set(resolved.map((r) => r.ref.peer).filter((p): p is string => p !== undefined));
  return {
    body: editedBody(base, ctx, defaults, peers),
    removed: resolved.map((r) => r.entry),
    renewed: [],
    emptiedPeerLists: [...touched].filter((p) => (peers[p] as PolicyEntry[]).length === 0),
    emptiedDefaults: resolved.some((r) => r.ref.peer === undefined) && defaults.length === 0,
    peersWithOwnList: Object.keys(peers),
  };
}

/**
 * Several entries given a new lifetime in ONE version: each entry named is REPLACED by itself with the new limits (a renewal: its counter starts again,
 * `limits.renewals` goes up by one). `limits` undefined: permanent. A change that widens (longer, more calls, permanent) needs the same admin signature
 * as an Allow: the warning is the caller's to show, this function only builds the body.
 */
export function nextPolicyBodyRenewMany(current: PolicyBody | undefined, ctx: EditContext, refs: EntryRef[], limits: Limits | undefined): PolicyEditEntries {
  const resolved = resolveRefs(current, ctx, refs);
  const base = current as PolicyBody;
  const renewed: Array<{ before: PolicyEntry; after: PolicyEntry }> = [];
  const replace = (list: PolicyEntry[], peer: string | undefined): PolicyEntry[] =>
    (JSON.parse(JSON.stringify(list)) as PolicyEntry[]).map((entry, i) => {
      const hit = resolved.find((r) => r.ref.peer === peer && r.ref.index === i + 1);
      if (hit === undefined) {
        return entry;
      }
      const { limits: _old, ...rest } = entry;
      const after = withGeneration({ ...rest, ...(limits === undefined ? {} : { limits: { ...limits } }) } as PolicyEntry, (hit.entry.limits?.renewals ?? 0) + 1);
      renewed.push({ before: hit.entry, after });
      return after;
    });
  const defaults = replace(base.defaults, undefined);
  const peers = Object.fromEntries(Object.entries(base.peers).map(([peer, list]) => [peer, replace(list, peer)])) as PolicyBody['peers'];
  return { body: editedBody(base, ctx, defaults, peers), removed: [], renewed, emptiedPeerLists: [], emptiedDefaults: false, peersWithOwnList: Object.keys(peers) };
}
