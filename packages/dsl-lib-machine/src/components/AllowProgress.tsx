import React from 'react';
import { Badge, type BadgeVariant, HorizontalStack, Progress, VerticalStack } from '@wadeck-app/dsl-ui';
import { percentOf, stepsOf, type ProgressRecord, type StepState } from '../lib/allowProgress.js';

// The thin stepper under a request (decision 86): the determinate bar of dsl-ui (Progress) and ONE badge per step, one word each. Every step comes from a real
// event (allowProgress.ts). The sentences (cause, explanation) are NOT here: the row above says the outcome, the Details disclosure the rest.

export interface AllowProgressProps {
  record: ProgressRecord;
  /** Epoch milliseconds, ticking in the parent while the progress is not finished. */
  now: number;
}

/** The state of a step in words, for a screen reader (the title of the badge). */
export const STATE_WORDS: Record<StepState, string> = { done: 'done', active: 'in progress', pending: 'pending', failed: 'failed', skipped: 'not needed' };
const STEP_VARIANT: Record<StepState, BadgeVariant> = { done: 'success', active: 'primary', pending: 'default', failed: 'danger', skipped: 'default' };

export function AllowProgress({ record, now }: AllowProgressProps) {
  const steps = stepsOf(record, now);
  const value = percentOf(record);
  return (
    <div data-testid="allow-progress">
      <VerticalStack gap="gap-1">
        <Progress value={value} size="sm" variant={steps.some((s) => s.state === 'failed') ? 'danger' : value >= 100 ? 'success' : 'default'} />
        <HorizontalStack gap="gap-1" align="items-center" wrap>
          {steps.map((s) => (
            <Badge key={s.id} label={s.short} variant={STEP_VARIANT[s.state]} tone="subtle" title={`${s.short}: ${STATE_WORDS[s.state]}`} />
          ))}
        </HorizontalStack>
      </VerticalStack>
    </div>
  );
}
