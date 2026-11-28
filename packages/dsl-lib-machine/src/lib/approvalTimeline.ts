import type { TimelineStep } from '../components/VerticalTimeline.js';

// What the page itself proves while it approves a candidacy, laid over the steps the module computed from the relay data (candidacyTimeline.ts). A step is
// marked only on a proof this page holds: the passphrase was used for the signature, the relay answered 2xx to the approval, the daemon's delivery report, the
// person's own answer on the codes. Never on a guess: a delivery that failed stays current with the exact command, codes that differ are not done.

export interface ApprovalProgress {
  candidate: { name: string; uuid: string };
  /** The passphrase was taken and the signature is made in this page. */
  signed: boolean;
  /** The relay accepted the approval (the decision went through). */
  approved: boolean;
  /** The candidate is the admin machine itself: nothing to compare the code with. */
  selfApproval: boolean;
  /** The delivery report: absent while it runs (or before it starts). */
  delivery?: 'delivered' | 'partial' | 'failed' | 'none';
  /** How many machines hold their documents in the relay inbox (offline, say): delivered counts them, the step says how many wait. */
  waiting?: number;
  /** The candidate was enrolled before (revoked here earlier): its admin key is already pinned, it prints no security code and there is nothing to compare. */
  noCode?: boolean;
  /** What the person answered about the two security codes. Absent: not answered yet. */
  codes?: 'match' | 'differ';
}

const DONE: Record<string, true> = { received: true, checked: true };

/** The steps with this approval laid over them. Returns `steps` itself when no approval has started (nothing the page proves yet). */
export function overlayApproval(steps: TimelineStep[], progress: ApprovalProgress | undefined): TimelineStep[] {
  if (progress === undefined || !progress.signed) {
    return steps;
  }
  return steps.map((step): TimelineStep => {
    if (DONE[step.id] === true) {
      return { ...step, status: 'done' };
    }
    if (step.id === 'signed') {
      return { ...step, status: progress.approved ? 'done' : 'current' };
    }
    if (!progress.approved) {
      return step;
    }
    // The codes are compared AFTER the documents are delivered (the real chronology): no answer of the person can make this step done before the one above it.
    if (step.id === 'final-code') {
      if (progress.noCode === true) {
        return { ...step, status: 'skipped', description: 'No code to compare: this machine already trusts your admin key.' };
      }
      const delivered = progress.delivery === 'delivered' || progress.delivery === 'none';
      if (progress.selfApproval) {
        return delivered
          ? { ...step, status: 'current', description: 'No other machine to compare with: this machine enrolls itself, run `machine join --resume` here.' }
          : { ...step, status: 'todo' };
      }
      if (progress.codes === 'differ') {
        return { ...step, status: 'current', description: `The codes differ: run \`machine admin revoke ${progress.candidate.name}\`.` };
      }
      if (progress.delivery === undefined) {
        return { ...step, status: 'todo' };
      }
      if (!delivered) {
        return progress.codes === 'match'
          ? { ...step, status: 'current', description: 'The codes match. Done once every machine has its documents.' }
          : { ...step, status: 'todo' };
      }
      if (progress.codes === 'match') {
        return { ...step, status: 'done' };
      }
      return { ...step, status: 'current', description: 'Compare the code with the candidate screen.' };
    }
    if (step.id === 'distributed') {
      if (progress.delivery === 'delivered' || progress.delivery === 'none') {
        const waiting = progress.waiting ?? 0;
        if (waiting === 0) {
          return { ...step, status: 'done' };
        }
        return { ...step, status: 'done', description: `${waiting} waiting in the relay inbox: ${waiting === 1 ? 'it installs them when it is back' : 'they install them when they are back'}.` };
      }
      if (progress.delivery === 'partial' || progress.delivery === 'failed') {
        return { ...step, status: 'current', description: 'Not delivered to every machine: the result says what to run.' };
      }
      return { ...step, status: 'current' };
    }
    return step;
  });
}
