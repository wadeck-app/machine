import { createDaemonClient } from '@wadeck-app/singleton-daemon-kit';
import { DEFAULT_HISTORY_LIMIT, DEFAULT_PENDING_LIMIT, HISTORY_KINDS, MAX_LIMIT, layoutHistory, layoutRequests, shellQuote, type HistoryKind, type PolicyMode, type RequestsSummary, type StoredNotice, type WaitingRequest } from '@wadeck-app/machine-core';
import { clockText, relativeText } from './humanTime.js';
import { EXIT, type CommandContext } from './cliTypes.js';
import { denyRemoteCommand } from './denyRemote.js';
import { requestsAnswer, type RequestsQuery } from './requestsView.js';
import { makeCommands } from './commands.js';
import { appVersion } from './version.js';

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

const ago = (at: number, now: number): string => `${clockText(at, now)} (${relativeText(at, now)})`;

export interface PendingText {
  machine: { name: string; policyMode: PolicyMode };
  /** Admin mode only: the admin key is on the machine that prints this (otherwise the command runs on the admin machine). */
  adminKeyHere: boolean;
  summary: Pick<RequestsSummary, 'pending' | 'pendingTotal' | 'allowedNow'> & { waiting?: WaitingRequest[] };
  logPresent: boolean;
  now: number;
  /** `this machine` for the local view, else the machine that holds the requests (the admin machine asked it). */
  where: string;
  /** `--full`: the whole command, wrapped, and the exact allow command of every row. */
  full?: boolean;
  /** What this listing does not cover (the local view: this machine only). */
  extraNote?: string;
  /** The local view: requests other machines reported (request-notices.md). */
  notices?: StoredNotice[];
}

/** The listing of one machine (machine-core layoutRequests): header, WAITING NOW, REFUSED, Notes. The same for `machine requests`, `<machine>` and `--all`. */
export function pendingText(v: PendingText): string[] {
  const local = v.where === 'this machine';
  return layoutRequests({
    machine: v.machine,
    remote: !local,
    adminKeyHere: v.adminKeyHere,
    now: v.now,
    waiting: v.summary.waiting ?? [],
    pending: v.summary.pending,
    pendingTotal: v.summary.pendingTotal,
    allowedNow: v.summary.allowedNow,
    logPresent: v.logPresent,
    full: v.full === true,
    ...(v.extraNote !== undefined ? { extraNote: v.extraNote } : {}),
    ...(v.notices !== undefined ? { notices: v.notices } : {}),
    age: relativeText,
    // Known for this machine only: a peer does not tell, the note then covers both.
    ...(local ? { targetPlatform: process.platform === 'win32' ? ('windows' as const) : ('posix' as const) } : {}),
  });
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
  if (args.deny !== undefined) {
    return await runDeny(ctx, args.deny, args.reason);
  }
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
  if (answer.noticesError !== undefined) {
    io.stderr(`[warn] ${answer.noticesError}\n`);
  }

  const limitation = answer.adminKeyHere
    ? 'this machine only: `machine requests <machine>` or `--all` asks the peers (admin passphrase)'
    : 'this machine only: the admin machine lists the others with `machine requests <machine>`';
  if (args.history !== true) {
    emit(answer, `${pendingText({ machine: { name: answer.self.name, policyMode: answer.policyMode }, adminKeyHere: answer.adminKeyHere, summary, logPresent: answer.logPresent, now: nowSeconds, where: 'this machine', full: args.full === true, extraNote: limitation, notices: answer.notices }).join('\n')}\n`);
    return EXIT.ok;
  }
  emit(answer, `${layoutHistory({ machineName: answer.self.name, now: nowSeconds, history: summary.history, historyTotal: summary.historyTotal, logPresent: answer.logPresent, full: args.full === true, when: ago, limitation }).join('\n')}\n`);
  return EXIT.ok;
}

/** `machine requests --deny <id> [--reason <text>]`: the daemon that holds the request refuses it. Restricting, no signature; the answer names what was denied. */
async function runDeny(ctx: CommandContext, id: string, reason: string | undefined): Promise<number> {
  const { args, rest, io, configDir, fail, emit } = ctx;
  if (rest.length > 1 || args.history === true || args.limit !== undefined || args.since !== undefined || args.event !== undefined || args.peer !== undefined) {
    return fail('--deny takes only the id (and --reason): `machine requests [<machine>] --deny <id> [--reason <text>]`; the id is shown by `machine requests` (on the machine that holds it) or `machine requests <machine>`', EXIT.usage);
  }
  if (rest.length === 1) {
    // A request held on ANOTHER machine (decision 85): sent over the authenticated channel, accepted only from a machine of its notice-recipients list. No passphrase.
    const machine = rest[0] as string;
    const nowSeconds = Math.floor((io.now?.() ?? new Date()).getTime() / 1000);
    const sent = await denyRemoteCommand(configDir, { peer: machine, id, ...(reason !== undefined ? { reason } : {}) }, nowSeconds, { allowLocal: io.allowLoopbackPeers === true, ...(args.address !== undefined ? { address: args.address } : {}) });
    if (!sent.ok) {
      return fail(sent.message, sent.reason === 'bad-deny' || sent.reason === 'ambiguous' || sent.reason === 'bad-reason' || sent.reason === 'unknown-peer' ? EXIT.usage : EXIT.failure);
    }
    emit(sent, `[ok] denied the request ${sent.id.slice(0, 8)} held on ${sent.peer?.name ?? machine}: its caller is answered refused (denied)${reason !== undefined ? ' with your reason' : ''}\n`);
    return EXIT.ok;
  }
  const client = createDaemonClient({ configDir, commands: makeCommands(configDir, appVersion) });
  const r = (await client.send('deny', { id, ...(reason !== undefined ? { reason } : {}) })) as Awaited<ReturnType<ReturnType<typeof makeCommands>['deny']>>;
  if (!r.ok) {
    return fail(r.message, r.reason === 'bad-reason' || r.reason === 'too-short' || r.reason === 'ambiguous' ? EXIT.usage : EXIT.failure);
  }
  emit(r, `[ok] denied ${r.shell} "${r.command}" from ${r.peer.slice(0, 8)}: its caller is answered refused (denied)${reason !== undefined ? ` with your reason` : ''}
`);
  return EXIT.ok;
}

export { DEFAULT_HISTORY_LIMIT, DEFAULT_PENDING_LIMIT };
