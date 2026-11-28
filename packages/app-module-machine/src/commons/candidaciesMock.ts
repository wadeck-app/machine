import {
  adminKey,
  advanceClock,
  approveCandidacy,
  approveContext,
  distribute,
  keepApprovalCode,
  listCandidacies,
  rebase,
  rejectCandidacy,
  type CandidaciesState,
  type Step,
} from './candidaciesState.js';
import { MODULE_PREFIX, type MockRoutes } from './mockRoutes.js';
import type { ApprovalCodeRequest, ApproveRequest, DistributeRequest } from './routeContracts.js';

// The seven routes of the Candidacies page on mock data (the dev-only scenarios of the module). The pure state machine (candidaciesState.ts) does the work; this file
// only keeps its state in a closure, so that Approve / Reject change what the next GET returns, and follows the clock of the browser, so that ages grow and a candidacy
// expires as it would for real. BROWSER-SAFE: no import of another package, no Node API.

// Small delays so the busy states of the page (signing, sending) can be seen; a read is near instant.
const READ_MS = 120;
const WRITE_MS = 450;

/** The name of the machine the page sends with a rejection (it only words the message), when it is a text. */
const nameOf = (body: unknown): string | undefined => {
  const name = typeof body === 'object' && body !== null ? (body as { name?: unknown }).name : undefined;
  return typeof name === 'string' ? name : undefined;
};

/**
 * The routes of one scenario, `seed` being its initial state (a seed JSON). `clock` returns the epoch seconds of "now": the seed is moved to it once (ages stay as
 * written in the seed) and then advances with it. Every call builds a new state: the closure of `create()` of the scenario, so Reset starts again.
 */
export function candidaciesRoutes(seed: CandidaciesState, clock: () => number): MockRoutes {
  let state = rebase(seed, Math.floor(clock()));
  let last = Math.floor(clock());

  const run = <T>(step: (current: CandidaciesState) => Step<T>, delayMs: number): { status: number; body: unknown; delayMs: number } => {
    const now = Math.floor(clock());
    if (now > last) {
      state = advanceClock(state, now - last).state;
      last = now;
    }
    const out = step(state);
    state = out.state;
    return { status: out.answer.status, body: out.answer.body, delayMs };
  };

  const key = (route: string): string => `${route.slice(0, route.indexOf(' '))} ${MODULE_PREFIX}${route.slice(route.indexOf(' ') + 1)}`;
  return {
    [key('GET /candidacies')]: () => run((s) => listCandidacies(s), READ_MS),
    [key('GET /admin-key')]: () => run((s) => adminKey(s), READ_MS),
    [key('GET /approve-context/:uuid')]: (req) => run((s) => approveContext(s, req.params['uuid'] ?? ''), READ_MS),
    [key('POST /candidacies/:id/approve')]: (req) => run((s) => approveCandidacy(s, req.params['id'] ?? '', req.body as ApproveRequest), WRITE_MS),
    [key('POST /candidacies/:id/reject')]: (req) => run((s) => rejectCandidacy(s, req.params['id'] ?? '', nameOf(req.body)), WRITE_MS),
    [key('POST /approve-distribute')]: (req) => run((s) => distribute(s, req.body as DistributeRequest), WRITE_MS),
    [key('POST /approval-codes')]: (req) => run((s) => keepApprovalCode(s, req.body as ApprovalCodeRequest), READ_MS),
  };
}
