import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CandidaciesState, RelayCandidacy } from '../../commons/candidaciesState.js';
import { candidaciesRoutes } from '../../commons/candidaciesMock.js';
import { MODULE_PREFIX, type MockResponse, type MockRoutes } from '../../commons/mockRoutes.js';
import type { ApproveAnswer, ApproveContextAnswer, ApproveRequest, CandidaciesAnswer, DistributeAnswer, ErrorBody } from '../../commons/routeContracts.js';

// The routes of the Candidacies page on mock data (what the dev-only scenarios serve): the pure state machine behind seven routes, with the state kept in the closure.
// The state machine itself is proved against the REAL routes in seeds.test.ts; here: every route is answered, and what the user does changes what the next GET returns.

const SEEDS_DIR = fileURLToPath(new URL('../../commons/scenarioSeeds/', import.meta.url));
const seed = (name: string): CandidaciesState => JSON.parse(readFileSync(`${SEEDS_DIR}${name}.json`, 'utf8')) as CandidaciesState;

const CLOCK_START = 2_000_000_000;
const full = (key: string): string => `${key.split(' ')[0]} ${MODULE_PREFIX}${key.slice(key.indexOf(' ') + 1)}`;
const make = (name: string, clock: { now: number } = { now: CLOCK_START }): MockRoutes => candidaciesRoutes(seed(name), () => clock.now);
const call = (routes: MockRoutes, key: string, params: Record<string, string> = {}, body?: unknown): MockResponse => {
  const handler = routes[full(key)];
  expect(handler, `the scenario answers no route ${key}`).toBeDefined();
  return (handler as NonNullable<typeof handler>)({ params, body });
};
const list = (routes: MockRoutes): CandidaciesAnswer => call(routes, 'GET /candidacies').body as CandidaciesAnswer;
const approveBody = (c: RelayCandidacy): ApproveRequest => ({
  approval: { v: 2, random: c.random, sealed: 'c2VhbGVk' },
  adminImport: { registration: { body: { uuid: c.uuid }, signature: 'x' }, sealedPairSecret: 'c2VhbGVk', adminUuid: '00000000-0000-4000-8000-000000000001', candidateUuid: c.uuid, random: c.random },
});
const first = (name: string): RelayCandidacy => seed(name).candidacies[0] as RelayCandidacy;

describe('the routes of the Candidacies page', () => {
  it('answers exactly the seven routes the page calls, under the module prefix', () => {
    expect(Object.keys(make('one-pending')).sort()).toEqual(
      [
        'GET /candidacies',
        'GET /admin-key',
        'GET /approve-context/:uuid',
        'POST /candidacies/:id/approve',
        'POST /candidacies/:id/reject',
        'POST /approve-distribute',
        'POST /approval-codes',
      ]
        .map(full)
        .sort(),
    );
  });

  it('GET /candidacies lists the seed with ages that follow the clock of the browser, not the one written in the seed', () => {
    const clock = { now: CLOCK_START };
    const routes = make('one-pending', clock);
    expect(list(routes).candidacies.map((r) => [r.name, r.ageText, r.canApprove])).toEqual([['mac-m2', '4 min', true]]);
    clock.now += 600;
    // 10 minutes later: 14 minutes old, still decidable (15 minutes of life); 10 more and it is expired.
    expect(list(routes).candidacies[0]).toMatchObject({ ageText: '14 min', canDecide: true });
    clock.now += 600;
    expect(list(routes).candidacies[0]).toMatchObject({ canDecide: false, canApprove: false });
  });

  it('GET /admin-key hands the placeholder envelope of the seed', () => {
    const answer = call(make('one-pending'), 'GET /admin-key');
    expect(answer.status).toBe(200);
    expect(JSON.parse((answer.body as { file: string }).file)).toMatchObject({ v: 2, hint: expect.stringContaining('FAKE PLACEHOLDER') });
  });

  it('GET /approve-context/:uuid answers the context of the candidate; a bad uuid is a 400 with the fix', () => {
    const routes = make('one-pending');
    const context = call(routes, 'GET /approve-context/:uuid', { uuid: first('one-pending').uuid as string });
    expect(context.status).toBe(200);
    expect((context.body as ApproveContextAnswer).adminMachine.name).toBe('midgard2');
    const bad = call(routes, 'GET /approve-context/:uuid', { uuid: 'nope' });
    expect(bad.status).toBe(400);
    expect((bad.body as ErrorBody).error).toContain('/approve-context/<uuid>');
  });

  it('Approve changes the next GET: the row is approved, no longer decidable, and the candidate is trusted in the next context', () => {
    const routes = make('one-pending');
    const c = first('one-pending');
    const done = call(routes, 'POST /candidacies/:id/approve', { id: c.id }, approveBody(c));
    expect(done.status).toBe(200);
    expect((done.body as ApproveAnswer).imported).toEqual({ uuid: c.uuid, name: 'mac-m2' });
    expect(list(routes).candidacies[0]).toMatchObject({ relayStatus: 'approved', canDecide: false, canApprove: false, statusText: 'Approved by the admin (relay status: approved)' });
    expect((call(routes, 'GET /approve-context/:uuid', { uuid: c.uuid as string }).body as ApproveContextAnswer).candidate.trusted).toBe(true);
    // A second approve of the same row is refused by the state, as the relay would.
    expect(call(routes, 'POST /candidacies/:id/approve', { id: c.id }, approveBody(c)).status).toBe(409);
  });

  it('Reject removes the row from the next GET, and rejecting it again is a 404', () => {
    const routes = make('several-pending');
    const a = first('several-pending');
    expect(list(routes).count).toBe(2);
    expect(call(routes, 'POST /candidacies/:id/reject', { id: a.id }).status).toBe(200);
    const after = list(routes);
    expect(after.count).toBe(1);
    expect(after.candidacies.map((r) => r.id)).not.toContain(a.id);
    expect(call(routes, 'POST /candidacies/:id/reject', { id: a.id }).status).toBe(404);
  });

  it('POST /approval-codes keeps the code: the next GET lists it and the last step shows it', () => {
    const routes = make('one-pending');
    const c = first('one-pending');
    call(routes, 'POST /candidacies/:id/approve', { id: c.id }, approveBody(c));
    expect(call(routes, 'POST /approval-codes', {}, { uuid: c.uuid, name: 'mac-m2', code: '12345 67890 12345 67890 12345' }).status).toBe(200);
    const after = list(routes);
    expect(after.approvals.map((a) => [a.name, a.code])).toEqual([['mac-m2', '12345 67890 12345 67890 12345']]);
    expect(after.timeline[4]?.description).toContain('12345 67890 12345 67890 12345');
    expect(call(routes, 'POST /approval-codes', {}, { uuid: c.uuid }).status).toBe(400);
  });

  it('POST /approve-distribute answers the delivery the scenario planned, but only after the approval (409 before)', () => {
    const routes = make('approve-result-partial');
    const c = first('approve-result-partial');
    const body = { candidateUuid: c.uuid, documents: [], noticeRecipients: null };
    expect(call(routes, 'POST /approve-distribute', {}, body).status).toBe(409);
    call(routes, 'POST /candidacies/:id/approve', { id: c.id }, approveBody(c));
    const out = call(routes, 'POST /approve-distribute', {}, body);
    expect(out.status).toBe(200);
    expect((out.body as DistributeAnswer).machines.map((m) => m.state)).toEqual(['inbox', 'delivered']);
  });

  it('a relay error seed fails every relay route with the error body of the real backend (503 / 502, the fix in the message)', () => {
    for (const [name, status, kind] of [['relay-error-503', 503, 'relay_not_configured'], ['relay-unreachable-502', 502, 'relay_error']] as const) {
      const routes = make(name);
      const answer = call(routes, 'GET /candidacies');
      expect([answer.status, (answer.body as ErrorBody).kind]).toEqual([status, kind]);
      expect((answer.body as ErrorBody).message).toBe((answer.body as ErrorBody).error);
      expect(call(routes, 'POST /candidacies/:id/reject', { id: 'cand-x-01' }).status).toBe(status);
    }
  });

  it('the writes carry a small delay so the busy state of the page can be seen', () => {
    const routes = make('one-pending');
    const c = first('one-pending');
    expect(call(routes, 'POST /candidacies/:id/approve', { id: c.id }, approveBody(c)).delayMs).toBeGreaterThan(0);
  });

  it('two instances of the same seed do not share their state (Reset starts again)', () => {
    const a = make('one-pending');
    const b = make('one-pending');
    call(a, 'POST /candidacies/:id/reject', { id: first('one-pending').id });
    expect(list(a).count).toBe(0);
    expect(list(b).count).toBe(1);
  });
});
