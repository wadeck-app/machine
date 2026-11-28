import React from 'react';
import { Badge, type BadgeVariant } from '@wadeck-app/dsl-ui';
import { stepsOf, type ProgressRecord, type StepState } from '../lib/allowProgress.js';
import { deliverySummary } from '../lib/deliverySummary.js';
import { MachineText } from './MachineText.js';
import { STATE_WORDS } from './AllowProgress.js';
import { StepMarker } from './StepMarker.js';
import { TEXT_MUTED } from '../lib/styleTokens.js';

// The content of the Details disclosure of a request: the vertical steps (state in words) and the long explanation of the delivery. What the row above the
// stepper already says (the outcome, the cause of a failure) is NOT said again here. The list is a polite live region: a change of step is announced.

const STATE_VARIANT: Record<StepState, BadgeVariant> = { done: 'success', active: 'primary', pending: 'default', failed: 'danger', skipped: 'default' };

export function AllowProgressDetails({ record }: { record: ProgressRecord }) {
  const steps = stepsOf(record, 0);
  const names = [record.machineName];
  const explanation = record.result !== undefined ? deliverySummary(record.result).explanation : undefined;
  return (
    <div className="flex flex-col gap-1 text-sm">
      <div aria-live="polite" data-testid="allow-progress-steps">
        <ol className="flex flex-col gap-0.5">
          {steps.map((s) => (
            <li key={s.id} className="flex flex-col">
              <span className="flex items-center gap-2">
                <StepMarker state={s.state} />
                <Badge label={STATE_WORDS[s.state]} variant={STATE_VARIANT[s.state]} tone="subtle" />
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
      {record.signedSummary !== undefined && (
        <p data-testid="signed-summary" className="text-xs">
          <MachineText text={`Signed: ${record.signedSummary.full}`} names={names} />
        </p>
      )}
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
