import { describe, expect, it } from 'vitest';
import { overlayApproval, type ApprovalProgress } from './approvalTimeline.js';
import type { TimelineStep } from '../components/VerticalTimeline.js';

// The timeline of the Candidacies page is computed by the module from what the relay proves; while this page approves a candidacy it adds only what the page itself
// proves (admin-ui.md, "Approve from the page"): the passphrase was used, the relay accepted the approval, the delivery report, the person's answer on the codes.
// The steps are in the real chronology: the documents are delivered to the peers BEFORE the admin compares the codes with the candidate.

const server = (): TimelineStep[] => [
  { id: 'received', title: 'Candidacy received', status: 'done', info: 'a' },
  { id: 'checked', title: 'Details checked', status: 'current', info: 'b' },
  { id: 'signed', title: 'Passphrase and signature', status: 'todo', info: 'c' },
  { id: 'distributed', title: 'Documents distributed', status: 'todo', info: 'e' },
  { id: 'final-code', title: 'Security code compared', status: 'todo', info: 'd' },
];
const ORDER = server().map((s) => s.id);
const statuses = (steps: TimelineStep[]): Record<string, string> => Object.fromEntries(steps.map((s) => [s.id, s.status]));
const UUID = '0b8a7a52-7f0d-4f0e-8a56-2f0d3a1c9e11';
const progress = (over: Partial<ApprovalProgress> = {}): ApprovalProgress => ({ candidate: { name: 'laptop', uuid: UUID }, signed: false, approved: false, selfApproval: false, ...over });

describe('overlayApproval', () => {
  it('no approval started: the steps of the module, untouched (same objects)', () => {
    const steps = server();
    expect(overlayApproval(steps, undefined)).toBe(steps);
    expect(statuses(overlayApproval(steps, progress()))).toEqual(statuses(steps));
  });

  it('the passphrase is used: checked is done, signed is current (the signature runs in this page)', () => {
    expect(statuses(overlayApproval(server(), progress({ signed: true })))).toEqual({ received: 'done', checked: 'done', signed: 'current', distributed: 'todo', 'final-code': 'todo' });
  });

  it('the relay holds the approval: signed is done, the delivery is running, the code waits for the delivery (it comes after)', () => {
    expect(statuses(overlayApproval(server(), progress({ signed: true, approved: true })))).toEqual({ received: 'done', checked: 'done', signed: 'done', distributed: 'current', 'final-code': 'todo' });
  });

  it('delivered: distributed is done and the code is the current step; it is done only when the person says both machines show the same', () => {
    const delivered = progress({ signed: true, approved: true, delivery: 'delivered' });
    expect(statuses(overlayApproval(server(), delivered))).toMatchObject({ signed: 'done', distributed: 'done', 'final-code': 'current' });
    expect(statuses(overlayApproval(server(), { ...delivered, codes: 'match' }))).toMatchObject({ distributed: 'done', 'final-code': 'done' });
  });

  it('documents queued in the relay inbox count as distributed, and the step says how many wait', () => {
    const out = overlayApproval(server(), progress({ signed: true, approved: true, delivery: 'delivered', waiting: 1 }));
    const step = out.find((s) => s.id === 'distributed');
    expect(step?.status).toBe('done');
    expect(step?.description).toBe('1 waiting in the relay inbox: it installs them when it is back.');
  });

  it('nobody waiting: the distributed step has no extra line', () => {
    const out = overlayApproval(server(), progress({ signed: true, approved: true, delivery: 'delivered', waiting: 0 }));
    expect(out.find((s) => s.id === 'distributed')?.description).toBeUndefined();
  });

  it('a delivery that failed or partly failed is NOT done: it stays current and names the exact retry command', () => {
    for (const delivery of ['failed', 'partial'] as const) {
      const out = overlayApproval(server(), progress({ signed: true, approved: true, delivery }));
      const step = out.find((s) => s.id === 'distributed');
      expect(step?.status).toBe('current');
      expect(step?.description).toContain(`machine admin distribute ${UUID}`);
    }
  });

  it('a failed delivery: the codes cannot be marked done before it (they stay to do, or current with the reason once the person answered)', () => {
    const failed = progress({ signed: true, approved: true, delivery: 'failed' });
    expect(statuses(overlayApproval(server(), failed))['final-code']).toBe('todo');
    const match = overlayApproval(server(), { ...failed, codes: 'match' }).find((s) => s.id === 'final-code');
    expect(match?.status).toBe('current');
    expect(match?.description).toMatch(/documents/);
  });

  it('the codes differ: the step is not done and says what to run', () => {
    const out = overlayApproval(server(), progress({ signed: true, approved: true, delivery: 'delivered', codes: 'differ' }));
    const step = out.find((s) => s.id === 'final-code');
    expect(step?.status).toBe('current');
    expect(step?.description).toContain('machine admin revoke laptop');
  });

  it('the first machine approving itself: nothing to deliver (done), nothing to compare with (never marked done)', () => {
    const out = overlayApproval(server(), progress({ signed: true, approved: true, selfApproval: true, delivery: 'none' }));
    expect(statuses(out)).toMatchObject({ distributed: 'done', 'final-code': 'current' });
    expect(out.find((s) => s.id === 'final-code')?.description).toMatch(/machine join --resume/);
  });

  it('a machine enrolled before (its admin key is already pinned there): the code step is "Not needed" once approved, never Done nor Current, and says why', () => {
    const out = overlayApproval(server(), progress({ signed: true, approved: true, delivery: 'delivered', noCode: true }));
    const step = out.find((s) => s.id === 'final-code');
    expect(step?.status).toBe('skipped');
    expect(step?.description).toBe('No code to compare: this machine already trusts your admin key.');
    // Whatever the person answers (the dialog shows no buttons), it stays not needed; and the delivery above still counts.
    expect(overlayApproval(server(), progress({ signed: true, approved: true, delivery: 'failed', noCode: true })).find((s) => s.id === 'final-code')?.status).toBe('skipped');
    expect(statuses(out)).toMatchObject({ signed: 'done', distributed: 'done' });
  });

  it('before the relay holds the approval the code step is still to do, even for a machine enrolled before', () => {
    const out = overlayApproval(server(), progress({ signed: true, noCode: true }));
    expect(out.find((s) => s.id === 'final-code')?.status).toBe('todo');
  });

  it('keeps title and info of every step', () => {
    const out = overlayApproval(server(), progress({ signed: true }));
    expect(out.map((s) => [s.id, s.title, s.info])).toEqual(server().map((s) => [s.id, s.title, s.info]));
  });

  it('INVARIANT: in every state of the approval flow, no later step is done while an earlier one is not', () => {
    const bools = [false, true];
    const deliveries = [undefined, 'delivered', 'partial', 'failed', 'none'] as const;
    const answers = [undefined, 'match', 'differ'] as const;
    let checked = 0;
    for (const signed of bools) {
      for (const approved of bools) {
        for (const selfApproval of bools) {
          for (const delivery of deliveries) {
            for (const answer of answers) {
              for (const waiting of [undefined, 0, 2]) {
                for (const noCode of bools) {
                  const state = progress({ signed, approved, selfApproval, noCode, ...(delivery === undefined ? {} : { delivery }), ...(answer === undefined ? {} : { codes: answer }), ...(waiting === undefined ? {} : { waiting }) });
                  const out = overlayApproval(server(), state);
                  expect(out.map((s) => s.id)).toEqual(ORDER);
                  // A step that does not apply ("Not needed") never blocks the ones after it, but nothing can be done after a step still to do or current.
                  const firstOpen = out.findIndex((s) => s.status !== 'done' && s.status !== 'skipped');
                  if (firstOpen !== -1) {
                    expect(out.slice(firstOpen).filter((s) => s.status === 'done').map((s) => s.id), JSON.stringify(state)).toEqual([]);
                  }
                  checked++;
                }
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(2 * 2 * 2 * 5 * 3 * 3 * 2);
  });
});
