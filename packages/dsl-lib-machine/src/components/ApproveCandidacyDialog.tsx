import React, { useEffect, useRef, useState } from 'react';
import { Collapsible, Notice, FieldReadOnly, VerticalStack } from '@wadeck-app/dsl-ui';
import { readAdminKeyHint, type AllowApi } from '../lib/allowFlow.js';
import type { ApprovalProgress } from '../lib/approvalTimeline.js';
import { checkApprovable, loadApproveContext, recordApprovalCode, signAndApprove, type Approvable, type ApproveContext, type ApproveResult, type ApproveRow } from '../lib/approveFlow.js';
import { CommandNotice } from './CommandNotice.js';
import { ConfirmSignModal } from './ConfirmSignModal.js';
import { DeliveryList } from './DeliveryList.js';
import { SecurityCodeCompare } from './SecurityCodeCompare.js';
import { VerticalTimeline, type TimelineStep } from './VerticalTimeline.js';

// The confirmation of ONE approval (admin-ui.md, "Approve from the page"): what `machine admin approve <id>` does, with the admin passphrase and the unlocked key
// living ONLY in this page. The passphrase is asked at EVERY approval (ConfirmSignModal `askEveryTime`: no unlock window), taken once, and used for one unlock that
// signs the approval, the import for this machine and the documents for the other peers. It is never kept and never sent: only signed and sealed documents are posted.
//
// The timeline of the approval is shown INSIDE the dialog (the page behind it is hidden by the backdrop). The result is short: one headline, the security code with
// its buttons, one line per machine, and the raw report of the CLI folded in "Details".

type Phase =
  | { kind: 'loading' }
  | { kind: 'refused'; message: string }
  | { kind: 'ready'; context: ApproveContext; checked: Approvable; hint: string | undefined }
  | { kind: 'signing'; context: ApproveContext; checked: Approvable; hint: string | undefined }
  | { kind: 'done'; context: ApproveContext; result: ApproveResult; noCode: boolean };

export interface ApproveCandidacyDialogProps {
  row: ApproveRow;
  api: AllowApi;
  onClose: () => void;
  /**
   * What this page proves about the approval, step by step (the timeline lays it over the steps of the module). Called with `undefined` when a signature failed
   * and nothing is proven any more.
   */
  onProgress: (progress: ApprovalProgress | undefined) => void;
  /** The timeline of the approval as the page shows it (steps of the module with what this page proves laid over them): shown inside the dialog. Absent: no timeline. */
  steps?: TimelineStep[];
}

/** Why the comparison of the codes is not offered while the documents are missing. */
const HELD_BACK = 'Comparing the codes waits until every machine has its documents.';

/** The days an approval is valid for: the default of `machine admin approve`. */
const VALID_FOR = '365 days';

export function ApproveCandidacyDialog({ row, api, onClose, onProgress, steps }: ApproveCandidacyDialogProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<'match' | 'differ' | undefined>(undefined);
  // The relay holds the approval: the documents are being delivered.
  const [delivering, setDelivering] = useState(false);
  // Why the security code could not be kept for later (it is still on screen).
  const [keepProblem, setKeepProblem] = useState<string | null>(null);
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

  const title = `Approve ${row.name}?`;
  // Inside the dialog, so the progress stays visible while the backdrop hides the page.
  const aside = steps !== undefined && steps.length > 0 ? <VerticalTimeline steps={steps} /> : undefined;
  const side = aside === undefined ? {} : { aside };

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
    setKeepProblem(null);
    setDelivering(false);
    setPhase({ kind: 'signing', context, checked, hint });
    const candidate = { name: row.name, uuid: row.uuid as string };
    report({ candidate, signed: true, approved: false, selfApproval: checked.selfApproval, noCode: checked.noCode });
    signAndApprove(api, context, row, passphrase, Math.floor(Date.now() / 1000), {
      onApproved: (code) => {
        report({ candidate, signed: true, approved: true, selfApproval: checked.selfApproval, noCode: checked.noCode });
        if (mounted.current) {
          setDelivering(true);
        }
        // The relay purges the random of an approved candidacy: the code cannot be recomputed later, so it is kept now (a public reminder). A failure is said, not hidden.
        if (checked.noCode) {
          return;
        }
        recordApprovalCode(api, candidate, code).catch((e: unknown) => {
          if (mounted.current) {
            setKeepProblem((e as Error).message);
          }
        });
      },
    }).then(
      (result) => {
        passphrase = '';
        report({ candidate, signed: true, approved: true, selfApproval: checked.selfApproval, noCode: checked.noCode, delivery: result.distribution.status, waiting: result.distribution.waiting });
        if (mounted.current) {
          setPhase({ kind: 'done', context, result, noCode: checked.noCode });
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
          setDelivering(false);
          setPhase({ kind: 'ready', context, checked, hint });
        }
      },
    );
  };

  if (phase.kind === 'loading') {
    return <ConfirmSignModal title={title} details={[]} warning="" needsPassphrase={false} confirmLabel="" onConfirm={() => undefined} onCancel={onClose} notes={['Checking the candidacy and the machines to inform...']} {...side} />;
  }
  if (phase.kind === 'refused') {
    return <ConfirmSignModal title={title} details={[]} warning="" needsPassphrase={false} confirmLabel="" error={phase.message} onConfirm={() => undefined} onCancel={onClose} {...side} />;
  }

  if (phase.kind === 'done') {
    const { distribution } = phase.result;
    // Some machine did not get its documents: comparing the codes now would be premature (the timeline keeps that step to do).
    const documentsMissing = distribution.status === 'partial' || distribution.status === 'failed';
    // The command the headline already gives: the machine rows do not say it again.
    const retry = /`([^`]+)`/.exec(distribution.headline)?.[1];
    const answer = (value: 'match' | 'differ') => {
      setCodes(value);
      if (progress.current !== undefined) {
        report({ ...progress.current, codes: value });
      }
    };
    return (
      <ConfirmSignModal title={`${row.name} approved`} details={[]} warning="" needsPassphrase={false} confirmLabel="" onConfirm={() => undefined} onCancel={onClose} {...side}>
        <CommandNotice label={distribution.headline} variant={distribution.tone} />
        {phase.noCode ? (
          // Enrolled before: its admin key is already pinned there, it prints no code and asks for no comparison.
          <Notice variant="info" label="No code to compare: this machine already trusts your admin key." />
        ) : (
          <SecurityCodeCompare code={phase.result.finalCode} name={row.name} answered={codes !== undefined} onMatch={() => answer('match')} onDiffer={() => answer('differ')} {...(documentsMissing ? { heldBack: HELD_BACK } : {})} />
        )}
        {codes === 'match' && <CommandNotice variant="success" label={`Comparison recorded on this page. The decisive confirmation is still to be made on ${row.name}: \`machine join\` there asks you to confirm its code.`} />}
        {codes === 'differ' && <CommandNotice variant="danger" label={`Codes differ: do NOT use "${row.name}". Run \`machine admin revoke ${row.name}\` now, then reject the candidate and look for who sits between the machines.`} />}
        {keepProblem !== null && <Notice variant="warning" label={keepProblem} />}
        <DeliveryList machines={distribution.machines} text={distribution.text} openDetails={documentsMissing} {...(retry === undefined ? {} : { said: retry })} />
      </ConfirmSignModal>
    );
  }

  const { checked, hint } = phase;
  const inform = checked.peersToInform.map((p) => p.name);
  return (
    <ConfirmSignModal
      title={title}
      details={[]}
      warning=""
      confirmLabel="Approve and sign"
      busy={phase.kind === 'signing'}
      busyLabel={delivering ? 'Telling the other machines...' : 'Signing...'}
      error={error}
      hint={hint ?? null}
      askEveryTime
      onConfirm={confirm}
      onCancel={onClose}
      {...side}
    >
      <Notice variant="default" label={`Enrolls ${row.name}: this machine${inform.length === 0 ? '' : ` and ${inform.join(', ')}`} will trust it, and judge its commands by their own policies. The passphrase signs once, in this page: it is asked at every approval and never kept or sent.`} />
      {checked.warnings.map((w) => (
        <Notice key={w} variant="warning" label={w} />
      ))}
      <Collapsible title="Details">
        <VerticalStack gap="gap-2">
          {[
            ['Name', row.name],
            ['Hostname', row.hostname === '' ? 'unknown' : row.hostname],
            ['Uuid', row.uuid ?? ''],
            ['Seen from', row.observedIp === '' ? 'unknown' : row.observedIp],
            ['Valid for', VALID_FOR],
            ['Others told', checked.selfApproval ? 'nobody: the first machine of the network' : inform.length === 0 ? 'nobody' : inform.join(', ')],
          ].map(([label, value]) => (
            <FieldReadOnly key={label} label={label as string} value={value as string} mono />
          ))}
          <Notice variant="default" label="Candidacy code recomputed in this page from the key and random the relay listed, and it matches: the relay did not swap the key." />
        </VerticalStack>
      </Collapsible>
    </ConfirmSignModal>
  );
}
