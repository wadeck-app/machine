import { createHash } from 'node:crypto';
import type { Json } from './canonical.js';
import { NOT_YET_VALID_LEEWAY_SECONDS, TIME_SYNC_FIX, formatDuration } from './clockSkew.js';
import { INVALID_ADMIN_KEY_MESSAGE, tryKeyId } from './keys.js';
import { signDocument, verifyDocument } from './signed.js';
import { canonicalEntry, looksLikePlaceholder, matchTemplate, parseTemplate, type Template } from './template.js';
import { TemplateError, type Platform } from './typedParams.js';

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
  /**
   * How many times the owner renewed this entry (hold-for-approval.md, "Renewal"): written by the Allow of a renewal, never by a first allow. It is part of the
   * key of the call counter, so a renewal with the SAME limits still starts the counter again. Needs a version 2 body (an older reader refuses it by name).
   */
  renewals?: number;
}

/** One exact command: the shell and the full command line, compared byte for byte (decision 13). */
export interface ExactEntry {
  shell: Shell;
  command: string;
  template?: never;
  limits?: Limits;
}

/** A typed entry (policy version 2): fixed words and `<label:type>` placeholders, see typed-parameters.md. */
export interface TypedEntry {
  shell: Shell;
  template: string;
  command?: never;
  limits?: Limits;
}

export type PolicyEntry = ExactEntry | TypedEntry;

/** The text of an entry as written and signed: the command of an exact entry, the template of a typed one. */
export const entryText = (entry: PolicyEntry): string => (entry.template !== undefined ? entry.template : (entry.command as string));
export const isTyped = (entry: PolicyEntry): entry is TypedEntry => entry.template !== undefined;
/** True when a list holds a typed entry (such a policy needs body version 2). */
export const hasTypedEntry = (lists: PolicyEntry[][]): boolean => lists.some((list) => list.some(isTyped));

/** The highest policy body version this build reads. Exact-only policies stay at version 1 so that older targets keep reading them. */
export const POLICY_MAX_VERSION = 2;
export const UPDATE_HINT = 'run `machine cli update` on this machine';

export interface PolicyBody {
  v: 1 | 2;
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
/** The whole body as JSON: 200 entries of 2048 characters are about 400 KiB. */
const MAX_BODY_CHARS = 512 * 1024;

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

function assertEntries(list: unknown, where: string, version: number): asserts list is PolicyEntry[] {
  if (!Array.isArray(list)) throw new Error(`policy: ${where} must be a list`);
  if (list.length > MAX_ENTRIES_PER_LIST) throw new Error(`policy: ${where} has more than ${MAX_ENTRIES_PER_LIST} entries`);
  const seen = new Set<string>();
  for (const raw of list as unknown[]) {
    const entry = raw as Record<string, unknown>;
    if (typeof entry !== 'object' || entry === null) throw new Error(`policy: every entry of ${where} must be an object`);
    for (const key of Object.keys(entry)) {
      if (!['shell', 'command', 'template', 'limits'].includes(key)) {
        throw new Error(`policy: unknown field "${key}" in an entry of ${where}`);
      }
    }
    if (!SHELLS.includes(entry.shell as Shell)) throw new Error(`policy: shell must be one of ${SHELLS.join(', ')} (got ${String(entry.shell)})`);
    if (('command' in entry) === ('template' in entry)) {
      throw new Error(`policy: an entry of ${where} must hold exactly one of command (exact) or template (typed)`);
    }
    let canonical: string;
    let shown: string;
    if ('template' in entry) {
      if (version < 2) {
        throw new Error(`policy: ${where} holds a typed entry but the body is version ${version}: typed entries need version 2`);
      }
      const text = entry.template;
      if (typeof text !== 'string') {
        throw new Error(`policy: ${where} template must be a string`);
      }
      let parsed: Template;
      try {
        parsed = parseTemplate(text, entry.shell as Shell);
      } catch (e) {
        if (e instanceof TemplateError) {
          throw new Error(`policy: ${where} template "${text}" is refused: ${e.detail}`);
        }
        throw e;
      }
      canonical = canonicalEntry(entry.shell as Shell, { kind: 'typed', template: parsed });
      shown = text;
    } else {
      assertCommand(entry.command, where);
      // An exact entry that looks like a placeholder would be read differently by a reader that knows typed entries.
      if (looksLikePlaceholder(entry.command)) {
        throw new Error(`policy: ${where} exact command "${entry.command}" holds a <label:type> placeholder: write it as a typed entry (policy version 2) or remove the angle brackets`);
      }
      canonical = canonicalEntry(entry.shell as Shell, { kind: 'exact', command: entry.command });
      shown = entry.command;
    }
    if ('limits' in entry && entry.limits === undefined) throw new Error(`policy: limits of an entry of ${where} must be omitted, not undefined`);
    if (entry.limits !== undefined) {
      const limits = entry.limits as Record<string, unknown>;
      if (typeof limits !== 'object' || limits === null) throw new Error(`policy: limits of an entry of ${where} must be an object`);
      for (const key of Object.keys(limits)) {
        if (key !== 'maxCalls' && key !== 'expiresAt' && key !== 'renewals') {
          throw new Error(`policy: unknown limit "${key}"`);
        }
        if (limits[key] === undefined) throw new Error(`policy: limits.${key} must be omitted, not undefined`);
      }
      if (limits.maxCalls !== undefined && !posInt(limits.maxCalls)) throw new Error('policy: limits.maxCalls must be a positive integer');
      if (limits.expiresAt !== undefined && !posInt(limits.expiresAt)) throw new Error('policy: limits.expiresAt must be epoch seconds (a positive integer)');
      if (limits.renewals !== undefined) {
        if (!posInt(limits.renewals)) {
          throw new Error('policy: limits.renewals must be a positive integer');
        }
        if (version < 2) {
          throw new Error(`policy: limits.renewals need version 2 (an entry of ${where} was renewed but the body is version ${version}): ${UPDATE_HINT}`);
        }
      }
    }
    if (seen.has(canonical)) {
      throw new Error(`policy: duplicate entry in ${where}: ${entry.shell as string} "${shown}" (labels and the order of enum members do not make an entry different)`);
    }
    seen.add(canonical);
  }
}

export interface PolicyReadOptions {
  /** The highest body version the reader knows (default POLICY_MAX_VERSION). A lower value simulates an older build. */
  readsUpTo?: number;
}

export function assertPolicyBody(value: unknown, options: PolicyReadOptions = {}): asserts value is PolicyBody {
  const readsUpTo = options.readsUpTo ?? POLICY_MAX_VERSION;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('policy: the body must be an object');
  const size = JSON.stringify(value).length;
  if (size > MAX_BODY_CHARS) {
    throw new Error(`policy: the body is ${size} characters, above the limit of ${MAX_BODY_CHARS} characters (512 KiB): remove entries or peer lists`);
  }
  const r = value as Record<string, unknown>;
  const fields = ['v', 'target', 'version', 'baseVersion', 'adminKeyId', 'issuedAt', 'notBefore', 'notAfter', 'defaults', 'peers'];
  for (const key of Object.keys(r)) {
    if (!fields.includes(key)) throw new Error(`policy: unknown field "${key}"`);
  }
  for (const key of fields) {
    if (!(key in r)) throw new Error(`policy: missing field "${key}"`);
  }
  if (r.v !== 1 && r.v !== 2) {
    throw new Error(`policy: unsupported version ${String(r.v)} (this build reads versions 1 to ${readsUpTo}): ${UPDATE_HINT}`);
  }
  if (r.v > readsUpTo) {
    throw new Error(`policy: unsupported version ${String(r.v)} (this reader knows versions 1 to ${readsUpTo}): ${UPDATE_HINT}, then apply the policy again`);
  }
  const bodyVersion = r.v;
  if (typeof r.target !== 'string' || !UUID_V4.test(r.target)) throw new Error('policy: target must be a lowercase version 4 UUID');
  if (typeof r.version !== 'number' || !Number.isSafeInteger(r.version) || r.version < 1) throw new Error('policy: version must be a positive integer');
  if (typeof r.baseVersion !== 'number' || !Number.isSafeInteger(r.baseVersion) || r.baseVersion < 0) throw new Error('policy: baseVersion must be a non-negative integer');
  if (r.version !== r.baseVersion + 1) throw new Error('policy: version must be baseVersion + 1');
  if (typeof r.adminKeyId !== 'string' || !KEY_ID.test(r.adminKeyId)) throw new Error('policy: adminKeyId must be 32 lowercase hex characters');
  for (const key of ['issuedAt', 'notBefore', 'notAfter']) {
    if (!posInt(r[key])) throw new Error(`policy: ${key} must be epoch seconds`);
  }
  if ((r.notAfter as number) <= (r.notBefore as number)) throw new Error('policy: notAfter must be after notBefore');
  assertEntries(r.defaults, 'defaults', bodyVersion);
  if (typeof r.peers !== 'object' || r.peers === null || Array.isArray(r.peers)) throw new Error('policy: peers must be an object keyed by peer UUID');
  const peerLists = Object.entries(r.peers);
  if (peerLists.length > MAX_PEERS) {
    throw new Error(`policy: more than ${MAX_PEERS} peers`);
  }
  for (const [id, list] of peerLists) {
    if (!UUID_V4.test(id)) throw new Error(`policy: peer key "${id}" is not a lowercase version 4 UUID`);
    assertEntries(list, `peers.${id}`, bodyVersion);
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
  // Not-yet-valid side only: a clock a little behind the signing clock must not refuse a policy the admin just signed (decision 88).
  if (ctx.now + NOT_YET_VALID_LEEWAY_SECONDS < body.notBefore) {
    return {
      ok: false,
      reason: 'not-yet-valid',
      message: `policy can be applied from ${new Date(body.notBefore * 1000).toISOString()}, but this machine's clock reads ${new Date(ctx.now * 1000).toISOString()}, ${formatDuration(body.notBefore - ctx.now)} earlier (up to ${NOT_YET_VALID_LEEWAY_SECONDS} s is tolerated): fix the time sync of this machine or of the admin machine (${TIME_SYNC_FIX})`,
    };
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
export function entryKey(scope: string, entry: { shell: Shell; command?: string; template?: string; limits?: Limits }): string {
  // The generation of a renewal joins the key only when there is one: the key of an entry that was never renewed is what it always was.
  const limits = `${entry.limits?.maxCalls ?? ''}\u0000${entry.limits?.expiresAt ?? ''}${entry.limits?.renewals === undefined ? '' : `\u0000${entry.limits.renewals}`}`;
  // An exact entry hashes as it always did (its counter survives the upgrade); a typed one hashes its template as signed.
  const text = entry.template !== undefined ? entry.template : entry.command;
  return `${scope}:${createHash('sha256').update(`${entry.shell}\u0000${text}\u0000${limits}`).digest('hex').slice(0, 32)}`;
}

/**
 * The entry an exhausted or expired refusal is about (hold-for-approval.md, "Renewal"): what the owner renews. LOCAL ONLY: it is written in the audit log and
 * shown to the owner, never sent to the caller (the caller learns nothing it did not already write, T-03).
 */
export interface Renewal {
  reason: 'expired' | 'exhausted';
  /** The text of the entry as signed: the command, or the template of a typed entry. The shell is the one of the request. */
  entry: string;
  typed: boolean;
  /** The entry is in the own list of the peer (the renewal edits that list), else in the default list. */
  own: boolean;
  maxCalls?: number;
  expiresAt?: number;
  /** Exhausted: the calls counted for the entry. */
  used?: number;
}

/** `entry used 1 of 1 call(s)` or `expired at 2026-11-22T10:00:00.000Z`: the words after `renew:` on every surface. */
export function renewalNote(renewal: Renewal): string {
  return renewal.reason === 'exhausted' ? `entry used ${renewal.used ?? renewal.maxCalls ?? 0} of ${renewal.maxCalls ?? 0} call(s)` : `expired at ${new Date((renewal.expiresAt ?? 0) * 1000).toISOString()}`;
}

export type Decision =
  | {
      allowed: true;
      entryKey: string;
      entry: PolicyEntry;
      /** The template of the typed entry that matched, as signed (absent for an exact entry): written in the audit log. */
      template?: string;
    }
  | {
      allowed: false;
      reason: 'invalid-request' | 'not-listed' | 'expired' | 'exhausted';
      message: string;
      /** `not-listed` only: the other shells under which the SAME command string is listed for this peer (the message says so). */
      allowedShells?: Shell[];
      /**
       * `not-listed` only, LOCAL ONLY (audit log and `machine requests`, never sent to the caller): the closest typed entry, the token
       * and the rule that failed. It never holds the value.
       */
      detail?: string;
      /** `expired` and `exhausted` only, LOCAL ONLY: the entry whose renewal would allow the request. */
      renewal?: Renewal;
    };

/** A command as written in a command line the user can paste: quoted when it holds spaces or quotes (the same rule as `machine run`). */
export const commandForHint = (command: string): string => (/[\s"'`]/.test(command) ? `"${command}"` : command);

/** The list that applies to `peerUuid`: its own list when it has one (it replaces the default), else the default list. */
export function effectiveList(body: PolicyBody, peerUuid: string): { entries: PolicyEntry[]; own: boolean } {
  const own = Object.hasOwn(body.peers, peerUuid);
  return { entries: own ? (body.peers[peerUuid] as PolicyEntry[]) : body.defaults, own };
}

const templateCache = new Map<string, Template>();
const TEMPLATE_CACHE_MAX = 2000;

/** The parsed template of a typed entry (cached: a policy is asserted when it is loaded, so this does not fail on a loaded policy). */
function templateOf(entry: TypedEntry): Template {
  const key = `${entry.shell}\u0000${entry.template}`;
  let parsed = templateCache.get(key);
  if (parsed === undefined) {
    parsed = parseTemplate(entry.template, entry.shell);
    if (templateCache.size >= TEMPLATE_CACHE_MAX) {
      templateCache.clear();
    }
    templateCache.set(key, parsed);
  }
  return parsed;
}

/** True when the entry allows exactly this shell and command line (an exact entry: same bytes; a typed one: every token valid). Limits are not looked at. */
export function entryMatches(entry: PolicyEntry, request: CommandRequest, platform: Platform): boolean {
  if (entry.shell !== request.shell) {
    return false;
  }
  return isTyped(entry) ? matchTemplate(templateOf(entry), request.command, platform).ok : entry.command === request.command;
}

/** The typed entry that shares the most leading words with the request (same shell), and why it fails: for the LOCAL log only. */
function closestDetail(list: PolicyEntry[], request: CommandRequest, platform: Platform): string | undefined {
  const words = request.command.split(' ');
  let best: { entry: TypedEntry; shared: number } | undefined;
  for (const entry of list) {
    if (!isTyped(entry) || entry.shell !== request.shell) {
      continue;
    }
    const template = templateOf(entry);
    if (template.tokens[0]?.kind === 'word' && template.tokens[0].text !== words[0]) {
      continue;
    }
    let shared = 0;
    while (shared < template.tokens.length && shared < words.length && template.tokens[shared]?.kind === 'word' && (template.tokens[shared] as { text: string }).text === words[shared]) shared += 1;
    if (best === undefined || shared > best.shared) {
      best = { entry, shared };
    }
  }
  if (best === undefined) {
    return undefined;
  }
  const result = matchTemplate(templateOf(best.entry), request.command, platform);
  if (result.ok) {
    return undefined;
  }
  return `closest typed entry "${best.entry.template}": ${result.tokenIndex === undefined ? '' : `token ${result.tokenIndex}: `}${result.rule}`;
}

/**
 * Matches the request against EVERY entry of the list that applies to the peer and takes the first that allows it: an exhausted or expired
 * entry never shadows a later one. An exact entry compares byte for byte; a typed one checks each value against its type (whitelists).
 * `usage` returns how many calls were already accepted for an entry key; the caller records a use after accepting.
 * `selfName`: the name of this machine, written in the hint of a `not-listed` refusal (absent: `<machine>`).
 * `platform`: the platform of THIS machine (reserved device names); absent means the strict answer, `windows`.
 */
export function authorize(
  body: PolicyBody,
  peerUuid: string,
  request: CommandRequest,
  now: number,
  usage: (key: string) => number,
  mode: PolicyMode = 'admin',
  selfName?: string,
  platform: Platform = 'windows',
): Decision {
  const who = mode === 'local' ? 'the owner of this machine (`machine policy allow` here)' : 'the admin';
  if (!SHELLS.includes(request.shell) || typeof request.command !== 'string' || request.command.length === 0 || request.command.length > MAX_COMMAND || !PRINTABLE_ASCII.test(request.command)) {
    return { allowed: false, reason: 'invalid-request', message: 'request refused: the shell must be known and the command must be 1 to 2048 printable ASCII characters' };
  }
  const { entries: list, own } = effectiveList(body, peerUuid);
  const scope = own ? peerUuid : 'default';
  const matching = list.filter((e) => entryMatches(e, request, platform));
  if (matching.length === 0) {
    // What this refusal reveals (T-03): only exact entries whose command string equals the one the caller just sent, in the list that applies
    // to this very caller, and only their shell names. Never another command of the list, never a template, a bound or a label: the caller
    // learns nothing it did not already write. A typed entry that did not match says nothing here (the detail stays local).
    const otherShells = [...new Set(list.filter((e) => !isTyped(e) && e.command === request.command && e.shell !== request.shell).map((e) => e.shell))];
    if (otherShells.length > 0) {
      const name = selfName ?? '<machine>';
      const first = otherShells[0] as Shell;
      return {
        allowed: false,
        reason: 'not-listed',
        allowedShells: otherShells,
        message: `"${request.command}" is allowed with shell ${otherShells.join(' or ')}, not with ${request.shell}: run machine run ${name} --shell ${first} -- ${commandForHint(request.command)} (or: machine peer connect ${name} --shell ${first} to make it the default)`,
      };
    }
    const detail = closestDetail(list, request, platform);
    return {
      allowed: false,
      reason: 'not-listed',
      message: `"${request.command}" (shell ${request.shell}) is not allowed for this peer; ${who} must add this exact string to the ${own ? 'peer list' : 'default list'}`,
      ...(detail === undefined ? {} : { detail }),
    };
  }
  let firstRefusal: Decision | undefined;
  for (const entry of matching) {
    const key = entryKey(scope, entry);
    if (entry.limits?.expiresAt !== undefined && now > entry.limits.expiresAt) {
      firstRefusal ??= {
        allowed: false,
        reason: 'expired',
        message: `"${request.command}" was allowed until ${new Date(entry.limits.expiresAt * 1000).toISOString()}; ask ${who} to renew it`,
        renewal: { reason: 'expired', entry: entryText(entry), typed: isTyped(entry), own, expiresAt: entry.limits.expiresAt, ...(entry.limits.maxCalls !== undefined ? { maxCalls: entry.limits.maxCalls } : {}) },
      };
      continue;
    }
    const used = entry.limits?.maxCalls === undefined ? 0 : usage(key);
    if (entry.limits?.maxCalls !== undefined && used >= entry.limits.maxCalls) {
      firstRefusal ??= {
        allowed: false,
        reason: 'exhausted',
        message: `"${request.command}" reached its limit of ${entry.limits.maxCalls} call(s); ask ${who} to renew it`,
        renewal: { reason: 'exhausted', entry: entryText(entry), typed: isTyped(entry), own, maxCalls: entry.limits.maxCalls, used, ...(entry.limits.expiresAt !== undefined ? { expiresAt: entry.limits.expiresAt } : {}) },
      };
      continue;
    }
    return { allowed: true, entryKey: key, entry, ...(isTyped(entry) ? { template: entry.template } : {}) };
  }
  return firstRefusal as Decision;
}
