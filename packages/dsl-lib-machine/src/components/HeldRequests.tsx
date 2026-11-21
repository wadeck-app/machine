import React, { useEffect, useMemo, useRef, useState } from 'react';
import { shellAllowApi, type AllowApi, type AllowResult } from '../lib/allowFlow.js';
import { ALLOW_BUTTON, DENY_BUTTON, HELD_COMMAND, HELD_COUNTDOWN, HELD_COUNTDOWN_URGENT, HELD_ITEM, NOTICE_NEUTRAL, NOTICE_SUCCESS, TEXT_MUTED, TEXT_MUTED_SM } from '../lib/styleTokens.js';
import { AllowDialog } from './AllowDialog.js';
import { DenyForm } from './DenyForm.js';

export interface HeldRequestRow {
  /** What the Deny button posts: the id of the held request. */
  id: string;
  peerText: string;
  peer: string;
  shell: string;
  command: string;
  /** Seconds until the hold ends, by the clock of the daemon, at the time the page was fetched. */
  secondsLeft: number;
  askedText: string;
  /** What the Allow dialog shows next to the peer. */
  countText: string;
  /** The `machine admin allow ...` command that does the same from a terminal. */
  nextCommand: string;
  nextWhere: string;
  /** Held on ANOTHER machine (the admin machine listed it): the machine Allow signs for. Absent: this machine (`allow.machine`). */
  machine?: { uuid: string; name: string };
  /** Whether Allow is offered for the machine of this row. Default: `allow.available`. */
  canAllow?: boolean;
  /** Present: no Deny button for this row (denying from another machine is not available), this text says where to deny it. */
  denyText?: string;
  /** Epoch milliseconds at which `secondsLeft` was read: the countdown runs from it. Default: when the list arrived. */
  fetchedAtMs?: number;
}

export interface HeldRequestsProps {
  /** The held requests of the Requests page (`$sources.requests.waiting`), soonest deadline first. */
  rows?: HeldRequestRow[];
  /** Whether Allow is offered here and for which machine (`$sources.requests.allow`): the admin machine, in policy mode admin. */
  allow?: { available: boolean; machine: { uuid: string; name: string }; note: string };
  /**
   * Re-runs the page's sources, so the list is the daemon's own after an allow or a deny. Defaults to the page's `$refresh`.
   * @ctxDefault $refresh
   */
  onRefresh?: (source?: string) => Promise<void>;
}

const NO_ROWS: HeldRequestRow[] = [];
/** Under this many seconds the countdown turns red. */
const URGENT_SECONDS = 30;

function leftText(seconds: number): string {
  if (seconds <= 0) {
    return 'expired';
  }
  return seconds >= 60 ? `${Math.floor(seconds / 60)} min ${seconds % 60} s left` : `${seconds} s left`;
}

/**
 * The held requests of the Requests page: a caller ran `machine run <peer> --wait ... -- <command>` and waits for the owner to answer. Each shows the
 * exact command in large type, a live countdown (counted down here from the seconds left of the fetch), and two buttons. Allow is the same flow as the
 * table below (confirmation, admin passphrase, signature in the page); Deny is a restricting action: an optional reason, no signature, no passphrase (the app-core PIN only).
 *
 * @registryCategory composite
 * @registryTags requests allow deny hold policy admin
 */
export function HeldRequests({ rows = NO_ROWS, allow, onRefresh }: HeldRequestsProps) {
  const [selected, setSelected] = useState<HeldRequestRow | null>(null);
  const [denying, setDenying] = useState<string | null>(null);
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const [result, setResult] = useState<string | null>(null);
  const api = useRef<AllowApi | null>(null);
  api.current ??= shellAllowApi();

  // The seconds left of every row are those of the moment the rows arrived: a new list (a refresh) starts the count again.
  const fetchedAt = useMemo(() => Date.now(), [rows]);
  const [now, setNow] = useState(() => Date.now());
  const ticking = rows.length > 0;
  useEffect(() => {
    if (!ticking) {
      return undefined;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking, rows]);

  const visible = rows.filter((r) => !answered.has(r.id));
  const canAllow = allow?.available === true;
  const elapsedSince = (from: number): number => Math.max(0, Math.floor((now - from) / 1000));

  const leave = (row: HeldRequestRow) => {
    setAnswered((prev) => new Set(prev).add(row.id));
    setSelected(null);
    setDenying(null);
    // The page's own data catches up (the request leaves the held list); a failure is reported by the page's notifier.
    void onRefresh?.('requests');
  };

  const allowed = (row: HeldRequestRow, answer: AllowResult) => {
    const where = answer.delivery === 'installed' ? `installed on ${answer.target.name}` : `stored in the relay inbox of ${answer.target.name}: its daemon installs it within about a minute`;
    setResult(`Allowed ${row.shell} ${JSON.stringify(row.command)}: policy version ${answer.version} is ${where}. The caller gets the result as soon as the daemon re-checks the request. \`machine allowed ${answer.target.name}\` lists it.`);
    leave(row);
  };

  const denied = (row: HeldRequestRow) => {
    setResult(`Denied ${row.shell} ${JSON.stringify(row.command)} from ${row.peerText}: the caller was answered "refused: denied". Nothing was signed.`);
    leave(row);
  };

  if (visible.length === 0 && result === null) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-base font-semibold text-content">Held requests: a caller is waiting for your answer</h3>
      {result !== null && <div role="status" className={NOTICE_SUCCESS}>{result}</div>}
      {allow !== undefined && !canAllow && allow.note !== '' && visible.length > 0 && <div className={NOTICE_NEUTRAL}>{allow.note}</div>}
      <ul className="flex flex-col gap-3">
        {visible.map((r) => {
          const left = Math.max(0, r.secondsLeft - elapsedSince(r.fetchedAtMs ?? fetchedAt));
          const rowCanAllow = r.canAllow ?? canAllow;
          return (
            <li key={r.id} aria-label={`Held request ${r.command}`} className={HELD_ITEM}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className={`text-sm ${TEXT_MUTED_SM}`}>
                  From <span className="font-medium text-content">{r.peerText}</span>
                  {r.machine !== undefined && (
                    <>
                      {' '}
                      on <span className="font-medium text-content">{r.machine.name}</span>
                    </>
                  )}{' '}
                  in <span className="font-mono text-content">{r.shell}</span>, asked {r.askedText}
                </span>
                <span className={left <= URGENT_SECONDS ? HELD_COUNTDOWN_URGENT : HELD_COUNTDOWN}>{leftText(left)}</span>
              </div>
              <div className={HELD_COMMAND}>{r.command}</div>
              {left > 0 && denying !== r.id && (
                <div className="flex flex-wrap items-center gap-2">
                  {rowCanAllow ? (
                    // violations-suppress: react/no-raw-button ButtonAction has no aria-label: the name "Allow <command>" tells the rows apart for a screen reader (same button as the table below)
                    <button type="button" aria-label={`Allow ${r.command}`} onClick={() => setSelected(r)} className={ALLOW_BUTTON}>
                      Allow
                    </button>
                  ) : (
                    <span className="break-all font-mono text-xs">{r.nextCommand}</span>
                  )}
                  {r.denyText !== undefined ? (
                    <span className={`text-xs ${TEXT_MUTED}`}>{r.denyText}</span>
                  ) : (
                    // violations-suppress: react/no-raw-button ButtonAction has no aria-label: the name "Deny <command>" tells the rows apart for a screen reader (looks like dsl-ui's danger outline button)
                    <button type="button" aria-label={`Deny ${r.command}`} onClick={() => setDenying(r.id)} className={DENY_BUTTON}>
                      Deny
                    </button>
                  )}
                </div>
              )}
              {left > 0 && denying === r.id && api.current !== null && <DenyForm id={r.id} api={api.current} onCancel={() => setDenying(null)} onDenied={() => denied(r)} />}
            </li>
          );
        })}
      </ul>
      {selected !== null && (selected.machine !== undefined || allow !== undefined) && api.current !== null && (
        <AllowDialog key={selected.id} row={{ ...selected, firstSeenText: selected.askedText, lastSeenText: selected.askedText }} machine={selected.machine ?? (allow as NonNullable<typeof allow>).machine} api={api.current} onClose={() => setSelected(null)} onDone={(answer) => allowed(selected, answer)} />
      )}
    </div>
  );
}
