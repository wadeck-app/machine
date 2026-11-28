import React, { useEffect, useRef, useState } from 'react';
import { ButtonAction, Notice } from '@wadeck-app/dsl-ui';
import type { WaitingRenewal } from '@wadeck-app/machine-core';
import { loadContexts, prepareBatch, readAdminKeyHint, signAndSubmitBatch, type AllowApi, type AllowContext, type AllowResult } from '../lib/allowFlow.js';
import { groupSelection, selectionSummary } from '../lib/batchAllow.js';
import { readOnlyDefaultKind } from '../lib/quickAllow.js';
import type { AllowDialogEvent } from './AllowDialog.js';
import { InlineAllowForm } from './InlineAllowForm.js';

/** One selected request, with the machine it is signed for and how the progress hook names that machine. */
export interface BatchItem<R> {
  row: R & { id: string; shell: string; command: string; peer?: string; renewal?: WaitingRenewal };
  machine: { uuid: string; name: string };
  /** `self` for this machine, else the uuid: what the hold polling asks the daemon about. */
  machineRef: string;
}

export interface BatchAllowBarProps<R> {
  items: Array<BatchItem<R>>;
  api: AllowApi;
  /** The progress of ONE request, as for a single Allow. */
  onEvent: (item: BatchItem<R>, event: AllowDialogEvent) => void;
  /** A request whose policy was delivered (its machine answered). */
  onDone: (item: BatchItem<R>, result: AllowResult) => void;
  /** The selection is no longer needed: cleared, or signed (the progress lives on the cards). */
  onClear: () => void;
}

type Phase =
  | { kind: 'collapsed' }
  | { kind: 'loading' }
  | { kind: 'ready'; contexts: AllowContext[]; hint: string | undefined }
  | { kind: 'info'; message: string }
  | { kind: 'failed'; message: string };

/**
 * The sticky bar of the held list, for the selected requests: ONE lifetime, ONE passphrase, ONE unlock of the admin key, one policy per machine (every
 * selected command of a machine in the same version). Opening it asks the PIN once and reads the policy of each machine, so a command the policy cannot
 * hold is refused HERE, before the passphrase is asked. A failure before the signature stays in the form with its cause (the selection is kept); after
 * it, each request's card shows its own machine's outcome, so one machine failing never hides another's progress.
 *
 * The parent keys this component by the selection: another selection starts again from the closed bar.
 */
/** The bar sticks to the bottom of the list while the requests above it are read. */
const BAR = 'sticky bottom-0 z-10 flex flex-col gap-2 rounded-lg border border-primary bg-surface px-3 py-2 text-content shadow-lg';

export function BatchAllowBar<R>({ items, api, onEvent, onDone, onClear }: BatchAllowBarProps<R>) {
  const [phase, setPhase] = useState<Phase>({ kind: 'collapsed' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const groups = groupSelection(items.map((i) => ({ id: i.row.id, machine: i.machine, shell: i.row.shell, command: i.row.command, ...(i.row.renewal !== undefined ? { renewal: { entry: i.row.renewal.entry, typed: i.row.renewal.typed, own: i.row.renewal.own, ...(i.row.renewal.own && i.row.peer !== undefined ? { peer: i.row.peer } : {}) } } : {}) })));
  const entriesOf = (contexts: AllowContext[]) => groups.map((g, i) => ({ context: contexts[i] as AllowContext, entries: g.entries }));

  const open = async () => {
    setPhase({ kind: 'loading' });
    try {
      const contexts = await loadContexts(api, groups.map((g) => g.machine.uuid));
      // Everything the policies can refuse is refused now, before the passphrase: nothing is signed for any machine when one refuses.
      const prepared = await prepareBatch(entriesOf(contexts), {}, Math.floor(Date.now() / 1000));
      if (!mounted.current) {
        return;
      }
      if (prepared.every((p) => !p.changed)) {
        setPhase({ kind: 'info', message: `The selected commands are already allowed on ${prepared.map((p) => `"${p.machine.name}"`).join(', ')}: nothing to sign.` });
        return;
      }
      // The hint is stored in clear: on screen before the passphrase is typed (a damaged key file stops here, with its fix).
      const hint = await readAdminKeyHint(api);
      if (mounted.current) {
        setPhase({ kind: 'ready', contexts, hint });
      }
    } catch (e) {
      if (mounted.current) {
        setPhase({ kind: 'failed', message: (e as Error).message });
      }
    }
  };

  const itemsOf = (uuid: string) => items.filter((i) => i.machine.uuid === uuid);

  return (
    <div role="region" aria-label="Allow selected requests" className={BAR}>
      {phase.kind === 'collapsed' && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ButtonAction label={selectionSummary(groups)} variant="primary" onClick={() => void open()} />
          <ButtonAction label="Clear" variant="secondary" onClick={onClear} />
        </div>
      )}
      {phase.kind === 'loading' && <Notice variant="default" label="Checking the current policies..." />}
      {(phase.kind === 'info' || phase.kind === 'failed') && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Notice variant={phase.kind === 'failed' ? 'danger' : 'default'} label={phase.message} />
          <ButtonAction label="Close" variant="secondary" size="sm" onClick={() => setPhase({ kind: 'collapsed' })} />
        </div>
      )}
      {phase.kind === 'ready' && (
        <>
          <div className="text-sm font-semibold">{selectionSummary(groups, true)}</div>
          <InlineAllowForm
            label={selectionSummary(groups)}
            hint={phase.hint}
            defaultKind={readOnlyDefaultKind(items.map((i) => i.row))}
            busy={busy}
            error={error}
            cancelLabel="Cancel"
            warning={(words) => `Widens rights: every trusted peer may run ${items.length === 1 ? 'this' : 'these'} on ${groups.map((g) => g.machine.name).join(', ')}, byte for byte, ${words}.`}
            onCancel={() => setPhase({ kind: 'collapsed' })}
            onSubmit={(lifetime, take) => {
              // The passphrase is a local variable of this call: read and cleared from the field at once, never stored, never passed anywhere but the signature.
              let passphrase = take();
              setError(null);
              setBusy(true);
              const contexts = phase.contexts;
              let signed = false;
              signAndSubmitBatch(api, entriesOf(contexts), lifetime.flags, passphrase, Math.floor(Date.now() / 1000), () => {
                signed = true;
                // Every policy is signed and the key locked: each card starts its own progress, and the bar and the selection go.
                for (const item of items) {
                  onEvent(item, { type: 'start' });
                  onEvent(item, { type: 'signed' });
                }
                onClear();
              }).then(
                (outcomes) => {
                  passphrase = '';
                  for (const outcome of outcomes) {
                    for (const item of itemsOf(outcome.machine.uuid)) {
                      // The requests of a machine share its outcome (one policy, one delivery); one whose entry was already allowed was not signed: it says so.
                      if (outcome.status === 'posted') {
                        onEvent(item, { type: 'result', result: outcome.result });
                        onDone(item, outcome.result);
                      } else {
                        onEvent(item, { type: 'failed', message: outcome.message });
                      }
                    }
                  }
                },
                (e: unknown) => {
                  passphrase = '';
                  const message = (e as Error).message;
                  if (signed) {
                    // Cannot happen after the signature (every post is caught per machine); never silent if it does.
                    for (const item of items) {
                      onEvent(item, { type: 'failed', message });
                    }
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
        </>
      )}
    </div>
  );
}
