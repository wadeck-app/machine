// Test helper (not shipped logic): the approval an admin console builds can only be sealed once the candidacy random is
// known, and the tests build it before the candidacy exists. A draft keeps the clear secrets and seals them when the fake
// relay stores the approval, with the random of the candidacy it answers. Only values still equal to PLACEHOLDER are filled,
// so a test that tampered with a field keeps its tampering.

export const PLACEHOLDER = '<sealed when the relay stores the approval>';

interface Draft {
  complete: (random: string) => void;
  secrets: { self: string; peers: string[] };
}

const drafts = new WeakMap<object, Draft>();

export function registerDraft(approval: object, draft: Draft): void {
  drafts.set(approval, draft);
}

/** Seal the draft for this candidacy random; a value that is not a draft is left alone. */
export function completeDraft(approval: unknown, random: string): void {
  if (typeof approval === 'object' && approval !== null) drafts.get(approval)?.complete(random);
}

/** The clear pair secrets of a draft: what the admin knows, never what the relay sees. */
export function draftSecrets(approval: unknown): { self: string; peers: string[] } {
  const draft = typeof approval === 'object' && approval !== null ? drafts.get(approval) : undefined;
  if (!draft) throw new Error('draftSecrets: this approval was not built by buildApproval');
  return draft.secrets;
}
