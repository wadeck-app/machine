import { auditLineHashOk } from './audit.js';
import { atMsOf, clean, parseAuditLine, receivedRowEvent, sentEvent, str, type ActivityEvent } from './activity.js';
import { parseRunLogLine } from './runLog.js';

// The pure part of `machine log --follow` (run-log.md): what to read next from a log that is polled, and what each new line shows. No I/O: the
// reader of the files (stat, read, sleep, Ctrl-C) is machine-cli's. The rows are the ones of `machine log` (activity.ts builds them); an audit entry
// with no row of its own (a hold, a session, a document, a notice...) is one row named by its event, with at most one word of detail.

/** How often a followed file is looked at. */
export const FOLLOW_POLL_MS = 500;
/** A line longer than this many bytes is not kept in memory; it is given as FOLLOW_OVERSIZED and is a damaged line for every follower. */
export const FOLLOW_MAX_LINE = 1024 * 1024;
export const FOLLOW_OVERSIZED = '\u0000oversized-line';
/** Bytes of the start of a file that tell it from another file (the first line of an audit log carries a hash, a run log line a time and an id). */
export const FOLLOW_HEAD_BYTES = 64;
/** Most bytes one plan asks to read: a big append is read in several rounds, never in one allocation. */
export const FOLLOW_READ_CHUNK = 256 * 1024;
const MAX_PENDING = 1000;

// ----------------------------------------------------------------------------------------------------------------------------- tailer

/** What a look at a file saw. `head` is the hex of its first bytes (at most FOLLOW_HEAD_BYTES). */
export interface LogObservation {
  size: number;
  mtimeMs: number;
  head: string;
}

export type TailRestart = 'truncated' | 'replaced' | 'disappeared';

export interface TailPlan {
  /** The file is not the one that was followed (cut, replaced by a rotation) or is gone: said to the person, then read from its start. */
  restart?: TailRestart;
  /** The bytes to read now, `to` excluded. */
  read?: { from: number; to: number };
}

export interface Tailer {
  /** What to read for what was seen; `undefined` is a file that does not exist. */
  plan: (seen: LogObservation | undefined) => TailPlan;
  /** The bytes read from `plan.read.from`: the complete lines they finish (a last line with no newline waits for it). */
  push: (bytes: Uint8Array) => string[];
}

/**
 * Follows one file by size and head, like `tail -F`.
 * - `initial` undefined: the first look is the starting point (what is there is not read; a file that does not exist yet is read from its start);
 * - `initial` an observation: what was seen before the history was shown;
 * - `initial` null: the file did not exist at the start.
 * A file smaller than what was read was cut; a file whose head is not the head it had was replaced (rotation); both restart at the first byte.
 */
export function createTailer(initial?: LogObservation | null): Tailer {
  let baselined = initial !== undefined;
  let present = initial !== undefined && initial !== null;
  let offset = initial === undefined || initial === null ? 0 : initial.size;
  let head = initial === undefined || initial === null ? '' : initial.head;
  let carry: Uint8Array = new Uint8Array(0);
  let skipping = false;
  const decoder = new TextDecoder();

  const reset = (): void => {
    offset = 0;
    carry = new Uint8Array(0);
    skipping = false;
  };
  const readFrom = (from: number, size: number): { from: number; to: number } | undefined => (size > from ? { from, to: Math.min(size, from + FOLLOW_READ_CHUNK) } : undefined);

  return {
    plan(seen) {
      if (seen === undefined) {
        const was = present;
        present = false;
        baselined = true;
        if (!was) {
          return {};
        }
        reset();
        head = '';
        return { restart: 'disappeared' };
      }
      if (!baselined) {
        baselined = true;
        present = true;
        offset = seen.size;
        head = seen.head;
        return {};
      }
      if (!present) {
        // The file appeared (or came back after `disappeared`, already said): everything in it is new.
        present = true;
        reset();
        head = seen.head;
        const read = readFrom(0, seen.size);
        return read === undefined ? {} : { read };
      }
      if (seen.size < offset) {
        reset();
        head = seen.head;
        const read = readFrom(0, seen.size);
        return { restart: 'truncated', ...(read !== undefined ? { read } : {}) };
      }
      if (!seen.head.startsWith(head)) {
        reset();
        head = seen.head;
        const read = readFrom(0, seen.size);
        return { restart: 'replaced', ...(read !== undefined ? { read } : {}) };
      }
      head = seen.head;
      const read = readFrom(offset, seen.size);
      return read === undefined ? {} : { read };
    },

    push(bytes) {
      offset += bytes.length;
      const lines: string[] = [];
      const join = (a: Uint8Array, b: Uint8Array): Uint8Array => {
        if (a.length === 0) {
          return b;
        }
        const out = new Uint8Array(a.length + b.length);
        out.set(a, 0);
        out.set(b, a.length);
        return out;
      };
      let start = 0;
      for (;;) {
        const idx = bytes.indexOf(0x0a, start);
        if (idx === -1) {
          break;
        }
        const piece = bytes.subarray(start, idx);
        if (skipping || carry.length + piece.length > FOLLOW_MAX_LINE) {
          lines.push(FOLLOW_OVERSIZED);
        } else {
          const text = decoder.decode(join(carry, piece)).replace(/\r$/, '');
          if (text.length > 0) {
            lines.push(text);
          }
        }
        skipping = false;
        carry = new Uint8Array(0);
        start = idx + 1;
      }
      const rest = bytes.subarray(start);
      if (!skipping) {
        if (carry.length + rest.length > FOLLOW_MAX_LINE) {
          skipping = true;
          carry = new Uint8Array(0);
        } else if (rest.length > 0) {
          carry = join(carry, rest);
        }
      }
      return lines;
    },
  };
}

// ------------------------------------------------------------------------------------------------------------------------- followers

export type FollowItem = { kind: 'event'; event: ActivityEvent } | { kind: 'warn'; message: string };

const warn = (message: string): FollowItem => ({ kind: 'warn', message });

export interface SentFollower {
  feed: (line: string) => FollowItem[];
}

/** The lines of the outgoing run log: a sent run is one row (the same as `machine log`); a damaged line is a warning. */
export function createSentFollower(options: { file: string }): SentFollower {
  return {
    feed(line) {
      const entry = line === FOLLOW_OVERSIZED ? 'damaged' : parseRunLogLine(line);
      if (entry === 'damaged') {
        return [warn(`a damaged line of the run log was skipped (a crash cut it, or the file was edited): see ${options.file}; the next lines are shown`)];
      }
      return [{ kind: 'event', event: sentEvent(entry) }];
    },
  };
}

export interface AuditFollowerOptions {
  self: { uuid: string; name: string };
  nameOf: (uuid: string) => string | undefined;
  /** The audit log file, named in the warnings. */
  file: string;
  /** The time of an entry that has none. */
  nowMs: () => number;
  /** The last line known before the first one read (history shown first): the first line read is checked against it. */
  last?: { seq: number; hash: string };
}

export interface AuditFollower {
  feed: (line: string) => FollowItem[];
  /** The log was cut or replaced: the next line starts a new chain, it is not a break. */
  restart: () => void;
}

/** The words that qualify an event with no row of its own, in order of preference; never a message, an environment or an output. */
const DETAIL_FIELDS = ['reason', 'outcome', 'state', 'cause', 'error', 'kind'] as const;

/**
 * The lines of the audit log of THIS machine, as they are appended. `accepted` is shown at once as `running`; the `completed` / `failed` line of the
 * same request is shown as the finished row (exit code, run time) of `machine log`. The chain is checked on the lines read: the first break is a
 * warning (once), the entries from there on are unverified; the whole log is the daemon's check at start.
 */
export function createAuditFollower(options: AuditFollowerOptions): AuditFollower {
  const pending = new Map<string, { entry: Record<string, unknown>; atMs: number }>();
  let last: { seq: number; hash: string } | undefined = options.last;
  let broken = false;

  const checkChain = (parsed: { seq: number; prev: string; hash: string; entry: Record<string, unknown> }): string | undefined => {
    if (!auditLineHashOk(parsed.seq, parsed.prev, parsed.entry, parsed.hash)) {
      return `audit log line ${parsed.seq + 1} was modified: its content does not match its hash`;
    }
    if (last !== undefined && (parsed.seq !== last.seq + 1 || parsed.prev !== last.hash)) {
      return `audit log line ${parsed.seq + 1} does not follow the previous line (an entry was deleted, reordered, inserted or damaged)`;
    }
    return undefined;
  };

  return {
    restart() {
      last = undefined;
      broken = false;
      pending.clear();
    },

    feed(line) {
      const parsed = line === FOLLOW_OVERSIZED ? undefined : parseAuditLine(line);
      if (parsed === undefined) {
        return [warn(`a damaged line of the audit log was skipped (a crash cut it, or the file was edited): see ${options.file}; the next lines are shown. Keep a copy of the file for the investigation`)];
      }
      const items: FollowItem[] = [];
      if (!broken) {
        const problem = checkChain(parsed);
        if (problem !== undefined) {
          broken = true;
          items.push(warn(`the audit log is broken at line ${parsed.seq + 1}: ${problem}. Checked on the lines read since the follow started (the daemon checks the whole log at start); the entries from here on are shown as [UNVERIFIED]. Keep a copy of ${options.file} for the investigation, then move it away to start a new log (the daemon refuses to start on a broken log)`));
        }
      }
      last = { seq: parsed.seq, hash: parsed.hash };
      const { entry } = parsed;
      const kind = str(entry['event']);
      const id = str(entry['id']);
      const atMsEntry = atMsOf(entry);
      const atMs = Number.isNaN(atMsEntry) ? options.nowMs() : atMsEntry;
      let event: ActivityEvent;
      if (kind === 'accepted' || kind === 'refused') {
        event = receivedRowEvent(entry, kind, atMs, undefined, options.self, options.nameOf);
        if (kind === 'accepted') {
          event = { ...event, outcome: 'running' };
          if (id !== undefined) {
            if (pending.size >= MAX_PENDING) {
              pending.delete(pending.keys().next().value as string);
            }
            pending.set(id, { entry, atMs });
          }
        }
      } else if ((kind === 'completed' || kind === 'failed') && id !== undefined) {
        const accepted = pending.get(id);
        pending.delete(id);
        event = receivedRowEvent(accepted?.entry ?? {}, 'accepted', atMs, entry, options.self, options.nameOf);
      } else {
        const peer = str(entry['source']);
        const peerName = peer === undefined ? undefined : options.nameOf(peer);
        const detail = DETAIL_FIELDS.map((field) => str(entry[field], 64)).find((v) => v !== undefined && v.length > 0);
        event = {
          ts: new Date(atMs).toISOString(),
          atMs,
          direction: 'received',
          from: { ...(peer !== undefined ? { uuid: peer } : {}), ...(peerName !== undefined ? { name: clean(peerName, 100) as string } : {}) },
          to: { uuid: options.self.uuid, name: clean(options.self.name, 100) as string },
          shell: str(entry['shell'], 16) ?? '',
          command: str(entry['command']) ?? '',
          outcome: kind ?? 'unknown-event',
          ...(id !== undefined ? { id } : {}),
          ...(detail !== undefined ? { detail } : {}),
          verified: true,
        };
      }
      items.push({ kind: 'event', event: broken ? { ...event, verified: false } : event });
      return items;
    },
  };
}
