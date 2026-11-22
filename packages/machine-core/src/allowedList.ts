import { describeLimits } from './lifetime.js';
import { entryKey, entryText, isTyped, type PolicyBody, type PolicyEntry, type Shell } from './policy.js';

// The allow list of a policy as data: what `machine allowed` prints and the Allowed page of the module shows. Pure, no I/O: the caller says
// which names the peers have and, only on the target machine, how many calls each entry has used.

export interface AllowedEntryView {
  /** Place in its list, from 1 (what `--remove --index` takes). */
  index: number;
  shell: Shell;
  /** The command or template as signed. */
  text: string;
  typed: boolean;
  maxCalls?: number;
  /** Epoch seconds. */
  expiresAt?: number;
  /** Calls already counted: only known on the target machine, absent for a policy signed here for another machine. */
  used?: number;
  /** The lifetime in words (describeLimits). */
  lifetime: string;
}

export interface AllowedListView {
  /** `default`: every trusted peer without a list of its own. `peer`: only that peer (its list replaces the default). */
  scope: 'default' | 'peer';
  peer?: { uuid: string; name: string };
  entries: AllowedEntryView[];
}

function entryView(entry: PolicyEntry, index: number, now: number, used: number | undefined): AllowedEntryView {
  const { maxCalls, expiresAt } = entry.limits ?? {};
  return {
    index,
    shell: entry.shell,
    text: entryText(entry),
    typed: isTyped(entry),
    ...(maxCalls === undefined ? {} : { maxCalls }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(used === undefined || maxCalls === undefined ? {} : { used }),
    lifetime: describeLimits(entry.limits, now, maxCalls === undefined ? undefined : used),
  };
}

export function allowedLists(body: Pick<PolicyBody, 'defaults' | 'peers'>, nameOf: (uuid: string) => string, now: number, counters?: { count(key: string): number }): AllowedListView[] {
  const entriesOf = (scope: string, list: PolicyEntry[]): AllowedEntryView[] =>
    list.map((e, i) => entryView(e, i + 1, now, counters === undefined ? undefined : counters.count(entryKey(scope, e))));
  return [
    { scope: 'default', entries: entriesOf('default', body.defaults) },
    ...Object.entries(body.peers).map(([uuid, list]): AllowedListView => ({ scope: 'peer', peer: { uuid, name: nameOf(uuid) }, entries: entriesOf(uuid, list) })),
  ];
}
