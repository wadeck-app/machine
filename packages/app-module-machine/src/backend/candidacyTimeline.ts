import { ageText, type CandidacyListView } from './candidacies.js';

// The timeline of the Candidacies page, computed from what the relay list proves. A step is "done" only when the relay data proves it: the relay data never proves
// the security code or the distribution, so they stay "to do" here. While an approval runs, the page that signs it lays what IT proves over these steps
// (dsl-lib-machine `approvalTimeline.ts`: the passphrase used, the relay accepted the approval, the delivery report, the person's answer on the codes).

export type TimelineStatus = 'done' | 'current' | 'todo';

export interface TimelineStepRow {
  id: string;
  title: string;
  status: TimelineStatus;
  info: string;
  /** One line under the title (the page shows it as is). */
  description?: string;
}

// The one place of the step texts (the view binds the steps to the source). The order is the real chronology: sign, approve at the relay, distribute to the peers,
// THEN the admin compares the security code with the candidate. A step is never done while an earlier one is not.
const STEPS: readonly { id: string; title: string; info: string }[] = [
  { id: 'received', title: 'Candidacy received', info: 'Threat: a stranger posts a candidacy to get a machine enrolled. Nothing is trusted until the admin approves it here.' },
  { id: 'checked', title: 'Details checked', info: 'Threat: a lookalike machine. The name, hostname and address shown are informative, not proof: compare them with the machine you expect.' },
  { id: 'signed', title: 'Passphrase and signature', info: 'Threat: a local process signing for you. The passphrase is typed in the approval dialog of this page (or in the terminal that runs `machine admin approve`), used for ONE signature made in the browser and never sent: the daemon and the module backend only receive what is already signed.' },
  { id: 'distributed', title: 'Documents distributed', info: 'Threat: peers keep an old view of the network. The signed documents are sent to the peers so that every machine trusts the new one. A machine that is offline gets them from the relay inbox when it is back.' },
  { id: 'final-code', title: 'Security code compared', info: 'Threat: the relay swaps a public key (candidate or admin). Compare the security code on the candidate machine, never the one displayed by the relay.' },
];

const isPending = (v: CandidacyListView): boolean => v.relayStatus === undefined || v.relayStatus === 'pending';
const isExpired = (v: CandidacyListView, nowSeconds: number): boolean => v.expiresAt !== undefined && nowSeconds >= v.expiresAt;
// A candidacy without a usable date comes last.
const byAge = (a: CandidacyListView, b: CandidacyListView): number => (a.createdAt ?? Infinity) - (b.createdAt ?? Infinity) || 0;

/** Which steps the relay data proves for `view` (the ids of the done steps and of the current one). */
function progress(view: CandidacyListView, nowSeconds: number): { done: string[]; current: string | undefined; verdict: string } {
  if (view.relayStatus === 'approved') {
    return { done: ['received', 'checked', 'signed'], current: undefined, verdict: 'approved by the admin' };
  }
  if (view.relayStatus === 'rejected') {
    return { done: ['received'], current: undefined, verdict: 'rejected' };
  }
  if (!isPending(view)) {
    return { done: ['received'], current: undefined, verdict: `in a relay status this page does not know ("${view.relayStatus}")` };
  }
  if (isExpired(view, nowSeconds)) {
    return { done: ['received'], current: undefined, verdict: 'expired: the candidate must post a new one' };
  }
  // Pending: the admin has to look at the details.
  return { done: ['received'], current: 'checked', verdict: 'pending' };
}

/** The security code kept after an approval made from the page (approvalCodes.ts). */
export interface KeptCode {
  uuid: string;
  name: string;
  code: string;
}

/**
 * `kept`: the codes kept after the approvals made from the page. The relay purges the random of an approved candidacy, so this is the only way to read the code again;
 * it is shown on the step "Security code compared" of the approved candidacy it belongs to. The step stays to do: only the person can compare it.
 */
export function candidacyTimeline(views: CandidacyListView[], nowSeconds: number, kept: KeptCode[] = []): { steps: TimelineStepRow[]; note: string } {
  const live = views.filter((v) => isPending(v) && !isExpired(v, nowSeconds));
  const followed = [...(live.length > 0 ? live : views)].sort(byAge)[0];
  if (followed === undefined) {
    return { steps: STEPS.map((s) => ({ ...s, status: 'todo' as const })), note: '' };
  }
  const { done, current, verdict } = progress(followed, nowSeconds);
  const code = followed.relayStatus === 'approved' && followed.uuid !== undefined ? kept.find((k) => k.uuid === followed.uuid) : undefined;
  const steps = STEPS.map((s): TimelineStepRow => {
    const status = done.includes(s.id) ? ('done' as const) : s.id === current ? ('current' as const) : ('todo' as const);
    return s.id === 'final-code' && code !== undefined ? { ...s, status, description: `Security code of "${code.name}": ${code.code}. It must read exactly the same on ${code.name}.` } : { ...s, status };
  });
  const which = `"${followed.name}" (${ageText(followed.ageSeconds)})`;
  const many = views.length > 1 ? `, ${live.length > 0 ? 'the oldest pending of' : 'the oldest of'} ${views.length} candidacies` : '';
  return { steps, note: `The timeline follows ${which}${many}: ${verdict}.` };
}
