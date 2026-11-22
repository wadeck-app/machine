import {
  commandTextProblem,
  nextNoticeRecipientsBody,
  nextPolicyBody,
  nextPolicyBodyMany,
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
  type UnlockedAdminKey,
} from '@wadeck-app/machine-webcrypto';
import { adminKeyHolder } from './adminKeyHolder.js';
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
  /** `installed`: the target is this machine. `direct`: the target took the policy over the peer channel and installed it (decision 86). `inbox`: stored in the relay inbox. */
  delivery: 'installed' | 'direct' | 'inbox';
  /** The sentence of the CLI for this delivery (the same words), with the colour it deserves: shown as it is. Absent: an older daemon. */
  deliveryText?: { tone: 'success' | 'warning'; text: string };
  /** Why the target was not reached directly (delivery `inbox` after a direct attempt). */
  fallback?: { code: string; cause: string };
  direct?: { outcome: 'installed' | 'already-installed'; ms: number };
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
  if (!isObject(raw) || raw['ok'] !== true || !isObject(raw['target']) || typeof raw['target']['uuid'] !== 'string' || typeof raw['target']['name'] !== 'string') {
    throw unexpected('the policy context');
  }
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

/** What needs no key: the shell is one of the four, the text of the command is one the policy can hold. */
function assertChange(shell: string, command: string): void {
  if (!(SHELLS as readonly string[]).includes(shell)) {
    throw new Error(`shell must be one of ${SHELLS.join(', ')} (got ${JSON.stringify(shell)})`);
  }
  const problem = commandTextProblem(command);
  if (problem !== undefined) {
    throw new Error(`command ${problem.replace(/^command /, '')}`);
  }
}

/** The signed policy the next one is edited from must be one the pinned admin key signed, for this machine: a base a backend wrote is never used. */
async function assertBase(context: AllowContext): Promise<void> {
  const { current } = context;
  if (current === null) {
    return;
  }
  if (!(await verifyBody(POLICY_DOMAIN, current as never, context.adminPublicKey))) {
    throw new Error(`the policy sent as the current one of "${context.target.name}" is not signed by the admin key pinned on this machine, so it is not used as a base (a base the admin never signed could carry entries the admin never saw). Reload the page; if it persists, check the policy files of the machine and the module`);
  }
  if (current.body.target !== context.target.uuid) {
    throw new Error(`the policy sent as the current one is written for another machine (${current.body.target}), not for "${context.target.name}": it is not used as a base. Reload the page`);
  }
}

/**
 * The next policy, computed here, from a base this page verified. No secret involved: it is what the confirmation shows. Throws a sentence naming the
 * problem (a command the policy cannot hold, a base the pinned key did not sign).
 */
export async function prepareAllow(context: AllowContext, change: AllowChange, now: number): Promise<AllowPreview> {
  assertChange(change.shell, change.command);
  await assertBase(context);
  const { current } = context;
  const limits = change.lifetime === undefined ? undefined : parseLifetime(change.lifetime, now);
  const edit: PolicyEdit = nextPolicyBody(current?.body, { target: context.target.uuid, adminKeyId: context.adminKeyId, now }, { kind: 'allow', entry: { shell: change.shell as PolicyEntry['shell'], command: change.command, ...(limits === undefined ? {} : { limits }) } });
  if (!edit.changed) {
    return { changed: false, reason: edit.reason };
  }
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

type DeliveryCheck = { targetKey: string | undefined; stored: SignedNoticeRecipients | null };

/** What must be true BEFORE any key is unlocked for a policy sent to `context`: the key the document is sealed to, and a stored notice list the pinned key signed. */
async function checkDelivery(context: AllowContext): Promise<DeliveryCheck> {
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
  return { targetKey, stored };
}

/** The encrypted key file, as the backend keeps it (sensitive GET: call it after the PIN). */
export async function readKeyFile(api: AllowApi): Promise<string> {
  const answer = await api.get('/admin-key');
  if (!isObject(answer) || typeof answer['file'] !== 'string') {
    throw unexpected('the admin key file');
  }
  return answer['file'];
}

export const LOCKED_MESSAGE = 'The admin key is locked (it locked itself after its idle time, or Lock now was pressed): type the admin passphrase to unlock it again. Nothing was signed';

/**
 * Runs `use` with the admin key (decision 92). `passphrase` null: the key held in this page (adminKeyHolder), which is refused with the fix when locked; the idle
 * timeout restarts. A passphrase: the encrypted key file is read, unlocked as a NON-EXTRACTABLE key, and after a successful `use` KEPT by the holder for the
 * chosen duration ("ask every time": locked at once). A failed `use` always locks the key it unlocked. Either way the key is not locked by the caller: the
 * holder owns it, so nothing posted to the network ever depends on it. The passphrase is never stored: it is a parameter of this call only.
 */
export async function withAdminKey<T>(api: AllowApi, passphrase: string | null, use: (key: UnlockedAdminKey) => Promise<T>): Promise<T> {
  if (passphrase === null) {
    const held = adminKeyHolder.current();
    if (held === null) {
      throw new Error(LOCKED_MESSAGE);
    }
    const out = await use(held);
    adminKeyHolder.touch();
    return out;
  }
  const file = await readKeyFile(api);
  const key = await unlockAdminKey(file, passphrase, { extractable: false });
  let done = false;
  try {
    const out = await use(key);
    done = true;
    return out;
  } finally {
    // Kept for the idle time, or locked: before anything goes to the network, whatever happened.
    if (!done || !adminKeyHolder.hold(key)) {
      key.lock();
    }
  }
}

type AllowPost = { policy: SignedPolicy; document?: unknown; noticeRecipients?: { signed: SignedNoticeRecipients; document: unknown } };

/** With the key unlocked: signs the policy, its inbox document for another machine, and the list of notice recipients (the same unlock, like every distribution of the CLI). */
async function signDocuments(key: { privateKey: Parameters<typeof signPolicy>[1] }, context: AllowContext, policyBody: PolicyBody, now: number, check: DeliveryCheck): Promise<AllowPost> {
  const { targetKey, stored } = check;
  const policy = await signPolicy(policyBody, key.privateKey);
  const body: AllowPost = context.delivery === 'inbox' ? { policy, document: await sealedPolicyDocument(policy, now, key.privateKey, targetKey as string) } : { policy };
  // The list of notice recipients rides the same unlock: the stored list as it is, or a new one for this machine.
  if (context.delivery === 'inbox' && context.noticeRecipients !== undefined) {
    const signed = stored ?? ((await signNoticeRecipients(nextNoticeRecipientsBody({ adminKeyId: context.adminKeyId, now, current: null, recipients: [context.noticeRecipients.selfUuid] }), key.privateKey)) as unknown as SignedNoticeRecipients);
    body.noticeRecipients = { signed, document: await sealedNoticeRecipientsDocument(signed as never, context.target.uuid, now, key.privateKey, targetKey as string) };
  }
  return body;
}

/** The daemon's answer to the post of the signed documents. */
async function postSigned(api: AllowApi, context: AllowContext, body: AllowPost): Promise<AllowResult> {
  const result = await api.post('/allow', body);
  if (!isObject(result) || result['ok'] === false) {
    throw unexpected('the signed policy');
  }
  const allowResult = result as unknown as AllowResult;
  if (context.delivery === 'inbox' && context.noticeRecipients === undefined) {
    return { ...allowResult, noticeRecipients: 'skipped', noticeRecipientsMessage: SKIPPED_MESSAGE };
  }
  return allowResult;
}

/** The key unlocked from the file must be the admin key this machine pinned. */
function assertPinnedKey(key: { keyId: string; publicKey: string }, context: AllowContext): void {
  if (key.keyId !== context.adminKeyId || key.publicKey !== context.adminPublicKey) {
    throw new Error('the key unlocked from the key file is not the admin key pinned on this machine: nothing was signed. Copy the admin key file again from the admin machine');
  }
}

/**
 * Unlock the admin key with `passphrase`, sign the policy (and its inbox document for another machine), lock the key, and post the signed documents.
 * Throws with the actionable sentence of whoever refused: wrong passphrase, another key than the pinned one, the daemon (stale base, mode local ...).
 */
export async function signAndSubmitAllow(api: AllowApi, context: AllowContext, change: AllowChange, passphrase: string | null, now: number, onSigned?: () => void): Promise<AllowResult> {
  const prepared = await prepareAllow(context, change, now);
  if (!prepared.changed) {
    throw new Error(`${change.shell} ${JSON.stringify(change.command)} is ${prepared.reason === 'already-allowed' ? 'already allowed' : 'not allowed'} on "${context.target.name}": nothing to sign`);
  }
  const check = await checkDelivery(context);
  const body = await withAdminKey(api, passphrase, async (key) => {
    assertPinnedKey(key, context);
    return signDocuments(key, context, prepared.body, now, check);
  });
  // The signature is made and the key is locked: the one event of the progress that happens before the network.
  onSigned?.();
  return postSigned(api, context, body);
}

/** The PIN once, then the context of every machine of a batch (one elevation for the whole selection). */
export async function loadContexts(api: AllowApi, machineUuids: string[]): Promise<AllowContext[]> {
  await api.elevate();
  const contexts: AllowContext[] = [];
  for (const uuid of machineUuids) {
    contexts.push(asContext(await api.get(`/allow/${encodeURIComponent(uuid)}`)));
  }
  return contexts;
}

export interface BatchGroupInput {
  context: AllowContext;
  /** What the policy of this machine gets: one entry per distinct shell and text (duplicates are skipped anyway). */
  entries: Array<{ shell: string; command: string }>;
}

export type BatchOutcome =
  | { status: 'posted'; machine: { uuid: string; name: string }; result: AllowResult }
  /** Every entry of this machine was already allowed: nothing was signed for it. */
  | { status: 'unchanged'; machine: { uuid: string; name: string }; message: string }
  /** Signed, but the post failed (the daemon, the relay ...): the other machines are not affected. */
  | { status: 'failed'; machine: { uuid: string; name: string }; message: string };

interface BatchPlan {
  context: AllowContext;
  /** Absent: nothing to sign for this machine. */
  body?: PolicyBody;
}

/**
 * Everything that can be refused without a key, for EVERY machine of the batch: nothing is signed for any machine when one refuses (a command the
 * grammar refuses, a list over the limit, a base or a list the pinned key did not sign, a missing identity key). The sentences name the machine.
 */
async function planBatch(groups: BatchGroupInput[], lifetime: LifetimeInput, now: number): Promise<Array<BatchPlan & { check?: DeliveryCheck }>> {
  const limits = parseLifetime(lifetime, now);
  const plans: Array<BatchPlan & { check?: DeliveryCheck }> = [];
  for (const group of groups) {
    const { context } = group;
    try {
      for (const e of group.entries) assertChange(e.shell, e.command);
      await assertBase(context);
      const entries = group.entries.map((e): PolicyEntry => ({ shell: e.shell as PolicyEntry['shell'], command: e.command, ...(limits === undefined ? {} : { limits: { ...limits } }) }));
      const edit = nextPolicyBodyMany(context.current?.body, { target: context.target.uuid, adminKeyId: context.adminKeyId, now }, entries);
      if (!edit.changed) {
        plans.push({ context });
        continue;
      }
      plans.push({ context, body: edit.body, check: await checkDelivery(context) });
    } catch (e) {
      throw new Error(`on "${context.target.name}": ${(e as Error).message}`);
    }
  }
  return plans;
}

/** What the batch would sign, per machine, without any key: `changed` false means every entry is allowed already. Throws like `signAndSubmitBatch` when a machine refuses. */
export async function prepareBatch(groups: BatchGroupInput[], lifetime: LifetimeInput, now: number): Promise<Array<{ machine: { uuid: string; name: string }; changed: boolean }>> {
  const plans = await planBatch(groups, lifetime, now);
  return plans.map((p) => ({ machine: { uuid: p.context.target.uuid, name: p.context.target.name }, changed: p.body !== undefined }));
}

/**
 * Several requests allowed at once: ONE policy per machine, signed in a SINGLE unlock of the admin key. Every machine is checked first (nothing is
 * signed if any refuses); then the key is unlocked once, every policy (and inbox document, notice list) is signed, the key is locked, `onSigned` is
 * told, and the policies are posted. A machine whose post fails is reported as `failed` and does not hide the others. A machine whose entries were
 * all allowed already is `unchanged` (nothing signed for it). Throws when nothing at all is to be signed, or on a wrong passphrase.
 */
export async function signAndSubmitBatch(api: AllowApi, groups: BatchGroupInput[], lifetime: LifetimeInput, passphrase: string | null, now: number, onSigned?: () => void): Promise<BatchOutcome[]> {
  const plans = await planBatch(groups, lifetime, now);
  const changed = plans.filter((p) => p.body !== undefined);
  if (changed.length === 0) {
    throw new Error(`the selected commands are already allowed on ${plans.map((p) => `"${p.context.target.name}"`).join(', ')}: nothing to sign`);
  }
  const bodies = new Map<BatchPlan, AllowPost>();
  await withAdminKey(api, passphrase, async (key) => {
    for (const plan of changed) {
      assertPinnedKey(key, plan.context);
      bodies.set(plan, await signDocuments(key, plan.context, plan.body as PolicyBody, now, (plan as { check: DeliveryCheck }).check));
    }
  });
  onSigned?.();
  return Promise.all(
    plans.map(async (plan): Promise<BatchOutcome> => {
      const machine = { uuid: plan.context.target.uuid, name: plan.context.target.name };
      const body = bodies.get(plan);
      if (body === undefined) {
        return { status: 'unchanged', machine, message: `the selected commands are already allowed on "${machine.name}": nothing to sign` };
      }
      try {
        return { status: 'posted', machine, result: await postSigned(api, plan.context, body) };
      } catch (e) {
        return { status: 'failed', machine, message: (e as Error).message };
      }
    }),
  );
}

/**
 * Which path the policy took, in the words of the CLI and with the colour it deserves: the success colour for an installation (directly or here), the warning
 * colour for the relay inbox. The daemon sends the sentence (`deliveryText`); an older daemon does not, and the page words the path itself.
 */
export function deliveryNotice(result: AllowResult): { tone: 'success' | 'warning'; text: string } {
  if (result.deliveryText !== undefined) {
    return result.deliveryText;
  }
  const name = result.target.name;
  if (result.delivery === 'inbox') {
    return { tone: 'warning', text: `Stored in the relay inbox of ${name}: it installs it at its next poll (within 60 s, or 5 s while it holds a request)` };
  }
  return { tone: 'success', text: result.delivery === 'direct' ? `Delivered directly to ${name}` : `Installed on ${name}` };
}
