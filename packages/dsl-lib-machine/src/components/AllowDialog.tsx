import React, { useEffect, useRef, useState } from 'react';
import { loadContext, prepareAllow, signAndSubmitAllow, type AllowApi, type AllowContext, type AllowPrepared, type AllowResult } from '../lib/allowFlow.js';
import { ConfirmSignModal } from './ConfirmSignModal.js';
import type { PendingRequestRow } from './AllowRequestsTable.js';

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; context: AllowContext; prepared: AllowPrepared }
  | { kind: 'info'; message: string }
  | { kind: 'failed'; message: string }
  | { kind: 'signing'; context: AllowContext; prepared: AllowPrepared };

export interface AllowDialogProps {
  row: PendingRequestRow;
  machine: { uuid: string; name: string };
  api: AllowApi;
  onClose: () => void;
  onDone: (result: AllowResult) => void;
}

/** The confirmation of ONE row: loads the context (after the PIN), shows the exact change, asks the passphrase, signs in the page and posts. */
export function AllowDialog({ row, machine, api, onClose, onDone }: AllowDialogProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
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
        if (!prepared.changed) {
          setPhase({ kind: 'info', message: `${row.shell} ${JSON.stringify(row.command)} is already allowed on "${machine.name}": nothing to sign. The list below catches up at its next refresh.` });
          return;
        }
        setPhase({ kind: 'ready', context, prepared });
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

  const confirm = (take: () => string) => {
    if (phase.kind !== 'ready') {
      return;
    }
    const { context, prepared } = phase;
    // The passphrase is a local variable of this call: read and cleared from the field at once, never stored, never passed anywhere but the signature.
    let passphrase = take();
    setError(null);
    setPhase({ kind: 'signing', context, prepared });
    signAndSubmitAllow(api, context, { shell: row.shell, command: row.command }, passphrase, Math.floor(Date.now() / 1000)).then(
      result => {
        passphrase = '';
        if (mounted.current) {
          onDone(result);
        }
      },
      (e: unknown) => {
        passphrase = '';
        if (!mounted.current) {
          return;
        }
        setError((e as Error).message);
        setPhase({ kind: 'ready', context, prepared });
      },
    );
  };

  if (phase.kind === 'loading') {
    return <ConfirmSignModal title={`Allow on ${machine.name}`} details={[]} warning="" needsPassphrase={false} confirmLabel="" onConfirm={() => undefined} onCancel={onClose} notes={['Checking the current policy...']} />;
  }
  if (phase.kind === 'info' || phase.kind === 'failed') {
    return <ConfirmSignModal title={`Allow on ${machine.name}`} details={[]} warning="" needsPassphrase={false} confirmLabel="" error={phase.kind === 'failed' ? phase.message : null} notes={phase.kind === 'info' ? [phase.message] : []} onConfirm={() => undefined} onCancel={onClose} />;
  }
  const { prepared, context } = phase;
  const notes = [
    `Policy version ${prepared.fromVersion} -> ${prepared.toVersion}, edited from the one ${context.source}. After this change every trusted peer may run ${prepared.defaultCount} command${prepared.defaultCount === 1 ? '' : 's'} on ${machine.name}.`,
    ...(prepared.peersWithOwnList.length > 0 ? [`Not affected (they have their own list): ${prepared.peersWithOwnList.join(', ')}.`] : []),
    context.delivery === 'install' ? `It is signed here, in this page, and installed on ${machine.name} (this machine).` : `It is signed here, in this page, and stored in the relay inbox of ${machine.name}.`,
  ];
  return (
    <ConfirmSignModal
      title={`Allow this command on ${machine.name}?`}
      details={[
        { label: 'Machine', value: machine.name },
        { label: 'Shell', value: row.shell },
        { label: 'Command', value: row.command },
        { label: 'Asked by', value: `${row.peerText} (${row.countText})` },
      ]}
      notes={notes}
      warning={`This widens what peers may run on ${machine.name}: the command is allowed to EVERY trusted peer, not only ${row.peerText}, byte for byte, until you remove it. Only the admin passphrase can sign it.`}
      confirmLabel="Allow and sign"
      busy={phase.kind === 'signing'}
      error={error}
      onConfirm={confirm}
      onCancel={onClose}
    />
  );
}
