import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileAuditLog, FileUsageStore } from './stores.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'machine-stores-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('FileUsageStore', () => {
  it('counts per key and survives a restart', () => {
    const file = join(dir, 'usage.json');
    const a = new FileUsageStore(file);
    expect(a.count('k')).toBe(0);
    a.record('k');
    a.record('k');
    const b = new FileUsageStore(file);
    expect(b.count('k')).toBe(2);
    expect(b.count('other')).toBe(0);
  });

  it('names the file when it is corrupt instead of resetting every counter', () => {
    const file = join(dir, 'usage.json');
    writeFileSync(file, '{broken');
    expect(() => new FileUsageStore(file)).toThrow(/usage\.json.*(corrupt|invalid)/);
  });
});

describe('FileAuditLog', () => {
  it('appends hash-chained lines and continues the chain after a restart', () => {
    const file = join(dir, 'audit.log');
    const a = new FileAuditLog(file);
    a.write({ event: 'one' });
    a.write({ event: 'two' });
    const b = new FileAuditLog(file);
    b.write({ event: 'three' });
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(() => new FileAuditLog(file)).not.toThrow();
  });

  it('refuses to open a log that was edited, naming the line', () => {
    const file = join(dir, 'audit.log');
    const a = new FileAuditLog(file);
    a.write({ event: 'one', command: 'echo 1' });
    a.write({ event: 'two' });
    writeFileSync(file, readFileSync(file, 'utf8').replace('echo 1', 'echo EVIL'));
    expect(() => new FileAuditLog(file)).toThrow(/audit\.log.*line 1/);
  });

  it('refuses to open a log with a line appended outside the chain', () => {
    const file = join(dir, 'audit.log');
    new FileAuditLog(file).write({ event: 'one' });
    appendFileSync(file, '{"seq":1,"prev":"x","entry":{},"hash":"y"}\n');
    expect(() => new FileAuditLog(file)).toThrow(/line 2/);
  });

  it('exposes the last hash so it can be anchored elsewhere', () => {
    const log = new FileAuditLog(join(dir, 'audit.log'));
    const before = log.lastHash();
    log.write({ event: 'one' });
    expect(log.lastHash()).not.toBe(before);
  });
});
