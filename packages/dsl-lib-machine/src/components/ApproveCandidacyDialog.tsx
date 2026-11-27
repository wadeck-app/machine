import React, { useEffect, useRef, useState } from 'react';
import { ButtonAction } from '@wadeck-app/dsl-ui';
import { readAdminKeyHint, type AllowApi } from '../lib/allowFlow.js';
import type { ApprovalProgress } from '../lib/approvalTimeline.js';
import { checkApprovable, loadApproveContext, signAndApprove, type Approvable, type ApproveContext, type ApproveResult, type ApproveRow } from '../lib/approveFlow.js';
import { NOTICE_SUCCESS, NOTICE_WARNING, TEXT_ERROR, TEXT_MUTED_SM } from '../lib/styleTokens.js';
import { ConfirmSignModal } from './ConfirmSignModal.js';
import { FinalCodeDisplay } from './FinalCodeDisplay.js';

// The confirmation of ONE approval (admin-ui.md, "Approve from the page"): what `machine admin approve <id>` does, with the admin passphrase and the unlocked key
// living ONLY in this page. The passphrase is asked at EVERY approval (ConfirmSignModal `askEveryTime`: no unlock window), taken once, and used for one unlock that
// signs the approval, the import for this machine and the documents for the other peers. It is never kept and never sent: only signed and sealed documents are posted.

type Phase =
  | { kind: 'loading' }
  | { kind: 'refused'; message: string }
  | { kind: 'ready'; context: ApproveContext; checked: Approvable; hint: string | undefined }
  | { kind: 'signing'; context: ApproveContext; checked: Approvable; hint: string | undefined }
  | { kind: 'done'; context: ApproveContext; result: ApproveResult };

export interface ApproveCandidacyDialogProps {
  row: ApproveRow;
  api: AllowApi;
  onClose: () => void;
  /**
   * What this page proves about the approval, step by step (the timeline lays it over the steps of the module). Called with `undefined` when a signature failed
   * and nothing is proven any more.
   */
  onProgress: (progress: ApprovalProgress | undefined) => void;
}

/** The days an approval is valid for: the default of `machine admin approve`. */
const VALID_FOR = '365 days';

const PREWRAP: React.CSSProperties = { whiteSpace: 'pre-wrap' };

export function ApproveCandidacyDialog({ row, api, onClose, onProgress }: ApproveCandidacyDialogProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<'match' | 'differ' | undefined>(undefined);
  const mounted = useRef(true);
  const progress = useRef<ApprovalProgress | undefined>(undefined);

  const report = (next: ApprovalProgress | undefined) => {
    progress.current = next;
    onProgress(next);
  };

  useEffect(() => {
    mounted.current = true;
    (async () => {
      try {
        const context = await loadApproveContext(api, row);
        const checked = await checkApprovable(row, context);
        // The hint of the key is stored in clear: read it now, so it is on screen before the passphrase is typed (a damaged key file stops here, with its fix).
        const hint = await readAdminKeyHint(api);
        if (mounted.current) {
          setPhase({ kind: 'ready', context, checked, hint });
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

  const title = <>Approve <span>{row.name}</span>?</>;

  const confirm = (take: () => string | null) => {
    if (phase.kind !== 'ready') {
      return;
    }
    const { context, checked, hint } = phase;
    // The passphrase is a local variable of this call: read and cleared from the field at once, never stored, never passed anywhere but the signature.
    let passphrase = take();
    if (passphrase === null) {
      setError('The admin passphrase is asked at every approval: type it. Nothing was signed.');
      return;
    }
    setError(null);
    setPhase({ kind: 'signing', context, checked, hint });
    const candidate = { name: row.name, uuid: row.uuid as string };
    report({ candidate, signed: true, approved: false, selfApproval: checked.selfApproval });
    signAndApprove(api, context, row, passphrase, Math.floor(Date.now() / 1000), {
      onApproved: () => report({ candidate, signed: true, approved: true, selfApproval: checked.selfApproval }),
    }).then(
      (result) => {
        passphrase = '';
        report({ candidate, signed: true, approved: true, selfApproval: checked.selfApproval, delivery: result.distribution.status });
        if (mounted.current) {
          setPhase({ kind: 'done', context, result });
        }
      },
      (e: unknown) => {
        passphrase = '';
        // Nothing was approved (the error says whether the backend or the signature stopped it): the timeline goes back to what the module computed, unless the relay holds the approval.
        if (progress.current?.approved !== true) {
          report(undefined);
        }
        if (mounted.current) {
          setError((e as Error).message);
          setPhase({ kind: 'ready', context, checked, hint });
        }
      },
    );
  };

  if (phase.kind === 'loading') {
    return <ConfirmSignModal title={title} details={[]} warning="" needsPassphrase={false} confirmLabel="" onConfirm={() => undefined} onCancel={onClose} notes={['Checking the candidacy and the machines to inform...']} />;
  }
  if (phase.kind === 'refused') {
    return <ConfirmSignModal title={title} details={[]} warning="" needsPassphrase={false} confirmLabel="" error={phase.message} onConfirm={() => undefined} onCancel={onClose} />;
  }

  if (phase.kind === 'done') {
    const { result, context } = phase;
    const ok = result.distribution.status === 'delivered' || result.distribution.status === 'none';
    return (
      <ConfirmSignModal
        title={<>{row.name} approved</>}
        details={[
          { label: 'Machine', value: row.name },
          { label: 'Uuid', value: row.uuid ?? '' },
        ]}
        warning=""
        needsPassphrase={false}
        confirmLabel=""
        notes={[result.message]}
        onConfirm={() => undefined}
        onCancel={onClose}
      >
        <div role={ok ? 'status' : 'alert'} className={ok ? NOTICE_SUCCESS : TEXT_ERROR} style={PREWRAP}>{result.distribution.text}</div>
        <FinalCodeDisplay candidatePublicKey={row.identityPublicKey as string} adminPublicKey={context.adminPublicKey} random={row.random as string} onConfirm={() => { setCodes('match'); if (progress.current !== undefined) { report({ ...progress.current, codes: 'match' }); } }} />
        <p className={TEXT_MUTED_SM}>It must read exactly the same on the candidate machine. If it differs, run: <code>machine admin revoke {row.name}</code></p>
        {codes === 'differ' && (
          <div role="alert" className={NOTICE_WARNING} style={PREWRAP}>{`The codes differ: do NOT use "${row.name}". Run \`machine admin revoke ${row.name}\` on this machine now, then reject or ignore the candidate and look at who sits between the two machines and the relay.`}</div>
        )}
        {codes === 'match' && <div role="status" className={NOTICE_SUCCESS}>Codes match: "{row.name}" is enrolled.</div>}
        {codes === undefined && (
          <div>
            <ButtonAction label="The codes differ" variant="danger-outline" onClick={() => { setCodes('differ'); if (progress.current !== undefined) { report({ ...progress.current, codes: 'differ' }); } }} />
          </div>
        )}
      </ConfirmSignModal>
    );
  }

  const { checked, context, hint } = phase;
  const inform = checked.peersToInform.map((p) => p.name);
  const notes: React.ReactNode[] = [
    'The candidacy code was recomputed in this page from the key and random the relay listed, and matches: the relay did not swap the key.',
    ...checked.warnings,
    checked.selfApproval
      ? 'This is the first machine of the network: it is the admin machine itself, there is no other machine to tell.'
      : inform.length === 0
        ? 'No other machine is told: this machine and the candidate are the only ones.'
        : `The documents that tell the others are signed with the same unlock: they are sent right after the approval (directly, or through the relay inbox when a machine is not reachable).`,
    'The security code to compare is shown after the approval.',
  ];
  return (
    <ConfirmSignModal
      title={title}
      details={[
        { label: 'Name', value: row.name },
        { label: 'Hostname', value: row.hostname === '' ? 'unknown' : row.hostname },
        { label: 'Uuid', value: row.uuid ?? '' },
        { label: 'Seen from', value: row.observedIp === '' ? 'unknown' : row.observedIp },
        { label: 'Admin machine', value: context.adminMachine.name },
        { label: 'Valid for', value: VALID_FOR },
        { label: 'Others told', value: inform.length === 0 ? 'nobody' : inform.join(', ') },
      ]}
      notes={notes}
      warning={`This ENROLLS "${row.name}": this machine${inform.length === 0 ? '' : ' and the machines listed above'} will trust it and its commands will be judged by their policies. Only the admin passphrase can sign it, and it is asked at every approval: it is never kept.`}
      confirmLabel="Approve and sign"
      busy={phase.kind === 'signing'}
      error={error}
      hint={hint ?? null}
      askEveryTime
      onConfirm={confirm}
      onCancel={onClose}
    />
  );
}
