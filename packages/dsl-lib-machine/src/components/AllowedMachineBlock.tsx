import { DataTable, type SortDir, type TableColumn } from '@wadeck-app/dsl-ui';
import { COMMAND_TEXT, MONO_STYLE, TEXT_MUTED_SM } from '../lib/styleTokens.js';
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
}

/** The body of the tab of one machine: ONE short status line, its problem or empty state, and ONE table. Read-only; every command is text. */
export function AllowedMachineBlock({ machine, rows, needle, sortCol, sortDir, onSortColChange, onSortDirChange, refreshing }: AllowedMachineBlockProps) {
  const total = machine.entries.length;
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
            {'Read-only. Add from a terminal: '}
            <code className={COMMAND_TEXT} style={MONO_STYLE}>{machine.fillCommand}</code>
            {'. Open a row for the command that withdraws it.'}
          </p>
          <DataTable<AllowedEntryData>
            id={`allowed-${machine.uuid}`}
            rows={rows}
            columns={COLUMNS}
            rowKey="key"
            sortCol={sortCol}
            sortDir={sortDir}
            onSortColChange={onSortColChange}
            onSortDirChange={onSortDirChange}
            refreshing={refreshing}
            expansion={{ $type: 'AllowedEntryDetails' }}
            renderNode={(_node, ctx) => <AllowedEntryDetails row={ctx['row'] as AllowedEntryData} machine={machine} />}
            expandLabel="Show details"
            collapseLabel="Hide details"
            emptyMessage={`No entry matches "${needle}" on ${machine.name}. Clear the search to see all ${total}.`}
          />
        </>
      ) : null}
    </section>
  );
}
