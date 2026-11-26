import React from 'react';
import { RadioGroup } from '@wadeck-app/dsl-ui';
import type { AllowStyle } from '../lib/allowStyle.js';
import { TEXT_ERROR } from '../lib/styleTokens.js';

export interface AllowStyleSwitchProps {
  value: AllowStyle;
  onChange: (style: AllowStyle) => void;
  /** Why the choice is not remembered (the storage refused or held a foreign value): one short line. */
  problem?: string | undefined;
}

const OPTIONS = [
  { value: 'dialog', label: 'Dialog' },
  { value: 'inline', label: 'Inline' },
];

/**
 * The choice `Allow style: Dialog | Inline` of the Requests page: how Allow asks (a confirmation dialog, or a form in the card). The dsl-ui RadioGroup
 * (a radiogroup: Tab reaches the checked option, the arrows move and choose).
 */
export function AllowStyleSwitch({ value, onChange, problem }: AllowStyleSwitchProps) {
  return (
    <div className="flex flex-col gap-1">
      <RadioGroup label="Allow style" orientation="horizontal" options={OPTIONS} value={value} onChange={(v) => onChange(v as AllowStyle)} />
      {problem !== undefined && problem !== '' && <div role="alert" className={TEXT_ERROR}>{problem}</div>}
    </div>
  );
}
