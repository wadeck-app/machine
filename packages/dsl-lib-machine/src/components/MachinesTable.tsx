import React, { useRef, useState } from 'react';
import { ButtonAction, DataTable, Markdown, type TableColumn } from '@wadeck-app/dsl-ui';
import { shellAllowApi, type AllowApi } from '../lib/allowFlow.js';
import type { SourceError } from '../lib/loadFailure.js';
import { splitHeadline } from '../lib/statusHeadline.js';
import { CellText, WrapText } from './CellText.js';
import { SourceFailureNotice } from './SourceFailureNotice.js';
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
  { key: 'reachable', label: 'Reachable', render: (r) => <WrapText text={splitHeadline(r.reachable ?? '').headline} /> },
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
 * The Machines page: this machine and the peers it trusts, with Revoke on each trusted peer. Revoke signs IN THE BROWSER with the admin passphrase asked at every
 * revocation (admin-ui.md, "Revoke from the page"); the machine that holds the admin key does the rest.
 *
 * @registryCategory composite
 * @registryTags machines revoke admin
 */
export function MachinesTable({ rows = [], emptyMessage = 'No machine', sourceErrors, onRefresh }: MachinesTableProps) {
  const [selected, setSelected] = useState<MachineTableRow | null>(null);
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
          {!r.self && <ButtonAction label="Revoke" ariaLabel={`Revoke ${r.name}`} variant="danger-outline" size="xs" onClick={() => setSelected(r)} />}
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
      {selected !== null && (
        <RevokeMachineDialog
          row={selected}
          api={api.current}
          onClose={() => {
            focus.leave(`Revoke ${selected.name}`);
            setSelected(null);
          }}
          onRevoked={() => {
            void onRefresh?.('machines');
          }}
        />
      )}
    </div>
  );
}
