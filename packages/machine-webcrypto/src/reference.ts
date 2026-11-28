// Copies of machine-core `machineNameProblem` and `normalizeMachineName` (reference.ts), message for message: the page checks the names it signs the way the machines
// read them. reference.test.ts proves the answers equal on a table of names.

export interface MachineEntry {
  uuid: string;
  name: string;
}

const HEX_PREFIX = /^[0-9a-f-]{4,}$/;

/** Why `name` is not a valid machine name, or undefined when it is one. */
export function machineNameProblem(name: string): string | undefined {
  if (name.length < 1 || name.length > 32) return 'a name is 1 to 32 characters';
  const lower = name.toLowerCase();
  if (!/^[a-z0-9-]+$/.test(lower)) return 'a name uses letters, digits and hyphens only';
  if (name !== lower) return 'a name is lowercase (references are case-insensitive)';
  if (name.startsWith('-')) return 'a name must start with a letter or a digit';
  if (HEX_PREFIX.test(name)) return 'a name must not be only hexadecimal digits and hyphens: it would look like a UUID prefix';
  return undefined;
}

export type NormalizedName = { ok: true; name: string; changed: boolean } | { ok: false; message: string };

/** Make a typed name a valid one: lowercase, accents removed, other runs a single hyphen, at most 32 characters, never hexadecimal only. */
export function normalizeMachineName(input: string): NormalizedName {
  const trim = (text: string) => text.replace(/^-+|-+$/g, '');
  let name = trim(
    input
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-'),
  );
  if (name.length === 0) {
    return { ok: false, message: `${JSON.stringify(input)} has no letters or digits to build a machine name from: pass one with --name <name> (letters, digits and hyphens, for example --name desktop)` };
  }
  name = trim(name.slice(0, 32));
  if (HEX_PREFIX.test(name)) name = trim(`host-${name}`.slice(0, 32));
  return { ok: true, name, changed: name !== input };
}
