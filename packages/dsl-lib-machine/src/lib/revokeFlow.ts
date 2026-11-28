import { buildRevocation, unlockAdminKey } from '@wadeck-app/machine-webcrypto';
import type { RevocationEntry, SignedNoticeRecipients, SignedRegistration } from '@wadeck-app/machine-core';
import { assertPinnedKey, readKeyFile, trackSigning, type AllowApi } from './allowFlow.js';
import { dedupeReport, describeDelivery, type DeliveryMachine, type DeliverySummary } from './approvalResult.js';

// Revoke from the page without React (admin-ui.md, "Revoke from the page"; threat-model.md). What `machine admin revoke <machine>` does, with the admin passphrase and the
// unlocked key living ONLY in this page and for ONE revocation:
//
//   1. context  (sensitive GET, after the PIN): the machine to revoke (name, uuid, highest serial), what is installed, the registrations of the peers that stay trusted
//      and the stored list of notice recipients. A machine that cannot be revoked here (this machine, not trusted, no admin key) is refused with the fix.
//   2. sign     (passphrase): the encrypted key file is read (sensitive GET), unlocked as a NON-EXTRACTABLE key, used for the union list and the documents for the peers,
//      and LOCKED again before anything is posted. No unlock window (no adminKeyHolder): the passphrase is a parameter of `signAndRevoke` only, never stored, logged
//      or put in an error, and nothing posted can carry it.
//   3. post     (sensitive POST): the daemon verifies, installs the list on this machine, then tells the peers and removes the machine from the relay. A failed delivery
//      never undoes the revocation: it is part of the result, with the exact command that finishes the job.

/** The row of the Machines page the action starts from. */
export interface RevokeRow {
  uuid: string;
  name: string;
}

/** The answer of the daemon command `revokeContext`, served by `GET /revoke-context/:uuid`. */
export interface RevokeContext {
  ok: true;
  adminMachine: { uuid: string; name: string };
  adminPublicKey: string;
  adminKeyId: string;
  revoked: { uuid: string; name: string; serial: number; keyId: string };
  held: { entries: RevocationEntry[]; version: number };
  recipients: SignedRegistration[];
  noticeRecipients: SignedNoticeRecipients | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const unexpected = (what: string): Error =>
  new Error(`the module backend sent an unexpected answer for ${what}: the page and the module are not the same version: update the machine module (\`app-core-cli update\`) and reload the page`);

function asContext(raw: unknown): RevokeContext {
  if (!isObject(raw) || raw['ok'] !== true || !isObject(raw['adminMachine']) || typeof raw['adminMachine']['uuid'] !== 'string' || typeof raw['adminPublicKey'] !== 'string' || typeof raw['adminKeyId'] !== 'string') {
    throw unexpected('the revocation context');
  }
  const revoked = raw['revoked'];
  if (!isObject(revoked) || typeof revoked['uuid'] !== 'string' || typeof revoked['name'] !== 'string' || typeof revoked['serial'] !== 'number' || typeof revoked['keyId'] !== 'string') {
    throw unexpected('the revocation context');
  }
  const held = raw['held'];
  if (!isObject(held) || !Array.isArray(held['entries']) || typeof held['version'] !== 'number') throw unexpected('the revocation context');
  if (!Array.isArray(raw['recipients']) || !raw['recipients'].every((r) => isObject(r) && isObject(r['body']) && typeof r['signature'] === 'string') || !('noticeRecipients' in raw)) {
    throw unexpected('the revocation context (the peers to inform are missing)');
  }
  return raw as unknown as RevokeContext;
}

/** The PIN first (so it is asked before anything is shown), then the context of the machine. */
export async function loadRevokeContext(api: AllowApi, row: RevokeRow): Promise<RevokeContext> {
  await api.elevate();
  return asContext(await api.get(`/revoke-context/${encodeURIComponent(row.uuid)}`));
}

export interface RevokeDistribution extends DeliverySummary {
  /** `delivered`: every peer took its document or the relay inbox holds it. `partial`: the daemon delivered what it could and names the rest. `none`: nobody to tell. */
  status: 'delivered' | 'partial' | 'none';
  /** The raw report in the words of the CLI (the "Details"), without the lines it repeats; for `partial` it names the exact retry command. */
  text: string;
  /** One entry per peer told, plus the revoked machine when it could not be removed from the relay (empty when `none`). */
  machines: DeliveryMachine[];
}

export interface RevokeResult {
  name: string;
  distribution: RevokeDistribution;
}

export interface RevokeHooks {
  /** The signatures are made and the key is locked: the one event that happens before the network. */
  onSigned?: () => void;
}

/** `machine admin distribute <uuid>`: finishes what a failed or partial delivery left (it also removes the machine from the relay). */
const retryCommand = (uuid: string): string => `machine admin distribute ${uuid}`;

/**
 * Unlock the admin key with `passphrase` (once), sign the list and the documents for the peers, lock the key, then post. Throws with the actionable sentence of whoever
 * refused (wrong passphrase, another key than the pinned one, the module, the daemon: each says that nothing was installed). A delivery that fails AFTER the daemon
 * installed the list is part of the result, never a throw: the revocation stands.
 */
export function signAndRevoke(api: AllowApi, context: RevokeContext, passphrase: string, now: number, hooks: RevokeHooks = {}): Promise<RevokeResult> {
  return trackSigning(() => signAndRevokeNow(api, context, passphrase, now, hooks));
}

async function signAndRevokeNow(api: AllowApi, context: RevokeContext, passphrase: string, now: number, hooks: RevokeHooks): Promise<RevokeResult> {
  const { revoked } = context;
  const retry = retryCommand(revoked.uuid);
  const file = await readKeyFile(api);
  const key = await unlockAdminKey(file, passphrase, { extractable: false });
  let built: Awaited<ReturnType<typeof buildRevocation>>;
  try {
    assertPinnedKey(key, context);
    built = await buildRevocation({
      adminPrivateKey: key.privateKey,
      adminPublicKey: key.publicKey,
      adminUuid: context.adminMachine.uuid,
      revoked: { uuid: revoked.uuid, serial: revoked.serial },
      held: context.held,
      recipients: context.recipients,
      noticeRecipients: context.noticeRecipients,
      now,
    });
  } finally {
    // Locked before anything goes to the network, whatever happened. The key is never handed to a holder: the passphrase is asked again for the next revocation.
    key.lock();
  }
  hooks.onSigned?.();

  const answer = await api.post('/revoke', { uuid: revoked.uuid, signed: built.signed, documents: built.documents, noticeRecipients: built.noticeRecipients });
  if (!isObject(answer) || !isObject(answer['text']) || typeof answer['text']['out'] !== 'string' || typeof answer['text']['err'] !== 'string' || typeof answer['failed'] !== 'boolean' || !Array.isArray(answer['machines']) || !answer['machines'].every(isDeliveryMachine)) {
    throw new Error(
      `the module backend sent an unexpected answer for the revocation (the list of machines is missing: an older module or daemon): the page and the module are not the same version. "${revoked.name}" may already be revoked on this machine: reload the Machines page to see whether it is still listed, update the machine module (\`app-core-cli update\`), then run \`${retry}\` in a terminal to tell the other machines`,
    );
  }
  const machines = answer['machines'];
  const buildNotes = built.failures.map((f) => `[error] ${f.toName} (${f.toUuid}): ${f.kind} document not built: ${f.message}`);
  const lines = [
    answer['text']['out'].trimEnd(),
    ...buildNotes,
    answer['text']['err'].trimEnd(),
    ...(buildNotes.length > 0 && !answer['failed'] ? [`[warn] the revocation stands: nothing was undone. Run \`${retry}\` to send what is missing; it is safe to run again`] : []),
  ].filter((l) => l !== '');
  const text = dedupeReport(lines.join('\n'));
  const failed = answer['failed'] || buildNotes.length > 0;

  // The revoked machine is not told anything: it is in the list only when it could not be removed from the relay.
  const told = machines.filter((m) => m.uuid !== revoked.uuid);
  const notRemoved = machines.some((m) => m.uuid === revoked.uuid && m.state === 'failed');
  if (told.length === 0 && !failed && !notRemoved) {
    return { name: revoked.name, distribution: { status: 'none', text, machines, headline: 'No other machine to tell.', tone: 'success', waiting: 0 } };
  }
  if (told.length === 0) {
    return { name: revoked.name, distribution: { status: 'partial', text, machines, headline: `"${revoked.name}" was not removed from the relay. Run \`${retry}\`.`, tone: 'warning', waiting: 0 } };
  }
  const status = failed ? 'partial' : 'delivered';
  const summary = describeDelivery(status, told, retry);
  const headline = notRemoved ? `${summary.headline} "${revoked.name}" was not removed from the relay.` : summary.headline;
  return { name: revoked.name, distribution: { status, text, machines, headline, tone: notRemoved && summary.tone === 'success' ? 'warning' : summary.tone, waiting: summary.waiting } };
}

function isDeliveryMachine(value: unknown): value is DeliveryMachine {
  return (
    isObject(value) &&
    typeof value['uuid'] === 'string' &&
    typeof value['name'] === 'string' &&
    (value['state'] === 'delivered' || value['state'] === 'inbox' || value['state'] === 'failed') &&
    typeof value['code'] === 'string' &&
    typeof value['reason'] === 'string' &&
    typeof value['next'] === 'string'
  );
}
