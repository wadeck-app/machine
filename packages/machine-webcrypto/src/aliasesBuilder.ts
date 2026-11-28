import type { SignedDocument, SignedRegistration } from '@wadeck-app/machine-core';
import { ALIASES_DOMAIN, assertAliasesBody, planAliasChange, signAliases, type AliasChange, type AliasEntry, type SignedAliases } from './aliases.js';
import type { Json } from './canonical.js';
import { buildDocument, documentId, DOCUMENT_RETENTION_SECONDS, REGISTRATION_DOMAIN } from './documents.js';
import { keyId } from './keys.js';
import { verifyBody } from './signed.js';

// Network aliases from the page (decision 116; admin-ui.md, "Rename and aliases from the page"): what `machine admin alias set|rm` signs and sends, built in the browser with
// the unlocked admin key. Twin of machine-cli `adminAlias.ts` (the plan), `aliasesStore.ts` `signAliasesFor` (serial = the later of now and the stored serial + 1) and
// `distribute.ts` `distributeAliases` (one sealed `aliases` document per trusted peer, same id and dates). An alias is a label, never a right. The daemon of the admin machine
// verifies all of it against the pinned key before it installs or sends anything. Pure: no I/O, `now` is given.

export interface BuildAliasesInput {
  /** The unlocked, non-extractable admin signing key. */
  adminPrivateKey: CryptoKey;
  adminPublicKey: string;
  /** The machine that holds the admin key: it keeps the list itself and is not a recipient. */
  adminUuid: string;
  change: AliasChange;
  /** The list stored on the admin machine, or null when there is none (verified against `adminPublicKey` here). */
  current: SignedAliases | null;
  /** Every machine an alias may point to: the trusted peers AND the admin machine. */
  machines: ReadonlyArray<{ uuid: string; name: string }>;
  /** Uuids revoked here. */
  revoked: readonly string[];
  /** The registrations the admin machine holds for the trusted peers (not the admin machine). Each is verified against `adminPublicKey` here. */
  recipients: SignedRegistration[];
  /** Epoch seconds. */
  now: number;
}

export interface AliasesBuildFailure {
  toUuid: string;
  toName: string;
  kind: 'aliases';
  message: string;
}

export interface BuiltAliases {
  /** The list after the change, signed: installed on the admin machine and carried by every document. */
  signed: SignedAliases;
  /** The alias that was set or removed (the typed one, normalized). */
  alias: string;
  entries: AliasEntry[];
  /** The typed alias was not valid as typed and was made valid. */
  normalized: boolean;
  /** One sealed inbox document per recipient. */
  documents: SignedDocument[];
  /** What could not be built, per machine: the others are still built; the caller reports them with the retry command. */
  failures: AliasesBuildFailure[];
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function buildAliases(input: BuildAliasesInput): Promise<BuiltAliases> {
  const { current, recipients } = input;
  if (current !== null) {
    let valid = false;
    try {
      assertAliasesBody(current.body);
      valid = await verifyBody(ALIASES_DOMAIN, current as unknown as { body: Json; signature: string }, input.adminPublicKey);
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new Error(
        'the stored list of network aliases is not signed by the admin key that was unlocked: the page was given altered data, or the key file is not the one pinned on this machine. Nothing was signed; reload the page and check `machine admin show`',
      );
    }
  }
  for (const to of recipients) {
    if (to.body.uuid === input.adminUuid) throw new Error(`the peers to inform include the admin machine "${to.body.name}": it keeps the list itself. Reload the page and try again. Nothing was signed`);
    // The daemon serves these registrations through a backend the page does not trust: a registration is used (its identity key seals the document) only when the admin key signed it.
    if (!(await verifyBody(REGISTRATION_DOMAIN, to as unknown as { body: Json; signature: string }, input.adminPublicKey))) {
      throw new Error(
        `the registration of "${to.body.name}" (${to.body.uuid}) is not signed by the admin key that was unlocked: the page was given altered data, or the key file is not the one pinned on this machine. Nothing was signed; reload the page and check \`machine admin show\``,
      );
    }
  }
  const plan = planAliasChange({ change: input.change, current: current?.body.entries ?? [], machines: input.machines, revoked: input.revoked });
  if (!plan.ok) {
    throw new Error(`${plan.message}. Nothing was signed`);
  }
  if (!plan.changed) {
    throw new Error(`the network alias "${plan.alias}" already points to that machine: nothing to sign. Nothing was signed`);
  }
  const serial = Math.max(input.now, (current?.body.serial ?? 0) + 1);
  const signed = await signAliases({ v: 1, adminKeyId: await keyId(input.adminPublicKey), serial, issuedAt: input.now, entries: plan.entries }, input.adminPrivateKey);

  const documents: SignedDocument[] = [];
  const failures: AliasesBuildFailure[] = [];
  for (const to of recipients) {
    try {
      documents.push(
        await buildDocument(
          {
            kind: 'aliases',
            to: to.body.uuid,
            id: await documentId(`v2:aliases:${to.body.uuid}:${signed.body.serial}:${signed.signature}`),
            issuedAt: input.now,
            expiresAt: input.now + DOCUMENT_RETENTION_SECONDS,
            payload: signed as unknown as Json as never,
            recipientIdentityPublicKey: to.body.identityPublicKey,
          },
          input.adminPrivateKey,
        ),
      );
    } catch (e) {
      failures.push({ toUuid: to.body.uuid, toName: to.body.name, kind: 'aliases', message: errorText(e) });
    }
  }
  return { signed, alias: plan.alias, entries: plan.entries, normalized: plan.normalized, documents, failures };
}
