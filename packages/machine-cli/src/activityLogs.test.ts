import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAudit, buildActivity, GENESIS_HASH, type Json, type RunLogEntry } from '@wadeck-app/machine-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countLogFile, createCountCache, openActivityLogs, OVERSIZED_LINE, reverseLines } from './activityLogs.js';
import { RUN_LOG_FILE, runLogDir } from './runLogStore.js';

// The files behind the Activity page: read from the END in chunks (a page never loads a 5 MiB file), rows counted once per file in a cache keyed by
// size and modification time, an appended file counted from where the cache stopped, a rewritten file recounted loudly.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'machine-activity-logs-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const noBytes = (): void => undefined;
const SELF = { name: 'laptop', uuid: '11111111-1111-4111-8111-111111111111' };
const DESK = { name: 'desk', uuid: '22222222-2222-4222-8222-222222222222' };
const T0 = Date.UTC(2026, 10, 21, 12, 0, 0);

function runLine(n: number, over: Partial<RunLogEntry> = {}): string {
  const entry: RunLogEntry = { v: 1, ts: new Date(T0 + n * 1000).toISOString(), runId: `run-${n}`, from: SELF, to: DESK, shell: 'sh', command: `echo ${n}`, truncated: false, waitMode: 'default', onRefusal: 'wait', waitSeconds: 600, waitedSeconds: 0, outcome: 'ran', exitCode: n % 7 === 0 ? 1 : 0, durationMs: 120, execMs: 80, ...over };
  return `${JSON.stringify(entry)}\n`;
}

describe('reverseLines', () => {
  const read = (path: string, chunkBytes: number, maxLineBytes?: number): string[] => [...reverseLines(path, noBytes, { chunkBytes, ...(maxLineBytes !== undefined ? { maxLineBytes } : {}) })];

  it('gives the lines last to first, whatever the chunk size, with a multi-byte character cut by a chunk boundary', () => {
    const file = join(dir, 'a.ndjson');
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i} café € ${'x'.repeat(i % 9)}`);
    writeFileSync(file, `${lines.join('\n')}\n`);
    for (const chunk of [1, 3, 7, 16, 64, 4096]) {
      expect(read(file, chunk)).toEqual([...lines].reverse());
    }
  });

  it('gives a last line that has no newline (a crash cut it), and nothing for an empty file', () => {
    const file = join(dir, 'b.ndjson');
    writeFileSync(file, 'one\ntwo\nthr');
    expect(read(file, 4)).toEqual(['thr', 'two', 'one']);
    writeFileSync(file, '');
    expect(read(file, 4)).toEqual([]);
  });

  it('turns a line longer than the bound into one marker line (counted as damaged by the parsers) and keeps its neighbours', () => {
    const file = join(dir, 'c.ndjson');
    writeFileSync(file, `before\n${'y'.repeat(500)}\nafter\n`);
    expect(read(file, 16, 100)).toEqual(['after', OVERSIZED_LINE, 'before']);
    writeFileSync(file, `${'y'.repeat(500)}\nafter\n`);
    expect(read(file, 16, 100)).toEqual(['after', OVERSIZED_LINE]);
  });

  it('reads only the chunks it is asked for: stopping after one line reads one chunk', () => {
    const file = join(dir, 'd.ndjson');
    writeFileSync(file, Array.from({ length: 1000 }, (_, i) => `line ${i}\n`).join(''));
    let bytes = 0;
    const it = reverseLines(file, (n) => { bytes += n; }, { chunkBytes: 256 });
    expect(it.next().value).toBe('line 999');
    it.return(undefined);
    expect(bytes).toBe(256);
  });
});

describe('countLogFile', () => {
  const sentFile = (): string => join(dir, 'runs.ndjson');

  it('counts valid rows and damaged lines of a run log, and an audit log counts only accepted and refused as rows', () => {
    writeFileSync(sentFile(), `${runLine(1)}${runLine(2)}{"v":1,"ts":\n${runLine(3)}`);
    expect(countLogFile(createCountCache(), sentFile(), 'sent', noBytes, [])).toEqual({ rows: 3, damaged: 1 });
    const audit: string[] = [];
    let prev = GENESIS_HASH;
    ([{ ts: new Date(T0).toISOString(), event: 'accepted', source: DESK.uuid, id: 'a' }, { ts: new Date(T0).toISOString(), event: 'completed', id: 'a' }, { ts: new Date(T0).toISOString(), event: 'refused', source: DESK.uuid, id: 'r', reason: 'denied' }, { ts: new Date(T0).toISOString(), event: 'held', id: 'h' }] as Array<Record<string, Json>>).forEach((entry, seq) => {
      const r = appendAudit({ prevHash: prev, seq, entry });
      audit.push(r.line);
      prev = r.hash;
    });
    const auditFile = join(dir, 'audit.log');
    writeFileSync(auditFile, `${audit.join('\n')}\nnot json\n`);
    expect(countLogFile(createCountCache(), auditFile, 'audit', noBytes, [])).toEqual({ rows: 2, damaged: 1 });
  });

  it('serves a file that did not change from the cache: no byte is read', () => {
    writeFileSync(sentFile(), runLine(1) + runLine(2));
    const cache = createCountCache();
    let bytes = 0;
    const count = () => countLogFile(cache, sentFile(), 'sent', (n) => { bytes += n; }, []);
    expect(count()).toEqual({ rows: 2, damaged: 0 });
    const first = bytes;
    expect(first).toBeGreaterThan(0);
    expect(count()).toEqual({ rows: 2, damaged: 0 });
    expect(bytes).toBe(first);
  });

  it('counts an appended file from where the cache stopped, silently (an append is the normal change)', () => {
    writeFileSync(sentFile(), Array.from({ length: 200 }, (_, i) => runLine(i)).join(''));
    const cache = createCountCache();
    const notes: string[] = [];
    let bytes = 0;
    const count = () => countLogFile(cache, sentFile(), 'sent', (n) => { bytes += n; }, notes);
    count();
    const full = bytes;
    bytes = 0;
    const added = runLine(500) + runLine(501);
    appendFileSync(sentFile(), added);
    expect(count()).toEqual({ rows: 202, damaged: 0 });
    expect(bytes).toBeLessThan(full / 10);
    expect(bytes).toBeLessThanOrEqual(Buffer.byteLength(added) + 256);
    expect(notes).toEqual([]);
  });

  it('counts a line that was not finished when the cache last looked once it is finished, never twice', () => {
    const half = runLine(2);
    writeFileSync(sentFile(), runLine(1) + half.slice(0, 30));
    const cache = createCountCache();
    expect(countLogFile(cache, sentFile(), 'sent', noBytes, [])).toEqual({ rows: 1, damaged: 1 });
    appendFileSync(sentFile(), half.slice(30));
    expect(countLogFile(cache, sentFile(), 'sent', noBytes, [])).toEqual({ rows: 2, damaged: 0 });
  });

  it('recounts loudly a file that was rewritten or shortened: never a stale count', () => {
    writeFileSync(sentFile(), Array.from({ length: 50 }, (_, i) => runLine(i)).join(''));
    const cache = createCountCache();
    const notes: string[] = [];
    expect(countLogFile(cache, sentFile(), 'sent', noBytes, notes).rows).toBe(50);
    // Same size, other content, other time.
    const same = Array.from({ length: 50 }, (_, i) => runLine(i)).join('').replace(/echo/g, 'ECHO');
    writeFileSync(sentFile(), same);
    const later = new Date(Date.now() + 5000);
    utimesSync(sentFile(), later, later);
    expect(countLogFile(cache, sentFile(), 'sent', noBytes, notes).rows).toBe(50);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/runs\.ndjson.*changed.*recounted/);
    writeFileSync(sentFile(), runLine(1));
    expect(countLogFile(cache, sentFile(), 'sent', noBytes, notes).rows).toBe(1);
    expect(notes).toHaveLength(2);
  });

  it('says what is wrong, and how to fix it, when a file cannot be read', () => {
    // A path the system refuses (a NUL character) fails the same way a file without permission does.
    expect(() => countLogFile(createCountCache(), join(dir, 'bad\u0000name.ndjson'), 'sent', noBytes, [])).toThrow(/cannot read the log .*Fix its permissions/);
  });
});

describe('openActivityLogs: a page of a big log reads a bounded number of bytes', () => {
  /** 50,000 run log lines in 4 rotated files and the current one, and 2,000 audit lines. */
  function bigLogs(): string {
    const configDir = join(dir, 'cfg');
    const logDir = runLogDir(configDir);
    mkdirSync(logDir, { recursive: true });
    const per = 10_000;
    for (let f = 0; f < 5; f++) {
      const name = f === 4 ? RUN_LOG_FILE : `runs.${String(1_000_000_000_000 + f).padStart(13, '0')}-1.ndjson`;
      let text = '';
      for (let i = 0; i < per; i++) {
        const n = f * per + i;
        text += runLine(n, n % 11 === 0 ? { outcome: 'refused', reason: 'not-listed' } : {});
      }
      writeFileSync(join(logDir, name), text);
    }
    const audit: string[] = [];
    let prev = GENESIS_HASH;
    for (let i = 0; i < 1000; i++) {
      for (const entry of [{ ts: new Date(T0 + i * 25_000).toISOString(), event: 'accepted', source: DESK.uuid, id: `a${i}`, shell: 'sh', command: `whoami ${i}` }, { ts: new Date(T0 + i * 25_000 + 1000).toISOString(), event: 'completed', id: `a${i}`, exitCode: 0, timedOut: false, truncated: false, durationMs: 40 }] as Array<Record<string, Json>>) {
        const r = appendAudit({ prevHash: prev, seq: audit.length, entry });
        audit.push(r.line);
        prev = r.hash;
      }
    }
    writeFileSync(join(configDir, 'audit.log'), `${audit.join('\n')}\n`);
    return configDir;
  }

  const view = (configDir: string, cache: ReturnType<typeof createCountCache>, filter: Parameters<typeof buildActivity>[0]['filter']) => {
    const logs = openActivityLogs(configDir, cache, join(configDir, 'audit.log'));
    const page = buildActivity({ self: SELF, sources: logs.sources, nameOf: () => undefined, filter });
    return { page, logs };
  };

  it('page 1 of 50,000 sent and 1,000 received reads a few chunks; the totals come from the cache', () => {
    const configDir = bigLogs();
    const cache = createCountCache();
    const cold = view(configDir, cache, { limit: 25 });
    expect(cold.page).toMatchObject({ total: 51_000, totalExact: true, page: 1, pageCount: 2040, counts: { sent: 50_000, received: 1000 } });
    expect(cold.page.items).toHaveLength(25);
    // Newest first: the page is the newest 25 of both logs.
    expect(cold.page.items[0]?.atMs).toBeGreaterThanOrEqual(cold.page.items[24]?.atMs as number);
    expect(cold.logs.bytes.page).toBeLessThanOrEqual(256 * 1024);
    expect(cold.logs.bytes.count).toBe(0);
    const coldCacheBytes = cold.logs.bytes.cache;
    expect(coldCacheBytes).toBeGreaterThan(10 * 1024 * 1024);

    const warm = view(configDir, cache, { limit: 25, offset: 25 });
    expect(warm.logs.bytes.cache).toBe(0);
    expect(warm.logs.bytes.page).toBeLessThanOrEqual(256 * 1024);
    expect(warm.page.page).toBe(2);
  });

  it('a filter on the content counts in one pass but still reads the page lazily', () => {
    const configDir = bigLogs();
    const { page, logs } = view(configDir, createCountCache(), { limit: 25, outcome: 'refused' });
    expect(page.total).toBe(Math.ceil(50_000 / 11));
    expect(page.totalExact).toBe(true);
    expect(logs.bytes.page).toBeLessThanOrEqual(512 * 1024);
    expect(logs.bytes.count).toBeGreaterThan(10 * 1024 * 1024);
  });

  it('the last page is reachable and exact', () => {
    const configDir = bigLogs();
    const { page } = view(configDir, createCountCache(), { limit: 25, offset: 51_000 - (51_000 % 25 === 0 ? 25 : 51_000 % 25) });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.hasMore).toBe(false);
  });

  it('is a log with no file yet: empty, not an error', () => {
    const configDir = join(dir, 'empty');
    mkdirSync(configDir);
    const { page, logs } = view(configDir, createCountCache(), {});
    expect(page).toMatchObject({ total: 0, items: [] });
    expect(logs.runLogFiles).toBe(0);
    expect(statSync(configDir).isDirectory()).toBe(true);
  });
});
