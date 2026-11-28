import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Collapsible, FieldText, Notice, Text } from '@wadeck-app/dsl-ui';
import { readAdminKeyHint, type AllowApi } from '../lib/allowFlow.js';
import { loadRenameContext, previewRename, RETRY_SAME_NAME_NOTE, signAndRename, type RenameContext, type RenameResult, type RenameRow } from '../lib/renameFlow.js';
import { CommandNotice } from './CommandNotice.js';
import { ConfirmSignModal } from './ConfirmSignModal.js';
import { DeliveryList } from './DeliveryList.js';
import { DetailRows } from './DetailRows.js';

// The confirmation of ONE rename (admin-ui.md, "Rename and aliases from the page"): what `machine admin rename <machine> <new-name>` does, with the admin passphrase and the
// unlocked key living ONLY in this page. The passphrase is asked at EVERY rename (ConfirmSignModal `askEveryTime`), taken once, and used for one unlock that signs the
// re-issued registration and the documents. A name the CLI would refuse is said under the field BEFORE the passphrase is asked. Nothing secret is kept or sent.

type Phase =
  | { kind: 'loading' }
  | { kind: 'refused'; message: string }
  | { kind: 'ready'; context: RenameContext; hint: string | undefined }
  | { kind: 'signing'; context: RenameContext; hint: string | undefined }
  | { kind: 'done'; result: RenameResult };

export interface RenameMachineDialogProps {
  row: RenameRow;
  api: AllowApi;
  onClose: () => void;
  /** The daemon trusts the new name (whatever the delivery to the others): the page list must catch up. `newName`: the name the machine has now. */
  onRenamed: (newName: string) => void;
}

const day = (epoch: number): string => new Date(epoch * 1000).toISOString().slice(0, 10);

export function RenameMachineDialog({ row, api, onClose, onRenamed }: RenameMachineDialogProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const nameField = useRef<HTMLInputElement>(null);
  // The name field takes the focus when the form first appears, not again after a failed signature (the passphrase takes it then).
  const focusedName = useRef(false);

  useEffect(() => {
    mounted.current = true;
    (async () => {
      try {
        const context = await loadRenameContext(api, row);
        // The hint of the key is stored in clear: read it now, so it is on screen before the passphrase is typed (a damaged key file stops here, with its fix).
        const hint = await readAdminKeyHint(api);
        if (mounted.current) {
          setPhase({ kind: 'ready', context, hint });
        }
      } catch (e) {
        if (mounted.current) {
          setPhase({ kind: 'refused', message: (e as Error).message });
        }
      }
    })();
    return () => {
      mounted.current = false;
    };
  }, [api, row]);

  useEffect(() => {
    if (phase.kind === 'ready' && !focusedName.current) {
      focusedName.current = true;
      nameField.current?.focus();
    }
  }, [phase.kind]);

  const context = phase.kind === 'ready' || phase.kind === 'signing' ? phase.context : undefined;
  const preview = useMemo(() => (context === undefined ? undefined : previewRename(context, typed, Math.floor(Date.now() / 1000))), [context, typed]);

  const title = `Rename ${row.name}?`;

  // What is wrong with the name, told together with an empty passphrase when the person presses the button (and the focus goes to the name).
  const nameProblem = (): { message: string; focus: () => void } | null => {
    if (preview === undefined || preview.ok) {
      return null;
    }
    return { message: preview.message === '' ? 'Type the new name first.' : `${preview.message}.`, focus: () => nameField.current?.focus() };
  };

  const confirm = (take: () => string | null) => {
    if (phase.kind !== 'ready' || preview === undefined) {
      return;
    }
    const { context: ctx, hint } = phase;
    if (!preview.ok) {
      setError(preview.message === '' ? 'Type the new name first. Nothing was signed.' : `${preview.message}. Nothing was signed.`);
      return;
    }
    // The passphrase is a local variable of this call: read and cleared from the field at once, never stored, never passed anywhere but the signature.
    let passphrase = take();
    if (passphrase === null) {
      setError('The admin passphrase is asked at every rename: type it. Nothing was signed.');
      return;
    }
    setError(null);
    setPhase({ kind: 'signing', context: ctx, hint });
    signAndRename(api, ctx, typed, passphrase, Math.floor(Date.now() / 1000)).then(
      (result) => {
        passphrase = '';
        // The daemon trusts the new name: the page list catches up now, behind the dialog.
        onRenamed(result.newName);
        if (mounted.current) {
          setPhase({ kind: 'done', result });
        }
      },
      (e: unknown) => {
        passphrase = '';
        if (mounted.current) {
          setError((e as Error).message);
          setPhase({ kind: 'ready', context: ctx, hint });
        }
      },
    );
  };

  if (phase.kind === 'loading') {
    return <ConfirmSignModal title={title} details={[]} warning="" needsPassphrase={false} confirmLabel="" onConfirm={() => undefined} onCancel={onClose} notes={['Checking the machine and the machines to tell...']} />;
  }
  if (phase.kind === 'refused') {
    return <ConfirmSignModal title={title} details={[]} warning="" needsPassphrase={false} confirmLabel="" error={phase.message} onConfirm={() => undefined} onCancel={onClose} />;
  }

  if (phase.kind === 'done') {
    const { distribution, oldName, newName } = phase.result;
    const retryDelivery = phase.result.retryDelivery;
    const onRetry =
      retryDelivery === undefined || distribution.status !== 'partial'
        ? undefined
        : async () => {
            const next = await retryDelivery();
            if (mounted.current) {
              setPhase({ kind: 'done', result: { ...phase.result, distribution: next } });
            }
          };
    return (
      <ConfirmSignModal title={`${oldName} renamed to ${newName}`} details={[]} warning="" needsPassphrase={false} confirmLabel="" onConfirm={() => undefined} onCancel={onClose}>
        <CommandNotice label={distribution.headline} variant={distribution.tone} />
        <DeliveryList
          machines={distribution.machines}
          text={distribution.text}
          {...(distribution.status === 'partial' ? { retryCommand: distribution.retryCommand, retryNote: RETRY_SAME_NAME_NOTE } : {})}
          {...(onRetry === undefined ? {} : { onRetry })}
        />
      </ConfirmSignModal>
    );
  }

  const { context: ctx, hint } = phase;
  const informed = [ctx.machine.name, ...ctx.others.map((r) => r.body.name)];
  const newName = preview?.ok === true ? preview.name : undefined;
  const fieldError = preview !== undefined && !preview.ok && preview.message !== '' ? preview.message : undefined;
  return (
    <ConfirmSignModal
      title={title}
      details={[]}
      warning=""
      confirmLabel="Sign and rename"
      busy={phase.kind === 'signing'}
      busyLabel="Signing and telling the machines..."
      error={error}
      hint={hint ?? null}
      askEveryTime
      autoFocusCancel={false}
      checkBeforeSigning={nameProblem}
      onConfirm={confirm}
      onCancel={onClose}
    >
      {/* Each message stays under 140 characters: the Notice of dsl-ui offers "Show more" above that, even when three lines hide nothing. */}
      <Notice variant="default" label={`Renames ${row.name}: only its name changes (same uuid, same key, same expiry).`} />
      <Text size="sm" tone="muted" text={ctx.others.length === 0 ? `${row.name} is told its new name.` : `${ctx.others.map((r) => r.body.name).join(', ')} and ${row.name} are told.`} />
      <FieldText
        ref={nameField}
        label="New name"
        description="Lowercase letters, digits and hyphens, at most 32 characters. A name that is not valid as typed is made valid."
        name="machine-new-name"
        autoComplete="off"
        maxLength={64}
        value={typed}
        disabled={phase.kind === 'signing'}
        onChange={(v) => {
          setTyped(v);
          setError(null);
        }}
        {...(fieldError === undefined ? {} : { error: fieldError })}
      />
      {preview?.ok === true && <Notice variant="info" label={`Will be renamed: ${row.name} -> ${preview.name}${preview.normalized ? ` (typed "${typed}", made valid).` : '.'}`} />}
      {preview?.ok === true && preview.capped && <Notice variant="warning" label="A name has at most 32 characters: the end of what you typed was cut." />}
      <Collapsible title="Details">
        <DetailRows
          rows={[
            { label: 'Name', value: `${row.name} -> ${newName ?? '(type the new name)'}` },
            { label: 'Uuid', value: row.uuid },
            { label: 'Identity key', value: ctx.machine.keyId },
            { label: 'Serial', value: `${ctx.machine.serial} -> ${preview?.ok === true ? preview.serial : ctx.machine.serial + 1}` },
            { label: 'Registration', value: `expires ${day(ctx.current.body.validTo)}, unchanged: a rename never extends it` },
            { label: 'Told', value: informed.join(', ') },
            { label: 'Keeps working', value: 'policies, local aliases, connection settings and notice recipients: they follow the machine by its uuid' },
            { label: 'Stops working', value: `references by the old name ("${row.name}"): use the new name, the uuid or an alias` },
          ]}
        />
      </Collapsible>
    </ConfirmSignModal>
  );
}
