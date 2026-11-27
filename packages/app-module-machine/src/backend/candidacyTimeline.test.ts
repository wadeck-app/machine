import { describe, expect, it } from 'vitest';
import type { CandidacyListView } from './candidacies.js';
import { candidacyTimeline } from './candidacyTimeline.js';

const NOW = 1_800_000_000;

function view(overrides: Partial<CandidacyListView> = {}): CandidacyListView {
  return {
    id: 'c1', name: 'laptop', hostname: 'H', observedIp: '198.51.100.2', uuid: undefined,
    createdAt: NOW - 84, expiresAt: NOW + 800, ageSeconds: 84, relayStatus: undefined,
    uuidBound: undefined, boundTokenLabel: undefined, boundToCandidateToken: undefined, rebind: false, bindingNote: undefined,
    code: undefined, identityPublicKey: undefined, random: undefined, problems: [],
    ...overrides,
  };
}

const statuses = (steps: { id: string; status: string }[]): Record<string, string> => Object.fromEntries(steps.map((s) => [s.id, s.status]));
const TODO = { received: 'todo', checked: 'todo', signed: 'todo', 'final-code': 'todo', distributed: 'todo' };

describe('candidacyTimeline', () => {
  it('always lists the five steps with their threat text', () => {
    const { steps } = candidacyTimeline([], NOW);
    expect(steps.map((s) => s.id)).toEqual(['received', 'checked', 'signed', 'final-code', 'distributed']);
    for (const step of steps) expect(step.info).toMatch(/^Threat: /);
  });

  it('no candidacy: every step is to do and there is nothing to follow', () => {
    const out = candidacyTimeline([], NOW);
    expect(statuses(out.steps)).toEqual(TODO);
    expect(out.note).toBe('');
  });

  it('one pending candidacy: received is done, checked is current, the rest is to do, and the note names it', () => {
    const out = candidacyTimeline([view({ name: 'macbook-pro-de-wadeck' })], NOW);
    expect(statuses(out.steps)).toEqual({ ...TODO, received: 'done', checked: 'current' });
    expect(out.note).toContain('macbook-pro-de-wadeck');
    expect(out.note).toContain('84 s');
  });

  it('an explicit relay status "pending" is the same as no status', () => {
    expect(statuses(candidacyTimeline([view({ relayStatus: 'pending' })], NOW).steps)).toEqual({ ...TODO, received: 'done', checked: 'current' });
  });

  it('several candidacies: follows the oldest pending one and says how many there are', () => {
    const out = candidacyTimeline([view({ id: 'new', name: 'newer', createdAt: NOW - 10 }), view({ id: 'old', name: 'older', createdAt: NOW - 500, ageSeconds: 500 }), view({ id: 'mid', name: 'middle', createdAt: NOW - 100 })], NOW);
    expect(out.note).toContain('older');
    expect(out.note).not.toContain('newer');
    expect(out.note).toContain('3');
    expect(statuses(out.steps)).toEqual({ ...TODO, received: 'done', checked: 'current' });
  });

  it('a candidacy without a usable date comes last when choosing the oldest', () => {
    const out = candidacyTimeline([view({ name: 'nodate', createdAt: undefined, ageSeconds: undefined }), view({ id: 'c2', name: 'dated' })], NOW);
    expect(out.note).toContain('dated');
  });

  it('prefers a pending candidacy over an older approved one', () => {
    const out = candidacyTimeline([view({ name: 'done-one', createdAt: NOW - 900, relayStatus: 'approved' }), view({ id: 'c2', name: 'waiting' })], NOW);
    expect(out.note).toContain('waiting');
    expect(statuses(out.steps).checked).toBe('current');
  });

  it('an expired candidacy is received but nothing can go on: checked is not current, and the note says it expired', () => {
    const out = candidacyTimeline([view({ expiresAt: NOW - 1 })], NOW);
    expect(statuses(out.steps)).toEqual({ ...TODO, received: 'done' });
    expect(out.note).toContain('expired');
  });

  it('an approved candidacy: received, checked and signed are done (the relay holds the signed approval), the CLI steps stay to do', () => {
    const out = candidacyTimeline([view({ relayStatus: 'approved' })], NOW);
    expect(statuses(out.steps)).toEqual({ ...TODO, received: 'done', checked: 'done', signed: 'done' });
    expect(out.note).toContain('approved');
  });

  it('a rejected candidacy: only received is done and no step is current', () => {
    const out = candidacyTimeline([view({ relayStatus: 'rejected' })], NOW);
    expect(statuses(out.steps)).toEqual({ ...TODO, received: 'done' });
    expect(out.note).toContain('rejected');
  });

  it('a relay status this page does not know: only received is done, and the note says the status is unknown', () => {
    const out = candidacyTimeline([view({ relayStatus: 'frozen' })], NOW);
    expect(statuses(out.steps)).toEqual({ ...TODO, received: 'done' });
    expect(out.note).toContain('frozen');
  });

  it('never marks the security code or the distribution as done: the page cannot observe them', () => {
    for (const relayStatus of [undefined, 'pending', 'approved', 'rejected', 'frozen']) {
      const s = statuses(candidacyTimeline([view({ relayStatus })], NOW).steps);
      expect(s['final-code']).toBe('todo');
      expect(s['distributed']).toBe('todo');
    }
  });
});
