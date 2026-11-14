import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const spy = <T extends (...args: never[]) => unknown>(name: string, fn: T): T =>
    ((...args: never[]) => {
      calls.push(name);
      return fn(...args);
    }) as T;
  return {
    ...actual,
    openSync: spy('open', actual.openSync),
    writeSync: spy('write', actual.writeSync),
    fsyncSync: spy('fsync', actual.fsyncSync),
    closeSync: spy('close', actual.closeSync),
    renameSync: spy('rename', actual.renameSync),
    writeFileSync: spy('writeFile', actual.writeFileSync),
  };
});

const { writeFileAtomic } = await import('./fsutil.js');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'machine-fsutil-'));
  calls.length = 0;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('writes the content, and leaves no temporary file behind', () => {
    writeFileAtomic(join(dir, 'a.json'), '{"a":1}\n', 0o600);
    expect(readFileSync(join(dir, 'a.json'), 'utf8')).toBe('{"a":1}\n');
    expect(readdirSync(dir)).toEqual(['a.json']);
  });

  it('flushes the data of the file to the disk BEFORE the rename, then closes it', () => {
    writeFileAtomic(join(dir, 'a.json'), 'x', 0o600);
    const order = calls.filter((c) => ['write', 'fsync', 'close', 'rename'].includes(c));
    // The first fsync is the file's, before the rename; the directory sync (where the platform allows it) comes after the rename.
    expect(order.slice(0, 4)).toEqual(['write', 'fsync', 'close', 'rename']);
  });

  it('syncs the directory after the rename where the platform allows it, never failing the write when it does not', () => {
    writeFileAtomic(join(dir, 'a.json'), 'x', 0o600);
    const afterRename = calls.slice(calls.indexOf('rename') + 1);
    if (process.platform === 'win32') expect(afterRename).not.toContain('fsync');
    else expect(afterRename).toContain('fsync');
  });

  it('a failed write removes the temporary file and reports the cause', () => {
    expect(() => writeFileAtomic(join(dir, 'missing', '..', 'x', 'a.json'), 'x', 0o600)).not.toThrow();
    expect(() => writeFileAtomic(dir, 'x', 0o600)).toThrow();
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('withFileLock', () => {
  it('runs the function with the lock held, returns its value and removes the lock', async () => {
    const { withFileLock } = await import('./fsutil.js');
    const file = join(dir, 'state.json');
    const value = withFileLock(file, () => {
      expect(readdirSync(dir)).toContain('state.json.lock');
      return 42;
    });
    expect(value).toBe(42);
    expect(readdirSync(dir)).not.toContain('state.json.lock');
  });

  it('removes the lock when the function throws', async () => {
    const { withFileLock } = await import('./fsutil.js');
    expect(() =>
      withFileLock(join(dir, 'state.json'), () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(readdirSync(dir)).not.toContain('state.json.lock');
  });

  it('a lock held by a live process is waited for, then refused with the file and the way out (no silent overwrite)', async () => {
    const { withFileLock } = await import('./fsutil.js');
    const { writeFileSync } = await import('node:fs');
    const file = join(dir, 'state.json');
    writeFileSync(`${file}.lock`, `${process.pid} ${Date.now()}\n`);
    expect(() => withFileLock(file, () => 1, { timeoutMs: 150 })).toThrow(/state\.json\.lock.*(held|another)/s);
    expect(readdirSync(dir)).toContain('state.json.lock');
  });

  it('a lock left by a process that no longer exists is stale and taken over', async () => {
    const { withFileLock } = await import('./fsutil.js');
    const { writeFileSync } = await import('node:fs');
    const file = join(dir, 'state.json');
    writeFileSync(`${file}.lock`, `2147483000 ${Date.now()}\n`);
    expect(withFileLock(file, () => 'ok', { timeoutMs: 500 })).toBe('ok');
  });

  it('a lock older than the stale delay is taken over even when its pid looks alive (a recycled pid)', async () => {
    const { withFileLock } = await import('./fsutil.js');
    const { writeFileSync, utimesSync } = await import('node:fs');
    const file = join(dir, 'state.json');
    writeFileSync(`${file}.lock`, `${process.pid} 1\n`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, old, old);
    expect(withFileLock(file, () => 'ok', { timeoutMs: 500, staleMs: 10_000 })).toBe('ok');
  });
});
