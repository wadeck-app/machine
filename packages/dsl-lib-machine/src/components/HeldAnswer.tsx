import React, { useState } from 'react';
import { ButtonAction, Notice, Text } from '@wadeck-app/dsl-ui';
import type { WaitingRenewal } from '@wadeck-app/machine-core';
import type { AllowApi, AllowResult } from '../lib/allowFlow.js';
import type { CallerAsk } from '../lib/callerAsk.js';
import { lifetimeInput, type LifetimeChoice } from '../lib/lifetimeChoice.js';
import { cardFlags } from '../lib/quickAllow.js';
import type { AllowDialogEvent } from './AllowDialog.js';
import { CompactLifetime } from './CompactLifetime.js';
import { InlineAllow } from './InlineAllow.js';
import { useAdminKey } from './useAdminKey.js';

// The answer of a held card: ONE row (lifetime select, Allow, Deny). With the admin key unlocked in the page Allow signs at once with the lifetime of the
// select, flagged lifetime or not (the badges only inform); in Safer mode (off by default) a FLAGGED lifetime (permanent, 50 calls or more, more than 7 days, or a caller ask of that size) needs a second click; with the key locked Allow
// expands the compact passphrase form of the card (Enter signs), or opens the dialog in dialog style.

export interface HeldAnswerProps {
  row: { id: string; shell: string; command: string; nextCommand: string; renewal?: WaitingRenewal; ask?: CallerAsk; peer?: string };
  machine: { uuid: string; name: string };
  canAllow: boolean;
  /** `inline`: the form of a locked key opens in the card. Else the confirmation dialog (`onOpenDialog`) opens, and the select shows only while the key is unlocked. */
  inline: boolean;
  /** Safer mode (default off): a flagged lifetime needs a second click ("Confirm allow") when the key is unlocked. */
  saferMode?: boolean;
  api: AllowApi;
  choice: LifetimeChoice;
  onChoice: (choice: LifetimeChoice) => void;
  onEvent: (event: AllowDialogEvent) => void;
  onDone: (result: AllowResult) => void;
  onOpenDialog: () => void;
  onDeny: () => void;
}

type Phase = 'idle' | 'confirm' | 'sign';

export function HeldAnswer({ row, machine, canAllow, inline, saferMode = false, api, choice, onChoice, onEvent, onDone, onOpenDialog, onDeny }: HeldAnswerProps) {
  const { unlocked } = useAdminKey();
  const [phase, setPhase] = useState<Phase>('idle');
  // `auto`: the click found the key unlocked, so the policy is signed as soon as it is checked.
  const [auto, setAuto] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const flags = cardFlags(choice, row.ask);
  const showSelect = canAllow && (inline || unlocked);

  const go = () => {
    const lifetime = lifetimeInput(choice);
    if (!lifetime.ok) {
      setProblem(lifetime.message);
      return;
    }
    setProblem(null);
    if (!inline && !unlocked) {
      onOpenDialog();
      return;
    }
    // Safer mode only (off by default, user decision 2026-11-22): a flagged lifetime is not signed by one click of an unlocked key. A locked key asks for the passphrase, which is the explicit step.
    if (saferMode && unlocked && flags.length > 0 && phase !== 'confirm') {
      setPhase('confirm');
      return;
    }
    setAuto(unlocked);
    setPhase('sign');
  };

  if (phase === 'sign') {
    return (
      <div className="flex flex-col gap-1.5">
        {/* The lifetime that will be signed stays in view, frozen while the form is open (Cancel to change it). */}
        {showSelect && (
          <div className="flex flex-wrap items-center gap-2">
            <CompactLifetime choice={choice} onChange={onChoice} disabled />
          </div>
        )}
        <InlineAllow row={row} machine={machine} choice={choice} autoSign={auto} api={api} onEvent={onEvent} onClose={() => setPhase('idle')} onDone={onDone} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {/* The buttons say "Allow" and "Deny": the group tells which request they answer (the design-system button has no aria-label). */}
      <div role="group" aria-label={`Answer ${row.command}`} className="flex flex-wrap items-center gap-2">
        {showSelect && <CompactLifetime choice={choice} onChange={onChoice} disabled={phase === 'confirm'} problem={problem} />}
        {canAllow ? (
          phase === 'confirm' ? (
            <>
              <ButtonAction label="Confirm allow" variant="primary" size="sm" onClick={go} />
              <ButtonAction label="Cancel" variant="secondary" size="sm" onClick={() => setPhase('idle')} />
            </>
          ) : (
            <span title={saferMode && flags.length > 0 ? `Flagged: ${flags.join('; ')}. With the admin key unlocked, Allow asks for a second click before it signs.` : undefined}>
              <ButtonAction label="Allow" variant="primary" size="sm" onClick={go} />
            </span>
          )
        ) : (
          <span className="break-all"><Text mono size="xs" text={row.nextCommand} /></span>
        )}
        {phase !== 'confirm' && <ButtonAction label="Deny" variant="danger-outline" size="sm" onClick={onDeny} />}
      </div>
      {phase === 'confirm' && (
        <div data-testid="flagged-line" className="text-xs text-muted">
          Flagged: {flags.join('; ')}. A flagged lifetime needs a second click: Confirm allow signs it, Cancel signs nothing.
        </div>
      )}
      {problem !== null && !showSelect && <Notice variant="danger" label={problem} />}
    </div>
  );
}
