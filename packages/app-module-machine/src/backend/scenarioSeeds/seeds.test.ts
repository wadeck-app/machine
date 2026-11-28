import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decryptAdminKey, verifyRegistration, type AdminKeyEnvelope } from '@wadeck-app/machine-core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { checkApprovable, loadApproveContext } from '../../../../dsl-lib-machine/src/lib/approveFlow.js';
import { describeDelivery } from '../../../../dsl-lib-machine/src/lib/approvalResult.js';
import {
  adminKey,
  approveCandidacy,
  approveContext,
  keepApprovalCode,
  listCandidacies,
  rejectCandidacy,
  type CandidaciesState,
  type RelayCandidacy,
} from '../../commons/candidaciesState.js';
import type { ApproveContextAnswer, ApproveRequest, CandidaciesAnswer, DistributeAnswer } from '../../commons/routeContracts.js';
import { expectNoRealData } from './privacyScan.testUtil.js';
import { ALLOWED_PUBLIC_KEYS, ALLOWED_RANDOMS, ALLOWED_SCENARIO_KEY_STRINGS, buildSeeds, KEYS, FAKE_DAEMON_IMPORT, NOW, rawOf, startReal, type Real, type RealOptions } from './seedBuilders.testUtil.js';

// The seeds of the Candidacies mock (src/commons/scenarioSeeds/<name>.json): plain JSON, the initial state of the mock. They are built by seedBuilders.testUtil.ts
// from fake material and the REAL functions of the CLI, and every answer the pure state machine (src/commons) derives from them is compared here with what the REAL
// backend routes answer, so a seed or the state machine cannot drift from reality. `WRITE_SEEDS=1 npm test ...` rewrites the files from the builders.

const SEEDS_DIR = fileURLToPath(new URL('../../commons/scenarioSeeds/', import.meta.url));
const WRITE = process.env['WRITE_SEEDS'] === '1';
const NAMES = [
  'empty',
  'one-pending',
  'several-pending',
  'pending-revoked-earlier',
  'pending-with-problems',
  'relay-error-503',
  'relay-unreachable-502',
  'approve-result-delivered',
  'approve-result-partial',
  'approve-result-failed',
  'approval-codes-recallable',
  'candidate-expired',
] as const;

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function seedText(name: string): string {
  try {
    return readFileSync(`${SEEDS_DIR}${name}.json`, 'utf8');
  } catch (e) {
    throw new Error(`seed ${name}.json cannot be read (${(e as Error).message}): run \`WRITE_SEEDS=1 npm test --workspace=packages/app-module-machine -- seeds\` to write the seeds from the builders`);
  }
}

const readSeed = (name: string): CandidaciesState => JSON.parse(seedText(name)) as CandidaciesState;

let built: Record<string, CandidaciesState>;
beforeAll(async () => {
  built = await buildSeeds();
  if (WRITE) {
    mkdirSync(SEEDS_DIR, { recursive: true });
    for (const [name, state] of Object.entries(built)) writeFileSync(`${SEEDS_DIR}${name}.json`, `${JSON.stringify(state, null, 2)}\n`);
  }
});

let real: Real | undefined;
afterEach(async () => {
  await real?.close();
  real = undefined;
});

const relayOf = (state: CandidaciesState, name: string, decisionStatus?: number): RealOptions['relay'] =>
  name === 'relay-error-503' ? { kind: 'none' } : name === 'relay-unreachable-502' ? { kind: 'unreachable' } : { kind: 'list', candidacies: state.candidacies.map(rawOf), ...(decisionStatus === undefined ? {} : { decisionStatus }) };

const approveBody = (c: RelayCandidacy, state: CandidaciesState): ApproveRequest => ({
  approval: { v: 2, random: c.random, sealed: 'c2VhbGVk' },
  adminImport: { registration: { body: { uuid: c.uuid }, signature: 'x' }, sealedPairSecret: 'c2VhbGVk', adminUuid: state.admin.uuid, candidateUuid: c.uuid, random: c.random },
});

describe('the seed files', () => {
  it.each(NAMES)('%s.json exists and is what the builder produces (a seed edited by hand, or a stale one, fails here)', (name) => {
    expect(readSeed(name)).toEqual(json(built[name]));
  });

  it('there is exactly one seed per name of the list, and the list is complete', () => {
    expect(Object.keys(built).sort()).toEqual([...NAMES].sort());
  });
});

describe('the list answered by the state machine is what the REAL GET /candidacies answers', () => {
  it.each(NAMES)('%s', async (name) => {
    const state = readSeed(name);
    real = await startReal({ now: NOW, relay: relayOf(state, name), approvals: state.approvals });
    const really = await real.call('GET /candidacies', {});
    const mocked = listCandidacies(state).answer;
    expect(json(mocked)).toEqual(json(really));
  });
});

describe('what each seed shows (the intent of the scenario, on the real answer)', () => {
  const rowsOf = (state: CandidaciesState): CandidaciesAnswer => listCandidacies(state).answer.body as CandidaciesAnswer;

  it('empty: no row, nothing to follow', () => {
    expect(rowsOf(readSeed('empty')).count).toBe(0);
  });
  it('one-pending: one row that can be approved', () => {
    expect(rowsOf(readSeed('one-pending')).candidacies.map((r) => [r.name, r.canApprove])).toEqual([['mac-m2', true]]);
  });
  it('several-pending: two rows, the timeline follows the oldest', () => {
    const out = rowsOf(readSeed('several-pending'));
    expect(out.count).toBe(2);
    expect(out.timelineNote).toBe('The timeline follows "mac-m2" (12 min), the oldest pending of 2 candidacies: pending.');
    expect(out.candidacies.find((r) => r.name === 'thinkcentre')?.rebind).toBe(true);
  });
  it('pending-revoked-earlier: the context says REVOKED earlier, the page then prints no code', () => {
    const state = readSeed('pending-revoked-earlier');
    expect((approveContext(state, state.candidacies[0]?.uuid as string).answer.body as ApproveContextAnswer).candidate.revokedSerial).toBe(3);
  });
  it('pending-with-problems: cannot be approved, can be rejected, the text names the missing uuid', () => {
    const row = rowsOf(readSeed('pending-with-problems')).candidacies[0];
    expect(row).toMatchObject({ canApprove: false, canDecide: true });
    expect(row?.statusText).toContain('carries no uuid');
  });
  it('relay-error-503 and relay-unreachable-502: the list is an error body with the fix', () => {
    const a = listCandidacies(readSeed('relay-error-503')).answer;
    const b = listCandidacies(readSeed('relay-unreachable-502')).answer;
    expect([a.status, (a.body as { kind: string }).kind]).toEqual([503, 'relay_not_configured']);
    expect((a.body as { error: string }).error).toContain('machine admin login');
    expect([b.status, (b.body as { kind: string }).kind]).toEqual([502, 'relay_error']);
    expect((b.body as { error: string }).error).toContain('relay is unreachable');
  });
  it('approval-codes-recallable: the approved machine shows its code on the last step, a second reminder is listed', () => {
    const out = rowsOf(readSeed('approval-codes-recallable'));
    expect(out.approvals.map((a) => a.name)).toEqual(['mac-m2', 'thinkcentre']);
    expect(out.timeline[4]?.description).toContain(out.approvals[0]?.code);
    expect(out.candidacies[0]?.statusText).toBe('Approved by the admin (relay status: approved)');
  });
  it('candidate-expired: cannot be decided, the problem says it expired', () => {
    const row = rowsOf(readSeed('candidate-expired')).candidacies[0];
    expect(row).toMatchObject({ canDecide: false, canApprove: false });
    expect(row?.problems.join(' ')).toContain('expired');
  });
});

describe('the approval context, checked by the REAL code of the page', () => {
  const approvable = NAMES.filter((n) => !['empty', 'relay-error-503', 'relay-unreachable-502', 'approval-codes-recallable', 'pending-with-problems', 'candidate-expired'].includes(n));

  it.each(approvable)('%s: loadApproveContext accepts it, its registrations carry a valid admin signature, checkApprovable passes on the row', async (name) => {
    const state = readSeed(name);
    const row = (listCandidacies(state).answer.body as CandidaciesAnswer).candidacies.find((r) => r.canApprove);
    expect(row).toBeDefined();
    const body = approveContext(state, row?.uuid as string).answer.body as ApproveContextAnswer;
    // The real route hands the daemon answer through unchanged.
    real = await startReal({ now: NOW, relay: relayOf(state, name), daemon: { approveContext: body } });
    expect(json((await real.call('GET /approve-context/:uuid', { params: { uuid: row?.uuid as string } })).body)).toEqual(json(body));
    // The real guard of the page.
    const context = await loadApproveContext({ elevate: async () => undefined, get: async () => body } as never, row as never);
    for (const registration of context.others) {
      expect(verifyRegistration(registration, { adminPublicKey: body.adminPublicKey, now: NOW }).ok).toBe(true);
    }
    // The real checks of the page: the code recomputed there from the key and random must equal the one of the row.
    const checked = await checkApprovable(row as never, context);
    expect(checked.finalCode).toMatch(/^\d{5}( \d{5}){4}$/);
    expect(checked.peersToInform.map((p) => p.name)).toEqual(state.trusted.map((t) => t.body.name));
    expect(checked.noCode).toBe(name === 'pending-revoked-earlier');
    expect(checked.warnings.some((w) => w.includes('REVOKED'))).toBe(name === 'pending-revoked-earlier');
    expect(checked.warnings.some((w) => w.includes('already bound'))).toBe(name === 'several-pending');
  });

  it('a candidacy with problems is refused by the real checks of the page, with the problem named', async () => {
    const state = readSeed('pending-with-problems');
    const row = (listCandidacies(state).answer.body as CandidaciesAnswer).candidacies[0];
    const context = approveContext(state, '00000000-0000-4000-8000-000000000002').answer.body;
    await expect(checkApprovable(row as never, context as never)).rejects.toThrow(/carries no uuid/);
  });
});

describe('the delivery answers, checked by the REAL code of the page', () => {
  const plans: Array<[string, 'delivered' | 'partial' | 'failed', string, string]> = [
    ['approve-result-delivered', 'delivered', 'success', 'Documents delivered to 2 machines.'],
    ['approve-result-partial', 'partial', 'success', 'Documents delivered to 1 machine, 1 waits in the relay inbox.'],
    ['approve-result-failed', 'failed', 'danger', 'Documents NOT delivered to 2 machines. Run `machine admin distribute 00000000-0000-4000-8000-000000000003`.'],
  ];

  it.each(plans)('%s: the route hands it through, and the page summary is the one of the scenario', async (name, plan, tone, headline) => {
    const state = readSeed(name);
    const uuid = state.candidacies[0]?.uuid as string;
    const answer = state.distributions[uuid] as DistributeAnswer;
    real = await startReal({ now: NOW, relay: relayOf(state, name), daemon: { approveDistribute: answer } });
    const body = { candidateUuid: uuid, documents: [], noticeRecipients: null };
    expect(json((await real.call('POST /approve-distribute', { body })).body)).toEqual(json(answer));
    const summary = describeDelivery(answer.failed ? 'partial' : 'delivered', answer.machines, answer.retry);
    expect([summary.tone, summary.headline]).toEqual([tone, headline]);
    expect(answer.machines.map((m) => m.state)).toEqual(plan === 'delivered' ? ['delivered', 'delivered'] : plan === 'partial' ? ['inbox', 'delivered'] : ['failed', 'failed']);
    expect(answer.failed).toBe(plan === 'failed');
    expect(answer.text.err).toBe(plan === 'failed' ? answer.text.err : '');
    expect(answer.text.err === '' ? answer.text.out : answer.text.err).toContain(plan === 'failed' ? answer.retry : '[ok]');
  });
});

describe('the transitions of the state machine answer what the REAL routes answer', () => {
  const first = (state: CandidaciesState): RelayCandidacy => state.candidacies[0] as RelayCandidacy;

  it.each(['one-pending', 'approve-result-partial', 'pending-revoked-earlier'])('%s: approve answers the same, and the list after it is the real list of an approved candidacy', async (name) => {
    const state = readSeed(name);
    const c = first(state);
    real = await startReal({ now: NOW, relay: relayOf(state, name), daemon: FAKE_DAEMON_IMPORT(c.uuid as string, c.name) });
    const really = await real.call('POST /candidacies/:id/approve', { params: { id: c.id }, body: approveBody(c, state) });
    const step = approveCandidacy(state, c.id, approveBody(c, state));
    expect(json(step.answer)).toEqual(json(really));
    await real.close();
    // The relay now lists it approved.
    real = await startReal({ now: NOW, relay: relayOf(step.state, name), approvals: step.state.approvals });
    expect(json(listCandidacies(step.state).answer)).toEqual(json(await real.call('GET /candidacies', {})));
  });

  it('the code kept after the approval: the answer and the list after it are the real ones', async () => {
    const state = approveCandidacy(readSeed('one-pending'), first(readSeed('one-pending')).id, approveBody(first(readSeed('one-pending')), readSeed('one-pending'))).state;
    const body = { uuid: first(state).uuid as string, name: 'mac-m2', code: '12345 67890 12345 67890 12345' };
    real = await startReal({ now: NOW, relay: relayOf(state, 'one-pending') });
    const really = await real.call('POST /approval-codes', { body });
    const step = keepApprovalCode(state, body);
    expect(json(step.answer)).toEqual(json(really));
    expect(json(listCandidacies(step.state).answer)).toEqual(json(await real.call('GET /candidacies', {})));
    for (const bad of [{ ...body, code: '123' }, { ...body, uuid: 'x' }, { ...body, extra: 1 }, { uuid: body.uuid }, undefined]) {
      expect(json(keepApprovalCode(state, bad as never).answer)).toEqual(json(await real.call('POST /approval-codes', { body: bad })));
    }
  });

  it('refusals of approve: unknown id, no longer pending, another random, a candidacy with problems or expired', async () => {
    const state = readSeed('one-pending');
    const c = first(state);
    const body = approveBody(c, state);
    const cases: Array<[string, CandidaciesState, string, ApproveRequest, RealOptions['relay']]> = [
      ['unknown id', state, 'cand-nobody', body, relayOf(state, 'one-pending')],
      ['no longer pending', state, c.id, body, { kind: 'list', candidacies: [rawOf({ ...c, status: 'approved' })] }],
      ['another random', state, c.id, { ...body, approval: { ...body.approval, random: 'b3RoZXI' } }, relayOf(state, 'one-pending')],
      ['problems', readSeed('pending-with-problems'), first(readSeed('pending-with-problems')).id, approveBody(first(readSeed('pending-with-problems')), readSeed('pending-with-problems')), relayOf(readSeed('pending-with-problems'), 'x')],
      ['expired', readSeed('candidate-expired'), first(readSeed('candidate-expired')).id, approveBody(first(readSeed('candidate-expired')), readSeed('candidate-expired')), relayOf(readSeed('candidate-expired'), 'x')],
    ];
    for (const [label, seed, id, requestBody, relay] of cases) {
      const staleSeed = label === 'no longer pending' ? { ...seed, candidacies: [{ ...c, status: 'approved' as const }] } : seed;
      real = await startReal({ now: NOW, relay, daemon: FAKE_DAEMON_IMPORT(c.uuid as string, c.name) });
      const really = await real.call('POST /candidacies/:id/approve', { params: { id }, body: requestBody });
      expect({ label, answer: json(approveCandidacy(staleSeed, id, requestBody).answer) }).toEqual({ label, answer: json(really) });
      await real.close();
      real = undefined;
    }
  });

  it('reject: the answer is the real one, the row is gone; the refusals (unknown id, not pending) are the real ones', async () => {
    const state = readSeed('several-pending');
    const c = first(state);
    real = await startReal({ now: NOW, relay: relayOf(state, 'several-pending') });
    expect(json(rejectCandidacy(state, c.id).answer)).toEqual(json(await real.call('POST /candidacies/:id/reject', { params: { id: c.id } })));
    expect((listCandidacies(rejectCandidacy(state, c.id).state).answer.body as CandidaciesAnswer).count).toBe(1);
    await real.close();
    real = await startReal({ now: NOW, relay: relayOf(state, 'several-pending', 404) });
    expect(json(rejectCandidacy(state, 'cand-nobody').answer)).toEqual(json(await real.call('POST /candidacies/:id/reject', { params: { id: 'cand-nobody' } })));
    await real.close();
    real = await startReal({ now: NOW, relay: relayOf(state, 'several-pending', 409) });
    const approved = approveCandidacy(state, c.id, approveBody(c, state)).state;
    expect(json(rejectCandidacy(approved, c.id).answer)).toEqual(json(await real.call('POST /candidacies/:id/reject', { params: { id: c.id } })));
  });

  it('a relay error: approve and reject answer what the real routes answer when the relay is not configured', async () => {
    const state = readSeed('relay-error-503');
    real = await startReal({ now: NOW, relay: { kind: 'none' }, daemon: {} });
    expect(json(rejectCandidacy(state, 'cand-x-01').answer)).toEqual(json(await real.call('POST /candidacies/:id/reject', { params: { id: 'cand-x-01' } })));
    const c = first(readSeed('one-pending'));
    expect(json(approveCandidacy(state, c.id, approveBody(c, state)).answer)).toEqual(json(await real.call('POST /candidacies/:id/approve', { params: { id: c.id }, body: approveBody(c, state) })));
  });

  it('the admin key: the real route hands the file through, the file is the envelope of the throwaway scenario key (a wrong passphrase opens nothing)', async () => {
    const state = readSeed('one-pending');
    real = await startReal({ now: NOW, relay: relayOf(state, 'one-pending'), daemon: { adminKeyFile: { ok: true, file: state.adminKeyFile } } });
    expect(json((await real.call('GET /admin-key', {})).body)).toEqual(json((adminKey(state).answer.body)));
    const envelope = JSON.parse(state.adminKeyFile) as AdminKeyEnvelope;
    expect(envelope.hint).toContain('scenario key');
    expect(decryptAdminKey(envelope, 'scenario-passphrase-2026').publicKey).toBe(KEYS.admin.publicKey);
    expect(() => decryptAdminKey(envelope, 'any passphrase of at least twelve characters')).toThrow();
  });
});

describe('the seeds hold nothing of a real network', () => {
  it.each(NAMES)('%s: only made-up uuids, documentation addresses, fake keys, no real name', (name) => {
    expectNoRealData(seedText(name));
  });

  it.each(NAMES)('%s: every key-like string (40 characters of base64url or more) is one of the fake keys, a signature of the fake admin key, or the ciphertext of the throwaway scenario key (ALLOWED_SCENARIO_KEY_STRINGS, the only allow-listed secret-looking string)', (name) => {
    const text = seedText(name);
    const state = JSON.parse(text) as CandidaciesState;
    const allowed = new Set<string>([...ALLOWED_PUBLIC_KEYS, ...ALLOWED_RANDOMS, ...state.trusted.map((t) => t.signature), ...ALLOWED_SCENARIO_KEY_STRINGS]);
    for (const token of text.match(/[A-Za-z0-9_-]{40,}/g) ?? []) expect(allowed.has(token), `unexpected key-like string ${token.slice(0, 12)}...`).toBe(true);
  });

  it.each(NAMES)('%s: the 16-byte randoms and the keys are the repeated-byte fakes (obviously not random)', (name) => {
    const text = seedText(name);
    for (const token of text.match(/"(?:random|identityPublicKey|publicKey)": "([A-Za-z0-9_-]+)"/g) ?? []) {
      const value = /"([A-Za-z0-9_-]+)"$/.exec(token)?.[1] as string;
      expect([...ALLOWED_PUBLIC_KEYS, ...ALLOWED_RANDOMS]).toContain(value);
    }
  });
});
