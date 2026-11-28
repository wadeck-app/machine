import { buildRename, buildRenamedRegistration, normalizeMachineName, unlockAdminKey } from '@wadeck-app/machine-webcrypto';
import type { SignedNoticeRecipients, SignedRegistration } from '@wadeck-app/machine-core';
import { assertPinnedKey, readKeyFile, trackSigning, type AllowApi } from './allowFlow.js';
import { postDeliveryRetry } from './deliveryRetry.js';
import { nameShortIds } from './machineIds.js';
import { distributionOf, hasDeliveryShape, isObject, type PageDistribution } from './pageDelivery.js';

// Rename from the page without React (admin-ui.md, "Rename and aliases from the page"; threat-model.md). What `machine admin rename <machine> <new-name>` does, with the admin
// passphrase and the unlocked key living ONLY in this page and for ONE rename:
//
//   1. context  (sensitive GET, after the PIN): the registration this machine trusts for the machine, the names and aliases that must not collide, the registrations of the
//      other peers and the stored list of notice recipients. A machine that cannot be renamed here (revoked, not trusted, the admin machine) is refused with the fix.
//   2. preview  (no key): the new name is checked live by the same rules as the CLI, so a name that would be refused is said before the passphrase is asked.
//   3. sign     (passphrase): the key file is read (sensitive GET), unlocked as a NON-EXTRACTABLE key, used for the re-issued registration and the documents (the other peers,
//      the renamed machine itself), and LOCKED again before anything is posted. No unlock window: the passphrase is a parameter of `signAndRename` only.
//   4. post     (sensitive POST): the daemon verifies against the pinned key, trusts the new registration, then delivers. A failed delivery never undoes the rename.

/** The row of the Machines page the action starts from. */
export interface RenameRow {
  uuid: string;
  name: string;
}

/** The answer of the daemon command `renameContext`, served by `GET /rename-context/:uuid`. */
export interface RenameContext {
  ok: true;
  adminMachine: { uuid: string; name: string };
  adminPublicKey: string;
  adminKeyId: string;
  machine: { uuid: string; name: string; serial: number; keyId: string };
  /** The registration this machine trusts for the machine now (its identity key, its expiry). */
  current: SignedRegistration;
  /** Every machine whose name is taken: the trusted peers AND the admin machine, the renamed one included. */
  machines: Array<{ uuid: string; name: string }>;
  /** Local aliases of the admin machine, alias to uuid. */
  aliases: Record<string, string>;
  /** Network aliases, alias to uuid. */
  networkAliases: Record<string, string>;
  /** The highest serial of the machine covered by an installed revocation, or null. */
  revokedUpTo: number | null;
  /** The registrations of the peers that are neither the machine nor the admin machine. */
  others: SignedRegistration[];
  noticeRecipients: SignedNoticeRecipients | null;
}

const unexpected = (what: string): Error =>
  new Error(`the module backend sent an unexpected answer for ${what}: the page and the module are not the same version: update the machine module (\`app-core-cli update\`) and reload the page`);

const isRegistration = (v: unknown): v is SignedRegistration => isObject(v) && isObject(v['body']) && typeof v['signature'] === 'string';
const isNames = (v: unknown): v is Array<{ uuid: string; name: string }> => Array.isArray(v) && v.every((m) => isObject(m) && typeof m['uuid'] === 'string' && typeof m['name'] === 'string');
const isMap = (v: unknown): v is Record<string, string> => isObject(v) && Object.values(v).every((x) => typeof x === 'string');

function asContext(raw: unknown): RenameContext {
  if (!isObject(raw) || raw['ok'] !== true || !isObject(raw['adminMachine']) || typeof raw['adminMachine']['uuid'] !== 'string' || typeof raw['adminPublicKey'] !== 'string' || typeof raw['adminKeyId'] !== 'string') {
    throw unexpected('the rename context');
  }
  const machine = raw['machine'];
  if (!isObject(machine) || typeof machine['uuid'] !== 'string' || typeof machine['name'] !== 'string' || typeof machine['serial'] !== 'number' || typeof machine['keyId'] !== 'string') {
    throw unexpected('the rename context');
  }
  if (!isRegistration(raw['current']) || !isNames(raw['machines']) || !isMap(raw['aliases']) || !isMap(raw['networkAliases'])) throw unexpected('the rename context');
  if (raw['revokedUpTo'] !== null && typeof raw['revokedUpTo'] !== 'number') throw unexpected('the rename context');
  if (!Array.isArray(raw['others']) || !raw['others'].every(isRegistration) || !('noticeRecipients' in raw)) throw unexpected('the rename context (the peers to inform are missing)');
  return raw as unknown as RenameContext;
}

/** The PIN first (so it is asked before anything is shown), then the context of the machine. */
export async function loadRenameContext(api: AllowApi, row: RenameRow): Promise<RenameContext> {
  await api.elevate();
  return asContext(await api.get(`/rename-context/${encodeURIComponent(row.uuid)}`));
}

export type RenamePreview =
  | {
      ok: true;
      name: string;
      /** The typed name was not valid as typed and was made valid. */
      normalized: boolean;
      /** The typed name was longer than the 32 characters a name may have: the end was cut (the dialog says so, it never cuts silently). */
      capped: boolean;
      /** The serial the new registration takes. */
      serial: number;
    }
  | { ok: false; /** Empty when nothing is typed yet: the dialog shows no message then. */ message: string };

/** The longest name a machine may have (machine-core `machineNameProblem`). */
export const MAX_NAME_LENGTH = 32;

/**
 * True when making `typed` a valid name cut its end at 32 characters. The steps are those of `normalizeMachineName` before its cut (machine-webcrypto reference.ts: accents
 * removed, lowercase, every other run a single hyphen, hyphens trimmed); a test keeps the two in step.
 */
function isCapped(typed: string): boolean {
  const full = typed
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return full.length > MAX_NAME_LENGTH;
}

/**
 * What the core says about a refused name, as a dialog shows it: a machine the core still names only by a uuid prefix is named by its name. The remove command
 * is worded by the core itself (`machine alias rm`, `machine admin alias rm`): nothing is rewritten here.
 */
function wordedForDialog(context: RenameContext, message: string, typed: string): string {
  const known = [context.aliases[typed], context.networkAliases[typed]].filter((u): u is string => u !== undefined);
  return nameShortIds(message, context.machines, known);
}

/** The plan the CLI makes (`buildRenamedRegistration`), run on the context: what the new name will be, or why it is refused (cause and fix). Signs nothing. */
export function previewRename(context: RenameContext, typed: string, now: number): RenamePreview {
  if (typed.trim() === '') {
    return { ok: false, message: '' };
  }
  const normalized = normalizeMachineName(typed);
  if (!normalized.ok) {
    return { ok: false, message: `invalid new name ${JSON.stringify(typed)}: it has no letter or digit to build a machine name from. Use letters, digits and hyphens, for example: mac-m2` };
  }
  const planned = buildRenamedRegistration({
    uuid: context.machine.uuid,
    current: context.current.body,
    newName: normalized.name,
    machines: context.machines,
    aliases: context.aliases,
    networkAliases: context.networkAliases,
    revokedUpTo: context.revokedUpTo ?? undefined,
    now,
  });
  if (!planned.ok) {
    return { ok: false, message: wordedForDialog(context, planned.message, normalized.name) };
  }
  return { ok: true, name: normalized.name, normalized: normalized.changed, capped: isCapped(typed), serial: planned.body.serial };
}

export interface RenameResult {
  oldName: string;
  newName: string;
  distribution: PageDistribution;
  /**
   * Sends again what was not delivered, WITHOUT the passphrase (nothing is signed again; the rename stands). Present only when the delivery is `partial`. Rejects with the
   * sentence of whoever refused (the daemon holds nothing to retry any more, no admin relay token ...).
   */
  retryDelivery?: () => Promise<PageDistribution>;
}

export interface RenameHooks {
  /** The signatures are made and the key is locked: the one event that happens before the network. */
  onSigned?: () => void;
}

/** One clause for the terminal command of a rename, whose same name twice looks like a mistake: it is the CLI's own form to send the documents again (UX review 5). */
export const RETRY_SAME_NAME_NOTE = 'Giving the same name twice is how `machine admin rename` sends the documents again; nothing is renamed.';

/** The command that sends the documents of a rename again (same name twice: nothing to change, only to send). */
const retryCommand = (name: string): string => `machine admin rename ${name} ${name}`;

/**
 * Unlock the admin key with `passphrase` (once), sign the new registration and the documents, lock the key, then post. Throws with the actionable sentence of whoever
 * refused (a name the plan refuses, wrong passphrase, another key than the pinned one, the module, the daemon: each says that nothing was installed). A delivery that fails
 * AFTER the daemon installed the registration is part of the result, never a throw: the rename stands.
 */
export function signAndRename(api: AllowApi, context: RenameContext, typedName: string, passphrase: string, now: number, hooks: RenameHooks = {}): Promise<RenameResult> {
  return trackSigning(() => signAndRenameNow(api, context, typedName, passphrase, now, hooks));
}

async function signAndRenameNow(api: AllowApi, context: RenameContext, typedName: string, passphrase: string, now: number, hooks: RenameHooks): Promise<RenameResult> {
  // Refused before the key file is even read: a name no machine would accept is never signed.
  const preview = previewRename(context, typedName, now);
  if (!preview.ok) {
    throw new Error(`${preview.message === '' ? 'no new name was typed' : preview.message}. Nothing was signed`);
  }
  const { machine } = context;
  const oldName = machine.name;
  const newName = preview.name;
  const retry = retryCommand(newName);
  const file = await readKeyFile(api);
  const key = await unlockAdminKey(file, passphrase, { extractable: false });
  let built: Awaited<ReturnType<typeof buildRename>>;
  try {
    assertPinnedKey(key, context);
    built = await buildRename({
      adminPrivateKey: key.privateKey,
      adminPublicKey: key.publicKey,
      adminUuid: context.adminMachine.uuid,
      current: context.current,
      newName: typedName,
      machines: context.machines,
      aliases: context.aliases,
      networkAliases: context.networkAliases,
      revokedUpTo: context.revokedUpTo ?? undefined,
      others: context.others,
      noticeRecipients: context.noticeRecipients,
      now,
    });
  } finally {
    // Locked before anything goes to the network, whatever happened. The key is never handed to a holder: the passphrase is asked again for the next action.
    key.lock();
  }
  hooks.onSigned?.();

  const answer = await api.post('/rename', { uuid: machine.uuid, signed: built.signed, documents: built.documents, noticeRecipients: built.noticeRecipients });
  if (!hasDeliveryShape(answer)) {
    throw new Error(
      `the module backend sent an unexpected answer for the rename (the list of machines is missing: an older module or daemon): the page and the module are not the same version. "${oldName}" may already be named "${newName}" on this machine: reload the Machines page to see its name, update the machine module (\`app-core-cli update\`), then run \`${retry}\` in a terminal to tell the other machines`,
    );
  }
  const said = `"${oldName}" is now "${newName}".`;
  const buildNotes = built.failures.map((f) => `[error] ${f.toName} (${f.toUuid}): ${f.kind} document not built: ${f.message}`);
  const standsNote = '[warn] the rename stands: nothing was undone. A document could not be built in this page: only the terminal command can send it; it is safe to run again';
  const distribution = distributionOf({ failed: answer.failed, text: answer.text, machines: answer.machines, retry: typeof answer['retry'] === 'string' ? answer['retry'] : retry }, said, retry, buildNotes, standsNote);
  if (distribution.status !== 'partial') {
    return { oldName, newName, distribution };
  }
  // The daemon holds what is left (in memory) and sends it again; the passphrase is not asked again.
  return { oldName, newName, distribution, retryDelivery: async () => distributionOf(await postDeliveryRetry(api, machine.uuid), said, retry, [], standsNote) };
}
