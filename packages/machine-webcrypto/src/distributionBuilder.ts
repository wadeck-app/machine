import type { SignedDocument, SignedRegistration } from '@wadeck-app/machine-core';
import { decodeBase64urlStrict } from './base64url.js';
import type { Json } from './canonical.js';
import { buildDocument, documentId, DOCUMENT_RETENTION_SECONDS, pairSecretDocumentContext, REGISTRATION_DOMAIN } from './documents.js';
import { keyId } from './keys.js';
import { nextNoticeRecipientsBody, sealedNoticeRecipientsDocument, signNoticeRecipients, type SignedNoticeRecipients } from './noticeRecipients.js';
import { derivePairSecretFromSignature } from './pairSecret.js';
import { sealTo } from './seal.js';
import { verifyBody } from './signed.js';

// Approve from the page, lot 5 (admin-ui.md): after the approval, the other peers learn the new machine and the new machine learns them. Built in the browser
// with the SAME unlocked key as the approval (one passphrase), delivered by the daemon of the admin machine, which verifies every document against the pinned
// admin key and the ids it derives itself. Twin of machine-cli `distribute.ts` (`distributeMachine`, `peerDocument`, `sendNoticeRecipients`): same ids, same
// dates, same pair secret (V2, D27), same list of notice recipients rule. Pure: no I/O, `now` is given.

export interface BuildDistributionInput {
  /** The unlocked, non-extractable admin signing key. */
  adminPrivateKey: CryptoKey;
  adminPublicKey: string;
  /** The machine that holds the admin key (bound into the seal context of the pair secrets, and the default notice recipient). */
  adminUuid: string;
  /** The registration of the new machine signed by `buildApproval` (the same one the admin machine imports). */
  subject: SignedRegistration;
  /** The registrations the admin machine holds for its OTHER trusted peers (neither the new machine nor the admin machine). Each is verified against `adminPublicKey` here. */
  others: SignedRegistration[];
  /** The list stored on the admin machine, or null when there is none: then `[adminUuid]` is signed. */
  noticeRecipients: SignedNoticeRecipients | null;
  /** Epoch seconds. */
  now: number;
}

export interface DistributionBuildFailure {
  toUuid: string;
  toName: string;
  kind: 'peer' | 'notice-recipients';
  message: string;
}

export interface BuiltDistribution {
  /** Sealed inbox documents: peer documents (both directions) and the list of notice recipients for each machine reached. */
  documents: SignedDocument[];
  /** The list signed here because the admin machine had none: the daemon keeps it (replace-newer). Null when the stored list was reused. */
  noticeRecipients: SignedNoticeRecipients | null;
  /** What could not be built, per machine: the others are still built; the caller reports them with the retry command. */
  failures: DistributionBuildFailure[];
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function peerDocument(input: BuildDistributionInput, to: SignedRegistration, about: SignedRegistration, secret: string): Promise<SignedDocument> {
  // From the two registrations only: a retry builds the same dates.
  const issuedAt = Math.max(to.body.validFrom, about.body.validFrom);
  const expiresAt = Math.min(issuedAt + DOCUMENT_RETENTION_SECONDS, to.body.validTo, about.body.validTo);
  if (expiresAt <= input.now) {
    throw new Error(`the registration of "${to.body.name}" or of "${about.body.name}" is older than the 30 days the relay keeps a document, or has expired: approve the machine again (or \`machine admin register\`) instead of distributing it`);
  }
  const sealedPairSecret = await sealTo(to.body.identityPublicKey, decodeBase64urlStrict(secret, 32, 'pair secret'), pairSecretDocumentContext(input.adminUuid, to.body.uuid, about.body.uuid));
  return buildDocument(
    {
      kind: 'peer',
      to: to.body.uuid,
      id: await documentId(`v2:peer:${to.body.uuid}:${to.body.serial}:${about.body.uuid}:${about.body.serial}`),
      issuedAt,
      expiresAt,
      payload: { registration: about, sealedPairSecret, adminUuid: input.adminUuid } as unknown as Json as never,
      recipientIdentityPublicKey: to.body.identityPublicKey,
    },
    input.adminPrivateKey,
  );
}

export async function buildDistribution(input: BuildDistributionInput): Promise<BuiltDistribution> {
  const { subject, others } = input;
  if (subject.body.uuid === input.adminUuid) {
    throw new Error('the new machine is the admin machine itself: it has no other machine to be told about. Nothing was signed');
  }
  for (const other of others) {
    if (other.body.uuid === subject.body.uuid) throw new Error(`the peers to inform include the new machine "${other.body.name}" itself: reload the page and approve again. Nothing was signed`);
    if (other.body.uuid === input.adminUuid) throw new Error(`the peers to inform include the admin machine "${other.body.name}": it learns the new machine from the import, not from a document. Reload the page and approve again. Nothing was signed`);
    // The daemon serves these registrations through a backend the page does not trust: a registration is used (its identity key seals the pair secret) only when the admin key signed it.
    if (!(await verifyBody(REGISTRATION_DOMAIN, other as unknown as { body: Json; signature: string }, input.adminPublicKey))) {
      throw new Error(
        `the registration of "${other.body.name}" (${other.body.uuid}) is not signed by the admin key that was unlocked: the page was given altered data, or the key file is not the one pinned on this machine. Nothing was signed; reload the page and check \`machine admin show\``,
      );
    }
  }
  const adminKeyId = await keyId(input.adminPublicKey);
  const documents: SignedDocument[] = [];
  const failures: DistributionBuildFailure[] = [];
  const attempt = async (to: SignedRegistration, kind: DistributionBuildFailure['kind'], build: () => Promise<SignedDocument>): Promise<void> => {
    try {
      documents.push(await build());
    } catch (e) {
      failures.push({ toUuid: to.body.uuid, toName: to.body.name, kind, message: errorText(e) });
    }
  };

  for (const other of others) {
    const secret = await derivePairSecretFromSignature(input.adminPrivateKey, { uuid: subject.body.uuid, serial: subject.body.serial }, { uuid: other.body.uuid, serial: other.body.serial });
    // About the new machine, to the old one; then about the old one, to the new machine.
    await attempt(other, 'peer', () => peerDocument(input, other, subject, secret));
    await attempt(subject, 'peer', () => peerDocument(input, subject, other, secret));
  }

  let list = input.noticeRecipients;
  let signedHere: SignedNoticeRecipients | null = null;
  if (list === null) {
    list = await signNoticeRecipients(nextNoticeRecipientsBody({ adminKeyId, now: input.now, current: null, recipients: [input.adminUuid] }), input.adminPrivateKey);
    signedHere = list;
  }
  const signedList = list;
  for (const target of [subject, ...others]) {
    await attempt(target, 'notice-recipients', () => sealedNoticeRecipientsDocument(signedList, target.body.uuid, input.now, input.adminPrivateKey, target.body.identityPublicKey));
  }
  return { documents, noticeRecipients: signedHere, failures };
}
