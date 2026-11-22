import React, { useEffect, useMemo, useRef, useState } from 'react';
import { loadContext, prepareAllow, readAdminKeyHint, signAndSubmitAllow, type AllowApi, type AllowContext, type AllowPrepared, type AllowResult } from '../lib/allowFlow.js';
import type { ProgressEvent } from '../lib/allowProgress.js';
import { lifetimeInput, lifetimeWords, type LifetimeChoice, type LifetimeKind } from '../lib/lifetimeChoice.js';
import { ConfirmSignModal } from './ConfirmSignModal.js';
import { LifetimePicker } from './LifetimePicker.js';
import { MachineName } from './MachineName.js';
import { MachineText } from './MachineText.js';
import type { PendingRequestRow } from './AllowRequestsTable.js';

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; context: AllowContext; prepared: AllowPrepared; hint: string | undefined }
  | { kind: 'info'; message: string }
  | { kind: 'failed'; message: string }
  | { kind: 'signing'; context: AllowContext; prepared: AllowPrepared; hint: string | undefined };

/** What the dialog tells the owner of the progress (decision 86): `start` when the passphrase is taken, then the events of the signature and of the answer, `failed` when it did not go through. */
export type AllowDialogEvent = ProgressEvent | { type: 'start' };

export interface AllowDialogProps {
  row: PendingRequestRow;
  machine: { uuid: string; name: string };
  api: AllowApi;
  /** The lifetime preselected: `once` for a request a caller is waiting for (it runs once, then is refused again), `permanent` for the list of refused commands. Default permanent. */
  defaultLifetime?: Extract<LifetimeKind, 'once' | 'permanent'>;
  onClose: () => void;
  onDone: (result: AllowResult) => void;
  /**
   * The owner shows the progress on its own card (decision 86). When given, this dialog is only the CONFIRMATION: it closes itself (`onClose`) as soon as
   * the signing is submitted, and a failure of the signature or of the post is reported with the event `failed` (the card shows it and offers Allow
   * again). Absent (the table of refused commands): the dialog stays open and busy until the result, and shows a failure itself.
   */
  onEvent?: (event: AllowDialogEvent) => void;
}

/** The sentence under the lifetime summary: what the entry lets EVERY trusted peer do, and until when. */
function warningText(machineName: string, peerText: string, words: string): React.ReactNode {
  return (
    <>
      This widens what peers may run on <MachineName name={machineName} />: the command is allowed to EVERY trusted peer, not only <MachineName name={peerText} />, byte for byte, {words === 'permanent, until you remove it' ? 'until you remove it' : words === 'allowed once' ? 'for ONE call (the next matching call, from any peer, uses it up)' : words}. Only the admin passphrase can sign it.
    </>
  );
}

/** The confirmation of ONE row: loads the context (after the PIN), shows the exact change and its lifetime, asks the passphrase, signs in the page and posts. */
export function AllowDialog({ row, machine, api, defaultLifetime = 'permanent', onClose, onDone, onEvent }: AllowDialogProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<LifetimeChoice>({ kind: defaultLifetime, customKind: 'duration', customText: '' });
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
        // A permanent entry already there: nothing to sign. An entry with limits is not "already allowed": the choice below renews it (checked again when signing).
        if (!prepared.changed) {
          setPhase({ kind: 'info', message: `${row.shell} ${JSON.stringify(row.command)} is already allowed on "${machine.name}": nothing to sign. The list below catches up at its next refresh.` });
          return;
        }
        // The hint of the key is stored in clear: read it now, so it is on screen before the passphrase is typed (a damaged key file stops here, with its fix).
        const hint = await readAdminKeyHint(api);
        if (!mounted.current) {
          return;
        }
        setPhase({ kind: 'ready', context, prepared, hint });
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

  const resolution = useMemo(() => lifetimeInput(choice), [choice]);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const words = resolution.ok ? lifetimeWords(resolution.limits(nowSeconds), nowSeconds) : null;

  const confirm = (take: () => string) => {
    if (phase.kind !== 'ready') {
      return;
    }
    const { context, prepared, hint } = phase;
    // An invalid lifetime stops here, before the passphrase is taken: the field keeps what was typed and nothing is signed.
    if (!resolution.ok) {
      setError(resolution.message);
      return;
    }
    // The passphrase is a local variable of this call: read and cleared from the field at once, never stored, never passed anywhere but the signature.
    let passphrase = take();
    setError(null);
    setPhase({ kind: 'signing', context, prepared, hint });
    onEvent?.({ type: 'start' });
    // The passphrase is taken: with an owner that shows the progress on its card, this confirmation has done its job and goes away.
    if (onEvent !== undefined) {
      onClose();
    }
    signAndSubmitAllow(api, context, { shell: row.shell, command: row.command, lifetime: resolution.flags }, passphrase, Math.floor(Date.now() / 1000), () => onEvent?.({ type: 'signed' })).then(
      result => {
        passphrase = '';
        // The owner learns the result even when the dialog was closed meanwhile: the progress goes on in its card.
        onEvent?.({ type: 'result', result });
        onDone(result);
      },
      (e: unknown) => {
        passphrase = '';
        const message = (e as Error).message;
        if (onEvent !== undefined) {
          // The dialog is gone: the card shows the failure (and Allow again).
          onEvent({ type: 'failed', message });
          return;
        }
        if (!mounted.current) {
          return;
        }
        setError(message);
        setPhase({ kind: 'ready', context, prepared, hint });
      },
    );
  };

  if (phase.kind === 'loading') {
    return <ConfirmSignModal title={<>Allow on <MachineName name={machine.name} /></>} details={[]} warning="" needsPassphrase={false} confirmLabel="" onConfirm={() => undefined} onCancel={onClose} notes={['Checking the current policy...']} />;
  }
  if (phase.kind === 'info' || phase.kind === 'failed') {
    return <ConfirmSignModal title={<>Allow on <MachineName name={machine.name} /></>} details={[]} warning="" needsPassphrase={false} confirmLabel="" error={phase.kind === 'failed' ? phase.message : null} notes={phase.kind === 'info' ? [<MachineText key="info" text={phase.message} names={[machine.name]} />] : []} onConfirm={() => undefined} onCancel={onClose} />;
  }
  const { prepared, context, hint } = phase;
  const names = [machine.name];
  const notes: React.ReactNode[] = [
    <MachineText key="version" text={`Policy version ${prepared.fromVersion} -> ${prepared.toVersion}. Every trusted peer may then run ${prepared.defaultCount} command${prepared.defaultCount === 1 ? '' : 's'} on ${machine.name}.`} names={names} />,
    ...(prepared.peersWithOwnList.length > 0 ? [<MachineText key="own" text={`Not affected (their own list): ${prepared.peersWithOwnList.join(', ')}.`} names={prepared.peersWithOwnList} />] : []),
    <MachineText
      key="where"
      text={context.delivery === 'install' ? `Signed here, then installed on ${machine.name} (this machine).` : `Signed here, then sent to ${machine.name} directly, or stored in its relay inbox when it is not reachable.`}
      names={names}
    />,
    ...(context.delivery === 'inbox' && context.noticeRecipients !== undefined
      ? [<MachineText key="recipients" text={`The list of machines that receive request notices (information only, no right) goes with it${context.noticeRecipients.current === null ? ': none exists yet, a new one naming this machine is signed' : ' (the one already signed on this machine)'}.`} names={names} />]
      : []),
    ...(choice.kind !== 'permanent' && choice.kind !== 'once' && choice.kind !== 'custom' ? ['A duration counts from the moment you sign.'] : []),
  ];
  return (
    <ConfirmSignModal
      title={<>Allow this command on <MachineName name={machine.name} />?</>}
      details={[
        { label: 'Machine', value: <MachineName name={machine.name} /> },
        { label: 'Shell', value: row.shell },
        { label: 'Command', value: row.command },
        { label: 'Asked by', value: <><MachineName name={row.peerText} /> ({row.countText})</> },
        { label: 'Lifetime', value: words ?? 'not valid yet: see the field below' },
      ]}
      notes={notes}
      warning={warningText(machine.name, row.peerText, words ?? 'for the lifetime you enter')}
      confirmLabel="Allow and sign"
      busy={phase.kind === 'signing'}
      error={error}
      hint={hint ?? null}
      onConfirm={confirm}
      onCancel={onClose}
    >
      <LifetimePicker choice={choice} onChange={setChoice} busy={phase.kind === 'signing'} />
    </ConfirmSignModal>
  );
}
