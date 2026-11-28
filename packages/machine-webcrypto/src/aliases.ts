import type { Json } from './canonical.js';
import { machineNameProblem, normalizeMachineName } from './reference.js';
import { signBody } from './signed.js';

// Network aliases (decision 116) as the page signs them: copies of machine-core aliases.ts (shape check, plan of one change, conflicts), message for message;
// aliases.test.ts proves the answers equal. An alias is a human-read label, NOT a right.

export const ALIASES_DOMAIN = 'machine/aliases/v1';
/** Bounded so that the sealed document stays far below the 16 KiB the relay accepts. */
export const MAX_ALIASES = 64;

export interface AliasEntry {
  alias: string;
  uuid: string;
}

export interface AliasesBody {
  v: 1;
  adminKeyId: string;
  serial: number;
  issuedAt: number;
  /** Sorted by alias, one entry per alias. May be empty. */
  entries: AliasEntry[];
}

export interface SignedAliases {
  body: AliasesBody;
  signature: string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_ID = /^[0-9a-f]{32}$/;

export function assertAliasesBody(value: unknown): asserts value is AliasesBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('aliases: the body must be an object');
  }
  const record = value as Partial<Record<keyof AliasesBody, unknown>>;
  for (const key of Object.keys(record)) {
    if (!['v', 'adminKeyId', 'serial', 'issuedAt', 'entries'].includes(key)) {
      throw new Error(`aliases: unknown field "${key}"`);
    }
  }
  if (record.v !== 1) {
    throw new Error(`aliases: unsupported version ${String(record.v)} (this build reads version 1): update machine on this machine (\`machine cli update\`)`);
  }
  if (typeof record.adminKeyId !== 'string' || !KEY_ID.test(record.adminKeyId)) {
    throw new Error('aliases: adminKeyId must be 32 lowercase hex characters');
  }
  if (typeof record.serial !== 'number' || !Number.isSafeInteger(record.serial) || record.serial < 1) {
    throw new Error('aliases: serial must be a positive integer');
  }
  if (typeof record.issuedAt !== 'number' || !Number.isSafeInteger(record.issuedAt) || record.issuedAt < 1) {
    throw new Error('aliases: issuedAt must be epoch seconds');
  }
  if (!Array.isArray(record.entries)) {
    throw new Error('aliases: entries must be a list');
  }
  if (record.entries.length > MAX_ALIASES) {
    throw new Error(`aliases: too many aliases (${record.entries.length}): at most ${MAX_ALIASES}`);
  }
  let previous: string | undefined;
  for (const entry of record.entries as unknown[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('aliases: every entry must be an object { alias, uuid }');
    }
    const e = entry as Record<string, unknown>;
    for (const key of Object.keys(e)) {
      if (key !== 'alias' && key !== 'uuid') {
        throw new Error(`aliases: unknown field "${key}" in an entry`);
      }
    }
    if (typeof e['alias'] !== 'string') {
      throw new Error('aliases: every entry needs a text alias');
    }
    const problem = machineNameProblem(e['alias']);
    if (problem !== undefined) {
      throw new Error(`aliases: alias ${JSON.stringify(e['alias'])} is not valid (${problem})`);
    }
    if (typeof e['uuid'] !== 'string' || !UUID_V4.test(e['uuid'])) {
      throw new Error(`aliases: the uuid of alias "${e['alias']}" must be a lowercase version 4 UUID`);
    }
    if (previous !== undefined && e['alias'] === previous) {
      throw new Error(`aliases: duplicate alias "${e['alias']}"`);
    }
    if (previous !== undefined && e['alias'] < previous) {
      throw new Error('aliases: entries must be sorted by alias');
    }
    previous = e['alias'];
  }
}

/** Signs the list with the unlocked admin key (the body is checked first: no machine would read a body this refuses). */
export async function signAliases(body: AliasesBody, adminPrivateKey: CryptoKey): Promise<SignedAliases> {
  assertAliasesBody(body);
  return signBody(ALIASES_DOMAIN, body as unknown as Json, adminPrivateKey) as unknown as Promise<SignedAliases>;
}

export type AliasChangeFailure = 'invalid-alias' | 'name-taken' | 'lookalike' | 'alias-taken' | 'lookalike-alias' | 'unknown-machine' | 'revoked' | 'no-such-alias' | 'too-many';

export type AliasChange = { action: 'set'; alias: string; uuid: string } | { action: 'rm'; alias: string };

export interface AliasChangeInput {
  change: AliasChange;
  /** The network aliases in force (sorted or not). */
  current: readonly AliasEntry[];
  /** Every machine whose name is taken and that an alias may point to: the trusted peers AND the admin machine. */
  machines: readonly { uuid: string; name: string }[];
  /** Uuids revoked here. */
  revoked: readonly string[];
}

export type AliasChangeResult =
  | { ok: true; alias: string; entries: AliasEntry[]; changed: boolean; /** The typed alias was not valid as typed and was made valid. */ normalized: boolean }
  | { ok: false; reason: AliasChangeFailure; message: string };

const short = (uuid: string): string => uuid.slice(0, 8);
const skeleton = (name: string): string => name.toLowerCase().replace(/-/g, '');
/** `machine "name" (id)` when the machine is listed, `machine id` otherwise: a name tells the reader more than a truncated uuid. */
const labelOf = (machines: readonly { uuid: string; name: string }[], uuid: string, id: string = short(uuid)): string => {
  const known = machines.find((m) => m.uuid === uuid);
  return known === undefined ? `machine ${id}` : `machine "${known.name}" (${id})`;
};
const bySort = (a: AliasEntry, b: AliasEntry): number => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0);

function fail(reason: AliasChangeFailure, message: string): AliasChangeResult {
  return { ok: false, reason, message };
}

export function planAliasChange(input: AliasChangeInput): AliasChangeResult {
  const { change, current, machines } = input;
  if (change.action === 'rm') {
    const alias = change.alias.toLowerCase();
    if (!current.some((e) => e.alias === alias)) {
      return fail('no-such-alias', `no network alias "${alias}"${current.length > 0 ? `: the network aliases are ${current.map((e) => e.alias).join(', ')}` : ' (there is no network alias at all)'}`);
    }
    return { ok: true, alias, entries: current.filter((e) => e.alias !== alias).sort(bySort), changed: true, normalized: false };
  }
  const normalized = normalizeMachineName(change.alias);
  if (!normalized.ok) {
    return fail('invalid-alias', `invalid alias ${JSON.stringify(change.alias)}: it has no letter or digit. Use letters, digits and hyphens, for example: machine admin alias set box <machine>`);
  }
  const alias = normalized.name;
  const problem = machineNameProblem(alias);
  if (problem !== undefined) {
    return fail('invalid-alias', `invalid alias ${JSON.stringify(alias)}: ${problem}`);
  }
  if (input.revoked.includes(change.uuid)) {
    return fail('revoked', `${labelOf(machines, change.uuid, change.uuid)} is revoked here: an alias never points to a revoked machine`);
  }
  if (!machines.some((m) => m.uuid === change.uuid)) {
    return fail('unknown-machine', `machine ${change.uuid} is not a trusted machine of this network: an alias points to a machine this one trusts (\`machine list\` shows them)`);
  }
  const named = machines.find((m) => m.name.toLowerCase() === alias);
  if (named !== undefined) {
    return fail('name-taken', `"${alias}" is already the name of machine "${named.name}" (${short(named.uuid)}): an alias with a machine's name would be ambiguous. Pick another alias`);
  }
  const lookalike = machines.find((m) => skeleton(m.name) === skeleton(alias));
  if (lookalike !== undefined) {
    return fail('lookalike', `the alias "${alias}" differs from the name of machine "${lookalike.name}" (${short(lookalike.uuid)}) only by hyphens or case: easy to mistake for it. Pick a clearly different alias`);
  }
  const same = current.find((e) => e.alias === alias);
  if (same !== undefined && same.uuid === change.uuid) {
    return { ok: true, alias, entries: [...current].sort(bySort), changed: false, normalized: normalized.changed };
  }
  if (same !== undefined) {
    return fail('alias-taken', `the alias "${alias}" already points to ${labelOf(machines, same.uuid)}: remove it first (\`machine admin alias rm ${alias}\`), then set it again`);
  }
  const resembles = current.find((e) => skeleton(e.alias) === skeleton(alias));
  if (resembles !== undefined) {
    return fail('lookalike-alias', `the alias "${alias}" differs from the alias "${resembles.alias}" only by hyphens: easy to mistake for it. Pick a clearly different alias`);
  }
  if (current.length >= MAX_ALIASES) {
    return fail('too-many', `there are already ${current.length} network aliases, the limit is ${MAX_ALIASES}: remove one first (\`machine admin alias rm <alias>\`)`);
  }
  return { ok: true, alias, entries: [...current, { alias, uuid: change.uuid }].sort(bySort), changed: true, normalized: normalized.changed };
}

export interface AliasConflict {
  alias: string;
  local: string;
  network: string;
}

/** The aliases that a local alias and a network alias point at different machines: the local one wins, and the person must be told. */
export function aliasConflicts(local: Readonly<Record<string, string>>, network: Readonly<Record<string, string>>): AliasConflict[] {
  const out: AliasConflict[] = [];
  for (const [alias, uuid] of Object.entries(local)) {
    const other = Object.prototype.hasOwnProperty.call(network, alias) ? network[alias] : undefined;
    if (other !== undefined && other.toLowerCase() !== uuid.toLowerCase()) {
      out.push({ alias, local: uuid, network: other });
    }
  }
  return out;
}
