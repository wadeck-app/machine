import type { SignedDocument, SignedRegistration } from '@wadeck-app/machine-core';
import type { Json } from './canonical.js';
import { buildDistribution, type DistributionBuildFailure } from './distributionBuilder.js';
import { buildDocument, documentId, DOCUMENT_RETENTION_SECONDS, REGISTRATION_DOMAIN, signRegistration } from './documents.js';
import type { SignedNoticeRecipients } from './noticeRecipients.js';
import { normalizeMachineName, type MachineEntry } from './reference.js';
import { buildRenamedRegistration } from './renameRegistration.js';
import { verifyBody } from './signed.js';

// Rename from the page (decision 114; admin-ui.md, "Rename and aliases from the page"): what `machine admin rename <machine> <new-name>` signs and sends, built in the
// browser with the unlocked admin key. Twin of machine-cli `adminRename.ts` (the plan, the re-issued registration) and `distribute.ts` `distributeRename` (the peer
// documents of `distributeMachine`, then the `self-registration` document of the renamed machine): same ids, same dates. The daemon of the admin machine verifies all of it
// against the pinned key before it installs or sends anything. Pure: no I/O, `now` is given.

export interface BuildRenameInput {
  /** The unlocked, non-extractable admin signing key. */
  adminPrivateKey: CryptoKey;
  adminPublicKey: string;
  /** The machine that holds the admin key: it cannot be renamed from here and is not a recipient (it installs the registration itself). */
  adminUuid: string;
  /** The registration the admin machine holds and trusts for the machine to rename (verified against `adminPublicKey` here). */
  current: SignedRegistration;
  /** The new name as typed: normalized here like the CLI (`normalized` says whether it changed). */
  newName: string;
  /** Every machine whose name is taken: the trusted peers AND the admin machine, the renamed machine included. */
  machines: readonly MachineEntry[];
  /** Local aliases of the admin machine (alias to uuid) and the network aliases in force. */
  aliases: Readonly<Record<string, string>>;
  networkAliases: Readonly<Record<string, string>>;
  /** The highest serial of the machine covered by an installed revocation, or undefined. */
  revokedUpTo: number | undefined;
  /** The registrations the admin machine holds for the OTHER trusted peers (neither the renamed machine nor the admin machine). Each is verified against `adminPublicKey` here. */
  others: SignedRegistration[];
  /** The list stored on the admin machine, or null when there is none: then `[adminUuid]` is signed. */
  noticeRecipients: SignedNoticeRecipients | null;
  /** Epoch seconds. */
  now: number;
}

export interface RenameBuildFailure {
  toUuid: string;
  toName: string;
  kind: DistributionBuildFailure['kind'] | 'self-registration';
  message: string;
}

export interface BuiltRename {
  /** The re-issued registration, signed: installed on the admin machine and carried by every document. */
  signed: SignedRegistration;
  /** The name that was signed (the typed one, normalized). */
  newName: string;
  /** The typed name was not valid as typed and was made valid. */
  normalized: boolean;
  /** Sealed inbox documents: peer documents (both directions), the list of notice recipients and the `self-registration` of the renamed machine. */
  documents: SignedDocument[];
  /** The list signed here because the admin machine had none: the daemon keeps it. Null when the stored list was reused. */
  noticeRecipients: SignedNoticeRecipients | null;
  /** What could not be built, per machine: the others are still built; the caller reports them with the retry command. */
  failures: RenameBuildFailure[];
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function assertSignedByAdmin(registration: SignedRegistration, adminPublicKey: string): Promise<void> {
  // The daemon serves these registrations through a backend the page does not trust: a registration is used (its identity key seals a document) only when the admin key signed it.
  if (!(await verifyBody(REGISTRATION_DOMAIN, registration as unknown as { body: Json; signature: string }, adminPublicKey))) {
    throw new Error(
      `the registration of "${registration.body.name}" (${registration.body.uuid}) is not signed by the admin key that was unlocked: the page was given altered data, or the key file is not the one pinned on this machine. Nothing was signed; reload the page and check \`machine admin show\``,
    );
  }
}

export async function buildRename(input: BuildRenameInput): Promise<BuiltRename> {
  const { current } = input;
  if (current.body.uuid === input.adminUuid) {
    throw new Error(
      `"${current.body.name}" is the admin machine itself: renaming it is not supported from this page (its peers would need a renewed registration of the admin machine). Rename the other machines. Nothing was signed`,
    );
  }
  await assertSignedByAdmin(current, input.adminPublicKey);
  for (const other of input.others) {
    if (other.body.uuid === current.body.uuid) throw new Error(`the peers to inform include the renamed machine "${other.body.name}" itself: reload the page and rename again. Nothing was signed`);
    if (other.body.uuid === input.adminUuid) throw new Error(`the peers to inform include the admin machine "${other.body.name}": it installs the registration itself. Reload the page and rename again. Nothing was signed`);
    await assertSignedByAdmin(other, input.adminPublicKey);
  }
  const normalized = normalizeMachineName(input.newName);
  if (!normalized.ok) {
    throw new Error(`invalid new name ${JSON.stringify(input.newName)}: it has no letter or digit to build a machine name from. Use letters, digits and hyphens, for example: mac-m2. Nothing was signed`);
  }
  const newName = normalized.name;
  const planned = buildRenamedRegistration({
    uuid: current.body.uuid,
    current: current.body,
    newName,
    machines: input.machines,
    aliases: input.aliases,
    networkAliases: input.networkAliases,
    revokedUpTo: input.revokedUpTo,
    now: input.now,
  });
  if (!planned.ok) {
    throw new Error(planned.message.endsWith('Nothing was signed') ? planned.message : `${planned.message}. Nothing was signed`);
  }
  const signed = await signRegistration(planned.body, input.adminPrivateKey);

  const distribution = await buildDistribution({
    adminPrivateKey: input.adminPrivateKey,
    adminPublicKey: input.adminPublicKey,
    adminUuid: input.adminUuid,
    subject: signed,
    others: input.others,
    noticeRecipients: input.noticeRecipients,
    now: input.now,
  });
  const documents = [...distribution.documents];
  const failures: RenameBuildFailure[] = [...distribution.failures];

  // The renamed machine also receives its OWN registration so that it takes its new name (distribute.ts `selfRegistrationDocument`: id and dates from the registration only).
  try {
    const issuedAt = signed.body.validFrom;
    const expiresAt = Math.min(issuedAt + DOCUMENT_RETENTION_SECONDS, signed.body.validTo);
    if (expiresAt <= input.now) {
      throw new Error(
        `the registration of "${signed.body.name}" is older than the 30 days the relay keeps a document, or has expired: the machine can no longer be told its new name this way. Run \`machine admin approve\` for it (it renews the registration and carries the name)`,
      );
    }
    documents.push(
      await buildDocument(
        {
          kind: 'self-registration',
          to: signed.body.uuid,
          id: await documentId(`v2:self-registration:${signed.body.uuid}:${signed.body.serial}`),
          issuedAt,
          expiresAt,
          payload: { registration: signed } as unknown as Json as never,
          recipientIdentityPublicKey: signed.body.identityPublicKey,
        },
        input.adminPrivateKey,
      ),
    );
  } catch (e) {
    failures.push({ toUuid: signed.body.uuid, toName: signed.body.name, kind: 'self-registration', message: errorText(e) });
  }
  return { signed, newName, normalized: normalized.changed, documents, noticeRecipients: distribution.noticeRecipients, failures };
}
