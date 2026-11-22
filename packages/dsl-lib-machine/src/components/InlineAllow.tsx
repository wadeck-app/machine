import React, { useEffect, useRef, useState } from 'react';
import { ButtonAction } from '@wadeck-app/dsl-ui';
import { loadContext, prepareAllow, readAdminKeyHint, signAndSubmitAllow, type AllowApi, type AllowContext, type AllowResult } from '../lib/allowFlow.js';
import { TEXT_ERROR, TEXT_MUTED_SM } from '../lib/styleTokens.js';
import type { AllowDialogEvent } from './AllowDialog.js';
import { InlineAllowForm } from './InlineAllowForm.js';
import { MachineName } from './MachineName.js';
import { MachineText } from './MachineText.js';

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; context: AllowContext; hint: string | undefined }
  | { kind: 'info'; message: string }
  | { kind: 'failed'; message: string };

export interface InlineAllowProps {
  row: { shell: string; command: string };
  machine: { uuid: string; name: string };
  api: AllowApi;
  /** The progress of the owner (decision 86): `start` and `signed` when the signature is made, then `result`, or `failed` when the post did not go through. */
  onEvent: (event: AllowDialogEvent) => void;
  /** The form is no longer needed: cancelled, or the signature is made (the progress lives on the card). */
  onClose: () => void;
  onDone: (result: AllowResult) => void;
}

/**
 * The Allow of ONE held request, in the card (no modal). Same flow as AllowDialog: the PIN, the current policy, the hint of the key, the lifetime and the
 * passphrase, then the signature in the page. A failure BEFORE the signature (wrong passphrase, invalid lifetime) stays in the form with its cause and the
 * form keeps working; once the policy is signed the form leaves and the card shows the progress, and a later failure is the card's.
 */
export function InlineAllow({ row, machine, api, onEvent, onClose, onDone }: InlineAllowProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    (async () => {
      try {
        const context = await loadContext(api, machine.uuid);
        const prepared = await prepareAllow(context, { shell: row.shell, command: row.command }, Math.floor(Date.now() / 1000));
        if (!mounted.current) {
          return;
        }
        // A permanent entry already there: nothing to sign (an entry with limits is renewed by the choice, checked again when signing).
        if (!prepared.changed) {
          setPhase({ kind: 'info', message: `${row.shell} ${JSON.stringify(row.command)} is already allowed on "${machine.name}": nothing to sign. The list catches up at its next refresh.` });
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
  }, [api, machine.uuid, machine.name, row.shell, row.command]);

  if (phase.kind === 'loading') {
    return <div className={TEXT_MUTED_SM}>Checking the current policy...</div>;
  }
  if (phase.kind === 'info' || phase.kind === 'failed') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {phase.kind === 'failed' ? <div role="alert" className={TEXT_ERROR}>{phase.message}</div> : <MachineText text={phase.message} names={[machine.name]} />}
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
      warning={(words) => (
        <>
          Widens rights: every trusted peer may run this on <MachineName name={machine.name} />, byte for byte, {words}.
        </>
      )}
      onCancel={onClose}
      onSubmit={(lifetime, take) => {
        // The passphrase is a local variable of this call: read and cleared from the field at once, never stored, never passed anywhere but the signature.
        let passphrase = take();
        setError(null);
        setBusy(true);
        let signed = false;
        signAndSubmitAllow(api, context, { shell: row.shell, command: row.command, lifetime: lifetime.flags }, passphrase, Math.floor(Date.now() / 1000), () => {
          signed = true;
          // The policy is signed and the key locked: the card takes over and the form goes.
          onEvent({ type: 'start' });
          onEvent({ type: 'signed' });
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
            }
          },
        );
      }}
    />
  );
}
