import React from 'react';
import { Switch } from '@wadeck-app/dsl-ui';
import { TEXT_ERROR } from '../lib/styleTokens.js';

export interface SaferModeSwitchProps {
  value: boolean;
  onChange: (on: boolean) => void;
  /** Why the choice is not remembered (the storage refused or held a foreign value): one short line. */
  problem?: string | undefined;
}

const TITLE = 'Off: Allow signs in one click for every lifetime. On: a permanent, 50 calls or more, or over 7 days lifetime needs a second click (Confirm allow).';

/** The switch `Safer mode: confirm risky lifetimes` of the Requests page (off by default): the dsl-ui Switch (role=switch), not a checkbox. */
export function SaferModeSwitch({ value, onChange, problem }: SaferModeSwitchProps) {
  return (
    <div className="flex flex-col gap-1">
      <span title={TITLE}>
        <Switch label="Safer mode: confirm risky lifetimes" checked={value} onChange={onChange} size="sm" />
      </span>
      {problem !== undefined && problem !== '' && <div role="alert" className={TEXT_ERROR}>{problem}</div>}
    </div>
  );
}
