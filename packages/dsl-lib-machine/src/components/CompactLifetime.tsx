import React from 'react';
import { CompactSelect, FieldText } from '@wadeck-app/dsl-ui';
import { LIFETIME_PRESETS, lifetimeInput, type LifetimeChoice, type LifetimeKind } from '../lib/lifetimeChoice.js';
import { TEXT_ERROR } from '../lib/styleTokens.js';

// The lifetime of an Allow as ONE small select on the row of the buttons of a card (the default is visible, changeable before the click). "Custom" adds a
// kind select and a field next to it. The long explanation of each lifetime is not here: it is in the Details of the card.

export interface CompactLifetimeProps {
  /** Names the select for a screen reader and a test ("Lifetime"). */
  label?: string;
  choice: LifetimeChoice;
  onChange: (choice: LifetimeChoice) => void;
  disabled?: boolean;
  /** A message the owner must read (an invalid custom lifetime found at the click). */
  problem?: string | null;
}

const PRESET_OPTIONS = LIFETIME_PRESETS.map((p) => ({ value: p.kind, label: p.label }));

const CUSTOM_KINDS = [
  { value: 'duration', label: 'A duration' },
  { value: 'calls', label: 'A number of calls' },
];

export function CompactLifetime({ label = 'Lifetime', choice, onChange, disabled = false, problem = null }: CompactLifetimeProps) {
  const resolution = lifetimeInput(choice);
  const typed = !resolution.ok && choice.kind === 'custom' && choice.customText.trim() !== '' ? resolution.message : null;
  const shown = problem ?? typed;
  return (
    <>
      <CompactSelect size="sm" ariaLabel={label} value={choice.kind} options={PRESET_OPTIONS} disabled={disabled} onChange={(v) => onChange({ ...choice, kind: v as LifetimeKind })} />
      {choice.kind === 'custom' && (
        <>
          <CompactSelect size="sm" ariaLabel="Limit by" value={choice.customKind} options={CUSTOM_KINDS} disabled={disabled} onChange={(v) => onChange({ ...choice, customKind: v as 'calls' | 'duration', customText: '' })} />
          <div className="w-32">
            <FieldText
              label={choice.customKind === 'calls' ? 'Number of calls (1 to 10000)' : 'Duration (like 30m, 2h, 7d; at most 365d)'}
              name="machine-allow-lifetime"
              autoComplete="off"
              value={choice.customText}
              disabled={disabled}
              onChange={(v) => onChange({ ...choice, customText: v })}
            />
          </div>
        </>
      )}
      {shown !== null && <div role="alert" className={`w-full ${TEXT_ERROR}`}>{shown}</div>}
    </>
  );
}
