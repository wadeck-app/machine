import { existsSync } from 'node:fs';
import {
  canonicalSignedAliases,
  compareAliases,
  DOCUMENT_RETENTION_SECONDS,
  documentId,
  NETWORK_ALIASES_SUBJECT_UUID,
  planAliasChange,
  verifyAliases,
  verifyDocumentEnvelope,
  type AliasChange,
  type AliasEntry,
  type SignedAliases,
  type SignedDocument,
  type SignedRegistration,
} from '@wadeck-app/machine-core';
import { adminKeyFile, readAdminPin } from './admin.js';
import { missingAdminTokenMessage } from './adminApprove.js';
import { installAliases, readAliasesList } from './aliasesStore.js';
import { deliveryMachines, type DeliveryMachine } from './deliveryMachines.js';
import type { DirectDelivery } from './directDelivery.js';
import { deliverItem, keepForRetry, type RetainedItem } from './deliveryRetry.js';
import { adminRelayAccess, emptyReport, formatDistribution, RETRY_ALIASES, type DeliveryContext, type DistributionFailure, type DistributionReport } from './distribute.js';
import { NotInitializedError } from './errors.js';
import { readMachine, type MachineIdentity } from './identity.js';
import { installedRevocations, loadNetwork, trustedRegistrations } from './network.js';
import type { RelayClient } from './relayClient.js';
import { readRelayConfig } from './relayStore.js';
import { readAliases } from './state.js';

// Network aliases from the page, daemon side (decision 116, admin-ui.md). The BROWSER holds the passphrase and signs (machine-webcrypto `buildAliases`): the whole new
// list (one alias added or removed) and one sealed `aliases` document per trusted machine. This machine, the one that holds the admin key file, only verifies, installs
// and delivers, like `machine admin alias set|rm|send`. It never receives a passphrase or an unlocked key and signs nothing.
//
// Hard rule 4: the only thing installed is a list signed by the PINNED admin key, newer than the stored one, that differs from it by exactly ONE alias and that
// `planAliasChange` accepts when re-run here against what this machine holds. An alias is a label for a human, never a right.

export type Failure = { ok: false; reason: string; message: string };
const fail = (reason: string, message: string): Failure => ({ ok: false, reason, message });

export interface AliasesContextOk {
  ok: true;
  /** The machine that holds the admin key: it installs the list itself and is not told. */
  adminMachine: { uuid: string; name: string };
  adminPublicKey: string;
  adminKeyId: string;
  /** The signed list in force on this machine, or null when there is none (the next serial is dated from the page clock). */
  current: SignedAliases | null;
  /** The machines an alias may point to and whose names an alias must not take: the trusted peers AND this admin machine. */
  machines: Array<{ uuid: string; name: string }>;
  /** Uuids revoked here: an alias never points to one. */
  revoked: string[];
  /** The local aliases of this machine (alias to uuid): a local alias wins over a network alias with the same label, so the page shows the conflicts. */
  localAliases: Record<string, string>;
  /** The registrations of the machines to tell (trusted, this admin machine excluded): the page verifies each against the key it unlocks, then seals a document to it. */
  recipients: SignedRegistration[];
}

const BAD_CONTEXT = 'expected an empty payload {}: reload the page and try again';

const notAdminHere = (configDir: string): Failure =>
  fail(
    'no-admin-key',
    `this machine has no admin key (${adminKeyFile(configDir)} does not exist): the network aliases can only be changed from the machine that holds the admin key, run this page there (\`machine admin init\` creates the key). Nothing was signed`,
  );

function selfOf(configDir: string): MachineIdentity | Failure {
  try {
    return readMachine(configDir);
  } catch (e) {
    if (e instanceof NotInitializedError) return fail('not-initialized', `${e.message}. Nothing was signed`);
    throw e;
  }
}

/** Everything the page needs BEFORE it asks the passphrase. Read-only. Payload: exactly `{}`. */
export function aliasesContext(configDir: string, payload: unknown, now: number): AliasesContextOk | Failure {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload) || Object.keys(payload).length > 0) return fail('bad-payload', BAD_CONTEXT);
  if (!existsSync(adminKeyFile(configDir))) return notAdminHere(configDir);
  const self = selfOf(configDir);
  if ('ok' in self) return self;
  const pin = readAdminPin(configDir);
  let current: SignedAliases | undefined;
  try {
    current = readAliasesList(configDir, pin.adminPublicKey);
  } catch (e) {
    return fail('aliases-invalid', `${(e as Error).message}. Nothing was signed`);
  }
  return {
    ok: true,
    adminMachine: { uuid: self.uuid, name: self.name },
    adminPublicKey: pin.adminPublicKey,
    adminKeyId: pin.adminKeyId,
    current: current ?? null,
    machines: machinesOf(configDir, self, now),
    revoked: [...new Set(installedRevocations(configDir).map((e) => e.uuid))],
    localAliases: readAliases(configDir),
    recipients: trustedRegistrations(configDir, now).filter((r) => r.body.uuid !== self.uuid),
  };
}

function machinesOf(configDir: string, self: MachineIdentity, now: number): Array<{ uuid: string; name: string }> {
  return [...loadNetwork(configDir, now).directory.machines().map((m) => ({ uuid: m.uuid, name: m.name })), { uuid: self.uuid, name: self.name }];
}

export type AliasesApplyAnswer =
  | {
      ok: true;
      serial: number;
      /** The list in force after the change, with the name of each machine when it is known. */
      entries: Array<{ alias: string; uuid: string; name?: string }>;
      changed: true;
      /** True when a machine was not told: the list stands, `text.err` names them and the retry command. */
      failed: boolean;
      report: DistributionReport;
      /** The report in the words of the CLI (`formatDistribution`): `out` is the success text, `err` the failures and the retry command. */
      text: { out: string; err: string };
      /** One entry per machine told: state, cause code, one short reason, one next action. */
      machines: DeliveryMachine[];
      retry: string;
    }
  | Failure;

const FIELDS = ['signed', 'documents'];
const BAD_PAYLOAD = 'expected exactly {"signed": <signed aliases list>, "documents": [<signed inbox document>...]}, nothing else: reload the page and change the aliases again';
// A generous bound: one document per trusted machine, each at most 16 KiB (the relay limit).
const MAX_DOCUMENTS = 256;

const sameEntry = (a: AliasEntry, b: AliasEntry): boolean => a.alias === b.alias && a.uuid === b.uuid;

/**
 * Verifies what the page signed, installs the list on this machine, then delivers like `machine admin alias send` (`put`: direct first, then the relay inbox).
 * Payload: exactly `{ signed, documents }`; any other field is refused. Nothing is installed or sent when a check fails. Once installed it stands: a failed delivery
 * is part of the answer with the retry command, never an undo.
 */
export async function aliasesApply(
  configDir: string,
  payload: unknown,
  now: number,
  options: { client?: RelayClient; /** Tries the peer channel before the inbox (decision 86). Absent: the inbox only. */ direct?: DirectDelivery } = {},
): Promise<AliasesApplyAnswer> {
  const p = typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : undefined;
  if (p === undefined || Object.keys(p).some((k) => !FIELDS.includes(k)) || FIELDS.some((k) => p[k] === undefined)) return fail('bad-payload', BAD_PAYLOAD);
  const documents = p['documents'];
  if (typeof p['signed'] !== 'object' || p['signed'] === null || Array.isArray(p['signed'])) return fail('bad-payload', `"signed" is not a signed aliases list: ${BAD_PAYLOAD}`);
  if (!Array.isArray(documents) || documents.length > MAX_DOCUMENTS) return fail('bad-payload', `"documents" must be a list of at most ${MAX_DOCUMENTS} signed documents: ${BAD_PAYLOAD}`);

  if (!existsSync(adminKeyFile(configDir))) return notAdminHere(configDir);
  const self = selfOf(configDir);
  if ('ok' in self) return self;
  const pin = readAdminPin(configDir);
  const nothing = 'Nothing was installed or delivered';
  const reload = `${nothing}. Reload the page and change the aliases again`;

  let signed: SignedAliases;
  try {
    signed = canonicalSignedAliases(p['signed']);
  } catch (e) {
    return fail('bad-aliases', `the aliases list is refused (${(e as Error).message}). ${nothing}`);
  }
  const verified = verifyAliases(signed, { adminPublicKey: pin.adminPublicKey });
  if (!verified.ok) {
    return fail('bad-aliases', `the aliases list is refused (${verified.reason}): ${verified.message}. The page unlocked another key than the one pinned on this machine, or the list was altered. ${nothing}`);
  }
  let stored: SignedAliases | undefined;
  try {
    stored = readAliasesList(configDir, pin.adminPublicKey);
  } catch (e) {
    return fail('aliases-invalid', `${(e as Error).message}. ${nothing}`);
  }
  if (compareAliases(stored, signed) !== 'newer') {
    return fail(
      'stale-aliases',
      `the aliases list the page signed (serial ${signed.body.serial}) does not replace the one on this machine (serial ${stored?.body.serial}): the network aliases changed since the page read them. ${reload}`,
    );
  }

  // The change: exactly one alias added or removed on top of what is stored, and accepted by the planner of this machine with what it holds.
  const before = stored?.body.entries ?? [];
  const after = signed.body.entries;
  const added = after.filter((e) => !before.some((b) => sameEntry(b, e)));
  const removed = before.filter((b) => !after.some((e) => sameEntry(b, e)));
  if (added.length + removed.length !== 1) {
    return fail(
      'bad-aliases',
      `the aliases list changes ${added.length + removed.length} aliases (${[...added.map((e) => `+${e.alias}`), ...removed.map((e) => `-${e.alias}`)].join(', ') || 'none'}): one change at a time, exactly one alias added or removed. ${reload}`,
    );
  }
  const change: AliasChange = added[0] !== undefined ? { action: 'set', alias: added[0].alias, uuid: added[0].uuid } : { action: 'rm', alias: (removed[0] as AliasEntry).alias };
  const machines = machinesOf(configDir, self, now);
  const plan = planAliasChange({ change, current: before, machines, revoked: installedRevocations(configDir).map((e) => e.uuid) });
  if (!plan.ok) return fail('refused', `${plan.message}. ${nothing}`);
  if (plan.alias !== change.alias || JSON.stringify(plan.entries) !== JSON.stringify(after)) {
    return fail('bad-aliases', `the aliases list is not the one this machine plans for that change (a label is lowercase letters, digits and hyphens, the list sorted by alias, nothing else changed). ${reload}`);
  }

  // What this change needs, derived HERE from what this machine holds (the page is not trusted for ids): one document per trusted machine, this one excluded.
  const recipients = trustedRegistrations(configDir, now).filter((r) => r.body.uuid !== self.uuid);
  const expected = new Map<string, { uuid: string; name: string }>();
  for (const r of recipients) expected.set(`${r.body.uuid}:${documentId(`v2:aliases:${r.body.uuid}:${signed.body.serial}:${signed.signature}`)}`, { uuid: r.body.uuid, name: r.body.name });
  const received = new Map<string, SignedDocument>();
  for (const raw of documents) {
    const addressee = (raw as { body?: { to?: unknown } } | null)?.body?.to;
    const envelope = verifyDocumentEnvelope(raw, { adminPublicKey: pin.adminPublicKey, selfUuid: typeof addressee === 'string' ? addressee : '', now });
    if (!envelope.ok) return fail('bad-document', `a document is refused (${envelope.reason}): ${envelope.message}. ${reload}`);
    const key = `${envelope.body.to}:${envelope.body.id}`;
    if (!expected.has(key) || envelope.kind !== 'aliases') {
      return fail(
        'bad-document',
        `document ${envelope.body.id} (${envelope.kind}, for machine ${envelope.body.to}) is not one this list needs: the page and this machine disagree about who is trusted here, or the document was altered. ${reload}`,
      );
    }
    if (received.has(key)) return fail('bad-document', `document ${envelope.body.id} was sent twice. ${reload}`);
    if (envelope.body.expiresAt - envelope.body.issuedAt > DOCUMENT_RETENTION_SECONDS) return fail('bad-document', `document ${envelope.body.id} lives longer than the relay keeps it. ${nothing}`);
    received.set(key, raw as SignedDocument);
  }

  // Everything checks out: the list is installed HERE first, whatever happens to the delivery.
  try {
    installAliases(configDir, signed, pin.adminPublicKey);
  } catch (e) {
    return fail('refused', `${(e as Error).message}. ${nothing}`);
  }
  const report = emptyReport();
  report.machines = recipients.length;
  const told = [...expected.values()];
  const notSent: DistributionFailure[] = [];
  const items: RetainedItem[] = [];
  for (const [key, to] of expected) {
    const document = received.get(key);
    if (document === undefined) {
      notSent.push({ toUuid: to.uuid, toName: to.name, kind: 'aliases', id: undefined, message: 'the page did not send the aliases document for this machine (it could not be built, or it was dropped): it was not delivered' });
    } else {
      items.push({ to, kind: 'aliases', document });
    }
  }
  const remaining: RetainedItem[] = [];
  const subject = { uuid: NETWORK_ALIASES_SUBJECT_UUID, name: 'the network aliases' };
  const finish = (): AliasesApplyAnswer => {
    const text = formatDistribution(report, 'the network aliases', RETRY_ALIASES);
    const machinesOut = deliveryMachines(report, told, RETRY_ALIASES);
    keepForRetry(configDir, { kind: 'aliases', subject, told, retry: RETRY_ALIASES, items: remaining, persistent: notSent, removal: undefined, machines: machinesOut });
    const entries = after.map((e) => {
      const name = machines.find((m) => m.uuid === e.uuid)?.name;
      return { alias: e.alias, uuid: e.uuid, ...(name === undefined ? {} : { name }) };
    });
    return { ok: true, serial: signed.body.serial, entries, changed: true, failed: text.failed, report, text: { out: text.out, err: text.err }, machines: machinesOut, retry: RETRY_ALIASES };
  };

  const access = adminRelayAccess(configDir, options.client);
  if (access === undefined) {
    report.aborted = true;
    report.failures.push({
      toUuid: self.uuid,
      toName: 'this machine',
      kind: 'machine',
      id: undefined,
      message: `the network aliases were NOT distributed: ${missingAdminTokenMessage(configDir, readRelayConfig(configDir)?.relayUrl)}`,
    });
    // Nothing was attempted: every document is kept, and the machines are told as not stored.
    remaining.push(...items);
    for (const to of told) report.failures.push({ toUuid: to.uuid, toName: to.name, kind: 'machine', id: undefined, message: 'not told: no admin relay token' });
    return finish();
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
