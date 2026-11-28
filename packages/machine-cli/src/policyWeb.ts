import { existsSync, readFileSync } from 'node:fs';
import {
  assertPolicyBody,
  canonicalize,
  canonicalSignedNoticeRecipients,
  compareNoticeRecipients,
  DOCUMENT_RETENTION_SECONDS,
  documentId,
  POLICY_DOMAIN,
  resolveMachineRef,
  verifyDocument,
  verifyDocumentEnvelope,
  verifyNoticeRecipients,
  type Json,
  type PolicyMode,
  type SignedDocument,
  type SignedNoticeRecipients,
  type SignedPolicy,
} from '@wadeck-app/machine-core';
import { adminKeyFile, readAdminPin } from './admin.js';
import { policyRecordFile, readPolicyRecord, recordSignedPolicy } from './adminAllow.js';
import { adminRelayError } from './adminRelay.js';
import { missingAdminTokenMessage } from './adminApprove.js';
import { describeAttempt, describeDirect, type DirectCode, type DirectDelivery } from './directDelivery.js';
import { adminRelayAccess } from './distribute.js';
import { exportMachineInfo, installPolicy, loadNetwork } from './network.js';
import { recordNoticeSent } from './noticeRecipientsSent.js';
import { installNoticeRecipients, readNoticeRecipients } from './noticeRecipientsStore.js';
import { readPolicyMode, policyFiles } from './policyMode.js';
import { RelayError, type RelayClient } from './relayClient.js';
import { readRelayConfig } from './relayStore.js';
import { networkAliasMap } from './aliasesStore.js';
import { readAliases } from './state.js';

// The daemon side of the Allow button of the Requests page (decision 76, requests.md). The admin key and its passphrase live ONLY in the browser:
// the page unlocks the encrypted key file (`adminKeyText`), builds and signs the next policy itself (machine-webcrypto), and sends back only
// signed documents (`submitPolicy`). Nothing here ever receives a passphrase or an unlocked key, and nothing here signs.
//
// What this side still does, because hard rule 4 and the daemon of the target do not trust the page: it verifies the admin signature against the
// pinned key, the target, the compare-and-set of the base version and (for another machine) the inbox document, and only then stores and delivers
// exactly like `machine admin allow` (recordSignedPolicy, installPolicy for this machine, the relay inbox for another one).

export type Failure = { ok: false; reason: string; message: string };
const fail = (reason: string, message: string): Failure => ({ ok: false, reason, message });

const KEY_FILE_FIELDS = ['v', 'publicKey', 'hint', 'kdf', 'cipher', 'ciphertext'];

/** The encrypted admin key file, as it is on disk, for the page to unlock in the browser. Refuses anything that is not an encrypted envelope. */
export function adminKeyText(configDir: string): { ok: true; file: string } | Failure {
  const path = adminKeyFile(configDir);
  if (!existsSync(path)) {
    return fail('no-admin-key', `this machine has no admin key (${path} does not exist): the page can only sign on the machine that holds the admin key (\`machine admin init\` there), nothing was read`);
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return fail('key-file-invalid', `cannot read ${path}: ${(e as Error).message}`);
  }
  const invalid = (why: string) => fail('key-file-invalid', `${path} is not served: ${why}. Copy the admin key file again from another machine`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid('it is corrupt or invalid (not valid JSON)');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return invalid('it is not an admin key file');
  const envelope = parsed as Record<string, unknown>;
  // Only an encrypted envelope leaves the disk: an unexpected field could be a plain key, so the whole file is refused (the value is never echoed).
  const extra = Object.keys(envelope).find((k) => !KEY_FILE_FIELDS.includes(k));
  if (extra !== undefined) return invalid(`it has an unexpected field "${extra}", it is not the encrypted format`);
  const kdf = envelope['kdf'] as { name?: unknown } | undefined;
  const cipher = envelope['cipher'] as { name?: unknown } | undefined;
  if ((envelope['v'] !== 1 && envelope['v'] !== 2) || typeof envelope['publicKey'] !== 'string' || typeof envelope['ciphertext'] !== 'string' || kdf?.name !== 'pbkdf2-sha256' || cipher?.name !== 'aes-256-gcm') {
    return invalid('it is not an encrypted admin key (version, kdf or cipher missing)');
  }
  return { ok: true, file: text };
}

export interface AllowContextOk {
  ok: true;
  /** `identityPublicKey`: the key of the target from the registration this admin holds; the page seals the inbox document to it (decision 78). */
  target: { uuid: string; name: string; identityPublicKey: string };
  /** The target is this machine: the policy is installed here, no relay is involved. */
  toSelf: boolean;
  policyMode: PolicyMode;
  /** The pinned admin key: the page checks that the key it unlocks is this one. */
  adminKeyId: string;
  adminPublicKey: string;
  /** The signed policy the next one is edited from (null: none is on record, the next one is version 1). The page re-verifies its signature. */
  current: SignedPolicy | null;
  source: 'installed on this machine' | 'the last one signed here';
  delivery: 'install' | 'inbox';
  /**
   * Another machine only (request-notices.md): the list of machines that receive request notices, stored on this admin machine (null: none yet) and this machine's
   * uuid. The page seals the stored list for the target, or signs `[selfUuid]` when there is none, in the same unlock as the policy.
   */
  noticeRecipients?: { selfUuid: string; current: SignedNoticeRecipients | null };
}

/** A machine the admin can address: the identity key is the one of its registration, the key an inbox document for it is sealed to (decision 78). */
interface Addressee {
  uuid: string;
  name: string;
  identityPublicKey: string;
}

/** The names the target of a policy can be reached by, from this machine, with the identity key of each. */
function everyone(configDir: string, now: number): Addressee[] {
  const self = exportMachineInfo(configDir);
  const network = loadNetwork(configDir, now);
  const peers: Addressee[] = [];
  for (const machine of network.directory.machines()) {
    const peer = network.directory.find(machine.uuid);
    if (peer !== undefined) {
      peers.push({ uuid: machine.uuid, name: machine.name, identityPublicKey: peer.identityPublicKey });
    }
  }
  return [{ uuid: self.uuid, name: self.name, identityPublicKey: self.identityPublicKey }, ...peers];
}

function resolveTarget(configDir: string, reference: string, now: number): { ok: true; target: Addressee; toSelf: boolean } | Failure {
  const machines = everyone(configDir, now);
  const resolved = resolveMachineRef(reference, machines, readAliases(configDir), networkAliasMap(configDir));
  if (!resolved.ok) return fail('unknown-machine', `${resolved.message} (see \`machine list\`)`);
  const target = machines.find((m) => m.uuid === resolved.uuid) as Addressee;
  return { ok: true, target, toSelf: target.uuid === exportMachineInfo(configDir).uuid };
}

/** The admin line of THIS machine's own installed policy, verified like loadNetwork does. */
function readInstalledPolicy(configDir: string, adminPublicKey: string): SignedPolicy | undefined {
  const file = policyFiles(configDir, 'admin').policy;
  if (!existsSync(file)) return undefined;
  let signed: SignedPolicy;
  try {
    signed = JSON.parse(readFileSync(file, 'utf8')) as SignedPolicy;
    assertPolicyBody(signed.body);
  } catch (e) {
    throw new Error(`${file} is not a valid policy (${(e as Error).message}): reinstall one with \`machine policy install <file>\``);
  }
  if (!verifyDocument(POLICY_DOMAIN, signed.body as unknown as Json, adminPublicKey, signed.signature)) {
    throw new Error(`${file} does not match the admin key of this machine: reinstall one with \`machine policy install <file>\``);
  }
  return signed;
}

type Base = { ok: true; current: SignedPolicy | undefined; source: AllowContextOk['source'] } | Failure;

function baseOf(configDir: string, target: { uuid: string; name: string }, toSelf: boolean, adminPublicKey: string): Base {
  try {
    if (toSelf) return { ok: true, current: readInstalledPolicy(configDir, adminPublicKey), source: 'installed on this machine' };
    return { ok: true, current: readPolicyRecord(configDir, target.uuid, adminPublicKey), source: 'the last one signed here' };
  } catch (e) {
    return fail('policy-record-invalid', (e as Error).message);
  }
}

const modeProblem = (target: { name: string }): Failure =>
  fail('mode-local', `"${target.name}" manages its own allow list (policy mode local): an admin signature would be refused there. Run \`machine policy allow -- <command>\` on that machine, or \`machine policy delegate\` there to give the list back to the admin first. Nothing was signed`);

function readMode(configDir: string): PolicyMode | Failure {
  try {
    return readPolicyMode(configDir).mode;
  } catch (e) {
    return fail('policy-mode-invalid', (e as Error).message);
  }
}

const notAdminHere = (configDir: string): Failure =>
  fail('no-admin-key', `this machine has no admin key (${adminKeyFile(configDir)} does not exist): run this on the machine that holds the admin key (\`machine setup <relay>\` creates it). The page cannot sign here`);

/**
 * Everything the page needs BEFORE it asks the passphrase: the target, the policy it is edited from, who verifies it and where it goes.
 * A problem that no passphrase can fix (no admin key here, mode local, no admin relay token for another machine) is answered here, so nobody
 * types a passphrase for nothing.
 */
export function allowContext(configDir: string, payload: unknown, now: number): AllowContextOk | Failure {
  const reference = typeof payload === 'object' && payload !== null ? (payload as { machine?: unknown }).machine : undefined;
  if (typeof reference !== 'string' || reference.length === 0) return fail('bad-payload', 'expected {"machine": "<name, alias or uuid>"}');
  if (!existsSync(adminKeyFile(configDir))) return notAdminHere(configDir);
  const pin = readAdminPin(configDir);
  const resolved = resolveTarget(configDir, reference, now);
  if (!resolved.ok) return resolved;
  const { target, toSelf } = resolved;
  const mode = readMode(configDir);
  if (typeof mode !== 'string') return mode;
  if (toSelf && mode === 'local') return modeProblem(target);
  if (!toSelf && adminRelayAccess(configDir) === undefined) {
    return fail('no-admin-token', `${missingAdminTokenMessage(configDir, readRelayConfig(configDir)?.relayUrl)}. Nothing was signed`);
  }
  const base = baseOf(configDir, target, toSelf, pin.adminPublicKey);
  if (!base.ok) return base;
  let noticeRecipients: AllowContextOk['noticeRecipients'];
  if (!toSelf) {
    try {
      noticeRecipients = { selfUuid: exportMachineInfo(configDir).uuid, current: readNoticeRecipients(configDir, pin.adminPublicKey) ?? null };
    } catch (e) {
      return fail('notice-recipients-invalid', `${(e as Error).message}. Nothing was signed`);
    }
  }
  return {
    ok: true,
    target,
    toSelf,
    policyMode: mode,
    adminKeyId: pin.adminKeyId,
    adminPublicKey: pin.adminPublicKey,
    current: base.current ?? null,
    source: base.source,
    delivery: toSelf ? 'install' : 'inbox',
    ...(noticeRecipients === undefined ? {} : { noticeRecipients }),
  };
}

export type SubmitAnswer =
  | {
      ok: true;
      target: { uuid: string; name: string };
      version: number;
      /** `installed`: this machine is the target. `direct`: the target took the document over the peer channel (decision 86). `inbox`: stored in the relay inbox. */
      delivery: 'installed' | 'direct' | 'inbox';
      /** How the delivery reads for a person, in the words of the CLI (the page shows it as it is): the success colour for an installation, the warning colour for the relay inbox. */
      deliveryText?: { tone: 'success' | 'warning'; text: string };
      /** The same policy was already installed here, or the target already had it (direct), or the relay already held the document. */
      alreadyThere?: true;
      /** `delivery` direct: what the target answered and how long it took. */
      direct?: { outcome: 'installed' | 'already-installed'; ms: number };
      /** `delivery` inbox after a direct attempt: why the target was not reached directly. Absent when no direct attempt was made. */
      fallback?: { code: DirectCode; cause: string };
      /** The list of notice recipients, sent with the policy to another machine. `failed`: the policy went through, the list did not (`noticeRecipientsMessage` says how to send it). */
      noticeRecipients?: 'sent' | 'already-there' | 'failed';
      noticeRecipientsPath?: 'direct' | 'inbox';
      noticeRecipientsMessage?: string;
    }
  | (Failure & { recorded?: true });

const installedText = (name: string): { tone: 'success'; text: string } => ({ tone: 'success', text: `Installed on ${name} (this machine)` });
const inboxText = (name: string): string => `Stored in the relay inbox of ${name}: it installs it at its next poll (within 60 s, or 5 s while it holds a request)`;

const BAD_PAYLOAD = 'expected {"policy": <signed policy>, "document": <signed inbox document, for another machine>, "noticeRecipients": {"signed": <signed list>, "document": <signed inbox document>}}: the page signs them in the browser';

/**
 * The signed policy (and, for another machine, the signed inbox document) the page produced. Verified against the pinned admin key and the
 * current version, then stored and delivered like `machine admin allow`. `client` is for tests.
 */
export async function submitPolicy(configDir: string, payload: unknown, now: number, options: { client?: RelayClient; /** Tries the peer channel before the inbox (decision 86). Absent: the inbox only. */ direct?: DirectDelivery } = {}): Promise<SubmitAnswer> {
  const p = typeof payload === 'object' && payload !== null ? (payload as { policy?: unknown; document?: unknown; noticeRecipients?: unknown }) : {};
  const policy = p.policy as SignedPolicy | undefined;
  if (typeof policy !== 'object' || policy === null || typeof policy.body !== 'object' || policy.body === null || typeof policy.signature !== 'string') return fail('bad-payload', BAD_PAYLOAD);
  try {
    assertPolicyBody(policy.body);
  } catch (e) {
    return fail('bad-payload', `the policy is not valid: ${(e as Error).message}`);
  }
  let listPayload: { signed: unknown; document: unknown } | undefined;
  if (p.noticeRecipients !== undefined) {
    const raw: Record<string, unknown> | undefined = typeof p.noticeRecipients === 'object' && p.noticeRecipients !== null && !Array.isArray(p.noticeRecipients) ? Object.fromEntries(Object.entries(p.noticeRecipients)) : undefined;
    if (raw === undefined || Object.keys(raw).some((k) => k !== 'signed' && k !== 'document') || raw['signed'] === undefined || raw['document'] === undefined) {
      return fail('bad-payload', `"noticeRecipients" must be exactly {"signed": <signed list>, "document": <signed inbox document>}, nothing else: ${BAD_PAYLOAD}`);
    }
    listPayload = { signed: raw['signed'], document: raw['document'] };
  }
  if (!existsSync(adminKeyFile(configDir))) return notAdminHere(configDir);
  const pin = readAdminPin(configDir);
  if (!verifyDocument(POLICY_DOMAIN, policy.body as unknown as Json, pin.adminPublicKey, policy.signature) || policy.body.adminKeyId !== pin.adminKeyId) {
    return fail('bad-signature', 'the policy is not signed by the admin key pinned on this machine (the page unlocked another key, or the document was altered). Nothing was stored or sent');
  }
  const resolved = resolveTarget(configDir, policy.body.target, now);
  if (!resolved.ok) return fail('unknown-machine', `the policy is written for ${policy.body.target}, which is not this machine nor a trusted peer of it (see \`machine list\`). Nothing was stored or sent`);
  const { target, toSelf } = resolved;
  const mode = readMode(configDir);
  if (typeof mode !== 'string') return mode;
  if (toSelf && mode === 'local') return modeProblem(target);

  // Compare-and-set (decision 27): the page edited the version it read; if the policy moved since, it must read again.
  const base = baseOf(configDir, target, toSelf, pin.adminPublicKey);
  if (!base.ok) return base;
  const currentVersion = base.current?.body.version ?? 0;
  // The very policy that is on record: a retry (the relay failed the first time, or the page was clicked twice). It is not a stale edit.
  const isRetry = base.current !== undefined && canonicalize(base.current as unknown as Json) === canonicalize(policy as unknown as Json);
  if (isRetry && toSelf) return { ok: true, target, version: policy.body.version, delivery: 'installed', alreadyThere: true, deliveryText: installedText(target.name) };
  if (!isRetry && policy.body.baseVersion !== currentVersion) {
    return fail('stale-base', `the policy of "${target.name}" is at version ${currentVersion} (${base.source}), and this one was edited from version ${policy.body.baseVersion}: reload the page and allow it again. Nothing was stored or sent`);
  }

  let access: ReturnType<typeof adminRelayAccess>;
  let document: SignedDocument | undefined;
  if (!toSelf) {
    access = adminRelayAccess(configDir, options.client);
    if (access === undefined) return fail('no-admin-token', `${missingAdminTokenMessage(configDir, readRelayConfig(configDir)?.relayUrl)}. Nothing was stored or sent`);
    const refusal = checkDocument(p.document, policy, pin.adminPublicKey, target.uuid, now);
    if (typeof refusal !== 'string') document = refusal;
    else return fail('bad-document', refusal);
  }
  let list: CheckedList | undefined;
  if (listPayload !== undefined) {
    if (toSelf) {
      return fail('bad-payload', 'a list of notice recipients was sent with a policy for THIS machine: it is sent to another machine only. Nothing was stored or sent');
    }
    const checked = checkNoticeRecipients(configDir, listPayload, pin.adminPublicKey, target.uuid, now);
    if ('ok' in checked) {
      return checked;
    }
    list = checked;
  }

  if (toSelf) {
    try {
      installPolicy(configDir, policy, { now });
    } catch (e) {
      return fail('refused', (e as Error).message);
    }
    recordSignedPolicy(configDir, policy);
    return { ok: true, target, version: policy.body.version, delivery: 'installed', deliveryText: installedText(target.name) };
  }

  // The record first, like the CLI: the next edit starts from it, and `machine admin distribute --policy` can resend it.
  recordSignedPolicy(configDir, policy);
  // Direct delivery first (decision 86): the very same sealed document, straight to the target. Only an acknowledged installation counts.
  const attempt = options.direct === undefined ? undefined : await options.direct(target, document as SignedDocument);
  if (attempt?.ok === true) {
    const answer = {
      ok: true as const,
      target,
      version: policy.body.version,
      delivery: 'direct' as const,
      direct: { outcome: attempt.outcome, ms: attempt.ms },
      deliveryText: { tone: 'success' as const, text: describeDirect(target.name, attempt.outcome, attempt.ms) },
      ...(attempt.outcome === 'already-installed' ? { alreadyThere: true as const } : {}),
    };
    return list === undefined ? answer : { ...answer, ...(await deliverList(configDir, (access as NonNullable<typeof access>).client, target, list, pin.adminPublicKey, now, options.direct)) };
  }
  const fallback = {
    ...(attempt === undefined || attempt.ok ? {} : { fallback: { code: attempt.code, cause: attempt.cause } }),
    deliveryText: { tone: 'warning' as const, text: attempt === undefined || attempt.ok ? inboxText(target.name) : describeAttempt(target.name, attempt) },
  };
  try {
    await (access as NonNullable<typeof access>).client.putInboxDocument(target.uuid, document as SignedDocument);
    const answer = { ok: true as const, target, version: policy.body.version, delivery: 'inbox' as const, ...fallback };
    return list === undefined ? answer : { ...answer, ...(await deliverList(configDir, (access as NonNullable<typeof access>).client, target, list, pin.adminPublicKey, now, options.direct)) };
  } catch (raw) {
    if (raw instanceof RelayError && raw.code === 'id_conflict') return { ok: true, target, version: policy.body.version, delivery: 'inbox', alreadyThere: true, ...fallback };
    const message = (adminRelayError(raw) as Error).message;
    return { ...fail('relay-error', `the policy is signed and recorded (version ${policy.body.version}) but the relay did not store it for "${target.name}": ${message}. Run \`machine admin distribute --policy ${policyRecordFile(configDir, target.uuid)}\` to send it again; it is safe to run again`), recorded: true };
  }
}

/**
 * The inbox document must be the one a policy of this admin needs. It is sealed to the target (decision 78), so this machine CANNOT open it and does
 * not try: it checks what the envelope shows (admin signature, version 2, addressed to the target, kind policy, time window, one sealed blob), that
 * the id is the one derived from THIS policy (target, version, signature: the rule of `distributePolicy`) and that it does not outlive the relay
 * retention. What is inside the sealed blob is the browser's word: the target opens it and checks the policy again itself (admin signature, target,
 * base version), so a page that sealed another policy gets it refused there, never installed.
 */
function checkDocument(raw: unknown, policy: SignedPolicy, adminPublicKey: string, targetUuid: string, now: number): SignedDocument | string {
  if (raw === undefined) return `the inbox document is missing: ${BAD_PAYLOAD}. Nothing was stored or sent`;
  const checked = verifyDocumentEnvelope(raw, { adminPublicKey, selfUuid: targetUuid, now });
  if (!checked.ok) return `the inbox document is refused (${checked.reason}): ${checked.message}. Nothing was stored or sent`;
  const expectedId = documentId(`v2:policy:${policy.body.target}:${policy.body.version}:${policy.signature}`);
  if (checked.kind !== 'policy' || checked.body.id !== expectedId) {
    return 'the inbox document does not carry the policy that was signed (its kind or id is not the one of this policy): the page and this machine disagree. Nothing was stored or sent';
  }
  if (checked.body.expiresAt - checked.body.issuedAt > DOCUMENT_RETENTION_SECONDS) return 'the inbox document lives longer than the relay keeps it. Nothing was stored or sent';
  return raw as SignedDocument;
}

interface CheckedList {
  signed: SignedNoticeRecipients;
  document: SignedDocument;
}

/**
 * The list of notice recipients the page signed (request-notices.md): the same checks as an inbox of the target would make on the envelope, plus the replace-newer
 * rule against the list stored here. Everything is refused BEFORE the policy is recorded, so a bad list never leaves a half-done Allow.
 */
function checkNoticeRecipients(configDir: string, raw: { signed: unknown; document: unknown }, adminPublicKey: string, targetUuid: string, now: number): CheckedList | Failure {
  const refuse = (why: string): Failure => fail('bad-notice-recipients', `the list of notice recipients is refused (${why}). Nothing was stored or sent`);
  let signed: SignedNoticeRecipients;
  try {
    signed = canonicalSignedNoticeRecipients(raw.signed);
  } catch (e) {
    return refuse((e as Error).message);
  }
  const verified = verifyNoticeRecipients(signed, { adminPublicKey });
  if (!verified.ok) {
    return refuse(`${verified.reason}: ${verified.message}`);
  }
  const envelope = verifyDocumentEnvelope(raw.document, { adminPublicKey, selfUuid: targetUuid, now });
  if (!envelope.ok) {
    return refuse(`the inbox document: ${envelope.reason}: ${envelope.message}`);
  }
  const expectedId = documentId(`v2:notice-recipients:${targetUuid}:${signed.body.serial}:${signed.signature}`);
  if (envelope.kind !== 'notice-recipients' || envelope.body.id !== expectedId) {
    return refuse('the inbox document does not carry that list (its kind or id is not the one of this list): the page and this machine disagree');
  }
  if (envelope.body.expiresAt - envelope.body.issuedAt > DOCUMENT_RETENTION_SECONDS) {
    return refuse('the inbox document lives longer than the relay keeps it');
  }
  let stored: SignedNoticeRecipients | undefined;
  try {
    stored = readNoticeRecipients(configDir, adminPublicKey);
  } catch (e) {
    return fail('notice-recipients-invalid', `${(e as Error).message}. Nothing was stored or sent`);
  }
  const order = compareNoticeRecipients(stored, signed);
  if (order === 'older' || (order === 'same' && stored !== undefined && stored.signature !== signed.signature)) {
    return fail('stale-notice-recipients', `this machine already holds a list of notice recipients (serial ${stored?.body.serial}) that this one (serial ${signed.body.serial}) does not replace: reload the page and allow it again. Nothing was stored or sent`);
  }
  return { signed, document: raw.document as SignedDocument };
}

/**
 * After the policy went through: keep the list as the list of this admin machine (replace-newer), send it, record what was sent. A failure here never undoes
 * the policy: it is said, with the command that sends the list again.
 */
async function deliverList(
  configDir: string,
  client: RelayClient,
  target: { uuid: string; name: string },
  list: CheckedList,
  adminPublicKey: string,
  now: number,
  direct?: DirectDelivery,
): Promise<{ noticeRecipients: 'sent' | 'already-there' | 'failed'; noticeRecipientsPath?: 'direct' | 'inbox'; noticeRecipientsMessage?: string }> {
  const again = 'machine admin notify-to <machines that receive the notices>';
  const failed = (message: string): { noticeRecipients: 'failed'; noticeRecipientsMessage: string } => ({
    noticeRecipients: 'failed',
    noticeRecipientsMessage: `${message}. The policy stands. Run \`${again}\` to send the list; it is safe to run again`,
  });
  try {
    installNoticeRecipients(configDir, list.signed, adminPublicKey);
  } catch (e) {
    return failed(`the list could not be kept on this machine (${(e as Error).message})`);
  }
  let outcome: 'sent' | 'already-there' = 'sent';
  let problem: string | undefined;
  let path: 'direct' | 'inbox' = 'inbox';
  const attempt = direct === undefined ? undefined : await direct(target, list.document);
  if (attempt?.ok === true) {
    path = 'direct';
  } else {
    try {
      await client.putInboxDocument(target.uuid, list.document);
    } catch (raw) {
      if (raw instanceof RelayError && raw.code === 'id_conflict') {
        outcome = 'already-there';
      } else {
        problem = `the relay did not store the list for "${target.name}": ${(adminRelayError(raw) as Error).message}`;
      }
    }
  }
  let recordProblem: string | undefined;
  try {
    recordNoticeSent(configDir, target.uuid, { serial: list.signed.body.serial, at: now, stored: problem === undefined });
  } catch (e) {
    recordProblem = (e as Error).message;
  }
  if (problem !== undefined) {
    return failed(problem);
  }
  return { noticeRecipients: outcome, noticeRecipientsPath: path, ...(recordProblem === undefined ? {} : { noticeRecipientsMessage: `the record of what was sent could not be written: ${recordProblem}` }) };
}
