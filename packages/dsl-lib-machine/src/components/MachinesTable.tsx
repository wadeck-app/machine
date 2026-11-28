import React, { useRef, useState } from 'react';
import { ButtonAction, DataTable, Markdown, type TableColumn } from '@wadeck-app/dsl-ui';
import { shellAllowApi, type AllowApi } from '../lib/allowFlow.js';
import type { SourceError } from '../lib/loadFailure.js';
import { splitHeadline } from '../lib/statusHeadline.js';
import { CellText } from './CellText.js';
import { SourceFailureNotice } from './SourceFailureNotice.js';
import { AliasesDialog } from './AliasesDialog.js';
import { RenameMachineDialog } from './RenameMachineDialog.js';
import { RevokeMachineDialog } from './RevokeMachineDialog.js';
import { useFocusReturn } from './useFocusReturn.js';

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
   * The failed sources of the page (`$ctx.$sourceErrors`): a failed load of `machines` is one alert above the table instead of an empty table.
   * @ctxDefault $sourceErrors
   */
  sourceErrors?: Record<string, SourceError>;
  /**
   * Re-runs the page's sources, so the list is the daemon's own after a revocation. Defaults to the page's `$refresh`.
   * @ctxDefault $refresh
   */
  onRefresh?: (source?: string) => Promise<void>;
}

// Four columns, then one narrow column for the action: whatever the text, Revoke stays in view (no sideways scroll, UX review 4). The name and the aliases are one line cut
// at a fixed width (the whole text is the tooltip and in the row details); Reachable is the column that gives way: its short headline wraps at its spaces, never in a word.
// The UUID (36 characters), "Receives notices" and "Notice list held" are in the row details: as columns they made the table scroll sideways.
const EXPANSION = { $type: 'MachineDetails' };
const COLUMNS_BASE: Array<TableColumn<MachineTableRow>> = [
  { key: 'name', label: 'Name', nowrap: true, render: (r) => <CellText text={r.name} width="max-w-40" /> },
  { key: 'role', label: 'Role', nowrap: true, render: (r) => r.role },
  { key: 'aliasesText', label: 'Aliases', nowrap: true, render: (r) => <CellText text={r.aliasesText ?? ''} width="max-w-40" /> },
  // A headline that wraps at its spaces; the daemon's whole sentence is in the row details.
  { key: 'reachable', label: 'Reachable', wrap: 'words', render: (r) => splitHeadline(r.reachable ?? '').headline },
];

// The row details: the whole name and aliases (the cells are cut), the uuid, the whole reachability sentence when the cell shows only its headline, and the notice columns
// that are not in the table (an empty value is not listed).
function detailsText(row: MachineTableRow): string {
  const { detail } = splitHeadline(row.reachable ?? '');
  const lines = [`- name: ${row.name}`, `- uuid: ${row.uuid}`];
  if ((row.aliasesText ?? '') !== '') {
    lines.push(`- aliases: ${row.aliasesText ?? ''}`);
  }
  if (detail !== '') {
    lines.push(`- reachable: ${row.reachable ?? ''}`);
  }
  if ((row.receivesNotices ?? '') !== '') {
    lines.push(`- receives notices: ${row.receivesNotices}`);
  }
  if ((row.listHeldText ?? '') !== '') {
    lines.push(`- notice list held: ${row.listHeldText}`);
  }
  return lines.join('\n');
}

/**
 * The Machines page: this machine and the peers it trusts, with Rename and Revoke on each trusted peer and Aliases (the network aliases) on every row. Each signs IN THE
 * BROWSER with the admin passphrase asked at every action (admin-ui.md, "Revoke from the page", "Rename and aliases from the page"); the machine that holds the admin key
 * does the rest.
 *
 * @registryCategory composite
 * @registryTags machines revoke rename aliases admin
 */
export function MachinesTable({ rows = [], emptyMessage = 'No machine', sourceErrors, onRefresh }: MachinesTableProps) {
  // The action open and the row it started from: one dialog at a time.
  const [selected, setSelected] = useState<{ action: 'revoke' | 'rename' | 'aliases'; row: MachineTableRow } | null>(null);
  // The name a renamed machine has now (set when the daemon trusts it, used when the dialog closes to find its button again).
  const [renamedTo, setRenamedTo] = useState<string | undefined>(undefined);
  const api = useRef<AllowApi | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // The dialog gives the focus back to the Revoke button that opened it (to the list when the row is gone), never to the page body.
  const focus = useFocusReturn(root, rows);
  api.current ??= shellAllowApi();

  const columns: Array<TableColumn<MachineTableRow>> = [
    ...COLUMNS_BASE,
    {
      key: '_actions',
      label: '',
      nowrap: true,
      render: (r) => (
        <span className="flex items-center justify-end gap-2">
          {!r.self && <ButtonAction label="Rename" ariaLabel={`Rename ${r.name}`} variant="neutral" size="xs" onClick={() => setSelected({ action: 'rename', row: r })} />}
          <ButtonAction label="Aliases" ariaLabel={`Aliases ${r.name}`} variant="neutral" size="xs" onClick={() => setSelected({ action: 'aliases', row: r })} />
          {!r.self && <ButtonAction label="Revoke" ariaLabel={`Revoke ${r.name}`} variant="danger-outline" size="xs" onClick={() => setSelected({ action: 'revoke', row: r })} />}
        </span>
      ),
    },
  ];

  const failure = sourceErrors?.['machines'];
  return (
    <div ref={root} tabIndex={-1} data-testid="machines-root" className="focus:outline-none">
      {failure !== undefined && <SourceFailureNotice source="machines" error={failure} onRefresh={onRefresh} />}
      {/* A failed load with nothing to show is the alert above, never the empty message. */}
      {(failure === undefined || rows.length > 0) && (
        <DataTable<MachineTableRow>
          rows={rows}
          columns={columns}
          emptyMessage={emptyMessage}
          expansion={EXPANSION}
          renderNode={(_node, ctx) => <Markdown text={detailsText(ctx['row'] as MachineTableRow)} />}
        />
      )}
      {selected?.action === 'revoke' && (
        <RevokeMachineDialog
          row={selected.row}
          api={api.current}
          onClose={() => {
            focus.leave(`Revoke ${selected.row.name}`);
            setSelected(null);
          }}
          onRevoked={() => {
            void onRefresh?.('machines');
          }}
        />
      )}
      {selected?.action === 'rename' && (
        <RenameMachineDialog
          row={selected.row}
          api={api.current}
          onClose={() => {
            // A rename changes the name of the row's buttons: the focus goes to the one it has now, once the list says it.
            focus.leave(`Rename ${selected.row.name}`, renamedTo === undefined ? undefined : `Rename ${renamedTo}`);
            setRenamedTo(undefined);
            setSelected(null);
          }}
          onRenamed={(newName) => {
            setRenamedTo(newName);
            void onRefresh?.('machines');
          }}
        />
      )}
      {selected?.action === 'aliases' && (
        <AliasesDialog
          row={selected.row}
          api={api.current}
          onClose={() => {
            focus.leave(`Aliases ${selected.row.name}`);
            setSelected(null);
          }}
          onChanged={() => {
            void onRefresh?.('machines');
          }}
        />
      )}
    </div>
  );
}
