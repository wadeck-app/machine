import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseRunDefaults, serializeRunDefaults, type RunDefaults } from '@wadeck-app/machine-core';
import { withFileLock, writeFileAtomic } from './fsutil.js';

// <configDir>/run-defaults.json: what `machine run` does when the target does not allow the command yet (the machine setting, below the flags of
// the command and above the built-in default). Public data (no secret), unsigned, local to the caller. Written by `machine run-defaults`.

export const runDefaultsFile = (configDir: string): string => join(configDir, 'run-defaults.json');

/** The file cannot be read as it is: the message names the path, the cause and the way out. */
export class RunDefaultsError extends Error {}

const unusable = (file: string, why: string): RunDefaultsError =>
  new RunDefaultsError(
    `${file} cannot be used (${why}): it holds the machine setting of \`machine run\` (what to do when the target does not allow a command yet), nothing secret. Run \`machine run-defaults --reset\` to delete it and go back to the built-in default (wait 10m), or edit the field named above`,
  );

/** Undefined when the file does not exist (not set: the built-in default applies). A file that does not validate stops the command. */
export function readRunDefaults(configDir: string): RunDefaults | undefined {
  const file = runDefaultsFile(configDir);
  if (!existsSync(file)) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw unusable(file, 'not valid JSON');
  }
  try {
    return parseRunDefaults(raw);
  } catch (e) {
    throw unusable(file, (e as Error).message);
  }
}

/** One locked read-modify-write. The result is validated before anything is written, so an invalid change leaves the file as it was. */
export function updateRunDefaults(configDir: string, change: { onRefusal?: 'wait' | 'fail'; waitSeconds?: number }): RunDefaults {
  const file = runDefaultsFile(configDir);
  return withFileLock(file, () => {
    const current = readRunDefaults(configDir) ?? { v: 1 as const };
    const next = parseRunDefaults({ ...current, ...change });
    writeFileAtomic(file, serializeRunDefaults(next), 0o644);
    return next;
  });
}

/** True when there was a file to delete. */
export function clearRunDefaults(configDir: string): boolean {
  const file = runDefaultsFile(configDir);
  return withFileLock(file, () => {
    if (!existsSync(file)) {
      return false;
    }
    rmSync(file);
    return true;
  });
}
