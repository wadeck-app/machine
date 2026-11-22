import React from 'react';
import { FieldSelect, FieldText } from '@wadeck-app/dsl-ui';
import { LIFETIME_PRESETS, lifetimeInput, type LifetimeChoice, type LifetimeKind } from '../lib/lifetimeChoice.js';
import { TEXT_ERROR, TEXT_MUTED_SM } from '../lib/styleTokens.js';

// The lifetime choice of an Allow (once, a preset duration, permanent, custom): the same controls in the confirmation dialog and in the inline forms.

const OPTIONS = LIFETIME_PRESETS.map((p) => ({ value: p.kind, label: p.label }));
const CUSTOM_KINDS = [
  { value: 'duration', label: 'A duration' },
  { value: 'calls', label: 'A number of calls' },
];

export interface LifetimePickerProps {
  choice: LifetimeChoice;
  onChange: (choice: LifetimeChoice) => void;
  /** True while the signature is made. */
  busy?: boolean;
}

export function LifetimePicker({ choice, onChange, busy = false }: LifetimePickerProps) {
  const resolution = lifetimeInput(choice);
  const problem = !resolution.ok && choice.kind === 'custom' && choice.customText.trim() !== '' ? resolution.message : null;
  return (
    <div className="flex flex-col gap-2" data-testid="lifetime-picker">
      <FieldSelect label="How long is it allowed?" value={choice.kind} onChange={(v) => onChange({ ...choice, kind: v as LifetimeKind })} options={OPTIONS} disabled={busy} />
      {choice.kind === 'custom' && (
        <div className="flex flex-wrap items-end gap-2">
          <FieldSelect label="Limit by" value={choice.customKind} onChange={(v) => onChange({ ...choice, customKind: v as 'calls' | 'duration', customText: '' })} options={CUSTOM_KINDS} disabled={busy} />
          <FieldText
            label={choice.customKind === 'calls' ? 'Number of calls (1 to 10000)' : 'Duration (like 30m, 2h, 7d; at most 365d)'}
            name="machine-allow-lifetime"
            autoComplete="off"
            value={choice.customText}
            disabled={busy}
            onChange={(v) => onChange({ ...choice, customText: v })}
          />
        </div>
      )}
      {problem !== null && <div role="alert" className={TEXT_ERROR}>{problem}</div>}
      {choice.kind === 'once' && <div className={TEXT_MUTED_SM}>The command runs once, then the next identical request is refused (or held) again.</div>}
    </div>
  );
}
