// Machine references (decision 11): UUID, local alias, name, or unique UUID prefix of 4+ hex characters.
// Same shape as the project and task references: case-insensitive, never a path, explicit errors with candidates.

export interface MachineEntry {
  uuid: string;
  name: string;
}

export type Resolution =
  | { ok: true; uuid: string; via: 'uuid' | 'alias' | 'name' | 'prefix' }
  | { ok: false; reason: 'invalid' | 'unknown' | 'ambiguous'; message: string; candidates: MachineEntry[] };

const REFERENCE = /^[A-Za-z0-9-]{1,64}$/;
const HEX_PREFIX = /^[0-9a-f-]{4,}$/;
const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const shortId = (uuid: string) => uuid.slice(0, 8);
const describe = (m: MachineEntry) => `${m.name} (${shortId(m.uuid)})`;

function fail(reason: 'invalid' | 'unknown' | 'ambiguous', message: string, candidates: MachineEntry[] = []): Resolution {
  return { ok: false, reason, message, candidates };
}

/** `aliases` maps a lowercase local alias to a machine UUID. */
export function resolveMachineRef(reference: string, machines: readonly MachineEntry[], aliases: Readonly<Record<string, string>>): Resolution {
  if (!REFERENCE.test(reference)) {
    return fail('invalid', `invalid machine reference ${JSON.stringify(reference)}: use a name, an alias or a UUID (letters, digits and hyphens, 1 to 64 characters), never a path`);
  }
  const ref = reference.toLowerCase();
  const find = (uuid: string) => machines.find((m) => m.uuid.toLowerCase() === uuid.toLowerCase());

  if (FULL_UUID.test(ref)) {
    const m = find(ref);
    if (m) return { ok: true, uuid: m.uuid, via: 'uuid' };
    return fail('unknown', `no registered machine has the UUID ${ref}: ${knownList(machines)}`, [...machines]);
  }

  const aliased = Object.prototype.hasOwnProperty.call(aliases, ref) ? aliases[ref] : undefined;
  if (aliased !== undefined) {
    const m = find(aliased);
    if (m) return { ok: true, uuid: m.uuid, via: 'alias' };
    return fail('unknown', `alias "${ref}" points to a machine that is not registered (${aliased}): remove the alias or point it to a registered machine`, [...machines]);
  }

  const byName = machines.filter((m) => m.name.toLowerCase() === ref);
  if (byName.length === 1) return { ok: true, uuid: (byName[0] as MachineEntry).uuid, via: 'name' };
  if (byName.length > 1) {
    return fail('ambiguous', `several machines are named "${ref}": ${byName.map(describe).join(', ')}; use a UUID prefix or set a local alias`, byName);
  }

  if (HEX_PREFIX.test(ref)) {
    const byPrefix = machines.filter((m) => m.uuid.toLowerCase().startsWith(ref));
    if (byPrefix.length === 1) return { ok: true, uuid: (byPrefix[0] as MachineEntry).uuid, via: 'prefix' };
    if (byPrefix.length > 1) {
      return fail('ambiguous', `"${ref}" matches several machines: ${byPrefix.map(describe).join(', ')}; use a longer prefix, a name or an alias`, byPrefix);
    }
  }

  return fail('unknown', `unknown machine "${ref}": ${knownList(machines)}`, [...machines]);
}

function knownList(machines: readonly MachineEntry[]): string {
  return machines.length === 0 ? 'no machine is registered yet (run `machine list` after enrollment)' : `known machines: ${machines.map((m) => m.name).join(', ')}`;
}

/** Why a machine name or alias is not acceptable, or undefined. Lowercase only, so that references stay case-insensitive. */
export function machineNameProblem(name: string): string | undefined {
  if (name.length < 1 || name.length > 32) return 'a name is 1 to 32 characters';
  const lower = name.toLowerCase();
  if (!/^[a-z0-9-]+$/.test(lower)) return 'a name uses letters, digits and hyphens only';
  if (name !== lower) return 'a name is lowercase (references are case-insensitive)';
  if (name.startsWith('-')) return 'a name must start with a letter or a digit';
  if (HEX_PREFIX.test(name)) return 'a name must not be only hexadecimal digits and hyphens: it would look like a UUID prefix';
  return undefined;
}
