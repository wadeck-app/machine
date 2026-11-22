import React from 'react';
import { FieldText } from '@wadeck-app/dsl-ui';
import { LIFETIME_PRESETS, lifetimeInput, type LifetimeChoice, type LifetimeKind } from '../lib/lifetimeChoice.js';
import { INPUT, TEXT_ERROR } from '../lib/styleTokens.js';

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
      {/* violations-suppress: react/no-raw-input a one-line select on the row of the buttons: FieldSelect always stacks a visible label above the control, which doubles the height of the card */}
      <select aria-label={label} title="How long the entry is allowed" className={INPUT} value={choice.kind} disabled={disabled} onChange={(e) => onChange({ ...choice, kind: e.target.value as LifetimeKind })}>
        {LIFETIME_PRESETS.map((p) => (
          <option key={p.kind} value={p.kind}>{p.label}</option>
        ))}
      </select>
      {choice.kind === 'custom' && (
        <>
          {/* violations-suppress: react/no-raw-input same as above: the kind of the custom limit, on the same row */}
          <select aria-label="Limit by" className={INPUT} value={choice.customKind} disabled={disabled} onChange={(e) => onChange({ ...choice, customKind: e.target.value as 'calls' | 'duration', customText: '' })}>
            {CUSTOM_KINDS.map((k) => (
              <option key={k.value} value={k.value}>{k.label}</option>
            ))}
          </select>
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
