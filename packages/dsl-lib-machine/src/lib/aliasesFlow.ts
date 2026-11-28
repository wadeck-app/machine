import { aliasConflicts, buildAliases, planAliasChange, unlockAdminKey, type AliasChange, type AliasConflict, type AliasEntry, type SignedAliases } from '@wadeck-app/machine-webcrypto';
import type { SignedRegistration } from '@wadeck-app/machine-core';
import { assertPinnedKey, readKeyFile, trackSigning, type AllowApi } from './allowFlow.js';
import { postDeliveryRetry } from './deliveryRetry.js';
import { nameShortIds } from './machineIds.js';
import { distributionOf, hasDeliveryShape, isObject, type PageDistribution } from './pageDelivery.js';

// Network aliases from the page without React (admin-ui.md, "Rename and aliases from the page"; decision 116). What `machine admin alias set|rm` does, with the admin passphrase
// and the unlocked key living ONLY in this page and for ONE change (a change is one alias added or removed; each is its own signature):
//
//   1. context  (sensitive GET, after the PIN): the list this machine holds, the machines an alias may point to, the local aliases, the registrations to send the list to.
//   2. preview  (no key): the plan of the CLI (`planAliasChange`) and the local aliases that would win over the new list, said before the passphrase is asked.
//   3. sign     (passphrase): the key file is read, unlocked as a NON-EXTRACTABLE key, used for the WHOLE new list and one sealed document per machine, and LOCKED again
//      before anything is posted. The passphrase is a parameter of `signAndChangeAlias` only.
//   4. post     (sensitive POST): the daemon verifies against the pinned key that the list differs by exactly this change, keeps it, then delivers. A failed delivery never
//      undoes the signature.
// An alias is a label for a human, never a right.

export type { AliasChange, AliasConflict, AliasEntry };

/** The answer of the daemon command `aliasesContext`, served by `GET /aliases-context`. */
export interface AliasesContext {
  ok: true;
  adminMachine: { uuid: string; name: string };
  adminPublicKey: string;
  adminKeyId: string;
  /** The signed list this machine holds, or null when none was ever signed. */
  current: SignedAliases | null;
  /** The machines an alias may point to: the trusted peers AND the admin machine. */
  machines: Array<{ uuid: string; name: string }>;
  /** Uuids revoked here. */
  revoked: string[];
  /** Local aliases of the admin machine, alias to uuid. */
  localAliases: Record<string, string>;
  /** The registrations of the machines the list is sent to (the trusted peers, not the admin machine). */
  recipients: SignedRegistration[];
}

const unexpected = (what: string): Error =>
  new Error(`the module backend sent an unexpected answer for ${what}: the page and the module are not the same version: update the machine module (\`app-core-cli update\`) and reload the page`);

const isRegistration = (v: unknown): v is SignedRegistration => isObject(v) && isObject(v['body']) && typeof v['signature'] === 'string';

function asContext(raw: unknown): AliasesContext {
  if (!isObject(raw) || raw['ok'] !== true || !isObject(raw['adminMachine']) || typeof raw['adminMachine']['uuid'] !== 'string' || typeof raw['adminPublicKey'] !== 'string' || typeof raw['adminKeyId'] !== 'string') {
    throw unexpected('the network aliases context');
  }
  const current = raw['current'];
  if (current !== null && !(isObject(current) && isObject(current['body']) && Array.isArray(current['body']['entries']) && typeof current['signature'] === 'string')) throw unexpected('the network aliases context');
  const machines = raw['machines'];
  if (!Array.isArray(machines) || !machines.every((m) => isObject(m) && typeof m['uuid'] === 'string' && typeof m['name'] === 'string')) throw unexpected('the network aliases context');
  if (!Array.isArray(raw['revoked']) || !raw['revoked'].every((u) => typeof u === 'string')) throw unexpected('the network aliases context');
  if (!isObject(raw['localAliases']) || !Object.values(raw['localAliases']).every((u) => typeof u === 'string')) throw unexpected('the network aliases context');
  if (!Array.isArray(raw['recipients']) || !raw['recipients'].every(isRegistration)) throw unexpected('the network aliases context (the machines to inform are missing)');
  return raw as unknown as AliasesContext;
}

/** The PIN first (so it is asked before anything is shown), then the context. */
export async function loadAliasesContext(api: AllowApi): Promise<AliasesContext> {
  await api.elevate();
  return asContext(await api.get('/aliases-context'));
}

export type AliasPreview =
  | { ok: true; alias: string; entries: AliasEntry[]; /** False: the alias already points there, nothing to sign. */ changed: boolean; normalized: boolean; /** Local aliases that point elsewhere than the list after the change: the local one wins on this machine. */ conflicts: AliasConflict[] }
  | { ok: false; message: string };

/** The plan of the CLI run on the context: the list after the change, or why it is refused (cause and fix). Signs nothing. */
export function previewAliasChange(context: AliasesContext, change: AliasChange): AliasPreview {
  const plan = planAliasChange({ change, current: context.current?.body.entries ?? [], machines: context.machines, revoked: context.revoked });
  if (!plan.ok) {
    // The uuid the message may talk about (the machine of a set, the one an alias already points to) settles a prefix that several machines share.
    const known = [change.action === 'set' ? change.uuid : undefined, ...(context.current?.body.entries ?? []).map((e) => e.uuid)].filter((u): u is string => u !== undefined);
    return { ok: false, message: nameShortIds(plan.message, context.machines, known) };
  }
  // Only the alias of THIS change: another label that already clashes (a standing conflict) is not what the person is signing, and a removal ends the clash of its label.
  const conflicts =
    change.action === 'set' ? aliasConflicts(context.localAliases, Object.fromEntries(plan.entries.map((e) => [e.alias, e.uuid]))).filter((c) => c.alias === plan.alias) : [];
  return { ok: true, alias: plan.alias, entries: plan.entries, changed: plan.changed, normalized: plan.normalized, conflicts };
}

export interface AliasesResult {
  action: 'set' | 'rm';
  alias: string;
  /** The list after the change, with the name of the machine each alias points to when this machine knows it. */
  entries: Array<{ alias: string; uuid: string; name?: string }>;
  distribution: PageDistribution;
  /** Sends again what was not delivered, WITHOUT the passphrase. Present only when the delivery is `partial`. Rejects with the sentence of whoever refused. */
  retryDelivery?: () => Promise<PageDistribution>;
}

export interface AliasesHooks {
  /** The signatures are made and the key is locked: the one event that happens before the network. */
  onSigned?: () => void;
}

/** The command that sends the stored list again (it signs nothing, it asks the passphrase to seal the documents). */
export const RETRY_ALIASES_COMMAND = 'machine admin alias send';

/** The key the daemon keeps the documents of the aliases under for a retry: machine-core NETWORK_ALIASES_SUBJECT_UUID (a value import of machine-core cannot be bundled for the browser; a test keeps them equal). */
export const ALIASES_SUBJECT_UUID = '00000000-0000-4000-8000-0000000a11a5';

/**
 * Unlock the admin key with `passphrase` (once), sign the whole new list and the documents, lock the key, then post. Throws with the actionable sentence of whoever refused
 * (a change the plan refuses, wrong passphrase, another key than the pinned one, the module, the daemon: each says that nothing was installed). A delivery that fails AFTER the
 * daemon kept the list is part of the result, never a throw.
 */
export function signAndChangeAlias(api: AllowApi, context: AliasesContext, change: AliasChange, passphrase: string, now: number, hooks: AliasesHooks = {}): Promise<AliasesResult> {
  return trackSigning(() => signAndChangeAliasNow(api, context, change, passphrase, now, hooks));
}

async function signAndChangeAliasNow(api: AllowApi, context: AliasesContext, change: AliasChange, passphrase: string, now: number, hooks: AliasesHooks): Promise<AliasesResult> {
  // Refused before the key file is even read: a change no machine would accept, or that changes nothing, is never signed.
  const preview = previewAliasChange(context, change);
  if (!preview.ok) {
    throw new Error(`${preview.message}. Nothing was signed`);
  }
  const nameOf = (uuid: string): string => context.machines.find((m) => m.uuid === uuid)?.name ?? uuid;
  if (!preview.changed) {
    throw new Error(`the network alias "${preview.alias}" already points to "${nameOf((change as { uuid: string }).uuid)}": nothing to sign`);
  }
  const file = await readKeyFile(api);
  const key = await unlockAdminKey(file, passphrase, { extractable: false });
  let built: Awaited<ReturnType<typeof buildAliases>>;
  try {
    assertPinnedKey(key, context);
    built = await buildAliases({ adminPrivateKey: key.privateKey, adminPublicKey: key.publicKey, adminUuid: context.adminMachine.uuid, change, current: context.current, machines: context.machines, revoked: context.revoked, recipients: context.recipients, now });
  } finally {
    // Locked before anything goes to the network, whatever happened. The passphrase is asked again for the next change.
    key.lock();
  }
  hooks.onSigned?.();

  const answer = await api.post('/aliases', { signed: built.signed, documents: built.documents });
  if (!hasDeliveryShape(answer)) {
    throw new Error(
      `the module backend sent an unexpected answer for the network aliases (the list of machines is missing: an older module or daemon): the page and the module are not the same version. The change may already be installed on this machine: reload the Machines page and open Aliases to see the list, update the machine module (\`app-core-cli update\`), then run \`${RETRY_ALIASES_COMMAND}\` in a terminal to tell the other machines`,
    );
  }
  const retry = typeof answer['retry'] === 'string' ? answer['retry'] : RETRY_ALIASES_COMMAND;
  const said = change.action === 'set' ? `Network alias "${built.alias}" now points to "${nameOf(change.uuid)}".` : `Network alias "${built.alias}" removed.`;
  const buildNotes = built.failures.map((f) => `[error] ${f.toName} (${f.toUuid}): ${f.kind} document not built: ${f.message}`);
  const standsNote = '[warn] the network aliases stand: nothing was undone. A document could not be built in this page: only the terminal command can send it; it is safe to run again';
  const distribution = distributionOf({ failed: answer.failed, text: answer.text, machines: answer.machines, retry }, said, retry, buildNotes, standsNote);
  const entries = built.entries.map((e) => ({ alias: e.alias, uuid: e.uuid, name: context.machines.find((m) => m.uuid === e.uuid)?.name }));
  const base = { action: change.action, alias: built.alias, entries: entries.map((e) => (e.name === undefined ? { alias: e.alias, uuid: e.uuid } : { alias: e.alias, uuid: e.uuid, name: e.name })) };
  if (distribution.status !== 'partial') {
    return { ...base, distribution };
  }
  // The daemon holds what is left (in memory) and sends it again; the passphrase is not asked again.
  return { ...base, distribution, retryDelivery: async () => distributionOf(await postDeliveryRetry(api, ALIASES_SUBJECT_UUID), said, retry, [], standsNote) };
}
