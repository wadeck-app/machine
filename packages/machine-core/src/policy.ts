import { createHash } from 'node:crypto';
import type { Json } from './canonical.js';
import { INVALID_ADMIN_KEY_MESSAGE, tryKeyId } from './keys.js';
import { signDocument, verifyDocument } from './signed.js';

export const POLICY_DOMAIN = 'machine/policy/v1';

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

export type PolicyFailure = 'malformed' | 'invalid-admin-key' | 'wrong-admin-key' | 'bad-signature' | 'wrong-target' | 'not-yet-valid' | 'expired' | 'stale-base' | 'rollback';
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

function assertCommand(command: unknown, where: string): asserts command is string {
  if (typeof command !== 'string') throw new Error(`policy: ${where} command must be a string`);
  if (command.length === 0) throw new Error(`policy: ${where} command must not be empty`);
  if (command.length > MAX_COMMAND) throw new Error(`policy: ${where} command is longer than ${MAX_COMMAND} characters`);
  if (!PRINTABLE_ASCII.test(command)) throw new Error(`policy: ${where} command must use printable ASCII only (no control or non-ASCII characters)`);
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

export function signPolicy(body: PolicyBody, adminPrivateKeyPkcs8: Uint8Array): SignedPolicy {
  assertPolicyBody(body);
  return { body, signature: signDocument(POLICY_DOMAIN, body as unknown as Json, adminPrivateKeyPkcs8) };
}

export interface PolicyState {
  /** Version currently applied on this machine (0 when none). */
  version: number;
  /** Highest version ever applied, kept apart from the policy store so that a wipe or restore cannot lower it. */
  highestSeen: number;
}

export interface ApplyPolicyContext {
  adminPublicKey: string;
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
  const pinned = tryKeyId(ctx.adminPublicKey);
  if (pinned === undefined) return { ok: false, reason: 'invalid-admin-key', message: INVALID_ADMIN_KEY_MESSAGE };
  if (body.adminKeyId !== pinned) {
    return { ok: false, reason: 'wrong-admin-key', message: `policy is certified by admin key ${body.adminKeyId}, but this machine pins ${pinned}` };
  }
  if (!verifyDocument(POLICY_DOMAIN, body as unknown as Json, ctx.adminPublicKey, signed.signature)) {
    return { ok: false, reason: 'bad-signature', message: 'policy has an invalid signature; it was altered or not signed by the admin key' };
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
export function authorize(body: PolicyBody, peerUuid: string, request: CommandRequest, now: number, usage: (key: string) => number): Decision {
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
      message: `"${request.command}" (shell ${request.shell}) is not allowed for this peer; the admin must add this exact string to the ${own ? 'peer list' : 'default list'}`,
    };
  }
  const key = entryKey(scope, entry);
  if (entry.limits?.expiresAt !== undefined && now > entry.limits.expiresAt) {
    return { allowed: false, reason: 'expired', message: `"${request.command}" was allowed until ${new Date(entry.limits.expiresAt * 1000).toISOString()}; ask the admin to renew it` };
  }
  if (entry.limits?.maxCalls !== undefined && usage(key) >= entry.limits.maxCalls) {
    return { allowed: false, reason: 'exhausted', message: `"${request.command}" reached its limit of ${entry.limits.maxCalls} call(s); ask the admin to renew it` };
  }
  return { allowed: true, entryKey: key, entry };
}
