import type { ErrorBody } from './routeContracts.js';

// The relay login started from the page, on mock data (the scenario "relay-error-503"): the pure state machine behind GET /admin-login, POST /admin-login and
// POST /admin-login/cancel. It answers what the daemon answers (machine-cli adminLoginFromPage.ts; the page parses the same shape, proved in candidaciesMock.test.ts), and
// the "admin" confirms in the relay console APPROVE_AFTER_SECONDS after the start: the status then turns approved and the caller lets the list load. BROWSER-SAFE: no import
// of a package, no Node API.

/** How long the mock admin takes to confirm in the relay console. */
export const APPROVE_AFTER_SECONDS = 8;
const CODE_LIFETIME_SECONDS = 300;

export interface LoginMock {
  phase: 'idle' | 'waiting' | 'approved';
  /** Epoch seconds of the start. */
  startedAt: number;
}

export const IDLE: LoginMock = { phase: 'idle', startedAt: 0 };

type Answer = { status: number; body: unknown };
export interface LoginStep {
  login: LoginMock;
  answer: Answer;
  /** The token was "saved": the caller lets the relay routes work (no more "no admin relay token"). */
  tokenSaved: boolean;
}

const waiting = (startedAt: number): unknown => ({
  ok: true,
  state: 'waiting',
  userCode: 'ADMN-7K42',
  verificationUrl: 'https://relay.example.net/console',
  label: 'midgard2 admin',
  relayUrl: 'https://relay.example.net',
  expiresAt: startedAt + CODE_LIFETIME_SECONDS,
  consoleHint: 'In the relay console open Tokens: the request "midgard2 admin" is listed there, marked MACHINE ADMIN. Compare its code with the one above, check that the source address is this computer, then approve.',
});

const refusal = (): ErrorBody => {
  const error = 'this machine already holds an admin relay token (/home/user/.config/machine/_secrets_/relay-admin.json): the page does not replace it; to replace it run `machine admin login --force` in a terminal';
  return { status: 409, kind: 'already-configured', error, message: error };
};

/** `GET /admin-login`: the state, moved on by the clock (the mock admin confirms after APPROVE_AFTER_SECONDS). */
export function loginStatus(login: LoginMock, now: number): LoginStep {
  if (login.phase === 'waiting' && now - login.startedAt >= APPROVE_AFTER_SECONDS) {
    return { login: { ...login, phase: 'approved' }, answer: { status: 200, body: { ok: true, state: 'approved', label: 'midgard2 admin', scopes: ['machine-admin'] } }, tokenSaved: true };
  }
  if (login.phase === 'waiting') return { login, answer: { status: 200, body: waiting(login.startedAt) }, tokenSaved: false };
  if (login.phase === 'approved') return { login, answer: { status: 200, body: { ok: true, state: 'approved', label: 'midgard2 admin', scopes: ['machine-admin'] } }, tokenSaved: false };
  return { login, answer: { status: 200, body: { ok: true, state: 'idle' } }, tokenSaved: false };
}

/** `POST /admin-login`: starts the login, or answers the one already waiting; refuses where a token is already held (`needsToken` false). */
export function loginStart(login: LoginMock, now: number, needsToken: boolean): LoginStep {
  if (!needsToken) return { login, answer: { status: 409, body: refusal() }, tokenSaved: false };
  if (login.phase === 'waiting') return { login, answer: { status: 200, body: waiting(login.startedAt) }, tokenSaved: false };
  return { login: { phase: 'waiting', startedAt: now }, answer: { status: 200, body: waiting(now) }, tokenSaved: false };
}

/** `POST /admin-login/cancel`: stops the wait, nothing is stored. */
export function loginCancel(login: LoginMock): LoginStep {
  const next = login.phase === 'waiting' ? IDLE : login;
  return { login: next, answer: { status: 200, body: loginStatus(next, 0).answer.body }, tokenSaved: false };
}
