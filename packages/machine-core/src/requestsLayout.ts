import { allowCommand, describeHistory, type HistoryEntry, type PendingGroup, type WaitingRequest } from './requests.js';
import type { PolicyMode } from './policy.js';

// The human layout of `machine requests` (local, `<machine>`, `--all`, `--history`): pure text, no I/O, no clock. A header with the counts, one
// section per kind (WAITING NOW, REFUSED), each request one aligned table row, at most one line of actions under a section, and a `Notes:` footer of at
// most 3 short lines. No line is wider than REQUESTS_WIDTH and every character is printable ASCII. `--json` is another document and never goes through here.

export const REQUESTS_WIDTH = 100;
export const MAX_NOTES = 3;

const INDENT = 2;
const GAP = 2;
/** The last column (the command) never gets less than this, so that the fixed columns are cut before it. */
const MIN_LAST_COLUMN = 24;

export interface RequestsLayoutInput {
  machine: { name: string; policyMode: PolicyMode };
  /** The machine listed is NOT the one that prints it (the admin machine asked a peer). */
  remote: boolean;
  /** Admin mode: the admin key is on the machine that prints this. */
  adminKeyHere: boolean;
  /** Epoch seconds on the printing machine. The times of the rows are already on its clock. */
  now: number;
  waiting: WaitingRequest[];
  pending: PendingGroup[];
  pendingTotal: number;
  allowedNow: number;
  logPresent: boolean;
  /** Show the whole command (wrapped) and the exact allow command of every row. */
  full: boolean;
  /** `5 min ago`. */
  age: (at: number, now: number) => string;
  /** The platform of the listed machine when it is known (a local view); unknown for a peer. */
  targetPlatform?: 'windows' | 'posix';
  /** The last note, kept only when there is room under the cap (what this listing does not cover). */
  extraNote?: string;
}

const ascii = (text: string): string => text.replace(/[^\x20-\x7e]/g, '?');
const cut = (text: string, width: number): string => (text.length <= width ? text : `${text.slice(0, Math.max(0, width - 3))}...`);
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);
/** A line that is not a command to copy: cut at the width rather than overflow. */
const fit = (line: string): string => cut(line, REQUESTS_WIDTH);

const leftText = (seconds: number): string => (seconds >= 60 ? `${Math.ceil(seconds / 60)} min` : `${Math.max(0, Math.ceil(seconds))} s`);

interface Column {
  title: string;
  cells: string[];
  /** The widest a fixed column gets (a longer text is cut with `...`). */
  max?: number;
}

/** Aligned rows under a title row; the LAST column takes the rest of the width, cut with `...` or, in full mode, wrapped under itself. */
function table(columns: Column[], full: boolean): string[] {
  const fixed = columns.slice(0, -1);
  const last = columns[columns.length - 1] as Column;
  const widths = fixed.map((c) => Math.min(c.max ?? 16, Math.max(c.title.length, ...c.cells.map((cell) => cell.length))));
  const lead = INDENT + widths.reduce((sum, w) => sum + w + GAP, 0);
  const lastWidth = Math.max(MIN_LAST_COLUMN, REQUESTS_WIDTH - lead);
  const pad = (parts: string[]): string => parts.map((p, i) => cut(p, widths[i] as number).padEnd((widths[i] as number) + GAP)).join('');
  // Titles are written in natural case and shown in capitals, as the section names are.
  const lines = [`${' '.repeat(INDENT)}${pad(fixed.map((c) => c.title.toUpperCase()))}${last.title.toUpperCase()}`];
  for (let row = 0; row < last.cells.length; row++) {
    const start = `${' '.repeat(INDENT)}${pad(fixed.map((c) => c.cells[row] as string))}`;
    const text = last.cells[row] as string;
    if (!full || text.length <= lastWidth) {
      lines.push(`${start}${cut(text, lastWidth)}`.trimEnd());
      continue;
    }
    const chunks = wrap(text, lastWidth);
    lines.push(`${start}${chunks[0] as string}`.trimEnd());
    for (const chunk of chunks.slice(1)) {
      lines.push(`${' '.repeat(lead)}${chunk}`.trimEnd());
    }
  }
  return lines;
}

/** Cuts at a space when there is one in the last quarter of the chunk, else at the width. */
function wrap(text: string, width: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > width) {
    const space = rest.lastIndexOf(' ', width);
    const at = space > width * 0.75 ? space + 1 : width;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  chunks.push(rest);
  return chunks;
}

const who = (g: { peer: string; peerName?: string }): string => ascii(g.peerName ?? g.peer.slice(0, 8));

function allowTemplate(machine: { name: string; policyMode: PolicyMode }): string {
  return machine.policyMode === 'local' ? 'machine policy allow --shell <shell> -- <command>' : `machine admin allow ${machine.name} --shell <shell> -- <command>`;
}

/** ONE line of actions under a section: the exact command when the section has one row (and it fits), else the template. */
function allowLines(rows: Array<{ shell: string; command: string }>, input: RequestsLayoutInput): string[] {
  const { machine, full } = input;
  if (full) {
    return rows.map((r) => `  allow: ${allowCommand(r, machine)}`);
  }
  const only = rows.length === 1 ? rows[0] : undefined;
  if (only !== undefined) {
    const exact = `  allow: ${allowCommand(only, machine)}`;
    if (exact.length <= REQUESTS_WIDTH) {
      return [exact];
    }
    return [fit(`  allow: ${allowTemplate(machine)}  (long command: --full)`)];
  }
  return [fit(`  allow: ${allowTemplate(machine)}  (exact: --full or --json)`)];
}

function shellNote(input: RequestsLayoutInput): string | undefined {
  const usesCmd = [...input.waiting, ...input.pending].some((r) => r.shell === 'cmd');
  if (!usesCmd || input.targetPlatform === 'windows') {
    return undefined;
  }
  return `cmd is a Windows shell: Linux/macOS needs --shell sh (peer connect ${input.machine.name} --shell sh)`;
}

function notes(input: RequestsLayoutInput): string[] {
  const { machine } = input;
  const out: string[] = [];
  const shell = shellNote(input);
  if (shell !== undefined) {
    out.push(shell);
  }
  if (input.waiting.length > 0) {
    out.push(
      input.remote
        ? `deny: machine requests --deny <id> [--reason <text>], run ON ${machine.name} (the machine that holds it)`
        : 'deny: machine requests --deny <id> [--reason <text>] (no passphrase)',
    );
  }
  if (input.waiting.length > 0 || input.pending.length > 0) {
    if (machine.policyMode === 'local') {
      out.push(`mode local: allow ON ${machine.name}, it asks its local passphrase (\`--peer <machine>\` limits it to one peer)`);
    } else if (input.remote) {
      out.push(`allow signs a policy: ${machine.name} installs it within about a minute, then the held request runs`);
    } else if (input.adminKeyHere) {
      out.push('allow adds the command to the default list: every peer may then run it');
    } else {
      out.push('allow adds it to the default list for every peer: run it on the admin machine');
    }
  }
  if (input.extraNote !== undefined) {
    out.push(input.extraNote);
  }
  return out.slice(0, MAX_NOTES).map(fit);
}

export function layoutRequests(raw: RequestsLayoutInput): string[] {
  // Whatever a peer wrote is reduced to printable ASCII before anything else: the allow commands are built from it too.
  const input: RequestsLayoutInput = {
    ...raw,
    machine: { ...raw.machine, name: ascii(raw.machine.name) },
    waiting: raw.waiting.map((w) => ({ ...w, shell: ascii(w.shell), command: ascii(w.command), ...(w.peerName !== undefined ? { peerName: ascii(w.peerName) } : {}) })),
    pending: raw.pending.map((g) => ({ ...g, shell: ascii(g.shell), command: ascii(g.command), ...(g.peerName !== undefined ? { peerName: ascii(g.peerName) } : {}) })),
  };
  const { machine, now, waiting, pending, pendingTotal } = input;
  const name = ascii(machine.name);
  const counts = [
    waiting.length > 0 ? `${waiting.length} waiting now` : 'nothing waiting',
    pendingTotal > 0 ? `${pendingTotal} refused (not allowed)` : 'no refused request',
  ];
  const lines: string[] = [fit(`${name} (${machine.policyMode} mode): ${counts.join(', ')}`)];

  if (waiting.length > 0) {
    lines.push('', `${'Waiting now'.toUpperCase()}  (the caller is connected and waits: answer before the time left runs out)`);
    lines.push(
      ...table(
        [
          { title: 'Id', cells: waiting.map((w) => w.id.slice(0, 8)), max: 8 },
          { title: 'From', cells: waiting.map(who), max: 14 },
          { title: 'Shell', cells: waiting.map((w) => ascii(w.shell)), max: 6 },
          { title: 'Left', cells: waiting.map((w) => leftText(w.deadline - now)), max: 8 },
          { title: 'Asked', cells: waiting.map((w) => input.age(w.since, now)), max: 12 },
          { title: 'Command', cells: waiting.map((w) => ascii(w.command)) },
        ],
        input.full,
      ),
    );
    lines.push(...allowLines(waiting, input));
  }

  if (pending.length > 0) {
    lines.push('', `${'Refused'.toUpperCase()}  (not allowed, newest first)`);
    lines.push(
      ...table(
        [
          { title: 'From', cells: pending.map(who), max: 14 },
          { title: 'Shell', cells: pending.map((g) => ascii(g.shell)), max: 6 },
          { title: 'Times', cells: pending.map((g) => String(g.count)), max: 6 },
          { title: 'Last', cells: pending.map((g) => input.age(g.lastSeen, now)), max: 12 },
          { title: 'Command', cells: pending.map((g) => ascii(g.command)) },
        ],
        input.full,
      ),
    );
    lines.push(...allowLines(pending, input));
    if (pendingTotal > pending.length) {
      lines.push(`  [info] showing ${pending.length} of ${pendingTotal} (the newest): --limit <n> shows more`);
    }
  }

  if (waiting.length === 0 && pending.length === 0 && !input.logPresent) {
    lines.push('', '  no audit log yet: no request ever reached it');
  }
  if (input.allowedNow > 0) {
    lines.push('', fit(`  ${input.allowedNow} earlier ${plural(input.allowedNow, 'request is', 'requests are')} allowed now and not listed`));
  }

  const footer = notes(input);
  if (footer.length > 0) {
    lines.push('', 'Notes:', ...footer.map((n) => `  - ${n}`).map(fit));
  }
  return lines;
}

export interface HistoryLayoutInput {
  machineName: string;
  now: number;
  history: HistoryEntry[];
  historyTotal: number;
  logPresent: boolean;
  full: boolean;
  /** `21:55 (5 min ago)`. */
  when: (at: number, now: number) => string;
  /** What the list does not cover (this machine only, where the others are read): the one note. */
  limitation: string;
}

export function layoutHistory(input: HistoryLayoutInput): string[] {
  const { history, historyTotal } = input;
  const name = ascii(input.machineName);
  const lines: string[] = [];
  if (history.length === 0) {
    lines.push(fit(`${name}: history, ${input.logPresent ? 'no entry matches' : 'no entry (no audit log yet: no request ever reached it)'}`));
  } else if (historyTotal > history.length) {
    lines.push(fit(`${name}: history, last ${history.length} of ${historyTotal} entries, oldest first (--limit <n> or --since change the window)`));
  } else {
    lines.push(`${name}: history, ${history.length} ${plural(history.length, 'entry', 'entries')}, oldest first`);
  }
  if (history.length > 0) {
    lines.push(
      '',
      ...table(
        [
          { title: 'When', cells: history.map((h) => input.when(h.at, input.now)), max: 30 },
          { title: 'From', cells: history.map((h) => ascii(h.peerName ?? (h.peer === undefined ? '-' : h.peer.slice(0, 8)))), max: 14 },
          { title: 'Kind', cells: history.map((h) => ascii(h.kind)), max: 8 },
          { title: 'What', cells: history.map((h) => `${h.verified ? '' : '[UNVERIFIED] '}${ascii(describeHistory(h))}`) },
        ],
        input.full,
      ),
    );
  }
  lines.push('', 'Notes:', fit(`  - ${input.limitation}`));
  return lines;
}
