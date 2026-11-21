import {
  commandTextProblem,
  nextNoticeRecipientsBody,
  nextPolicyBody,
  parseLifetime,
  sealedNoticeRecipientsDocument,
  sealedPolicyDocument,
  NOTICE_RECIPIENTS_DOMAIN,
  POLICY_DOMAIN,
  SHELLS,
  signNoticeRecipients,
  signPolicy,
  adminKeyHint,
  unlockAdminKey,
  verifyBody,
  type LifetimeInput,
  type PolicyEdit,
} from '@wadeck-app/machine-webcrypto';
import type { PolicyBody, PolicyEntry, SignedNoticeRecipients, SignedPolicy } from '@wadeck-app/machine-core';
import { appFetcher, elevate } from './shellApi.js';

// The Allow button of the Requests page, without React (decision 76): what `machine admin allow <machine> --shell <s> -- <command>` does, with the admin
// passphrase and the unlocked key living ONLY in this page.
//
//   1. context  (sensitive GET, after the PIN): the target, the signed policy the next one is edited from, the pinned admin key, where it goes.
//   2. preview  (no secret): the next body, computed HERE from a base whose signature is verified against the pinned admin key. A backend that sends a
//      base with entries the admin never signed is refused: the page never signs a body a backend wrote.
//   3. sign     (passphrase): the encrypted key file is read (sensitive GET), unlocked as a NON-EXTRACTABLE key, used for the policy and its inbox
//      document, and locked again BEFORE the post. The passphrase is a parameter of `signAndSubmitAllow` only: it is never stored, logged or put in an
//      error, and nothing in what is posted can carry it (the post is `{ policy, document? }`, both signed documents).
//   4. post     (sensitive POST): only the signed documents; the daemon verifies them against the pinned key and the current version before it stores them.

const BASE = '/api/modules/machine';
/** Not authentication (any local process can send it): it only refuses a stray request that did not come from the module's page code. */
const MODULE_HEADER = { 'x-machine-module': '1' };

export interface AllowApi {
  /** The PIN dialog of app-core, when the session needs it. Rejects when it is cancelled. */
  elevate(): Promise<void>;
  /** A sensitive GET of the module backend; `path` is relative to `/api/modules/machine`. Returns the parsed answer, rejects with the server's message. */
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

/** The API of the real page: the shell's PIN-aware fetcher and the PIN dialog. */
export function shellAllowApi(): AllowApi {
  return {
    elevate,
    get: (path) => appFetcher(`GET ${BASE}${path}`, undefined, undefined, MODULE_HEADER),
    post: (path, body) => appFetcher(`POST ${BASE}${path}`, undefined, body, MODULE_HEADER),
  };
}

export interface AllowContext {
  ok: true;
  /** `identityPublicKey`: the key of the target from the registration the admin signed; the inbox document is sealed to it (decision 78). Needed for `delivery: 'inbox'`. */
  target: { uuid: string; name: string; identityPublicKey?: string };
  /** The target is this machine: the policy is installed here, no relay is involved. */
  toSelf: boolean;
  policyMode: 'admin' | 'local';
  /** The pinned admin key. The key unlocked in the page must be this one. */
  adminKeyId: string;
  adminPublicKey: string;
  /** The signed policy the next one is edited from; null: none on record (the next is version 1). */
  current: SignedPolicy | null;
  source: string;
  delivery: 'install' | 'inbox';
  /**
   * Another machine only (request-notices.md): the list of machines that receive request notices, as stored on the admin machine (null: none), and this machine's uuid.
   * Absent: an older module backend, the page then cannot send the list.
   */
  noticeRecipients?: { selfUuid: string; current: SignedNoticeRecipients | null };
}

export interface AllowChange {
  shell: string;
  command: string;
  /**
   * The lifetime as the CLI flags (`--times`, `--for`): parsed by the same pure code at the time of the signature (a duration counts from then). Absent or
   * empty: a permanent entry, no `limits` key. Invalid: the parser's sentence is thrown before anything is read or signed.
   */
  lifetime?: LifetimeInput;
}

export interface AllowPrepared {
  changed: true;
  fromVersion: number;
  toVersion: number;
  added: PolicyEntry[];
  /** How many commands every trusted peer may run after this change. */
  defaultCount: number;
  /** Peers with their own list: this change does not apply to them. */
  peersWithOwnList: string[];
  body: PolicyBody;
}

// This flow only allows one EXACT entry: 'ambiguous' and 'bad-index' belong to `--remove` and cannot happen here (the type is the one of the shared edit).
export type AllowPreview = AllowPrepared | { changed: false; reason: 'already-allowed' | 'not-allowed' | 'ambiguous' | 'bad-index' };

export interface AllowResult {
  ok: true;
  target: { uuid: string; name: string };
  version: number;
  delivery: 'installed' | 'inbox';
  alreadyThere?: true;
  /** The list of notice recipients sent with the policy to another machine: `sent`, `already-there`, `failed` (the daemon, with its message) or `skipped` (the backend is older: nothing was sent). */
  noticeRecipients?: 'sent' | 'already-there' | 'failed' | 'skipped';
  noticeRecipientsMessage?: string;
}

const SKIPPED_MESSAGE = 'the list of machines that receive request notices was NOT sent with this policy: the module backend is older than this page. Update the machine module (`app-core-cli update`), or run `machine admin notify-to <machines>` on the admin machine';

/** One sentence for the confirmation line of the page: empty when the list rode along without a problem to tell. */
export function noticeRecipientsText(result: AllowResult): string {
  if (result.noticeRecipients === 'failed' || result.noticeRecipients === 'skipped') {
    return ` [warn] ${result.noticeRecipientsMessage ?? SKIPPED_MESSAGE}`;
  }
  return result.noticeRecipientsMessage === undefined ? '' : ` [warn] ${result.noticeRecipientsMessage}`;
}

const unexpected = (what: string): Error =>
  new Error(`the module backend sent an unexpected answer for ${what}: the page and the module are not the same version: update the machine module (\`app-core-cli update\`) and reload the page`);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function asContext(raw: unknown): AllowContext {
  if (!isObject(raw) || raw['ok'] !== true || !isObject(raw['target']) || typeof raw['target']['uuid'] !== 'string' || typeof raw['target']['name'] !== 'string') throw unexpected('the policy context');
  const current = raw['current'];
  const signed = isObject(current) && isObject(current['body']) && typeof current['signature'] === 'string';
  if (typeof raw['adminKeyId'] !== 'string' || typeof raw['adminPublicKey'] !== 'string' || typeof raw['toSelf'] !== 'boolean' || (raw['delivery'] !== 'install' && raw['delivery'] !== 'inbox') || (current !== null && !signed)) {
    throw unexpected('the policy context');
  }
  return raw as unknown as AllowContext;
}

/**
 * The hint of the admin key, read from the encrypted key file BEFORE the passphrase is typed (it is stored in clear, decision 57). Undefined: no hint is stored.
 * Throws with the message of the key file reader when the stored hint is malformed. The route is sensitive: call it after the PIN.
 */
export async function readAdminKeyHint(api: AllowApi): Promise<string | undefined> {
  const answer = await api.get('/admin-key');
  if (!isObject(answer) || typeof answer['file'] !== 'string') {
    throw unexpected('the admin key file');
  }
  return adminKeyHint(answer['file']);
}

/** The PIN first (so it is asked before the unlock form is shown), then the context of the machine. */
export async function loadContext(api: AllowApi, machineUuid: string): Promise<AllowContext> {
  await api.elevate();
  return asContext(await api.get(`/allow/${encodeURIComponent(machineUuid)}`));
}

/**
 * The next policy, computed here, from a base this page verified. No secret involved: it is what the confirmation shows. Throws a sentence naming the
 * problem (a command the policy cannot hold, a base the pinned key did not sign).
 */
export async function prepareAllow(context: AllowContext, change: AllowChange, now: number): Promise<AllowPreview> {
  if (!(SHELLS as readonly string[]).includes(change.shell)) throw new Error(`shell must be one of ${SHELLS.join(', ')} (got ${JSON.stringify(change.shell)})`);
  const problem = commandTextProblem(change.command);
  if (problem !== undefined) throw new Error(`command ${problem.replace(/^command /, '')}`);
  const { current } = context;
  if (current !== null) {
    if (!(await verifyBody(POLICY_DOMAIN, current as never, context.adminPublicKey))) {
      throw new Error(`the policy sent as the current one of "${context.target.name}" is not signed by the admin key pinned on this machine, so it is not used as a base (a base the admin never signed could carry entries the admin never saw). Reload the page; if it persists, check the policy files of the machine and the module`);
    }
    if (current.body.target !== context.target.uuid) throw new Error(`the policy sent as the current one is written for another machine (${current.body.target}), not for "${context.target.name}": it is not used as a base. Reload the page`);
  }
  const limits = change.lifetime === undefined ? undefined : parseLifetime(change.lifetime, now);
  const edit: PolicyEdit = nextPolicyBody(current?.body, { target: context.target.uuid, adminKeyId: context.adminKeyId, now }, { kind: 'allow', entry: { shell: change.shell as PolicyEntry['shell'], command: change.command, ...(limits === undefined ? {} : { limits }) } });
  if (!edit.changed) return { changed: false, reason: edit.reason };
  return {
    changed: true,
    fromVersion: edit.body.baseVersion,
    toVersion: edit.body.version,
    added: edit.added,
    defaultCount: edit.body.defaults.length,
    peersWithOwnList: edit.peersWithOwnList,
    body: edit.body,
  };
}

/**
 * Unlock the admin key with `passphrase`, sign the policy (and its inbox document for another machine), lock the key, and post the signed documents.
 * Throws with the actionable sentence of whoever refused: wrong passphrase, another key than the pinned one, the daemon (stale base, mode local ...).
 */
export async function signAndSubmitAllow(api: AllowApi, context: AllowContext, change: AllowChange, passphrase: string, now: number): Promise<AllowResult> {
  const prepared = await prepareAllow(context, change, now);
  if (!prepared.changed) {
    throw new Error(`${change.shell} ${JSON.stringify(change.command)} is ${prepared.reason === 'already-allowed' ? 'already allowed' : 'not allowed'} on "${context.target.name}": nothing to sign`);
  }
  // Decision 78: the document is sealed to the target, so its key is needed BEFORE anything is unlocked. No key, no document (never a clear one).
  const targetKey = context.target.identityPublicKey;
  if (context.delivery === 'inbox' && (typeof targetKey !== 'string' || targetKey.length === 0)) {
    throw new Error(
      `the module backend did not send the identity key of "${context.target.name}", so the policy cannot be sealed to it (a policy is never sent to the relay in clear). Nothing was signed. Update the machine module (\`app-core-cli update\`) and reload the page`,
    );
  }
  // A stored list the pinned admin key did not sign is not sealed for anybody: the page never vouches for what a backend handed over.
  const stored = context.noticeRecipients?.current ?? null;
  if (stored !== null && !(await verifyBody(NOTICE_RECIPIENTS_DOMAIN, stored as never, context.adminPublicKey))) {
    throw new Error('the list of notice recipients sent by the module backend is not signed by the admin key pinned on this machine, so the page does not send it. Nothing was signed. Delete notice-recipients.json on the admin machine and run `machine admin notify-to <machines>` there');
  }
  const answer = await api.get('/admin-key');
  if (!isObject(answer) || typeof answer['file'] !== 'string') throw unexpected('the admin key file');

  const key = await unlockAdminKey(answer['file'], passphrase, { extractable: false });
  let body: { policy: SignedPolicy; document?: unknown; noticeRecipients?: { signed: SignedNoticeRecipients; document: unknown } };
  try {
    if (key.keyId !== context.adminKeyId || key.publicKey !== context.adminPublicKey) {
      throw new Error('the key unlocked from the key file is not the admin key pinned on this machine: nothing was signed. Copy the admin key file again from the admin machine');
    }
    const policy = await signPolicy(prepared.body, key.privateKey);
    body = context.delivery === 'inbox' ? { policy, document: await sealedPolicyDocument(policy, now, key.privateKey, targetKey as string) } : { policy };
    // The list of notice recipients rides the same unlock, like every distribution of the CLI: the stored list as it is, or a new one for this machine.
    if (context.delivery === 'inbox' && context.noticeRecipients !== undefined) {
      const signed = stored ?? ((await signNoticeRecipients(nextNoticeRecipientsBody({ adminKeyId: context.adminKeyId, now, current: null, recipients: [context.noticeRecipients.selfUuid] }), key.privateKey)) as unknown as SignedNoticeRecipients);
      body.noticeRecipients = { signed, document: await sealedNoticeRecipientsDocument(signed as never, context.target.uuid, now, key.privateKey, targetKey as string) };
    }
  } finally {
    // Locked before anything goes to the network: a failure of the post never leaves an unlocked key behind.
    key.lock();
  }
  const result = await api.post('/allow', body);
  if (!isObject(result) || result['ok'] === false) throw unexpected('the signed policy');
  const allowResult = result as unknown as AllowResult;
  if (context.delivery === 'inbox' && context.noticeRecipients === undefined) {
    return { ...allowResult, noticeRecipients: 'skipped', noticeRecipientsMessage: SKIPPED_MESSAGE };
  }
  return allowResult;
}
