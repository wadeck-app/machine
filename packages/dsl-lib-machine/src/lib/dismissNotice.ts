import type { AllowApi } from './allowFlow.js';

// Dismiss and Clear expired on the Requests page (decision 100): a notice row (a refused request, or a held one past its deadline with no end notice) leaves
// notices.json of THIS machine. A restricting, local action on a display row: no signature, no passphrase, no PIN (it answers nobody and touches no target and no
// audit line), unlike Deny. No React, no I/O besides the api given.

/** What a Dismiss names: one notice by the machine that reported it and its request id, or every expired one. */
export type DismissTarget = { machine: string; id: string } | { expired: true };

/** Sends the dismiss to the module backend; rejects with the sentence of the daemon (it names the cause and the fix). */
export async function dismissNotice(api: AllowApi, target: DismissTarget): Promise<void> {
  await api.post('/dismiss-notice', target);
}

/** The sentence shown when a dismiss fails: the daemon's own text, with the way out when the daemon is too old to know the command. */
export function dismissFailureMessage(err: unknown): string {
  // violations-suppress: ts/no-err-message-direct getErrorMessage is not exported by the entry of dsl-renderer or dsl-ui: the fetcher rejects with an Error that carries the daemon's sentence
  const text = err instanceof Error ? err.message : String(err);
  return /unknown command/i.test(text) ? `${text}. The daemon is older than this page: update it with \`machine cli update\` and restart it` : text;
}
