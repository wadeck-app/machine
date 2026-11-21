import { ACTIVITY_MAX_LIMIT, type ActivityEvent, type ActivityQueryText } from '@wadeck-app/machine-core';
import { activityAnswer, type ActivityView } from './activityView.js';
import { EXIT, type CommandContext, type Parsed } from './cliTypes.js';

// `machine log`: the commands THIS machine sent (`machine run`, its outgoing run log) and received (its audit log) in one list, newest first
// (run-log.md). Read-only, no daemon needed. Human output: at most LINE_WIDTH ASCII characters per line.

const LINE_WIDTH = 100;
const pad = (n: number): string => String(n).padStart(2, '0');

/** "2026-11-21 10:00", local time. */
function clock(atMs: number): string {
  const d = new Date(atMs);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `text` cut to `max` characters, ending with `...` when it was cut. */
function fit(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return max <= 3 ? text.slice(0, Math.max(0, max)) : `${text.slice(0, max - 3)}...`;
}

const nameOf = (m: { name?: string | undefined; uuid?: string | undefined }): string => m.name ?? (m.uuid === undefined ? '?' : m.uuid.slice(0, 8));

function outcomeText(e: ActivityEvent): string {
  let text: string;
  switch (e.outcome) {
    case 'ran':
      text = `ran (exit ${e.exitCode === null || e.exitCode === undefined ? 'none' : e.exitCode}${e.timedOut === true ? ', timed out' : ''})`;
      break;
    case 'refused':
      text = `refused (${e.reason ?? 'unknown'})`;
      break;
    case 'error':
      text = `error${e.cause !== undefined ? ` (${e.cause})` : ''}`;
      break;
    default:
      text = e.outcome;
  }
  const shown = fit(text, 20);
  return e.verified ? shown : `${shown} [UNVERIFIED]`;
}

/** The human text of a view, one string per line, none longer than LINE_WIDTH. Times are the local time of each entry. */
export function activityText(view: ActivityView, filterNote: string): string[] {
  const { page } = view;
  const lines: string[] = [];
  const first = page.total === 0 ? 0 : page.offset + 1;
  lines.push(`Activity of ${view.self.name}: ${page.total} entr${page.total === 1 ? 'y' : 'ies'} (${page.counts.sent} sent, ${page.counts.received} received), newest first${page.total > 0 ? `, showing ${first}-${page.offset + page.items.length}` : ''}`);
  if (filterNote.length > 0) {
    lines.push(`filters: ${filterNote}`);
  }
  if (page.items.length === 0) {
    lines.push(filterNote.length > 0 ? 'no entry matches these filters' : 'no activity yet: no `machine run` was sent from this machine and no request reached it');
    return lines;
  }
  const arrowOf = (e: ActivityEvent): string => (e.direction === 'sent' ? '=>' : '<=');
  const routes = page.items.map((e) => ({ from: nameOf(e.from), to: nameOf(e.to) }));
  const routeText = (r: { from: string; to: string }, max: number): string => {
    const half = Math.max(3, Math.floor((max - 4) / 2));
    return `${fit(r.from, half)} -> ${fit(r.to, half)}`;
  };
  const routeTexts = routes.map((r) => routeText(r, 21));
  const routeWidth = Math.max(10, ...routeTexts.map((t) => t.length));
  const shellWidth = Math.max(5, ...page.items.map((e) => Math.min(6, e.shell.length)));
  const outcomes = page.items.map((e) => outcomeText(e));
  const outcomeWidth = Math.max(7, ...outcomes.map((t) => t.length));
  // time(16) arrow(2) route shell command outcome, five gaps of two spaces
  const commandWidth = Math.max(12, LINE_WIDTH - (16 + 2 + routeWidth + shellWidth + outcomeWidth + 10));
  const row = (time: string, arrow: string, route: string, shell: string, command: string, outcome: string): string => `${time.padEnd(16)}  ${arrow}  ${route.padEnd(routeWidth)}  ${shell.padEnd(shellWidth)}  ${command.padEnd(commandWidth)}  ${outcome}`.trimEnd();
  lines.push(row('TIME', '  ', 'FROM -> TO', 'SHELL', 'COMMAND', 'OUTCOME'));
  page.items.forEach((e, i) => {
    lines.push(row(clock(e.atMs), arrowOf(e), routeTexts[i] as string, e.shell === '' ? '-' : fit(e.shell, 6), e.command === '' ? '-' : fit(e.command, commandWidth), outcomes[i] as string));
  });
  lines.push('=> sent from this machine, <= received by this machine');
  if (page.hasMore) {
    lines.push(`[info] ${page.total - page.offset - page.items.length} more: --offset ${page.nextOffset as number} shows the next page (--limit up to ${ACTIVITY_MAX_LIMIT})`);
  }
  return lines;
}

function describeFilters(query: ActivityQueryText): string {
  const parts: string[] = [];
  for (const key of ['direction', 'machine', 'outcome', 'since', 'text'] as const) {
    const v = query[key];
    if (v !== undefined && v !== '') {
      parts.push(`${key}=${v}`);
    }
  }
  return parts.join(', ');
}

export function runActivityLog(ctx: CommandContext): number {
  const { args, rest, io, configDir, fail, emit } = ctx;
  const usage = 'usage: machine log [--sent | --received] [--machine <name>] [--since <30m|2h|3d|date>] [--outcome <ran|refused|denied|deadline|timeout|connection-lost|error|unfinished>] [--text <word>] [--limit <n>] [--offset <n>] [--json]';
  if (rest.length > 0) {
    return fail(`unexpected argument "${rest[0] as string}" for \`machine log\`. ${usage}`, EXIT.usage);
  }
  if (args.sent === true && args.received === true) {
    return fail(`--sent and --received contradict each other: remove one of them, or neither to see both. ${usage}`, EXIT.usage);
  }
  const query: ActivityQueryText = {
    ...(args.sent === true ? { direction: 'sent' } : {}),
    ...(args.received === true ? { direction: 'received' } : {}),
    ...(args.machine !== undefined ? { machine: args.machine } : {}),
    ...(args.outcome !== undefined ? { outcome: args.outcome } : {}),
    ...(args.since !== undefined ? { since: args.since } : {}),
    ...(args.text !== undefined ? { text: args.text } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.offset !== undefined ? { offset: args.offset } : {}),
  };
  const answer = activityAnswer(configDir, query, Math.floor((io.now?.() ?? new Date()).getTime() / 1000));
  if (!answer.initialized) {
    return fail(answer.message);
  }
  if (!answer.ok) {
    return fail(answer.reason === 'bad-query' ? `${answer.message}. ${usage}` : answer.message, answer.reason === 'bad-query' ? EXIT.usage : EXIT.failure);
  }

  if (answer.runLog.damagedLines > 0) {
    io.stderr(`[warn] ${answer.runLog.damagedLines} damaged line(s) of the run log were skipped (a crash cut them, or the file was edited): see ${answer.runLog.dir}; the other entries are shown\n`);
  }
  const { chain } = answer.page;
  if (chain !== undefined && !chain.ok) {
    io.stderr(`[warn] the audit log is broken at line ${chain.line}: ${chain.message}. The ${chain.trustedEntries} entries before it are verified; the received entries after it are shown as [UNVERIFIED]. Keep a copy of ${answer.auditLogFile} for the investigation, then move it away to start a new log (the daemon refuses to start on a broken log)\n`);
  }
  if (args.machine !== undefined && args.machine !== '' && answer.page.total === 0 && !answer.machines.some((m) => m.toLowerCase() === (args.machine as string).toLowerCase())) {
    io.stderr(`[warn] no machine named "${args.machine}" is known here${answer.machines.length > 0 ? ` (known: ${answer.machines.join(', ')})` : ''}: check the spelling, \`machine list\` shows the machines of the network\n`);
  }

  const text = `${activityText(answer, describeFilters(query)).join('\n')}\n`;
  emit({ machine: answer.self, total: answer.page.total, offset: answer.page.offset, limit: answer.page.limit, hasMore: answer.page.hasMore, ...(answer.page.nextOffset !== undefined ? { nextOffset: answer.page.nextOffset } : {}), counts: answer.page.counts, items: answer.page.items, warnings: { damagedRunLogLines: answer.runLog.damagedLines, auditChainOk: chain?.ok !== false } }, text);
  return EXIT.ok;
}

/**
 * Flags are never silently ignored: the filters of `machine log` are refused on another command, and the options of `machine requests` are
 * refused on `machine log` (`--since` and `--limit` are shared and checked by cli.ts). Returns the message, or undefined.
 */
export function logOnlyFlagProblem(command: string, args: Pick<Parsed, 'sent' | 'received' | 'machine' | 'outcome' | 'text' | 'offset' | 'history' | 'all' | 'event' | 'full' | 'peer'>): string | undefined {
  const logFlags: Array<[string, unknown]> = [['--sent', args.sent], ['--received', args.received], ['--machine', args.machine], ['--outcome', args.outcome], ['--text', args.text], ['--offset', args.offset]];
  if (command !== 'log') {
    const given = logFlags.find(([, v]) => v !== undefined);
    return given === undefined ? undefined : `${given[0]} only applies to \`machine log\` (the commands this machine sent and received)`;
  }
  const requestsFlags: Array<[string, unknown]> = [['--history', args.history], ['--all', args.all], ['--event', args.event], ['--full', args.full], ['--peer', args.peer]];
  const given = requestsFlags.find(([, v]) => v !== undefined);
  return given === undefined ? undefined : `${given[0]} does not apply to \`machine log\`: it takes --sent, --received, --machine, --since, --outcome, --text, --limit, --offset and --json (\`machine requests --history\` is the history of the requests refused by this machine)`;
}
