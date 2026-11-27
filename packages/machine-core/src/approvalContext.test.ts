import { describe, expect, it } from 'vitest';
import { approvalSealContext, importCandidateSealContext, pairSecretContext } from './approvalContext.js';

// The seal contexts of the enrollment by candidacy. They are part of the wire format: any change breaks every approval in flight, so they are pinned here.
const ADMIN = '11111111-1111-4111-8111-111111111111';
const CANDIDATE = '22222222-2222-4222-8222-222222222222';
const RANDOM = 'AAAAAAAAAAAAAAAAAAAAAA';

describe('seal contexts of the approval', () => {
  it('pair secret: one admin machine, one candidate, one candidacy, one entry', () => {
    expect(pairSecretContext({ adminUuid: ADMIN, candidateUuid: CANDIDATE, random: RANDOM, slot: 'self' })).toBe(`pair-secret:${ADMIN}:${CANDIDATE}:${RANDOM}:self`);
    expect(pairSecretContext({ adminUuid: null, candidateUuid: CANDIDATE, random: RANDOM, slot: `peer:${ADMIN}` })).toBe(`pair-secret:none:${CANDIDATE}:${RANDOM}:peer:${ADMIN}`);
  });

  it('approval: this candidate and this candidacy', () => {
    expect(approvalSealContext(CANDIDATE, RANDOM)).toBe(`approval:v2:${CANDIDATE}:${RANDOM}`);
  });

  it('import of a candidate on the admin machine: names the admin machine, the candidate and the candidacy, and differs from every other context', () => {
    const context = importCandidateSealContext(ADMIN, CANDIDATE, RANDOM);
    expect(context).toBe(`import-candidate:v1:${ADMIN}:${CANDIDATE}:${RANDOM}`);
    expect(context).not.toBe(pairSecretContext({ adminUuid: ADMIN, candidateUuid: CANDIDATE, random: RANDOM, slot: 'self' }));
    expect(context).not.toBe(approvalSealContext(CANDIDATE, RANDOM));
  });
});
