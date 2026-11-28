import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  advanceClock,
  adminKey,
  approveCandidacy,
  approveContext,
  distribute,
  keepApprovalCode,
  listCandidacies,
  rebase,
  rejectCandidacy,
  type CandidaciesState,
  type RelayCandidacy,
} from '../commons/candidaciesState.js';
import type { ApproveRequest, CandidaciesAnswer, ErrorBody } from '../commons/routeContracts.js';

// The pure state machine of the Candidacies page (no React, no Node API in the module: the browser mock wraps it). The equivalence with the REAL backend routes is
// proved in src/backend/scenarioSeeds/seeds.test.ts; here the transitions are proved on a small hand-made state.

const NOW = 1_795_860_000;
const ADMIN = '00000000-0000-4000-8000-000000000001';
const PEER = '00000000-0000-4000-8000-000000000002';
const CAND = '00000000-0000-4000-8000-000000000003';
const RANDOM = 'AQEBAQEBAQEBAQEBAQEBAQ';
const KEY = 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM';

const candidacy = (over: Partial<RelayCandidacy> = {}): RelayCandidacy => ({
  id: 'cand-mac-m2',
  name: 'mac-m2',
  hostname: 'mac-m2.local',
  observedIp: '192.0.2.10',
  uuid: CAND,
  createdAt: NOW - 600,
  expiresAt: NOW + 300,
  status: 'pending',
  uuidBound: false,
  identityPublicKey: KEY,
  random: RANDOM,
  code: 'ABCDE12345',
  problems: [],
  ...over,
});

const STEPS = ['received', 'checked', 'signed', 'distributed', 'final-code'].map((id) => ({ id, title: `Title of ${id}`, info: `Info of ${id}` }));

const base = (over: Partial<CandidaciesState> = {}): CandidaciesState => ({
  now: NOW,
  relayError: null,
  adminKeyFile: '{"v":2}',
  admin: { uuid: ADMIN, name: 'midgard2', identityPublicKey: KEY, publicKey: KEY, keyId: 'a'.repeat(32) },
  trusted: [],
  revoked: {},
  candidacies: [candidacy()],
  approvals: [],
  approvalsProblem: '',
  timelineSteps: STEPS,
  distributions: {},
  ...over,
});

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
};

const request = (c: RelayCandidacy): ApproveRequest => ({ approval: { v: 2, random: c.random, sealed: 'c2VhbGVk' }, adminImport: { candidateUuid: c.uuid, random: c.random } });
const list = (state: CandidaciesState): CandidaciesAnswer => {
  const out = listCandidacies(state).answer;
  expect(out.status).toBe(200);
  return out.body as CandidaciesAnswer;
};
const error = (answer: { status: number; body: unknown }, status: number, kind: string): ErrorBody => {
  expect(answer.status).toBe(status);
  const body = answer.body as ErrorBody;
  expect(body.kind).toBe(kind);
  expect(body.message).toBe(body.error);
  return body;
};

describe('list', () => {
  it('empty: no row, the five steps to do, no note', () => {
    const out = list(base({ candidacies: [] }));
    expect(out.count).toBe(0);
    expect(out.candidacies).toEqual([]);
    expect(out.timeline.map((s) => s.status)).toEqual(['todo', 'todo', 'todo', 'todo', 'todo']);
    expect(out.timelineNote).toBe('');
  });

  it('one pending: a row that can be approved, the details step is the current one', () => {
    const out = list(base());
    const row = out.candidacies[0];
    expect(row).toMatchObject({ name: 'mac-m2', ageText: '10 min', statusText: 'Pending', canDecide: true, canApprove: true, rebind: false, ageSeconds: 600 });
    expect(row?.bindingText).toContain('The uuid is not bound yet: approving creates the binding.');
    expect(out.timeline.map((s) => s.status)).toEqual(['done', 'current', 'todo', 'todo', 'todo']);
    expect(out.timelineNote).toBe('The timeline follows "mac-m2" (posted 10 min ago): pending.');
  });

  it('several pending: the timeline follows the oldest and says so', () => {
    const out = list(base({ candidacies: [candidacy({ id: 'young', name: 'thinkcentre', createdAt: NOW - 60 }), candidacy()] }));
    expect(out.count).toBe(2);
    expect(out.timelineNote).toBe('The timeline follows "mac-m2" (posted 10 min ago), the oldest pending of 2 candidacies: pending.');
  });

  it('problems: the row cannot be approved but can be rejected, and says why', () => {
    const row = list(base({ candidacies: [candidacy({ problems: ['the candidacy carries no uuid'], uuid: undefined })] })).candidacies[0];
    expect(row).toMatchObject({ canApprove: false, canDecide: true, statusText: 'Cannot be approved: the candidacy carries no uuid' });
  });

  it('a binding to another token is a rebind and the row says it', () => {
    const row = list(base({ candidacies: [candidacy({ uuidBound: true, boundTokenLabel: '(revoked token)', boundToCandidateToken: false })] })).candidacies[0];
    expect(row).toMatchObject({ rebind: true, statusText: 'Warning: uuid already bound to a token' });
    expect(row?.bindingText).toContain('The uuid is already bound to the token labelled "(revoked token)"; approving replaces that binding.');
  });

  it('a relay error answers the error body for the list', () => {
    const relayError: ErrorBody = { status: 503, kind: 'relay_not_configured', error: 'no admin token', message: 'no admin token' };
    expect(listCandidacies(base({ relayError })).answer).toEqual({ status: 503, body: relayError });
  });
});

describe('purity', () => {
  it('no action changes the state it receives (a frozen state does not throw), and the answer is a new object each time', () => {
    const state = deepFreeze(base({ trusted: [] }));
    approveCandidacy(state, 'cand-mac-m2', request(candidacy()));
    rejectCandidacy(state, 'cand-mac-m2');
    keepApprovalCode(state, { uuid: CAND, name: 'mac-m2', code: '12345 12345 12345 12345 12345' });
    advanceClock(state, 10);
    rebase(state, NOW + 5);
    expect(listCandidacies(state).answer).not.toBe(listCandidacies(state).answer);
  });
});

describe('approve', () => {
  it('pending -> approved: the candidate is trusted, the row cannot be decided any more, nothing is lost for the others', () => {
    const state = base();
    const step = approveCandidacy(state, 'cand-mac-m2', request(candidacy()));
    expect(step.answer.status).toBe(200);
    expect(step.answer.body).toEqual({ ok: true, id: 'cand-mac-m2', message: 'Candidacy cand-mac-m2 approved: the candidate finishes on its next check, after the security codes are compared', imported: { uuid: CAND, name: 'mac-m2' } });
    const row = list(step.state).candidacies[0];
    expect(row).toMatchObject({ relayStatus: 'approved', statusText: 'Approved by the admin (relay status: approved)', canDecide: false, canApprove: false });
    expect(list(step.state).timeline.map((s) => s.status)).toEqual(['done', 'done', 'done', 'unrecorded', 'unrecorded']);
    const context = approveContext(step.state, CAND).answer.body as { candidate: { trusted: boolean } };
    expect(context.candidate.trusted).toBe(true);
    expect(list(state).candidacies[0]?.relayStatus).toBe('pending');
  });

  it('an unknown id: 404 with the fix; a second approval: 409 not pending', () => {
    const state = base();
    expect(error(approveCandidacy(state, 'nope', request(candidacy())).answer, 404, 'not_found').error).toContain('machine join --resume');
    const approved = approveCandidacy(state, 'cand-mac-m2', request(candidacy())).state;
    expect(error(approveCandidacy(approved, 'cand-mac-m2', request(candidacy())).answer, 409, 'not_pending').error).toContain('Reload the page');
  });

  it('another random than the one listed now: 409 random_mismatch, nothing approved', () => {
    const step = approveCandidacy(base(), 'cand-mac-m2', { approval: { v: 2, random: 'other', sealed: 'c2VhbGVk' }, adminImport: null });
    error(step.answer, 409, 'random_mismatch');
    expect(list(step.state).candidacies[0]?.relayStatus).toBe('pending');
  });

  it('a candidacy with problems or expired cannot be approved: 409 and the problem is named', () => {
    const problem = base({ candidacies: [candidacy({ problems: ['the candidacy carries no uuid'] })] });
    expect(error(approveCandidacy(problem, 'cand-mac-m2', request(candidacy())).answer, 409, 'not_pending').error).toContain('the candidacy carries no uuid');
    const expired = advanceClock(base(), 301).state;
    expect(error(approveCandidacy(expired, 'cand-mac-m2', request(candidacy())).answer, 409, 'not_pending').error).toContain('expired');
  });

  it('without an import for the admin machine, only the admin machine itself may be approved', () => {
    const step = approveCandidacy(base(), 'cand-mac-m2', { approval: request(candidacy()).approval, adminImport: null });
    error(step.answer, 409, 'import_required');
  });

  it('a malformed body is a 400 that names the rule (the page cannot send it, a regression would)', () => {
    error(approveCandidacy(base(), 'cand-mac-m2', { approval: { v: 1 } } as never).answer, 400, 'bad_request');
  });

  it('a revoked machine is enrolled again: the revocation is forgotten', () => {
    const state = base({ revoked: { [CAND]: 3 } });
    expect((approveContext(state, CAND).answer.body as { candidate: unknown }).candidate).toEqual({ trusted: false, revokedSerial: 3 });
    const after = approveCandidacy(state, 'cand-mac-m2', request(candidacy())).state;
    expect(after.revoked).toEqual({});
  });

  it('a relay error refuses the approval with the same body', () => {
    const relayError: ErrorBody = { status: 502, kind: 'relay_error', error: 'the relay is unreachable', message: 'the relay is unreachable' };
    expect(approveCandidacy(base({ relayError }), 'cand-mac-m2', request(candidacy())).answer).toEqual({ status: 502, body: relayError });
  });
});

describe('reject', () => {
  it('removes the row', () => {
    const step = rejectCandidacy(base(), 'cand-mac-m2');
    expect(step.answer).toEqual({ status: 200, body: { ok: true, id: 'cand-mac-m2', message: 'Candidacy cand-mac-m2 rejected: the candidate is told on its next check' } });
    expect(list(step.state).count).toBe(0);
  });

  it('an unknown id is 404, an approved one is 409', () => {
    error(rejectCandidacy(base(), 'nope').answer, 404, 'not_found');
    const approved = approveCandidacy(base(), 'cand-mac-m2', request(candidacy())).state;
    error(rejectCandidacy(approved, 'cand-mac-m2').answer, 409, 'not_pending');
  });
});

describe('the code kept after an approval', () => {
  const code = '12345 67890 12345 67890 12345';

  it('is recorded, then shown on the final step of the approved candidacy and in the reminders', () => {
    const approved = approveCandidacy(base(), 'cand-mac-m2', request(candidacy())).state;
    const kept = keepApprovalCode(approved, { uuid: CAND, name: 'mac-m2', code });
    expect(kept.answer).toEqual({ status: 200, body: { ok: true } });
    const out = list(advanceClock(kept.state, 120).state);
    expect(out.approvals).toEqual([{ uuid: CAND, name: 'mac-m2', code, ageText: '2 min' }]);
    expect(out.timeline[4]).toMatchObject({ status: 'unrecorded', description: `Security code of "mac-m2": ${code}. It must read exactly the same on mac-m2.` });
  });

  it('a second code of the same machine replaces the first; reminders older than 7 days are dropped', () => {
    const once = keepApprovalCode(base(), { uuid: CAND, name: 'mac-m2', code }).state;
    const twice = keepApprovalCode(once, { uuid: CAND, name: 'mac-m2', code: '11111 11111 11111 11111 11111' }).state;
    expect(list(twice).approvals.map((a) => a.code)).toEqual(['11111 11111 11111 11111 11111']);
    expect(list(advanceClock(twice, 7 * 24 * 3600).state).approvals).toEqual([]);
  });

  it('refuses a body that is not exactly uuid, name and a code of five groups of five digits', () => {
    error(keepApprovalCode(base(), { uuid: CAND, name: 'mac-m2', code: '123' }).answer, 400, 'bad_request');
    error(keepApprovalCode(base(), { uuid: 'x', name: 'mac-m2', code }).answer, 400, 'bad_request');
    error(keepApprovalCode(base(), { uuid: CAND, name: 'mac-m2', code, extra: 1 } as never).answer, 400, 'bad_request');
  });
});

describe('the clock', () => {
  it('advancing past the expiry: the row cannot be decided, says it is expired and the timeline says so', () => {
    const out = list(advanceClock(base(), 301).state);
    expect(out.candidacies[0]).toMatchObject({ canDecide: false, canApprove: false, ageText: '15 min' });
    expect(out.candidacies[0]?.problems.at(-1)).toContain('expired');
    expect(out.timelineNote).toBe('The timeline follows "mac-m2" (posted 15 min ago): expired: the candidate must post a new one.');
  });

  it('rebase moves every date, so a seed built once stays "10 min old" whenever it is loaded', () => {
    const moved = rebase(base({ approvals: [{ uuid: CAND, name: 'mac-m2', code: '12345 12345 12345 12345 12345', at: NOW - 60 }] }), NOW + 86_400);
    expect(moved.now).toBe(NOW + 86_400);
    expect(moved.candidacies[0]).toMatchObject({ createdAt: NOW + 86_400 - 600, expiresAt: NOW + 86_400 + 300 });
    expect(moved.approvals[0]?.at).toBe(NOW + 86_400 - 60);
    expect(list(moved).candidacies[0]?.ageText).toBe('10 min');
  });
});

describe('distribute', () => {
  const body = { candidateUuid: CAND, documents: [], noticeRecipients: null };
  const answer = { ok: true as const, subject: { uuid: CAND, name: 'mac-m2' }, failed: false, report: {}, text: { out: '[ok] done\n', err: '' }, machines: [], retry: `machine admin distribute ${CAND}` };

  it('before the approval the candidate is not trusted here: 409 not-imported', () => {
    error(distribute(base({ distributions: { [CAND]: answer } }), body).answer, 409, 'not-imported');
  });

  it('after the approval it answers the delivery the scenario planned', () => {
    const approved = approveCandidacy(base({ distributions: { [CAND]: answer } }), 'cand-mac-m2', request(candidacy())).state;
    expect(distribute(approved, body).answer).toEqual({ status: 200, body: answer });
  });

  it('no planned delivery is a loud 502, never a made-up success', () => {
    const approved = approveCandidacy(base(), 'cand-mac-m2', request(candidacy())).state;
    expect(error(distribute(approved, body).answer, 502, 'mock_no_delivery').error).toContain(CAND);
  });

  it('a malformed body is a 400', () => {
    error(distribute(base(), { candidateUuid: 'x', documents: [], noticeRecipients: null }).answer, 400, 'bad_request');
  });
});

describe('admin key and context', () => {
  it('the key file is the text of the state', () => {
    expect(adminKey(base()).answer).toEqual({ status: 200, body: { file: '{"v":2}' } });
  });

  it('the context of an unknown uuid is a candidate that is not trusted', () => {
    const body = approveContext(base(), CAND).answer.body as { ok: true; candidate: unknown; others: unknown[]; noticeRecipients: unknown; adminMachine: { name: string } };
    expect(body).toMatchObject({ ok: true, candidate: { trusted: false }, others: [], noticeRecipients: null, adminMachine: { name: 'midgard2' } });
  });

  it('a malformed uuid is the 400 of the backend', () => {
    error(approveContext(base(), 'x').answer, 400, 'bad_request');
  });
});

describe('browser safety of the commons', () => {
  const dir = fileURLToPath(new URL('../commons/', import.meta.url));
  const sources = readdirSync(dir).filter((f) => f.endsWith('.ts'));

  it('has sources to check', () => {
    expect(sources).toContain('candidaciesState.ts');
    expect(sources).toContain('routeContracts.ts');
  });

  it.each(sources)('%s imports nothing from node or from another package and touches no Node global', (file) => {
    const text = readFileSync(`${dir}${file}`, 'utf8');
    expect(text).not.toMatch(/from 'node:/);
    expect(text).not.toMatch(/from '@wadeck-app/);
    expect(text).not.toMatch(/from '\.\.\//);
    expect(text).not.toMatch(/\b(process|Buffer|require)\b\s*[.(\[]/);
  });
});
