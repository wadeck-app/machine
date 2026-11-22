import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { classifyAuditLine, parseRunLogLine, type ActivityPhase, type ActivitySources } from '@wadeck-app/machine-core';
import { runLogFilesNewestFirst } from './runLogStore.js';

// The files behind the Activity page and `machine log` (run-log.md). The logs can be big (the run log is 5 files of 5 MiB, the audit log never
// rotates), so a page is NEVER read by loading a file:
//  - the lines come from the END of the newest file, in chunks, and stop as soon as the page is full (reverseLines);
//  - the number of rows of each file is counted once and kept in a cache keyed by size and modification time; an appended file is counted from where
//    the cache stopped, a file changed any other way is recounted from the start and SAID (never a stale count);
//  - the audit chain is not verified here (the daemon does it at start): machine-core checks the lines it read against each other.

/** Stands for a line longer than the bound: not kept in memory, and a damaged line for every parser. */
export const OVERSIZED_LINE = '\u0000oversized-line';
const DEFAULT_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const FINGERPRINT_BYTES = 64;

export interface ReadOptions {
  chunkBytes?: number;
  maxLineBytes?: number;
}

/** A log that cannot be read; `reason` is the one of the daemon answer. */
export class ActivityReadError extends Error {
  readonly reason: 'run-log-unreadable' | 'audit-log-unreadable';
  constructor(reason: 'run-log-unreadable' | 'audit-log-unreadable', message: string) {
    super(message);
    this.name = 'ActivityReadError';
    this.reason = reason;
  }
}

const codeOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;
const unreadable = (path: string, e: unknown): Error => new Error(`cannot read the log ${path}: ${(e as Error).message}. Fix its permissions, then run the command again`);

function readFully(fd: number, buffer: Buffer, position: number, path: string): void {
  let done = 0;
  while (done < buffer.length) {
    let n: number;
    try {
      n = readSync(fd, buffer, done, buffer.length - done, position + done);
    } catch (e) {
      throw unreadable(path, e);
    }
    if (n === 0) {
      throw new Error(`cannot read the log ${path}: it ended ${buffer.length - done} bytes early (the file was cut while it was read). Run the command again`);
    }
    done += n;
  }
}

function openLog(path: string): number | undefined {
  try {
    return openSync(path, 'r');
  } catch (e) {
    // Rotated or deleted by another process between the listing and the read.
    if (codeOf(e) === 'ENOENT') {
      return undefined;
    }
    throw unreadable(path, e);
  }
}

/**
 * The lines of a file from the last to the first, read from the end in chunks of `chunkBytes`: stopping early costs only the chunks read.
 * The size is the one when the file was opened (a line appended meanwhile is not seen). A line longer than `maxLineBytes` is dropped from memory
 * and given as OVERSIZED_LINE. A file that does not exist (rotated away meanwhile) has no lines.
 */
export function* reverseLines(path: string, onBytes: (n: number) => void, options: ReadOptions = {}): Generator<string> {
  const chunk = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const maxLine = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const fd = openLog(path);
  if (fd === undefined) {
    return;
  }
  try {
    let pos: number;
    try {
      pos = fstatSync(fd).size;
    } catch (e) {
      throw unreadable(path, e);
    }
    // The beginning-less end of the line the previous chunk started in the middle of.
    let carry: Buffer = Buffer.alloc(0);
    // Inside a line longer than the bound: its end was dropped, the next newline found going back is its start.
    let skipping = false;
    while (pos > 0) {
      const start = Math.max(0, pos - chunk);
      const buf = Buffer.allocUnsafe(pos - start);
      readFully(fd, buf, start, path);
      onBytes(buf.length);
      pos = start;
      const data = carry.length === 0 ? buf : Buffer.concat([buf, carry]);
      let end = data.length;
      for (;;) {
        const idx = end === 0 ? -1 : data.lastIndexOf(0x0a, end - 1);
        if (idx === -1) {
          if (skipping) {
            carry = Buffer.alloc(0);
          } else if (end > maxLine) {
            skipping = true;
            carry = Buffer.alloc(0);
          } else {
            carry = data.subarray(0, end);
          }
          break;
        }
        if (skipping) {
          yield OVERSIZED_LINE;
          skipping = false;
        } else if (end - idx - 1 > maxLine) {
          yield OVERSIZED_LINE;
        } else if (end - idx - 1 > 0) {
          yield data.toString('utf8', idx + 1, end);
        }
        end = idx;
      }
    }
    if (skipping) {
      yield OVERSIZED_LINE;
    } else if (carry.length > 0) {
      yield carry.toString('utf8');
    }
  } finally {
    closeSync(fd);
  }
}

// ----------------------------------------------------------------------------------------------------- the cache of counts

export type LogKind = 'sent' | 'audit';

interface Tally {
  rows: number;
  damaged: number;
}

interface CachedCount {
  size: number;
  mtimeMs: number;
  /** Offset after the last newline: the lines before it are in `base`, and never change but by an append. */
  endOffset: number;
  /** The last bytes before `endOffset`: an append leaves them as they were. */
  fingerprint: string;
  base: Tally;
  /** `base` plus the line that has no newline yet, if any. */
  total: Tally;
}

/** The counts of the files, by path, kept as long as the process lives (the daemon keeps them between two page requests). */
export type CountCache = Map<string, CachedCount>;
export const createCountCache = (): CountCache => new Map();

function classify(kind: LogKind, line: string): 'row' | 'damaged' | 'other' {
  if (kind === 'sent') {
    return parseRunLogLine(line) === 'damaged' ? 'damaged' : 'row';
  }
  return classifyAuditLine(line);
}

function fingerprintOf(fd: number, endOffset: number, path: string): string {
  const from = Math.max(0, endOffset - FINGERPRINT_BYTES);
  const buf = Buffer.allocUnsafe(endOffset - from);
  if (buf.length > 0) {
    readFully(fd, buf, from, path);
  }
  return buf.toString('hex');
}

/**
 * Rows and damaged lines of a file. A file whose size and modification time are those of the last count costs nothing. A file that only grew
 * (the bytes before the old end are as they were) is counted from the old end. Any other change recounts the whole file and adds a sentence to
 * `notes`: a count is never served stale.
 */
export function countLogFile(cache: CountCache, path: string, kind: LogKind, onBytes: (n: number) => void, notes: string[], options: ReadOptions = {}): Tally {
  let st;
  try {
    st = statSync(path);
  } catch (e) {
    if (codeOf(e) === 'ENOENT') {
      cache.delete(path);
      return { rows: 0, damaged: 0 };
    }
    throw unreadable(path, e);
  }
  const known = cache.get(path);
  if (known !== undefined && known.size === st.size && known.mtimeMs === st.mtimeMs) {
    return known.total;
  }
  const fd = openLog(path);
  if (fd === undefined) {
    cache.delete(path);
    return { rows: 0, damaged: 0 };
  }
  try {
    const now = fstatSync(fd);
    let base: Tally = { rows: 0, damaged: 0 };
    let from = 0;
    if (known !== undefined) {
      if (now.size > known.size && fingerprintOf(fd, known.endOffset, path) === known.fingerprint) {
        base = { ...known.base };
        from = known.endOffset;
      } else {
        notes.push(`the ${kind === 'sent' ? 'run log' : 'audit log'} file ${path} changed other than by appending (its size or content is not what the last count saw): its entries were recounted from the start`);
      }
    }
    const chunk = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    const maxLine = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    const add = (tally: Tally, line: string): void => {
      const c = classify(kind, line);
      if (c === 'row') {
        tally.rows += 1;
      } else if (c === 'damaged') {
        tally.damaged += 1;
      }
    };
    let endOffset = from;
    let pos = from;
    let carry: Buffer = Buffer.alloc(0);
    let overflow = false;
    while (pos < now.size) {
      const buf = Buffer.allocUnsafe(Math.min(chunk, now.size - pos));
      readFully(fd, buf, pos, path);
      onBytes(buf.length);
      const data = carry.length === 0 ? buf : Buffer.concat([carry, buf]);
      const dataStart = pos - carry.length;
      pos += buf.length;
      let lineStart = 0;
      for (;;) {
        const idx = data.indexOf(0x0a, lineStart);
        if (idx === -1) {
          break;
        }
        if (overflow) {
          add(base, OVERSIZED_LINE);
          overflow = false;
        } else if (idx - lineStart > maxLine) {
          add(base, OVERSIZED_LINE);
        } else if (idx - lineStart > 0) {
          add(base, data.toString('utf8', lineStart, idx));
        }
        lineStart = idx + 1;
        endOffset = dataStart + lineStart;
      }
      const rest = data.subarray(lineStart);
      if (overflow || rest.length > maxLine) {
        overflow = true;
        carry = Buffer.alloc(0);
      } else {
        carry = rest;
      }
    }
    const total = { ...base };
    if (overflow) {
      add(total, OVERSIZED_LINE);
    } else if (carry.length > 0) {
      // A last line with no newline: a crash cut it, or it is being written; counted for now, recounted at the next look.
      add(total, carry.toString('utf8'));
    }
    cache.set(path, { size: now.size, mtimeMs: now.mtimeMs, endOffset, fingerprint: fingerprintOf(fd, endOffset, path), base, total });
    return total;
  } finally {
    closeSync(fd);
  }
}

// ------------------------------------------------------------------------------------------------------------ the sources

/** Bytes read from disk, by why: the lines of the page, the pass that counts a filter, and the cache of totals. */
export interface ActivityBytes extends Record<ActivityPhase, number> {
  cache: number;
}

export interface ActivityLogs {
  sources: ActivitySources;
  bytes: ActivityBytes;
  /** Files whose count was redone because they changed other than by appending (the totals are right, say so). */
  notes: string[];
  runLogFiles: number;
  auditPresent: boolean;
}

/** Wraps a read so that a failure says which log it was and carries the reason the daemon answers. */
function* guarded<T>(reason: ActivityReadError['reason'], inner: Generator<T>): Generator<T> {
  try {
    yield* inner;
  } catch (e) {
    if (e instanceof ActivityReadError) {
      throw e;
    }
    throw new ActivityReadError(reason, (e as Error).message);
  }
}

export function openActivityLogs(configDir: string, cache: CountCache, auditFile: string, options: ReadOptions = {}): ActivityLogs {
  let files: string[];
  try {
    files = runLogFilesNewestFirst(configDir);
  } catch (e) {
    throw new ActivityReadError('run-log-unreadable', (e as Error).message);
  }
  const auditPresent = existsSync(auditFile);
  const bytes: ActivityBytes = { page: 0, count: 0, cache: 0 };
  const notes: string[] = [];

  function* sentLines(phase: ActivityPhase): Generator<string> {
    for (const file of files) {
      yield* reverseLines(file, (n) => { bytes[phase] += n; }, options);
    }
  }
  function* auditLines(phase: ActivityPhase): Generator<string> {
    if (auditPresent) {
      yield* reverseLines(auditFile, (n) => { bytes[phase] += n; }, options);
    }
  }
  const knownRows = (): { sent: number; received: number; damaged: { sent: number; received: number } } => {
    const sent: Tally = { rows: 0, damaged: 0 };
    try {
      for (const file of files) {
        const t = countLogFile(cache, file, 'sent', (n) => { bytes.cache += n; }, notes, options);
        sent.rows += t.rows;
        sent.damaged += t.damaged;
      }
    } catch (e) {
      throw new ActivityReadError('run-log-unreadable', (e as Error).message);
    }
    let received: Tally = { rows: 0, damaged: 0 };
    if (auditPresent) {
      try {
        received = countLogFile(cache, auditFile, 'audit', (n) => { bytes.cache += n; }, notes, options);
      } catch (e) {
        throw new ActivityReadError('audit-log-unreadable', (e as Error).message);
      }
    }
    return { sent: sent.rows, received: received.rows, damaged: { sent: sent.damaged, received: received.damaged } };
  };

  return {
    sources: {
      sentLines: (phase) => guarded('run-log-unreadable', sentLines(phase)),
      auditLines: (phase) => guarded('audit-log-unreadable', auditLines(phase)),
      knownRows,
    },
    bytes,
    notes,
    runLogFiles: files.length,
    auditPresent,
  };
}
