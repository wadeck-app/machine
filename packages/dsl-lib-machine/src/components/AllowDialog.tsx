import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FieldSelect, FieldText } from '@wadeck-app/dsl-ui';
import { loadContext, prepareAllow, readAdminKeyHint, signAndSubmitAllow, type AllowApi, type AllowContext, type AllowPrepared, type AllowResult } from '../lib/allowFlow.js';
import { LIFETIME_PRESETS, lifetimeInput, lifetimeWords, type LifetimeChoice, type LifetimeKind } from '../lib/lifetimeChoice.js';
import { TEXT_ERROR, TEXT_MUTED_SM } from '../lib/styleTokens.js';
import { ConfirmSignModal } from './ConfirmSignModal.js';
import type { PendingRequestRow } from './AllowRequestsTable.js';

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; context: AllowContext; prepared: AllowPrepared; hint: string | undefined }
  | { kind: 'info'; message: string }
  | { kind: 'failed'; message: string }
  | { kind: 'signing'; context: AllowContext; prepared: AllowPrepared; hint: string | undefined };

export interface AllowDialogProps {
  row: PendingRequestRow;
  machine: { uuid: string; name: string };
  api: AllowApi;
  /** The lifetime preselected: `once` for a request a caller is waiting for (it runs once, then is refused again), `permanent` for the list of refused commands. Default permanent. */
  defaultLifetime?: Extract<LifetimeKind, 'once' | 'permanent'>;
  onClose: () => void;
  onDone: (result: AllowResult) => void;
}

const OPTIONS = LIFETIME_PRESETS.map((p) => ({ value: p.kind, label: p.label }));
const CUSTOM_KINDS = [
  { value: 'duration', label: 'A duration' },
  { value: 'calls', label: 'A number of calls' },
];

/** The sentence under the lifetime summary: what the entry lets EVERY trusted peer do, and until when. */
function warningText(machineName: string, peerText: string, words: string): string {
  return `This widens what peers may run on ${machineName}: the command is allowed to EVERY trusted peer, not only ${peerText}, byte for byte, ${words === 'permanent, until you remove it' ? 'until you remove it' : words === 'allowed once' ? 'for ONE call (the next matching call, from any peer, uses it up)' : words}. Only the admin passphrase can sign it.`;
}

/** The confirmation of ONE row: loads the context (after the PIN), shows the exact change and its lifetime, asks the passphrase, signs in the page and posts. */
export function AllowDialog({ row, machine, api, defaultLifetime = 'permanent', onClose, onDone }: AllowDialogProps) {
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
  const problem = !resolution.ok && choice.kind === 'custom' && choice.customText.trim() !== '' ? resolution.message : null;

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
    signAndSubmitAllow(api, context, { shell: row.shell, command: row.command, lifetime: resolution.flags }, passphrase, Math.floor(Date.now() / 1000)).then(
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
        setPhase({ kind: 'ready', context, prepared, hint });
      },
    );
  };

  if (phase.kind === 'loading') {
    return <ConfirmSignModal title={`Allow on ${machine.name}`} details={[]} warning="" needsPassphrase={false} confirmLabel="" onConfirm={() => undefined} onCancel={onClose} notes={['Checking the current policy...']} />;
  }
  if (phase.kind === 'info' || phase.kind === 'failed') {
    return <ConfirmSignModal title={`Allow on ${machine.name}`} details={[]} warning="" needsPassphrase={false} confirmLabel="" error={phase.kind === 'failed' ? phase.message : null} notes={phase.kind === 'info' ? [phase.message] : []} onConfirm={() => undefined} onCancel={onClose} />;
  }
  const { prepared, context, hint } = phase;
  const notes = [
    `Policy version ${prepared.fromVersion} -> ${prepared.toVersion}, edited from the one ${context.source}. After this change every trusted peer may run ${prepared.defaultCount} command${prepared.defaultCount === 1 ? '' : 's'} on ${machine.name}.`,
    ...(prepared.peersWithOwnList.length > 0 ? [`Not affected (they have their own list): ${prepared.peersWithOwnList.join(', ')}.`] : []),
    context.delivery === 'install' ? `It is signed here, in this page, and installed on ${machine.name} (this machine).` : `It is signed here, in this page, and stored in the relay inbox of ${machine.name}.`,
    ...(context.delivery === 'inbox' && context.noticeRecipients !== undefined
      ? [`The list of machines that receive request notices (information only, no right) is signed with it and sent to ${machine.name}${context.noticeRecipients.current === null ? ': none exists yet, a new one naming this machine is signed' : ' (the one already signed on this machine)'}.`]
      : []),
    ...(choice.kind !== 'permanent' && choice.kind !== 'once' && choice.kind !== 'custom' ? ['A duration counts from the moment you sign.'] : []),
  ];
  return (
    <ConfirmSignModal
      title={`Allow this command on ${machine.name}?`}
      details={[
        { label: 'Machine', value: machine.name },
        { label: 'Shell', value: row.shell },
        { label: 'Command', value: row.command },
        { label: 'Asked by', value: `${row.peerText} (${row.countText})` },
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
      <div className="flex flex-col gap-2" data-testid="lifetime-picker">
        <FieldSelect label="How long is it allowed?" value={choice.kind} onChange={(v) => setChoice({ ...choice, kind: v as LifetimeKind })} options={OPTIONS} disabled={phase.kind === 'signing'} />
        {choice.kind === 'custom' && (
          <div className="flex flex-wrap items-end gap-2">
            <FieldSelect label="Limit by" value={choice.customKind} onChange={(v) => setChoice({ ...choice, customKind: v as 'calls' | 'duration', customText: '' })} options={CUSTOM_KINDS} disabled={phase.kind === 'signing'} />
            <FieldText
              label={choice.customKind === 'calls' ? 'Number of calls (1 to 10000)' : 'Duration (like 30m, 2h, 7d; at most 365d)'}
              name="machine-allow-lifetime"
              autoComplete="off"
              value={choice.customText}
              disabled={phase.kind === 'signing'}
              onChange={(v) => setChoice({ ...choice, customText: v })}
            />
          </div>
        )}
        {problem !== null && <div role="alert" className={TEXT_ERROR}>{problem}</div>}
        {choice.kind === 'once' && <div className={TEXT_MUTED_SM}>The command runs once, then the next identical request is refused (or held) again.</div>}
      </div>
    </ConfirmSignModal>
  );
}
