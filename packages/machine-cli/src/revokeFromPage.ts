import { existsSync } from 'node:fs';
import {
  canonicalSignedNoticeRecipients,
  canonicalSignedRevocation,
  compareNoticeRecipients,
  DOCUMENT_RETENTION_SECONDS,
  documentId,
  isUuid,
  keyId,
  mergeRevocations,
  revocationDigest,
  verifyDocumentEnvelope,
  verifyNoticeRecipients,
  verifyRevocation,
  type RevocationEntry,
  type SignedDocument,
  type SignedNoticeRecipients,
  type SignedRegistration,
  type SignedRevocation,
} from '@wadeck-app/machine-core';
import { adminKeyFile, readAdminPin } from './admin.js';
import { missingAdminTokenMessage } from './adminApprove.js';
import { deliveryMachines, type DeliveryMachine } from './deliveryMachines.js';
import type { DirectDelivery } from './directDelivery.js';
import { deliverItem, keepForRetry, type RetainedItem } from './deliveryRetry.js';
import { adminRelayAccess, emptyReport, formatDistribution, removeRevokedFromRelay, type DeliveryContext, type DistributionFailure, type DistributionReport } from './distribute.js';
import { NotInitializedError } from './errors.js';
import { readMachine, type MachineIdentity } from './identity.js';
import { installedRevocations, installRevocation, loadNetwork, registeredSerial, revocationState, trustedRegistrations } from './network.js';
import { installNoticeRecipients, readNoticeRecipients } from './noticeRecipientsStore.js';
import type { RelayClient } from './relayClient.js';
import { readRelayConfig } from './relayStore.js';

// Revoke from the page, daemon side (admin-ui.md, "Revoke from the page"). The BROWSER holds the passphrase and signs (machine-webcrypto `buildRevocation`): the union
// list and the documents for the peers that stay trusted. This machine, the one that holds the admin key file, only verifies, installs and delivers. It never receives
// a passphrase or an unlocked key and signs nothing.

export type Failure = { ok: false; reason: string; message: string };
const fail = (reason: string, message: string): Failure => ({ ok: false, reason, message });

const retryOf = (uuid: string): string => `machine admin distribute ${uuid}`;

export interface RevokeContextOk {
  ok: true;
  /** The machine that holds the admin key: never revoked from the page, never told (it installs the list itself). */
  adminMachine: { uuid: string; name: string };
  /** The pinned admin key: the public half of the key file the page unlocks. */
  adminPublicKey: string;
  adminKeyId: string;
  /** The machine to revoke: `serial` is the highest registration this machine holds for it (the list must cover it). */
  revoked: { uuid: string; name: string; serial: number; keyId: string };
  /** What is installed now, and the highest `issuedAt` of the lists kept here: the page signs the union, dated above it. */
  held: { entries: RevocationEntry[]; version: number };
  /** The registrations of the peers that STAY trusted: the page verifies each against the admin key it unlocks, then seals a document to it. */
  recipients: SignedRegistration[];
  /** The list of machines that receive request notices stored here, or null when none: the page then signs `[this machine]`. */
  noticeRecipients: SignedNoticeRecipients | null;
}

const notAdminHere = (configDir: string): Failure =>
  fail(
    'no-admin-key',
    `this machine has no admin key (${adminKeyFile(configDir)} does not exist): a machine can only be revoked from the machine that holds the admin key, run this page there (\`machine admin init\` creates the key). Nothing was signed`,
  );

function selfOf(configDir: string): MachineIdentity | Failure {
  try {
    return readMachine(configDir);
  } catch (e) {
    if (e instanceof NotInitializedError) return fail('not-initialized', `${e.message}. Nothing was signed`);
    throw e;
  }
}

const BAD_CONTEXT = 'expected exactly {"uuid": "<uuid of the machine to revoke>"}: reload the page and revoke again';

/** Why a machine this one does not trust cannot be revoked: already revoked here (the CLI retry exists), or not a peer at all. */
function untrusted(configDir: string, uuid: string): Failure {
  const entry = installedRevocations(configDir).find((e) => e.uuid === uuid);
  if (entry !== undefined) {
    return fail(
      'not-trusted',
      `machine ${uuid} is already revoked on this machine (serial ${entry.serial}), so there is nothing to sign. To send the revocation to the other machines again, run \`${retryOf(uuid)}\` in a terminal`,
    );
  }
  return fail('not-trusted', `machine ${uuid} is not a trusted peer of this machine (see the Machines page, or \`machine status\`): only a machine this one trusts can be revoked. Nothing was signed`);
}

/** Everything the page needs BEFORE it asks the passphrase. Read-only. Payload: exactly `{ uuid }`. */
export function revokeContext(configDir: string, payload: unknown, now: number): RevokeContextOk | Failure {
  const p = typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const uuid = p['uuid'];
  if (Object.keys(p).some((k) => k !== 'uuid') || typeof uuid !== 'string' || !isUuid(uuid)) return fail('bad-payload', BAD_CONTEXT);
  if (!existsSync(adminKeyFile(configDir))) return notAdminHere(configDir);
  const self = selfOf(configDir);
  if ('ok' in self) return self;
  if (uuid === self.uuid) {
    return fail('self', `"${self.name}" is the admin machine itself: it cannot revoke itself from this page (the network would lose its admin machine). Nothing was signed`);
  }
  const pin = readAdminPin(configDir);
  const peer = loadNetwork(configDir, now).directory.find(uuid);
  if (peer === undefined) return untrusted(configDir, uuid);
  const serial = registeredSerial(configDir, uuid);
  if (serial === undefined) return fail('not-trusted', `cannot find the registration of ${uuid} in the peer list of this machine: nothing was signed`);
  let noticeRecipients: SignedNoticeRecipients | null;
  try {
    noticeRecipients = readNoticeRecipients(configDir, pin.adminPublicKey) ?? null;
  } catch (e) {
    return fail('notice-recipients-invalid', `${(e as Error).message}. Nothing was signed`);
  }
  return {
    ok: true,
    adminMachine: { uuid: self.uuid, name: self.name },
    adminPublicKey: pin.adminPublicKey,
    adminKeyId: pin.adminKeyId,
    revoked: { uuid: peer.peerId, name: peer.name, serial, keyId: keyId(peer.identityPublicKey) },
    held: { entries: installedRevocations(configDir), version: revocationState(configDir).version },
    recipients: trustedRegistrations(configDir, now).filter((r) => r.body.uuid !== uuid),
    noticeRecipients,
  };
}

export type RevokeApplyAnswer =
  | {
      ok: true;
      revoked: { uuid: string; name: string };
      /** True when a machine was not told (or the revoked machine could not be removed from the relay): the revocation stands, `text.err` names them and the retry command. */
      failed: boolean;
      report: DistributionReport;
      /** The report in the words of the CLI (`formatDistribution`): `out` is the success text, `err` the failures and the retry command. */
      text: { out: string; err: string };
      /** One entry per peer told, plus the revoked machine when it could not be removed from the relay: state, cause code, one short reason, one next action. */
      machines: DeliveryMachine[];
      retry: string;
    }
  | Failure;

const FIELDS = ['uuid', 'signed', 'documents', 'noticeRecipients'];
const BAD_PAYLOAD = `expected exactly {"uuid": <uuid>, "signed": <signed revocation list>, "documents": [<signed inbox document>...], "noticeRecipients": <signed list, or null when this machine already holds one>}, nothing else: reload the page and revoke again`;
// A generous bound: one revocation and one list per peer that stays trusted, each at most 16 KiB (the relay limit).
const MAX_DOCUMENTS = 256;

interface Expected {
  to: { uuid: string; name: string };
  kind: 'revocation' | 'notice-recipients';
}

/**
 * Verifies what the page signed, installs the list on this machine, then delivers the documents with the code of `machine admin revoke` (`put`: direct first, then the
 * relay inbox) and removes the revoked machine from the relay. Payload: exactly `{ uuid, signed, documents, noticeRecipients }`; any other field is refused.
 *
 * Hard rule 4: a revocation only restricts, but it is installed only when the PINNED admin key signed it, and it must revoke exactly the machine asked for (up to its
 * highest registered serial) and nothing else, on top of what is installed. Nothing is installed or sent when a check fails. Once installed it stands: a failed
 * delivery is part of the answer with the retry command, never an undo.
 */
export async function revokeApply(
  configDir: string,
  payload: unknown,
  now: number,
  options: { client?: RelayClient; /** Tries the peer channel before the inbox (decision 86). Absent: the inbox only. */ direct?: DirectDelivery } = {},
): Promise<RevokeApplyAnswer> {
  const p = typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : undefined;
  if (p === undefined || Object.keys(p).some((k) => !FIELDS.includes(k)) || FIELDS.some((k) => p[k] === undefined)) return fail('bad-payload', BAD_PAYLOAD);
  const uuid = p['uuid'];
  const documents = p['documents'];
  if (typeof uuid !== 'string' || !isUuid(uuid)) return fail('bad-payload', `"uuid" is not a uuid: ${BAD_PAYLOAD}`);
  if (typeof p['signed'] !== 'object' || p['signed'] === null) return fail('bad-payload', `"signed" is not a signed revocation list: ${BAD_PAYLOAD}`);
  if (!Array.isArray(documents) || documents.length > MAX_DOCUMENTS) return fail('bad-payload', `"documents" must be a list of at most ${MAX_DOCUMENTS} signed documents: ${BAD_PAYLOAD}`);

  if (!existsSync(adminKeyFile(configDir))) return notAdminHere(configDir);
  const self = selfOf(configDir);
  if ('ok' in self) return self;
  if (uuid === self.uuid) return fail('self', `"${self.name}" is the admin machine itself: it cannot be revoked from this page. Nothing was installed`);
  const pin = readAdminPin(configDir);

  const peer = loadNetwork(configDir, now).directory.find(uuid);
  if (peer === undefined) return untrusted(configDir, uuid);
  const serial = registeredSerial(configDir, uuid);
  if (serial === undefined) return fail('not-trusted', `cannot find the registration of ${uuid} in the peer list of this machine: nothing was installed`);
  const retry = retryOf(uuid);
  const retryText = `Nothing was delivered. The revocation stands: run \`${retry}\` to tell the other machines`;

  // The list: signed by the pinned key, and exactly one new entry on top of what is installed (this machine, up to the serial it holds), nothing removed.
  let list: SignedRevocation;
  try {
    list = canonicalSignedRevocation(p['signed']);
  } catch (e) {
    return fail('bad-revocation', `the revocation list is refused (${(e as Error).message}). Nothing was installed`);
  }
  const verified = verifyRevocation(list, { adminPublicKey: pin.adminPublicKey });
  if (!verified.ok) {
    return fail('bad-revocation', `the revocation list is refused (${verified.reason}): ${verified.message}. The page unlocked another key than the one pinned on this machine, or the list was altered. Nothing was installed`);
  }
  const installed = installedRevocations(configDir);
  if (revocationDigest(mergeRevocations(installed, list.body.entries)) !== revocationDigest(list.body.entries)) {
    return fail('stale-revocation', `another revocation was installed on this machine since the page read it, and the list the page signed does not include it: reload the page and revoke again. Nothing was installed`);
  }
  const added = list.body.entries.filter((e) => !installed.some((i) => i.uuid === e.uuid && i.serial >= e.serial));
  if (added.length !== 1 || added[0]?.uuid !== uuid || added[0]?.serial !== serial) {
    return fail(
      'bad-revocation',
      `the revocation list revokes something else than machine ${uuid} up to serial ${serial} (it adds ${added.length === 0 ? 'nothing' : added.map((e) => `${e.uuid} up to serial ${e.serial}`).join(', ')}): reload the page and revoke again. Nothing was installed`,
    );
  }

  // The list of notice recipients: the one the page signed because this machine had none, else the stored one. Never replaces a stored one by an older or other one.
  let notices: SignedNoticeRecipients | undefined;
  let installNotices = false;
  if (p['noticeRecipients'] !== null) {
    try {
      notices = canonicalSignedNoticeRecipients(p['noticeRecipients']);
    } catch (e) {
      return fail('bad-notice-recipients', `the list of notice recipients is refused (${(e as Error).message}). Nothing was installed`);
    }
    const checked = verifyNoticeRecipients(notices, { adminPublicKey: pin.adminPublicKey });
    if (!checked.ok) return fail('bad-notice-recipients', `the list of notice recipients is refused (${checked.reason}): ${checked.message}. Nothing was installed`);
    installNotices = true;
  }
  let stored: SignedNoticeRecipients | undefined;
  try {
    stored = readNoticeRecipients(configDir, pin.adminPublicKey);
  } catch (e) {
    return fail('notice-recipients-invalid', `${(e as Error).message}. Nothing was installed`);
  }
  if (notices === undefined) {
    if (stored === undefined) return fail('bad-notice-recipients', 'no list of notice recipients was sent and this machine holds none: reload the page and revoke again. Nothing was installed');
    notices = stored;
  } else {
    const order = compareNoticeRecipients(stored, notices);
    if (order === 'older' || (order === 'same' && stored !== undefined && stored.signature !== notices.signature)) {
      return fail('stale-notice-recipients', `this machine already holds a list of notice recipients (serial ${stored?.body.serial}) that the one the page signed (serial ${notices.body.serial}) does not replace: reload the page and revoke again. Nothing was installed`);
    }
  }
  const noticeList = notices;

  // What this revocation needs, derived HERE from what this machine holds (the page is not trusted for ids): one revocation and one list per peer that stays trusted.
  const recipients = trustedRegistrations(configDir, now).filter((r) => r.body.uuid !== uuid && r.body.uuid !== self.uuid);
  const expected = new Map<string, Expected>();
  const keyOf = (to: string, id: string): string => `${to}:${id}`;
  for (const r of recipients) {
    const to = { uuid: r.body.uuid, name: r.body.name };
    expected.set(keyOf(to.uuid, documentId(`v2:revocation:${to.uuid}:${list.signature}`)), { to, kind: 'revocation' });
  }
  for (const r of recipients) {
    const to = { uuid: r.body.uuid, name: r.body.name };
    expected.set(keyOf(to.uuid, documentId(`v2:notice-recipients:${to.uuid}:${noticeList.body.serial}:${noticeList.signature}`)), { to, kind: 'notice-recipients' });
  }
  const received = new Map<string, SignedDocument>();
  for (const raw of documents) {
    const addressee = (raw as { body?: { to?: unknown } } | null)?.body?.to;
    const envelope = verifyDocumentEnvelope(raw, { adminPublicKey: pin.adminPublicKey, selfUuid: typeof addressee === 'string' ? addressee : '', now });
    if (!envelope.ok) return fail('bad-document', `a document is refused (${envelope.reason}): ${envelope.message}. Nothing was installed or delivered; reload the page and revoke again`);
    const key = keyOf(envelope.body.to, envelope.body.id);
    const wanted = expected.get(key);
    if (wanted === undefined || wanted.kind !== envelope.kind) {
      return fail(
        'bad-document',
        `document ${envelope.body.id} (${envelope.kind}, for machine ${envelope.body.to}) is not one this revocation needs: the page and this machine disagree about who is trusted here, or the document was altered. Nothing was installed or delivered; reload the page and revoke again`,
      );
    }
    if (received.has(key)) return fail('bad-document', `document ${envelope.body.id} was sent twice. Nothing was installed or delivered; reload the page and revoke again`);
    if (envelope.body.expiresAt - envelope.body.issuedAt > DOCUMENT_RETENTION_SECONDS) return fail('bad-document', `document ${envelope.body.id} lives longer than the relay keeps it. Nothing was installed or delivered`);
    received.set(key, raw as SignedDocument);
  }

  // Everything checks out: the revocation is installed HERE first, whatever happens to the delivery (it only restricts, and the others learn it as soon as they can).
  try {
    installRevocation(configDir, list, { now });
  } catch (e) {
    return fail('refused', `${(e as Error).message}. Nothing was installed or delivered`);
  }
  const report = emptyReport();
  report.machines = recipients.length;
  const told = recipients.map((r) => ({ uuid: r.body.uuid, name: r.body.name }));
  const subjectOf = { uuid, name: peer.name };
  // What the page did not send: no retry can fix it, it stays a failure with the CLI command in every report.
  const notSent: DistributionFailure[] = [];
  // The documents to deliver, in the order of delivery (revocations, then lists).
  const items: RetainedItem[] = [];
  for (const [key, want] of expected) {
    const document = received.get(key);
    if (document === undefined) {
      notSent.push({
        toUuid: want.to.uuid,
        toName: want.to.name,
        kind: want.kind,
        id: undefined,
        message: `the page did not send the ${want.kind === 'revocation' ? 'revocation' : 'notice recipients'} document for this machine (it could not be built, or it was dropped): it was not delivered`,
      });
    } else {
      items.push(want.kind === 'notice-recipients' ? { to: want.to, kind: 'notice-recipients', document, noticeList } : { to: want.to, kind: 'revocation', document });
    }
  }
  // What is not stored after this run (failed, or not attempted after an abort): kept in memory for `retryDelivery`.
  const remaining: RetainedItem[] = [];
  // A failure of this machine that a retry cannot fix (the list of notice recipients could not be kept here).
  const kept: DistributionFailure[] = [];
  const finish = (removalPending: boolean): RevokeApplyAnswer => {
    const text = formatDistribution(report, 'the revocation', retry);
    const machines = deliveryMachines(report, told, retry);
    // The revoked machine is not told anything: it appears only when it could not be removed from the relay.
    if (report.failures.some((f) => f.toUuid === uuid)) {
      machines.push({ uuid, name: peer.name, state: 'failed', code: 'not-stored', reason: 'not removed from the relay', next: `run \`${retry}\`` });
    }
    keepForRetry(configDir, { kind: 'revocation', subject: subjectOf, told, retry, items: remaining, persistent: [...notSent, ...kept], removal: removalPending ? subjectOf : undefined, machines });
    return { ok: true, revoked: subjectOf, failed: text.failed, report, text: { out: text.out, err: text.err }, machines, retry };
  };

  const access = adminRelayAccess(configDir, options.client);
  if (access === undefined) {
    report.aborted = true;
    report.failures.push({
      toUuid: self.uuid,
      toName: 'this machine',
      kind: 'machine',
      id: undefined,
      message: `the revocation was NOT distributed: ${missingAdminTokenMessage(configDir, readRelayConfig(configDir)?.relayUrl)}`,
    });
    // Nothing was attempted: every document is kept, and so is the removal of the revoked machine.
    remaining.push(...items);
    return finish(true);
  }

  if (installNotices) {
    try {
      installNoticeRecipients(configDir, noticeList, pin.adminPublicKey);
    } catch (e) {
      const failure: DistributionFailure = { toUuid: self.uuid, toName: 'this machine', kind: 'notice-recipients', id: undefined, message: `the list of notice recipients could not be kept on this machine (${(e as Error).message})` };
      report.failures.push(failure);
      kept.push(failure);
    }
  }

  const sender: DeliveryContext = { client: access.client, adminUuid: self.uuid, now: () => now, configDir, ...(options.direct === undefined ? {} : { direct: options.direct }) };
  // Same order as `distributeRevocation`: the revocation for each peer, then the lists; the removal from the relay only when the relay is usable.
  let go = true;
  for (const item of items) {
    if (!go) {
      remaining.push(item);
      continue;
    }
    const sent = await deliverItem(sender, report, item);
    go = sent.go;
    if (!sent.stored) remaining.push(item);
  }
  // The documents the page did not send are told: the revocations always, the lists only while the relay is usable (as before).
  for (const f of notSent) {
    if (f.kind === 'revocation' || go) report.failures.push(f);
  }
  let removalPending = true;
  if (go) {
    await removeRevokedFromRelay(access.client, report, uuid, peer.name);
    removalPending = report.failures.some((f) => f.toUuid === uuid && f.kind === 'machine');
  }
  return finish(removalPending);
}
