import { existsSync } from 'node:fs';
import { isUuid, verifyDocumentEnvelope, type SignedDocument, type SignedNoticeRecipients } from '@wadeck-app/machine-core';
import { adminKeyFile, readAdminPin } from './admin.js';
import { missingAdminTokenMessage } from './adminApprove.js';
import type { ApproveDistributeAnswer } from './approveDistribute.js';
import type { DirectDelivery } from './directDelivery.js';
import { deliveryMachines, type DeliveryMachine } from './deliveryMachines.js';
import { adminRelayAccess, emptyReport, formatDistribution, put, putNoticeDocument, removeRevokedFromRelay, type DeliveryContext, type DistributionFailure, type DistributionReport, type Recipient } from './distribute.js';
import { NotInitializedError } from './errors.js';
import { readMachine } from './identity.js';
import type { RelayClient } from './relayClient.js';
import { readRelayConfig } from './relayStore.js';

// Retry delivery (admin-ui.md, "Result and progress UX"): after an approval or a revocation made from the page, some documents may not have reached the relay. The page
// signed them in the browser and the daemon already verified them, so the daemon can send them again WITHOUT a passphrase: nothing is signed here.
//
// The documents are kept in the MEMORY of this daemon process only, never on disk: they are sealed (the relay holds the same bytes in an inbox), but a file would outlive
// the process for nothing. A restart, or a run that delivered everything, forgets them; `machine admin distribute <uuid>` (it asks the passphrase) is the way out then.

/** One document still to deliver. A list of notice recipients also carries the list itself (what `putNoticeDocument` records). */
export type RetainedItem =
  | { to: Recipient; kind: 'peer' | 'revocation'; document: SignedDocument }
  | { to: Recipient; kind: 'notice-recipients'; document: SignedDocument; noticeList: SignedNoticeRecipients };

export interface RetainedDelivery {
  kind: 'approval' | 'revocation';
  subject: Recipient;
  /** Every machine the first run told, in the order of its answer. */
  told: Recipient[];
  /** The command that finishes the job from a terminal (asks the passphrase). */
  retry: string;
  /** Only the documents NOT stored yet: failed, or not attempted after an abort. */
  items: RetainedItem[];
  /** Failures no retry can fix (the page sent no document, a list could not be kept here): they stay in every report, with the CLI command. */
  persistent: DistributionFailure[];
  /** The revoked machine still to remove from the relay (revocation only). */
  removal: Recipient | undefined;
  /** The entries of the machines that were not failed when this entry was kept: a machine delivered earlier stays delivered. */
  settled: DeliveryMachine[];
}

// Key: the config directory and the subject, so two daemons of one process (tests) never share an entry. A newer entry for the subject replaces the older one.
const store = new Map<string, RetainedDelivery>();
const keyOf = (configDir: string, uuid: string): string => `${configDir}\n${uuid}`;

export const retainedDelivery = (configDir: string, uuid: string): RetainedDelivery | undefined => store.get(keyOf(configDir, uuid));

/** Forgets everything kept (tests). */
export const clearRetainedDeliveries = (): void => store.clear();

/**
 * Keeps what is still to deliver for `subject`, or forgets the older entry when nothing is left (everything delivered, or only failures a retry cannot fix).
 * `machines` is the answer of the run: its non-failed entries are what a later retry reports for the machines it does not touch.
 */
export function keepForRetry(
  configDir: string,
  run: Omit<RetainedDelivery, 'settled'> & { machines: DeliveryMachine[] },
): void {
  const key = keyOf(configDir, run.subject.uuid);
  if (run.items.length === 0 && run.removal === undefined) {
    store.delete(key);
    return;
  }
  const { machines, ...entry } = run;
  store.set(key, { ...entry, settled: machines.filter((m) => m.state !== 'failed') });
}

/** Sends one retained document and tells whether it was stored (a failure was added to the report) and whether the rest may be attempted. */
export async function deliverItem(sender: DeliveryContext, report: DistributionReport, item: RetainedItem): Promise<{ go: boolean; stored: boolean }> {
  const before = report.failures.length;
  const go =
    item.kind === 'notice-recipients'
      ? await putNoticeDocument(sender, report, item.to, item.noticeList, () => item.document)
      : await put(sender, report, item.to, item.kind, () => item.document);
  return { go, stored: report.failures.length === before };
}

export type RetryDeliveryAnswer = ApproveDistributeAnswer;
const fail = (reason: string, message: string): RetryDeliveryAnswer => ({ ok: false, reason, message });

const BAD_PAYLOAD = 'expected exactly {"uuid": "<uuid of the machine the approval or the revocation was about>"}, nothing else: reload the page and try again';

/**
 * Delivers again the documents kept after a run of `approveDistribute` or `revokeApply` that did not store them all. Payload: exactly `{ uuid }`. Every kept document is
 * verified again (pinned admin key, addressee, expiry at `now`) before it is sent; nothing is signed and no passphrase is involved, so no right is widened (hard rule 4).
 */
export async function retryDelivery(
  configDir: string,
  payload: unknown,
  now: number,
  options: { client?: RelayClient; /** Tries the peer channel before the inbox (decision 86). Absent: the inbox only. */ direct?: DirectDelivery } = {},
): Promise<RetryDeliveryAnswer> {
  const p = typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : undefined;
  const uuid = p?.['uuid'];
  if (p === undefined || Object.keys(p).some((k) => k !== 'uuid') || typeof uuid !== 'string' || !isUuid(uuid)) return fail('bad-payload', BAD_PAYLOAD);

  if (!existsSync(adminKeyFile(configDir))) {
    return fail('no-admin-key', `this machine has no admin key (${adminKeyFile(configDir)} does not exist): the documents can only be delivered by the machine that holds the admin key (\`machine admin init\` creates the key). Nothing was delivered`);
  }
  const cliRetry = `machine admin distribute ${uuid}`;
  const entry = retainedDelivery(configDir, uuid);
  if (entry === undefined) {
    return fail(
      'nothing-retained',
      `this machine keeps no documents to send again for ${uuid}: the daemon keeps them only in memory, they are lost when the daemon restarts and after a run that delivered everything. Run \`${cliRetry}\` in a terminal (it asks the admin passphrase)`,
    );
  }

  let self: { uuid: string; name: string };
  try {
    self = readMachine(configDir);
  } catch (e) {
    if (e instanceof NotInitializedError) return fail('not-initialized', `${e.message}. Nothing was delivered`);
    throw e;
  }
  const access = adminRelayAccess(configDir, options.client);
  if (access === undefined) return fail('no-admin-token', `${missingAdminTokenMessage(configDir, readRelayConfig(configDir)?.relayUrl)}. Nothing was delivered; the documents are kept, retry once this is fixed (or run \`${entry.retry}\`)`);

  // The same checks as the first run, again: an expired document is refused here, never sent.
  const pin = readAdminPin(configDir);
  for (const item of entry.items) {
    const checked = verifyDocumentEnvelope(item.document, { adminPublicKey: pin.adminPublicKey, selfUuid: item.to.uuid, now });
    if (!checked.ok) {
      // It can never become valid again: forget it, so the page stops offering a retry that cannot work.
      store.delete(keyOf(configDir, uuid));
      return fail('bad-document', `a kept document for "${item.to.name}" is refused (${checked.reason}): ${checked.message}. Nothing was delivered; run \`${entry.retry}\` in a terminal (it signs fresh documents and asks the admin passphrase)`);
    }
  }

  const sender: DeliveryContext = { client: access.client, adminUuid: self.uuid, now: () => now, configDir, ...(options.direct === undefined ? {} : { direct: options.direct }) };
  const report = emptyReport();
  report.machines = new Set(entry.items.map((i) => i.to.uuid)).size;
  let go = true;
  const remaining: RetainedItem[] = [];
  for (const item of entry.items) {
    if (!go) {
      remaining.push(item);
      continue;
    }
    const sent = await deliverItem(sender, report, item);
    go = sent.go;
    if (!sent.stored) remaining.push(item);
  }
  // The removal of the revoked machine follows the documents, as in the first run: only when the relay is usable.
  let removal: Recipient | undefined;
  if (entry.removal !== undefined) {
    if (go) {
      await removeRevokedFromRelay(access.client, report, entry.removal.uuid, entry.removal.name);
      if (report.failures.some((f) => f.toUuid === entry.removal?.uuid && f.kind === 'machine')) removal = entry.removal;
    } else {
      removal = entry.removal;
    }
  }
  // What no retry can fix stays in the report, so a success of the rest is never read as "all told".
  report.failures.push(...entry.persistent);

  const text = formatDistribution(report, entry.kind === 'approval' ? 'the approval' : 'the revocation', entry.retry);
  // Merge with the first run: a machine this retry touched (something left to send, or a failure that stays) takes the entry of THIS report; every other machine keeps
  // the entry it had when it was not failed (it was delivered or in the inbox then, and nothing was sent to it since).
  const touched = new Set([...entry.items.map((i) => i.to.uuid), ...entry.persistent.map((f) => f.toUuid)]);
  const fresh = deliveryMachines(report, entry.told.filter((m) => touched.has(m.uuid)), entry.retry);
  const machines = entry.told.map(
    (m): DeliveryMachine =>
      fresh.find((f) => f.uuid === m.uuid) ??
      entry.settled.find((s) => s.uuid === m.uuid) ??
      // Unreachable by construction (a failed machine always has a document left or a failure that stays): never claim a success we cannot prove.
      { uuid: m.uuid, name: m.name, state: 'failed', code: 'not-stored', reason: 'documents not stored', next: `run \`${entry.retry}\`` },
  );
  if (entry.kind === 'revocation' && removal !== undefined) {
    machines.push({ uuid: removal.uuid, name: removal.name, state: 'failed', code: 'not-stored', reason: 'not removed from the relay', next: `run \`${entry.retry}\`` });
  }

  keepForRetry(configDir, { ...entry, items: remaining, removal, machines });
  return { ok: true, subject: entry.subject, failed: text.failed, report, text: { out: text.out, err: text.err }, machines, retry: entry.retry };
}
