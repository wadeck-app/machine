import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOLD_POLL_MS, HOLD_TIMEOUT_MS, elapsedText, initialProgress, noConfirmationMessage, percentOf, reduceProgress, startHoldPolling, stepsOf, type HoldPollAnswer, type ProgressRecord } from './allowProgress.js';

// The progress after "Allow and sign" (decision 86): every step is driven by a REAL event (the signature, the answer of the daemon about the delivery, the
// end of the hold that the target reported). A success is never shown without the end of the hold.

const T0 = 1_000_000;
const held = (over: Partial<ProgressRecord> = {}): ProgressRecord => ({ ...initialProgress({ machineName: 'thinkcentre', held: true, now: T0 }), ...over });
const labels = (r: ProgressRecord, now = T0) => stepsOf(r, now).map((s) => `${s.state}:${s.label}`);
const direct = { ok: true as const, delivery: 'direct' as const, target: { uuid: 'u', name: 'thinkcentre' }, version: 1, direct: { outcome: 'installed' as const, ms: 412 }, deliveryText: { tone: 'success' as const, text: 'Delivered directly to thinkcentre (installed, 0.4 s)' } };
const inbox = { ok: true as const, delivery: 'inbox' as const, target: { uuid: 'u', name: 'thinkcentre' }, version: 1, deliveryText: { tone: 'warning' as const, text: 'thinkcentre is not reachable directly: stored in the relay inbox, ...' } };

describe('steps of the progress', () => {
  it('before anything: signing is the active step, nothing else is done', () => {
    expect(labels(held())).toEqual(['active:Signing', 'pending:Delivering', 'pending:thinkcentre installs the policy', 'pending:The held command is released']);
    expect(percentOf(held())).toBe(0);
  });

  it('signed, delivery not answered yet: the delivery is the active step', () => {
    const r = reduceProgress(held(), { type: 'signed' }, T0 + 1000);
    expect(labels(r, T0 + 1000)).toEqual(['done:Signed', 'active:Delivering', 'pending:thinkcentre installs the policy', 'pending:The held command is released']);
    expect(percentOf(r)).toBe(25);
  });

  it('delivered directly and installed: steps 2 and 3 are done at once (the target said installed), the release is awaited', () => {
    const r = reduceProgress(reduceProgress(held(), { type: 'signed' }, T0 + 1000), { type: 'result', result: direct }, T0 + 1400);
    expect(labels(r, T0 + 1400)).toEqual(['done:Signed', 'done:Delivered directly to thinkcentre', 'done:thinkcentre installed the policy', 'active:Waiting for the held command to be released']);
    expect(percentOf(r)).toBe(75);
  });

  it('stored in the relay: step 3 is waiting, and says how long it can take', () => {
    const r = reduceProgress(reduceProgress(held(), { type: 'signed' }, T0 + 1000), { type: 'result', result: inbox }, T0 + 1400);
    const steps = stepsOf(r, T0 + 1400);
    expect(steps.map((s) => `${s.state}:${s.label}`)).toEqual(['done:Signed', 'done:Stored on the relay', 'active:thinkcentre installs the policy', 'pending:The held command is released']);
    expect(steps[2]?.detail).toMatch(/next inbox poll.*60 s.*5 s while it holds a request/);
    expect(percentOf(r)).toBe(50);
  });

  it('the end of the hold reported as allowed completes every step: this is the only success', () => {
    let r = reduceProgress(held(), { type: 'signed' }, T0 + 1000);
    r = reduceProgress(r, { type: 'result', result: inbox }, T0 + 1400);
    r = reduceProgress(r, { type: 'hold', answer: { state: 'ended', outcome: 'allowed' } }, T0 + 7000);
    expect(labels(r, T0 + 7000)).toEqual(['done:Signed', 'done:Stored on the relay', 'done:thinkcentre installed the policy', 'done:The held command was released']);
    expect(percentOf(r)).toBe(100);
    expect(r.finishedAt).toBe(T0 + 7000);
  });

  it('a delivery that said installed is NOT a success by itself: without the end notice the last step is still active', () => {
    const r = reduceProgress(reduceProgress(held(), { type: 'signed' }, T0), { type: 'result', result: direct }, T0);
    expect(stepsOf(r, T0)[3]?.state).toBe('active');
    expect(percentOf(r)).toBeLessThan(100);
  });

  it.each([
    ['denied', /denied/],
    ['deadline', /wait ended|deadline/],
    ['disconnected', /caller disconnected/],
    ['refused', /refused/],
    ['revoked', /revoked/],
  ] as const)('an end with the outcome %s is a failure of the last step, with the cause', (outcome, text) => {
    let r = reduceProgress(held(), { type: 'signed' }, T0);
    r = reduceProgress(r, { type: 'result', result: direct }, T0);
    r = reduceProgress(r, { type: 'hold', answer: { state: 'ended', outcome } }, T0 + 2000);
    const last = stepsOf(r, T0 + 2000)[3];
    expect(last?.state).toBe('failed');
    expect(`${last?.label} ${last?.detail}`).toMatch(text);
    expect(percentOf(r)).toBeLessThan(100);
    expect(r.finishedAt).toBe(T0 + 2000);
  });

  it('after 3 minutes without the end: the honest message, never a success', () => {
    let r = reduceProgress(held(), { type: 'signed' }, T0);
    r = reduceProgress(r, { type: 'result', result: inbox }, T0);
    r = reduceProgress(r, { type: 'timeout' }, T0 + HOLD_TIMEOUT_MS);
    const steps = stepsOf(r, T0 + HOLD_TIMEOUT_MS);
    expect(steps[3]?.state).toBe('failed');
    expect(steps[3]?.detail).toBe('no confirmation from thinkcentre: it may be offline, or it runs an older build: check machine requests thinkcentre');
    expect(noConfirmationMessage('thinkcentre')).toBe(steps[3]?.detail);
    expect(percentOf(r)).toBeLessThan(100);
  });

  it('a request nobody waits for (not held) has three steps and never claims a release', () => {
    let r = reduceProgress(initialProgress({ machineName: 'thinkcentre', held: false, now: T0 }), { type: 'signed' }, T0);
    r = reduceProgress(r, { type: 'result', result: direct }, T0);
    expect(labels(r)).toEqual(['done:Signed', 'done:Delivered directly to thinkcentre', 'done:thinkcentre installed the policy']);
    expect(percentOf(r)).toBe(100);
  });

  it('a request held on THIS machine: the target is this machine, installed here, and the local hold gives the end', () => {
    let r = reduceProgress(initialProgress({ machineName: 'desktop', held: true, now: T0 }), { type: 'signed' }, T0);
    r = reduceProgress(r, { type: 'result', result: { ok: true, delivery: 'installed', target: { uuid: 'u', name: 'desktop' }, version: 1, deliveryText: { tone: 'success', text: 'Installed on desktop (this machine)' } } }, T0);
    expect(labels(r)).toEqual(['done:Signed', 'done:Installed on desktop (this machine)', 'done:desktop installed the policy', 'active:Waiting for the held command to be released']);
  });

  it('a failure of the post is a failure of the delivery step, with the message', () => {
    let r = reduceProgress(held(), { type: 'signed' }, T0);
    r = reduceProgress(r, { type: 'failed', message: 'the relay did not store it' }, T0 + 500);
    const steps = stepsOf(r, T0 + 500);
    expect(steps[1]).toMatchObject({ state: 'failed', detail: 'the relay did not store it' });
    expect(r.finishedAt).toBe(T0 + 500);
  });
});

describe('elapsed time', () => {
  it('counts from the click and freezes at the end', () => {
    const r = held();
    expect(elapsedText(r, T0 + 4000)).toBe('4 s');
    const done = reduceProgress(reduceProgress(r, { type: 'signed' }, T0), { type: 'hold', answer: { state: 'ended', outcome: 'allowed' } }, T0 + 9000);
    expect(elapsedText(done, T0 + 60_000)).toBe('9 s');
    expect(elapsedText(held(), T0 + 125_000)).toBe('2 min 5 s');
  });
});

describe('polling the daemon', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(answers: Array<HoldPollAnswer | Error>) {
    const asked: string[] = [];
    let i = 0;
    const updates: Array<{ type: string; answer?: HoldPollAnswer; message?: string }> = [];
    const stop = startHoldPolling({
      get: async (path) => {
        asked.push(path);
        const a = answers[Math.min(i++, answers.length - 1)];
        if (a instanceof Error) {
          throw a;
        }
        return a;
      },
      machine: 'self',
      id: '3f1c2d3e-4a5b-4c6d-8e7f-000000000001',
      now: () => Date.now(),
      onEvent: (e) => void updates.push(e as never),
    });
    return { asked, updates, stop };
  }

  it('asks at once, then every 2 s, and stops at the end of the hold', async () => {
    const w = setup([{ state: 'held' }, { state: 'held' }, { state: 'ended', outcome: 'allowed' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.asked).toEqual(['/hold-progress/self/3f1c2d3e-4a5b-4c6d-8e7f-000000000001']);
    await vi.advanceTimersByTimeAsync(HOLD_POLL_MS);
    await vi.advanceTimersByTimeAsync(HOLD_POLL_MS);
    expect(w.asked).toHaveLength(3);
    expect(w.updates.at(-1)).toMatchObject({ type: 'hold', answer: { state: 'ended', outcome: 'allowed' } });
    await vi.advanceTimersByTimeAsync(10 * HOLD_POLL_MS);
    expect(w.asked).toHaveLength(3);
  });

  it('gives up after 3 minutes with a timeout event, and asks no more', async () => {
    const w = setup([{ state: 'unknown' }]);
    await vi.advanceTimersByTimeAsync(HOLD_TIMEOUT_MS + HOLD_POLL_MS);
    expect(w.updates.at(-1)).toEqual({ type: 'timeout' });
    const asked = w.asked.length;
    await vi.advanceTimersByTimeAsync(10 * HOLD_POLL_MS);
    expect(w.asked).toHaveLength(asked);
  });

  it('an error of the daemon is reported once as an event and the polling goes on', async () => {
    const w = setup([new Error('daemon unreachable'), { state: 'ended', outcome: 'allowed' }]);
    await vi.advanceTimersByTimeAsync(HOLD_POLL_MS + 10);
    expect(w.updates.map((u) => u.type)).toEqual(['poll-error', 'hold']);
  });

  it('stop() ends the polling', async () => {
    const w = setup([{ state: 'held' }]);
    await vi.advanceTimersByTimeAsync(0);
    w.stop();
    await vi.advanceTimersByTimeAsync(10 * HOLD_POLL_MS);
    expect(w.asked).toHaveLength(1);
  });
});
