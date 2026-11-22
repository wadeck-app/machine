import React from 'react';
import { TEXT_ERROR, TEXT_MUTED } from '../lib/styleTokens.js';

export interface SaferModeSwitchProps {
  value: boolean;
  onChange: (on: boolean) => void;
  /** Why the choice is not remembered (the storage refused or held a foreign value): one short line. */
  problem?: string | undefined;
}

const TITLE = 'Off: Allow signs in one click for every lifetime. On: a permanent, 50 calls or more, or over 7 days lifetime needs a second click (Confirm allow).';

const TRACK = 'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary';
const KNOB = 'inline-block h-3.5 w-3.5 rounded-full bg-content transition-transform';

/** The switch `Safer mode: confirm risky lifetimes` of the Requests page (off by default): a role=switch button, not a checkbox. */
export function SaferModeSwitch({ value, onChange, problem }: SaferModeSwitchProps) {
  return (
    <div className="flex flex-col gap-1">
      <span title={TITLE} className="inline-flex items-center gap-2">
        {/* violations-suppress: react/no-raw-button a switch needs role=switch and aria-checked, which ButtonAction and ChipButton do not forward */}
        <button type="button" role="switch" aria-checked={value} aria-label="Safer mode: confirm risky lifetimes" className={`${TRACK} ${value ? 'bg-primary' : 'bg-surface'}`} onClick={() => onChange(!value)}>
          <span className={`${KNOB} ${value ? 'translate-x-4' : 'translate-x-0.5'}`} />
        </button>
        <span className={`text-sm ${TEXT_MUTED}`} aria-hidden="true">Safer mode: confirm risky lifetimes</span>
      </span>
      {problem !== undefined && problem !== '' && <div role="alert" className={TEXT_ERROR}>{problem}</div>}
    </div>
  );
}
