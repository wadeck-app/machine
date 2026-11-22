import { ACTIVITY_MAX_LIMIT, formatRunTime, type ActivityEvent, type ActivityQueryText } from '@wadeck-app/machine-core';
import { activityAnswer, type ActivityView } from './activityView.js';
import { EXIT, type CommandContext, type Parsed } from './cliTypes.js';

// `machine log`: the commands THIS machine sent (`machine run`, its outgoing run log) and received (its audit log) in one list, newest first
// (run-log.md). Read-only, no daemon needed. Human output: at most LINE_WIDTH ASCII characters per line.

const LINE_WIDTH = 100;
const pad = (n: number): string => String(n).padStart(2, '0');

/** "2026-11-21 10:00", local time; "11-21 10:00" (no year) when every entry of the page is from the current year. */
function clock(atMs: number, withYear: boolean): string {
  const d = new Date(atMs);
  return `${withYear ? `${d.getFullYear()}-` : ''}${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `text` cut to `max` characters, ending with `...` when it was cut. */
function fit(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return max <= 3 ? text.slice(0, Math.max(0, max)) : `${text.slice(0, max - 3)}...`;
}

const nameOf = (m: { name?: string | undefined; uuid?: string | undefined }): string => m.name ?? (m.uuid === undefined ? '?' : m.uuid.slice(0, 8));

/** The RESULT column: what became of the request. The exit code, the run time and the wait have their own columns. */
function resultText(e: ActivityEvent): string {
  if (e.outcome === 'refused') {
    return `refused (${e.reason ?? 'unknown'})`;
  }
  if (e.outcome === 'error' && e.cause !== undefined) {
    return `error (${e.cause})`;
  }
  return e.outcome;
}

/** The EXIT column: the number, or why there is none; a dash when no command ran. */
function exitText(e: ActivityEvent): string {
  if (e.outcome !== 'ran') {
    return '-';
  }
  if (e.timedOut === true) {
    return 'timed out';
  }
  return e.exitCode === null || e.exitCode === undefined ? 'killed' : String(e.exitCode);
}

/** The RAN column: the run time of the command on the target; ~ marks an estimate (the whole run minus the wait, for an older entry). */
const ranText = (e: ActivityEvent): string => (e.execMs === undefined ? '-' : `${e.execDerived === true ? '~' : ''}${formatRunTime(e.execMs)}`);

/** The WAITED column: how long the request was held waiting for the owner; a dash when it was not. */
const waitedText = (e: ActivityEvent): string => (e.waitedSeconds === undefined || e.waitedSeconds <= 0 ? '-' : formatRunTime(e.waitedSeconds * 1000));

/** Widest first: the caps of the route and result columns are lowered until the command keeps at least 14 characters (8 as a last resort). */
const WIDTH_STEPS = [{ route: 21, result: 20 }, { route: 19, result: 18 }, { route: 19, result: 16 }, { route: 15, result: 16 }, { route: 11, result: 14 }] as const;
// time(16 or 11) arrow(2) route shell command result exit ran waited: six gaps of one space and two of two spaces around the command
const GAPS = 10;

/** The human text of a view, one string per line, none longer than LINE_WIDTH. Times are the local time of each entry. */
export function activityText(view: ActivityView, filterNote: string): string[] {
  const { page } = view;
  const lines: string[] = [];
  const first = page.total === 0 ? 0 : page.offset + 1;
  const total = `${page.totalExact ? '' : 'at least '}${page.total}`;
  lines.push(`Activity of ${view.self.name}: ${total} entr${page.total === 1 && page.totalExact ? 'y' : 'ies'} (${page.counts.sent} sent, ${page.counts.received} received), newest first${page.total > 0 ? `, showing ${first}-${page.offset + page.items.length}` : ''}`);
  if (filterNote.length > 0) {
    lines.push(`filters: ${filterNote}`);
  }
  if (page.items.length === 0) {
    lines.push(filterNote.length > 0 ? 'no entry matches these filters' : 'no activity yet: no `machine run` was sent from this machine and no request reached it');
    return lines;
  }
  const thisYear = new Date(view.now * 1000).getFullYear();
  const withYear = page.items.some((e) => new Date(e.atMs).getFullYear() !== thisYear);
  const timeWidth = withYear ? 16 : 11;
  const arrowOf = (e: ActivityEvent): string => (e.direction === 'sent' ? '=>' : '<=');
  const step = WIDTH_STEPS.find((s) => {
    const natural = fixedWidth(page.items, s.route, s.result, timeWidth);
    return LINE_WIDTH - natural >= 14;
  }) ?? (WIDTH_STEPS[WIDTH_STEPS.length - 1] as (typeof WIDTH_STEPS)[number]);
  const routeOf = (e: ActivityEvent, max: number): string => {
    const half = Math.max(3, Math.floor((max - 4) / 2));
    return `${fit(nameOf(e.from), half)} -> ${fit(nameOf(e.to), half)}`;
  };
  const cells = page.items.map((e) => ({ e, route: routeOf(e, step.route), shell: e.shell === '' ? '-' : fit(e.shell, 6), result: fit(resultText(e), step.result), exit: exitText(e), ran: ranText(e), waited: waitedText(e) }));
  const widthOf = (header: string, pick: (c: (typeof cells)[number]) => string): number => Math.max(header.length, ...cells.map((c) => pick(c).length));
  const w = { route: widthOf('FROM -> TO', (c) => c.route), shell: widthOf('SHELL', (c) => c.shell), result: widthOf('RESULT', (c) => c.result), exit: widthOf('EXIT', (c) => c.exit), ran: widthOf('RAN', (c) => c.ran), waited: widthOf('WAITED', (c) => c.waited) };
  const commandWidth = Math.max(8, LINE_WIDTH - (timeWidth + 2 + w.route + w.shell + w.result + w.exit + w.ran + w.waited + GAPS));
  const row = (time: string, arrow: string, route: string, shell: string, command: string, result: string, exit: string, ran: string, waited: string): string =>
    `${time.padEnd(timeWidth)} ${arrow} ${route.padEnd(w.route)} ${shell.padEnd(w.shell)}  ${command.padEnd(commandWidth)}  ${result.padEnd(w.result)} ${exit.padStart(w.exit)} ${ran.padStart(w.ran)} ${waited.padStart(w.waited)}`.trimEnd();
  lines.push(row('TIME', '  ', 'FROM -> TO', 'SHELL', 'COMMAND', 'RESULT', 'EXIT', 'RAN', 'WAITED'));
  for (const c of cells) {
    lines.push(row(clock(c.e.atMs, withYear), arrowOf(c.e), c.route, c.shell, c.e.command === '' ? '-' : fit(c.e.command, commandWidth), c.result, c.exit, c.ran, c.waited));
    if (!c.e.verified) {
      lines.push('  [UNVERIFIED] the audit log is broken before this entry: it cannot be trusted');
    }
  }
  lines.push('=> sent from this machine, <= received by this machine');
  lines.push('RAN: run time of the command on the target. WAITED: time the request was held for its owner');
  if (cells.some((c) => c.e.execDerived === true)) {
    lines.push('~ estimated: the whole run minus the wait (the entry was written before the run time was recorded)');
  }
  if (page.hasMore) {
    lines.push(page.totalExact ? `[info] ${page.total - page.offset - page.items.length} more: --offset ${page.nextOffset as number} shows the next page (--limit up to ${ACTIVITY_MAX_LIMIT})` : `[info] more follow: --offset ${page.nextOffset as number} shows the next page (--limit up to ${ACTIVITY_MAX_LIMIT})`);
  }
  return lines;
}

/** Width of everything but the command, for the caps of a step. */
function fixedWidth(items: ActivityEvent[], routeCap: number, resultCap: number, timeWidth: number): number {
  const half = Math.max(3, Math.floor((routeCap - 4) / 2));
  const max = (header: string, texts: string[]): number => Math.max(header.length, ...texts.map((t) => t.length));
  const route = max('FROM -> TO', items.map((e) => `${fit(nameOf(e.from), half)} -> ${fit(nameOf(e.to), half)}`));
  const shell = max('SHELL', items.map((e) => (e.shell === '' ? '-' : fit(e.shell, 6))));
  const result = max('RESULT', items.map((e) => fit(resultText(e), resultCap)));
  const exit = max('EXIT', items.map(exitText));
  const ran = max('RAN', items.map(ranText));
  const waited = max('WAITED', items.map(waitedText));
  return timeWidth + 2 + route + shell + result + exit + ran + waited + GAPS;
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

  for (const note of answer.runLog.recounted) {
    io.stderr(`[warn] ${note}\n`);
  }
  if (answer.auditDamagedLines > 0) {
    io.stderr(`[warn] ${answer.auditDamagedLines} damaged line(s) of the audit log were skipped: see ${answer.auditLogFile}; the other entries are shown. Keep a copy of the file for the investigation\n`);
  }
  if (answer.runLog.damagedLines > 0) {
    io.stderr(`[warn] ${answer.runLog.damagedLines} damaged line(s) of the run log were skipped (a crash cut them, or the file was edited): see ${answer.runLog.dir}; the other entries are shown\n`);
  }
  const { chain } = answer.page;
  if (chain !== undefined && !chain.ok) {
    io.stderr(`[warn] the audit log is broken at line ${chain.line}: ${chain.message}. Checked on the ${chain.checkedLines} lines read for this page (the daemon checks the whole log at start); the received entries from that line on are shown as [UNVERIFIED]. Keep a copy of ${answer.auditLogFile} for the investigation, then move it away to start a new log (the daemon refuses to start on a broken log)\n`);
  }
  if (args.machine !== undefined && args.machine !== '' && answer.page.total === 0 && !answer.machines.some((m) => m.toLowerCase() === (args.machine as string).toLowerCase())) {
    io.stderr(`[warn] no machine named "${args.machine}" is known here${answer.machines.length > 0 ? ` (known: ${answer.machines.join(', ')})` : ''}: check the spelling, \`machine list\` shows the machines of the network\n`);
  }

  const text = `${activityText(answer, describeFilters(query)).join('\n')}\n`;
  emit({ machine: answer.self, total: answer.page.total, totalExact: answer.page.totalExact, page: answer.page.page, pageSize: answer.page.pageSize, pageCount: answer.page.pageCount, offset: answer.page.offset, limit: answer.page.limit, hasMore: answer.page.hasMore, ...(answer.page.nextOffset !== undefined ? { nextOffset: answer.page.nextOffset } : {}), counts: answer.page.counts, items: answer.page.items, warnings: { damagedRunLogLines: answer.runLog.damagedLines, damagedAuditLines: answer.auditDamagedLines, auditChainOk: chain?.ok !== false } }, text);
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
