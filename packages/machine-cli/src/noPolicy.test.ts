import { describe, expect, it } from 'vitest';
import { FAST_POLL_MS, HOLD_POLL_MS,FAST_POLL_WINDOW_MS, noPolicyMessage, pendingPolicyNote, pollDelayMs } from './noPolicy.js';

describe('noPolicyMessage (target side, decision 70)', () => {
  it('mode admin: says the policy may just be in transit, and names the admin command', () => {
    const m = noPolicyMessage('admin', 'thinkcentre');
    expect(m).toContain('no policy is installed on this machine yet');
    expect(m).toContain('If the admin just ran `machine admin allow thinkcentre`');
    expect(m).toContain('within about a minute');
    expect(m).toContain('retry shortly');
    expect(m).toContain('`machine admin allow thinkcentre -- <command>` on the admin machine');
  });

  it('never sends people to sign-policy as the only path', () => {
    expect(noPolicyMessage('admin', 'a')).not.toContain('sign-policy');
    expect(noPolicyMessage('local', 'a')).not.toContain('sign-policy');
  });

  it('mode local: names the local command and not the relay', () => {
    const m = noPolicyMessage('local', 'thinkcentre');
    expect(m).toContain('no policy is installed on this machine yet');
    expect(m).toContain('`machine policy allow -- <command>`');
    expect(m).not.toContain('relay');
    expect(m).not.toContain('machine admin allow');
  });
});

describe('pendingPolicyNote (caller side)', () => {
  const base = { machine: 'thinkcentre', version: 1, issuedAt: 1_000, now: 1_090 };

  it('no-policy with a policy signed 90 s ago: says version, age, and retry delay', () => {
    expect(pendingPolicyNote({ ...base, reason: 'no-policy' })).toBe(
      'a policy (version 1) for thinkcentre was signed here 90 s ago and sent through the relay: it is not installed yet; retry in about 10 s',
    );
  });

  it('a policy signed 20 s ago: the retry delay is what is left of the minute', () => {
    expect(pendingPolicyNote({ ...base, now: 1_020, reason: 'no-policy' })).toContain('retry in about 40 s');
  });

  it('says "just now" for a policy signed seconds ago', () => {
    expect(pendingPolicyNote({ ...base, now: 1_002, reason: 'no-policy' })).toContain('signed here just now');
  });

  it('nothing for a policy signed long ago (the relay would have delivered it: the cause is elsewhere)', () => {
    expect(pendingPolicyNote({ ...base, now: 1_000 + 3_600, reason: 'no-policy' })).toBeUndefined();
  });

  it('nothing for a record dated in the future (clock skew is not a pending policy)', () => {
    expect(pendingPolicyNote({ ...base, now: 900, reason: 'no-policy' })).toBeUndefined();
  });

  it('not-listed: only when the recorded policy allows that command', () => {
    expect(pendingPolicyNote({ ...base, reason: 'not-listed', recordAllowsCommand: false })).toBeUndefined();
    expect(pendingPolicyNote({ ...base, reason: 'not-listed', recordAllowsCommand: true })).toContain('(version 1)');
  });

  it('other reasons: nothing', () => {
    expect(pendingPolicyNote({ ...base, reason: 'predates-start' })).toBeUndefined();
  });
});

describe('pollDelayMs (inbox cadence, decision 70)', () => {
  const normal = 60_000;
  it('documented constants', () => {
    expect(FAST_POLL_MS).toBe(10_000);
    expect(FAST_POLL_WINDOW_MS).toBe(300_000);
  });

  it('fast while a policy is needed and the window is open', () => {
    expect(pollDelayMs({ normalMs: normal, failures: 0, needsPolicy: true, elapsedMs: 0 })).toBe(10_000);
    expect(pollDelayMs({ normalMs: normal, failures: 0, needsPolicy: true, elapsedMs: 299_999 })).toBe(10_000);
  });

  it('normal once the window is over', () => {
    expect(pollDelayMs({ normalMs: normal, failures: 0, needsPolicy: true, elapsedMs: 300_000 })).toBe(60_000);
  });

  it('normal when no policy is needed', () => {
    expect(pollDelayMs({ normalMs: normal, failures: 0, needsPolicy: false, elapsedMs: 0 })).toBe(60_000);
  });

  it('a failing relay backs off whatever is needed (never hammered)', () => {
    expect(pollDelayMs({ normalMs: normal, failures: 1, needsPolicy: true, elapsedMs: 0 })).toBe(120_000);
    expect(pollDelayMs({ normalMs: normal, failures: 10, needsPolicy: true, elapsedMs: 0 })).toBe(600_000);
  });

  it('never slower than the normal cadence when that one is already faster', () => {
    expect(pollDelayMs({ normalMs: 5_000, failures: 0, needsPolicy: true, elapsedMs: 0 })).toBe(5_000);
  });

  describe('while a request is held (hold-for-approval)', () => {
    it('documented constant', () => {
      expect(HOLD_POLL_MS).toBe(5_000);
    });

    it('5 s while a hold is active, with no time window, whatever the elapsed time', () => {
      expect(pollDelayMs({ normalMs: normal, failures: 0, needsPolicy: false, elapsedMs: 0, holdActive: true })).toBe(5_000);
      expect(pollDelayMs({ normalMs: normal, failures: 0, needsPolicy: false, elapsedMs: 10_000_000, holdActive: true })).toBe(5_000);
    });

    it('wins over the 10 s policy cadence', () => {
      expect(pollDelayMs({ normalMs: normal, failures: 0, needsPolicy: true, elapsedMs: 0, holdActive: true })).toBe(5_000);
    });

    it('normal when the hold is over or absent', () => {
      expect(pollDelayMs({ normalMs: normal, failures: 0, needsPolicy: false, elapsedMs: 0, holdActive: false })).toBe(60_000);
    });

    it('a failing relay still backs off: an active hold never shortens the backoff', () => {
      expect(pollDelayMs({ normalMs: normal, failures: 1, needsPolicy: false, elapsedMs: 0, holdActive: true })).toBe(120_000);
      expect(pollDelayMs({ normalMs: normal, failures: 10, needsPolicy: false, elapsedMs: 0, holdActive: true })).toBe(600_000);
    });

    it('never slower than the normal cadence when that one is already faster', () => {
      expect(pollDelayMs({ normalMs: 2_000, failures: 0, needsPolicy: false, elapsedMs: 0, holdActive: true })).toBe(2_000);
    });
  });
});
