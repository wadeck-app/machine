import { existsSync } from 'node:fs';
import {
  canonicalSignedNoticeRecipients,
  compareNoticeRecipients,
  DOCUMENT_RETENTION_SECONDS,
  documentId,
  isUuid,
  verifyDocumentEnvelope,
  verifyNoticeRecipients,
  type SignedDocument,
  type SignedNoticeRecipients,
  type SignedRegistration,
} from '@wadeck-app/machine-core';
import { adminKeyFile, readAdminPin } from './admin.js';
import { missingAdminTokenMessage } from './adminApprove.js';
import type { DirectDelivery } from './directDelivery.js';
import { deliveryMachines, type DeliveryMachine } from './deliveryMachines.js';
import { adminRelayAccess, emptyReport, formatDistribution, put, putNoticeDocument, type DeliveryContext, type DistributionReport } from './distribute.js';
import { NotInitializedError } from './errors.js';
import { readMachine } from './identity.js';
import { trustedRegistrations } from './network.js';
import { installNoticeRecipients, readNoticeRecipients } from './noticeRecipientsStore.js';
import type { RelayClient } from './relayClient.js';
import { readRelayConfig } from './relayStore.js';

// Approve from the page, lot 5 (admin-ui.md): the other peers learn the new machine. The BROWSER signs the peer documents and the list of notice recipients with the
// same unlocked key as the approval (machine-webcrypto `buildDistribution`); this machine, which holds the admin key file, only verifies and delivers them. It never
// receives a passphrase or an unlocked key and signs nothing. The delivery is `put` of distribute.ts, the code of `machine admin distribute`: direct first, then the
// relay inbox, the same report and the same words, so the page and the CLI cannot drift apart.
//
// Hard rule 4: the documents are sealed to their addressee, so this machine cannot read them. What it CAN check, it does: the admin signature against the pinned key,
// the addressee, the time window, and that each id is the one it derives itself from the registrations it holds (and, for a list, from the list itself). A page that
// sealed something else gets it refused by the addressee, which opens and verifies the payload again; nothing here widens a right.

export type Failure = { ok: false; reason: string; message: string };
const fail = (reason: string, message: string): Failure => ({ ok: false, reason, message });

export type ApproveDistributeAnswer =
  | {
      ok: true;
      subject: { uuid: string; name: string };
      /** True when at least one machine does not know the new machine yet: the approval stands, `text.err` names the machines and the retry command. */
      failed: boolean;
      report: DistributionReport;
      /** The report in the words of the CLI (`formatDistribution`): `out` is the success text, `err` the failures and the retry command. */
      text: { out: string; err: string };
      /** One entry per machine told (the new machine included), from the same report: state, cause code, one short reason, one next action. The page shows these and keeps `text` in a collapsed "Details". */
      machines: DeliveryMachine[];
      retry: string;
    }
  | Failure;

const FIELDS = ['candidateUuid', 'documents', 'noticeRecipients'];
const BAD_PAYLOAD = `expected exactly {"candidateUuid": <uuid>, "documents": [<signed inbox document>...], "noticeRecipients": <signed list, or null when this machine already holds one>}, nothing else: reload the page and approve again`;
// A generous bound: 2 documents per other peer plus one list per machine, each at most 16 KiB (the relay limit), for at most this many machines.
const MAX_DOCUMENTS = 256;

interface Expected {
  to: { uuid: string; name: string };
  kind: 'peer' | 'notice-recipients';
}

export async function approveDistribute(
  configDir: string,
  payload: unknown,
  now: number,
  options: { client?: RelayClient; /** Tries the peer channel before the inbox (decision 86). Absent: the inbox only. */ direct?: DirectDelivery } = {},
): Promise<ApproveDistributeAnswer> {
  const p = typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : undefined;
  if (p === undefined || Object.keys(p).some((k) => !FIELDS.includes(k)) || FIELDS.some((k) => p[k] === undefined)) return fail('bad-payload', BAD_PAYLOAD);
  const candidateUuid = p['candidateUuid'];
  const documents = p['documents'];
  if (typeof candidateUuid !== 'string' || !isUuid(candidateUuid)) return fail('bad-payload', `"candidateUuid" is not a uuid: ${BAD_PAYLOAD}`);
  if (!Array.isArray(documents) || documents.length > MAX_DOCUMENTS) return fail('bad-payload', `"documents" must be a list of at most ${MAX_DOCUMENTS} signed documents: ${BAD_PAYLOAD}`);

  if (!existsSync(adminKeyFile(configDir))) {
    return fail('no-admin-key', `this machine has no admin key (${adminKeyFile(configDir)} does not exist): the documents can only be delivered by the machine that holds the admin key (\`machine admin init\` creates the key). Nothing was delivered`);
  }
  let self: { uuid: string; name: string };
  try {
    self = readMachine(configDir);
  } catch (e) {
    if (e instanceof NotInitializedError) return fail('not-initialized', `${e.message}. Nothing was delivered`);
    throw e;
  }
  const pin = readAdminPin(configDir);

  const registrations = trustedRegistrations(configDir, now);
  const subject = registrations.find((r) => r.body.uuid === candidateUuid);
  if (subject === undefined) {
    return fail(
      'not-imported',
      `machine ${candidateUuid} is not a trusted peer of this machine: the approval was not imported here, so there is nothing to tell the others about. Nothing was delivered; approve the candidacy again, or run \`machine admin approve\``,
    );
  }
  const others = registrations.filter((r) => r.body.uuid !== candidateUuid);
  const retry = `machine admin distribute ${subject.body.uuid}`;
  const retryText = `Nothing was delivered. The approval stands: run \`${retry}\` to tell the other machines`;

  // The list of notice recipients: the one the page signed because this machine had none, else the stored one. Never replaces a stored one by an older or other one.
  let list: SignedNoticeRecipients | undefined;
  let installList = false;
  if (p['noticeRecipients'] !== null) {
    try {
      list = canonicalSignedNoticeRecipients(p['noticeRecipients']);
    } catch (e) {
      return fail('bad-notice-recipients', `the list of notice recipients is refused (${(e as Error).message}). ${retryText}`);
    }
    const verified = verifyNoticeRecipients(list, { adminPublicKey: pin.adminPublicKey });
    if (!verified.ok) return fail('bad-notice-recipients', `the list of notice recipients is refused (${verified.reason}): ${verified.message}. ${retryText}`);
    installList = true;
  }
  let stored: SignedNoticeRecipients | undefined;
  try {
    stored = readNoticeRecipients(configDir, pin.adminPublicKey);
  } catch (e) {
    return fail('notice-recipients-invalid', `${(e as Error).message}. ${retryText}`);
  }
  if (list === undefined) {
    if (stored === undefined) return fail('bad-notice-recipients', `no list of notice recipients was sent and this machine holds none: reload the page and approve again. ${retryText}`);
    list = stored;
  } else {
    const order = compareNoticeRecipients(stored, list);
    if (order === 'older' || (order === 'same' && stored !== undefined && stored.signature !== list.signature)) {
      return fail('stale-notice-recipients', `this machine already holds a list of notice recipients (serial ${stored?.body.serial}) that the one the page signed (serial ${list.body.serial}) does not replace: reload the page and approve again. ${retryText}`);
    }
  }

  // What this approval needs, derived HERE from what this machine holds (the page is not trusted for ids).
  const expected = new Map<string, Expected>();
  const peerId = (to: SignedRegistration, about: SignedRegistration): string => documentId(`v2:peer:${to.body.uuid}:${to.body.serial}:${about.body.uuid}:${about.body.serial}`);
  const keyOf = (to: string, id: string): string => `${to}:${id}`;
  for (const other of others) {
    expected.set(keyOf(other.body.uuid, peerId(other, subject)), { to: { uuid: other.body.uuid, name: other.body.name }, kind: 'peer' });
    expected.set(keyOf(subject.body.uuid, peerId(subject, other)), { to: { uuid: subject.body.uuid, name: subject.body.name }, kind: 'peer' });
  }
  for (const target of registrations) {
    if (target.body.uuid === self.uuid) continue;
    expected.set(keyOf(target.body.uuid, documentId(`v2:notice-recipients:${target.body.uuid}:${list.body.serial}:${list.signature}`)), { to: { uuid: target.body.uuid, name: target.body.name }, kind: 'notice-recipients' });
  }

  const received = new Map<string, SignedDocument>();
  for (const raw of documents) {
    const addressee = (raw as { body?: { to?: unknown } } | null)?.body?.to;
    const envelope = verifyDocumentEnvelope(raw, { adminPublicKey: pin.adminPublicKey, selfUuid: typeof addressee === 'string' ? addressee : '', now });
    if (!envelope.ok) return fail('bad-document', `a document is refused (${envelope.reason}): ${envelope.message}. Nothing was delivered; reload the page and approve again`);
    const key = keyOf(envelope.body.to, envelope.body.id);
    const wanted = expected.get(key);
    if (wanted === undefined || wanted.kind !== envelope.kind) {
      return fail(
        'bad-document',
        `document ${envelope.body.id} (${envelope.kind}, for machine ${envelope.body.to}) is not one this approval needs: the page and this machine disagree about who is trusted here, or the document was altered. Nothing was delivered; reload the page and approve again`,
      );
    }
    if (received.has(key)) return fail('bad-document', `document ${envelope.body.id} was sent twice. Nothing was delivered; reload the page and approve again`);
    if (envelope.body.expiresAt - envelope.body.issuedAt > DOCUMENT_RETENTION_SECONDS) return fail('bad-document', `document ${envelope.body.id} lives longer than the relay keeps it. Nothing was delivered`);
    received.set(key, raw as SignedDocument);
  }

  const access = adminRelayAccess(configDir, options.client);
  if (access === undefined) return fail('no-admin-token', `${missingAdminTokenMessage(configDir, readRelayConfig(configDir)?.relayUrl)}. ${retryText}`);

  if (installList) {
    try {
      installNoticeRecipients(configDir, list, pin.adminPublicKey);
    } catch (e) {
      return fail('notice-recipients-invalid', `the list of notice recipients could not be kept on this machine (${(e as Error).message}). ${retryText}`);
    }
  }

  const sender: DeliveryContext = { client: access.client, adminUuid: self.uuid, now: () => now, configDir, ...(options.direct === undefined ? {} : { direct: options.direct }) };
  const report = emptyReport();
  report.machines = others.length;
  // Same order as `distributeMachine`: for each other peer the document about the new machine, then the one about it, then the lists.
  const missing: Array<{ to: { uuid: string; name: string }; kind: 'peer' | 'notice-recipients' }> = [];
  let go = true;
  for (const [key, want] of expected) {
    const document = received.get(key);
    if (document === undefined) {
      missing.push(want);
      continue;
    }
    if (!go) continue;
    go =
      want.kind === 'notice-recipients'
        ? await putNoticeDocument(sender, report, want.to, list, () => document)
        : await put(sender, report, want.to, 'peer', () => document);
  }
  // A document the page could not build (an expired registration, say) is not silence: the machine is named, with the way to send it from the terminal.
  for (const m of missing) {
    report.failures.push({
      toUuid: m.to.uuid,
      toName: m.to.name,
      kind: m.kind,
      id: undefined,
      message: `the page did not send the ${m.kind === 'peer' ? 'peer' : 'notice recipients'} document for this machine (it could not be built, or it was dropped): it was not delivered`,
    });
  }
  const text = formatDistribution(report, 'the approval', retry);
  // The machines told, once each, in the order of the documents.
  const told = new Map<string, { uuid: string; name: string }>();
  for (const want of expected.values()) told.set(want.to.uuid, want.to);
  return { ok: true, subject: { uuid: subject.body.uuid, name: subject.body.name }, failed: text.failed, report, text: { out: text.out, err: text.err }, machines: deliveryMachines(report, [...told.values()], retry), retry };
}
