// Pure part of the batch Allow (inline mode of the Requests page): the selected requests become ONE policy per target machine, signed in a single
// unlock. Grouping only; the entries are put in the policy by machine-webcrypto `nextPolicyBodyMany`.

export interface BatchRow {
  id: string;
  machine: { uuid: string; name: string };
  shell: string;
  command: string;
}

export interface BatchGroup {
  machine: { uuid: string; name: string };
  /** Every selected request of this machine. */
  rows: BatchRow[];
  /** What the policy gets: one entry per distinct shell and text (two requests for the same command are one entry). */
  entries: Array<{ shell: string; command: string }>;
}

/** Groups by target machine (first selected first); entries are unique by shell and text. */
export function groupSelection(rows: BatchRow[]): BatchGroup[] {
  const groups = new Map<string, BatchGroup>();
  for (const r of rows) {
    let group = groups.get(r.machine.uuid);
    if (group === undefined) {
      group = { machine: r.machine, rows: [], entries: [] };
      groups.set(r.machine.uuid, group);
    }
    group.rows.push(r);
    if (!group.entries.some((e) => e.shell === r.shell && e.command === r.command)) {
      group.entries.push({ shell: r.shell, command: r.command });
    }
  }
  return [...groups.values()];
}

/** The label of the sticky bar; `detailed` adds what is signed (shown when the selection spans several machines). */
export function selectionSummary(groups: BatchGroup[], detailed = false): string {
  const count = groups.reduce((n, g) => n + g.rows.length, 0);
  const base = `Allow ${count} selected`;
  return detailed && groups.length > 1 ? `${base} (${groups.length} machines, ${groups.length} policies, one passphrase)` : base;
}
