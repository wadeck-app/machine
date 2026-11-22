import React, { useEffect, useId, useState } from 'react';
import { ButtonAction, IconButton } from '@wadeck-app/dsl-ui';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { elapsedText, summaryOf, type ProgressRecord, type StepState } from '../lib/allowProgress.js';
import { MONO_STYLE, PROGRESS_CARD_ACTIVE, PROGRESS_CARD_DANGER, PROGRESS_CARD_SUCCESS, PROGRESS_SLIM_SUCCESS, STEP_ACTIVE, STEP_DONE, STEP_FAILED, TEXT_MUTED } from '../lib/styleTokens.js';
import { AllowProgress } from './AllowProgress.js';
import { AllowProgressDetails } from './AllowProgressDetails.js';
import { MachineName } from './MachineName.js';
import { StepMarker } from './StepMarker.js';

/** A success stays open this long after the end (the person sees the result), then collapses into one slim row. */
export const COLLAPSE_AFTER_MS = 10_000;

export interface RequestProgressCardProps {
  /** The request the progress belongs to: its command names the card for a screen reader. */
  row: { id: string; command: string };
  record: ProgressRecord;
  /** Epoch milliseconds, ticking in the owner while a progress is not finished. */
  now: number;
  /** Allow is offered for this request: a failed signature or delivery offers Allow again. */
  canRetry: boolean;
  /** One line the owner wants next to the progress (the notice recipients were not sent ...). */
  warning?: string;
  onRetry: () => void;
  onDismiss: () => void;
}

const ICON_STATE: Record<'active' | 'success' | 'danger', StepState> = { active: 'active', success: 'done', danger: 'failed' };
const ICON_COLOUR = { active: STEP_ACTIVE, success: STEP_DONE, danger: STEP_FAILED };
const TEXT_COLOUR = { active: 'text-content', success: STEP_DONE, danger: STEP_FAILED };

/**
 * A request that is only a progress display (after Allow): ONE line (status icon, command, machine, outcome, elapsed time, buttons) and the thin
 * stepper under it. The vertical steps and the long explanation are behind Details (closed). A success collapses into a slim row 10 s after the end;
 * a failure stays open with its one-line cause until it is dismissed, and offers Allow again when nothing was installed.
 */
export function RequestProgressCard({ row, record, now, canRetry, warning, onRetry, onDismiss }: RequestProgressCardProps) {
  const summary = summaryOf(record, now);
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const finishedAt = record.finishedAt;

  useEffect(() => {
    if (!summary.succeeded || finishedAt === undefined) {
      setCollapsed(false);
      return undefined;
    }
    const left = Math.max(0, COLLAPSE_AFTER_MS - (Date.now() - finishedAt));
    const timer = setTimeout(() => setCollapsed(true), left);
    return () => clearTimeout(timer);
  }, [summary.succeeded, finishedAt]);

  const className = collapsed ? PROGRESS_SLIM_SUCCESS : summary.tone === 'danger' ? PROGRESS_CARD_DANGER : summary.tone === 'success' ? PROGRESS_CARD_SUCCESS : PROGRESS_CARD_ACTIVE;
  const delivery = summary.delivery !== undefined && summary.delivery.tone === 'warning' ? summary.delivery : undefined;

  return (
    <li aria-label={`Held request ${row.command}`} className={className}>
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <span className={`shrink-0 ${ICON_COLOUR[summary.tone]}`}>
          <StepMarker state={ICON_STATE[summary.tone]} />
        </span>
        <span className="min-w-0 truncate font-medium text-content" style={MONO_STYLE} title={row.command}>{row.command}</span>
        <span className={`shrink-0 text-xs ${TEXT_MUTED}`}>
          on <MachineName name={record.machineName} />
        </span>
        <span aria-live="polite" className={`shrink-0 ${TEXT_COLOUR[summary.tone]}`}>{summary.text}</span>
        {record.signedSummary !== undefined && <span className={`min-w-0 truncate text-xs ${TEXT_MUTED}`} title={record.signedSummary.full}>{`Signed: ${record.signedSummary.short}`}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <span className={`text-xs tabular-nums ${TEXT_MUTED}`}>{elapsedText(record, now)}</span>
          {summary.retryable && canRetry && <ButtonAction label="Allow again" variant="secondary" size="sm" onClick={onRetry} />}
          <IconButton icon={open ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />} aria-label="Details" aria-expanded={open} aria-controls={panelId} size="icon-xs" onClick={() => setOpen((v) => !v)} />
          {summary.finished && <IconButton icon={<X size={14} aria-hidden="true" />} aria-label="Dismiss" size="icon-xs" onClick={onDismiss} />}
        </span>
      </div>
      {!collapsed && <AllowProgress record={record} now={now} />}
      {!collapsed && summary.cause !== undefined && <div className={`text-xs ${summary.tone === 'danger' ? 'text-danger-text' : TEXT_MUTED}`}>{summary.cause}</div>}
      {!collapsed && delivery !== undefined && (
        <div className={`text-xs ${TEXT_MUTED}`}>
          {delivery.text}
          {delivery.cause !== undefined && <span className="block">{delivery.cause}</span>}
        </div>
      )}
      {warning !== undefined && <div className="text-xs text-warning-text">{warning}</div>}
      <div id={panelId}>{open && <AllowProgressDetails record={record} />}</div>
    </li>
  );
}
