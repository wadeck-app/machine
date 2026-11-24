import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Checkbox } from '@wadeck-app/dsl-ui';
import { loadContext, readAdminKeyHint, type AllowApi, type AllowContext } from '../lib/allowFlow.js';
import { editNotDelivered, editOutcome, prepareEdit, RECORDED_BUT_NOT_DELIVERED, signAndSubmitEdit, type EditAction, type EditOutcome, type EditPrepared, type EditRef } from '../lib/allowedEdit.js';
import { lifetimeInput, lifetimeWords, type LifetimeChoice } from '../lib/lifetimeChoice.js';
import { cardFlags } from '../lib/quickAllow.js';
import { OUTCOME_WARNING, TEXT_MUTED_SM } from '../lib/styleTokens.js';
import type { AllowedEntryData, AllowedMachineData } from './AllowedList.js';
import { ConfirmSignModal } from './ConfirmSignModal.js';
import { LifetimePicker } from './LifetimePicker.js';
import { MachineName } from './MachineName.js';
import { useAdminKey } from './useAdminKey.js';

// The confirmation of a delete or a change of lifetime on the Allowed page (decision 112): the machine, the shell(s), the EXACT command(s) and what happens,
// then the admin passphrase (or one click when the key is unlocked in this page, decision 92). The next policy is computed here from the verified base
// (allowedEdit.ts); a policy that moved since the page was read is refused BEFORE the passphrase with the fix.

export interface AllowedEditDialogProps {
  machine: AllowedMachineData;
  /** The selected rows: the exact entries that are listed, whatever the page shows now. */
  rows: AllowedEntryData[];
  action: EditAction['kind'];
  api: AllowApi;
  /** Safer mode of the Requests page (decision 98), read from the same browser storage. */
  saferMode: boolean;
  onClose: () => void;
  /** The change is signed and recorded: the page reads the list again and shows the line. */
  onDone: (outcome: EditOutcome) => void;
}

type Phase = { kind: 'loading' } | { kind: 'ready'; context: AllowContext; hint: string | undefined } | { kind: 'failed'; message: string };

const LIST = 'max-h-40 overflow-y-auto';
const START_CHOICE: LifetimeChoice = { kind: 'once', customKind: 'duration', customText: '' };

const refOf = (r: AllowedEntryData): EditRef => ({ shell: r.shell, text: r.text, index: r.index, peerUuid: r.peerUuid });
const plural = (n: number): string => `${n} allowed command${n === 1 ? '' : 's'}`;

export function AllowedEditDialog({ machine, rows, action, api, saferMode, onClose, onDone }: AllowedEditDialogProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [choice, setChoice] = useState<LifetimeChoice>(START_CHOICE);
  const [preview, setPreview] = useState<{ prepared: EditPrepared } | { problem: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const { unlocked } = useAdminKey();
  const mounted = useRef(true);
  const latest = useRef(0);
  const refs = useMemo(() => rows.map(refOf), [rows]);
  const resolution = useMemo(() => lifetimeInput(choice), [choice]);

  useEffect(() => {
    mounted.current = true;
    (async () => {
      try {
        const context = await loadContext(api, machine.uuid);
        // Everything the policy can refuse is refused now, before the passphrase (a policy that moved, a base the pinned key did not sign).
        if (action === 'delete') {
          const prepared = await prepareEdit(context, machine.version ?? 0, refs, { kind: 'delete' }, Math.floor(Date.now() / 1000));
          if (mounted.current) {
            setPreview({ prepared });
          }
        }
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
    // One load per dialog: the selection and the machine are those of the click.
  }, [api, machine.uuid, machine.version, action, refs]);

  // A new lifetime: the next policy again for each choice (no secret involved).
  const context = phase.kind === 'ready' ? phase.context : undefined;
  useEffect(() => {
    if (action !== 'lifetime' || context === undefined || !resolution.ok) {
      return;
    }
    const mine = ++latest.current;
    prepareEdit(context, machine.version ?? 0, refs, { kind: 'lifetime', lifetime: resolution.flags }, Math.floor(Date.now() / 1000)).then(
      (prepared) => {
        if (mine === latest.current && mounted.current) {
          setPreview({ prepared });
        }
      },
      (e: unknown) => {
        if (mine === latest.current && mounted.current) {
          setPreview({ problem: (e as Error).message });
        }
      },
    );
  }, [action, context, resolution, machine.version, refs]);

  const name = machine.name;
  const title = action === 'delete' ? <>Delete {plural(rows.length)} on <MachineName name={name} />?</> : <>Change the lifetime of {plural(rows.length)} on <MachineName name={name} />?</>;

  if (phase.kind === 'loading') {
    return <ConfirmSignModal title={title} details={[]} warning="" needsPassphrase={false} confirmLabel="" onConfirm={() => undefined} onCancel={onClose} notes={['Checking the current policy...']} />;
  }
  if (phase.kind === 'failed' || (action === 'delete' && (preview === null || 'problem' in preview))) {
    const message = phase.kind === 'failed' ? phase.message : preview !== null && 'problem' in preview ? preview.problem : '';
    return <ConfirmSignModal title={title} details={[]} warning="" needsPassphrase={false} confirmLabel="" error={message} onConfirm={() => undefined} onCancel={onClose} />;
  }

  const prepared = preview !== null && 'prepared' in preview ? preview.prepared : undefined;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const words = resolution.ok ? lifetimeWords(resolution.limits(nowSeconds), nowSeconds) : null;
  const flags = action === 'lifetime' ? cardFlags(choice, undefined) : [];
  // Safer mode (decision 98): a flagged lifetime is not signed by one click of an unlocked key. A locked key asks the passphrase, which is the explicit step.
  const needsAck = saferMode && unlocked && flags.length > 0;
  const shells = [...new Set(rows.map((r) => r.shell))].join(', ');

  const where = (r: AllowedEntryData): string => (r.peerName === '' ? '' : ` (own list of ${r.peerName})`);
  const lifetimeOf = (r: AllowedEntryData): { before: string; after: string; widens: boolean } | undefined => {
    const e = prepared?.entries.find((x) => x.ref.index === r.index && x.ref.peerUuid === r.peerUuid);
    return e === undefined ? undefined : { before: e.lifetimeBefore, after: e.lifetimeAfter ?? '', widens: e.widens === true };
  };

  const commands: React.ReactNode =
    rows.length === 1 ? (
      (rows[0] as AllowedEntryData).text + where(rows[0] as AllowedEntryData)
    ) : (
      <ul aria-label="Commands" className={LIST}>
        {rows.map((r) => {
          const life = action === 'lifetime' ? lifetimeOf(r) : undefined;
          return (
            <li key={r.key}>
              {`${r.shell} ${r.text}${where(r)}`}
              {life === undefined ? null : <span className="text-muted">{`: ${life.before} -> ${life.after}${life.widens ? ' (widens)' : ''}`}</span>}
            </li>
          );
        })}
      </ul>
    );

  const only = rows.length === 1 ? lifetimeOf(rows[0] as AllowedEntryData) : undefined;
  const notes: React.ReactNode[] = [];
  if (prepared !== undefined) {
    notes.push(`Policy version ${prepared.fromVersion} -> ${prepared.toVersion}. Every trusted peer without a list of its own may then run ${prepared.defaultCount} command${prepared.defaultCount === 1 ? '' : 's'} on ${name}.`);
    if (prepared.emptiedPeerLists.length > 0) {
      const named = prepared.emptiedPeerLists.map((uuid) => rows.find((r) => r.peerUuid === uuid)?.peerName ?? uuid).join(', ');
      notes.push(`The own list of ${named} will be EMPTY: a peer with a list of its own uses only that list, so it may then run nothing on ${name}.`);
    }
    if (prepared.emptiedDefaults) {
      notes.push(`The default list will be EMPTY: every trusted peer without a list of its own is refused every command on ${name}.`);
    }
    if (action === 'lifetime') {
      notes.push('Each changed entry is replaced by itself with the new lifetime: its counter starts again. A duration counts from the moment you sign.');
    }
    notes.push(machine.isSelf ? `Signed here, then installed on ${name} (this machine).` : `Signed here, then sent to ${name} directly, or stored in its relay inbox when it is not reachable.`);
  }

  const confirm = (take: () => string | null) => {
    if (action === 'lifetime' && !resolution.ok) {
      setError(resolution.message);
      return;
    }
    if (prepared === undefined) {
      setError(preview !== null && 'problem' in preview ? preview.problem : 'The next policy is not ready yet (the current policy is still being checked): try again in a moment. Nothing was signed.');
      return;
    }
    if (needsAck && !acknowledged) {
      setError(`Safer mode is on and this lifetime is flagged (${flags.join('; ')}): tick "I understand" to sign it, or choose another lifetime. Nothing was signed.`);
      return;
    }
    // The passphrase is a local variable of this call: read and cleared from the field at once, never stored, never passed anywhere but the signature.
    let passphrase = take();
    setError(null);
    setBusy(true);
    const now = Math.floor(Date.now() / 1000);
    const { context: ctx } = phase;
    // A lifetime change signs what the person sees NOW: the policy is prepared again from the choice at the time of the signature.
    const run = async () => {
      const toSign = action === 'lifetime' && resolution.ok ? await prepareEdit(ctx, machine.version ?? 0, refs, { kind: 'lifetime', lifetime: resolution.flags }, now) : prepared;
      return { toSign, result: await signAndSubmitEdit(api, ctx, toSign, passphrase, now) };
    };
    run().then(
      ({ toSign, result }) => {
        passphrase = '';
        onDone(editOutcome(toSign, name, result));
      },
      (e: unknown) => {
        passphrase = '';
        const message = (e as Error).message;
        if (RECORDED_BUT_NOT_DELIVERED.test(message)) {
          onDone(editNotDelivered(prepared, name, message));
          return;
        }
        if (mounted.current) {
          setError(message);
          setBusy(false);
        }
      },
    );
  };

  return (
    <ConfirmSignModal
      title={title}
      details={[
        { label: 'Machine', value: <MachineName name={name} /> },
        { label: 'Shell', value: shells },
        { label: rows.length === 1 ? 'Command' : 'Commands', value: commands },
        ...(action === 'lifetime' && only !== undefined ? [{ label: 'Lifetime', value: <span>{`${only.before} -> ${only.after}`}</span> }] : []),
      ]}
      notes={notes}
      warning={
        action === 'delete'
          ? <>{rows.length === 1 ? 'This command stops' : 'These commands stop'} being allowed on <MachineName name={name} />: peers that run {rows.length === 1 ? 'it' : 'them'} are refused (or held for your answer) from then on. A deletion only restricts, and only the admin passphrase can sign it.</>
          : <>This changes how long {rows.length === 1 ? 'this command is' : 'these commands are'} allowed on <MachineName name={name} /> for every peer that may run {rows.length === 1 ? 'it' : 'them'}{words === null ? '' : `: ${words}`}. Only the admin passphrase can sign it.</>
      }
      confirmLabel={action === 'delete' ? 'Delete and sign' : 'Change lifetime and sign'}
      busy={busy}
      error={error}
      hint={phase.hint ?? null}
      onConfirm={confirm}
      onCancel={onClose}
    >
      {action === 'lifetime' && (
        <>
          <LifetimePicker choice={choice} onChange={(c) => { setChoice(c); setAcknowledged(false); setError(null); }} busy={busy} />
          {prepared !== undefined && prepared.widening && (
            <span role="note" className={OUTCOME_WARNING}>Widens rights: at least one command is allowed for longer, for more calls, or for ever than before.</span>
          )}
          {preview !== null && 'problem' in preview && <div role="alert" className={TEXT_MUTED_SM}>{preview.problem}</div>}
          {needsAck && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox aria-label={`I understand this lifetime is flagged: ${flags.join('; ')}`} checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
              <span>{`I understand: ${flags.join('; ')}.`}</span>
            </label>
          )}
        </>
      )}
    </ConfirmSignModal>
  );
}
