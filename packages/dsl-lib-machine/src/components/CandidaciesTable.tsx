import React, { useRef, useState } from 'react';
import { ButtonAction, DataTable, Markdown, type TableColumn } from '@wadeck-app/dsl-ui';
import { shellAllowApi, type AllowApi } from '../lib/allowFlow.js';
import { overlayApproval, type ApprovalProgress } from '../lib/approvalTimeline.js';
import type { ApproveRow } from '../lib/approveFlow.js';
import { TEXT_ERROR } from '../lib/styleTokens.js';
import { ApproveCandidacyDialog } from './ApproveCandidacyDialog.js';
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
   * Runs a named action of the view (here `reject`, with its confirmation and its reload) for a row.
   * @ctxDefault
   */
  onAction?: (action: string, row: CandidacyTableRow) => void;
  /**
   * Re-runs the page's sources, so the list is the relay's own after an approval. Defaults to the page's `$refresh`.
   * @ctxDefault $refresh
   */
  onRefresh?: (source?: string) => Promise<void>;
}

const COLUMNS_BASE: Array<TableColumn<CandidacyTableRow>> = [
  { key: 'name', label: 'Name', render: (r) => r.name },
  { key: 'hostname', label: 'Hostname', render: (r) => r.hostname },
  { key: 'observedIp', label: 'Seen from', nowrap: true, render: (r) => r.observedIp },
  { key: 'ageText', label: 'Age', nowrap: true, render: (r) => r.ageText },
  { key: 'statusText', label: 'Status', render: (r) => r.statusText },
];

// The same rule as the details of the row expansion: never empty, markdown of the module.
const EXPANSION = { $type: 'CandidacyDetails' };

/**
 * The Candidacies page: the timeline of the approval and the table of the candidacies, with Approve and Reject on each pending row. Approve signs IN THE BROWSER
 * with the admin passphrase asked at every approval (admin-ui.md, "Approve from the page"); Reject is the action of the view, as before.
 *
 * @registryCategory composite
 * @registryTags candidacies approve reject admin enrollment
 */
export function CandidaciesTable({ rows = [], timeline, emptyMessage = 'No pending candidacy', onAction, onRefresh }: CandidaciesTableProps) {
  const [selected, setSelected] = useState<CandidacyTableRow | null>(null);
  const [progress, setProgress] = useState<ApprovalProgress | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const latest = useRef<ApprovalProgress | undefined>(undefined);
  const api = useRef<AllowApi | null>(null);
  api.current ??= shellAllowApi();

  const track = (next: ApprovalProgress | undefined) => {
    latest.current = next;
    setProgress(next);
  };
  const close = () => {
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
    onAction('reject', row);
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
          {r.canDecide && <ButtonAction label="Reject" ariaLabel={`Reject ${r.name}`} variant="danger-outline" size="xs" onClick={() => reject(r)} />}
        </span>
      ),
    },
  ];

  const steps = timeline === undefined ? undefined : overlayApproval(timeline, progress);
  return (
    <div className="flex items-start gap-6">
      {steps !== undefined && steps.length > 0 && (
        <div className="shrink-0">
          <VerticalTimeline steps={steps} />
        </div>
      )}
      <div className="min-w-0 flex-1 flex flex-col gap-2">
        {problem !== null && <div role="alert" className={TEXT_ERROR}>{problem}</div>}
        <DataTable<CandidacyTableRow>
          rows={rows}
          columns={columns}
          emptyMessage={emptyMessage}
          expansion={EXPANSION}
          renderNode={(_node, ctx) => <Markdown text={(ctx['row'] as CandidacyTableRow).bindingText} />}
        />
      </div>
      {selected !== null && <ApproveCandidacyDialog row={selected} api={api.current} onClose={close} onProgress={track} />}
    </div>
  );
}
