import { createHash } from 'node:crypto';
import type { Json } from './canonical.js';
import { INVALID_ADMIN_KEY_MESSAGE, tryKeyId } from './keys.js';
import { signDocument, verifyDocument } from './signed.js';

export const POLICY_DOMAIN = 'machine/policy/v1';
/**
 * Policy mode `local` (hard rule 4 as amended): a policy signed by the policy key of the machine itself. A DISTINCT domain string, so that a
 * signature made for one mode never verifies in the other, even with the same private key (the signed bytes begin with the domain).
 */
export const LOCAL_POLICY_DOMAIN = 'machine/policy-local/v1';

/** Who manages the allow list of a machine: `admin` (delegation, the default) or `local` (the machine itself, with its own policy key). */
export type PolicyMode = 'admin' | 'local';
export const POLICY_MODES: readonly PolicyMode[] = ['admin', 'local'];

const domainOf = (mode: PolicyMode): string => (mode === 'local' ? LOCAL_POLICY_DOMAIN : POLICY_DOMAIN);

/** The exact refusal shown, audited and returned when an admin-signed policy reaches a machine that manages its own list. */
export const MANAGED_LOCALLY_MESSAGE = 'this machine manages its own allow list (machine policy delegate to give it back to the admin)';

export const SHELLS = ['cmd', 'ps', 'bash', 'sh'] as const;
export type Shell = (typeof SHELLS)[number];

export interface Limits {
  /** Maximum number of accepted calls over the life of the entry. */
  maxCalls?: number;
  /** Epoch seconds; a call after this instant is refused. */
  expiresAt?: number;
}

/** One exact command: the shell and the full command line, compared byte for byte (decision 13). */
export interface PolicyEntry {
  shell: Shell;
  command: string;
  limits?: Limits;
}

export interface PolicyBody {
  v: 1;
  /** UUID of the ONE machine this policy is written for. */
  target: string;
  version: number;
  /** The version this document was edited from; the target applies it only if this equals its current version. */
  baseVersion: number;
  adminKeyId: string;
  issuedAt: number;
  /** Window in which the document may be APPLIED (not how long its entries live: see limits.expiresAt). */
  notBefore: number;
  notAfter: number;
  defaults: PolicyEntry[];
  /** Per-peer lists, keyed by peer UUID; a listed peer uses ONLY its own list. */
  peers: Record<string, PolicyEntry[]>;
}

export interface SignedPolicy {
  body: PolicyBody;
  signature: string;
}

export type PolicyFailure = 'malformed' | 'invalid-admin-key' | 'wrong-admin-key' | 'wrong-mode' | 'bad-signature' | 'wrong-target' | 'not-yet-valid' | 'expired' | 'stale-base' | 'rollback';
export type PolicyResult = { ok: true; body: PolicyBody } | { ok: false; reason: PolicyFailure; message: string };

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_ID = /^[0-9a-f]{32}$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const MAX_COMMAND = 2048;
const MAX_ENTRIES_PER_LIST = 200;
const MAX_PEERS = 64;

function posInt(x: unknown): x is number {
  return typeof x === 'number' && Number.isSafeInteger(x) && x > 0;
}

/** Why a command text cannot be allowed or launched, or undefined when it is acceptable. One rule for policy and launcher. */
export function commandTextProblem(command: string): string | undefined {
  if (command.length === 0) return 'command must not be empty';
  if (command.length > MAX_COMMAND) return `command is longer than ${MAX_COMMAND} characters`;
  if (!PRINTABLE_ASCII.test(command)) return 'command must use printable ASCII only (no control or non-ASCII characters)';
  return undefined;
}

function assertCommand(command: unknown, where: string): asserts command is string {
  if (typeof command !== 'string') throw new Error(`policy: ${where} command must be a string`);
  const problem = commandTextProblem(command);
  if (problem) throw new Error(`policy: ${where} ${problem}`);
}

function assertEntries(list: unknown, where: string): asserts list is PolicyEntry[] {
  if (!Array.isArray(list)) throw new Error(`policy: ${where} must be a list`);
  if (list.length > MAX_ENTRIES_PER_LIST) throw new Error(`policy: ${where} has more than ${MAX_ENTRIES_PER_LIST} entries`);
  const seen = new Set<string>();
  for (const raw of list as unknown[]) {
    const entry = raw as Record<string, unknown>;
    if (typeof entry !== 'object' || entry === null) throw new Error(`policy: every entry of ${where} must be an object`);
    for (const key of Object.keys(entry)) {
      if (!['shell', 'command', 'limits'].includes(key)) throw new Error(`policy: unknown field "${key}" in an entry of ${where}`);
    }
    if (!SHELLS.includes(entry.shell as Shell)) throw new Error(`policy: shell must be one of ${SHELLS.join(', ')} (got ${String(entry.shell)})`);
    assertCommand(entry.command, where);
    if ('limits' in entry && entry.limits === undefined) throw new Error(`policy: limits of an entry of ${where} must be omitted, not undefined`);
    if (entry.limits !== undefined) {
      const limits = entry.limits as Record<string, unknown>;
      if (typeof limits !== 'object' || limits === null) throw new Error(`policy: limits of an entry of ${where} must be an object`);
      for (const key of Object.keys(limits)) {
        if (key !== 'maxCalls' && key !== 'expiresAt') throw new Error(`policy: unknown limit "${key}"`);
        if (limits[key] === undefined) throw new Error(`policy: limits.${key} must be omitted, not undefined`);
      }
      if (limits.maxCalls !== undefined && !posInt(limits.maxCalls)) throw new Error('policy: limits.maxCalls must be a positive integer');
      if (limits.expiresAt !== undefined && !posInt(limits.expiresAt)) throw new Error('policy: limits.expiresAt must be epoch seconds (a positive integer)');
    }
    const id = `${entry.shell as string}\u0000${entry.command}`;
    if (seen.has(id)) throw new Error(`policy: duplicate entry in ${where}: ${entry.shell as string} "${entry.command}"`);
    seen.add(id);
  }
}

export function assertPolicyBody(value: unknown): asserts value is PolicyBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('policy: the body must be an object');
  const r = value as Record<string, unknown>;
  const fields = ['v', 'target', 'version', 'baseVersion', 'adminKeyId', 'issuedAt', 'notBefore', 'notAfter', 'defaults', 'peers'];
  for (const key of Object.keys(r)) {
    if (!fields.includes(key)) throw new Error(`policy: unknown field "${key}"`);
  }
  for (const key of fields) {
    if (!(key in r)) throw new Error(`policy: missing field "${key}"`);
  }
  if (r.v !== 1) throw new Error(`policy: unsupported version ${String(r.v)} (this build reads version 1)`);
  if (typeof r.target !== 'string' || !UUID_V4.test(r.target)) throw new Error('policy: target must be a lowercase version 4 UUID');
  if (typeof r.version !== 'number' || !Number.isSafeInteger(r.version) || r.version < 1) throw new Error('policy: version must be a positive integer');
  if (typeof r.baseVersion !== 'number' || !Number.isSafeInteger(r.baseVersion) || r.baseVersion < 0) throw new Error('policy: baseVersion must be a non-negative integer');
  if (r.version !== r.baseVersion + 1) throw new Error('policy: version must be baseVersion + 1');
  if (typeof r.adminKeyId !== 'string' || !KEY_ID.test(r.adminKeyId)) throw new Error('policy: adminKeyId must be 32 lowercase hex characters');
  for (const key of ['issuedAt', 'notBefore', 'notAfter']) {
    if (!posInt(r[key])) throw new Error(`policy: ${key} must be epoch seconds`);
  }
  if ((r.notAfter as number) <= (r.notBefore as number)) throw new Error('policy: notAfter must be after notBefore');
  assertEntries(r.defaults, 'defaults');
  if (typeof r.peers !== 'object' || r.peers === null || Array.isArray(r.peers)) throw new Error('policy: peers must be an object keyed by peer UUID');
  const peerIds = Object.keys(r.peers);
  if (peerIds.length > MAX_PEERS) throw new Error(`policy: more than ${MAX_PEERS} peers`);
  for (const id of peerIds) {
    if (!UUID_V4.test(id)) throw new Error(`policy: peer key "${id}" is not a lowercase version 4 UUID`);
    assertEntries((r.peers as Record<string, unknown>)[id], `peers.${id}`);
  }
}

/** Sign with the admin key (mode `admin`, the default) or with the local policy key of the target machine (mode `local`). */
export function signPolicy(body: PolicyBody, privateKeyPkcs8: Uint8Array, mode: PolicyMode = 'admin'): SignedPolicy {
  assertPolicyBody(body);
  return { body, signature: signDocument(domainOf(mode), body as unknown as Json, privateKeyPkcs8) };
}

/** True when `signed` carries a valid signature of `publicKey` in the domain of `mode`. */
export function verifyPolicySignature(signed: SignedPolicy, publicKey: string, mode: PolicyMode): boolean {
  return typeof signed.signature === 'string' && verifyDocument(domainOf(mode), signed.body as unknown as Json, publicKey, signed.signature);
}

export interface PolicyState {
  /** Version currently applied on this machine (0 when none). */
  version: number;
  /** Highest version ever applied, kept apart from the policy store so that a wipe or restore cannot lower it. */
  highestSeen: number;
}

export interface ApplyPolicyContext {
  /** The mode of THIS machine (default `admin`): it alone chooses the accepted signer and the signature domain. */
  mode?: PolicyMode;
  /** Mode `admin`: the pinned admin public key. */
  adminPublicKey: string;
  /** Mode `local`: the pinned public key of the local policy key. Absent in mode `local` is a failure, never a fallback to the admin key. */
  localPublicKey?: string;
  now: number;
  targetUuid: string;
}

/** Compare-and-set (decision 27): every refusal says what to do. */
export function applyPolicy(state: PolicyState, signed: SignedPolicy, ctx: ApplyPolicyContext): PolicyResult {
  try {
    if (typeof signed !== 'object' || signed === null || typeof signed.signature !== 'string') throw new Error('policy: missing signature');
    assertPolicyBody(signed.body);
  } catch (e) {
    return { ok: false, reason: 'malformed', message: (e as Error).message };
  }
  const { body } = signed;
  const mode = ctx.mode ?? 'admin';
  const signerKey = mode === 'local' ? ctx.localPublicKey : ctx.adminPublicKey;
  const pinned = signerKey === undefined ? undefined : tryKeyId(signerKey);
  if (signerKey === undefined || pinned === undefined) {
    return {
      ok: false,
      reason: 'invalid-admin-key',
      message: mode === 'local' ? 'the local policy key of this machine is missing or invalid (policy-mode.json): restore it, or run `machine policy delegate` to give the allow list back to the admin' : INVALID_ADMIN_KEY_MESSAGE,
    };
  }
  if (body.adminKeyId !== pinned) {
    if (mode === 'local') return { ok: false, reason: 'wrong-mode', message: MANAGED_LOCALLY_MESSAGE };
    return {
      ok: false,
      reason: 'wrong-admin-key',
      message: `policy is certified by key ${body.adminKeyId}, but this machine pins admin key ${pinned}; if it was signed by the local policy key of a machine, this machine is in admin mode (\`machine policy local enable\` makes it manage its own list)`,
    };
  }
  if (!verifyDocument(domainOf(mode), body as unknown as Json, signerKey, signed.signature)) {
    return { ok: false, reason: 'bad-signature', message: `policy has an invalid signature; it was altered or not signed by the ${mode === 'local' ? 'local policy key of this machine' : 'admin key'}` };
  }
  if (body.target !== ctx.targetUuid) {
    return { ok: false, reason: 'wrong-target', message: `policy is written for machine ${body.target}, not for this machine (${ctx.targetUuid})` };
  }
  if (ctx.now < body.notBefore) {
    return { ok: false, reason: 'not-yet-valid', message: `policy can be applied from ${new Date(body.notBefore * 1000).toISOString()}; check the clocks` };
  }
  if (ctx.now > body.notAfter) {
    return { ok: false, reason: 'expired', message: `policy could be applied until ${new Date(body.notAfter * 1000).toISOString()}; sign it again` };
  }
  if (body.baseVersion !== state.version) {
    return {
      ok: false,
      reason: 'stale-base',
      message: `policy changed, reload: this machine is at version ${state.version}, the document was edited from version ${body.baseVersion}`,
    };
  }
  if (body.version <= state.highestSeen) {
    return { ok: false, reason: 'rollback', message: `policy version ${body.version} is not newer than version ${state.highestSeen}, already applied once on this machine; a restored or replayed document is refused` };
  }
  return { ok: true, body };
}

export interface CommandRequest {
  shell: Shell;
  command: string;
}

/**
 * Key of the call counter: scope is "default" or the peer UUID whose own list holds the entry.
 * The limits are part of the key: when the admin changes them (a renewal) the counter starts again, and
 * while they stay the same the counter survives new policy versions.
 */
export function entryKey(scope: string, entry: CommandRequest & { limits?: Limits }): string {
  const limits = `${entry.limits?.maxCalls ?? ''}\u0000${entry.limits?.expiresAt ?? ''}`;
  return `${scope}:${createHash('sha256').update(`${entry.shell}\u0000${entry.command}\u0000${limits}`).digest('hex').slice(0, 32)}`;
}

export type Decision =
  | { allowed: true; entryKey: string; entry: PolicyEntry }
  | { allowed: false; reason: 'invalid-request' | 'not-listed' | 'expired' | 'exhausted'; message: string };

/**
 * Exact match only (no normalization, no pattern). A peer with its own list uses only that list.
 * `usage` returns how many calls were already accepted for an entry key; the caller records a use after accepting.
 */
export function authorize(body: PolicyBody, peerUuid: string, request: CommandRequest, now: number, usage: (key: string) => number, mode: PolicyMode = 'admin'): Decision {
  const who = mode === 'local' ? 'the owner of this machine (`machine policy allow` here)' : 'the admin';
  if (!SHELLS.includes(request.shell) || typeof request.command !== 'string' || request.command.length === 0 || request.command.length > MAX_COMMAND || !PRINTABLE_ASCII.test(request.command)) {
    return { allowed: false, reason: 'invalid-request', message: 'request refused: the shell must be known and the command must be 1 to 2048 printable ASCII characters' };
  }
  const own = Object.hasOwn(body.peers, peerUuid);
  const list = own ? (body.peers[peerUuid] as PolicyEntry[]) : body.defaults;
  const scope = own ? peerUuid : 'default';
  const entry = list.find(e => e.shell === request.shell && e.command === request.command);
  if (entry === undefined) {
    return {
      allowed: false,
      reason: 'not-listed',
      message: `"${request.command}" (shell ${request.shell}) is not allowed for this peer; ${who} must add this exact string to the ${own ? 'peer list' : 'default list'}`,
    };
  }
  const key = entryKey(scope, entry);
  if (entry.limits?.expiresAt !== undefined && now > entry.limits.expiresAt) {
    return { allowed: false, reason: 'expired', message: `"${request.command}" was allowed until ${new Date(entry.limits.expiresAt * 1000).toISOString()}; ask ${who} to renew it` };
  }
  if (entry.limits?.maxCalls !== undefined && usage(key) >= entry.limits.maxCalls) {
    return { allowed: false, reason: 'exhausted', message: `"${request.command}" reached its limit of ${entry.limits.maxCalls} call(s); ask ${who} to renew it` };
  }
  return { allowed: true, entryKey: key, entry };
}
