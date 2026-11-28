import React, { useRef, useState } from 'react';
import { ButtonAction, Collapsible, DataTable, Markdown, Notice, type TableColumn } from '@wadeck-app/dsl-ui';
import { shellAllowApi, type AllowApi } from '../lib/allowFlow.js';
import { overlayApproval, type ApprovalProgress } from '../lib/approvalTimeline.js';
import type { ApproveRow } from '../lib/approveFlow.js';
import type { SourceError } from '../lib/loadFailure.js';
import { statusHeadlineOf } from '../lib/problemHeadline.js';
import { CellText, WrapText } from './CellText.js';
import { ApproveCandidacyDialog } from './ApproveCandidacyDialog.js';
import { CodeText, CommandNotice } from './CommandNotice.js';
import { SourceFailureNotice } from './SourceFailureNotice.js';
import { RejectCandidacyDialog } from './RejectCandidacyDialog.js';
import { SecurityCodeCompare } from './SecurityCodeCompare.js';
import { useFocusReturn } from './useFocusReturn.js';
import { VerticalTimeline, type TimelineStep } from './VerticalTimeline.js';

/** One row of the Candidacies list, as the module backend answers it. */
export type CandidacyTableRow = ApproveRow & {
  ageText: string;
  statusText: string;
  /** Markdown of the row expansion (never empty). */
  bindingText: string;
  /** The relay can still take a decision (pending, not expired): Reject is offered. */
  canDecide: boolean;
  /** Pending, usable key, random, uuid and code, no problem: Approve is offered. */
  canApprove: boolean;
};

export interface CandidaciesTableProps {
  /** The candidacies of the page (`$sources.candidacies.candidacies`). */
  rows?: CandidacyTableRow[];
  /** The steps the module computed from the relay data (`$sources.candidacies.timeline`); this page lays what it proves over them while it approves. Absent: no timeline. */
  timeline?: TimelineStep[];
  emptyMessage?: string;
  /**
   * The failed sources of the page (`$ctx.$sourceErrors`): a failed load of `candidacies` is one alert above the table instead of an empty table that reads as "nothing pending".
   * @ctxDefault $sourceErrors
   */
  sourceErrors?: Record<string, SourceError>;
  /**
   * The security codes the module kept after the approvals made from this page (`$sources.candidacies.approvals`): the relay purges the candidacy random once approved,
   * so the code cannot be recomputed later. Public values, shown again until the candidate had time to confirm on its own machine.
   */
  approvals?: Array<{ uuid: string; name: string; code: string; ageText: string }>;
  /** Why the module could not read the kept codes (`$sources.candidacies.approvalsProblem`, the fix included). Empty: no problem. */
  approvalsProblem?: string;
  /**
   * Runs a named action of the view (here `reject`, with its confirmation and its reload) for a row.
   * @ctxDefault
   */
  onAction?: (action: string, row: CandidacyTableRow, options?: { body?: unknown }) => void;
  /**
   * Re-runs the page's sources, so the list is the relay's own after an approval. Defaults to the page's `$refresh`.
   * @ctxDefault $refresh
   */
  onRefresh?: (source?: string) => Promise<void>;
}

// What the page says when nothing is pending: the next step, not only the absence.
export const NO_CANDIDACY = 'No pending candidacy. Run `machine join` on the new machine to enroll it.';

// Four columns that fit at 1024 px, whatever the text (UX review 4): the name is one line cut at a fixed width (the whole name is its tooltip and the first line of the row
// expansion), the age and the buttons never wrap, the status is the column that gives way: a short headline that WRAPS at its spaces and never inside a word, so the buttons
// stay in view next to the timeline. The hostname and the address are in the row expansion, and the rest of a long status (the problems of the candidacy) too.
const COLUMNS_BASE: Array<TableColumn<CandidacyTableRow>> = [
  { key: 'name', label: 'Name', nowrap: true, render: (r) => <CellText text={r.name} width="max-w-32" /> },
  { key: 'ageText', label: 'Age', nowrap: true, render: (r) => r.ageText },
  { key: 'statusText', label: 'Status', render: (r) => <WrapText text={statusHeadlineOf(r)} /> },
];

// The same rule as the details of the row expansion: never empty, markdown of the module.
const EXPANSION = { $type: 'CandidacyDetails' };

// Why an expired candidacy has no Reject: the relay drops a candidacy when it expires and answers 404 to a decision on it (poc-node lib/machines/store.js, getCandidacy), so
// there is nothing to reject; the candidate posts a new one.
const NOTHING_TO_REJECT = '- Nothing to reject: the relay drops an expired candidacy and refuses a decision on it. The candidate runs `machine join --resume` to post a new one.';

// The row expansion: the whole name (the cell cuts it), the status sentence when the cell shows only its headline, then the details of the module.
function expansionText(row: CandidacyTableRow): string {
  const lines = [`- name: ${row.name}`];
  if (statusHeadlineOf(row) !== row.statusText) {
    lines.push(`- status: ${row.statusText}`);
  }
  if (!row.canDecide && row.problems.some((p) => /is expired/.test(p))) {
    lines.push(NOTHING_TO_REJECT);
  }
  return `${lines.join('\n')}\n${row.bindingText}`;
}

/**
 * The Candidacies page: the timeline of the approval and the table of the candidacies, with Approve and Reject on each pending row. Approve signs IN THE BROWSER
 * with the admin passphrase asked at every approval (admin-ui.md, "Approve from the page"); Reject is the action of the view, as before.
 *
 * @registryCategory composite
 * @registryTags candidacies approve reject admin enrollment
 */
export function CandidaciesTable({ rows = [], timeline, emptyMessage = NO_CANDIDACY, sourceErrors, approvals = [], approvalsProblem = '', onAction, onRefresh }: CandidaciesTableProps) {
  const [selected, setSelected] = useState<CandidacyTableRow | null>(null);
  const [progress, setProgress] = useState<ApprovalProgress | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  // The candidacy whose rejection waits for the person's confirmation (a dialog that names it).
  const [rejecting, setRejecting] = useState<CandidacyTableRow | null>(null);
  const latest = useRef<ApprovalProgress | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);
  // A dialog gives the focus back to the button that opened it (to the list when the row is gone), never to the page body.
  const focus = useFocusReturn(root, rows);
  const api = useRef<AllowApi | null>(null);
  api.current ??= shellAllowApi();

  const track = (next: ApprovalProgress | undefined) => {
    latest.current = next;
    setProgress(next);
  };
  const close = () => {
    if (selected !== null) {
      focus.leave(`Approve ${selected.name}`);
    }
    setSelected(null);
    // The relay holds the approval: the list catches up (the candidacy leaves the pending ones). A failure is reported by the page's notifier.
    if (latest.current?.approved === true) {
      void onRefresh?.('candidacies');
    }
  };
  const reject = (row: CandidacyTableRow) => {
    if (onAction === undefined) {
      setProblem('Reject is not wired to this page: the module and the page are not the same version. Update the machine module (`app-core-cli update`), reload the page, or run `machine admin approve --reject` in a terminal.');
      return;
    }
    setProblem(null);
    // The name goes with the request: the route words its answer (the toast) with it instead of the id of the candidacy. It decides nothing.
    onAction('reject', row, { body: { name: row.name } });
  };

  const columns: Array<TableColumn<CandidacyTableRow>> = [
    ...COLUMNS_BASE,
    {
      key: '_actions',
      label: '',
      nowrap: true,
      render: (r) => (
        <span className="flex items-center justify-end gap-2">
          {r.canApprove && <ButtonAction label="Approve" ariaLabel={`Approve ${r.name}`} variant="primary" size="xs" onClick={() => { setProblem(null); track(undefined); setSelected(r); }} />}
          {r.canDecide && <ButtonAction label="Reject" ariaLabel={`Reject ${r.name}`} variant="danger-outline" size="xs" onClick={() => setRejecting(r)} />}
        </span>
      ),
    },
  ];

  const failure = sourceErrors?.['candidacies'];
  // No candidacy: five steps to do that follow nobody say nothing. The timeline appears with the candidacy it follows.
  const steps = timeline === undefined || rows.length === 0 ? undefined : overlayApproval(timeline, progress);
  return (
    <div ref={root} tabIndex={-1} data-testid="candidacies-root" className="flex items-start gap-4 focus:outline-none">
      {steps !== undefined && steps.length > 0 && (
        <div className="w-44 shrink-0 xl:w-52">
          <VerticalTimeline steps={steps} />
        </div>
      )}
      <div className="min-w-0 flex-1 flex flex-col gap-2">
        {problem !== null && <CommandNotice variant="danger" label={problem} />}
        {failure !== undefined && <SourceFailureNotice source="candidacies" error={failure} onRefresh={onRefresh} />}
        {/* A failed load with nothing to show is the alert above, never the empty message (it would say "nothing pending"). */}
        {/* Nothing pending: a padded block that says it and names the next step (an empty table header says nothing, and its message is plain text: no command in monospace). */}
        {failure === undefined && rows.length === 0 && (
          <div data-testid="empty-candidacies" className="rounded border border-border px-4 py-10 text-center text-sm text-content">
            <CodeText text={emptyMessage} />
          </div>
        )}
        {rows.length > 0 && (
          <DataTable<CandidacyTableRow>
            rows={rows}
            columns={columns}
            emptyMessage={emptyMessage}
            expansion={EXPANSION}
            renderNode={(_node, ctx) => <Markdown text={expansionText(ctx['row'] as CandidacyTableRow)} />}
          />
        )}
        {approvalsProblem !== '' && <Notice variant="warning" label={approvalsProblem} />}
        {approvals.length > 0 && (
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium text-content">Security codes of recent approvals</h3>
            {approvals.map((a) => (
              <Collapsible key={a.uuid} title={`Show security code: ${a.name} (approved ${a.ageText} ago)`}>
                <SecurityCodeCompare code={a.code} name={a.name} />
              </Collapsible>
            ))}
          </div>
        )}
      </div>
      {rejecting !== null && (
        <RejectCandidacyDialog
          name={rejecting.name}
          onCancel={() => {
            focus.leave(`Reject ${rejecting.name}`);
            setRejecting(null);
          }}
          onConfirm={() => {
            const row = rejecting;
            focus.leave(`Reject ${row.name}`);
            setRejecting(null);
            reject(row);
          }}
        />
      )}
      {selected !== null && <ApproveCandidacyDialog row={selected} api={api.current} onClose={close} onProgress={track} {...(steps === undefined ? {} : { steps })} />}
    </div>
  );
}
