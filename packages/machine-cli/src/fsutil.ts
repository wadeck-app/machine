import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Write a file so that a crash never leaves a half-written one: temp file in the same folder, data flushed to the disk, then rename. The
 * flush matters for counters and state (a rename without it can survive a power cut with an empty file); the directory is synced after the
 * rename where the platform allows it (Windows does not allow opening a directory: skipped there).
 */
export function writeFileAtomic(file: string, content: string, mode: number): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  const fd = openSync(temp, 'w', mode);
  try {
    const data = Buffer.from(content, 'utf8');
    let written = 0;
    while (written < data.length) written += writeSync(fd, data, written);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    removeQuietly(temp);
    throw e;
  }
  closeSync(fd);
  try {
    renameSync(temp, file);
  } catch (e) {
    removeQuietly(temp);
    throw e;
  }
  syncDirectory(dirname(file));
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // The temporary file is already gone: nothing to clean.
  }
}

function syncDirectory(dir: string): void {
  if (process.platform === 'win32') return;
  let fd: number | undefined;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // Some file systems refuse to sync a directory: the data of the file itself was flushed, which is what this function promises.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface LockOptions {
  /** How long to wait for another holder (default 5 s). */
  timeoutMs?: number;
  /** A lock file older than this is taken over whatever its pid says (default 30 s: a holder keeps the lock for a few milliseconds). */
  staleMs?: number;
}

const sleep = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function holderIsAlive(lockFile: string): boolean {
  try {
    const pid = Number.parseInt(readFileSync(lockFile, 'utf8').split(' ')[0] ?? '', 10);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else: alive.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Runs `fn` while holding `<file>.lock` (created with O_EXCL, so two processes never hold it together). The read-modify-write of a state file
 * that several commands and the daemon touch belongs inside it. A lock whose holder is gone, or that is older than `staleMs`, is taken over;
 * a live holder is waited for and, after `timeoutMs`, refused loudly (the lock is never removed under a live process).
 */
export function withFileLock<T>(file: string, fn: () => T, options: LockOptions = {}): T {
  const lockFile = `${file}.lock`;
  const timeoutMs = options.timeoutMs ?? 5000;
  const staleMs = options.staleMs ?? 30_000;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lockFile, 'wx', 0o600);
      try {
        writeSync(fd, `${process.pid} ${Date.now()}\n`);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let stale = false;
    try {
      stale = Date.now() - statSync(lockFile).mtimeMs > staleMs || !holderIsAlive(lockFile);
    } catch {
      // The holder just released it: try again at once.
      continue;
    }
    if (stale) {
      removeQuietly(lockFile);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`${lockFile} is held by another machine process (waited ${Math.round(timeoutMs / 1000)} s): wait for the other command to finish; if no machine command or daemon is running, delete that file`);
    }
    sleep(20);
  }
  try {
    return fn();
  } finally {
    removeQuietly(lockFile);
  }
}
