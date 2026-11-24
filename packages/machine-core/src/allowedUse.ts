import { parseAuditLine, atMsOf } from './activity.js';
import type { AllowedListView } from './allowedList.js';

// The last accepted use of each entry of the policy INSTALLED on this machine, from the lines of its audit log (newest first). Pure, no I/O.
// The audit line `accepted` records the peer (source), the shell, the command and, for a typed entry, the template that matched: it does NOT
// record the place of the entry, so an entry is found by (list, shell, command or template). A use is attributed to the entry as it is today:
// a command allowed by an older policy and still allowed now counts.

/** Key of an entry in the result: `default:<index>` or `peer:<uuid>:<index>`. */
export const useKey = (list: AllowedListView, index: number): string => `${list.scope === 'peer' ? `peer:${list.peer?.uuid ?? ''}` : 'default'}:${index}`;

export interface LastUses {
  /** Epoch seconds of the newest accepted use, by `useKey`. An entry without a key was not used in the lines read. */
  at: Map<string, number>;
  /** Lines read (damaged ones included). */
  scanned: number;
  damaged: number;
  /** False when the bound stopped the scan before the start of the log while some entry had no use yet. */
  complete: boolean;
}

export function lastAcceptedUses(linesNewestFirst: Iterable<string>, lists: readonly AllowedListView[], maxLines: number): LastUses {
  const total = lists.reduce((n, l) => n + l.entries.length, 0);
  const at = new Map<string, number>();
  let scanned = 0;
  let damaged = 0;
  let exhausted = true;
  if (total === 0) {
    return { at, scanned, damaged, complete: true };
  }
  for (const line of linesNewestFirst) {
    if (scanned >= maxLines) {
      exhausted = false;
      break;
    }
    scanned += 1;
    const parsed = parseAuditLine(line);
    if (parsed === undefined) {
      damaged += 1;
      continue;
    }
    const { entry } = parsed;
    const ms = atMsOf(entry);
    if (entry['event'] !== 'accepted' || Number.isNaN(ms) || typeof entry['shell'] !== 'string') {
      continue;
    }
    const source = entry['source'];
    const own = lists.find((l) => l.scope === 'peer' && l.peer?.uuid === source);
    const list = own ?? lists.find((l) => l.scope === 'default');
    if (list === undefined) {
      continue;
    }
    const template = typeof entry['template'] === 'string' ? entry['template'] : undefined;
    const command = typeof entry['command'] === 'string' ? entry['command'] : undefined;
    for (const e of list.entries) {
      const same = e.typed ? template !== undefined && e.text === template : template === undefined && command !== undefined && e.text === command;
      const key = useKey(list, e.index);
      if (same && e.shell === entry['shell'] && !at.has(key)) {
        at.set(key, ms / 1000);
      }
    }
    if (at.size === total) {
      return { at, scanned, damaged, complete: true };
    }
  }
  return { at, scanned, damaged, complete: exhausted };
}
