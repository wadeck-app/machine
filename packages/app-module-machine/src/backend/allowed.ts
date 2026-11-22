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
  key: string;
  index: number;
  shell: string;
  text: string;
  typed: boolean;
  lifetimeText: string;
  /** True when the entry has a call count or an end date. */
  limited: boolean;
  /** Why a value is not shown (the calls left of a list signed here), empty when there is nothing to say. */
  limitNote: string;
}

export interface AllowedListRow {
  key: string;
  title: string;
  /** The name of the peer the list is for; empty for the default list. */
  peerName: string;
  entries: AllowedEntryRow[];
}

export interface AllowedMachineRow {
  uuid: string;
  name: string;
  isSelf: boolean;
  source: 'installed' | 'signed-here';
  sourceText: string;
  mode: 'admin' | 'local';
  version: number | null;
  signedText: string;
  signedIso: string;
  lists: AllowedListRow[];
  /** The line that says the list may differ from what is installed there (same wording as `machine allowed`); empty for an installed list. */
  deliveryNote: string;
  /** A record that could not be read, with its file and the fix. */
  problem: string;
  /** Why there is no list, with what to do; empty when there is a list or a problem. */
  emptyText: string;
  fillCommand: string;
}

export interface AllowedPage {
  machine: { uuid: string; name: string };
  entryCount: number;
  machineCount: number;
  summary: string;
  machines: AllowedMachineRow[];
  warnings: string[];
  changeNote: string;
}

export const CHANGE_NOTE = 'Read-only. To change a list today: `machine admin allow <machine> -- <command>` on the admin machine, `machine policy allow -- <command>` on a machine that manages its own list, or the Requests page for a request that is held.';

const OLDER = 'the daemon answered something that is not the `allowed` command of this version: it is an older version, update it with `machine cli update` and restart it';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function entryRow(raw: unknown, key: string, machine: { name: string; source: string }): AllowedEntryRow {
  if (!isObject(raw)) {
    throw new AllowedAnswerError(OLDER);
  }
  const maxCalls = num(raw['maxCalls']);
  const expiresAt = num(raw['expiresAt']);
  const used = num(raw['used']);
  const limited = maxCalls !== undefined || expiresAt !== undefined;
  return {
    key,
    index: num(raw['index']) ?? 0,
    shell: text(raw['shell']),
    text: text(raw['text']),
    typed: raw['typed'] === true,
    lifetimeText: text(raw['lifetime'], 'permanent'),
    limited,
    // The counter of an entry lives on the target: for a list signed here the calls left are not known, and the page says so rather than guess.
    limitNote: maxCalls !== undefined && used === undefined && machine.source === 'signed-here' ? `calls left: not shown, the counter is kept on ${machine.name}` : '',
  };
}

function listRow(raw: unknown, machine: { name: string; source: string }, at: number): AllowedListRow {
  if (!isObject(raw) || !Array.isArray(raw['entries'])) {
    throw new AllowedAnswerError(OLDER);
  }
  const peer = isObject(raw['peer']) ? text(raw['peer']['name']) : '';
  const isPeer = raw['scope'] === 'peer';
  return {
    key: isPeer ? `peer:${text(isObject(raw['peer']) ? raw['peer']['uuid'] : undefined, String(at))}` : 'default',
    title: isPeer ? `Only for ${peer} (its own list, it replaces the default)` : 'Default list (every trusted peer without a list of its own)',
    peerName: isPeer ? peer : '',
    entries: raw['entries'].map((e, i) => entryRow(e, `${at}:${i}`, machine)),
  };
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
  const lists = policy !== undefined && Array.isArray(policy['lists']) ? policy['lists'].map((l, i) => listRow(l, { name, source }, i)) : [];
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
    sourceText: source === 'installed'
      ? `installed on this machine, in force now (mode ${mode})`
      : `signed here by the admin: may differ from what is installed on ${name} until it is delivered`,
    mode,
    version: policy === undefined ? null : (num(policy['version']) ?? null),
    signedText: issuedAt === undefined ? '' : `signed ${now - issuedAt < 5 ? 'now' : `${ageText(now - issuedAt)} ago`}`,
    signedIso: issuedAt === undefined ? '' : new Date(issuedAt * 1000).toISOString(),
    lists,
    deliveryNote: source === 'signed-here' && policy !== undefined ? text(raw['remoteViewLine']) : '',
    problem,
    emptyText,
    fillCommand: text(raw['fillCommand']),
  };
}

/** The page for an answer of the daemon command `allowed`. Any other answer is an error that names the fix, never an empty page. */
export function allowedPage(answer: unknown, now: number): AllowedPage {
  if (!isObject(answer) || answer['ok'] !== true || !isObject(answer['self']) || !Array.isArray(answer['machines'])) {
    throw new AllowedAnswerError(OLDER);
  }
  const machines = answer['machines'].map((m) => machineRow(m, now));
  const holding = machines.filter((m) => m.version !== null);
  const entryCount = holding.reduce((n, m) => n + m.lists.reduce((k, l) => k + l.entries.length, 0), 0);
  return {
    machine: { uuid: text(answer['self']['uuid']), name: text(answer['self']['name']) },
    entryCount,
    machineCount: holding.length,
    summary: `${plural(entryCount, 'entry', 'entries')} on ${plural(holding.length, 'machine', 'machines')}`,
    machines,
    warnings: Array.isArray(answer['warnings']) ? answer['warnings'].filter((w): w is string => typeof w === 'string') : [],
    changeNote: CHANGE_NOTE,
  };
}
