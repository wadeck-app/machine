import { createHash } from 'node:crypto';
import { canonicalize, type Json } from './canonical.js';

// Hash-chained audit log (T-07): every line commits to the previous one, so an edited, deleted or reordered line is
// detected. A chain cannot reveal that the TAIL was cut off: `lastHash` is returned so it can be anchored elsewhere.

export const GENESIS_HASH = '0'.repeat(64);
const AUDIT_DOMAIN = 'machine/audit/v1';

function hashOf(prevHash: string, seq: number, entry: Json): string {
  return createHash('sha256').update(`${AUDIT_DOMAIN}\u0000${prevHash}\u0000${seq}\u0000${canonicalize(entry)}`).digest('hex');
}

export function appendAudit(input: { prevHash: string; seq: number; entry: Json }): { line: string; hash: string } {
  const hash = hashOf(input.prevHash, input.seq, input.entry);
  return { line: JSON.stringify({ seq: input.seq, prev: input.prevHash, entry: input.entry, hash }), hash };
}

export type AuditVerification = { ok: true; entries: number; lastHash: string } | { ok: false; line: number; message: string };

export function verifyAuditChain(lines: readonly string[]): AuditVerification {
  let prev = GENESIS_HASH;
  for (let i = 0; i < lines.length; i++) {
    const line = i + 1;
    let parsed: { seq?: unknown; prev?: unknown; entry?: unknown; hash?: unknown };
    try {
      parsed = JSON.parse(lines[i] as string) as typeof parsed;
    } catch {
      return { ok: false, line, message: `audit log line ${line} is not valid JSON: the log was edited or damaged` };
    }
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.seq !== 'number' || typeof parsed.prev !== 'string' || typeof parsed.hash !== 'string' || parsed.entry === undefined) {
      return { ok: false, line, message: `audit log line ${line} has an unexpected shape: the log was edited or damaged` };
    }
    if (parsed.seq !== i || parsed.prev !== prev) {
      return { ok: false, line, message: `audit log line ${line} does not follow the previous line (an entry was deleted, reordered or inserted)` };
    }
    let expected: string;
    try {
      expected = hashOf(prev, i, parsed.entry as Json);
    } catch {
      return { ok: false, line, message: `audit log line ${line} holds an entry that cannot be checked: the log was edited` };
    }
    if (parsed.hash !== expected) return { ok: false, line, message: `audit log line ${line} was modified: its content does not match its hash` };
    prev = parsed.hash;
  }
  return { ok: true, entries: lines.length, lastHash: prev };
}
