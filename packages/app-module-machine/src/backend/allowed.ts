import { ageText } from './candidacies.js';

// The Allowed page: what every machine allows, read-only. The data is the answer of the daemon command `allowed` (the readers of
// `machine allowed <machine>`); this file keeps ONLY the fields the page shows (a field of the answer that is not listed here never reaches
// the browser: no signature, no key) and turns them into text. Entry text is data: the component renders it as text, never as HTML.

/** The daemon answered something that is not the `allowed` command of this version. */
export class AllowedAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllowedAnswerError';
  }
}

export interface AllowedEntryRow {
  /** Unique inside its machine and stable across two reads: the IDENTITY of the entry (its list, shell and text), never its place. A selection on the page is kept by it. */
  key: string;
  /** Short name of the list the entry belongs to: `default` or `only for <peer>`. */
  listLabel: string;
  /** The list in words (what it covers and that a per-peer list replaces the default). */
  listTitle: string;
  /** The name of the peer the list is for; empty for the default list. */
  peerName: string;
  /** The uuid of that peer (what a signed edit names); empty for the default list. */
  peerUuid: string;
  /** Place in its list, from 1. */
  index: number;
  shell: string;
  text: string;
  typed: boolean;
  lifetimeText: string;
  /** True when the entry has a call count or an end date. */
  limited: boolean;
  /** The limits as signed (null: none): what a change of lifetime compares with. */
  maxCalls: number | null;
  expiresAt: number | null;
  /** Why a value is not shown (the calls left of a list signed here), empty when there is nothing to say. */
  limitNote: string;
  /** Epoch seconds of the last accepted use, null when it is not known (see lastUsedText). */
  lastUsedAt: number | null;
  /** The sort key of the last use: its seconds, or -1 when unknown (sorts as the oldest). */
  lastUsedSort: number;
  /** Age text of the last use, or why there is none ("never", "not known here", "not read", "not in the last N lines"). */
  lastUsedText: string;
  /** The reason behind lastUsedText when it is not a date; empty for a date. */
  lastUsedNote: string;
  /** The terminal command that withdraws this entry today; empty when none is known. */
  removeCommand: string;
}

export interface AllowedMachineRow {
  uuid: string;
  name: string;
  isSelf: boolean;
  source: 'installed' | 'signed-here';
  /** One short line: where the list comes from. */
  sourceText: string;
  mode: 'admin' | 'local';
  version: number | null;
  signedText: string;
  signedIso: string;
  /** Every entry of every list of the machine, one row each. */
  entries: AllowedEntryRow[];
  /** The line that says the list may differ from what is installed there (same wording as `machine allowed`); empty for an installed list. */
  deliveryNote: string;
  /** A record that could not be read, with its file and the fix. */
  problem: string;
  /** Why there is no list, with what to do; empty when there is a list or a problem. */
  emptyText: string;
  fillCommand: string;
  /** This machine can sign a change of this list: the page offers delete and change of lifetime. */
  canEdit: boolean;
  /** Why not, with the terminal command, when the list has entries and cannot be changed here. */
  editNote: string;
}

export interface AllowedPage {
  machine: { uuid: string; name: string };
  entryCount: number;
  machineCount: number;
  machines: AllowedMachineRow[];
  warnings: string[];
}

const OLDER_FOR_EDIT = 'the daemon is older than this page and does not say whether this machine can sign a change of this list, so no action is offered: update it with `machine cli update` and restart it';
const OLDER = 'the daemon answered something that is not the `allowed` command of this version: it is an older version, update it with `machine cli update` and restart it';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

interface MachineContext {
  name: string;
  source: 'installed' | 'signed-here';
  mode: 'admin' | 'local';
  fillCommand: string;
  lastUse: { scanned: number; damaged: number; complete: boolean } | undefined;
  now: number;
}

function lastUseOf(at: number | undefined, m: MachineContext): Pick<AllowedEntryRow, 'lastUsedAt' | 'lastUsedSort' | 'lastUsedText' | 'lastUsedNote'> {
  if (at !== undefined) {
    return { lastUsedAt: at, lastUsedSort: at, lastUsedText: m.now - at < 5 ? 'just now' : `${ageText(m.now - at)} ago`, lastUsedNote: '' };
  }
  const unknown = (lastUsedText: string, lastUsedNote: string) => ({ lastUsedAt: null, lastUsedSort: -1, lastUsedText, lastUsedNote });
  // The audit log of a machine is on that machine: for a list signed here nothing is known, and the page says so rather than show a date it does not have.
  if (m.source === 'signed-here') {
    return unknown('not known here', `The audit log that records the uses is on ${m.name}: only that machine knows when this command last ran.`);
  }
  if (m.lastUse === undefined) {
    return unknown('not read', 'The daemon gave no reading of the audit log of this machine: either it could not be read (see the warnings at the top of the page) or the daemon is older than this page (update it with `machine cli update` and restart it).');
  }
  const damaged = m.lastUse.damaged > 0 ? ` ${m.lastUse.damaged} damaged line(s) were skipped.` : '';
  if (!m.lastUse.complete) {
    return unknown(`not in the last ${m.lastUse.scanned} lines`, `No accepted use in the last ${m.lastUse.scanned} lines of the audit log of this machine; older uses are not read.${damaged}`);
  }
  return unknown('never', `No accepted use in the audit log of this machine (${plural(m.lastUse.scanned, 'line', 'lines')} read).${damaged}`);
}

/** The terminal command that withdraws the entry today (the page itself does not edit). Empty when no command is known for it. */
function removeCommandOf(m: MachineContext, peerName: string, index: number): string {
  if (m.mode === 'local' && m.source === 'installed') {
    return `machine policy allow${peerName === '' ? '' : ` --peer ${peerName}`} --remove --index ${index}`;
  }
  // `machine admin allow` edits the default list only: a per-peer list of an admin policy has no command of that kind.
  return peerName === '' ? `${m.fillCommand.replace(/ -- <command>$/, '')} --remove --index ${index}` : '';
}

/** The identity key of an entry: its list (default, or the uuid of the peer), shell and text; a repeat inside the machine gets `#2`, `#3`. */
function identityKey(seen: Map<string, number>, list: { peerUuid: string }, shell: string, text: string): string {
  const base = `${list.peerUuid === '' ? 'default' : list.peerUuid}|${shell}|${text}`;
  const n = (seen.get(base) ?? 0) + 1;
  seen.set(base, n);
  return n === 1 ? base : `${base}#${n}`;
}

function entryRow(raw: unknown, seen: Map<string, number>, list: { label: string; title: string; peerName: string; peerUuid: string }, m: MachineContext): AllowedEntryRow {
  if (!isObject(raw)) {
    throw new AllowedAnswerError(OLDER);
  }
  const maxCalls = num(raw['maxCalls']);
  const expiresAt = num(raw['expiresAt']);
  const used = num(raw['used']);
  const index = num(raw['index']) ?? 0;
  return {
    key: identityKey(seen, list, text(raw['shell']), text(raw['text'])),
    listLabel: list.label,
    listTitle: list.title,
    peerName: list.peerName,
    peerUuid: list.peerUuid,
    index,
    shell: text(raw['shell']),
    text: text(raw['text']),
    typed: raw['typed'] === true,
    lifetimeText: text(raw['lifetime'], 'permanent'),
    limited: maxCalls !== undefined || expiresAt !== undefined,
    maxCalls: maxCalls ?? null,
    expiresAt: expiresAt ?? null,
    // The counter of an entry lives on the target: for a list signed here the calls left are not known, and the page says so rather than guess.
    limitNote: maxCalls !== undefined && used === undefined && m.source === 'signed-here' ? `calls left: not shown, the counter is kept on ${m.name}` : '',
    ...lastUseOf(num(raw['lastUsedAt']), m),
    removeCommand: removeCommandOf(m, list.peerName, index),
  };
}

function listEntries(raw: unknown, m: MachineContext, seen: Map<string, number>): AllowedEntryRow[] {
  if (!isObject(raw) || !Array.isArray(raw['entries'])) {
    throw new AllowedAnswerError(OLDER);
  }
  const peer = isObject(raw['peer']) ? text(raw['peer']['name']) : '';
  const isPeer = raw['scope'] === 'peer';
  const list = {
    label: isPeer ? `only for ${peer}` : 'default',
    title: isPeer ? `Only for ${peer} (its own list, it replaces the default)` : 'Default list (every trusted peer without a list of its own)',
    peerName: isPeer ? peer : '',
    peerUuid: isPeer && isObject(raw['peer']) ? text(raw['peer']['uuid']) : '',
  };
  return raw['entries'].map((e) => entryRow(e, seen, list, m));
}

function machineRow(raw: unknown, now: number): AllowedMachineRow {
  if (!isObject(raw)) {
    throw new AllowedAnswerError(OLDER);
  }
  const name = text(raw['name']);
  const isSelf = raw['isSelf'] === true;
  const source = raw['source'] === 'installed' ? 'installed' : 'signed-here';
  const mode = raw['mode'] === 'local' ? 'local' : 'admin';
  const policy = isObject(raw['policy']) ? raw['policy'] : undefined;
  const issuedAt = policy === undefined ? undefined : num(policy['issuedAt']);
  const problem = text(raw['problem']);
  const fillCommand = text(raw['fillCommand']);
  const scan = isObject(raw['lastUse']) ? raw['lastUse'] : undefined;
  const lastUse = scan === undefined ? undefined : { scanned: num(scan['scanned']) ?? 0, damaged: num(scan['damaged']) ?? 0, complete: scan['complete'] === true };
  const context: MachineContext = { name, source, mode, fillCommand, lastUse, now };
  const seen = new Map<string, number>();
  const entries = policy !== undefined && Array.isArray(policy['lists']) ? policy['lists'].flatMap((l) => listEntries(l, context, seen)) : [];
  let emptyText = '';
  if (policy === undefined && problem === '') {
    emptyText = source === 'installed'
      ? `Nothing is allowed on this machine "${name}" (mode ${mode}): no policy is installed, so every command is refused.`
      : `No policy was signed on this machine for "${name}": nothing is known here about what it allows (only policies signed on this machine are on record).`;
  }
  return {
    uuid: text(raw['uuid']),
    name,
    isSelf,
    source,
    sourceText: source === 'installed' ? `In force on this machine (mode ${mode})` : `Signed here, may differ from what ${name} has installed until it is delivered`,
    mode,
    version: policy === undefined ? null : (num(policy['version']) ?? null),
    signedText: issuedAt === undefined ? '' : `signed ${now - issuedAt < 5 ? 'now' : `${ageText(now - issuedAt)} ago`}`,
    signedIso: issuedAt === undefined ? '' : new Date(issuedAt * 1000).toISOString(),
    entries,
    deliveryNote: source === 'signed-here' && policy !== undefined ? text(raw['remoteViewLine']) : '',
    problem,
    emptyText,
    fillCommand,
    // A daemon that does not say is an OLDER one: said with the fix, never a silent read-only page.
    canEdit: raw['canEdit'] === true,
    editNote: typeof raw['canEdit'] === 'boolean' ? text(raw['editNote']) : entries.length > 0 ? OLDER_FOR_EDIT : '',
  };
}

/** The page for an answer of the daemon command `allowed`. Any other answer is an error that names the fix, never an empty page. */
export function allowedPage(answer: unknown, now: number): AllowedPage {
  if (!isObject(answer) || answer['ok'] !== true || !isObject(answer['self']) || !Array.isArray(answer['machines'])) {
    throw new AllowedAnswerError(OLDER);
  }
  const machines = answer['machines'].map((m) => machineRow(m, now));
  const holding = machines.filter((m) => m.version !== null);
  return {
    machine: { uuid: text(answer['self']['uuid']), name: text(answer['self']['name']) },
    entryCount: holding.reduce((n, m) => n + m.entries.length, 0),
    machineCount: holding.length,
    machines,
    warnings: Array.isArray(answer['warnings']) ? answer['warnings'].filter((w): w is string => typeof w === 'string') : [],
  };
}
