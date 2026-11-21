import React from 'react';
import { StepMarker } from './StepMarker.js';
import { elapsedText, percentOf, stepsOf, type ProgressRecord, type StepState } from '../lib/allowProgress.js';
import { PROGRESS_FILL, PROGRESS_FILL_FAILED, PROGRESS_TRACK, STEP_ACTIVE, STEP_DONE, STEP_FAILED, STEP_PENDING, TEXT_MUTED_SM } from '../lib/styleTokens.js';

// The steps after "Allow and sign" (decision 86), with a determinate bar and the elapsed time. Every step comes from a real event (allowProgress.ts).
// The state of a step is said in words for a screen reader; the list is a polite live region, so a change is announced.

export interface AllowProgressProps {
  record: ProgressRecord;
  /** Epoch milliseconds, ticking in the parent while the progress is not finished. */
  now: number;
}

const WORDS: Record<StepState, string> = { done: 'done', active: 'in progress', pending: 'pending', failed: 'failed', skipped: 'not needed' };
const COLOUR: Record<StepState, string> = { done: STEP_DONE, active: STEP_ACTIVE, pending: STEP_PENDING, failed: STEP_FAILED, skipped: STEP_PENDING };

export function AllowProgress({ record, now }: AllowProgressProps) {
  const steps = stepsOf(record, now);
  const percent = percentOf(record);
  const failed = steps.some((s) => s.state === 'failed');
  return (
    <div className="flex flex-col gap-2" data-testid="allow-progress">
      <div role="progressbar" aria-label="Progress of the allow" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className={PROGRESS_TRACK}>
        <div className={failed ? PROGRESS_FILL_FAILED : PROGRESS_FILL} style={{ width: `${percent}%` }} />
      </div>
      <div className={TEXT_MUTED_SM}>{elapsedText(record, now)}</div>
      {/* A polite live region without role=status: the page already has its own status message for the result, and a change of step is announced here. */}
      <div aria-live="polite" data-testid="allow-progress-steps">
        <ol className="flex flex-col gap-1 text-sm">
          {steps.map((s) => (
            <li key={s.id} className={`flex flex-col ${COLOUR[s.state]}`}>
              <span className="flex items-center gap-2">
                <StepMarker state={s.state} />
                <span className="sr-only">{WORDS[s.state]}: </span>
                <span>{s.label}</span>
              </span>
              {s.detail !== undefined && <span className="pl-6 text-xs text-muted">{s.detail}</span>}
            </li>
          ))}
        </ol>
        {record.pollError !== undefined && !record.timedOut && record.finishedAt === undefined && <p className="text-xs text-muted">The page could not ask {record.machineName} just now ({record.pollError}); it asks again.</p>}
      </div>
    </div>
  );
}
