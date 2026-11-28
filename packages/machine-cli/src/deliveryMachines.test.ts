import { describe, expect, it } from 'vitest';
import { deliveryMachines } from './deliveryMachines.js';
import { emptyReport, formatDistribution, type DistributionReport } from './distribute.js';

// The per-machine view of a distribution report (what the Candidacies page shows instead of the raw CLI text): one entry per machine told, with a state, a cause code,
// ONE short reason and ONE next action. It is derived from the very same report as `formatDistribution`, which stays byte-identical.

const RETRY = 'machine admin distribute 22222222-2222-4222-8222-222222222222';
const A = { uuid: '11111111-1111-4111-8111-111111111111', name: 'server' };
const B = { uuid: '33333333-3333-4333-8333-333333333333', name: 'laptop' };

const report = (over: Partial<DistributionReport> = {}): DistributionReport => ({ ...emptyReport(), machines: 2, ...over });
const direct = (to: { uuid: string; name: string }) => ({ toUuid: to.uuid, toName: to.name, kind: 'peer' as const, outcome: 'installed' as never, ms: 12 });
const fallback = (to: { uuid: string; name: string }, code: 'unreachable' | 'unknown-peer' | 'no-answer' | 'peer-too-old' | 'refused' | 'unexpected-answer', cause = 'boom') => ({
  toUuid: to.uuid,
  toName: to.name,
  kind: 'peer' as const,
  code,
  cause,
  ms: 3,
});

describe('deliveryMachines', () => {
  it('a machine that took every document directly is delivered, with nothing to do', () => {
    const out = deliveryMachines(report({ direct: [direct(A), direct(B)], noticeDirectNames: ['server', 'laptop'] }), [A, B], RETRY);
    expect(out.map((m) => [m.name, m.state, m.code, m.next])).toEqual([
      ['server', 'delivered', 'direct', 'nothing to do'],
      ['laptop', 'delivered', 'direct', 'nothing to do'],
    ]);
  });

  it('an unreachable machine waits in the relay inbox: "offline", it installs by itself, nothing to do', () => {
    const out = deliveryMachines(report({ delivered: 2, direct: [direct(A)], fallbacks: [fallback(B, 'unreachable')] }), [A, B], RETRY);
    expect(out[1]).toMatchObject({ uuid: B.uuid, state: 'inbox', code: 'unreachable', reason: 'offline', next: 'installs by itself when it is back, nothing to do' });
  });

  it('no direct channel at all: every machine waits in the relay inbox, nothing to do', () => {
    const out = deliveryMachines(report({ delivered: 4 }), [A, B], RETRY);
    expect(out.map((m) => [m.state, m.code])).toEqual([['inbox', 'inbox'], ['inbox', 'inbox']]);
    expect(out[0]?.next).toMatch(/nothing to do/);
  });

  it('a document that was stored by the relay before (alreadyThere) is still in the inbox, not a failure', () => {
    const out = deliveryMachines(report({ alreadyThere: 4 }), [A, B], RETRY);
    expect(out.every((m) => m.state === 'inbox')).toBe(true);
  });

  it('an older build and a refusal are in the inbox too, but the next action is NOT "nothing to do"', () => {
    const out = deliveryMachines(report({ delivered: 2, fallbacks: [fallback(A, 'peer-too-old'), fallback(B, 'refused', 'clock skew')] }), [A, B], RETRY);
    expect(out[0]).toMatchObject({ state: 'inbox', code: 'peer-too-old', reason: 'runs an older build' });
    expect(out[0]?.next).toContain('machine cli update');
    expect(out[0]?.next).toContain(RETRY);
    expect(out[1]).toMatchObject({ state: 'inbox', code: 'refused', reason: 'refused the documents' });
    expect(out[1]?.next).toContain(RETRY);
    expect(out[1]?.next).not.toMatch(/nothing to do/);
  });

  it('an incompatible answer says to update both machines', () => {
    const out = deliveryMachines(report({ delivered: 2, fallbacks: [fallback(A, 'unexpected-answer')] }), [A], RETRY);
    expect(out[0]?.next).toContain('machine cli update');
  });

  it('a failure to store a document makes the machine failed, whatever else reached it, and the next action is the retry command', () => {
    const out = deliveryMachines(report({ delivered: 1, direct: [direct(A)], failures: [{ toUuid: A.uuid, toName: 'server', kind: 'peer', id: 'x', message: 'relay down' }] }), [A, B], RETRY);
    expect(out[0]).toMatchObject({ state: 'failed', code: 'not-stored', reason: 'documents not stored' });
    expect(out[0]?.next).toContain(RETRY);
  });

  it('an aborted distribution: a machine with no trace of delivery was not attempted (failed), one that took its documents is not blamed', () => {
    const out = deliveryMachines(report({ aborted: true, direct: [direct(A)], failures: [{ toUuid: B.uuid, toName: 'laptop', kind: 'peer', id: 'y', message: 'token refused' }] }), [A, B, { uuid: '44444444-4444-4444-8444-444444444444', name: 'nas' }], RETRY);
    expect(out.map((m) => [m.name, m.state, m.code])).toEqual([['server', 'delivered', 'direct'], ['laptop', 'failed', 'not-stored'], ['nas', 'failed', 'not-attempted']]);
    expect(out[2]?.next).toContain(RETRY);
  });

  it('never leaks the cause text of a failure into the short reason (the cause stays in the raw report)', () => {
    const out = deliveryMachines(report({ failures: [{ toUuid: A.uuid, toName: 'server', kind: 'peer', id: 'x', message: 'a very long relay message '.repeat(20) }] }), [A], RETRY);
    expect(out[0]?.reason.length).toBeLessThan(60);
  });

  it('the CLI text does not change: formatDistribution of the same report is untouched by the structured view', () => {
    const r = report({ delivered: 2, fallbacks: [fallback(B, 'unreachable')] });
    const before = formatDistribution(r, 'the approval', RETRY);
    deliveryMachines(r, [A, B], RETRY);
    expect(formatDistribution(r, 'the approval', RETRY)).toEqual(before);
  });
});
