import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { createAuditFollower, createSentFollower, createTailer, FOLLOW_HEAD_BYTES, FOLLOW_POLL_MS, type ActivityEvent, type AuditFollower, type LogObservation, type FollowItem, type SentFollower, type Tailer } from '@wadeck-app/machine-core';
import { activityAnswer } from './activityView.js';
import { activityCells, arrowOf, clock, fit, formatActivityRow, type RowLayout } from './cliActivity.js';
import { EXIT, type CommandContext, type Timing } from './cliTypes.js';
import { NotInitializedError } from './errors.js';
import { readMachine } from './identity.js';
import { realTiming } from './join.js';
import { loadNetwork } from './network.js';
import { auditLogFile } from './requestsView.js';
import { RUN_LOG_FILE, runLogDir } from './runLogStore.js';
import { join } from 'node:path';

// `machine log --follow` (run-log.md): like `tail -f` on this machine's own logs. The audit log (what the daemon did: requests accepted and run,
// refused, held, sessions, documents, notices) and the run log (what `machine run` sent) are polled by size and head every FOLLOW_POLL_MS. Read-only,
// no daemon needed; the output of a command, its environment and every secret are not in these logs, and the rows show only the fields `machine log`
// shows. The tailing and the rows are machine-core's (activityFollow.ts, activity.ts); this file is stat, read, print and Ctrl-C.

/** Wider than the 100 columns of the table: a live stream has no page to fit, and the command is the column that matters. */
const FOLLOW_LINE_WIDTH = 140;
const GAPS = 10;
const LAYOUT: RowLayout = (() => {
  const base = { time: 14, route: 28, shell: 6, result: 30, exit: 9, ran: 8, waited: 6 };
  return { ...base, command: FOLLOW_LINE_WIDTH - (base.time + 2 + base.route + base.shell + base.result + base.exit + base.ran + base.waited + GAPS) };
})();
const CAPS = { route: 29, result: 30 } as const;
/** The last audit line is looked for in at most this many bytes before the start of the follow. */
const SEED_BYTES = 64 * 1024;

const HEADER = formatActivityRow(LAYOUT, { time: 'TIME', arrow: '  ', route: 'FROM -> TO', shell: 'SHELL', command: 'COMMAND', result: 'RESULT', exit: 'EXIT', ran: 'RAN', waited: 'WAITED' });

/** One row of the stream: the cells of `machine log`, at the fixed widths of the follow mode. */
export function followRowText(e: ActivityEvent): string {
  const cells = activityCells(e, CAPS);
  return formatActivityRow(LAYOUT, { time: clock(e.atMs, false, true), arrow: arrowOf(e), ...cells, command: e.command === '' ? '-' : fit(e.command, LAYOUT.command) });
}

const codeOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;

/** What a look at a file saw, or undefined when it does not exist. Reads at most FOLLOW_HEAD_BYTES. */
function observe(path: string): LogObservation | undefined {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (e) {
    if (codeOf(e) === 'ENOENT') {
      return undefined;
    }
    throw e;
  }
  try {
    const st = fstatSync(fd);
    const head = Buffer.alloc(Math.min(st.size, FOLLOW_HEAD_BYTES));
    const n = head.length === 0 ? 0 : readSync(fd, head, 0, head.length, 0);
    return { size: st.size, mtimeMs: st.mtimeMs, head: head.subarray(0, n).toString('hex') };
  } finally {
    closeSync(fd);
  }
}

/** The bytes [from, to) of a file; fewer when it was cut meanwhile (the next look sees it). */
function readRange(path: string, from: number, to: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(to - from);
    let done = 0;
    while (done < buf.length) {
      const n = readSync(fd, buf, done, buf.length - done, from + done);
      if (n === 0) {
        break;
      }
      done += n;
    }
    return buf.subarray(0, done);
  } finally {
    closeSync(fd);
  }
}

/** The chain position of the last complete audit line before `size`, so that the first new line is checked against it. Undefined when there is none. */
function lastAuditLink(path: string, size: number): { seq: number; hash: string } | undefined {
  if (size === 0) {
    return undefined;
  }
  const from = Math.max(0, size - SEED_BYTES);
  const text = readRange(path, from, size).toString('utf8');
  const lines = text.split('\n');
  // Not complete when it does not end with a newline; the part cut at `from` is not a line.
  if (!text.endsWith('\n')) {
    lines.pop();
  }
  if (from > 0) {
    lines.shift();
  }
  const line = lines.filter((l) => l.trim().length > 0).at(-1);
  if (line === undefined) {
    return undefined;
  }
  try {
    const p = JSON.parse(line) as { seq?: unknown; hash?: unknown };
    return typeof p.seq === 'number' && typeof p.hash === 'string' ? { seq: p.seq, hash: p.hash } : undefined;
  } catch {
    return undefined;
  }
}

interface Source {
  label: 'audit log' | 'run log';
  path: string;
  tailer: Tailer;
  follower: AuditFollower | SentFollower;
  /** Size and modification time of the last look that led to a plan: an unchanged file is not opened again. */
  lastStat: { size: number; mtimeMs: number } | undefined;
  /** The read problem already reported, so that a file that stays unreadable is said once. */
  problem: string | undefined;
}

export async function runActivityFollow(ctx: CommandContext): Promise<number> {
  const { args, rest, io, configDir, fail } = ctx;
  const usage = 'usage: machine log --follow [--sent | --received] [--since <30m|2h|3d|date>] [--limit <n>] [--json]';
  if (rest.length > 0) {
    return fail(`unexpected argument "${rest[0] as string}" for \`machine log --follow\`. ${usage}`, EXIT.usage);
  }
  if (args.sent === true && args.received === true) {
    return fail(`--sent and --received contradict each other: remove one of them, or neither to follow both. ${usage}`, EXIT.usage);
  }
  const filter = ([['--machine', args.machine], ['--outcome', args.outcome], ['--text', args.text], ['--offset', args.offset]] as const).find(([, v]) => v !== undefined);
  if (filter !== undefined) {
    return fail(`${filter[0]} does not combine with --follow: the stream shows every new entry (a pager like \`| grep\` filters it). ${usage}`, EXIT.usage);
  }
  if (args.limit !== undefined && args.since === undefined) {
    return fail(`--limit only applies to the history shown first, which --since asks for: add --since <30m|2h|3d|date>, or remove --limit. ${usage}`, EXIT.usage);
  }

  let self;
  try {
    self = readMachine(configDir);
  } catch (e) {
    if (e instanceof NotInitializedError) {
      const { message } = e;
      return fail(message);
    }
    throw e;
  }
  const nowMs = (): number => (io.now?.() ?? new Date()).getTime();
  const wantSent = args.received !== true;
  const wantReceived = args.sent !== true;
  const auditPath = auditLogFile(configDir);
  const runPath = join(runLogDir(configDir), RUN_LOG_FILE);

  // The names of the machines of the network; looked up again (at most every 5 s) when a line names a machine that is not known yet.
  let names = new Map<string, string>();
  let namesAt = Number.NEGATIVE_INFINITY;
  let namesWarned = false;
  const loadNames = (): void => {
    namesAt = nowMs();
    try {
      names = new Map(loadNetwork(configDir, Math.floor(namesAt / 1000)).directory.machines().map((m) => [m.uuid, m.name]));
    } catch (e) {
      if (!namesWarned) {
        namesWarned = true;
        io.stderr(`[warn] the machines of the network cannot be read (${(e as Error).message}): machines are shown by the start of their id. Fix it with \`machine list\`\n`);
      }
    }
  };
  loadNames();
  const nameOf = (uuid: string): string | undefined => {
    const known = names.get(uuid);
    if (known === undefined && nowMs() - namesAt > 5000) {
      loadNames();
      return names.get(uuid);
    }
    return known;
  };

  // What is there NOW is looked at before the history is read: the follow starts exactly where the history ends.
  const startAudit = wantReceived ? safeObserve(auditPath, io.stderr) : undefined;
  const startRun = wantSent ? safeObserve(runPath, io.stderr) : undefined;

  const direction = wantSent && wantReceived ? undefined : wantSent ? 'sent' : 'received';
  const json = args.json;
  const printEvent = (e: ActivityEvent): void => {
    if (json) {
      io.stdout(`${JSON.stringify(e)}\n`);
      return;
    }
    io.stdout(`${followRowText(e)}\n`);
    if (!e.verified) {
      io.stdout('  [UNVERIFIED] the audit log is broken before this entry: it cannot be trusted\n');
    }
  };
  const printItem = (item: FollowItem): void => {
    if (item.kind === 'warn') {
      io.stderr(`[warn] ${item.message}\n`);
    } else {
      printEvent(item.event);
    }
  };

  if (!json) {
    io.stdout(`Following the activity of ${self.name} (${direction === undefined ? 'sent and received' : direction}): new entries appear as they happen, Ctrl+C stops\n`);
    io.stdout(`${HEADER}\n`);
  }
  if (args.since !== undefined) {
    const answer = activityAnswer(configDir, { ...(direction !== undefined ? { direction } : {}), since: args.since, ...(args.limit !== undefined ? { limit: args.limit } : {}) }, Math.floor(nowMs() / 1000));
    if (!answer.initialized) {
      return fail(answer.message);
    }
    if (!answer.ok) {
      return fail(answer.reason === 'bad-query' ? `${answer.message}. ${usage}` : answer.message, answer.reason === 'bad-query' ? EXIT.usage : EXIT.failure);
    }
    // Oldest first: the history flows into the stream.
    for (const e of [...answer.page.items].reverse()) {
      printEvent(e);
    }
    if (answer.page.hasMore) {
      io.stderr(`[info] ${answer.page.total - answer.page.items.length} older entries match --since ${args.since} and are not shown: \`machine log --since ${args.since}\` pages through them, or raise --limit (up to 500)\n`);
    }
  }

  const sources: Source[] = [];
  if (wantReceived) {
    const last = startAudit === undefined ? undefined : safeLastLink(auditPath, startAudit.size, io.stderr);
    sources.push({
      label: 'audit log',
      path: auditPath,
      tailer: createTailer(startAudit ?? null),
      follower: createAuditFollower({ self: { uuid: self.uuid, name: self.name }, nameOf, file: auditPath, nowMs, ...(last !== undefined ? { last } : {}) }),
      lastStat: startAudit === undefined ? undefined : { size: startAudit.size, mtimeMs: startAudit.mtimeMs },
      problem: undefined,
    });
  }
  if (wantSent) {
    sources.push({ label: 'run log', path: runPath, tailer: createTailer(startRun ?? null), follower: createSentFollower({ file: runPath }), lastStat: startRun === undefined ? undefined : { size: startRun.size, mtimeMs: startRun.mtimeMs }, problem: undefined });
  }
  for (const s of sources) {
    if (s.lastStat === undefined) {
      io.stderr(`[info] the ${s.label} ${s.path} does not exist yet: it is followed as soon as it appears\n`);
    }
  }

  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  const timing: Timing = io.timing ?? { ...realTiming(), signal: controller.signal };
  const stopped = (): boolean => timing.signal?.aborted === true;
  if (io.timing === undefined) {
    process.once('SIGINT', onSigint);
  }
  try {
    for (;;) {
      for (const s of sources) {
        pollSource(s, io.stderr, printItem);
      }
      if (stopped()) {
        break;
      }
      await timing.sleep(FOLLOW_POLL_MS, timing.signal);
      if (stopped()) {
        break;
      }
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
  return EXIT.ok;
}

function safeObserve(path: string, stderr: (t: string) => void): LogObservation | undefined {
  try {
    return observe(path);
  } catch (e) {
    stderr(`[warn] cannot read ${path}: ${(e as Error).message}. The follow starts from its current end once it is readable; fix its permissions\n`);
    return undefined;
  }
}

function safeLastLink(path: string, size: number, stderr: (t: string) => void): { seq: number; hash: string } | undefined {
  try {
    return lastAuditLink(path, size);
  } catch (e) {
    stderr(`[warn] cannot read the end of ${path} (${(e as Error).message}): the first new entry is not checked against the one before it\n`);
    return undefined;
  }
}

/** One look at one file: what is new is printed. A file that cannot be read is said once, and looked at again at the next poll. */
function pollSource(s: Source, stderr: (t: string) => void, print: (item: FollowItem) => void): void {
  try {
    for (;;) {
      let st;
      try {
        st = statSync(s.path);
      } catch (e) {
        if (codeOf(e) !== 'ENOENT') {
          throw e;
        }
        st = undefined;
      }
      if (st !== undefined && s.lastStat !== undefined && s.lastStat.size === st.size && s.lastStat.mtimeMs === st.mtimeMs) {
        break;
      }
      if (st === undefined && s.lastStat === undefined) {
        break;
      }
      const seen = st === undefined ? undefined : observe(s.path);
      const plan = s.tailer.plan(seen);
      s.lastStat = seen === undefined ? undefined : { size: seen.size, mtimeMs: seen.mtimeMs };
      if (plan.restart !== undefined) {
        stderr(`[info] the ${s.label} ${plan.restart === 'truncated' ? 'was cut' : plan.restart === 'replaced' ? 'was replaced (rotation)' : 'disappeared'}: ${plan.restart === 'disappeared' ? 'it is followed again when it comes back' : 'following it from its start'}\n`);
        if ('restart' in s.follower) {
          s.follower.restart();
        }
      }
      if (plan.read === undefined) {
        break;
      }
      const bytes = readRange(s.path, plan.read.from, plan.read.to);
      for (const line of s.tailer.push(bytes)) {
        for (const item of s.follower.feed(line)) {
          print(item);
        }
      }
      if (bytes.length < plan.read.to - plan.read.from) {
        // Cut while it was read: look again at the next poll.
        s.lastStat = undefined;
        break;
      }
      if (seen !== undefined && plan.read.to >= seen.size) {
        break;
      }
      // More to read than one chunk: go on at once.
      s.lastStat = undefined;
    }
    if (s.problem !== undefined) {
      s.problem = undefined;
      stderr(`[info] the ${s.label} is readable again\n`);
    }
  } catch (e) {
    const message = (e as Error).message;
    if (s.problem !== message) {
      s.problem = message;
      stderr(`[warn] cannot read the ${s.label} ${s.path}: ${message}. Fix its permissions; it is looked at again every ${FOLLOW_POLL_MS} ms\n`);
    }
    s.lastStat = undefined;
  }
}
