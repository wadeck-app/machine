import type {
  AdminKeyAnswer,
  ApprovalCodeRequest,
  ApproveAnswer,
  ApproveContextAnswer,
  ApproveRequest,
  CandidaciesAnswer,
  CandidacyRow,
  DistributeAnswer,
  DistributeRequest,
  ErrorBody,
  OkAnswer,
  RejectAnswer,
  RouteAnswer,
  SignedRegistrationWire,
  TimelineStepRow,
} from './routeContracts.js';

// The pure state machine of the Candidacies page: what the relay and the daemon of the admin machine hold, and what every route of the page answers from it. No
// React, no Node API, no import of another package (the mock of the page runs it in the browser). Every function takes the state and returns a NEW state with the
// answer: nothing is mutated. The derived texts (age, binding, status, timeline) are re-implemented from the backend (`index.ts` candidacyRow,
// `candidacyTimeline.ts`, `candidacies.ts`); src/scenarios-draft/seeds.test.ts compares them with the REAL routes, so a change of the backend that is not followed here
// fails there. What the backend never produces and this machine invents is marked `MOCK` below.

/** What the relay lists of one candidacy, plus the code the backend recomputes from its key and random (no crypto here: the seed holds it, a test recomputes it). */
export interface RelayCandidacy {
  id: string;
  name: string;
  hostname: string;
  observedIp: string;
  uuid?: string;
  /** Epoch seconds. */
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'approved' | 'rejected';
  uuidBound?: boolean;
  boundTokenLabel?: string;
  boundToCandidateToken?: boolean;
  identityPublicKey: string;
  random: string;
  /** `candidacyCode(identityPublicKey, random)`. */
  code: string;
  /** The problems of the review that do not depend on the clock (the expiry is derived). */
  problems: string[];
}

/** The security code of an approval made from the page (backend `approvalCodes.ts`). */
export interface KeptApproval {
  uuid: string;
  name: string;
  code: string;
  /** Epoch seconds. */
  at: number;
}

export interface CandidaciesState {
  /** Epoch seconds of the clock of the mock. */
  now: number;
  /** When set, every route that needs the relay answers this error (no admin token, relay unreachable). */
  relayError: ErrorBody | null;
  /** The text of the encrypted admin key file served by `GET /admin-key`. */
  adminKeyFile: string;
  /** The admin machine (the one that runs the page): its identity and the pinned admin key. */
  admin: { uuid: string; name: string; identityPublicKey: string; publicKey: string; keyId: string };
  /** The registrations of the other trusted machines (the admin machine is not in the list). */
  trusted: SignedRegistrationWire[];
  /** The serial of the last revocation of a machine, by uuid. */
  revoked: Record<string, number>;
  candidacies: RelayCandidacy[];
  approvals: KeptApproval[];
  approvalsProblem: string;
  /** The five steps of the timeline with their texts (the statuses are derived). */
  timelineSteps: Array<{ id: string; title: string; info: string }>;
  /** The answer of `POST /approve-distribute`, by uuid of the approved machine: what the scenario plans for the delivery. */
  distributions: Record<string, DistributeAnswer>;
}

export interface Step<T> {
  state: CandidaciesState;
  answer: RouteAnswer<T>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANDIDACY_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CODE = /^\d{5}( \d{5}){4}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const RETENTION_SECONDS = 7 * 24 * 3600;
const KEPT = 20;
const VALID_YEARS_SECONDS = 10 * 365 * 24 * 3600;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const fail = (status: number, kind: string, error: string): RouteAnswer<never> => ({ status, body: { status, kind, error, message: error } });
const ok = <T>(body: T): RouteAnswer<T> => ({ status: 200, body });

/** "now", "45 s", "10 min", "3 h", "3 days" (backend `candidacies.ts` ageText). */
export function ageText(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return 'unknown';
  const abs = Math.max(0, Math.round(seconds));
  if (abs < 5) return 'now';
  if (abs < 120) return `${abs} s`;
  if (abs < 120 * 60) return `${Math.round(abs / 60)} min`;
  if (abs < 48 * 3600) return `${Math.round(abs / 3600)} h`;
  return `${Math.round(abs / 86_400)} days`;
}

const isPending = (c: { relayStatus: string | undefined }): boolean => c.relayStatus === undefined || c.relayStatus === 'pending';
const isExpired = (c: { expiresAt: number | undefined }, now: number): boolean => c.expiresAt !== undefined && now >= c.expiresAt;

/** The row of the list: the review of the relay entry plus the texts and flags of the page (backend `candidacyRow`). */
function rowOf(c: RelayCandidacy, now: number): CandidacyRow {
  const problems = [...c.problems, ...(now >= c.expiresAt ? ['this candidacy is expired: the candidate must post a new one (`machine join --resume`)'] : [])];
  const rebind = c.uuidBound === true && c.boundToCandidateToken !== true;
  const bindingNote = rebind && c.boundToCandidateToken === undefined ? 'the relay did not say whether the binding is for the token of this candidacy: read as a rebind' : undefined;
  const ageSeconds = Math.max(0, now - c.createdAt);
  let binding: string;
  if (rebind) {
    const which = c.boundTokenLabel !== undefined ? `the token labelled "${c.boundTokenLabel}"` : 'another token (the relay did not say which)';
    binding = `The uuid is already bound to ${which}; approving replaces that binding.${bindingNote !== undefined ? ` Note: ${bindingNote}.` : ''}`;
  } else if (c.uuidBound === true) {
    binding = 'The uuid is already bound to the same token as this candidacy: a re-approval, nothing is rebound.';
  } else if (c.uuidBound === false) {
    binding = 'The uuid is not bound yet: approving creates the binding.';
  } else {
    binding = 'The relay did not say whether the uuid is already bound.';
  }
  const expires = c.expiresAt <= now ? 'expired' : `in ${ageText(c.expiresAt - now)}`;
  const bindingText = [
    `- name: ${c.name}`,
    `- hostname: ${c.hostname === '' ? 'unknown' : c.hostname}`,
    `- uuid: ${c.uuid ?? 'unknown'}`,
    `- seen from: ${c.observedIp === '' ? 'unknown' : c.observedIp}`,
    `- age: ${ageText(ageSeconds)}`,
    `- ${expires === 'expired' ? 'expired' : `expires ${expires}`}`,
    '',
    binding,
    '',
    'Approve signs here, in your browser, with the admin passphrase asked at every approval (it is never kept or sent), then tells the other machines. Reject refuses the candidate here (no passphrase needed). The terminal alternative is `machine admin approve`.',
  ].join('\n');
  const canDecide = CANDIDACY_ID.test(c.id) && c.status === 'pending' && c.expiresAt > now;
  const canApprove = canDecide && problems.length === 0 && c.uuid !== undefined;
  const statusText =
    problems.length > 0
      ? `Cannot be approved: ${problems.join('; ')}`
      : c.status === 'approved'
        ? 'Approved by the admin (relay status: approved)'
        : c.status !== 'pending'
          ? `Relay status: ${c.status}`
          : rebind
            ? 'Warning: uuid already bound to a token'
            : 'Pending';
  return {
    id: c.id,
    name: c.name,
    hostname: c.hostname,
    observedIp: c.observedIp,
    uuid: c.uuid,
    createdAt: c.createdAt,
    expiresAt: c.expiresAt,
    relayStatus: c.status,
    ageSeconds,
    uuidBound: c.uuidBound,
    boundTokenLabel: c.boundTokenLabel,
    boundToCandidateToken: c.boundToCandidateToken,
    rebind,
    bindingNote,
    code: c.code,
    identityPublicKey: c.identityPublicKey,
    random: c.random,
    problems,
    ageText: ageText(ageSeconds),
    bindingText,
    statusText,
    canDecide,
    canApprove,
  };
}

const fresh = (list: KeptApproval[], now: number): KeptApproval[] =>
  list
    .filter((e) => now - e.at < RETENTION_SECONDS)
    .sort((a, b) => b.at - a.at)
    .slice(0, KEPT);

/** The timeline of the page from the rows (backend `candidacyTimeline.ts`): a step is done only when the relay data proves it. */
function timelineOf(rows: CandidacyRow[], now: number, kept: KeptApproval[], steps: CandidaciesState['timelineSteps']): { steps: TimelineStepRow[]; note: string } {
  const live = rows.filter((v) => isPending(v) && !isExpired(v, now));
  const followed = [...(live.length > 0 ? live : rows)].sort((a, b) => (a.createdAt ?? Infinity) - (b.createdAt ?? Infinity) || 0)[0];
  if (followed === undefined) return { steps: steps.map((s) => ({ ...s, status: 'todo' as const })), note: '' };
  let done: string[];
  let current: string | undefined;
  let verdict: string;
  if (followed.relayStatus === 'approved') {
    done = ['received', 'checked', 'signed'];
    verdict = 'approved by the admin';
  } else if (followed.relayStatus === 'rejected') {
    done = ['received'];
    verdict = 'rejected';
  } else if (!isPending(followed)) {
    done = ['received'];
    verdict = `in a relay status this page does not know ("${followed.relayStatus}")`;
  } else if (isExpired(followed, now)) {
    done = ['received'];
    verdict = 'expired: the candidate must post a new one';
  } else {
    done = ['received'];
    current = 'checked';
    verdict = 'pending';
  }
  const code = followed.relayStatus === 'approved' && followed.uuid !== undefined ? kept.find((k) => k.uuid === followed.uuid) : undefined;
  const out = steps.map((s): TimelineStepRow => {
    const status = done.includes(s.id) ? ('done' as const) : s.id === current ? ('current' as const) : ('todo' as const);
    return s.id === 'final-code' && code !== undefined ? { ...s, status, description: `Security code of "${code.name}": ${code.code}. It must read exactly the same on ${code.name}.` } : { ...s, status };
  });
  const many = rows.length > 1 ? `, ${live.length > 0 ? 'the oldest pending of' : 'the oldest of'} ${rows.length} candidacies` : '';
  return { steps: out, note: `The timeline follows "${followed.name}" (${ageText(followed.ageSeconds)})${many}: ${verdict}.` };
}

/** `GET /candidacies`. */
export function listCandidacies(state: CandidaciesState): Step<CandidaciesAnswer> {
  if (state.relayError !== null) return { state, answer: { status: state.relayError.status, body: { ...state.relayError } } };
  const rows = state.candidacies.map((c) => rowOf(c, state.now));
  const kept = fresh(state.approvals, state.now);
  const { steps, note } = timelineOf(rows, state.now, kept, state.timelineSteps);
  return {
    state,
    answer: ok({
      candidacies: rows,
      count: rows.length,
      timeline: steps,
      timelineNote: note,
      approvals: kept.map((k) => ({ uuid: k.uuid, name: k.name, code: k.code, ageText: ageText(state.now - k.at) })),
      approvalsProblem: state.approvalsProblem,
    }),
  };
}

/** `GET /admin-key`. */
export function adminKey(state: CandidaciesState): Step<AdminKeyAnswer> {
  return { state, answer: ok({ file: state.adminKeyFile }) };
}

/** `GET /approve-context/:uuid`. */
export function approveContext(state: CandidaciesState, uuid: string): Step<ApproveContextAnswer> {
  if (!UUID.test(uuid)) return { state, answer: fail(400, 'bad_request', 'expected the uuid of the candidacy in the path: /approve-context/<uuid>') };
  const known = state.trusted.find((r) => r.body.uuid === uuid);
  const revokedSerial = state.revoked[uuid];
  return {
    state,
    answer: ok({
      ok: true,
      adminMachine: { uuid: state.admin.uuid, name: state.admin.name, identityPublicKey: state.admin.identityPublicKey },
      adminPublicKey: state.admin.publicKey,
      adminKeyId: state.admin.keyId,
      candidate: { trusted: known !== undefined, ...(known === undefined ? {} : { name: known.body.name, identityPublicKey: known.body.identityPublicKey }), ...(revokedSerial === undefined ? {} : { revokedSerial }) },
      others: state.trusted.filter((r) => r.body.uuid !== uuid),
      noticeRecipients: null,
    }),
  };
}

const BODY_RULE = 'expected exactly {"approval": {"v": 2, "random": "...", "sealed": "..."}, "adminImport": <import for the admin machine, or null for the first machine approving itself>}, nothing else: reload the page and approve again';

/** The sentence that says why `body` is not an approval request (backend `candidacyApprove.ts` parseBody), or undefined. */
function approveBodyProblem(body: unknown): string | undefined {
  if (!isObject(body) || Object.keys(body).some((k) => k !== 'approval' && k !== 'adminImport')) return BODY_RULE;
  if (!isObject(body['approval'])) return `"approval" is missing or not an object: ${BODY_RULE}`;
  if (!('adminImport' in body)) return `"adminImport" is missing (null when there is nothing to import): ${BODY_RULE}`;
  const approval = body['approval'];
  if (Object.keys(approval).some((k) => k !== 'v' && k !== 'random' && k !== 'sealed')) return `"approval" has a field other than v, random and sealed: ${BODY_RULE}`;
  if (approval['v'] !== 2) return `the approval has envelope version ${String(approval['v'])}, only version 2 (sealed) is accepted: update the page and approve again`;
  if (typeof approval['random'] !== 'string' || approval['random'].length === 0 || typeof approval['sealed'] !== 'string' || approval['sealed'].length === 0) return `"approval" needs a text "random" and a text "sealed": ${BODY_RULE}`;
  const adminImport = body['adminImport'];
  if (adminImport !== null && !isObject(adminImport)) return `"adminImport" must be an object or null: ${BODY_RULE}`;
  return undefined;
}

const NOT_PENDING_AFTER = 'Reload the page to see its current state';
const unknownToApprove = 'the relay does not list this candidacy any more (it expired 15 minutes after it was posted, was decided, or the relay restarted): nothing was approved. The candidate can run `machine join --resume` to post a new one';

/** `POST /candidacies/:id/approve`: pending -> approved, the candidate is trusted here, a revocation of it is forgotten. */
export function approveCandidacy(state: CandidaciesState, id: string, body: ApproveRequest): Step<ApproveAnswer> {
  const refuse = (status: number, kind: string, error: string): Step<ApproveAnswer> => ({ state, answer: fail(status, kind, error) });
  if (!CANDIDACY_ID.test(id)) return refuse(400, 'bad_request', 'the candidacy id must be 1 to 128 letters, digits, "-" or "_" (it is the id the relay listed): reload the page and approve the candidacy of the row again');
  const problem = approveBodyProblem(body);
  if (problem !== undefined) return refuse(400, 'bad_request', problem);
  if (state.relayError !== null) return { state, answer: { status: state.relayError.status, body: { ...state.relayError } } };
  const index = state.candidacies.findIndex((c) => c.id === id);
  const c = state.candidacies[index];
  if (c === undefined) return refuse(404, 'not_found', unknownToApprove);
  if (c.status !== 'pending') return refuse(409, 'not_pending', `the relay says this candidacy is no longer pending (its status is "${c.status}"): nothing was approved. ${NOT_PENDING_AFTER}`);
  const problems = rowOf(c, state.now).problems;
  if (problems.length > 0) return refuse(409, 'not_pending', `this candidacy cannot be approved: ${problems.join('; ')}. Nothing was approved; reject it, or ask the candidate to run \`machine join --resume\``);
  if (body.approval.random !== c.random) return refuse(409, 'random_mismatch', 'the approval answers another candidacy than the one the relay lists now (its random differs): nothing was imported or approved. Reload the page and approve again');
  if (body.adminImport === null) {
    if (c.uuid !== state.admin.uuid) return refuse(409, 'import_required', 'this approval carries no import for the admin machine, and the candidate is not the admin machine itself: without the import this machine would not trust it. Nothing was approved; reload the page and approve again');
  } else if (body.adminImport['candidateUuid'] !== c.uuid || body.adminImport['random'] !== c.random) {
    return refuse(409, 'import_mismatch', 'the import for the admin machine is not for the candidate and candidacy the relay lists now (uuid or random differ): nothing was imported or approved. Reload the page and approve again');
  }
  const uuid = c.uuid as string;
  const registration: SignedRegistrationWire = {
    body: { v: 1, uuid, name: c.name, identityPublicKey: c.identityPublicKey, serial: (state.revoked[uuid] ?? 0) + 1, validFrom: state.now, validTo: state.now + VALID_YEARS_SECONDS, adminKeyId: state.admin.keyId },
    // MOCK: the browser mock cannot sign; the real daemon holds a registration signed by the admin key.
    signature: 'MOCK-UNSIGNED-NOT-A-SIGNATURE',
  };
  const revoked = Object.fromEntries(Object.entries(state.revoked).filter(([k]) => k !== uuid));
  const next: CandidaciesState = {
    ...state,
    candidacies: state.candidacies.map((x, i) => (i === index ? { ...x, status: 'approved' as const } : x)),
    trusted: uuid === state.admin.uuid ? state.trusted : [...state.trusted.filter((r) => r.body.uuid !== uuid), registration],
    revoked,
  };
  return {
    state: next,
    answer: ok({
      ok: true,
      id,
      message: `Candidacy ${id} approved: the candidate finishes on its next check, after the security codes are compared`,
      ...(body.adminImport === null ? {} : { imported: { uuid, name: c.name } }),
    }),
  };
}

/** `POST /candidacies/:id/reject`: the row is gone from the list. */
export function rejectCandidacy(state: CandidaciesState, id: string): Step<RejectAnswer> {
  const refuse = (status: number, kind: string, error: string): Step<RejectAnswer> => ({ state, answer: fail(status, kind, error) });
  if (!CANDIDACY_ID.test(id)) return refuse(400, 'bad_request', 'the candidacy id must be 1 to 128 letters, digits, "-" or "_" (it is the id the relay listed): reload the page and press Reject on the row again');
  if (state.relayError !== null) return { state, answer: { status: state.relayError.status, body: { ...state.relayError } } };
  const c = state.candidacies.find((x) => x.id === id);
  // MOCK: the relay purges an expired candidacy, so rejecting it is "unknown" (the backend only relays whatever status the real relay answers).
  if (c === undefined || (c.status === 'pending' && c.expiresAt <= state.now)) {
    return refuse(404, 'not_found', 'the relay does not know this candidacy (it expired, 15 minutes after it was posted, or the relay restarted): nothing was rejected. The candidate can run `machine join --resume` to post a new one');
  }
  if (c.status !== 'pending') return refuse(409, 'not_pending', 'the candidacy is no longer pending (it was already approved or rejected, or it expired): nothing was changed here. Reload the page to see its current state');
  return {
    state: { ...state, candidacies: state.candidacies.filter((x) => x.id !== id) },
    answer: ok({ ok: true, id, message: `Candidacy ${id} rejected: the candidate is told on its next check` }),
  };
}

const CODE_RULE = 'expected exactly {"uuid": "<uuid of the approved machine>", "name": "<its name, 1 to 64 characters>", "code": "<five groups of five digits>"}, nothing else';

/** The sentence that says why `body` is not a code to keep (backend `approvalCodes.ts` parseApprovalCode), or undefined. */
function codeProblem(body: unknown): string | undefined {
  if (!isObject(body)) return CODE_RULE;
  const keys = Object.keys(body);
  if (keys.length !== 3 || !keys.every((k) => k === 'uuid' || k === 'name' || k === 'code')) return CODE_RULE;
  if (typeof body['uuid'] !== 'string' || !UUID.test(body['uuid'])) return `"uuid" is not the uuid of a machine: ${CODE_RULE}`;
  if (typeof body['name'] !== 'string' || body['name'].length < 1 || body['name'].length > 64 || CONTROL.test(body['name'])) return `"name" must be 1 to 64 printable characters: ${CODE_RULE}`;
  if (typeof body['code'] !== 'string' || !CODE.test(body['code'])) return `"code" must be five groups of five digits: ${CODE_RULE}`;
  return undefined;
}

/** `POST /approval-codes`: keeps the code (replacing the one of the same machine), so it is listed and shown again on the last step. */
export function keepApprovalCode(state: CandidaciesState, body: ApprovalCodeRequest): Step<OkAnswer> {
  const problem = codeProblem(body);
  if (problem !== undefined) return { state, answer: fail(400, 'bad_request', problem) };
  const kept: KeptApproval = { uuid: body.uuid, name: body.name, code: body.code, at: state.now };
  return { state: { ...state, approvals: fresh([kept, ...state.approvals.filter((e) => e.uuid !== body.uuid)], state.now) }, answer: ok({ ok: true }) };
}

const DISTRIBUTE_RULE = 'expected exactly {"candidateUuid": "<uuid>", "documents": [<signed inbox document>...], "noticeRecipients": <signed list, or null>}, nothing else: reload the page and approve again';

/** `POST /approve-distribute`: the delivery the scenario planned, once the candidate is trusted here (so only after the approval). */
export function distribute(state: CandidaciesState, body: DistributeRequest): Step<DistributeAnswer> {
  const refuse = (status: number, kind: string, error: string): Step<DistributeAnswer> => ({ state, answer: fail(status, kind, error) });
  if (!isObject(body) || Object.keys(body).length !== 3 || !('candidateUuid' in body) || !('documents' in body) || !('noticeRecipients' in body)) return refuse(400, 'bad_request', DISTRIBUTE_RULE);
  const { candidateUuid, documents, noticeRecipients } = body;
  if (typeof candidateUuid !== 'string' || !UUID.test(candidateUuid)) return refuse(400, 'bad_request', `"candidateUuid" is not the uuid of the approved machine: ${DISTRIBUTE_RULE}`);
  if (!Array.isArray(documents) || !documents.every(isObject)) return refuse(400, 'bad_request', `"documents" must be a list of signed documents: ${DISTRIBUTE_RULE}`);
  if (noticeRecipients !== null && !isObject(noticeRecipients)) return refuse(400, 'bad_request', `"noticeRecipients" must be a signed list or null: ${DISTRIBUTE_RULE}`);
  if (!state.trusted.some((r) => r.body.uuid === candidateUuid) && candidateUuid !== state.admin.uuid) {
    return refuse(409, 'not-imported', `machine ${candidateUuid} is not a trusted peer of this machine: the approval was not imported here, so there is nothing to tell the others about. Nothing was delivered; approve the candidacy again, or run \`machine admin approve\``);
  }
  const planned = state.distributions[candidateUuid];
  // MOCK: a scenario that plans no delivery fails loudly instead of inventing one.
  if (planned === undefined) return refuse(502, 'mock_no_delivery', `the mock scenario plans no delivery for machine ${candidateUuid}: add its answer to "distributions" of the seed`);
  return { state, answer: ok(planned) };
}

/** Moves the clock: ages grow, a candidacy can expire, a kept code can be forgotten. */
export function advanceClock(state: CandidaciesState, seconds: number): Step<OkAnswer> {
  return { state: { ...state, now: state.now + seconds }, answer: ok({ ok: true }) };
}

/** Moves every date of the state so that `now` is `newNow` and the ages stay what they were (a seed written once stays "4 min old" whenever it is loaded). */
export function rebase(state: CandidaciesState, newNow: number): CandidaciesState {
  const delta = newNow - state.now;
  return {
    ...state,
    now: newNow,
    candidacies: state.candidacies.map((c) => ({ ...c, createdAt: c.createdAt + delta, expiresAt: c.expiresAt + delta })),
    approvals: state.approvals.map((a) => ({ ...a, at: a.at + delta })),
  };
}
