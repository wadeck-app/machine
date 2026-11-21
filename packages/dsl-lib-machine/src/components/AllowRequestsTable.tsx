import React, { useRef, useState } from 'react';
import { noticeRecipientsText, shellAllowApi, type AllowApi, type AllowResult } from '../lib/allowFlow.js';
import { ALLOW_BUTTON, NOTICE_NEUTRAL, NOTICE_SUCCESS, TABLE_BODY_ROW, TABLE_HEAD_ROW, TEXT_MUTED_SM } from '../lib/styleTokens.js';
import { AllowDialog } from './AllowDialog.js';

export interface PendingRequestRow {
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
}

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
  const [result, setResult] = useState<string | null>(null);
  const api = useRef<AllowApi | null>(null);
  api.current ??= shellAllowApi();

  const visible = rows.filter(r => !allowed.has(rowKey(r)));
  const canAllow = allow?.available === true;
  const rowCanAllow = (r: PendingRequestRow): boolean => r.canAllow ?? canAllow;

  const done = (row: PendingRequestRow, answer: AllowResult) => {
    setAllowed(prev => new Set(prev).add(rowKey(row)));
    setSelected(null);
    const where = answer.delivery === 'installed' ? `installed on ${answer.target.name}` : `stored in the relay inbox of ${answer.target.name}: its daemon installs it within about a minute`;
    setResult(`Allowed ${row.shell} ${JSON.stringify(row.command)}: policy version ${answer.version} is ${where}. \`machine allowed ${answer.target.name}\` lists it.${noticeRecipientsText(answer)}`);
    // The page's own data catches up (the allowed command leaves the pending list); a failure is reported by the page's notifier.
    void onRefresh?.('requests');
  };

  return (
    <div className="flex flex-col gap-3">
      {result !== null && (
        <div role="status" className={NOTICE_SUCCESS}>{result}</div>
      )}
      {allow !== undefined && !canAllow && allow.note !== '' && (
        <div className={NOTICE_NEUTRAL}>{allow.note}</div>
      )}
      {visible.length === 0 ? (
        <div className={`py-2 ${TEXT_MUTED_SM}`}>{emptyMessage}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className="px-2 py-1 font-medium">From</th>
                <th className="px-2 py-1 font-medium">Shell</th>
                <th className="px-2 py-1 font-medium">Command</th>
                <th className="px-2 py-1 font-medium">Times</th>
                <th className="px-2 py-1 font-medium">First</th>
                <th className="px-2 py-1 font-medium">Last</th>
                <th className="px-2 py-1 font-medium">{canAllow ? 'Action' : 'To allow it'}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(r => (
                <tr key={rowKey(r)} className={TABLE_BODY_ROW} {...(r.note !== undefined ? { 'data-testid': 'notice-row' } : {})}>
                  <td className="whitespace-nowrap px-2 py-1">{r.peerText}</td>
                  <td className="whitespace-nowrap px-2 py-1">{r.shell}</td>
                  <td className="break-all px-2 py-1">
                    {/* The command is untrusted text (a notice comes from another machine): a text node only, never interpreted. */}
                    <span className="font-mono">{r.command}</span>
                    {r.commandTruncated === true && <div className={`text-xs ${TEXT_MUTED_SM}`}>Truncated: only the first part of the command was reported.</div>}
                    {r.note !== undefined && (
                      <div data-testid="notice-note" className="text-xs text-muted">
                        {r.note}
                      </div>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1">{r.countText}</td>
                  <td className="whitespace-nowrap px-2 py-1">{r.firstSeenText}</td>
                  <td className="whitespace-nowrap px-2 py-1">{r.lastSeenText}</td>
                  <td className="px-2 py-1">
                    {rowCanAllow(r) ? (
                      // violations-suppress: react/no-raw-button ButtonAction has no aria-label and dsl-ui's Button is not exported: the name "Allow <command>" tells the rows apart for a screen reader (looks like dsl-ui's primary Button, same tokens as its Badge)
                      <button type="button" aria-label={`Allow ${r.command}`} onClick={() => setSelected(r)} className={ALLOW_BUTTON}>
                        Allow
                      </button>
                    ) : (
                      <span className="break-all font-mono text-xs">{r.nextCommand}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected !== null && allow !== undefined && (
        <AllowDialog key={rowKey(selected)} row={selected} machine={allow.machine} api={api.current} onClose={() => setSelected(null)} onDone={answer => done(selected, answer)} />
      )}
    </div>
  );
}
