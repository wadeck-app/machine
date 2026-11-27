import { ageText, type CandidacyListView } from './candidacies.js';

// The timeline of the Candidacies page, computed from what the relay list proves (this page can reject but not approve yet). A step is "done" only when the
// relay data proves it; the passphrase, the security code and the distribution happen in `machine admin approve` and are never observable here.

export type TimelineStatus = 'done' | 'current' | 'todo';

export interface TimelineStepRow {
  id: string;
  title: string;
  status: TimelineStatus;
  info: string;
}

// The one place of the step texts (the view binds the steps to the source).
const STEPS: readonly { id: string; title: string; info: string }[] = [
  { id: 'received', title: 'Candidacy received', info: 'Threat: a stranger posts a candidacy to get a machine enrolled. Nothing is trusted until the admin approves it here.' },
  { id: 'checked', title: 'Details checked', info: 'Threat: a lookalike machine. The name, hostname and address shown are informative, not proof: compare them with the machine you expect.' },
  { id: 'signed', title: 'Passphrase and signature', info: 'Threat: a local process signing for you. Today the passphrase is typed in the terminal that runs `machine admin approve`, never in this page, and the signature is made there, never by the daemon or the module backend.' },
  { id: 'final-code', title: 'Security code compared', info: 'Threat: the relay swaps a public key (candidate or admin). Compare the security code on the candidate machine, never the one displayed by the relay.' },
  { id: 'distributed', title: 'Documents distributed', info: 'Threat: peers keep an old view of the network. The signed documents are sent to the peers so that every machine trusts the new one.' },
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

export function candidacyTimeline(views: CandidacyListView[], nowSeconds: number): { steps: TimelineStepRow[]; note: string } {
  const live = views.filter((v) => isPending(v) && !isExpired(v, nowSeconds));
  const followed = [...(live.length > 0 ? live : views)].sort(byAge)[0];
  if (followed === undefined) {
    return { steps: STEPS.map((s) => ({ ...s, status: 'todo' as const })), note: '' };
  }
  const { done, current, verdict } = progress(followed, nowSeconds);
  const steps = STEPS.map((s) => ({ ...s, status: done.includes(s.id) ? ('done' as const) : s.id === current ? ('current' as const) : ('todo' as const) }));
  const which = `"${followed.name}" (${ageText(followed.ageSeconds)})`;
  const many = views.length > 1 ? `, ${live.length > 0 ? 'the oldest pending of' : 'the oldest of'} ${views.length} candidacies` : '';
  return { steps, note: `The timeline follows ${which}${many}: ${verdict}.` };
}
