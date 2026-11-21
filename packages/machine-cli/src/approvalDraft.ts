// Test helper (not shipped logic): the approval an admin console builds can only be sealed once the candidacy random is
// known, and the tests build it before the candidacy exists. A draft keeps the clear secrets and seals them when the fake
// relay stores the approval, with the random of the candidacy it answers. Only values still equal to PLACEHOLDER are filled,
// so a test that tampered with a field keeps its tampering.

export const PLACEHOLDER = '<sealed when the relay stores the approval>';

interface Draft {
  /** Seals the pair secrets, then the whole approval to the candidate (decision 78): returns what the relay stores. */
  complete: (random: string) => unknown;
  secrets: { self: string; peers: string[] };
}

const drafts = new WeakMap<object, Draft>();

export function registerDraft(approval: object, draft: Draft): void {
  drafts.set(approval, draft);
}

/** Seal the draft for this candidacy random and return the sealed approval the relay stores; undefined for a value that is not a draft (it is stored as is). */
export function completeDraft(approval: unknown, random: string): unknown {
  if (typeof approval === 'object' && approval !== null) {
    return drafts.get(approval)?.complete(random);
  }
  return undefined;
}

/** The clear pair secrets of a draft: what the admin knows, never what the relay sees. */
export function draftSecrets(approval: unknown): { self: string; peers: string[] } {
  const draft = typeof approval === 'object' && approval !== null ? drafts.get(approval) : undefined;
  if (!draft) throw new Error('draftSecrets: this approval was not built by buildApproval');
  return draft.secrets;
}
