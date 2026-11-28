import React, { useRef, useState } from 'react';
import { ButtonAction, DataTable, HorizontalStack, Notice, type TableColumn } from '@wadeck-app/dsl-ui';
import { deliveryNotice, noticeRecipientsText, shellAllowApi, type AllowApi, type AllowResult } from '../lib/allowFlow.js';
import { dismissFailureMessage, dismissNotice } from '../lib/dismissNotice.js';
import { MachineName } from './MachineName.js';
import { AllowDialog } from './AllowDialog.js';
import type { WaitingRenewal } from '@wadeck-app/machine-core';
import type { CallerAsk } from '../lib/callerAsk.js';
import { MONO_STYLE } from '../lib/styleTokens.js';

export type PendingRequestRow = {
  peerText: string;
  peer: string;
  shell: string;
  command: string;
  countText: string;
  firstSeenText: string;
  lastSeenText: string;
  /** The `machine admin allow ...` command that does the same from a terminal. */
  nextCommand: string;
  nextWhere: string;
  /** Whether Allow is offered for this row. Default: `allow.available`. */
  canAllow?: boolean;
  /** Present: this row is a NOTICE another machine reported (not verified live); the text says by whom and when. */
  note?: string;
  /** The notice carries only the first part of the command. */
  commandTruncated?: boolean;
  /** A notice row only (decision 100): what Dismiss names, the machine that reported it and the request id. Present: the row has a Dismiss button. */
  notice?: { machine: string; id: string };
  /** The request waits for the renewal of an exhausted or expired entry: the Allow replaces that entry. */
  renewal?: WaitingRenewal;
  /** What the caller asked the owner for (a held request only): pre-fills the lifetime of the Allow, never applied by itself. */
  ask?: CallerAsk;
};

export interface AllowRequestsTableProps {
  /** The pending requests of the Requests page (`$sources.requests.pending`). */
  rows?: PendingRequestRow[];
  /** Whether Allow is offered here and for which machine (`$sources.requests.allow`): the admin machine, in policy mode admin. */
  allow?: { available: boolean; machine: { uuid: string; name: string }; note: string };
  emptyMessage?: string;
  /**
   * Re-runs the page's sources, so the list is the daemon's own after an allow. Defaults to the page's `$refresh`.
   * @ctxDefault $refresh
   */
  onRefresh?: (source?: string) => Promise<void>;
}

type PendingRow = PendingRequestRow & { rowId: string };

const rowKey = (r: PendingRequestRow): string => `${r.peer}\u0000${r.shell}\u0000${r.command}`;

/**
 * The "Waiting for approval" table of the Requests page, with an Allow button on each row: it does what `machine admin allow <machine> --shell <s> -- <command>`
 * does, but the admin passphrase and the unlocked key exist ONLY in this page (decision 76). A confirmation names the machine, the shell and the exact command,
 * asks the passphrase, signs the next policy here (machine-webcrypto) and posts only the signed documents; the daemon verifies them before it stores them.
 *
 * @registryCategory composite
 * @registryTags requests allow policy admin
 */
export function AllowRequestsTable({ rows = [], allow, emptyMessage = 'No request is waiting for approval', onRefresh }: AllowRequestsTableProps) {
  const [selected, setSelected] = useState<PendingRequestRow | null>(null);
  const [allowed, setAllowed] = useState<ReadonlySet<string>>(new Set());
  const [result, setResult] = useState<{ tone: 'success' | 'warning'; text: string; machine: string } | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const api = useRef<AllowApi | null>(null);
  api.current ??= shellAllowApi();

  const visible = rows.filter(r => !allowed.has(rowKey(r)));
  const canAllow = allow?.available === true;
  const rowCanAllow = (r: PendingRequestRow): boolean => r.canAllow ?? canAllow;

  const done = (row: PendingRequestRow, answer: AllowResult) => {
    setAllowed(prev => new Set(prev).add(rowKey(row)));
    setSelected(null);
    // Which path the policy took, in the words of the CLI: delivered directly or installed here (success colour), or the relay inbox with the cause (warning colour).
    const path = deliveryNotice(answer);
    setResult({ tone: path.tone, machine: answer.target.name, text: `Allowed ${row.shell} ${JSON.stringify(row.command)}: policy version ${answer.version}. ${path.text}. \`machine allowed ${answer.target.name}\` lists it.${noticeRecipientsText(answer)}` });
    // The page's own data catches up (the allowed command leaves the pending list); a failure is reported by the page's notifier.
    void onRefresh?.('requests');
  };

  // Dismiss of a notice row (decision 100): local, no passphrase and no PIN; the row leaves notices.json of this machine, never an audit line.
  const removeNotice = async (row: PendingRequestRow, notice: { machine: string; id: string }): Promise<void> => {
    await dismissNotice(api.current as AllowApi, notice);
    setAllowed((prev) => new Set(prev).add(rowKey(row)));
    void onRefresh?.('requests');
  };
  const dismiss = (row: PendingRequestRow, notice: { machine: string; id: string }) => {
    setDismissing(true);
    setDismissError(null);
    removeNotice(row, notice).then(
      () => setDismissing(false),
      (e: unknown) => {
        setDismissing(false);
        setDismissError(dismissFailureMessage(e));
      },
    );
  };
  // The command is already allowed (the dialog has nothing to sign): the row is obsolete. A notice row is dismissed at once (it never ends by itself); a row of this machine leaves at the refresh.
  const alreadyAllowed = async (row: PendingRequestRow): Promise<void> => {
    if (row.notice !== undefined) {
      await removeNotice(row, row.notice);
      return;
    }
    void onRefresh?.('requests');
  };

  const columns: Array<TableColumn<PendingRow>> = [
    { key: 'peerText', label: 'From', nowrap: true, render: (r) => <MachineName name={r.peerText} /> },
    { key: 'shell', label: 'Shell', nowrap: true, render: (r) => r.shell },
    {
      key: 'command',
      label: 'Command',
      mono: true,
      render: (r) => (
        <>
          {/* The command is untrusted text (a notice comes from another machine): a text node only, never interpreted. */}
          {r.command}
          {r.commandTruncated === true && <Notice variant="default" label="Truncated: only the first part of the command was reported." />}
          {r.note !== undefined && (
            <div data-testid="notice-note">
              <Notice variant="default" label={r.note} />
            </div>
          )}
        </>
      ),
    },
    { key: 'countText', label: 'Times', nowrap: true, render: (r) => r.countText },
    { key: 'firstSeenText', label: 'First', nowrap: true, render: (r) => r.firstSeenText },
    { key: 'lastSeenText', label: 'Last', nowrap: true, render: (r) => r.lastSeenText },
    {
      key: 'action',
      label: canAllow ? 'Action' : 'To allow it',
      render: (r) => (
        <HorizontalStack gap="gap-2" align="items-center" wrap>
          {rowCanAllow(r) ? (
            <ButtonAction label="Allow" ariaLabel={`Allow ${r.command}`} size="xs" onClick={() => setSelected(r)} />
          ) : (
            <span style={MONO_STYLE}>{r.nextCommand}</span>
          )}
          {r.notice !== undefined && <ButtonAction label="Dismiss" variant="secondary" size="sm" disabled={dismissing} onClick={() => dismiss(r, r.notice as NonNullable<PendingRequestRow['notice']>)} />}
        </HorizontalStack>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      {dismissError !== null && <Notice variant="danger" label={dismissError} />}
      {result !== null && <Notice variant={result.tone} label={result.text} />}
      {allow !== undefined && !canAllow && allow.note !== '' && (
        <Notice variant="default" label={allow.note} />
      )}
      {visible.length === 0 ? <Notice variant="default" label={emptyMessage} /> : <DataTable<PendingRow> rows={visible.map((r) => ({ ...r, rowId: rowKey(r) }))} columns={columns} rowKey="rowId" />}
      {selected !== null && allow !== undefined && (
        <AllowDialog key={rowKey(selected)} row={selected} machine={allow.machine} api={api.current} onClose={() => setSelected(null)} onAlreadyAllowed={() => alreadyAllowed(selected)} onDone={answer => done(selected, answer)} />
      )}
    </div>
  );
}
