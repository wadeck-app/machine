import React, { useEffect, useRef, useState } from 'react';
import { ButtonAction, Notice } from '@wadeck-app/dsl-ui';
import { allowRenewalOf, loadContext, prepareAllow, readAdminKeyHint, signAndSubmitAllow, type AllowApi, type AllowContext, type AllowResult } from '../lib/allowFlow.js';
import type { WaitingRenewal } from '@wadeck-app/machine-core';
import type { CallerAsk } from '../lib/callerAsk.js';
import { adminKeyHolder } from '../lib/adminKeyHolder.js';
import { lifetimeInput, lifetimeWords, type LifetimeChoice, type LifetimeResolution } from '../lib/lifetimeChoice.js';
import type { AllowDialogEvent } from './AllowDialog.js';
import { InlineAllowForm } from './InlineAllowForm.js';
import { MachineName } from './MachineName.js';
import { MachineText } from './MachineText.js';

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; context: AllowContext; hint: string | undefined }
  | { kind: 'signing' }
  | { kind: 'info'; message: string }
  | { kind: 'failed'; message: string };

export interface InlineAllowProps {
  row: { shell: string; command: string; peer?: string; renewal?: WaitingRenewal; ask?: CallerAsk };
  machine: { uuid: string; name: string };
  /** The lifetime decided on the card (its select): this component never asks for one. A valid choice (the card checked it). */
  choice: LifetimeChoice;
  /** Sign as soon as the policy is checked when the admin key is unlocked in this page (one click); locked, the compact passphrase form shows. */
  autoSign?: boolean;
  api: AllowApi;
  /** The progress of the owner (decision 86): `start` and `signed` when the signature is made, then `result`, or `failed` when the post did not go through. */
  onEvent: (event: AllowDialogEvent) => void;
  /** The form is no longer needed: cancelled, or the signature is made (the progress lives on the card). */
  onClose: () => void;
  onDone: (result: AllowResult) => void;
}

/**
 * The Allow of ONE held request, in the card (no modal). Same flow as AllowDialog: the current policy, the hint of the key, the passphrase, then the signature
 * in the page; the lifetime is the select of the card (`choice`). With `autoSign` and the admin key unlocked in this page it signs at once (one click). A
 * failure BEFORE the signature (wrong passphrase, stale policy) stays here with its cause and the form keeps working; once the policy is signed the form
 * leaves and the card shows the progress (with what was signed), and a later failure is the card's.
 */
export function InlineAllow({ row, machine, choice, autoSign = false, api, onEvent, onClose, onDone }: InlineAllowProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const renewal = allowRenewalOf(row);
  // The effect below runs once per request: the choice it signs with is the one of the click.
  const choiceRef = useRef(choice);

  // Signs `context` with the lifetime; `take` returns the passphrase once, or null when the key held in this page signs.
  const sign = (context: AllowContext, lifetime: Extract<LifetimeResolution, { ok: true }>, take: () => string | null) => {
    // The passphrase is a local variable of this call: read and cleared from the field at once, never stored, never passed anywhere but the signature.
    let passphrase = take();
    setError(null);
    setBusy(true);
    setPhase((p) => (p.kind === 'ready' ? p : { kind: 'signing' }));
    let signed = false;
    const now = Math.floor(Date.now() / 1000);
    signAndSubmitAllow(api, context, { shell: row.shell, command: row.command, lifetime: lifetime.flags, ...(renewal !== undefined ? { renewal } : {}) }, passphrase, now, () => {
      signed = true;
      // The policy is signed and the key locked: the card takes over and the form goes.
      const words = lifetimeWords(lifetime.limits(now), now);
      const what = renewal === undefined ? `${row.shell} ${JSON.stringify(row.command)}` : `renews ${row.shell} ${JSON.stringify(renewal.entry)}`;
      onEvent({ type: 'start' });
      onEvent({ type: 'signed', summary: { short: words, full: `${what} on ${machine.name}, ${words}` } });
      onClose();
    }).then(
      (result) => {
        passphrase = '';
        onEvent({ type: 'result', result });
        onDone(result);
      },
      (e: unknown) => {
        passphrase = '';
        const message = (e as Error).message;
        if (signed) {
          onEvent({ type: 'failed', message });
          return;
        }
        if (mounted.current) {
          setError(message);
          setBusy(false);
          // Back to the form (with the passphrase field when the key is locked now) to try again.
          setPhase((p) => (p.kind === 'ready' ? p : { kind: 'ready', context, hint: undefined }));
        }
      },
    );
  };

  useEffect(() => {
    mounted.current = true;
    (async () => {
      try {
        const context = await loadContext(api, machine.uuid);
        const prepared = await prepareAllow(context, { shell: row.shell, command: row.command, ...(renewal !== undefined ? { renewal } : {}) }, Math.floor(Date.now() / 1000));
        if (!mounted.current) {
          return;
        }
        // A permanent entry already there: nothing to sign (an entry with limits is renewed by the choice, checked again when signing).
        if (!prepared.changed) {
          setPhase({ kind: 'info', message: `${row.shell} ${JSON.stringify(row.command)} is already allowed on "${machine.name}": nothing to sign. The list catches up at its next refresh.` });
          return;
        }
        // One click: the key of this page signs at once, with the lifetime of the card. No hint, no field, no second button.
        const lifetime = lifetimeInput(choiceRef.current);
        if (autoSign && lifetime.ok && adminKeyHolder.current() !== null) {
          sign(context, lifetime, () => null);
          return;
        }
        // The hint is stored in clear: on screen before the passphrase is typed (a damaged key file stops here, with its fix).
        const hint = await readAdminKeyHint(api);
        if (mounted.current) {
          setPhase({ kind: 'ready', context, hint });
        }
      } catch (e) {
        if (mounted.current) {
          setPhase({ kind: 'failed', message: (e as Error).message });
        }
      }
    })();
    return () => {
      mounted.current = false;
    };
    // `sign` and `autoSign` are those of the click: the check of the policy must not restart when the parent re-renders.
  }, [api, machine.uuid, machine.name, row.shell, row.command, row.renewal, row.peer]);

  if (phase.kind === 'loading') {
    return <Notice variant="default" label="Checking the current policy..." />;
  }
  if (phase.kind === 'signing') {
    return <Notice variant="default" label="Signing..." />;
  }
  if (phase.kind === 'info' || phase.kind === 'failed') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {phase.kind === 'failed' ? <Notice variant="danger" label={phase.message} /> : <MachineText text={phase.message} names={[machine.name]} />}
        <ButtonAction label="Close" variant="secondary" size="sm" onClick={onClose} />
      </div>
    );
  }
  const { context, hint } = phase;
  return (
    <InlineAllowForm
      label={`Allow ${row.command}`}
      hint={hint}
      busy={busy}
      error={error}
      fixedChoice={choice}
      onCancel={onClose}
      onSubmit={(lifetime, take) => sign(context, lifetime, take)}
    />
  );
}
