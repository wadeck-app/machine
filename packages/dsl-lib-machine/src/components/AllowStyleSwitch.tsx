import React, { useRef } from 'react';
import type { AllowStyle } from '../lib/allowStyle.js';
import { TEXT_ERROR, TEXT_MUTED } from '../lib/styleTokens.js';

export interface AllowStyleSwitchProps {
  value: AllowStyle;
  onChange: (style: AllowStyle) => void;
  /** Why the choice is not remembered (the storage refused or held a foreign value): one short line. */
  problem?: string | undefined;
}

const OPTIONS: ReadonlyArray<{ value: AllowStyle; label: string }> = [
  { value: 'dialog', label: 'Dialog' },
  { value: 'inline', label: 'Inline' },
];

const BASE = 'px-4 py-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary';
const CHECKED = `${BASE} bg-primary text-on-solid`;
const UNCHECKED = `${BASE} bg-surface text-content hover:bg-border`;

/**
 * The segmented control `Allow style: Dialog | Inline` of the Requests page: how Allow asks (a confirmation dialog, or a form in the card). A radiogroup:
 * Tab reaches the checked option, the arrows move and choose.
 */
export function AllowStyleSwitch({ value, onChange, problem }: AllowStyleSwitchProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (from: number, step: number) => {
    const to = (from + step + OPTIONS.length) % OPTIONS.length;
    onChange((OPTIONS[to] as (typeof OPTIONS)[number]).value);
    refs.current[to]?.focus();
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className={`text-sm ${TEXT_MUTED}`}>Allow style:</span>
        <div role="radiogroup" aria-label="Allow style" className="inline-flex overflow-hidden rounded-lg border border-border">
          {OPTIONS.map((o, i) => {
            const checked = o.value === value;
            return (
              // violations-suppress: react/no-raw-button a segmented radio needs role=radio, aria-checked and a roving tabindex, which ButtonAction and ChipButton do not forward
              <button
                key={o.value}
                ref={(el) => {
                  refs.current[i] = el;
                }}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={checked ? 0 : -1}
                className={checked ? CHECKED : UNCHECKED}
                onClick={() => onChange(o.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    move(i, 1);
                  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    move(i, -1);
                  }
                }}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      </div>
      {problem !== undefined && problem !== '' && <div role="alert" className={TEXT_ERROR}>{problem}</div>}
    </div>
  );
}
