import type { RevocationEntry, SignedDocument, SignedRegistration, SignedRevocation } from '@wadeck-app/machine-core';
import type { Json } from './canonical.js';
import { buildDocument, documentId, DOCUMENT_RETENTION_SECONDS, REGISTRATION_DOMAIN, signRevocation } from './documents.js';
import { keyId } from './keys.js';
import { nextNoticeRecipientsBody, sealedNoticeRecipientsDocument, signNoticeRecipients, type SignedNoticeRecipients } from './noticeRecipients.js';
import { verifyBody } from './signed.js';

// Revoke from the page (admin-ui.md, "Revoke from the page"): what `machine admin revoke` signs and sends, built in the browser with the unlocked admin key. Twin of
// machine-cli `adminRevoke.ts` (the union list, dated above the held version) and `distribute.ts` `distributeRevocation` (one revocation document per machine still
// trusted, the list of notice recipients): same ids, same dates, same list rule. The daemon of the admin machine verifies all of it against the pinned key before it
// installs or sends anything. Pure: no I/O, `now` is given.

export interface BuildRevocationInput {
  /** The unlocked, non-extractable admin signing key. */
  adminPrivateKey: CryptoKey;
  adminPublicKey: string;
  /** The machine that holds the admin key: it never revokes itself and is not a recipient (it installs the list itself). */
  adminUuid: string;
  /** The machine to revoke and the highest serial this machine holds for it (every registration up to it stops being trusted). */
  revoked: { uuid: string; serial: number };
  /** What the daemon holds now: the installed entries and the highest `issuedAt` of the lists it keeps. */
  held: { entries: RevocationEntry[]; version: number };
  /** The registrations the daemon holds for the peers that STAY trusted (neither the revoked machine nor the admin machine). Each is verified against `adminPublicKey` here. */
  recipients: SignedRegistration[];
  /** The list stored on the admin machine, or null when there is none: then `[adminUuid]` is signed. */
  noticeRecipients: SignedNoticeRecipients | null;
  /** Epoch seconds. */
  now: number;
}

export interface RevocationBuildFailure {
  toUuid: string;
  toName: string;
  kind: 'revocation' | 'notice-recipients';
  message: string;
}

export interface BuiltRevocation {
  /** The union list, signed: installed on the admin machine and carried by every revocation document. */
  signed: SignedRevocation;
  /** Sealed inbox documents: the revocation and the list of notice recipients for each peer that stays trusted. */
  documents: SignedDocument[];
  /** The list signed here because the admin machine had none: the daemon keeps it. Null when the stored list was reused. */
  noticeRecipients: SignedNoticeRecipients | null;
  /** What could not be built, per machine: the others are still built; the caller reports them with the retry command. */
  failures: RevocationBuildFailure[];
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Grow-only union, highest serial per machine, sorted by uuid: machine-core `mergeRevocations`. */
function union(...lists: RevocationEntry[][]): RevocationEntry[] {
  const highest = new Map<string, number>();
  for (const list of lists) {
    for (const { uuid, serial } of list) {
      if ((highest.get(uuid) ?? 0) < serial) highest.set(uuid, serial);
    }
  }
  return [...highest.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([uuid, serial]) => ({ uuid, serial }));
}

export async function buildRevocation(input: BuildRevocationInput): Promise<BuiltRevocation> {
  const { revoked, recipients } = input;
  if (revoked.uuid === input.adminUuid) {
    throw new Error('the machine to revoke is the admin machine itself: it cannot revoke itself from this page. Nothing was signed');
  }
  if (!Number.isSafeInteger(revoked.serial) || revoked.serial < 1) {
    throw new Error(`the serial of the machine to revoke (${String(revoked.serial)}) is not a positive integer: reload the page and revoke again. Nothing was signed`);
  }
  for (const to of recipients) {
    if (to.body.uuid === revoked.uuid) throw new Error(`the peers to inform include the revoked machine "${to.body.name}" itself: reload the page and revoke again. Nothing was signed`);
    if (to.body.uuid === input.adminUuid) throw new Error(`the peers to inform include the admin machine "${to.body.name}": it installs the list itself. Reload the page and revoke again. Nothing was signed`);
    // The daemon serves these registrations through a backend the page does not trust: a registration is used (its identity key seals the document) only when the admin key signed it.
    if (!(await verifyBody(REGISTRATION_DOMAIN, to as unknown as { body: Json; signature: string }, input.adminPublicKey))) {
      throw new Error(
        `the registration of "${to.body.name}" (${to.body.uuid}) is not signed by the admin key that was unlocked: the page was given altered data, or the key file is not the one pinned on this machine. Nothing was signed; reload the page and check \`machine admin show\``,
      );
    }
  }
  const adminKeyId = await keyId(input.adminPublicKey);
  const signed = await signRevocation(
    { v: 1, adminKeyId, issuedAt: Math.max(input.now, input.held.version + 1), entries: union(input.held.entries, [{ uuid: revoked.uuid, serial: revoked.serial }]) },
    input.adminPrivateKey,
  );

  const documents: SignedDocument[] = [];
  const failures: RevocationBuildFailure[] = [];
  const attempt = async (to: SignedRegistration, kind: RevocationBuildFailure['kind'], build: () => Promise<SignedDocument>): Promise<void> => {
    try {
      documents.push(await build());
    } catch (e) {
      failures.push({ toUuid: to.body.uuid, toName: to.body.name, kind, message: errorText(e) });
    }
  };

  for (const to of recipients) {
    await attempt(to, 'revocation', async () =>
      buildDocument(
        {
          kind: 'revocation',
          to: to.body.uuid,
          id: await documentId(`v2:revocation:${to.body.uuid}:${signed.signature}`),
          issuedAt: signed.body.issuedAt,
          expiresAt: signed.body.issuedAt + DOCUMENT_RETENTION_SECONDS,
          payload: signed as unknown as Json as never,
          recipientIdentityPublicKey: to.body.identityPublicKey,
        },
        input.adminPrivateKey,
      ),
    );
  }

  let list = input.noticeRecipients;
  let signedHere: SignedNoticeRecipients | null = null;
  if (list === null) {
    list = await signNoticeRecipients(nextNoticeRecipientsBody({ adminKeyId, now: input.now, current: null, recipients: [input.adminUuid] }), input.adminPrivateKey);
    signedHere = list;
  }
  const signedList = list;
  for (const to of recipients) {
    await attempt(to, 'notice-recipients', () => sealedNoticeRecipientsDocument(signedList, to.body.uuid, input.now, input.adminPrivateKey, to.body.identityPublicKey));
  }
  return { signed, documents, noticeRecipients: signedHere, failures };
}
