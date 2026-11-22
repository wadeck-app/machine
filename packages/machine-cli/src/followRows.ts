import type { ActivityEvent } from '@wadeck-app/machine-core';
import { arrowOf, clock, exitText, fit, nameOf, ranText, resultText, waitedText } from './cliActivity.js';

// The rows of `machine log --follow` (run-log.md): ONE line per entry, never longer than the terminal. The width is asked again at each row, so a
// resize applies to the next one. What does not fit is dropped in a fixed order (the wait, the shell, the width of the result, the run time, the
// result again); the time, the command (at least 12 characters, ending with ... when cut), the result and the exit code are always there.
// The other machine is named on a row only when it is not the one of the row above (or the one named by the header).

/** Used when the output is not a terminal or its width is unknown. */
export const DEFAULT_COLUMNS = 100;
export const MIN_COLUMNS = 40;
export const MAX_COLUMNS = 300;

/** The outcomes of an entry that has a row of its own in `machine log`. */
const ROW_OUTCOMES = new Set(['running', 'ran', 'refused', 'denied', 'error', 'unfinished']);
/** Events of no interest to someone who watches commands: shown with --all only. */
const QUIET_EVENT = /^(documents?|session|notice|request-notice|daemon)(-|$)/;
const RAN_WIDTH = 9;
/** Below this many usable columns: no arrow, no seconds, one space between columns. */
const COMPACT_BELOW = 60;

/** An audit entry with no command: a document, a session, a notice... */
const isPlainEvent = (e: ActivityEvent): boolean => e.direction === 'received' && e.command === '' && !ROW_OUTCOMES.has(e.outcome);

/** An event row that is hidden unless --all. */
export const isQuietEvent = (e: ActivityEvent): boolean => isPlainEvent(e) && QUIET_EVENT.test(e.outcome);

/** The short words of an event row: what it says in the COMMAND column, and what is left for the RESULT one. */
function eventWords(e: ActivityEvent): { label: string; result: string } {
  if (e.outcome === 'document-delivered' && e.detail === 'already-installed') {
    return { label: 'doc already there', result: '-' };
  }
  const label = e.outcome.replace(/^documents(?=-|$)/, 'docs').replace(/^document(?=-|$)/, 'doc').replace(/-/g, ' ');
  return { label, result: e.detail ?? '-' };
}

export interface FollowRowsOptions {
  /** The width of the terminal now; called at each row. */
  columns: () => number;
  /** Show the event rows (documents, sessions, notices) too. */
  all: boolean;
  /** The only other machine of the network, when there is one: named by the header, so never on a row. */
  peer?: string;
}

export interface FollowRows {
  header: () => string;
  /** The line of an entry, or undefined when it is not shown (an event row without --all). */
  row: (e: ActivityEvent) => string | undefined;
}

/** The cells of a line. `ran` and `tail` are absent on a row that has none; the columns stay where they are. */
interface Cells {
  time: string;
  arrow: string;
  shell: string;
  command: string;
  result: string;
  exit: string;
  ran?: string;
  tail?: string;
}

/** What a width keeps: the same for every row of that width, so that the columns line up. */
interface Plan {
  compact: boolean;
  shell: boolean;
  ran: boolean;
  tail: boolean;
  resultWidth: number;
  commandWidth: number;
}

const TAIL_WIDTH = 20;

function line(p: Omit<Plan, 'commandWidth'>, c: Cells, commandWidth: number): string {
  const gap = p.compact ? ' ' : '  ';
  const lead = p.compact ? `${c.time} ` : `${c.time} ${c.arrow} `;
  const shell = p.shell ? `${fit(c.shell, 6).padEnd(6)} ` : '';
  const exit = c.exit.padStart(p.compact ? 4 : 7);
  const ran = p.ran ? `${gap}${fit(c.ran ?? '', RAN_WIDTH).padEnd(p.tail ? RAN_WIDTH : 0)}` : '';
  const tail = p.tail && c.tail !== undefined ? `${gap}${fit(c.tail, TAIL_WIDTH)}` : '';
  return `${lead}${shell}${fit(c.command, commandWidth).padEnd(commandWidth)}${gap}${fit(c.result, p.resultWidth).padEnd(p.resultWidth)}${gap}${exit}${ran}${tail}`.trimEnd();
}

/**
 * What a line of `width` characters keeps, in the order of the priorities: the wait, then the shell, then part of the result, then the run time,
 * then more of the result go first, until the command has 24 characters (12 at the very least). Decided on a row with a long command, a run time
 * and a wait, so that it does not change from one row to the next.
 */
function planFor(width: number): Plan {
  const compact = width < COMPACT_BELOW;
  const sample: Cells = { time: 'T'.repeat(compact ? 11 : 14), arrow: '  ', shell: 'sh', command: 'c', result: 'r', exit: 'e', ran: 'r'.repeat(RAN_WIDTH), tail: 't'.repeat(TAIL_WIDTH) };
  const p = { compact, shell: !compact, ran: true, tail: !compact, resultWidth: compact ? 12 : width >= 119 ? 28 : width >= 70 ? 22 : 14 };
  const room = (): number => width - line(p, sample, 0).length;
  const drops: Array<() => void> = [
    () => { p.tail = false; },
    () => { p.shell = false; },
    () => { p.resultWidth = Math.min(p.resultWidth, 18); },
    () => { p.resultWidth = Math.min(p.resultWidth, 14); },
    () => { p.ran = false; },
    () => { p.resultWidth = Math.min(p.resultWidth, compact ? 8 : 10); },
  ];

  for (const drop of drops) {
    if (room() >= 24) {
      break;
    }
    drop();
  }
  return { ...p, commandWidth: Math.max(0, room()) };
}

export function createFollowRows(options: FollowRowsOptions): FollowRows {
  // One column less than the terminal: a line that fills it exactly wraps on some terminals.
  const usable = (): number => Math.max(MIN_COLUMNS, Math.floor(options.columns())) - 1;
  let previousPeer: string | undefined = options.peer;

  return {
    header() {
      const width = usable();
      const p = planFor(width);
      return line(p, { time: 'TIME'.padEnd(p.compact ? 11 : 14), arrow: '  ', shell: 'SHELL', command: 'COMMAND', result: 'RESULT', exit: 'EXIT', ran: 'RAN', ...(p.tail ? { tail: 'WAITED' } : {}) }, p.commandWidth).slice(0, width);
    },

    row(e) {
      if (!options.all && isQuietEvent(e)) {
        return undefined;
      }
      const width = usable();
      const p = planFor(width);
      const plain = isPlainEvent(e);
      const words = plain ? eventWords(e) : undefined;
      const other = nameOf(e.direction === 'sent' ? e.to : e.from);
      const ran = plain || ranText(e) === '-' ? undefined : ranText(e);
      const waited = waitedText(e);
      const exit = plain ? '-' : exitText(e);
      let command = words !== undefined ? words.label : e.command === '' ? '-' : e.command;
      // The other machine is the first words of the command cell, as far as the command keeps its 12 characters.
      const room = p.commandWidth - 14;
      if (other !== previousPeer && room >= 3) {
        command = `${fit(other, Math.min(12, room))}: ${command}`;
      }
      previousPeer = other;
      const cells: Cells = {
        time: clock(e.atMs, false, !p.compact),
        arrow: arrowOf(e),
        shell: e.shell === '' ? '-' : e.shell,
        command,
        result: words !== undefined ? words.result : resultText(e),
        exit: p.compact ? (exit === 'timed out' ? 'tmo' : exit === 'killed' ? 'kill' : exit) : exit === 'timed out' ? 'timeout' : exit,
        ...(ran !== undefined ? { ran } : {}),
        ...(waited !== '-' && !plain ? { tail: `waited ${waited}` } : {}),
      };
      return line(p, cells, p.commandWidth).slice(0, width);
    },
  };
}
