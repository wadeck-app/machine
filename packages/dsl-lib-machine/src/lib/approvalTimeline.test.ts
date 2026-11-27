import { describe, expect, it } from 'vitest';
import { overlayApproval, type ApprovalProgress } from './approvalTimeline.js';
import type { TimelineStep } from '../components/VerticalTimeline.js';

// The timeline of the Candidacies page is computed by the module from what the relay proves; while this page approves a candidacy it adds only what the page itself
// proves (admin-ui.md, "Approve from the page"): the passphrase was used, the relay accepted the approval, the delivery report, the person's answer on the codes.

const server = (): TimelineStep[] => [
  { id: 'received', title: 'Candidacy received', status: 'done', info: 'a' },
  { id: 'checked', title: 'Details checked', status: 'current', info: 'b' },
  { id: 'signed', title: 'Passphrase and signature', status: 'todo', info: 'c' },
  { id: 'final-code', title: 'Security code compared', status: 'todo', info: 'd' },
  { id: 'distributed', title: 'Documents distributed', status: 'todo', info: 'e' },
];
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
    expect(statuses(overlayApproval(server(), progress({ signed: true })))).toEqual({ received: 'done', checked: 'done', signed: 'current', 'final-code': 'todo', distributed: 'todo' });
  });

  it('the relay holds the approval: signed is done, the code waits for the person, the delivery is running', () => {
    expect(statuses(overlayApproval(server(), progress({ signed: true, approved: true })))).toEqual({ received: 'done', checked: 'done', signed: 'done', 'final-code': 'current', distributed: 'current' });
  });

  it('delivered: distributed is done; the code is done only when the person says both machines show the same', () => {
    const delivered = progress({ signed: true, approved: true, delivery: 'delivered' });
    expect(statuses(overlayApproval(server(), delivered))).toMatchObject({ signed: 'done', 'final-code': 'current', distributed: 'done' });
    expect(statuses(overlayApproval(server(), { ...delivered, codes: 'match' }))).toMatchObject({ 'final-code': 'done', distributed: 'done' });
  });

  it('a delivery that failed or partly failed is NOT done: it stays current and names the exact retry command', () => {
    for (const delivery of ['failed', 'partial'] as const) {
      const out = overlayApproval(server(), progress({ signed: true, approved: true, delivery }));
      const step = out.find((s) => s.id === 'distributed');
      expect(step?.status).toBe('current');
      expect(step?.description).toContain(`machine admin distribute ${UUID}`);
    }
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

  it('keeps title and info of every step', () => {
    const out = overlayApproval(server(), progress({ signed: true }));
    expect(out.map((s) => [s.id, s.title, s.info])).toEqual(server().map((s) => [s.id, s.title, s.info]));
  });
});
