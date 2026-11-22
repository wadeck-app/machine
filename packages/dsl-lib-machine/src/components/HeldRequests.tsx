import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ButtonAction, Checkbox } from '@wadeck-app/dsl-ui';
import type { WaitingRenewal } from '@wadeck-app/machine-core';
import type { CallerAsk } from '../lib/callerAsk.js';
import { lifetimeInput, lifetimeWords, type LifetimeChoice } from '../lib/lifetimeChoice.js';
import { cardFlags, lifetimeMemory, readOnlyDefaultKind, startChoiceOf } from '../lib/quickAllow.js';
import { noticeRecipientsText, shellAllowApi, type AllowApi, type AllowResult } from '../lib/allowFlow.js';
import { HELD_COMMAND, HELD_COUNTDOWN, HELD_COUNTDOWN_URGENT, HELD_ITEM, MONO_STYLE, NOTICE_NEUTRAL, NOTICE_SUCCESS, OUTCOME_NEUTRAL, OUTCOME_SUCCESS, OUTCOME_WARNING, TEXT_MUTED_SM } from '../lib/styleTokens.js';
import type { AllowStyle } from '../lib/allowStyle.js';
import { AllowDialog } from './AllowDialog.js';
import { BatchAllowBar, type BatchItem } from './BatchAllowBar.js';
import { DenyForm, NO_REASON_TEXT } from './DenyForm.js';
import { HeldAnswer } from './HeldAnswer.js';
import { HeldDetails } from './HeldDetails.js';
import { HeldStatusRow } from './HeldStatusRow.js';
import { MachineName } from './MachineName.js';
import { RequestProgressCard } from './RequestProgressCard.js';
import { useAllowProgress } from './useAllowProgress.js';

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
  /** Epoch milliseconds at which `secondsLeft` was read: the countdown runs from it. Default: when the list arrived. */
  fetchedAtMs?: number;
  /** Present: this row is a NOTICE another machine reported (not verified live); the text says by whom and when. Shown muted, the row has no "asked" text. */
  note?: string;
  /** The notice carries only the first part of the command. */
  commandTruncated?: boolean;
  /** The request waits for the renewal of an exhausted or expired entry (hold-for-approval.md, "Renewal"): the Allow replaces that entry. */
  renewal?: WaitingRenewal;
  /** What the CALLER asked the owner for (`machine run --times/--for/--why`, decision 96): its wish, untrusted text, only pre-fills the Allow. */
  ask?: CallerAsk;
}

export interface HeldRequestsProps {
  /** The held requests of the Requests page (`$sources.requests.waiting`), soonest deadline first. */
  rows?: HeldRequestRow[];
  /** Whether Allow is offered here and for which machine (`$sources.requests.allow`): the admin machine, in policy mode admin. */
  allow?: { available: boolean; machine: { uuid: string; name: string }; note: string };
  /**
   * Whether each other machine is reachable directly now, by uuid (fields `reachableState` and `reachable` of `$sources.machines.machines`): a badge on the cards
   * of the requests it holds. Allow reaches a machine at once when it is, else through the relay inbox (decision 86). This machine shows no badge.
   */
  reachability?: Record<string, { state: string; text: string }>;
  /**
   * Re-runs the page's sources, so the list is the daemon's own after an allow or a deny. Defaults to the page's `$refresh`.
   * @ctxDefault $refresh
   */
  onRefresh?: (source?: string) => Promise<void>;
  /**
   * How Allow asks: in a confirmation `dialog` (default), or `inline` in the card, with a checkbox per card and a sticky bar that signs the selected requests
   * with one passphrase (one policy per machine). The Requests page passes the person's choice (AllowStyleSwitch).
   */
  allowStyle?: AllowStyle;
  /** Safer mode (default off): with the admin key unlocked, a flagged lifetime (permanent, 50 calls or more, over 7 days) needs a second click. The Requests page passes the person's choice. */
  saferMode?: boolean;
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
 * table below (confirmation dialog, admin passphrase, signature in the page); the dialog closes as soon as the signing is submitted and the progress lives
 * on the card (one line and a thin stepper, RequestProgressCard). Deny is a restricting action: an optional reason, no signature, no passphrase (the app-core PIN only).
 *
 * @registryCategory composite
 * @registryTags requests allow deny hold policy admin
 */
export function HeldRequests({ rows = NO_ROWS, allow, reachability, onRefresh, allowStyle = 'dialog', saferMode = false }: HeldRequestsProps) {
  const inline = allowStyle === 'inline';
  const [selected, setSelected] = useState<HeldRequestRow | null>(null);
  // Inline style: the cards ticked for one batch.
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  // The lifetime the owner picked on a card (a card not touched starts from `startChoiceOf`), and the cards whose Details are open.
  const [choices, setChoices] = useState<Readonly<Record<string, LifetimeChoice>>>({});
  const [detailsOpen, setDetailsOpen] = useState<ReadonlySet<string>>(new Set());
  const panelBase = useId();
  const [denying, setDenying] = useState<string | null>(null);
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  // The one short line of a Deny (nothing else shows it). An Allow has none: its card says everything.
  const [result, setResult] = useState<React.ReactNode | null>(null);
  // A line the owner has to read next to the progress of a request (the list of notice recipients was not sent ...).
  const [warnings, setWarnings] = useState<Readonly<Record<string, string>>>({});
  const api = useRef<AllowApi | null>(null);
  api.current ??= shellAllowApi();
  const progress = useAllowProgress<HeldRequestRow>(api.current);

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

  // A request that was allowed stays as a card while its progress is shown, even after the page's list no longer has it.
  const orphans = Object.values(progress.entries).filter((e) => !rows.some((r) => r.id === e.row.id)).map((e) => e.row);
  const visible = [...rows.filter((r) => !answered.has(r.id)), ...orphans];
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
    // Only what the card cannot say by itself: a warning about the list of notice recipients (without its "[warn]" tag, the line is a warning already).
    const warning = noticeRecipientsText(answer).replace(/^ \[warn\] /, '');
    setWarnings((prev) => ({ ...Object.fromEntries(Object.entries(prev).filter(([id]) => id !== row.id)), ...(warning === '' ? {} : { [row.id]: warning }) }));
    setDenying(null);
    // The page's own data catches up; the card stays (with its progress) until the person dismisses it after the end.
    void onRefresh?.('requests');
  };

  const denied = (row: HeldRequestRow, reason: string | undefined) => {
    setResult(
      <>
        Denied {row.command}
        {row.machine !== undefined ? (
          <>
            {' '}
            on <MachineName name={row.machine.name} /> (<MachineName name={row.machine.name} /> was told)
          </>
        ) : (
          <>
            {' '}
            from <MachineName name={row.peerText} />
          </>
        )}
        : nothing was signed. The caller was told: {reason ?? NO_REASON_TEXT}
      </>,
    );
    leave(row);
  };

  const machineOf = (r: HeldRequestRow) => r.machine ?? (allow as NonNullable<typeof allow>).machine;
  const progressFor = (r: HeldRequestRow) => (event: Parameters<typeof progress.handle>[3]) => progress.handle(r, machineOf(r), r.machine?.uuid ?? 'self', event);
  // The ticked requests that can still be allowed (no progress yet, not expired), in the order of the list.
  const batchItems: Array<BatchItem<HeldRequestRow>> = inline
    ? visible
        .filter((r) => ticked.has(r.id) && progress.entries[r.id] === undefined && (r.canAllow ?? canAllow) && r.secondsLeft - elapsedSince(r.fetchedAtMs ?? fetchedAt) > 0)
        .map((r) => ({ row: r, machine: machineOf(r), machineRef: r.machine?.uuid ?? 'self' }))
    : [];
  const wordsOf = (choice: LifetimeChoice): string => {
    const lifetime = lifetimeInput(choice);
    const nowSeconds = Math.floor(Date.now() / 1000);
    return lifetime.ok ? lifetimeWords(lifetime.limits(nowSeconds), nowSeconds) : 'for the lifetime you enter';
  };
  const choiceOf = (r: HeldRequestRow): LifetimeChoice => choices[r.id] ?? startChoiceOf(r);
  const choose = (r: HeldRequestRow, choice: LifetimeChoice) => {
    lifetimeMemory.remember(choice);
    setChoices((prev) => ({ ...prev, [r.id]: choice }));
  };
  const toggleDetails = (id: string) =>
    setDetailsOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });
  const tick = (id: string, on: boolean) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (on) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });

  if (visible.length === 0 && result === null) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-base font-semibold text-content">Held requests: a caller is waiting for your answer</h3>
      {result !== null && <div role="status" className={NOTICE_SUCCESS}>{result}</div>}
      {allow !== undefined && !canAllow && allow.note !== '' && visible.length > 0 && <div className={NOTICE_NEUTRAL}>{allow.note}</div>}
      <ul className="flex flex-col gap-2">
        {visible.map((r) => {
          const left = Math.max(0, r.secondsLeft - elapsedSince(r.fetchedAtMs ?? fetchedAt));
          const rowCanAllow = r.canAllow ?? canAllow;
          const progressOf = progress.entries[r.id]?.record;
          const reach = r.machine !== undefined ? reachability?.[r.machine.uuid] : undefined;
          // The machine Allow signs for (absent when Allow is not offered for this row).
          const target = rowCanAllow ? r.machine ?? allow?.machine : undefined;
          if (progressOf !== undefined) {
            const warning = warnings[r.id];
            return (
              <RequestProgressCard
                key={r.id}
                row={r}
                record={progressOf}
                now={progress.now}
                canRetry={rowCanAllow}
                {...(warning !== undefined ? { warning } : {})}
                onRetry={() => {
                  if (inline) {
                    // The card goes back to the held request with its Allow row (one click again when the key is unlocked).
                    progress.dismiss(r.id);
                    return;
                  }
                  setSelected(r);
                }}
                onDismiss={() => {
                  progress.dismiss(r.id);
                  // A request that ended left the daemon's list (the rows of the page may not have caught up yet); one whose signature or delivery failed is still held: its card comes back.
                  if (progressOf.failed === undefined) {
                    setAnswered((prev) => new Set(prev).add(r.id));
                  }
                }}
              />
            );
          }
          return (
            <li key={r.id} aria-label={`Held request ${r.command}`} className={HELD_ITEM} {...(r.note !== undefined ? { 'data-testid': 'notice-row' } : {})}>
              <div data-testid="held-header" className="flex flex-wrap items-baseline justify-between gap-x-2">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  {inline && rowCanAllow && left > 0 && <Checkbox aria-label={`Select ${r.command}`} checked={ticked.has(r.id)} onChange={(e) => tick(r.id, e.target.checked)} />}
                  <span className={`text-sm ${TEXT_MUTED_SM}`}>
                    From <MachineName name={r.peerText} />
                    {r.machine !== undefined && (
                      <>
                        {' '}
                        on <MachineName name={r.machine.name} />
                      </>
                    )}{' '}
                    in <span style={MONO_STYLE} className="text-content">{r.shell}</span>
                    {r.note === undefined && <>, asked {r.askedText}</>}
                  </span>
                  {reach !== undefined && (
                    <span data-testid="reachable-badge" className={reach.state === 'direct' ? OUTCOME_SUCCESS : reach.state === 'not-direct' ? OUTCOME_WARNING : OUTCOME_NEUTRAL}>
                      Reachability: {reach.text}
                    </span>
                  )}
                </span>
                <span className={left <= URGENT_SECONDS ? HELD_COUNTDOWN_URGENT : HELD_COUNTDOWN}>{leftText(left)}</span>
              </div>
              {/* The command is untrusted text (a notice comes from another machine): a text node only, never interpreted. */}
              <div className={HELD_COMMAND} style={MONO_STYLE}>{r.command}</div>
              <HeldStatusRow row={r} choiceFlags={rowCanAllow ? cardFlags(choiceOf(r), undefined) : []} open={detailsOpen.has(r.id)} panelId={`${panelBase}-${r.id}`} onToggle={() => toggleDetails(r.id)} />
              <div id={`${panelBase}-${r.id}`}>
                {detailsOpen.has(r.id) && <HeldDetails row={r} machine={target} words={wordsOf(choiceOf(r))} />}
              </div>
              {left > 0 && denying !== r.id && api.current !== null && (
                <HeldAnswer
                  key={r.id}
                  row={r}
                  machine={machineOf(r)}
                  canAllow={rowCanAllow}
                  inline={inline}
                  saferMode={saferMode}
                  api={api.current}
                  choice={choiceOf(r)}
                  onChoice={(c) => choose(r, c)}
                  onEvent={progressFor(r)}
                  onDone={(answer) => allowed(r, answer)}
                  onOpenDialog={() => setSelected(r)}
                  onDeny={() => setDenying(r.id)}
                />
              )}
              {left > 0 && denying === r.id && api.current !== null && <DenyForm id={r.id} {...(r.machine !== undefined ? { machine: r.machine.uuid } : {})} api={api.current} onCancel={() => setDenying(null)} onDenied={(reason) => denied(r, reason)} />}
            </li>
          );
        })}
      </ul>
      {inline && batchItems.length > 0 && api.current !== null && (
        <BatchAllowBar
          key={batchItems.map((i) => i.row.id).join('|')}
          items={batchItems}
          api={api.current}
          onEvent={(item, event) => progress.handle(item.row, item.machine, item.machineRef, event)}
          onDone={(item, answer) => allowed(item.row, answer)}
          onClear={() => setTicked(new Set())}
        />
      )}
      {selected !== null && (selected.machine !== undefined || allow !== undefined) && api.current !== null && (
        <AllowDialog
          key={selected.id}
          defaultLifetime={readOnlyDefaultKind([selected])}
          row={{ ...selected, firstSeenText: selected.askedText, lastSeenText: selected.askedText }}
          machine={selected.machine ?? (allow as NonNullable<typeof allow>).machine}
          api={api.current}
          onEvent={(event) => progress.handle(selected, selected.machine ?? (allow as NonNullable<typeof allow>).machine, selected.machine?.uuid ?? 'self', event)}
          onClose={() => setSelected(null)}
          onDone={(answer) => allowed(selected, answer)}
        />
      )}
    </div>
  );
}
