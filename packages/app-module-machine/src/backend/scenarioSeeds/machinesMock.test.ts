import { describe, expect, it } from 'vitest';
import { readAdminKeyHint } from '../../../../dsl-lib-machine/src/lib/allowFlow.js';
import { describeDelivery } from '../../../../dsl-lib-machine/src/lib/approvalResult.js';
import { loadRevokeContext } from '../../../../dsl-lib-machine/src/lib/revokeFlow.js';
import { machinesRoutes } from '../../commons/machinesMock.js';
import { MACHINES_SEED_NAMES, machinesSeed, type MachinesSeedName } from '../../commons/machinesSeeds.js';
import type { MachineRow, MachinesAnswer, RevokeApplyAnswer, RevokeContextAnswer } from '../../commons/machinesState.js';
import { MODULE_PREFIX, type MockResponse, type MockRoutes } from '../../commons/mockRoutes.js';
import type { ErrorBody } from '../../commons/routeContracts.js';

// The routes of the Machines page on mock data (the dev-only scenarios): the pure state machine of src/commons/machinesState.ts behind four routes. The page's own code
// (loadRevokeContext, readAdminKeyHint, describeDelivery) is run on the answers, so a drift between the mock and the page fails here.

const ADMIN = '00000000-0000-4000-8000-000000000001';
const THINK = '00000000-0000-4000-8000-000000000002';
const MAC = '00000000-0000-4000-8000-000000000003';

// What the page says when this machine is alone on the network.
const NEXT_STEP = 'No other machine yet. Run `machine join` on the new machine, then approve it on the Candidacies page.';
const full = (key: string): string => `${key.split(' ')[0]} ${MODULE_PREFIX}${key.slice(key.indexOf(' ') + 1)}`;
const make = (name: MachinesSeedName): MockRoutes => machinesRoutes(machinesSeed(name));
const call = (routes: MockRoutes, key: string, params: Record<string, string> = {}, body?: unknown): MockResponse => {
  const handler = routes[full(key)];
  expect(handler, `the scenario answers no route ${key}`).toBeDefined();
  return (handler as NonNullable<typeof handler>)({ params, body });
};
const list = (routes: MockRoutes): MachinesAnswer => call(routes, 'GET /machines').body as MachinesAnswer;
const names = (routes: MockRoutes): string[] => list(routes).machines.map((m: MachineRow) => m.name);
const apply = (uuid: string) => ({ uuid, signed: { body: {}, signature: 'x' }, documents: [], noticeRecipients: null });

describe('the seeds of the Machines page', () => {
  it('are exactly the seven scenarios of the page', () => {
    expect([...MACHINES_SEED_NAMES]).toEqual(['only-this-machine', 'two-trusted-peers', 'peer-revoked-earlier', 'revoke-delivered', 'revoke-partial', 'revoke-failed', 'relay-unreachable']);
  });
});

describe('the routes of the Machines page', () => {
  it('answers exactly the five routes the page calls, under the module prefix', () => {
    expect(Object.keys(make('two-trusted-peers')).sort()).toEqual(['GET /machines', 'GET /admin-key', 'GET /revoke-context/:uuid', 'POST /revoke', 'POST /delivery-retry'].map(full).sort());
  });

  it('POST /delivery-retry: after a failed revocation the first retry delivers to the peer that stays and drops the revoked machine from the list, then nothing is retained (409)', () => {
    const routes = make('revoke-failed');
    expect(call(routes, 'POST /delivery-retry', {}, { uuid: MAC }).status).toBe(409);
    call(routes, 'POST /revoke', {}, apply(MAC));
    const out = call(routes, 'POST /delivery-retry', {}, { uuid: MAC });
    expect(out.status).toBe(200);
    const answer = out.body as { ok: boolean; failed: boolean; subject: { uuid: string }; machines: Array<{ name: string; state: string }>; text: { err: string } };
    expect([answer.ok, answer.failed, answer.subject.uuid, answer.text.err]).toEqual([true, false, MAC, '']);
    expect(answer.machines.map((m) => [m.name, m.state])).toEqual([['thinkcentre', 'inbox']]);
    const again = call(routes, 'POST /delivery-retry', {}, { uuid: MAC });
    expect([again.status, (again.body as ErrorBody).kind]).toEqual([409, 'nothing-retained']);
  });

  it('POST /delivery-retry: a revocation that failed nothing leaves nothing to retry, and the body is exactly { uuid }', () => {
    const routes = make('revoke-partial');
    call(routes, 'POST /revoke', {}, apply(MAC));
    expect(call(routes, 'POST /delivery-retry', {}, { uuid: MAC }).status).toBe(409);
    expect(call(routes, 'POST /delivery-retry', {}, { uuid: MAC, extra: 1 }).status).toBe(400);
  });

  it('POST /delivery-retry: a revoked machine that could not be removed from the relay is dropped from the answer once removed (relay-unreachable)', () => {
    const routes = make('relay-unreachable');
    call(routes, 'POST /revoke', {}, apply(MAC));
    const answer = call(routes, 'POST /delivery-retry', {}, { uuid: MAC }).body as { failed: boolean; machines: Array<{ uuid: string; state: string }> };
    expect(answer.failed).toBe(false);
    expect(answer.machines.some((m) => m.uuid === MAC)).toBe(false);
  });

  it('only-this-machine: one row, this machine, no Revoke to offer', () => {
    const out = list(make('only-this-machine'));
    expect(out.machines.map((m) => [m.name, m.self, m.role])).toEqual([['midgard2', true, 'this machine']]);
    expect([out.count, out.enrolled]).toEqual([1, true]);
    // Alone on the network: the page says what to do next, with the command (Markdown), and the help line does not talk about the daemon.
    expect(out.nextStep).toBe(NEXT_STEP);
    expect(out.presenceNote).not.toMatch(/daemon/);
  });

  it('two-trusted-peers: this machine first, then the peers with their reachability, aliases and notice columns', () => {
    const out = list(make('two-trusted-peers'));
    expect(out.machines.map((m) => [m.name, m.self, m.role])).toEqual([['midgard2', true, 'this machine'], ['thinkcentre', false, 'peer'], ['mac-m2', false, 'peer']]);
    expect(out.machines[0]?.reachable).toBe('this machine');
    expect(out.machines[1]?.reachableState).not.toBe(out.machines[2]?.reachableState);
    expect(out.machines.map((m) => m.receivesNotices)).toEqual(['yes', 'yes', 'no']);
    expect(out.noticesText).toBe('Request notices go to midgard2, thinkcentre (list serial 1).');
    expect(out.count).toBe(3);
    expect(out.nextStep).toBeUndefined();
  });

  it('GET /admin-key hands the envelope of the throwaway scenario key, and the page reads its hint from it', async () => {
    const routes = make('two-trusted-peers');
    const answer = call(routes, 'GET /admin-key');
    expect(answer.status).toBe(200);
    expect(await readAdminKeyHint({ get: async () => answer.body } as never)).toContain('scenario key');
  });

  it('GET /revoke-context/:uuid is accepted by the real code of the page, and lists as recipients the peers that stay', async () => {
    const routes = make('two-trusted-peers');
    const body = call(routes, 'GET /revoke-context/:uuid', { uuid: MAC }).body as RevokeContextAnswer;
    expect(body.revoked).toMatchObject({ uuid: MAC, name: 'mac-m2', serial: 1 });
    expect(body.recipients.map((r) => r.body.name)).toEqual(['thinkcentre']);
    const context = await loadRevokeContext({ elevate: async () => undefined, get: async () => body } as never, { uuid: MAC, name: 'mac-m2' });
    expect(context.revoked.name).toBe('mac-m2');
    expect(context.adminMachine.name).toBe('midgard2');
  });

  it('GET /revoke-context refuses with the fix: a bad uuid (400), this machine (409 self), an unknown machine (409 not-trusted)', () => {
    const routes = make('two-trusted-peers');
    const bad = call(routes, 'GET /revoke-context/:uuid', { uuid: 'nope' });
    expect([bad.status, (bad.body as ErrorBody).kind]).toEqual([400, 'bad_request']);
    expect((bad.body as ErrorBody).error).toContain('/revoke-context/<uuid>');
    const self = call(routes, 'GET /revoke-context/:uuid', { uuid: ADMIN });
    expect([self.status, (self.body as ErrorBody).kind]).toEqual([409, 'self']);
    const unknown = call(routes, 'GET /revoke-context/:uuid', { uuid: '00000000-0000-4000-8000-0000000000ff' });
    expect([unknown.status, (unknown.body as ErrorBody).kind]).toEqual([409, 'not-trusted']);
    expect((unknown.body as ErrorBody).error).toContain('not a trusted peer');
  });

  it('peer-revoked-earlier: the revoked machine is not listed, and its context says it is already revoked (serial 3) with the command', () => {
    const routes = make('peer-revoked-earlier');
    expect(names(routes)).toEqual(['midgard2', 'thinkcentre']);
    const refused = call(routes, 'GET /revoke-context/:uuid', { uuid: MAC });
    expect([refused.status, (refused.body as ErrorBody).kind]).toEqual([409, 'not-trusted']);
    expect((refused.body as ErrorBody).error).toContain('already revoked on this machine (serial 3)');
    expect((refused.body as ErrorBody).error).toContain(`machine admin distribute ${MAC}`);
  });

  it('Revoke changes the next GET: the peer is gone from the list, the held list grows, and revoking it again is refused', () => {
    const routes = make('revoke-delivered');
    const before = (call(routes, 'GET /revoke-context/:uuid', { uuid: MAC }).body as RevokeContextAnswer).held;
    expect(call(routes, 'POST /revoke', {}, apply(MAC)).status).toBe(200);
    expect(names(routes)).toEqual(['midgard2', 'thinkcentre']);
    expect(list(routes).count).toBe(2);
    const again = call(routes, 'POST /revoke', {}, apply(MAC));
    expect([again.status, (again.body as ErrorBody).kind]).toEqual([409, 'not-trusted']);
    const next = (call(routes, 'GET /revoke-context/:uuid', { uuid: THINK }).body as RevokeContextAnswer).held;
    expect(next.entries).toEqual([...before.entries, { uuid: MAC, serial: 1 }]);
    expect(next.version).toBeGreaterThan(before.version);
  });

  it('POST /revoke refuses a body that is not exactly the four fields, this machine, and an unknown machine, nothing changing', () => {
    const routes = make('revoke-delivered');
    const extra = call(routes, 'POST /revoke', {}, { ...apply(MAC), passphrase: 'x' });
    expect([extra.status, (extra.body as ErrorBody).kind]).toEqual([400, 'bad_request']);
    expect((extra.body as ErrorBody).error).toContain('expected exactly');
    expect(call(routes, 'POST /revoke', {}, apply(ADMIN)).status).toBe(409);
    expect(call(routes, 'POST /revoke', {}, apply('00000000-0000-4000-8000-0000000000ff')).status).toBe(409);
    expect(names(routes)).toHaveLength(3);
  });

  it('revoke-delivered: the peer that stays took the documents directly', () => {
    const out = call(make('revoke-delivered'), 'POST /revoke', {}, apply(MAC)).body as RevokeApplyAnswer;
    expect([out.failed, out.machines.map((m) => [m.name, m.state])]).toEqual([false, [['thinkcentre', 'delivered']]]);
    expect(out.text.err).toBe('');
    expect(out.text.out).toContain('thinkcentre');
    expect(describeDelivery('delivered', out.machines).tone).toBe('success');
  });

  it('revoke-partial: the peer that stays is offline, its document waits in the relay inbox, nothing failed', () => {
    const out = call(make('revoke-partial'), 'POST /revoke', {}, apply(MAC)).body as RevokeApplyAnswer;
    expect([out.failed, out.machines.map((m) => [m.name, m.state, m.code])]).toEqual([false, [['thinkcentre', 'inbox', 'unreachable']]]);
    expect(describeDelivery('delivered', out.machines).headline).toContain('wait');
  });

  it('revoke-failed: the relay refuses the documents, the revocation stands, the retry command is in the report', () => {
    const out = call(make('revoke-failed'), 'POST /revoke', {}, apply(MAC)).body as RevokeApplyAnswer;
    expect([out.failed, out.machines.map((m) => [m.name, m.state])]).toEqual([true, [['thinkcentre', 'failed']]]);
    expect(out.retry).toBe(`machine admin distribute ${MAC}`);
    expect(out.text.err).toContain(out.retry);
    expect(out.text.err).toContain('the revocation stands');
    expect(names(make('revoke-failed'))).toHaveLength(3);
  });

  it('relay-unreachable: nobody is told AND the revoked machine is not removed from the relay (it is listed as failed too)', () => {
    const routes = make('relay-unreachable');
    const out = call(routes, 'POST /revoke', {}, apply(MAC)).body as RevokeApplyAnswer;
    expect(out.failed).toBe(true);
    expect(out.machines.map((m) => [m.name, m.state])).toEqual([['thinkcentre', 'failed'], ['mac-m2', 'failed']]);
    expect(out.machines.find((m) => m.uuid === MAC)?.reason).toBe('not removed from the relay');
    expect(out.text.err).toContain('relay is unreachable');
    expect(names(routes)).toEqual(['midgard2', 'thinkcentre']);
  });

  it('the revocation of the last peer has nobody to tell: no machine, nothing failed', () => {
    const routes = make('peer-revoked-earlier');
    const out = call(routes, 'POST /revoke', {}, apply(THINK)).body as RevokeApplyAnswer;
    expect([out.failed, out.machines]).toEqual([false, []]);
    expect(out.text.out).toContain('no other peer to inform');
  });

  it('the writes carry a delay, and two instances of a seed do not share their state', () => {
    const a = make('revoke-delivered');
    const b = make('revoke-delivered');
    expect(call(a, 'POST /revoke', {}, apply(MAC)).delayMs).toBeGreaterThan(0);
    expect(names(a)).toHaveLength(2);
    expect(names(b)).toHaveLength(3);
  });
});
