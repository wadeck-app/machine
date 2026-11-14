import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isUuid, machineNameProblem } from '@wadeck-app/machine-core';
import { AliasConflictError, NoSuchAliasError } from './errors.js';
import { writeFileAtomic } from './fsutil.js';

interface StateFile {
  v: 1;
  aliases: Record<string, string>;
}


function stateFile(configDir: string): string {
  return join(configDir, 'state.json');
}

function readState(configDir: string): StateFile {
  const path = stateFile(configDir);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { v: 1, aliases: {} };
    throw new Error(`cannot read ${path}: ${(e as Error).message}`);
  }
  const corrupt = (why: string) => new Error(`${path} is corrupt or invalid (${why}): fix or delete it (only local aliases are stored there)`);
  let raw: Partial<StateFile>;
  try {
    raw = JSON.parse(text) as Partial<StateFile>;
  } catch {
    throw corrupt('not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw corrupt('unexpected shape');
  if (raw.v !== 1 || typeof raw.aliases !== 'object' || raw.aliases === null || Array.isArray(raw.aliases)) throw corrupt('unexpected shape');
  for (const [alias, uuid] of Object.entries(raw.aliases)) {
    if (machineNameProblem(alias) || typeof uuid !== 'string' || !isUuid(uuid)) throw corrupt(`alias ${JSON.stringify(alias)} is invalid`);
  }
  return { v: 1, aliases: { ...raw.aliases } };
}

export function readAliases(configDir: string): Record<string, string> {
  return readState(configDir).aliases;
}

export function setAlias(configDir: string, alias: string, uuid: string, options: { replace?: boolean } = {}): { previous?: string } {
  const problem = machineNameProblem(alias);
  if (problem) throw new Error(`invalid alias ${JSON.stringify(alias)}: ${problem}`);
  if (!isUuid(uuid)) throw new Error(`an alias must point to a machine UUID, got ${JSON.stringify(uuid)}`);
  const state = readState(configDir);
  const previous = Object.prototype.hasOwnProperty.call(state.aliases, alias) ? state.aliases[alias] : undefined;
  if (previous !== undefined && previous !== uuid && !options.replace) {
    throw new AliasConflictError(`alias "${alias}" already points to ${previous}: pass --replace to repoint it`);
  }
  state.aliases[alias] = uuid;
  writeFileAtomic(stateFile(configDir), `${JSON.stringify(state, null, 2)}\n`, 0o600);
  return previous !== undefined && previous !== uuid ? { previous } : {};
}

export function removeAlias(configDir: string, alias: string): void {
  const state = readState(configDir);
  if (!Object.prototype.hasOwnProperty.call(state.aliases, alias)) throw new NoSuchAliasError(alias);
  delete state.aliases[alias];
  writeFileAtomic(stateFile(configDir), `${JSON.stringify(state, null, 2)}\n`, 0o600);
}
