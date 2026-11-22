import React from 'react';
import { stepsOf, type ProgressRecord, type StepState } from '../lib/allowProgress.js';
import { deliverySummary } from '../lib/deliverySummary.js';
import { STEP_ACTIVE, STEP_DONE, STEP_FAILED, STEP_PENDING, TEXT_MUTED } from '../lib/styleTokens.js';
import { MachineText } from './MachineText.js';
import { STATE_WORDS } from './AllowProgress.js';
import { StepMarker } from './StepMarker.js';

// The content of the Details disclosure of a request: the vertical steps (state in words) and the long explanation of the delivery. What the row above the
// stepper already says (the outcome, the cause of a failure) is NOT said again here. The list is a polite live region: a change of step is announced.

const COLOUR: Record<StepState, string> = { done: STEP_DONE, active: STEP_ACTIVE, pending: STEP_PENDING, failed: STEP_FAILED, skipped: STEP_PENDING };

export function AllowProgressDetails({ record }: { record: ProgressRecord }) {
  const steps = stepsOf(record, 0);
  const names = [record.machineName];
  const explanation = record.result !== undefined ? deliverySummary(record.result).explanation : undefined;
  return (
    <div className="flex flex-col gap-1 text-sm">
      <div aria-live="polite" data-testid="allow-progress-steps">
        <ol className="flex flex-col gap-0.5">
          {steps.map((s) => (
            <li key={s.id} className={`flex flex-col ${COLOUR[s.state]}`}>
              <span className="flex items-center gap-2">
                <StepMarker state={s.state} />
                <span className="sr-only">{STATE_WORDS[s.state]}: </span>
                <span><MachineText text={s.label} names={names} /></span>
              </span>
              {/* The detail of a FAILED step is the cause the row shows: not repeated here. */}
              {s.detail !== undefined && s.state !== 'failed' && <span className={`pl-6 text-xs ${TEXT_MUTED}`}>{s.detail}</span>}
            </li>
          ))}
        </ol>
        {record.pollError !== undefined && !record.timedOut && record.finishedAt === undefined && (
          <p className={`text-xs ${TEXT_MUTED}`}>
            The page could not ask <MachineText text={record.machineName} names={names} /> just now ({record.pollError}); it asks again.
          </p>
        )}
      </div>
      {explanation !== undefined && (
        <p className={`text-xs ${TEXT_MUTED}`}>
          <MachineText text={explanation} names={names} />
        </p>
      )}
      {record.result !== undefined && (
        <p className={`text-xs ${TEXT_MUTED}`}>
          Policy version {record.result.version}. <MachineText text={`\`machine allowed ${record.result.target.name}\``} names={[record.result.target.name]} /> lists it.
        </p>
      )}
    </div>
  );
}
