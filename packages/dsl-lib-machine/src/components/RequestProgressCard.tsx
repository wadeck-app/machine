import React, { useEffect, useId, useState } from 'react';
import { Badge, type BadgeVariant, ButtonAction, Card, HorizontalStack, IconButton, Notice, VerticalStack, Text } from '@wadeck-app/dsl-ui';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { elapsedText, summaryOf, type ProgressRecord, type StepState } from '../lib/allowProgress.js';
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
const OUTCOME_VARIANT: Record<'active' | 'success' | 'danger', BadgeVariant> = { active: 'primary', success: 'success', danger: 'danger' };

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

  const delivery = summary.delivery !== undefined && summary.delivery.tone === 'warning' ? summary.delivery : undefined;

  return (
    <li aria-label={`Held request ${row.command}`}>
      <Card padding="sm">
        <VerticalStack gap="gap-1">
          <HorizontalStack gap="gap-2" align="items-center" justify="justify-between" wrap>
            <HorizontalStack gap="gap-2" align="items-center" wrap>
              <StepMarker state={ICON_STATE[summary.tone]} />
              <span title={row.command}><Text mono text={row.command} /></span>
              <span>
                on <MachineName name={record.machineName} />
              </span>
              <span aria-live="polite">
                <Badge label={summary.text} variant={OUTCOME_VARIANT[summary.tone]} tone="subtle" />
              </span>
              {record.signedSummary !== undefined && <span title={record.signedSummary.full}>{`Signed: ${record.signedSummary.short}`}</span>}
            </HorizontalStack>
            <HorizontalStack gap="gap-1" align="items-center">
              <span>{elapsedText(record, now)}</span>
              {summary.retryable && canRetry && <ButtonAction label="Allow again" variant="secondary" size="sm" onClick={onRetry} />}
              <IconButton icon={open ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />} aria-label="Details" aria-expanded={open} aria-controls={panelId} size="icon-xs" onClick={() => setOpen((v) => !v)} />
              {summary.finished && <IconButton icon={<X size={14} aria-hidden="true" />} aria-label="Dismiss" size="icon-xs" onClick={onDismiss} />}
            </HorizontalStack>
          </HorizontalStack>
          {!collapsed && <AllowProgress record={record} now={now} />}
          {!collapsed && summary.cause !== undefined && <Notice variant={summary.tone === 'danger' ? 'danger' : 'default'} label={summary.cause} />}
          {!collapsed && delivery !== undefined && <Notice variant="warning" label={delivery.cause === undefined ? delivery.text : `${delivery.text} ${delivery.cause}`} />}
          {warning !== undefined && <Notice variant="warning" label={warning} />}
          <div id={panelId}>{open && <AllowProgressDetails record={record} />}</div>
        </VerticalStack>
      </Card>
    </li>
  );
}
