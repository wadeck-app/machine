import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { GENESIS_HASH, appendAudit, verifyAuditChain, type Json } from '@wadeck-app/machine-core';
import { writeFileAtomic } from './fsutil.js';

/** Call counters of policy entries (decision 44), kept across restarts: a restart must never reset a limit. */
export class FileUsageStore {
  private readonly counts: Record<string, number> = {};

  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    const corrupt = (why: string) => new Error(`${file} is corrupt or invalid (${why}): the call counters cannot be trusted; restore it from a backup or delete it to restart every counter from zero`);
    let raw: { v?: unknown; counts?: unknown };
    try {
      raw = JSON.parse(readFileSync(file, 'utf8')) as typeof raw;
    } catch {
      throw corrupt('not valid JSON');
    }
    if (raw.v !== 1 || typeof raw.counts !== 'object' || raw.counts === null || Array.isArray(raw.counts)) throw corrupt('unexpected shape');
    for (const [key, value] of Object.entries(raw.counts)) {
      if (!Number.isSafeInteger(value) || (value as number) < 0) throw corrupt(`counter ${JSON.stringify(key)} is not a count`);
      this.counts[key] = value as number;
    }
  }

  count(key: string): number {
    return Object.prototype.hasOwnProperty.call(this.counts, key) ? (this.counts[key] as number) : 0;
  }

  record(key: string): void {
    this.counts[key] = this.count(key) + 1;
    writeFileAtomic(this.file, `${JSON.stringify({ v: 1, counts: this.counts }, null, 2)}\n`, 0o600);
  }
}

/** Append-only, hash-chained audit log (T-07). Refuses to open a log that does not verify. */
export class FileAuditLog {
  private prev = GENESIS_HASH;
  private seq = 0;

  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    if (!existsSync(file)) return;
    const text = readFileSync(file, 'utf8');
    const lines = text.length === 0 ? [] : text.replace(/\n$/, '').split('\n');
    const result = verifyAuditChain(lines);
    if (!result.ok) {
      throw new Error(`${file} is broken: ${result.message}. The log was edited or damaged; keep a copy for the investigation, then move it away to start a new log`);
    }
    this.prev = result.lastHash;
    this.seq = result.entries;
  }

  write(entry: Record<string, Json>): void {
    const { line, hash } = appendAudit({ prevHash: this.prev, seq: this.seq, entry });
    appendFileSync(this.file, `${line}\n`, { mode: 0o600 });
    this.prev = hash;
    this.seq += 1;
  }

  /** Hash of the last line: store it elsewhere to detect a log cut off at its end. */
  lastHash(): string {
    return this.prev;
  }
}
