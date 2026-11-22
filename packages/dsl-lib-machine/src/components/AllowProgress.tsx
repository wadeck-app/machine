import React from 'react';
import { percentOf, stepsOf, type ProgressRecord, type StepState } from '../lib/allowProgress.js';
import { SEGMENT_ACTIVE, SEGMENT_DONE, SEGMENT_FAILED, SEGMENT_PENDING, STEPPER_SEGMENT, STEP_ACTIVE, STEP_DONE, STEP_FAILED, STEP_PENDING } from '../lib/styleTokens.js';

// The thin stepper under a request (decision 86): one segment and ONE word per step, merged with the determinate bar. Every step comes from a real
// event (allowProgress.ts). The sentences (cause, explanation) are NOT here: the row above says the outcome, the Details disclosure the rest.

export interface AllowProgressProps {
  record: ProgressRecord;
  /** Epoch milliseconds, ticking in the parent while the progress is not finished. */
  now: number;
}

/** The state of a step in words, for a screen reader (the value text of the bar). */
export const STATE_WORDS: Record<StepState, string> = { done: 'done', active: 'in progress', pending: 'pending', failed: 'failed', skipped: 'not needed' };
const SEGMENT: Record<StepState, string> = { done: SEGMENT_DONE, active: SEGMENT_ACTIVE, pending: SEGMENT_PENDING, failed: SEGMENT_FAILED, skipped: SEGMENT_PENDING };
const WORD_COLOUR: Record<StepState, string> = { done: STEP_DONE, active: STEP_ACTIVE, pending: STEP_PENDING, failed: STEP_FAILED, skipped: STEP_PENDING };

export function AllowProgress({ record, now }: AllowProgressProps) {
  const steps = stepsOf(record, now);
  return (
    <div
      role="progressbar"
      aria-label="Progress of the allow"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percentOf(record)}
      aria-valuetext={steps.map((s) => `${s.short}: ${STATE_WORDS[s.state]}`).join(', ')}
      data-testid="allow-progress"
      className="flex gap-1"
    >
      {steps.map((s) => (
        <div key={s.id} className="flex flex-1 flex-col gap-0.5">
          <div className={`${STEPPER_SEGMENT} ${SEGMENT[s.state]}`} />
          <span className={`text-xs ${WORD_COLOUR[s.state]}`}>{s.short}</span>
        </div>
      ))}
    </div>
  );
}
