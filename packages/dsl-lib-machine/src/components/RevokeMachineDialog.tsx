import React, { useEffect, useRef, useState } from 'react';
import { Collapsible, Notice } from '@wadeck-app/dsl-ui';
import { readAdminKeyHint, type AllowApi } from '../lib/allowFlow.js';
import { loadRevokeContext, signAndRevoke, type RevokeContext, type RevokeResult, type RevokeRow } from '../lib/revokeFlow.js';
import { CommandNotice } from './CommandNotice.js';
import { ConfirmSignModal } from './ConfirmSignModal.js';
import { DeliveryList } from './DeliveryList.js';
import { DetailRows } from './DetailRows.js';

// The confirmation of ONE revocation (admin-ui.md, "Revoke from the page"): what `machine admin revoke <machine>` does, with the admin passphrase and the unlocked key
// living ONLY in this page. The passphrase is asked at EVERY revocation (ConfirmSignModal `askEveryTime`: no unlock window), taken once, and used for one unlock that
// signs the revocation list and the documents for the other peers. It is never kept and never sent: only signed and sealed documents are posted.

type Phase =
  | { kind: 'loading' }
  | { kind: 'refused'; message: string }
  | { kind: 'ready'; context: RevokeContext; hint: string | undefined }
  | { kind: 'signing'; context: RevokeContext; hint: string | undefined }
  | { kind: 'done'; result: RevokeResult };

export interface RevokeMachineDialogProps {
  row: RevokeRow;
  api: AllowApi;
  onClose: () => void;
  /** The daemon installed the revocation (whatever the delivery to the peers): the page list must catch up. */
  onRevoked: () => void;
}

export function RevokeMachineDialog({ row, api, onClose, onRevoked }: RevokeMachineDialogProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    (async () => {
      try {
        const context = await loadRevokeContext(api, row);
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

  const title = `Revoke ${row.name}?`;

  const confirm = (take: () => string | null) => {
    if (phase.kind !== 'ready') {
      return;
    }
    const { context, hint } = phase;
    // The passphrase is a local variable of this call: read and cleared from the field at once, never stored, never passed anywhere but the signature.
    let passphrase = take();
    if (passphrase === null) {
      setError('The admin passphrase is asked at every revocation: type it. Nothing was signed.');
      return;
    }
    setError(null);
    setPhase({ kind: 'signing', context, hint });
    signAndRevoke(api, context, passphrase, Math.floor(Date.now() / 1000)).then(
      (result) => {
        passphrase = '';
        // The daemon installed the list: the page list catches up now, behind the dialog.
        onRevoked();
        if (mounted.current) {
          setPhase({ kind: 'done', result });
        }
      },
      (e: unknown) => {
        passphrase = '';
        if (mounted.current) {
          setError((e as Error).message);
          setPhase({ kind: 'ready', context, hint });
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
    const { distribution } = phase.result;
    const retryDelivery = phase.result.retryDelivery;
    const onRetry = retryDelivery === undefined || distribution.status !== 'partial'
      ? undefined
      : async () => {
          const next = await retryDelivery();
          if (mounted.current) {
            setPhase({ kind: 'done', result: { ...phase.result, distribution: next } });
          }
        };
    return (
      <ConfirmSignModal title={`${row.name} revoked`} details={[]} warning="" needsPassphrase={false} confirmLabel="" onConfirm={() => undefined} onCancel={onClose}>
        <CommandNotice label={distribution.headline} variant={distribution.tone} />
        <DeliveryList machines={distribution.machines} text={distribution.text} {...(distribution.status === 'partial' ? { retryCommand: distribution.retryCommand } : {})} {...(onRetry === undefined ? {} : { onRetry })} />
      </ConfirmSignModal>
    );
  }

  const { context, hint } = phase;
  const inform = context.recipients.map((r) => r.body.name);
  return (
    <ConfirmSignModal
      title={title}
      details={[]}
      warning=""
      confirmLabel="Revoke and sign"
      busy={phase.kind === 'signing'}
      busyLabel="Signing and telling the other machines..."
      error={error}
      hint={hint ?? null}
      askEveryTime
      onConfirm={confirm}
      onCancel={onClose}
    >
      <Notice variant="default" label={`Revokes ${row.name}: this machine stops trusting it now, and ${inform.length === 0 ? 'there is no other machine to tell' : `${inform.join(', ')} will be told to stop too`}. It can come back only through a new approval.`} />
      <Collapsible title="Details">
        <DetailRows
          rows={[
            { label: 'Name', value: row.name },
            { label: 'Uuid', value: row.uuid },
            { label: 'Identity key', value: context.revoked.keyId },
            { label: 'Serial', value: `${context.revoked.serial}: this registration and every older one stop being trusted` },
            { label: 'Others told', value: inform.length === 0 ? 'nobody' : inform.join(', ') },
            { label: 'Relay', value: 'its record and inbox are removed' },
          ]}
        />
      </Collapsible>
    </ConfirmSignModal>
  );
}
