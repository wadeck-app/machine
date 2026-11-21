import { allowCommand, describeHistory, type HistoryEntry, type PendingGroup, type RequestsListAnswer, type RequestsSummary, type WaitingRequest } from '@wadeck-app/machine-core';
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
  /** Request notices reported by other machines (request-notices.md, phase 2); absent in an older daemon. */
  notices?: unknown;
  noticesError?: unknown;
}

/**
 * A held or refused request that ANOTHER machine reported (a notice). Information, not verified live: the row is labelled with the machine that
 * REPORTED it (`machineName`, authenticated by the daemon), never with a name inside the notice. `command` is untrusted text: the page shows it as text only.
 */
export interface NoticeRow {
  /** The request id (what `machine requests --deny <id>` takes ON the machine). */
  id: string;
  /** The machine that reported it, and so the machine Allow signs for. */
  machine: string;
  machineName: string;
  peerText: string;
  peer: string;
  shell: string;
  command: string;
  commandTruncated: boolean;
  state: 'held' | 'refused';
  /** Held: seconds left at the time of this answer; null for a refused one. */
  secondsLeft: number | null;
  /** Epoch seconds, this machine's clock. */
  receivedAt: number;
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

/** A request a peer's `run --wait` holds right now: the owner may still allow or deny it. The page counts `secondsLeft` down by itself from the value it got at fetch time. */
export interface WaitingRow {
  /** What `machine requests --deny <id>` and the Deny button take. */
  id: string;
  peerText: string;
  peer: string;
  shell: string;
  command: string;
  /** Seconds until the hold ends, by the clock of the daemon that holds it (never negative). */
  secondsLeft: number;
  askedText: string;
  /** What the Allow dialog shows next to the peer (it shows `countText` of a pending row). */
  countText: string;
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

/** Whether the Allow button of the rows is offered on this machine (decision 76), and why not. The button signs IN THE BROWSER; see AllowRequestsTable. */
export interface AllowCapability {
  available: boolean;
  /** The target of the policy: this machine. */
  machine: { uuid: string; name: string };
  /** Why it is not offered, and what to do instead; empty when it is. */
  note: string;
}

/** Whether this page may ask the OTHER machines for their requests (admin machine only: the request is signed with the admin key, in the browser). */
export interface RemoteCapability {
  available: boolean;
  /** Why not, and where to do it instead; empty when it is. */
  note: string;
}

export interface RequestsPage {
  machine: { uuid: string; name: string };
  policyMode: 'admin' | 'local';
  allow: AllowCapability;
  remote: RemoteCapability;
  /** The tab indicator reads this. */
  count: number;
  waiting: WaitingRow[];
  pending: PendingRow[];
  pendingTotal: number;
  /** Held and refused requests other machines reported, newest first. */
  notices: NoticeRow[];
  /** Why the notices may be incomplete (damaged store, older daemon, unexpected entries); empty when all is well. */
  noticesError: string;
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
    nextWhere: nextWhere(machine),
  };
}

function nextWhere(machine: { name: string; policyMode: 'admin' | 'local' }): string {
  return machine.policyMode === 'local' ? `Run it on ${machine.name}: it manages its own allow list and asks its local passphrase.` : 'Run it on the admin machine (the one that holds the admin key): it allows the command for every peer.';
}

function waitingRow(w: WaitingRequest, machine: { name: string; policyMode: 'admin' | 'local' }, daemonNow: number, now: number, clockOffset = 0): WaitingRow {
  return {
    id: w.id,
    peerText: w.peerName ?? w.peer.slice(0, 8),
    peer: w.peer,
    shell: w.shell,
    command: w.command,
    secondsLeft: Math.max(0, w.deadline - daemonNow),
    // `clockOffset`: the times of a peer are on ITS clock; the age is shown on this machine's clock.
    askedText: ago(w.since + clockOffset, now),
    countText: 'waiting now',
    nextCommand: allowCommand(w, machine),
    nextWhere: nextWhere(machine),
  };
}

function historyRow(h: HistoryEntry, now: number): HistoryRow {
  return { whenText: ago(h.at, now), peerText: h.peerName ?? (h.peer === undefined ? '-' : h.peer.slice(0, 8)), kind: h.kind, text: describeHistory(h), unverified: !h.verified };
}

function isAnswer(answer: unknown): answer is RequestsAnswerLike {
  const a = typeof answer === 'object' && answer !== null ? (answer as Record<string, unknown>) : undefined;
  return a !== undefined && a['initialized'] === true && a['ok'] === true && typeof a['summary'] === 'object' && a['summary'] !== null && Array.isArray((a['summary'] as { waiting?: unknown }).waiting) && typeof a['self'] === 'object' && a['self'] !== null;
}

type LooseNotice = { [K in keyof NoticeRow | 'peerName' | 'deadline' | 'ts']?: unknown };
const isLooseNotice = (v: unknown): v is LooseNotice => typeof v === 'object' && v !== null && !Array.isArray(v);

function noticeRow(n: unknown, now: number): NoticeRow | undefined {
  if (!isLooseNotice(n)) {
    return undefined;
  }
  const { machine, machineName, receivedAt, id, peer, peerName, shell, command, commandTruncated, state, deadline, ts } = n;
  if (typeof machine !== 'string' || typeof machineName !== 'string' || typeof id !== 'string' || typeof peer !== 'string' || typeof shell !== 'string' || typeof command !== 'string' || typeof commandTruncated !== 'boolean') {
    return undefined;
  }
  if (typeof receivedAt !== 'number' || typeof ts !== 'number' || (state !== 'held' && state !== 'refused')) {
    return undefined;
  }
  if (state === 'held' && typeof deadline !== 'number') {
    return undefined;
  }
  // The hold length is deadline - ts (both the target's clock); the time since it arrived is on this clock: no clock of the target is compared with this one.
  const secondsLeft = state === 'held' ? Math.max(0, (deadline as number) - ts - Math.max(0, now - receivedAt)) : null;
  return { id, machine, machineName, peerText: typeof peerName === 'string' && peerName !== '' ? peerName : peer.slice(0, 8), peer, shell, command, commandTruncated, state, secondsLeft, receivedAt };
}

function noticesOf(answer: RequestsAnswerLike, now: number): { notices: NoticeRow[]; noticesError: string } {
  if (answer.notices === undefined) {
    return { notices: [], noticesError: 'the daemon does not report request notices: it is an older version, update it with `machine cli update` and restart it' };
  }
  if (!Array.isArray(answer.notices)) {
    return { notices: [], noticesError: 'the daemon sent request notices in an unexpected shape: it is probably another version, update it with `machine cli update` and restart it' };
  }
  const rows: NoticeRow[] = [];
  let skipped = 0;
  for (const n of answer.notices) {
    const row = noticeRow(n, now);
    if (row === undefined) {
      skipped += 1;
    } else {
      rows.push(row);
    }
  }
  const messages: string[] = [];
  if (typeof answer.noticesError === 'string' && answer.noticesError !== '') {
    messages.push(answer.noticesError);
  }
  if (skipped > 0) {
    messages.push(`${skipped} request notice${skipped === 1 ? ' is' : 's are'} not shown: not shaped like a notice, the daemon and the module are probably not the same version (\`machine cli update\`).`);
  }
  return { notices: rows, noticesError: messages.join(' ') };
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
  const remote: RemoteCapability = answer.adminKeyHere
    ? { available: true, note: '' }
    : { available: false, note: 'Only the admin machine can ask the other machines for their requests: it holds the admin key that signs the request. Run `machine requests <machine>` there.' };
  let allowNote = '';
  if (answer.policyMode === 'local') {
    allowNote = `${answer.self.name} manages its own allow list (policy mode local): an admin signature would be refused. Run the command shown in each row on ${answer.self.name} (\`machine policy allow\`, it asks the local passphrase).`;
  } else if (!answer.adminKeyHere) {
    allowNote = 'Only the admin machine can allow a command: it holds the admin key. Run the command shown in each row there (`machine admin allow`).';
  }
  return {
    machine: answer.self,
    policyMode: answer.policyMode,
    allow: { available: allowNote === '', machine: answer.self, note: allowNote },
    remote,
    count: summary.waiting.length + summary.pending.length,
    waiting: summary.waiting.map((w) => waitingRow(w, machine, answer.now, nowSeconds)),
    pending: summary.pending.map((g) => pendingRow(g, machine, nowSeconds)),
    pendingTotal: summary.pendingTotal,
    ...noticesOf(answer, nowSeconds),
    history: summary.history.map((h) => historyRow(h, nowSeconds)),
    historyTotal: summary.historyTotal,
    logPresent: answer.logPresent,
    chainOk: chain.ok,
    chainText: chain.ok
      ? ''
      : `The audit log is broken at line ${chain.line}: ${chain.message}. The ${chain.trustedEntries} entries before it are verified; ${chain.unverifiedEntries} after it are shown as unverified and never listed as pending${chain.unreadableLines > 0 ? `; ${chain.unreadableLines} line(s) cannot be read at all` : ''}. Keep a copy of the file for the investigation, then move it away to start a new log (the daemon refuses to start on a broken log).`,
    emptyMessage: answer.logPresent ? 'No request is waiting for approval' : 'No audit log yet: no request ever reached this machine',
    remoteNote: answer.adminKeyHere
      ? 'The requests of the other trusted machines are loaded below: it asks the admin passphrase each time (it signs a read-only request in your browser, nothing is stored and nothing is run).'
      : remote.note,
    notes,
  };
}

export interface RemoteRequestsPage {
  machine: { uuid: string; name: string };
  policyMode: 'admin' | 'local';
  /** Allow from THIS (admin) machine: a signed policy goes to the peer through the relay inbox. Not in mode local: the peer signs its own list. */
  allow: AllowCapability;
  /** The tab indicator and the counts read this. */
  count: number;
  /** Held requests (`run --wait`): the seconds left are the peer's own, at the time of its answer. */
  waiting: WaitingRow[];
  /** What to do to Deny one: there is no Deny button for a request held on another machine (it needs a frame the peers do not have yet). */
  denyNote: string;
  pending: PendingRow[];
  pendingTotal: number;
  chainOk: boolean;
  chainText: string;
  notes: string[];
}

/** The answer of a peer to `requests-list`, as rows. The ages use the clock of THIS machine; the seconds left of a held request use the clock of the peer. */
export function remoteRequestsPage(answer: RequestsListAnswer, nowSeconds: number): RemoteRequestsPage {
  const machine = { name: answer.machine.name, policyMode: answer.policyMode };
  const notes: string[] = [];
  if (answer.truncated || answer.pendingTotal > answer.pending.length) notes.push(`Showing ${answer.pending.length} of ${answer.pendingTotal} pending requests (the newest).`);
  if (answer.allowedNow > 0) notes.push(`${answer.allowedNow} earlier request${answer.allowedNow === 1 ? ' is' : 's are'} allowed now and not listed.`);
  const skew = answer.now - nowSeconds;
  if (Math.abs(skew) > 120) notes.push(`The clock of ${machine.name} differs from this machine by ${Math.abs(skew)} s: the ages use this machine's clock.`);
  const allowNote = answer.policyMode === 'local' ? `${machine.name} manages its own allow list (policy mode local): an admin signature would be refused. Run the command shown in each row on ${machine.name} (\`machine policy allow\`, it asks the local passphrase).` : '';
  return {
    machine: answer.machine,
    policyMode: answer.policyMode,
    allow: { available: allowNote === '', machine: answer.machine, note: allowNote },
    count: answer.waiting.length + answer.pending.length,
    waiting: answer.waiting.map((w) => waitingRow(w, machine, answer.now, nowSeconds, -skew)),
    denyNote: `To deny a held request run \`machine requests --deny <id>\` ON ${machine.name} (the machine that holds it): denying from another machine is not available yet.`,
    pending: answer.pending.map((g) => pendingRow(g, machine, nowSeconds)),
    pendingTotal: answer.pendingTotal,
    chainOk: answer.chain.ok,
    chainText: answer.chain.ok ? '' : `The audit log of ${machine.name} is broken at line ${answer.chain.line}: what follows is not listed. Keep a copy of it on that machine for the investigation.`,
    notes,
  };
}
