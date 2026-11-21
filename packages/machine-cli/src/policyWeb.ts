import { existsSync, readFileSync } from 'node:fs';
import {
  assertPolicyBody,
  canonicalize,
  DOCUMENT_RETENTION_SECONDS,
  POLICY_DOMAIN,
  resolveMachineRef,
  verifyDocument,
  verifyInboxDocument,
  type Json,
  type PolicyMode,
  type SignedDocument,
  type SignedPolicy,
} from '@wadeck-app/machine-core';
import { adminKeyFile, readAdminPin } from './admin.js';
import { policyRecordFile, readPolicyRecord, recordSignedPolicy } from './adminAllow.js';
import { adminRelayError } from './adminRelay.js';
import { missingAdminTokenMessage } from './adminApprove.js';
import { adminRelayAccess } from './distribute.js';
import { exportMachineInfo, installPolicy, loadNetwork } from './network.js';
import { readPolicyMode, policyFiles } from './policyMode.js';
import { RelayError, type RelayClient } from './relayClient.js';
import { readRelayConfig } from './relayStore.js';
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
  target: { uuid: string; name: string };
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
}

/** The names the target of a policy can be reached by, from this machine. */
function everyone(configDir: string, now: number): { uuid: string; name: string }[] {
  const self = exportMachineInfo(configDir);
  return [{ uuid: self.uuid, name: self.name }, ...loadNetwork(configDir, now).directory.machines()];
}

function resolveTarget(configDir: string, reference: string, now: number): { ok: true; target: { uuid: string; name: string }; toSelf: boolean } | Failure {
  const machines = everyone(configDir, now);
  const resolved = resolveMachineRef(reference, machines, readAliases(configDir));
  if (!resolved.ok) return fail('unknown-machine', `${resolved.message} (see \`machine list\`)`);
  const target = machines.find((m) => m.uuid === resolved.uuid) as { uuid: string; name: string };
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
  };
}

export type SubmitAnswer =
  | { ok: true; target: { uuid: string; name: string }; version: number; delivery: 'installed' | 'inbox'; /** The same policy was already installed here, or the relay already held the document. */ alreadyThere?: true }
  | (Failure & { recorded?: true });

const BAD_PAYLOAD = 'expected {"policy": <signed policy>, "document": <signed inbox document, for another machine>}: the page signs both in the browser';

/**
 * The signed policy (and, for another machine, the signed inbox document) the page produced. Verified against the pinned admin key and the
 * current version, then stored and delivered like `machine admin allow`. `client` is for tests.
 */
export async function submitPolicy(configDir: string, payload: unknown, now: number, options: { client?: RelayClient } = {}): Promise<SubmitAnswer> {
  const p = typeof payload === 'object' && payload !== null ? (payload as { policy?: unknown; document?: unknown }) : {};
  const policy = p.policy as SignedPolicy | undefined;
  if (typeof policy !== 'object' || policy === null || typeof policy.body !== 'object' || policy.body === null || typeof policy.signature !== 'string') return fail('bad-payload', BAD_PAYLOAD);
  try {
    assertPolicyBody(policy.body);
  } catch (e) {
    return fail('bad-payload', `the policy is not valid: ${(e as Error).message}`);
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
  if (isRetry && toSelf) return { ok: true, target, version: policy.body.version, delivery: 'installed', alreadyThere: true };
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

  if (toSelf) {
    try {
      installPolicy(configDir, policy, { now });
    } catch (e) {
      return fail('refused', (e as Error).message);
    }
    recordSignedPolicy(configDir, policy);
    return { ok: true, target, version: policy.body.version, delivery: 'installed' };
  }

  // The record first, like the CLI: the next edit starts from it, and `machine admin distribute --policy` can resend it.
  recordSignedPolicy(configDir, policy);
  try {
    await (access as NonNullable<typeof access>).client.putInboxDocument(target.uuid, document as SignedDocument);
    return { ok: true, target, version: policy.body.version, delivery: 'inbox' };
  } catch (raw) {
    if (raw instanceof RelayError && raw.code === 'id_conflict') return { ok: true, target, version: policy.body.version, delivery: 'inbox', alreadyThere: true };
    const message = (adminRelayError(raw) as Error).message;
    return { ...fail('relay-error', `the policy is signed and recorded (version ${policy.body.version}) but the relay did not store it for "${target.name}": ${message}. Run \`machine admin distribute --policy ${policyRecordFile(configDir, target.uuid)}\` to send it again; it is safe to run again`), recorded: true };
  }
}

/** The inbox document must be the one a policy of this admin needs: admin signature, addressed to the target, carrying exactly this policy. */
function checkDocument(raw: unknown, policy: SignedPolicy, adminPublicKey: string, targetUuid: string, now: number): SignedDocument | string {
  if (raw === undefined) return `the inbox document is missing: ${BAD_PAYLOAD}. Nothing was stored or sent`;
  const checked = verifyInboxDocument(raw, { adminPublicKey, selfUuid: targetUuid, now });
  if (!checked.ok) return `the inbox document is refused (${checked.reason}): ${checked.message}. Nothing was stored or sent`;
  if (checked.kind !== 'policy' || canonicalize(checked.policy as unknown as Json) !== canonicalize(policy as unknown as Json)) {
    return 'the inbox document does not carry the policy that was signed: the page and this machine disagree. Nothing was stored or sent';
  }
  if (checked.body.expiresAt - checked.body.issuedAt > DOCUMENT_RETENTION_SECONDS) return 'the inbox document lives longer than the relay keeps it. Nothing was stored or sent';
  return raw as SignedDocument;
}
