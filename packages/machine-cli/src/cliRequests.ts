import { DEFAULT_HISTORY_LIMIT, DEFAULT_PENDING_LIMIT, HISTORY_KINDS, MAX_LIMIT, allowCommand, describeHistory, shellQuote, type HistoryEntry, type HistoryKind, type PolicyMode, type RequestsSummary } from '@wadeck-app/machine-core';
import { clockText, relativeText } from './humanTime.js';
import { EXIT, type CommandContext } from './cliTypes.js';
import { requestsAnswer, type RequestsQuery } from './requestsView.js';

// `machine requests`: what the peers asked THIS machine to run and what became of it, read from its own audit log (read-only,
// no daemon, nothing sent). The pending list is the requests refused because the command is not allowed (decision 73).

export { shellQuote };

const SINCE_FORMS = 'a duration (30m, 2h, 3d) or a local date (2026-11-20 or "2026-11-20 21:30")';

/** `--since`: a duration back from now, or a local date and time. Epoch seconds. */
export function parseSince(text: string, nowSeconds: number): number {
  const duration = /^(\d{1,6})([mhd])$/.exec(text);
  if (duration !== null) {
    const n = Number(duration[1]);
    if (n === 0) throw new Error(`--since ${text}: the duration must be at least 1 (${SINCE_FORMS})`);
    return nowSeconds - n * ({ m: 60, h: 3600, d: 86_400 }[duration[2] as 'm' | 'h' | 'd']);
  }
  const date = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(text);
  if (date !== null) {
    const [, y, mo, d, h = '0', mi = '0'] = date;
    const parsed = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), 0);
    if (!Number.isNaN(parsed.getTime()) && parsed.getMonth() === Number(mo) - 1) return Math.floor(parsed.getTime() / 1000);
  }
  throw new Error(`--since ${JSON.stringify(text)} is not understood: use ${SINCE_FORMS}`);
}

const who = (g: { peer?: string; peerName?: string }): string => g.peerName ?? (g.peer === undefined ? '-' : g.peer.slice(0, 8));

const ago = (at: number, now: number): string => `${clockText(at, now)} (${relativeText(at, now)})`;

export interface PendingText {
  machine: { name: string; policyMode: PolicyMode };
  /** Admin mode only: the admin key is on the machine that prints this (otherwise the command runs on the admin machine). */
  adminKeyHere: boolean;
  summary: Pick<RequestsSummary, 'pending' | 'pendingTotal' | 'allowedNow'>;
  logPresent: boolean;
  now: number;
  /** `this machine` for the local view; shown in the header. */
  where: string;
}

export function pendingText(v: PendingText): string[] {
  const { pending, pendingTotal, allowedNow } = v.summary;
  const lines: string[] = [];
  if (pending.length === 0) {
    lines.push(`no request waiting for approval on ${v.machine.name}${v.logPresent ? '' : ' (no audit log yet: no request ever reached it)'}`);
  } else {
    lines.push(`requests waiting for approval on ${v.machine.name} (${pendingTotal} command${pendingTotal === 1 ? '' : 's'} refused because not allowed, newest first):`);
    for (const g of pending) {
      lines.push(`  ${who(g)} -> ${g.shell} "${g.command}"  ${g.count} time${g.count === 1 ? '' : 's'}, first ${ago(g.firstSeen, v.now)}, last ${ago(g.lastSeen, v.now)}`);
      lines.push(`      ${allowCommand(g, v.machine)}`);
    }
    if (pendingTotal > pending.length) lines.push(`[info] showing ${pending.length} of ${pendingTotal} (the newest): \`--limit <n>\` shows more`);
    if (v.machine.policyMode === 'admin') {
      lines.push(`allowing adds the command to the default list: every peer may then run it. ${v.adminKeyHere ? '' : 'Run it on the admin machine (the one that holds the admin key). '}\`machine admin allow ${v.machine.name} --list\` shows what is allowed`.trim());
    } else lines.push(`mode local: ${v.machine.name} manages its own allow list: run the command ON ${v.where === 'this machine' ? 'this machine' : v.machine.name}; it asks the local passphrase. \`--peer <machine>\` limits it to one peer`);
  }
  if (allowedNow > 0) lines.push(`${allowedNow} earlier request${allowedNow === 1 ? ' is' : 's are'} allowed now and not listed`);
  return lines;
}

function historyText(h: HistoryEntry, now: number): string {
  return `${ago(h.at, now)}  ${who(h)}  ${h.kind} ${describeHistory(h)}${h.verified ? '' : '  [UNVERIFIED]'}`;
}

function parseLimit(text: string | undefined, flag: string): number | undefined {
  if (text === undefined) return undefined;
  const n = Number(text);
  if (!/^\d+$/.test(text) || n < 1 || n > MAX_LIMIT) throw new Error(`${flag} must be a whole number from 1 to ${MAX_LIMIT}, got "${text}"`);
  return n;
}

function parseKinds(text: string | undefined): HistoryKind[] | undefined {
  if (text === undefined) return undefined;
  const kinds = text.split(',').map((k) => k.trim());
  const bad = kinds.find((k) => !(HISTORY_KINDS as readonly string[]).includes(k));
  if (bad !== undefined) throw new Error(`--event "${bad}" is not an event kind: use ${HISTORY_KINDS.join(', ')} (comma-separated for several)`);
  return kinds as HistoryKind[];
}

export async function runRequests(ctx: CommandContext): Promise<number> {
  const { args, rest, io, configDir, fail, emit } = ctx;
  const nowSeconds = Math.floor((io.now?.() ?? new Date()).getTime() / 1000);
  const usage = 'usage: machine requests [--limit <n>] | machine requests --history [--peer <machine>] [--since <30m|2h|3d|date>] [--event refused|run|session|document] [--limit <n>] [--json]';
  if (rest.length > 0) return fail(`unexpected argument "${rest[0] as string}" for \`machine requests\`. ${usage}`, EXIT.usage);
  if (args.history !== true) {
    const stray = args.since !== undefined ? '--since' : args.event !== undefined ? '--event' : args.peer !== undefined ? '--peer' : undefined;
    if (stray !== undefined) return fail(`${stray} only applies to \`machine requests --history\`. ${usage}`, EXIT.usage);
  }
  let query: RequestsQuery;
  try {
    const limit = parseLimit(args.limit, '--limit');
    const kinds = parseKinds(args.event);
    query = {
      ...(args.history === true ? { ...(limit !== undefined ? { limit } : {}), ...(args.peer !== undefined ? { peer: args.peer } : {}), ...(args.since !== undefined ? { since: parseSince(args.since, nowSeconds) } : {}), ...(kinds !== undefined ? { kinds } : {}) } : { ...(limit !== undefined ? { pendingLimit: limit } : {}) }),
    };
  } catch (e) {
    return fail(`${(e as Error).message}. ${usage}`, EXIT.usage);
  }

  const answer = requestsAnswer(configDir, query, nowSeconds);
  if (!answer.initialized) return fail(answer.message);
  if (!answer.ok) return fail(answer.message, EXIT.reference);

  const { summary } = answer;
  if (!summary.chain.ok) {
    io.stderr(`[warn] audit log is broken at line ${summary.chain.line}: ${summary.chain.message}. The ${summary.chain.trustedEntries} entries before it are verified; ${summary.chain.unverifiedEntries} after it are shown as [UNVERIFIED] and never listed as pending${summary.chain.unreadableLines > 0 ? `; ${summary.chain.unreadableLines} line(s) cannot be read at all` : ''}. Keep a copy of ${answer.logFile} for the investigation, then move it away to start a new log (the daemon refuses to start on a broken log)\n`);
  }
  if (summary.skipped > 0) io.stderr(`[warn] ${summary.skipped} verified entr${summary.skipped === 1 ? 'y has' : 'ies have'} no usable time or event name and ${summary.skipped === 1 ? 'is' : 'are'} not shown\n`);
  for (const p of answer.problems) io.stderr(`[warn] ${p}\n`);

  const limitation = answer.adminKeyHere
    ? "this machine's requests only; `machine requests <machine>` or `--all` asks the peers for their pending list (admin passphrase; history stays on each machine)"
    : "this machine's requests only; the admin machine can list those of another machine with `machine requests <machine>` (its history: run `machine requests --history` there)";
  if (args.history !== true) {
    emit(answer, `${[...pendingText({ machine: { name: answer.self.name, policyMode: answer.policyMode }, adminKeyHere: answer.adminKeyHere, summary, logPresent: answer.logPresent, now: nowSeconds, where: 'this machine' }), `see what happened: \`machine requests --history\`; ${limitation}`].join('\n')}\n`);
    return EXIT.ok;
  }
  const lines = summary.history.map((h) => historyText(h, nowSeconds));
  if (lines.length === 0) lines.push(answer.logPresent ? 'no entry matches' : 'no entry: no audit log yet, no request ever reached this machine');
  else if (summary.historyTotal > summary.history.length) lines.push(`[info] showing the last ${summary.history.length} of ${summary.historyTotal}: \`--limit <n>\` (up to ${MAX_LIMIT}) or \`--since\` change the window`);
  lines.push(limitation);
  emit(answer, `${lines.join('\n')}\n`);
  return EXIT.ok;
}

export { DEFAULT_HISTORY_LIMIT, DEFAULT_PENDING_LIMIT };
