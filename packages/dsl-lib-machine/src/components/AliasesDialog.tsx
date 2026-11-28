import React, { useEffect, useRef, useState } from 'react';
import { ButtonAction, Collapsible, FieldReadOnly, FieldSelect, FieldText, Notice, Text, VerticalStack } from '@wadeck-app/dsl-ui';
import { MAX_ALIASES } from '@wadeck-app/machine-webcrypto';
import { loadAliasesContext, previewAliasChange, signAndChangeAlias, type AliasChange, type AliasesContext, type AliasesResult, type AliasPreview } from '../lib/aliasesFlow.js';
import { readAdminKeyHint, type AllowApi } from '../lib/allowFlow.js';
import { CommandNotice } from './CommandNotice.js';
import { ConfirmSignModal } from './ConfirmSignModal.js';
import { DeliveryList } from './DeliveryList.js';

// The network aliases (decision 116; admin-ui.md, "Rename and aliases from the page"): the admin-signed labels that mean the same machine on every machine of the network.
// One dialog: the list (what is in force), an add form, a Remove per alias. EACH change is its own signature: a confirmation names it, the admin passphrase is asked now
// (`askEveryTime`), taken once, and used for one unlock that signs the whole new list and the documents; it is never kept or sent. The plan the CLI makes is run on the
// context first, so a refused alias is said under the field BEFORE the passphrase is asked. An alias is a label for a human, never a right.

type Phase =
  | { kind: 'loading' }
  | { kind: 'refused'; message: string }
  | { kind: 'list'; context: AliasesContext; hint: string | undefined }
  | { kind: 'confirm'; context: AliasesContext; hint: string | undefined; change: AliasChange; preview: Extract<AliasPreview, { ok: true }>; busy: boolean }
  | { kind: 'done'; context: AliasesContext; hint: string | undefined; result: AliasesResult };

export interface AliasesDialogProps {
  /** The machine of the row that opened the dialog: it is the preselected target of a new alias. */
  row: { uuid: string; name: string };
  api: AllowApi;
  onClose: () => void;
  /** The daemon kept a new list (whatever the delivery): the page list (the Aliases column) must catch up. */
  onChanged: () => void;
}

const short = (uuid: string): string => uuid.slice(0, 8);

export function AliasesDialog({ row, api, onClose, onChanged }: AliasesDialogProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [alias, setAlias] = useState('');
  const [target, setTarget] = useState(row.uuid);
  const [addError, setAddError] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  // The context is read after the PIN, the hint of the key right after it (a damaged key file stops here, with its fix). Used at the start and after a change.
  const load = async (): Promise<void> => {
    setPhase({ kind: 'loading' });
    try {
      const context = await loadAliasesContext(api);
      const hint = await readAdminKeyHint(api);
      if (mounted.current) {
        setPhase({ kind: 'list', context, hint });
      }
    } catch (e) {
      if (mounted.current) {
        setPhase({ kind: 'refused', message: (e as Error).message });
      }
    }
  };

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
    // The dialog is mounted for one row: `load` reads only `api`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const title = 'Network aliases';

  if (phase.kind === 'loading') {
    return <ConfirmSignModal title={title} details={[]} warning="" needsPassphrase={false} confirmLabel="" onConfirm={() => undefined} onCancel={onClose} notes={['Reading the network aliases...']} />;
  }
  if (phase.kind === 'refused') {
    return <ConfirmSignModal title={title} details={[]} warning="" needsPassphrase={false} confirmLabel="" error={phase.message} onConfirm={() => undefined} onCancel={onClose} />;
  }

  const nameOf = (context: AliasesContext, uuid: string): string => context.machines.find((m) => m.uuid === uuid)?.name ?? short(uuid);

  if (phase.kind === 'done') {
    const { result } = phase;
    const { distribution } = result;
    const retryDelivery = result.retryDelivery;
    const onRetry =
      retryDelivery === undefined || distribution.status !== 'partial'
        ? undefined
        : async () => {
            const next = await retryDelivery();
            if (mounted.current) {
              setPhase({ ...phase, result: { ...result, distribution: next } });
            }
          };
    return (
      <ConfirmSignModal title={`Network alias ${result.alias} ${result.action === 'set' ? 'set' : 'removed'}`} details={[]} warning="" needsPassphrase={false} confirmLabel="" onConfirm={() => undefined} onCancel={onClose}>
        <CommandNotice label={distribution.headline} variant={distribution.tone} />
        <DeliveryList machines={distribution.machines} text={distribution.text} {...(distribution.status === 'partial' ? { retryCommand: distribution.retryCommand } : {})} {...(onRetry === undefined ? {} : { onRetry })} />
        <div>
          <ButtonAction label="Back to the aliases" variant="secondary" size="sm" onClick={() => void load()} />
        </div>
      </ConfirmSignModal>
    );
  }

  if (phase.kind === 'confirm') {
    const { context, hint, change, preview } = phase;
    const told = context.recipients.map((r) => r.body.name);
    const pointsTo = change.action === 'set' ? nameOf(context, change.uuid) : nameOf(context, context.current?.body.entries.find((e) => e.alias === preview.alias)?.uuid ?? '');
    const confirm = (take: () => string | null) => {
      // The passphrase is a local variable of this call: read and cleared from the field at once, never stored, never passed anywhere but the signature.
      let passphrase = take();
      if (passphrase === null) {
        setError('The admin passphrase is asked at every change: type it. Nothing was signed.');
        return;
      }
      setError(null);
      setPhase({ ...phase, busy: true });
      signAndChangeAlias(api, context, change, passphrase, Math.floor(Date.now() / 1000)).then(
        (result) => {
          passphrase = '';
          // The daemon kept the list: the page list catches up now, behind the dialog.
          onChanged();
          if (mounted.current) {
            // The alias that was just added must not stay typed: the next Add would send the same one again.
            if (change.action === 'set') {
              setAlias('');
            }
            setPhase({ kind: 'done', context, hint, result });
          }
        },
        (e: unknown) => {
          passphrase = '';
          if (mounted.current) {
            setError((e as Error).message);
            setPhase({ ...phase, busy: false });
          }
        },
      );
    };
    return (
      <ConfirmSignModal
        title={`${change.action === 'set' ? 'Set' : 'Remove'} alias ${preview.alias}?`}
        details={[]}
        warning=""
        confirmLabel={change.action === 'set' ? 'Sign and add' : 'Sign and remove'}
        busy={phase.busy}
        busyLabel="Signing and telling the other machines..."
        error={error}
        hint={hint ?? null}
        askEveryTime
        onConfirm={confirm}
        onCancel={() => {
          setError(null);
          setPhase({ kind: 'list', context, hint });
        }}
      >
        {/* Each message stays under 140 characters (the Notice of dsl-ui offers "Show more" above that, even when it hides nothing): who is told is a line of its own. */}
        <Notice variant="default" label={change.action === 'set' ? `On every machine of the network, "${preview.alias}" will mean ${pointsTo}.` : `"${preview.alias}" (${pointsTo}) will no longer be a network alias.`} />
        <Text size="sm" tone="muted" text={told.length === 0 ? 'There is no other machine to tell.' : `${told.join(', ')} will be told.`} />
        {/* Only the conflicts of THIS alias (previewAliasChange): the command is monospace under its sentence. */}
        {preview.conflicts.map((c) => (
          <CommandNotice key={c.alias} variant="warning" label={`"${c.alias}" is also a local alias of ${nameOf(context, c.local)}: the local alias wins on this machine. Remove it with \`machine alias rm ${c.alias}\` to follow the network alias.`} />
        ))}
        <Collapsible title="Details">
          <VerticalStack gap="gap-2">
            {[
              { label: 'Alias', value: preview.alias },
              { label: 'Points to', value: pointsTo },
              { label: 'After', value: `${preview.entries.length} network ${preview.entries.length === 1 ? 'alias' : 'aliases'}, signed as one list and sent to every other trusted machine as a sealed document` },
              { label: 'Told', value: told.length === 0 ? 'nobody' : told.join(', ') },
            ].map((r) => (
              <FieldReadOnly key={r.label} label={r.label} value={r.value} mono wrap="words" />
            ))}
          </VerticalStack>
        </Collapsible>
      </ConfirmSignModal>
    );
  }

  const { context, hint } = phase;
  const entries = context.current?.body.entries ?? [];
  const network = Object.fromEntries(entries.map((e) => [e.alias, e.uuid]));
  const standing = Object.entries(context.localAliases).filter(([a, u]) => network[a] !== undefined && network[a].toLowerCase() !== u.toLowerCase());
  const full = entries.length >= MAX_ALIASES;
  const options = context.machines.map((m) => ({ value: m.uuid, label: m.uuid === context.adminMachine.uuid ? `${m.name} (this machine)` : m.name }));

  const add = (): void => {
    const change: AliasChange = { action: 'set', alias: alias.trim(), uuid: target };
    if (change.alias === '') {
      setAddError('Type the alias first (letters, digits and hyphens, for example: box). Nothing was signed.');
      return;
    }
    const preview = previewAliasChange(context, change);
    if (!preview.ok) {
      setAddError(`${preview.message}. Nothing was signed.`);
      return;
    }
    if (!preview.changed) {
      setAddError(`"${preview.alias}" already points to ${nameOf(context, target)}: nothing to change.`);
      return;
    }
    setAddError(undefined);
    setError(null);
    setPhase({ kind: 'confirm', context, hint, change, preview, busy: false });
  };

  const remove = (aliasName: string): void => {
    const change: AliasChange = { action: 'rm', alias: aliasName };
    const preview = previewAliasChange(context, change);
    if (!preview.ok) {
      setAddError(`${preview.message}. Nothing was signed.`);
      return;
    }
    setAddError(undefined);
    setError(null);
    setPhase({ kind: 'confirm', context, hint, change, preview, busy: false });
  };

  return (
    <ConfirmSignModal title={title} details={[]} warning="" needsPassphrase={false} confirmLabel="" onConfirm={() => undefined} onCancel={onClose}>
      {/* Plain text, not a Notice: it is a help line, and a Notice of this length offers a "Show more" that hides nothing. */}
      <Text size="sm" tone="muted" text="A network alias is a label every machine reads the same way (box means the same machine everywhere). It is never a right: it only decides which machine a name means. Each change is its own signature." />
      {standing.map(([a, u]) => (
        <CommandNotice key={a} variant="warning" label={`"${a}" is a network alias of ${nameOf(context, network[a] as string)} and a local alias of ${nameOf(context, u)}: the local alias wins on this machine. Remove it with \`machine alias rm ${a}\` to follow the network alias.`} />
      ))}
      <VerticalStack gap="gap-2">
        <Text size="sm" tone="muted" text={`${entries.length} of the ${MAX_ALIASES} aliases the network can hold`} />
        {entries.length === 0 ? (
          <Text text="No network alias yet: add one below." />
        ) : (
          <ul aria-label="Network aliases" className="flex list-none flex-col gap-2 p-0 text-sm">
            {entries.map((e) => (
              <li key={e.alias} className="flex items-center justify-between gap-3">
                <span className="min-w-0 flex-1">
                  <Text mono text={e.alias} /> points to <Text mono text={nameOf(context, e.uuid)} /> <Text tone="muted" mono text={`(${short(e.uuid)})`} />
                </span>
                <span className="shrink-0">
                  <ButtonAction label="Remove" ariaLabel={`Remove alias ${e.alias}`} variant="danger-outline" size="xs" onClick={() => remove(e.alias)} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </VerticalStack>
      {full ? (
        <Notice variant="warning" label={`There are already ${MAX_ALIASES} network aliases, the limit: remove one before adding another.`} />
      ) : (
        <VerticalStack gap="gap-2">
          <FieldText
            label="Alias"
            description="Letters, digits and hyphens, for example: box. An alias that is not valid as typed is made valid."
            name="machine-network-alias"
            autoComplete="off"
            maxLength={64}
            value={alias}
            onChange={(v) => {
              setAlias(v);
              setAddError(undefined);
            }}
            {...(addError === undefined ? {} : { error: addError })}
          />
          <FieldSelect label="Points to" value={target} onChange={setTarget} options={options} />
          <div>
            <ButtonAction label="Add alias" variant="primary" size="sm" onClick={add} />
          </div>
        </VerticalStack>
      )}
      {full && addError !== undefined && <Notice variant="danger" label={addError} />}
    </ConfirmSignModal>
  );
}
