import { allowCommand, describeHistory, type HistoryEntry, type PendingGroup, type RequestsListAnswer, type RequestsSummary } from '@wadeck-app/machine-core';
import { ageText } from './candidacies.js';

// The Requests page (decision 73): what the peers asked THIS machine to run and what became of it. The data is the answer of the daemon
// command `requests` (the same reader as `machine requests`, machine-core summarizeRequests, over this machine's audit.log); this file only
// turns it into rows with humanized ages. Read-only. No verification code and no key anywhere in it.

/** The daemon answered something that is not the `requests` command of this version. */
export class RequestsAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestsAnswerError';
  }
}

interface RequestsAnswerLike {
  initialized: true;
  ok: true;
  self: { uuid: string; name: string };
  policyMode: 'admin' | 'local';
  adminKeyHere: boolean;
  logPresent: boolean;
  now: number;
  summary: RequestsSummary;
  problems: string[];
}

export interface PendingRow {
  peerText: string;
  peer: string;
  shell: string;
  command: string;
  countText: string;
  firstSeenText: string;
  lastSeenText: string;
  nextCommand: string;
  nextWhere: string;
}

export interface HistoryRow {
  whenText: string;
  peerText: string;
  kind: string;
  text: string;
  unverified: boolean;
}

export interface RequestsPage {
  machine: { uuid: string; name: string };
  policyMode: 'admin' | 'local';
  /** The tab indicator reads this. */
  count: number;
  pending: PendingRow[];
  pendingTotal: number;
  history: HistoryRow[];
  historyTotal: number;
  logPresent: boolean;
  chainOk: boolean;
  chainText: string;
  emptyMessage: string;
  remoteNote: string;
  notes: string[];
}

const ago = (at: number, now: number): string => (now - at < 5 ? 'now' : `${ageText(now - at)} ago`);
const times = (n: number): string => `${n} time${n === 1 ? '' : 's'}`;

function pendingRow(g: PendingGroup, machine: { name: string; policyMode: 'admin' | 'local' }, now: number): PendingRow {
  return {
    peerText: g.peerName ?? g.peer.slice(0, 8),
    peer: g.peer,
    shell: g.shell,
    command: g.command,
    countText: times(g.count),
    firstSeenText: ago(g.firstSeen, now),
    lastSeenText: ago(g.lastSeen, now),
    nextCommand: allowCommand(g, machine),
    nextWhere: machine.policyMode === 'local' ? `Run it on ${machine.name}: it manages its own allow list and asks its local passphrase.` : 'Run it on the admin machine (the one that holds the admin key): it allows the command for every peer.',
  };
}

function historyRow(h: HistoryEntry, now: number): HistoryRow {
  return { whenText: ago(h.at, now), peerText: h.peerName ?? (h.peer === undefined ? '-' : h.peer.slice(0, 8)), kind: h.kind, text: describeHistory(h), unverified: !h.verified };
}

function isAnswer(answer: unknown): answer is RequestsAnswerLike {
  const a = typeof answer === 'object' && answer !== null ? (answer as Record<string, unknown>) : undefined;
  return a !== undefined && a['initialized'] === true && a['ok'] === true && typeof a['summary'] === 'object' && a['summary'] !== null && typeof a['self'] === 'object' && a['self'] !== null;
}

export function requestsPage(answer: unknown, nowSeconds: number): RequestsPage {
  if (typeof answer === 'object' && answer !== null && (answer as { initialized?: unknown }).initialized === false) {
    throw new RequestsAnswerError(String((answer as { message?: unknown }).message ?? 'this machine is not initialized: run `machine setup <relay>`'));
  }
  if (!isAnswer(answer)) {
    throw new RequestsAnswerError('the daemon answered the requests command with something unexpected: it is probably an older version, update it with `machine cli update` and restart it');
  }
  const machine = { name: answer.self.name, policyMode: answer.policyMode };
  const { summary } = answer;
  const chain = summary.chain;
  const notes: string[] = [...answer.problems];
  if (summary.pendingTotal > summary.pending.length) notes.push(`Showing ${summary.pending.length} of ${summary.pendingTotal} pending requests (the newest).`);
  if (summary.historyTotal > summary.history.length) notes.push(`Showing the last ${summary.history.length} of ${summary.historyTotal} entries.`);
  if (summary.allowedNow > 0) notes.push(`${summary.allowedNow} earlier request${summary.allowedNow === 1 ? ' is' : 's are'} allowed now and not listed.`);
  if (summary.skipped > 0) notes.push(`${summary.skipped} verified entr${summary.skipped === 1 ? 'y has' : 'ies have'} no usable time or event name and ${summary.skipped === 1 ? 'is' : 'are'} not shown.`);
  return {
    machine: answer.self,
    policyMode: answer.policyMode,
    count: summary.pending.length,
    pending: summary.pending.map((g) => pendingRow(g, machine, nowSeconds)),
    pendingTotal: summary.pendingTotal,
    history: summary.history.map((h) => historyRow(h, nowSeconds)),
    historyTotal: summary.historyTotal,
    logPresent: answer.logPresent,
    chainOk: chain.ok,
    chainText: chain.ok
      ? ''
      : `The audit log is broken at line ${chain.line}: ${chain.message}. The ${chain.trustedEntries} entries before it are verified; ${chain.unverifiedEntries} after it are shown as unverified and never listed as pending${chain.unreadableLines > 0 ? `; ${chain.unreadableLines} line(s) cannot be read at all` : ''}. Keep a copy of the file for the investigation, then move it away to start a new log (the daemon refuses to start on a broken log).`,
    emptyMessage: answer.logPresent ? 'No request is waiting for approval' : 'No audit log yet: no request ever reached this machine',
    remoteNote: answer.adminKeyHere
      ? 'This page shows the requests of THIS machine. To list the pending requests of another machine, run `machine requests <machine>` or `machine requests --all` here (it asks the admin passphrase): the page cannot ask a peer yet.'
      : 'This page shows the requests of THIS machine. Only the admin machine can list those of another machine (`machine requests <machine>` there).',
    notes,
  };
}

export interface RemoteRequestsPage {
  machine: { uuid: string; name: string };
  policyMode: 'admin' | 'local';
  pending: PendingRow[];
  pendingTotal: number;
  chainOk: boolean;
  chainText: string;
  notes: string[];
}

/** The answer of a peer to `requests-list`, as rows. The ages use the clock of THIS machine. */
export function remoteRequestsPage(answer: RequestsListAnswer, nowSeconds: number): RemoteRequestsPage {
  const machine = { name: answer.machine.name, policyMode: answer.policyMode };
  const notes: string[] = [];
  if (answer.truncated || answer.pendingTotal > answer.pending.length) notes.push(`Showing ${answer.pending.length} of ${answer.pendingTotal} pending requests (the newest).`);
  if (answer.allowedNow > 0) notes.push(`${answer.allowedNow} earlier request${answer.allowedNow === 1 ? ' is' : 's are'} allowed now and not listed.`);
  if (Math.abs(answer.now - nowSeconds) > 120) notes.push(`The clock of ${machine.name} differs from this machine by ${Math.abs(answer.now - nowSeconds)} s: the ages use this machine's clock.`);
  return {
    machine: answer.machine,
    policyMode: answer.policyMode,
    pending: answer.pending.map((g) => pendingRow(g, machine, nowSeconds)),
    pendingTotal: answer.pendingTotal,
    chainOk: answer.chain.ok,
    chainText: answer.chain.ok ? '' : `The audit log of ${machine.name} is broken at line ${answer.chain.line}: what follows is not listed. Keep a copy of it on that machine for the investigation.`,
    notes,
  };
}
