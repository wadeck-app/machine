import { DataTable, IconButton, type SortDir, type TableColumn } from '@wadeck-app/dsl-ui';
import { Pencil, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { AllowApi } from '../lib/allowFlow.js';
import type { EditAction, EditOutcome } from '../lib/allowedEdit.js';
import { COMMAND_TEXT, MONO_STYLE, TEXT_MUTED_SM } from '../lib/styleTokens.js';
import { AllowedEditDialog } from './AllowedEditDialog.js';
import { AllowedEntryDetails } from './AllowedEntryDetails.js';
import type { AllowedEntryData, AllowedMachineData } from './AllowedList.js';

const TYPED_TAG = 'ml-2 rounded border border-border px-1 text-xs text-muted';
const ALERT = 'rounded border border-danger bg-danger-bg p-2 text-sm text-danger-text';

/** True when the entry shows under the search word (empty: all): its command, shell, list, peer or lifetime contains it. */
export const matches = (needle: string, e: AllowedEntryData): boolean =>
  needle === '' || [e.text, e.shell, e.listLabel, e.peerName, e.lifetimeText].some((field) => field.toLowerCase().includes(needle));

// A module constant: DataTable normalises its columns once per identity of this array.
const COLUMNS: Array<TableColumn<AllowedEntryData>> = [
  {
    key: 'text',
    label: 'Command',
    sortable: true,
    render: (r) => (
      <>
        <span className={COMMAND_TEXT} style={MONO_STYLE}>{r.text}</span>
        {r.typed ? <span className={TYPED_TAG}>typed</span> : null}
      </>
    ),
  },
  { key: 'shell', label: 'Shell', sortable: true, nowrap: true, render: (r) => <span className="text-muted">{r.shell}</span> },
  {
    key: 'lifetimeText',
    label: 'Lifetime',
    nowrap: true,
    render: (r) => <span className={r.limited ? '' : 'text-muted'}>{r.lifetimeText}</span>,
    // The same text is in the details of the row: the tooltip is only a shortcut.
    cellTitle: (r) => (r.limitNote === '' ? undefined : r.limitNote),
  },
  {
    // Sorted on the number (seconds, -1 when unknown: the oldest), shown as the text the backend wrote.
    key: 'lastUsedSort',
    label: 'Last used',
    sortable: true,
    nowrap: true,
    render: (r) => <span className={r.lastUsedAt === null ? 'text-muted' : ''}>{r.lastUsedText}</span>,
    cellTitle: (r, ctx) => (r.lastUsedAt === null ? r.lastUsedNote : (ctx?.dates.exact(r.lastUsedAt * 1000) ?? new Date(r.lastUsedAt * 1000).toISOString())),
  },
];

/** The actions column: icon buttons named with their command (a screen reader hears which row), present only where this machine can sign. */
function actionsColumn(begin: (action: EditAction['kind'], rows: AllowedEntryData[]) => void): TableColumn<AllowedEntryData> {
  return {
    key: '_edit',
    // No header text: like the actions column of the other tables, it hugs the right edge (a header word would set its width). The buttons carry the names.
    label: '',
    nowrap: true,
    // Narrow, like the actions columns of the other tables (DataTable gives a column `width` x 4 px): two icon buttons plus the cell padding, so the column hugs the right edge.
    width: ACTIONS_WIDTH,
    render: (r) => (
      <span className="flex items-center gap-1">
        <IconButton icon={<Pencil className="h-3 w-3" aria-hidden="true" />} aria-label={`Change lifetime of ${r.text}`} size="icon-xs" onClick={() => begin('lifetime', [r])} />
        <IconButton icon={<Trash2 className="h-3 w-3" aria-hidden="true" />} aria-label={`Delete ${r.text}`} size="icon-xs" onClick={() => begin('delete', [r])} />
      </span>
    ),
  };
}

// Neutral on purpose: the danger signals (widening, an empty list) are in the confirmation dialog, not in the table.
const BATCH_ACTIONS: Array<{ label: string; action: string; variant: 'ghost' }> = [
  { label: 'Change lifetime', action: 'lifetime', variant: 'ghost' },
  { label: 'Delete selected', action: 'delete', variant: 'ghost' },
];
const ACTIONS_WIDTH = 14;

export interface AllowedMachineBlockProps {
  machine: AllowedMachineData;
  /** The entries that match the search. */
  rows: AllowedEntryData[];
  needle: string;
  sortCol: string;
  sortDir: SortDir;
  onSortColChange: (col: string) => void;
  onSortDirChange: (dir: SortDir) => void;
  refreshing: boolean;
  /** The signing path (the PIN, the admin key file, the post of the signed policy): the same as the Requests page. */
  api: AllowApi;
  /** Safer mode of the Requests page, read from the browser storage. */
  saferMode: boolean;
  /** A change was signed (or signed and not delivered): the page reads the list again and says what happened. */
  onEdited: (outcome: EditOutcome) => void;
}

/** The body of the tab of one machine: ONE short status line, its problem or empty state, and ONE table. Read-only; every command is text. */
export function AllowedMachineBlock({ machine, rows, needle, sortCol, sortDir, onSortColChange, onSortDirChange, refreshing, api, saferMode, onEdited }: AllowedMachineBlockProps) {
  const total = machine.entries.length;
  const [editing, setEditing] = useState<{ action: EditAction['kind']; rows: AllowedEntryData[] } | null>(null);
  // The columns are a stable array (DataTable normalises them once per identity): the handler is reached through a ref.
  const beginRef = useRef((action: EditAction['kind'], chosen: AllowedEntryData[]) => setEditing({ action, rows: chosen }));
  const canEdit = machine.canEdit && machine.version !== null;
  const columns = useMemo(() => (canEdit ? [...COLUMNS, actionsColumn((a, r) => beginRef.current(a, r))] : COLUMNS), [canEdit]);
  return (
    <section className="flex flex-col gap-2" aria-label={`Allowed on ${machine.name}`}>
      <p className={`${TEXT_MUTED_SM} flex flex-wrap items-baseline gap-x-3`}>
        <span>{machine.sourceText}</span>
        {machine.version !== null ? <span>{`version ${machine.version}`}</span> : null}
        {machine.signedText !== '' ? <span title={machine.signedIso}>{machine.signedText}</span> : null}
      </p>
      {machine.problem !== '' ? <div role="alert" className={ALERT}>{machine.problem}</div> : null}
      {machine.emptyText !== '' ? (
        <p className={TEXT_MUTED_SM}>
          {machine.emptyText}
          {' '}
          Allow a first command with
          {' '}
          <code className={COMMAND_TEXT} style={MONO_STYLE}>{machine.fillCommand}</code>
        </p>
      ) : null}
      {machine.version !== null && total === 0 ? <p className={TEXT_MUTED_SM}>{`Nothing is allowed for ${machine.name}: this policy has no entry, so every command is refused.`}</p> : null}
      {total > 0 ? (
        <>
          <p className={TEXT_MUTED_SM}>
            {canEdit ? (
              'Delete or change the lifetime of a row with its buttons, or select several rows. Add from a terminal: '
            ) : (
              <>
                {/* One line that says why nothing can be changed here, and where to do it. */}
                <span>{machine.editNote}</span>
                {' Add from a terminal: '}
              </>
            )}
            <code className={COMMAND_TEXT} style={MONO_STYLE}>{machine.fillCommand}</code>
            {canEdit ? '.' : '. Open a row for the command that withdraws it.'}
          </p>
          <DataTable<AllowedEntryData>
            id={`allowed-${machine.uuid}`}
            rows={rows}
            columns={columns}
            rowKey="key"
            sortCol={sortCol}
            sortDir={sortDir}
            onSortColChange={onSortColChange}
            onSortDirChange={onSortDirChange}
            refreshing={refreshing}
            expansion={{ $type: 'AllowedEntryDetails' }}
            renderNode={(_node, ctx) => <AllowedEntryDetails row={ctx['row'] as AllowedEntryData} machine={machine} />}
            {...(canEdit
              ? {
                  selectable: true,
                  batchActions: BATCH_ACTIONS,
                  onBatchAction: (action: string, chosen: AllowedEntryData[]) => {
                    // A selected row that left the list (or is hidden by the search) is not acted on: when none is left, say so instead of doing nothing.
                    if (chosen.length === 0) {
                      onEdited({ tone: 'warning', text: 'The selected entries are no longer shown (the list changed, or the search hides them): nothing was changed. Select them again.' });
                      return;
                    }
                    setEditing({ action: action === 'delete' ? 'delete' : 'lifetime', rows: chosen });
                  },
                }
              : {})}
            expandLabel="Show details"
            collapseLabel="Hide details"
            emptyMessage={`No entry matches "${needle}" on ${machine.name}. Clear the search to see all ${total}.`}
          />
        </>
      ) : null}
      {editing !== null && editing.rows.length > 0 ? (
        <AllowedEditDialog
          key={`${editing.action}:${editing.rows.map((r) => r.key).join('|')}`}
          machine={machine}
          rows={editing.rows}
          action={editing.action}
          api={api}
          saferMode={saferMode}
          onClose={() => setEditing(null)}
          onDone={(outcome) => {
            setEditing(null);
            onEdited(outcome);
          }}
        />
      ) : null}
    </section>
  );
}
