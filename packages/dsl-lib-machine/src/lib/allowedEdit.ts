import type { PolicyBody, PolicyEntry } from '@wadeck-app/machine-core';
import { describeLimits, nextPolicyBodyRemoveMany, nextPolicyBodyRenewMany, parseLifetime, type EntryRef, type LifetimeInput, type LifetimeLimits } from '@wadeck-app/machine-webcrypto';
import { assertBase, assertPinnedKey, checkDelivery, deliveryNotice, noticeRecipientsText, postSigned, signDocuments, trackSigning, withAdminKey, type AllowApi, type AllowContext, type AllowResult } from './allowFlow.js';

// The delete and the change of lifetime of the Allowed page, without React (decision 112). The same path as the Allow button (decisions 76 and 92):
//   1. context   : allowFlow `loadContext` (PIN, then the signed policy the next one is edited from, the pinned admin key, where it goes).
//   2. prepare   : the next body, computed HERE from a base whose signature is verified against the pinned admin key, and only if that base is the
//                  version the person was looking at (a policy that moved is refused with the fix, never edited from what the page no longer shows).
//   3. sign+post : the same signing, locking and posting as Allow (allowFlow `signDocuments`, `postSigned`): only signed documents leave the page, and the
//                  daemon verifies them against the pinned key and the current version (compare-and-set) before it stores anything.
// A deletion only restricts; a longer lifetime widens rights and is flagged. Both need the same admin signature.

/** One entry the person selected: where the page read it, and what must still be there. */
export interface EditRef {
  shell: string;
  /** The command, or the template of a typed entry, as signed. */
  text: string;
  /** Place in its list, from 1. */
  index: number;
  /** The uuid of the peer whose own list holds it; empty for the default list. */
  peerUuid: string;
}

export type EditAction = { kind: 'delete' } | { kind: 'lifetime'; lifetime: LifetimeInput };

export interface EditedEntry {
  ref: EditRef;
  /** The entry as the verified base holds it. */
  before: PolicyEntry;
  /** A new lifetime only: the entry as it will be signed. */
  after?: PolicyEntry;
  lifetimeBefore: string;
  /** A new lifetime only. */
  lifetimeAfter?: string;
  /** A new lifetime only: this entry is allowed for longer, for more calls, or for ever. */
  widens?: boolean;
}

export interface EditPrepared {
  kind: EditAction['kind'];
  fromVersion: number;
  toVersion: number;
  body: PolicyBody;
  entries: EditedEntry[];
  /** True when at least one entry is allowed for longer, for more calls, or for ever. A deletion never widens. */
  widening: boolean;
  /** Peers whose own list is now empty: the default list does not apply to them, so they may run nothing. */
  emptiedPeerLists: string[];
  emptiedDefaults: boolean;
  /** How many commands every trusted peer without a list of its own may run after this change. */
  defaultCount: number;
  peersWithOwnList: string[];
}

const hasLimits = (l: LifetimeLimits | undefined): boolean => l !== undefined && (l.maxCalls !== undefined || l.expiresAt !== undefined);

/**
 * True when `after` lets the entry run for longer, for more calls, or for ever than `before`: one of the limits `before` had is gone or looser. A limit that
 * is new (permanent to limited) only restricts. Equal limits do not widen (the counter still starts again: the confirmation says so).
 */
export function lifetimeWidens(before: LifetimeLimits | undefined, after: LifetimeLimits | undefined): boolean {
  const calls = before?.maxCalls !== undefined && (after?.maxCalls === undefined || after.maxCalls > before.maxCalls);
  const date = before?.expiresAt !== undefined && (after?.expiresAt === undefined || after.expiresAt > before.expiresAt);
  return calls || date;
}

const refsOf = (refs: EditRef[]): EntryRef[] => refs.map((r) => ({ index: r.index, shell: r.shell as EntryRef['shell'], text: r.text, ...(r.peerUuid === '' ? {} : { peer: r.peerUuid }) }));

/**
 * The next policy for the selection, with no secret involved: what the confirmation shows. Throws a sentence that names the problem and the fix (a policy
 * that moved since the page was read, a base the pinned key did not sign, a lifetime the parser refuses).
 */
export async function prepareEdit(context: AllowContext, expectedVersion: number, refs: EditRef[], action: EditAction, now: number): Promise<EditPrepared> {
  await assertBase(context);
  const current = context.current?.body;
  const name = context.target.name;
  if (current === undefined) {
    throw new Error(`"${name}" has no policy on record: there is nothing to ${action.kind === 'delete' ? 'delete' : 'change'}. Refresh the page. Nothing was signed`);
  }
  if (current.version !== expectedVersion) {
    throw new Error(`the policy of "${name}" changed since this page was read (the page shows version ${expectedVersion}, it is version ${current.version} now). Refresh the page and select the entries again. Nothing was signed`);
  }
  const ctx = { target: context.target.uuid, adminKeyId: context.adminKeyId, now };
  // The same entry selected twice is one entry (the shared edit does the same).
  const unique = refs.filter((r, i) => refs.findIndex((o) => o.index === r.index && o.peerUuid === r.peerUuid) === i);
  let edit;
  let limits: LifetimeLimits | undefined;
  if (action.kind === 'delete') {
    edit = nextPolicyBodyRemoveMany(current, ctx, refsOf(unique));
  } else {
    limits = parseLifetime(action.lifetime, now);
    edit = nextPolicyBodyRenewMany(current, ctx, refsOf(unique), limits);
    if (!hasLimits(limits) && edit.renewed.every((r) => !hasLimits(r.before.limits))) {
      throw new Error(`the selected ${unique.length === 1 ? 'entry is' : 'entries are'} already permanent: there is nothing to change. Pick another lifetime. Nothing was signed`);
    }
  }
  // Looked up by place in the verified base and in the new body (a renewal keeps every place): the order of the shared edit is the order of the lists, not of the selection.
  const listOf = (body: PolicyBody, peerUuid: string): PolicyEntry[] => (peerUuid === '' ? body.defaults : (body.peers[peerUuid] as PolicyEntry[]));
  const entries: EditedEntry[] = unique.map((ref) => {
    const before = listOf(current, ref.peerUuid)[ref.index - 1] as PolicyEntry;
    if (action.kind === 'delete') {
      return { ref, before, lifetimeBefore: describeLimits(before.limits, now) };
    }
    const after = listOf(edit.body, ref.peerUuid)[ref.index - 1] as PolicyEntry;
    return { ref, before, after, lifetimeBefore: describeLimits(before.limits, now), lifetimeAfter: describeLimits(limits, now), widens: lifetimeWidens(before.limits, limits) };
  });
  return {
    kind: action.kind,
    fromVersion: edit.body.baseVersion,
    toVersion: edit.body.version,
    body: edit.body,
    entries,
    widening: entries.some((e) => e.widens === true),
    emptiedPeerLists: edit.emptiedPeerLists,
    emptiedDefaults: edit.emptiedDefaults,
    defaultCount: edit.body.defaults.length,
    peersWithOwnList: edit.peersWithOwnList,
  };
}

/**
 * Signs the prepared policy with the admin key (the passphrase, or the key held in this page when `passphrase` is null) and posts the signed documents.
 * `onSigned` is told once the signature is made and the key locked, before anything goes to the network. Throws with the sentence of whoever refused:
 * a wrong passphrase, a locked key, another key than the pinned one, the daemon (a stale base, mode local ...).
 */
export function signAndSubmitEdit(api: AllowApi, context: AllowContext, prepared: EditPrepared, passphrase: string | null, now: number, onSigned?: () => void): Promise<AllowResult> {
  return trackSigning(async () => {
    const check = await checkDelivery(context);
    const body = await withAdminKey(api, passphrase, async (key) => {
      assertPinnedKey(key, context);
      return signDocuments(key, context, prepared.body, now, check);
    });
    onSigned?.();
    return postSigned(api, context, body);
  });
}

/** What the page says about a finished change: the colour it deserves and the sentence. */
export interface EditOutcome {
  tone: 'success' | 'warning' | 'danger';
  text: string;
}

const plural = (n: number): string => `${n} allowed command${n === 1 ? '' : 's'}`;
const whatOf = (prepared: EditPrepared): string => (prepared.kind === 'delete' ? `deleted ${plural(prepared.entries.length)}` : `changed the lifetime of ${plural(prepared.entries.length)}`);

/** The line after a change that was signed and delivered (or stored for delivery): the version signed and the delivery in the words of the CLI. */
export function editOutcome(prepared: EditPrepared, machineName: string, result: AllowResult): EditOutcome {
  const notice = deliveryNotice(result);
  return { tone: notice.tone, text: `Signed version ${prepared.toVersion} for ${machineName}: ${whatOf(prepared)}. ${notice.text}.${noticeRecipientsText(result)}` };
}

/**
 * The daemon records a policy before it delivers it: when the delivery fails its sentence says `signed and recorded (version N)` and carries the exact
 * command that sends it again. That failure is the page's line (the list changed on this machine); any other refusal leaves nothing stored and stays in the dialog.
 */
export const RECORDED_BUT_NOT_DELIVERED = /signed and recorded \(version (\d+)\)/;

/** The line after a change that was signed and recorded here but NOT delivered: the cause and the exact command that sends it again are the daemon's sentence. */
export function editNotDelivered(prepared: EditPrepared, machineName: string, message: string): EditOutcome {
  return { tone: 'danger', text: `Signed version ${prepared.toVersion} for ${machineName} (${whatOf(prepared)}) but NOT delivered: ${message}` };
}
