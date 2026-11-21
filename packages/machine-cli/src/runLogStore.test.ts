import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildRunLogLine, type RunLogInput } from '@wadeck-app/machine-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const writes = vi.hoisted(() => [] as number[]);

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeSync: ((...args: Parameters<typeof actual.writeSync>) => {
      writes.push(typeof args[1] === 'string' ? Buffer.byteLength(args[1]) : (args[1] as Uint8Array).length);
      return (actual.writeSync as (...a: unknown[]) => number)(...args);
    }) as typeof actual.writeSync,
  };
});

const { RUN_LOG_DIRNAME, RUN_LOG_FILE, appendRunLog, readRunLog, runLogDir } = await import('./runLogStore.js');

const SELF = { name: 'laptop', uuid: '11111111-1111-4111-8111-111111111111' };
const PEER = { name: 'desk', uuid: '22222222-2222-4222-8222-222222222222' };

function lineFor(n: number, over: Partial<RunLogInput> = {}): string {
  return buildRunLogLine({ now: Date.UTC(2026, 10, 21, 10, 0, 0) + n * 1000, runId: `run-${n}`, from: SELF, to: PEER, shell: 'sh', command: `echo ${n}`, waitMode: 'default', onRefusal: 'wait', waitSeconds: 600, waitedSeconds: 0, outcome: { outcome: 'ran', exitCode: 0 }, durationMs: 10, ...over });
}

let configDir: string;
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'machine-runlog-'));
  writes.length = 0;
});
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe('appendRunLog', () => {
  it('creates <configDir>/run-log/runs.ndjson and appends one line per call, in order', () => {
    expect(runLogDir(configDir)).toBe(join(configDir, RUN_LOG_DIRNAME));
    expect(appendRunLog(configDir, lineFor(1))).toEqual({ written: true, warnings: [] });
    appendRunLog(configDir, lineFor(2));
    const text = readFileSync(join(runLogDir(configDir), RUN_LOG_FILE), 'utf8');
    expect(text.split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { runId: string }).runId)).toEqual(['run-1', 'run-2']);
  });

  it.skipIf(process.platform === 'win32')('uses the modes of the audit log: folder 0700, file 0600', () => {
    appendRunLog(configDir, lineFor(1));
    expect(statSync(runLogDir(configDir)).mode & 0o777).toBe(0o700);
    expect(statSync(join(runLogDir(configDir), RUN_LOG_FILE)).mode & 0o777).toBe(0o600);
  });

  it('appends a line with ONE write of the whole line (two processes never interleave inside a line)', () => {
    const line = lineFor(1);
    appendRunLog(configDir, line);
    expect(writes).toEqual([Buffer.byteLength(line)]);
  });

  it('refuses a line that is not exactly one line under 4 KiB, loudly, and writes nothing', () => {
    expect(appendRunLog(configDir, 'no newline')).toMatchObject({ written: false });
    expect(appendRunLog(configDir, 'two\nlines\n')).toMatchObject({ written: false });
    expect(appendRunLog(configDir, `${'x'.repeat(4097)}\n`)).toMatchObject({ written: false });
    expect(existsSync(join(runLogDir(configDir), RUN_LOG_FILE))).toBe(false);
  });

  it('never throws when the log cannot be written: the warning names the folder and the fix', () => {
    // A FILE where the folder should be.
    writeFileSync(join(configDir, RUN_LOG_DIRNAME), 'not a folder');
    const result = appendRunLog(configDir, lineFor(1));
    expect(result.written).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(runLogDir(configDir));
    expect(result.warnings[0]).toMatch(/NOT recorded/);
    expect(result.warnings[0]).toMatch(/permissions|disk space|remove/);
  });
});

describe('rotation', () => {
  const small = { maxBytes: 600, keepFiles: 3 };
  const files = (): string[] => readdirSync(runLogDir(configDir)).sort();

  it('moves the full file aside by rename (nothing is truncated) and continues in a new one', () => {
    const small = { maxBytes: 3 * Buffer.byteLength(lineFor(1)) + 10, keepFiles: 3 };
    const first = [lineFor(1), lineFor(2), lineFor(3)];
    for (const l of first) {
      appendRunLog(configDir, l, small);
    }
    expect(files()).toEqual([RUN_LOG_FILE]);
    const before = readFileSync(join(runLogDir(configDir), RUN_LOG_FILE), 'utf8');
    appendRunLog(configDir, lineFor(4), small);
    const rotated = files().filter((f) => f !== RUN_LOG_FILE);
    expect(rotated).toHaveLength(1);
    expect(readFileSync(join(runLogDir(configDir), rotated[0] as string), 'utf8')).toBe(before);
    expect(readFileSync(join(runLogDir(configDir), RUN_LOG_FILE), 'utf8')).toBe(lineFor(4));
  });

  it('keeps the newest N files (the current one included) and deletes the oldest', () => {
    for (let n = 1; n <= 30; n++) {
      appendRunLog(configDir, lineFor(n), small);
    }
    expect(files()).toHaveLength(3);
    const ids = readRunLog(configDir).entries.map((e) => e.runId);
    expect(ids.at(-1)).toBe('run-30');
    expect(ids.includes('run-1')).toBe(false);
    // What is kept is a contiguous tail, in order.
    const numbers = ids.map((id) => Number(id.slice(4)));
    expect(numbers).toEqual(numbers.map((_, i) => (numbers[0] as number) + i));
  });

  it('defaults to 5 MiB per file and 5 files', () => {
    appendRunLog(configDir, lineFor(1));
    // 5 MiB of data in the current file: the next line starts a new file.
    const current = join(runLogDir(configDir), RUN_LOG_FILE);
    writeFileSync(current, `${'x'.repeat(5 * 1024 * 1024 - 100)}\n`);
    appendRunLog(configDir, lineFor(2));
    expect(readdirSync(runLogDir(configDir))).toHaveLength(2);
  });

  it('is not an error that another process already rotated the file we saw full', () => {
    // The file the rotation wants to move is gone: the line is simply appended to the (new) current file.
    appendRunLog(configDir, lineFor(1), small);
    appendRunLog(configDir, lineFor(2), small);
    expect(appendRunLog(configDir, lineFor(3), { ...small, maxBytes: 1 })).toMatchObject({ written: true });
  });
});

describe('readRunLog', () => {
  it('is empty, not an error, before the first run', () => {
    expect(readRunLog(configDir)).toEqual({ entries: [], damaged: 0, files: 0 });
  });

  it('reads the rotated files then the current one, oldest first, and skips what is not a log file', () => {
    const dir = runLogDir(configDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'runs.1700000000002-77.ndjson'), lineFor(2));
    writeFileSync(join(dir, 'runs.1700000000001-77.ndjson'), lineFor(1));
    writeFileSync(join(dir, RUN_LOG_FILE), lineFor(3));
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    const read = readRunLog(configDir);
    expect(read.entries.map((e) => e.runId)).toEqual(['run-1', 'run-2', 'run-3']);
    expect(read.files).toBe(3);
  });

  it('counts a damaged line (a crash cut it, someone edited it) and still returns the rest', () => {
    const dir = runLogDir(configDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, RUN_LOG_FILE), `${lineFor(1)}garbage\n${lineFor(2)}${lineFor(3).slice(0, 30)}`);
    const read = readRunLog(configDir);
    expect(read.entries.map((e) => e.runId)).toEqual(['run-1', 'run-2']);
    expect(read.damaged).toBe(2);
  });

  it('fails loudly, with the path and a fix, when the log folder cannot be read', () => {
    writeFileSync(join(configDir, RUN_LOG_DIRNAME), 'not a folder');
    expect(() => readRunLog(configDir)).toThrow(new RegExp(`${runLogDir(configDir).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}.*(permissions|remove|move)`));
  });
});

describe('two machine run processes at once', () => {
  it('append whole lines only: nothing lost, nothing mixed', async () => {
    const run = promisify(execFile);
    const child = join(import.meta.dirname, 'runLogChild.fixture.ts');
    const tsx = join(import.meta.dirname, '..', '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
    await Promise.all(['a', 'b'].map((tag) => run(process.execPath, [tsx, child, configDir, tag, '60'], { timeout: 60_000 })));
    const read = readRunLog(configDir);
    expect(read.damaged).toBe(0);
    expect(read.entries).toHaveLength(120);
    expect(new Set(read.entries.map((e) => e.runId)).size).toBe(120);
  });
});
