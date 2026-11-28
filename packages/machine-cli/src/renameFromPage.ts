import { existsSync } from 'node:fs';
import {
  buildRenamedRegistration,
  canonicalSignedNoticeRecipients,
  compareNoticeRecipients,
  DOCUMENT_RETENTION_SECONDS,
  DOCUMENT_SKEW_SECONDS,
  documentId,
  isUuid,
  keyId,
  NOT_YET_VALID_LEEWAY_SECONDS,
  registrationReplaces,
  verifyDocumentEnvelope,
  verifyNoticeRecipients,
  verifyRegistration,
  type SignedDocument,
  type SignedNoticeRecipients,
  type SignedRegistration,
} from '@wadeck-app/machine-core';
import { adminKeyFile, readAdminPin } from './admin.js';
import { missingAdminTokenMessage } from './adminApprove.js';
import { retryRename } from './adminRename.js';
import { networkAliasMap } from './aliasesStore.js';
import { deliveryMachines, type DeliveryMachine } from './deliveryMachines.js';
import type { DirectDelivery } from './directDelivery.js';
import { deliverItem, keepForRetry, type RetainedItem } from './deliveryRetry.js';
import { adminRelayAccess, emptyReport, formatDistribution, type DeliveryContext, type DistributionFailure, type DistributionReport } from './distribute.js';
import { NotInitializedError } from './errors.js';
import { readMachine, type MachineIdentity } from './identity.js';
import { importPeer, installedRevocations, loadNetwork, resolveRevokedMachine, trustedRegistrations } from './network.js';
import { installNoticeRecipients, readNoticeRecipients } from './noticeRecipientsStore.js';
import type { RelayClient } from './relayClient.js';
import { readRelayConfig } from './relayStore.js';
import { readAliases } from './state.js';

// Rename from the page, daemon side (admin-ui.md, "Rename from the page"). The BROWSER holds the passphrase and signs (machine-webcrypto `buildRename`): the re-issued
// registration of the machine (same uuid, same identity key, new name, serial + 1, same expiry) and the documents that carry it. This machine, the one that holds the
// admin key file, only verifies, installs and delivers, like `machine admin rename`. It never receives a passphrase or an unlocked key and signs nothing.
//
// Hard rule 4: the only thing installed is a registration signed by the PINNED admin key that is EXACTLY what `buildRenamedRegistration` plans from what this machine
// holds (re-run here), for a machine this one already trusts: a name change, no right widened, no expiry extended, no key changed.

export type Failure = { ok: false; reason: string; message: string };
const fail = (reason: string, message: string): Failure => ({ ok: false, reason, message });

export interface RenameContextOk {
  ok: true;
  /** The machine that holds the admin key: never renamed from the page, never told (it installs the registration itself). */
  adminMachine: { uuid: string; name: string };
  adminPublicKey: string;
  adminKeyId: string;
  machine: { uuid: string; name: string; serial: number; keyId: string };
  /** The registration currently trusted for the machine: the page plans the rename from its body. */
  current: SignedRegistration;
  /** Every machine whose name is taken: the trusted peers and this admin machine (the renamed machine included). */
  machines: Array<{ uuid: string; name: string }>;
  /** Local aliases of this machine (alias to uuid) and the network aliases (decision 116): a name must not be an alias of another machine. */
  aliases: Record<string, string>;
  networkAliases: Record<string, string>;
  /** The highest serial of the machine covered by an installed revocation, or null. */
  revokedUpTo: number | null;
  /** The registrations of the other trusted machines (neither the renamed one nor the admin machine): the page verifies each against the key it unlocks, then seals documents to it. */
  others: SignedRegistration[];
  /** The list of machines that receive request notices stored here, or null when none: the page then signs `[this machine]`. */
  noticeRecipients: SignedNoticeRecipients | null;
}

const BAD_CONTEXT = 'expected exactly {"uuid": "<uuid of the machine to rename>"}: reload the page and rename again';

const notAdminHere = (configDir: string): Failure =>
  fail(
    'no-admin-key',
    `this machine has no admin key (${adminKeyFile(configDir)} does not exist): a machine can only be renamed from the machine that holds the admin key, run this page there (\`machine admin init\` creates the key). Nothing was signed`,
  );

function selfOf(configDir: string): MachineIdentity | Failure {
  try {
    return readMachine(configDir);
  } catch (e) {
    if (e instanceof NotInitializedError) return fail('not-initialized', `${e.message}. Nothing was signed`);
    throw e;
  }
}

const selfRefusal = (name: string): Failure =>
  fail(
    'self',
    `"${name}" is the admin machine itself: renaming it is not supported from the page (its peers would need a renewed registration of the admin machine, which a rename does not issue). Rename the other machines, or enroll this one again under another name. Nothing was signed`,
  );

/** Why a machine this one does not trust cannot be renamed: revoked here, or not a peer at all. */
function untrusted(configDir: string, uuid: string, nothing: string): Failure {
  const gone = resolveRevokedMachine(configDir, uuid, {});
  if (gone.ok) {
    return fail(
      'revoked',
      `"${gone.machine.name ?? gone.machine.uuid}" (${gone.machine.uuid}) is revoked here: a revoked machine cannot be renamed. Enroll it again (\`machine join\` there, then \`machine admin approve\` here) and it takes the name it joins with. ${nothing}`,
    );
  }
  return fail('not-trusted', `machine ${uuid} is not a trusted peer of this machine (see the Machines page, or \`machine status\`): only a machine this one trusts can be renamed. ${nothing}`);
}

const revokedUpToOf = (configDir: string, uuid: string): number | null =>
  installedRevocations(configDir)
    .filter((entry) => entry.uuid === uuid)
    .reduce<number | null>((best, entry) => (best === null || entry.serial > best ? entry.serial : best), null);

/** Everything the page needs BEFORE it asks the passphrase. Read-only. Payload: exactly `{ uuid }`. */
export function renameContext(configDir: string, payload: unknown, now: number): RenameContextOk | Failure {
  const p = typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const uuid = p['uuid'];
  if (Object.keys(p).some((k) => k !== 'uuid') || typeof uuid !== 'string' || !isUuid(uuid)) return fail('bad-payload', BAD_CONTEXT);
  if (!existsSync(adminKeyFile(configDir))) return notAdminHere(configDir);
  const self = selfOf(configDir);
  if ('ok' in self) return self;
  if (uuid === self.uuid) return selfRefusal(self.name);
  const pin = readAdminPin(configDir);
  const directory = loadNetwork(configDir, now).directory;
  const peer = directory.find(uuid);
  const registrations = trustedRegistrations(configDir, now);
  const current = registrations.find((r) => r.body.uuid === uuid);
  if (peer === undefined || current === undefined) return untrusted(configDir, uuid, 'Nothing was signed');
  let noticeRecipients: SignedNoticeRecipients | null;
  try {
    noticeRecipients = readNoticeRecipients(configDir, pin.adminPublicKey) ?? null;
  } catch (e) {
    return fail('notice-recipients-invalid', `${(e as Error).message}. Nothing was signed`);
  }
  let networkAliases: Record<string, string>;
  try {
    networkAliases = networkAliasMap(configDir);
  } catch (e) {
    return fail('aliases-invalid', `${(e as Error).message}. Nothing was signed`);
  }
  return {
    ok: true,
    adminMachine: { uuid: self.uuid, name: self.name },
    adminPublicKey: pin.adminPublicKey,
    adminKeyId: pin.adminKeyId,
    machine: { uuid: current.body.uuid, name: current.body.name, serial: current.body.serial, keyId: keyId(peer.identityPublicKey) },
    current,
    machines: [...directory.machines().map((m) => ({ uuid: m.uuid, name: m.name })), { uuid: self.uuid, name: self.name }],
    aliases: readAliases(configDir),
    networkAliases,
    revokedUpTo: revokedUpToOf(configDir, uuid),
    others: registrations.filter((r) => r.body.uuid !== uuid && r.body.uuid !== self.uuid),
    noticeRecipients,
  };
}

export type RenameApplyAnswer =
  | {
      ok: true;
      subject: { uuid: string; name: string };
      /** True when a machine was not told: the rename stands, `text.err` names them and the retry command. */
      failed: boolean;
      report: DistributionReport;
      /** The report in the words of the CLI (`formatDistribution`): `out` is the success text, `err` the failures and the retry command. */
      text: { out: string; err: string };
      /** One entry per machine told, the renamed one included: state, cause code, one short reason, one next action. */
      machines: DeliveryMachine[];
      retry: string;
    }
  | Failure;

const FIELDS = ['uuid', 'signed', 'documents', 'noticeRecipients'];
const BAD_PAYLOAD = `expected exactly {"uuid": <uuid>, "signed": <re-issued signed registration>, "documents": [<signed inbox document>...], "noticeRecipients": <signed list, or null when this machine already holds one>}, nothing else: reload the page and rename again`;
// A generous bound: two peer documents and one list per other machine, the list and the self-registration of the renamed one, each at most 16 KiB (the relay limit).
const MAX_DOCUMENTS = 256;
/** The page signs right before it posts: a registration dated long ago is a stale or replayed one (it would also dodge the expiry check of the planner). */
const MAX_BACKDATE_SECONDS = 600;

interface Expected {
  to: { uuid: string; name: string };
  kind: 'peer' | 'notice-recipients' | 'self-registration';
}

/**
 * Verifies what the page signed, installs the registration on this machine (keeping the pair secret it already shares with the machine), then delivers like
 * `machine admin rename` (`put`: direct first, then the relay inbox). Payload: exactly `{ uuid, signed, documents, noticeRecipients }`; any other field is refused.
 * Nothing is installed or sent when a check fails. Once installed it stands: a failed delivery is part of the answer with the retry command, never an undo.
 */
export async function renameApply(
  configDir: string,
  payload: unknown,
  now: number,
  options: { client?: RelayClient; /** Tries the peer channel before the inbox (decision 86). Absent: the inbox only. */ direct?: DirectDelivery } = {},
): Promise<RenameApplyAnswer> {
  const p = typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : undefined;
  if (p === undefined || Object.keys(p).some((k) => !FIELDS.includes(k)) || FIELDS.some((k) => p[k] === undefined)) return fail('bad-payload', BAD_PAYLOAD);
  const uuid = p['uuid'];
  const documents = p['documents'];
  if (typeof uuid !== 'string' || !isUuid(uuid)) return fail('bad-payload', `"uuid" is not a uuid: ${BAD_PAYLOAD}`);
  if (typeof p['signed'] !== 'object' || p['signed'] === null || Array.isArray(p['signed'])) return fail('bad-payload', `"signed" is not a signed registration: ${BAD_PAYLOAD}`);
  if (!Array.isArray(documents) || documents.length > MAX_DOCUMENTS) return fail('bad-payload', `"documents" must be a list of at most ${MAX_DOCUMENTS} signed documents: ${BAD_PAYLOAD}`);

  if (!existsSync(adminKeyFile(configDir))) return notAdminHere(configDir);
  const self = selfOf(configDir);
  if ('ok' in self) return self;
  if (uuid === self.uuid) return selfRefusal(self.name);
  const pin = readAdminPin(configDir);
  const nothing = 'Nothing was installed or delivered';

  const network = loadNetwork(configDir, now);
  const peer = network.directory.find(uuid);
  const registrations = trustedRegistrations(configDir, now);
  const current = registrations.find((r) => r.body.uuid === uuid);
  if (peer === undefined || current === undefined) return untrusted(configDir, uuid, `${nothing}`);

  // The registration: signed by the pinned key, for this machine and this identity key, and EXACTLY the rename this machine plans from what it holds.
  const signed = p['signed'] as unknown as SignedRegistration;
  const verified = verifyRegistration(signed, { adminPublicKey: pin.adminPublicKey, now, skewSeconds: DOCUMENT_SKEW_SECONDS, notBeforeLeewaySeconds: NOT_YET_VALID_LEEWAY_SECONDS });
  if (!verified.ok) {
    return fail(
      'bad-registration',
      `the re-issued registration is refused (${verified.reason}): ${verified.message}. The page unlocked another key than the one pinned on this machine, or the registration was altered. ${nothing}`,
    );
  }
  const body = verified.body;
  if (body.uuid !== uuid) return fail('bad-registration', `the registration is for machine ${body.uuid}, not for ${uuid}: reload the page and rename again. ${nothing}`);
  const replaces = registrationReplaces(current.body, body);
  if (!replaces.ok) return fail('bad-registration', `the registration is refused (${replaces.reason}): ${replaces.message}. ${nothing}`);
  if (body.validFrom < now - MAX_BACKDATE_SECONDS) {
    return fail('bad-registration', `the registration is dated ${new Date(body.validFrom * 1000).toISOString()}, more than ${MAX_BACKDATE_SECONDS / 60} minutes ago: it is not the one the page just signed. Reload the page and rename again. ${nothing}`);
  }
  let networkAliases: Record<string, string>;
  try {
    networkAliases = networkAliasMap(configDir);
  } catch (e) {
    return fail('aliases-invalid', `${(e as Error).message}. ${nothing}`);
  }
  const machines = [...network.directory.machines().map((m) => ({ uuid: m.uuid, name: m.name })), { uuid: self.uuid, name: self.name }];
  const planned = buildRenamedRegistration({
    uuid,
    current: current.body,
    newName: body.name,
    machines,
    aliases: readAliases(configDir),
    networkAliases,
    revokedUpTo: revokedUpToOf(configDir, uuid) ?? undefined,
    now: body.validFrom,
  });
  if (!planned.ok) return fail('refused', `${planned.message}. ${nothing}`);
  if (JSON.stringify(sortedBody(planned.body)) !== JSON.stringify(sortedBody(body))) {
    return fail(
      'bad-registration',
      `the registration is not the rename this machine plans (a rename changes the name and the serial + 1 only: same machine, same identity key, same expiry): reload the page and rename again. ${nothing}`,
    );
  }
  const retry = retryRename(body.name);
  const retryText = `Nothing was installed or delivered. Reload the page and rename again`;

  // The list of notice recipients: the one the page signed because this machine had none, else the stored one. Never replaces a stored one by an older or other one.
  let notices: SignedNoticeRecipients | undefined;
  let installNotices = false;
  if (p['noticeRecipients'] !== null) {
    try {
      notices = canonicalSignedNoticeRecipients(p['noticeRecipients']);
    } catch (e) {
      return fail('bad-notice-recipients', `the list of notice recipients is refused (${(e as Error).message}). ${nothing}`);
    }
    const checked = verifyNoticeRecipients(notices, { adminPublicKey: pin.adminPublicKey });
    if (!checked.ok) return fail('bad-notice-recipients', `the list of notice recipients is refused (${checked.reason}): ${checked.message}. ${nothing}`);
    installNotices = true;
  }
  let stored: SignedNoticeRecipients | undefined;
  try {
    stored = readNoticeRecipients(configDir, pin.adminPublicKey);
  } catch (e) {
    return fail('notice-recipients-invalid', `${(e as Error).message}. ${nothing}`);
  }
  if (notices === undefined) {
    if (stored === undefined) return fail('bad-notice-recipients', `no list of notice recipients was sent and this machine holds none: reload the page and rename again. ${nothing}`);
    notices = stored;
  } else {
    const order = compareNoticeRecipients(stored, notices);
    if (order === 'older' || (order === 'same' && stored !== undefined && stored.signature !== notices.signature)) {
      return fail('stale-notice-recipients', `this machine already holds a list of notice recipients (serial ${stored?.body.serial}) that the one the page signed (serial ${notices.body.serial}) does not replace: ${retryText}`);
    }
  }
  const noticeList = notices;

  // What this rename needs, derived HERE from what this machine holds, the new registration in place of the old one (the page is not trusted for ids).
  const after = registrations.map((r) => (r.body.uuid === uuid ? signed : r));
  const subject = signed;
  const others = after.filter((r) => r.body.uuid !== uuid && r.body.uuid !== self.uuid);
  const expected = new Map<string, Expected>();
  const keyOf = (to: string, id: string): string => `${to}:${id}`;
  const peerId = (to: SignedRegistration, about: SignedRegistration): string => documentId(`v2:peer:${to.body.uuid}:${to.body.serial}:${about.body.uuid}:${about.body.serial}`);
  const named = (r: SignedRegistration): { uuid: string; name: string } => ({ uuid: r.body.uuid, name: r.body.name });
  for (const other of others) {
    expected.set(keyOf(other.body.uuid, peerId(other, subject)), { to: named(other), kind: 'peer' });
    expected.set(keyOf(subject.body.uuid, peerId(subject, other)), { to: named(subject), kind: 'peer' });
  }
  for (const target of after) {
    if (target.body.uuid === self.uuid) continue;
    expected.set(keyOf(target.body.uuid, documentId(`v2:notice-recipients:${target.body.uuid}:${noticeList.body.serial}:${noticeList.signature}`)), { to: named(target), kind: 'notice-recipients' });
  }
  expected.set(keyOf(subject.body.uuid, documentId(`v2:self-registration:${subject.body.uuid}:${subject.body.serial}`)), { to: named(subject), kind: 'self-registration' });

  const received = new Map<string, SignedDocument>();
  for (const raw of documents) {
    const addressee = (raw as { body?: { to?: unknown } } | null)?.body?.to;
    const envelope = verifyDocumentEnvelope(raw, { adminPublicKey: pin.adminPublicKey, selfUuid: typeof addressee === 'string' ? addressee : '', now });
    if (!envelope.ok) return fail('bad-document', `a document is refused (${envelope.reason}): ${envelope.message}. ${retryText}`);
    const key = keyOf(envelope.body.to, envelope.body.id);
    const wanted = expected.get(key);
    if (wanted === undefined || wanted.kind !== envelope.kind) {
      return fail(
        'bad-document',
        `document ${envelope.body.id} (${envelope.kind}, for machine ${envelope.body.to}) is not one this rename needs: the page and this machine disagree about who is trusted here, or the document was altered. ${retryText}`,
      );
    }
    if (received.has(key)) return fail('bad-document', `document ${envelope.body.id} was sent twice. ${retryText}`);
    if (envelope.body.expiresAt - envelope.body.issuedAt > DOCUMENT_RETENTION_SECONDS) return fail('bad-document', `document ${envelope.body.id} lives longer than the relay keeps it. ${nothing}`);
    received.set(key, raw as SignedDocument);
  }

  // Everything checks out: the rename is installed HERE first, whatever happens to the delivery. The pair secret this machine shares with the machine is kept.
  try {
    importPeer(configDir, { registration: signed, pairSecret: peer.pairSecret.toString('base64url') }, { now });
  } catch (e) {
    return fail('refused', `${(e as Error).message}. ${nothing}`);
  }
  const report = emptyReport();
  // The renamed machine is one more machine reached (as `distributeRename`).
  report.machines = others.length + 1;
  const told = new Map<string, { uuid: string; name: string }>();
  for (const want of expected.values()) told.set(want.to.uuid, want.to);
  const subjectOf = named(subject);
  // What the page did not send: no retry can fix it, it stays a failure with the CLI command in every report.
  const notSent: DistributionFailure[] = [];
  const items: RetainedItem[] = [];
  for (const [key, want] of expected) {
    const document = received.get(key);
    if (document === undefined) {
      notSent.push({
        toUuid: want.to.uuid,
        toName: want.to.name,
        kind: want.kind,
        id: undefined,
        message: `the page did not send the ${want.kind === 'notice-recipients' ? 'notice recipients' : want.kind} document for this machine (it could not be built, or it was dropped): it was not delivered`,
      });
    } else {
      items.push(want.kind === 'notice-recipients' ? { to: want.to, kind: 'notice-recipients', document, noticeList } : { to: want.to, kind: want.kind, document });
    }
  }
  const remaining: RetainedItem[] = [];
  // A failure of this machine that a retry cannot fix (the list of notice recipients could not be kept here).
  const kept: DistributionFailure[] = [];
  const finish = (): RenameApplyAnswer => {
    const text = formatDistribution(report, 'the rename', retry);
    const machinesOut = deliveryMachines(report, [...told.values()], retry);
    keepForRetry(configDir, { kind: 'rename', subject: subjectOf, told: [...told.values()], retry, items: remaining, persistent: [...notSent, ...kept], removal: undefined, machines: machinesOut });
    return { ok: true, subject: subjectOf, failed: text.failed, report, text: { out: text.out, err: text.err }, machines: machinesOut, retry };
  };

  const access = adminRelayAccess(configDir, options.client);
  if (access === undefined) {
    report.aborted = true;
    report.failures.push({
      toUuid: self.uuid,
      toName: 'this machine',
      kind: 'machine',
      id: undefined,
      message: `the rename was NOT distributed: ${missingAdminTokenMessage(configDir, readRelayConfig(configDir)?.relayUrl)}`,
    });
    // Nothing was attempted: every document is kept, and the machines are told as not stored.
    remaining.push(...items);
    for (const want of told.values()) report.failures.push({ toUuid: want.uuid, toName: want.name, kind: 'machine', id: undefined, message: 'not told: no admin relay token' });
    return finish();
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
  report.failures.push(...notSent);
  return finish();
}

/** The body with its keys in a fixed order, so that two equal bodies compare equal whatever the order they were built in. */
function sortedBody(body: SignedRegistration['body']): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
