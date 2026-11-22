import { describe, expect, it } from 'vitest';
import type { AllowResult } from './allowFlow.js';
import { deliverySummary } from './deliverySummary.js';

// The delivery of a policy after Allow, in ONE short line per fact (the cause in a smaller line, the long wording only for a details disclosure).

const target = { uuid: 'u', name: 'thinkcentre' };
const SKEW_CAUSE = "thinkcentre refused the document (not-yet-valid): thinkcentre's clock is 3 min behind this machine (its time 10:00:00, this machine 10:03:00): fix its time sync (Linux: `timedatectl status`, Windows: `w32tm /query /status`)";
const inbox = (fallback: AllowResult['fallback'], text: string): AllowResult => ({ ok: true, target, version: 1, delivery: 'inbox', ...(fallback !== undefined ? { fallback } : {}), deliveryText: { tone: 'warning', text } });

describe('deliverySummary', () => {
  it('a refusal for the clock names the skew in the short line, and the cause is not repeated in a second line', () => {
    const s = deliverySummary(inbox({ code: 'refused', cause: SKEW_CAUSE }, `thinkcentre did not take the document directly: stored in the relay inbox, it installs it when it comes back (next poll within 60 s, or 5 s while it holds a request). Cause: ${SKEW_CAUSE}`));
    expect(s.tone).toBe('warning');
    expect(s.text).toBe('Stored on the relay (direct delivery refused: clock 3 min behind)');
    expect(s.cause).toBeUndefined();
    // The long wording (with the fix) stays available for the disclosure.
    expect(s.explanation).toContain('fix its time sync');
  });

  it('a clock ahead is said ahead, with the unit of the measure', () => {
    const cause = "thinkcentre's clock is 3 h 2 min ahead of this machine (its time 13:00:00, this machine 09:58:00): fix its time sync (x)";
    expect(deliverySummary(inbox({ code: 'refused', cause }, `x. Cause: ${cause}`)).text).toBe('Stored on the relay (direct delivery refused: clock 3 h 2 min ahead)');
  });

  it('a cause that is not a skew goes to the secondary line, and the explanation does not repeat it', () => {
    const s = deliverySummary(inbox({ code: 'unreachable', cause: 'connect timed out' }, 'thinkcentre is not reachable directly: stored in the relay inbox, it installs it when it comes back (next poll within 60 s, or 5 s while it holds a request). Cause: connect timed out'));
    expect(s.text).toBe('Stored on the relay (not reachable directly)');
    expect(s.cause).toBe('connect timed out');
    expect(s.explanation).not.toContain('connect timed out');
    expect(s.explanation).toContain('next poll within 60 s');
  });

  it('an older daemon sends no structured fallback: the cause is read from its sentence, never lost', () => {
    const s = deliverySummary(inbox(undefined, 'thinkcentre is not reachable directly: stored in the relay inbox. Cause: connect timed out'));
    expect(s.text).toBe('Stored on the relay (direct delivery failed)');
    expect(s.cause).toBe('connect timed out');
  });

  it('stored in the relay without a direct attempt: no reason in brackets, no cause', () => {
    const s = deliverySummary({ ok: true, target, version: 1, delivery: 'inbox' });
    expect(s).toMatchObject({ tone: 'warning', text: 'Stored on the relay' });
    expect(s.cause).toBeUndefined();
    expect(s.explanation).toMatch(/next poll.*60 s.*5 s while it holds a request/);
  });

  it('a direct delivery and a local installation keep the short sentence of the daemon, with the success tone', () => {
    expect(deliverySummary({ ok: true, target, version: 1, delivery: 'direct', deliveryText: { tone: 'success', text: 'Delivered directly to thinkcentre (installed, 0.4 s)' } })).toEqual({ tone: 'success', text: 'Delivered directly to thinkcentre (installed, 0.4 s)' });
    expect(deliverySummary({ ok: true, target, version: 1, delivery: 'installed' })).toEqual({ tone: 'success', text: 'Installed on thinkcentre' });
  });

  it.each([
    ['peer-too-old', 'Stored on the relay (peer too old for direct delivery)'],
    ['no-answer', 'Stored on the relay (not reachable directly)'],
    ['unexpected-answer', 'Stored on the relay (direct delivery failed)'],
  ])('the code %s is worded short', (code, text) => {
    expect(deliverySummary(inbox({ code, cause: 'some cause' }, 'x. Cause: some cause')).text).toBe(text);
  });
});
