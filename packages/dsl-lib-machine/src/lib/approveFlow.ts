import { buildApproval, buildDistribution, unlockAdminKey } from '@wadeck-app/machine-webcrypto';
import type { SignedNoticeRecipients, SignedRegistration } from '@wadeck-app/machine-core';
import { assertPinnedKey, readKeyFile, trackSigning, type AllowApi } from './allowFlow.js';
import { proveCandidacy } from './candidacyProof.js';

// Approve from the page without React (admin-ui.md, "Approve from the page"; threat-model.md). What `machine admin approve <id>` does, with the admin
// passphrase and the unlocked key living ONLY in this page and for ONE approval:
//
//   1. context  (sensitive GET, after the PIN): the admin machine, the pinned admin key, whether the candidate is already trusted, the registrations of the
//      other peers and the stored list of notice recipients.
//   2. checks   (no secret): the candidacy code recomputed from the key and random as received (T-05, rule 5), the problems the list reported, a key change
//      the daemon would refuse. Everything that can be refused is refused BEFORE the passphrase is asked.
//   3. sign     (passphrase): the encrypted key file is read (sensitive GET), unlocked as a NON-EXTRACTABLE key, used for the approval, the import for the
//      admin machine and the documents for the other peers, and LOCKED again before anything is posted. No unlock window (no adminKeyHolder): the
//      passphrase is a parameter of `signAndApprove` only, never stored, logged or put in an error, and nothing posted can carry it.
//   4. post     (sensitive POST): the approval and the import, then, once the relay holds the approval, the documents for the other peers. A failed delivery
//      never undoes the approval: it is reported with the exact command that finishes the job.

const MODULE_API = '/candidacies';

/** One row of the Candidacies list, as the module backend answers it (only what the approval reads). */
export type ApproveRow = {
  id: string;
  name: string;
  hostname: string;
  uuid: string | undefined;
  observedIp: string;
  identityPublicKey: string | undefined;
  random: string | undefined;
  /** The candidacy code the backend recomputed: only cross-checked here, never shown. */
  code: string | undefined;
  /** Approving replaces a uuid binding to ANOTHER token at the relay. */
  rebind: boolean;
  boundTokenLabel?: string | undefined;
  bindingNote?: string | undefined;
  /** Why this candidacy must not be approved (it can still be rejected). */
  problems: string[];
};

/** The answer of the daemon command `approveContext`, served by `GET /approve-context/:uuid`. */
export interface ApproveContext {
  ok: true;
  adminMachine: { uuid: string; name: string; identityPublicKey: string };
  adminPublicKey: string;
  adminKeyId: string;
  candidate: { trusted: boolean; name?: string; identityPublicKey?: string; revokedSerial?: number };
  others: SignedRegistration[];
  noticeRecipients: SignedNoticeRecipients | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const unexpected = (what: string): Error =>
  new Error(`the module backend sent an unexpected answer for ${what}: the page and the module are not the same version: update the machine module (\`app-core-cli update\`) and reload the page`);

function asContext(raw: unknown): ApproveContext {
  if (!isObject(raw) || raw['ok'] !== true || !isObject(raw['adminMachine']) || typeof raw['adminMachine']['uuid'] !== 'string' || typeof raw['adminMachine']['name'] !== 'string' || typeof raw['adminMachine']['identityPublicKey'] !== 'string') {
    throw unexpected('the approval context');
  }
  if (typeof raw['adminPublicKey'] !== 'string' || typeof raw['adminKeyId'] !== 'string' || !isObject(raw['candidate']) || typeof raw['candidate']['trusted'] !== 'boolean') {
    throw unexpected('the approval context');
  }
  // `others` and `noticeRecipients` came with the distribution of lot 5: an older backend or daemon does not send them, and without them the other peers would never be told.
  if (!Array.isArray(raw['others']) || !raw['others'].every((r) => isObject(r) && isObject(r['body']) && typeof r['signature'] === 'string') || !('noticeRecipients' in raw)) {
    throw unexpected('the approval context (the peers to inform are missing: an older module or daemon would leave them uninformed)');
  }
  return raw as unknown as ApproveContext;
}

/** The PIN first (so it is asked before anything is shown), then the context of the candidate. */
export async function loadApproveContext(api: AllowApi, row: ApproveRow): Promise<ApproveContext> {
  if (row.uuid === undefined) {
    throw new Error('this candidacy carries no uuid (the list says why): it cannot be approved from the page. Reject it, and ask the candidate to run `machine join --resume`');
  }
  await api.elevate();
  return asContext(await api.get(`/approve-context/${encodeURIComponent(row.uuid)}`));
}

export interface Approvable {
  /** The security code, recomputed here from the keys held here: shown for the human to compare with the candidate screen. */
  finalCode: string;
  /** What the person must know before signing (a machine revoked earlier, a rebind of the relay binding). */
  warnings: string[];
  /** The machines that will be told about the new one (the other trusted peers). */
  peersToInform: Array<{ uuid: string; name: string }>;
  /** The candidate is the admin machine itself (the first machine of a network). */
  selfApproval: boolean;
}

/** Everything that needs no passphrase and can stop the approval. Throws a sentence naming the problem and the way out. */
export async function checkApprovable(row: ApproveRow, context: ApproveContext): Promise<Approvable> {
  if (row.problems.length > 0) {
    throw new Error(`this candidacy cannot be approved: ${row.problems.join('; ')}. Reject it, and ask the candidate to run \`machine join --resume\``);
  }
  if (row.uuid === undefined) {
    throw new Error('this candidacy carries no uuid (the list says why): it cannot be approved from the page. Reject it, and ask the candidate to run `machine join --resume`');
  }
  // T-05: the codes are recomputed HERE from the key and random as received; a mismatch with the list means the answer was altered on its way to the page.
  const proof = await proveCandidacy({ identityPublicKey: row.identityPublicKey, random: row.random, listedCode: row.code, adminPublicKey: context.adminPublicKey });
  const selfApproval = context.adminMachine.uuid === row.uuid;
  if (context.candidate.trusted && context.candidate.identityPublicKey !== undefined && context.candidate.identityPublicKey !== row.identityPublicKey) {
    throw new Error(
      `"${context.candidate.name ?? row.name}" (${row.uuid}) is already trusted on this machine with another identity key, and this candidacy carries a different one: replacing a key needs the relay's binding information. Nothing was signed; run \`machine admin approve ${row.id}\` in a terminal, or reject the candidacy and revoke the old machine (\`machine admin revoke ${context.candidate.name ?? row.name}\`) first`,
    );
  }
  if (selfApproval && context.others.length > 0) {
    throw new Error(
      `this is the admin machine renewing its own registration, and ${context.others.length} other machine(s) must be told about the new one: the page does not do that yet. Nothing was signed; run \`machine admin approve ${row.id}\` in a terminal`,
    );
  }
  const warnings: string[] = [];
  if (context.candidate.revokedSerial !== undefined) {
    warnings.push(`This machine was REVOKED here earlier (serial ${context.candidate.revokedSerial}): approving it enrolls it again.`);
  }
  if (row.rebind) {
    const which = row.boundTokenLabel !== undefined ? `the token labelled "${row.boundTokenLabel}"` : 'another token (the relay did not say which)';
    warnings.push(`The relay says this uuid is already bound to ${which}: approving replaces that binding.${row.bindingNote !== undefined ? ` Note: ${row.bindingNote}.` : ''}`);
  }
  return { finalCode: proof.finalCode, warnings, peersToInform: context.others.map((r) => ({ uuid: r.body.uuid, name: r.body.name })), selfApproval };
}

export interface ApproveDistribution {
  /** `delivered`: every machine took its document (or already had it). `partial`: the daemon delivered what it could and names the rest. `failed`: nothing was delivered. `none`: nobody to inform. */
  status: 'delivered' | 'partial' | 'failed' | 'none';
  /** What to tell the person, in the words of the CLI; for `partial` and `failed` it names the exact retry command. */
  text: string;
}

export interface ApproveResult {
  /** The security code computed in this page: to compare with the one the candidate shows. */
  finalCode: string;
  message: string;
  distribution: ApproveDistribution;
}

export interface ApproveHooks {
  /** The signatures are made and the key is locked: the one event that happens before the network. */
  onSigned?: () => void;
  /** The relay holds the approval (the decision went through). */
  onApproved?: () => void;
}

const VALID_FOR_DAYS = 365;

/** `machine admin distribute <uuid>`: finishes what a failed or partial delivery left. */
const retryCommand = (uuid: string): string => `machine admin distribute ${uuid}`;

/**
 * Unlock the admin key with `passphrase` (once), sign the approval, the import for the admin machine and the documents for the other peers, lock the key, then post.
 * Throws with the actionable sentence of whoever refused (wrong passphrase, another key than the pinned one, the backend, the relay), before or at the approval; a
 * failure of the delivery AFTER the approval is part of the result, never a throw: the approval stands.
 */
export function signAndApprove(api: AllowApi, context: ApproveContext, row: ApproveRow, passphrase: string, now: number, hooks: ApproveHooks = {}): Promise<ApproveResult> {
  return trackSigning(() => signAndApproveNow(api, context, row, passphrase, now, hooks));
}

async function signAndApproveNow(api: AllowApi, context: ApproveContext, row: ApproveRow, passphrase: string, now: number, hooks: ApproveHooks): Promise<ApproveResult> {
  const checked = await checkApprovable(row, context);
  // `checkApprovable` proved these are present; the types do not know it.
  const uuid = row.uuid as string;
  const identityPublicKey = row.identityPublicKey as string;
  const random = row.random as string;

  const file = await readKeyFile(api);
  const key = await unlockAdminKey(file, passphrase, { extractable: false });
  let built: Awaited<ReturnType<typeof buildApproval>>;
  let documents: Awaited<ReturnType<typeof buildDistribution>> | undefined;
  try {
    assertPinnedKey(key, context);
    built = await buildApproval({
      adminPrivateKey: key.privateKey,
      adminPublicKey: key.publicKey,
      adminKeyId: key.keyId,
      candidate: { uuid, name: row.name, identityPublicKey, random },
      adminMachine: context.adminMachine,
      now,
      validForDays: VALID_FOR_DAYS,
    });
    // Two paths to the same code (the proof of the checks, the builder): a difference is a bug or an alteration, never shown as a code to compare.
    if (built.finalCode !== checked.finalCode) {
      throw new Error('the security code computed while signing differs from the one computed before: nothing was sent. Reload the page; if it persists, reject this candidacy');
    }
    if (!checked.selfApproval) {
      documents = await buildDistribution({
        adminPrivateKey: key.privateKey,
        adminPublicKey: key.publicKey,
        adminUuid: context.adminMachine.uuid,
        subject: built.registrations.candidate,
        others: context.others,
        noticeRecipients: context.noticeRecipients,
        now,
      });
    }
  } finally {
    // Locked before anything goes to the network, whatever happened. The key is never handed to a holder: the passphrase is asked again for the next approval.
    key.lock();
  }
  hooks.onSigned?.();

  const approved = await api.post(`${MODULE_API}/${encodeURIComponent(row.id)}/approve`, { approval: built.approval, adminImport: built.adminImport });
  const message = isObject(approved) && typeof approved['message'] === 'string' ? approved['message'] : 'Candidacy approved';
  hooks.onApproved?.();

  if (documents === undefined) {
    return { finalCode: built.finalCode, message, distribution: { status: 'none', text: 'No other machine to inform: this is the first machine of the network.' } };
  }
  const buildNotes = documents.failures.map((f) => `[error] ${f.toName} (${f.toUuid}): ${f.kind} document not built: ${f.message}`);
  const retry = retryCommand(uuid);
  try {
    const answer = await api.post('/approve-distribute', { candidateUuid: uuid, documents: documents.documents, noticeRecipients: documents.noticeRecipients });
    if (!isObject(answer) || !isObject(answer['text']) || typeof answer['text']['out'] !== 'string' || typeof answer['text']['err'] !== 'string' || typeof answer['failed'] !== 'boolean') {
      throw unexpected('the delivery of the documents');
    }
    const out = answer['text']['out'];
    const err = answer['text']['err'];
    const failed = answer['failed'] || buildNotes.length > 0;
    const lines = [out.trimEnd(), ...buildNotes, err.trimEnd(), ...(buildNotes.length > 0 && !answer['failed'] ? [`[warn] the approval stands: nothing was undone. Run \`${retry}\` to send what is missing; it is safe to run again`] : [])].filter((l) => l !== '');
    return { finalCode: built.finalCode, message, distribution: { status: failed ? 'partial' : 'delivered', text: lines.join('\n') } };
  } catch (e) {
    return {
      finalCode: built.finalCode,
      message,
      distribution: {
        status: 'failed',
        text: `[error] the other machines were NOT told about "${row.name}": ${(e as Error).message}\n[warn] the approval stands: nothing was undone. Run \`${retry}\` on this machine to tell them; it is safe to run again`,
      },
    };
  }
}
