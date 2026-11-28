import React, { useRef, useState } from 'react';
import { ButtonAction, DataTable, Markdown, type TableColumn } from '@wadeck-app/dsl-ui';
import { shellAllowApi, type AllowApi } from '../lib/allowFlow.js';
import { RevokeMachineDialog } from './RevokeMachineDialog.js';

/** One row of the Machines list, as the module backend answers it. */
export type MachineTableRow = {
  uuid: string;
  name: string;
  /** This machine: it is never revoked from its own page. */
  self: boolean;
  role: string;
  aliasesText?: string;
  reachable?: string;
  receivesNotices?: string;
  listHeldText?: string;
};

export interface MachinesTableProps {
  /** The machines of the page (`$sources.machines.machines`): this machine and the peers it trusts. */
  rows?: MachineTableRow[];
  emptyMessage?: string;
  /**
   * Re-runs the page's sources, so the list is the daemon's own after a revocation. Defaults to the page's `$refresh`.
   * @ctxDefault $refresh
   */
  onRefresh?: (source?: string) => Promise<void>;
}

// The columns of the page, then one narrow column for the action: a word is never cut (the cells that must not wrap say so). The UUID (36 characters) is in the row details: as a column it made the table scroll sideways.
const EXPANSION = { $type: 'MachineDetails' };
const COLUMNS_BASE: Array<TableColumn<MachineTableRow>> = [
  { key: 'name', label: 'Name', nowrap: true, render: (r) => r.name },
  { key: 'role', label: 'Role', nowrap: true, render: (r) => r.role },
  { key: 'aliasesText', label: 'Aliases', render: (r) => r.aliasesText ?? '' },
  { key: 'reachable', label: 'Reachable', render: (r) => r.reachable ?? '' },
  { key: 'receivesNotices', label: 'Receives notices', nowrap: true, render: (r) => r.receivesNotices ?? '' },
  { key: 'listHeldText', label: 'Notice list held', render: (r) => r.listHeldText ?? '' },
];

/**
 * The Machines page: this machine and the peers it trusts, with Revoke on each trusted peer. Revoke signs IN THE BROWSER with the admin passphrase asked at every
 * revocation (admin-ui.md, "Revoke from the page"); the machine that holds the admin key does the rest.
 *
 * @registryCategory composite
 * @registryTags machines revoke admin
 */
export function MachinesTable({ rows = [], emptyMessage = 'No machine', onRefresh }: MachinesTableProps) {
  const [selected, setSelected] = useState<MachineTableRow | null>(null);
  const api = useRef<AllowApi | null>(null);
  api.current ??= shellAllowApi();

  const columns: Array<TableColumn<MachineTableRow>> = [
    ...COLUMNS_BASE,
    {
      key: '_actions',
      label: '',
      nowrap: true,
      render: (r) => (
        <span className="flex items-center justify-end gap-2">
          {!r.self && <ButtonAction label="Revoke" ariaLabel={`Revoke ${r.name}`} variant="danger-outline" size="xs" onClick={() => setSelected(r)} />}
        </span>
      ),
    },
  ];

  return (
    <>
      <DataTable<MachineTableRow>
        rows={rows}
        columns={columns}
        emptyMessage={emptyMessage}
        expansion={EXPANSION}
        renderNode={(_node, ctx) => <Markdown text={`- uuid: ${(ctx['row'] as MachineTableRow).uuid}`} />}
      />
      {selected !== null && (
        <RevokeMachineDialog
          row={selected}
          api={api.current}
          onClose={() => setSelected(null)}
          onRevoked={() => {
            void onRefresh?.('machines');
          }}
        />
      )}
    </>
  );
}
