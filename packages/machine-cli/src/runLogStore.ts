import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { parseRunLogLines, RUN_LOG_MAX_LINE, type RunLogEntry } from '@wadeck-app/machine-core';

// The files of the OUTGOING run log (run-log.md): `<configDir>/run-log/runs.ndjson` is the current file, `runs.<stamp>-<pid>.ndjson` the rotated
// ones. Same modes as the audit log (folder 0700, files 0600). Appending is ONE write of one line (O_APPEND, under 4 KiB), so two `machine run`
// processes never interleave inside a line. Rotation is a rename (never a truncation in place): a crash leaves every line in one file or the other.
// A log that cannot be written never blocks a run: the caller prints the warnings returned here.

export const RUN_LOG_DIRNAME = 'run-log';
export const RUN_LOG_FILE = 'runs.ndjson';
export const RUN_LOG_DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
/** Files kept, the current one included. */
export const RUN_LOG_DEFAULT_KEEP_FILES = 5;

const ROTATED = /^runs\.(\d{13,})-(\d+)\.ndjson$/;

export interface RunLogStoreOptions {
  maxBytes?: number;
  keepFiles?: number;
}

export interface AppendResult {
  written: boolean;
  /** What to tell the person, one sentence each (a rotation that failed does not stop the line from being written). */
  warnings: string[];
}

export const runLogDir = (configDir: string): string => join(configDir, RUN_LOG_DIRNAME);

const codeOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;

/** The rotated files, oldest first. */
function rotatedFiles(dir: string): Array<{ name: string; stamp: number; pid: number }> {
  const found: Array<{ name: string; stamp: number; pid: number }> = [];
  for (const name of readdirSync(dir)) {
    const m = ROTATED.exec(name);
    if (m !== null) {
      found.push({ name, stamp: Number(m[1]), pid: Number(m[2]) });
    }
  }
  return found.sort((a, b) => a.stamp - b.stamp || a.pid - b.pid);
}

function rotateIfFull(dir: string, incomingBytes: number, maxBytes: number, keepFiles: number, warnings: string[]): void {
  const current = join(dir, RUN_LOG_FILE);
  let size: number;
  try {
    size = statSync(current).size;
  } catch (e) {
    if (codeOf(e) === 'ENOENT') {
      return;
    }
    throw e;
  }
  if (size === 0 || size + incomingBytes <= maxBytes) {
    return;
  }
  // Newer than every file already there, so two rotations in the same millisecond never meet on one name (a rename onto an existing file would replace it).
  const newest = rotatedFiles(dir).at(-1)?.stamp ?? 0;
  const stamp = Math.max(Date.now(), newest + 1);
  try {
    renameSync(current, join(dir, `runs.${String(stamp).padStart(13, '0')}-${process.pid}.ndjson`));
  } catch (e) {
    // Another process rotated it first: the file we saw full is already moved, the line goes to the new current file.
    if (codeOf(e) !== 'ENOENT') {
      warnings.push(`cannot rotate the run log ${current}: ${(e as Error).message}. It keeps growing past ${maxBytes} bytes until this is fixed (permissions of ${dir}, or a program holding the file open)`);
      return;
    }
  }
  const rotated = rotatedFiles(dir);
  for (const old of rotated.slice(0, Math.max(0, rotated.length - (keepFiles - 1)))) {
    try {
      unlinkSync(join(dir, old.name));
    } catch (e) {
      if (codeOf(e) !== 'ENOENT') {
        warnings.push(`cannot delete the old run log ${join(dir, old.name)}: ${(e as Error).message}. Delete it by hand to free the space`);
      }
    }
  }
}

/** Appends one line built by machine-core `buildRunLogLine`. Never throws: a failure is returned as a warning to print. */
export function appendRunLog(configDir: string, line: string, options: RunLogStoreOptions = {}): AppendResult {
  const dir = runLogDir(configDir);
  const warnings: string[] = [];
  const bytes = Buffer.from(line, 'utf8');
  const lineBreaks = line.split('\n').length - 1;
  if (!line.endsWith('\n') || lineBreaks !== 1 || bytes.length > RUN_LOG_MAX_LINE) {
    return { written: false, warnings: [`this run is NOT recorded in ${dir}: the entry is not one line of at most ${RUN_LOG_MAX_LINE} bytes (this is a bug of machine: report it with the command you ran)`] };
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    rotateIfFull(dir, bytes.length, options.maxBytes ?? RUN_LOG_DEFAULT_MAX_BYTES, options.keepFiles ?? RUN_LOG_DEFAULT_KEEP_FILES, warnings);
    const fd = openSync(join(dir, RUN_LOG_FILE), 'a', 0o600);
    try {
      const written = writeSync(fd, bytes);
      if (written !== bytes.length) {
        throw new Error(`only ${written} of ${bytes.length} bytes were written (disk full?)`);
      }
    } finally {
      closeSync(fd);
    }
    return { written: true, warnings };
  } catch (e) {
    return { written: false, warnings: [...warnings, `this run is NOT recorded in the run log ${dir}: ${(e as Error).message}. The run itself is not affected; fix the permissions or the free disk space of that folder (or remove it if it is not a folder)`] };
  }
}

export interface RunLogRead {
  /** Oldest file first, file order inside each: roughly oldest first (the reader of the timeline sorts by time). */
  entries: RunLogEntry[];
  /** Lines that are not valid entries, over all files. */
  damaged: number;
  files: number;
}

/** Every entry of the kept files. No folder yet is an empty log (no run was ever sent); a folder that cannot be read is an error with its fix. */
export function readRunLog(configDir: string): RunLogRead {
  const dir = runLogDir(configDir);
  let names: string[];
  try {
    names = rotatedFiles(dir).map((f) => f.name);
  } catch (e) {
    if (codeOf(e) === 'ENOENT') {
      return { entries: [], damaged: 0, files: 0 };
    }
    throw new Error(`cannot read the run log folder ${dir}: ${(e as Error).message}. Fix its permissions, or move it away if it is not a folder (a new log starts at the next run)`);
  }
  const entries: RunLogEntry[] = [];
  let damaged = 0;
  let files = 0;
  for (const name of [...names, RUN_LOG_FILE]) {
    let text: string;
    try {
      text = readFileSync(join(dir, name), 'utf8');
    } catch (e) {
      // Rotated or deleted by another process between the listing and the read, or no current file yet.
      if (codeOf(e) === 'ENOENT') {
        continue;
      }
      throw new Error(`cannot read the run log ${join(dir, name)}: ${(e as Error).message}. Fix its permissions, or move it away (a new log starts at the next run)`);
    }
    const parsed = parseRunLogLines(text);
    entries.push(...parsed.entries);
    damaged += parsed.damaged;
    files += 1;
  }
  return { entries, damaged, files };
}
