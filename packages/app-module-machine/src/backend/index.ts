// violations-suppress: ts/no-barrel-index app-core requires the backend entry of an app-module to be src/backend/index.ts (app-core-cli check)
import { ageText, isCandidacyId, listCandidacies, rejectCandidacy, RelayNotConfiguredError, RelayRequestError, type CandidacyListView } from './candidacies.js';
import { candidacyTimeline } from './candidacyTimeline.js';
import { resolveModuleConfigDir } from './configDir.js';
import { callDaemon, DaemonAuthError, DaemonCommandError, DaemonUnreachableError } from './daemonClient.js';
import { runHealth } from './health.js';
import { checkModuleHeader } from './guard.js';
import { remoteRequestsPage, requestsPage, RequestsAnswerError } from './requests.js';
import { registerActivityRoute } from './activityRoute.js'; // run-log
import { registerAllowedRoute } from './allowedRoute.js';
import { checkDenyReason, type RequestsListAnswer } from '@wadeck-app/machine-core';
import { errorBody } from './errorBody.js';

// Backend of the machine module. Read routes, plus the routes of the Allow button (decision 76: `sensitive`, they carry only the ENCRYPTED admin key
// and signed documents). No route here signs: signing happens in the browser (decision D25). Local-API limit, stated honestly: app-core checks only Host and
// Origin, so ANY local process can call these routes as the user; they hand out what that process could read from the files
// of the same user anyway. `guard.ts` (x-machine-module) is for the routes of the later slices that sign or spend the token.

/** The minimal part of the app-core ModuleContext this module uses (the SDK package is not a dependency of this slice). */
export interface ModuleContextLike {
  registerRoute(method: string, subPath: string, handler: (req: unknown, reply: ReplyLike) => unknown, options?: { effect: 'read' | 'write' | 'sensitive' }): void;
}

export interface ReplyLike {
  code(status: number): ReplyLike;
  send(body: unknown): unknown;
}

/** Connecting and asking a peer takes up to the connection timeouts plus the answer timeout of the daemon. */
const REMOTE_TIMEOUT_MS = 45_000;

/** The HTTP status of a failure of `remoteRequests` (the reason is the `kind`; anything not listed is 502). */
const REMOTE_STATUS: Record<string, number> = {
  'unknown-peer': 404,
  'bad-payload': 400,
  'wrong-target': 400,
  'source-mismatch': 400,
  'bad-signature': 403,
  'no-admin': 403,
  'rate-limited': 429,
};

/** The HTTP status of a refusal of the daemon commands of the Allow flow (the reason is the `kind`; anything not listed is 502). */
const ALLOW_STATUS: Record<string, number> = {
  'bad-payload': 400,
  'bad-document': 400,
  'bad-notice-recipients': 400,
  'stale-notice-recipients': 409,
  'notice-recipients-invalid': 409,
  'unknown-machine': 404,
  'bad-signature': 403,
  'stale-base': 409,
  'mode-local': 409,
  'no-admin-key': 409,
  'no-admin-token': 409,
  'policy-record-invalid': 409,
  'policy-mode-invalid': 409,
  'key-file-invalid': 409,
  refused: 409,
  'relay-error': 502,
};

/**
 * The HTTP status of a refusal of the daemon command `deny` (the reason is the `kind`; anything not listed is 502). The body of the answer
 * carries the daemon's own sentence, which names the fix.
 */
const DENY_STATUS: Record<string, number> = {
  unknown: 404,
  ambiguous: 400,
  'too-short': 400,
  'bad-reason': 400,
  'no-daemon': 503,
  // A request held on ANOTHER machine (decision 85): the answer of that machine, or why it could not be asked.
  'not-a-recipient': 403,
  'recipients-unreadable': 409,
  'not-held': 404,
  'bad-deny': 400,
  'unknown-peer': 404,
  'peer-too-old': 502,
  unreachable: 502,
  'no-answer': 504,
  'audit-unavailable': 503,
  'unexpected-answer': 502,
  'bad-payload': 400,
};

/** Connecting to the target (3 s per address, plus the address lookup) and its answer (10 s). */
const REMOTE_DENY_TIMEOUT_MS = 30_000;

/** Storing a policy may include one call to the relay. */
const ALLOW_TIMEOUT_MS = 20_000;

/** Why a body is not `{ policy, document? }` (names the offending field, never its value); undefined when it is. */
function allowBodyProblem(body: unknown): string | undefined {
  const expected = 'expected {"policy": <signed policy>, "document": <signed inbox document, for another machine>}: the page signs them in the browser';
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return expected;
  const record = body as Record<string, unknown>;
  const extra = Object.keys(record).find((k) => k !== 'policy' && k !== 'document' && k !== 'noticeRecipients');
  if (extra !== undefined) return `the field "${extra}" is not accepted: this route takes only the signed policy, its document and the signed list of notice recipients, never a passphrase or a key (${expected})`;
  const signed = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { body?: unknown }).body === 'object' && (v as { body?: unknown }).body !== null && typeof (v as { signature?: unknown }).signature === 'string';
  if (!signed(record['policy'])) return `"policy" must be a signed policy ({ body, signature }); ${expected}`;
  if (record['document'] !== undefined && !signed(record['document'])) return `"document" must be a signed document ({ body, signature }); ${expected}`;
  const list = record['noticeRecipients'];
  if (list !== undefined) {
    const shape: Record<string, unknown> | undefined = typeof list === 'object' && list !== null && !Array.isArray(list) ? Object.fromEntries(Object.entries(list)) : undefined;
    const listExtra = shape === undefined ? undefined : Object.keys(shape).find((k) => k !== 'signed' && k !== 'document');
    if (shape === undefined || listExtra !== undefined || !signed(shape['signed']) || !signed(shape['document'])) {
      return `"noticeRecipients" must be exactly {"signed": <signed list>, "document": <signed inbox document>}${listExtra === undefined ? '' : ` (the field "${listExtra}" is not accepted)`}; ${expected}`;
    }
  }
  return undefined;
}

/** The body of a Deny: `{ id, reason? }`, or why it is not (names the offending field, never its value). */
type DenyBody = { ok: true; id: string; reason: string | undefined; machine: string | undefined } | { ok: false; problem: string };

function parseDenyBody(body: unknown): DenyBody {
  const expected = 'expected {"id": "<id of the waiting request>", "reason": "<optional text for the agent>", "machine": "<the machine that holds it, when it is not this one>"}';
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, problem: expected };
  }
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(body));
  const extra = Object.keys(record).find((k) => k !== 'id' && k !== 'reason' && k !== 'machine');
  if (extra !== undefined) {
    return { ok: false, problem: `the field "${extra}" is not accepted: a Deny signs nothing and asks no passphrase, this route takes only the id, an optional reason and the machine that holds the request (${expected})` };
  }
  const id = record['id'];
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
    return { ok: false, problem: `"id" must be the id of a waiting request, 1 to 64 characters (\`machine requests\` lists them); ${expected}` };
  }
  const machine = record['machine'];
  if (machine !== undefined && (typeof machine !== 'string' || machine.length === 0 || machine.length > 64)) {
    return { ok: false, problem: `"machine" must be the name, alias or uuid of the machine that holds the request, 1 to 64 characters (the Requests page names it); ${expected}` };
  }
  const reason = record['reason'];
  if (reason === undefined) {
    return { ok: true, id, reason, machine };
  }
  if (typeof reason !== 'string') {
    return { ok: false, problem: `"reason" must be text; ${expected}` };
  }
  // The ONE whitelist of the CLI, the daemon and this route (machine-core checkDenyReason): a blank text is no reason.
  const checked = checkDenyReason(reason);
  if (!checked.ok) {
    return { ok: false, problem: checked.message };
  }
  return { ok: true, id, reason: checked.reason, machine };
}

/** The HTTP status of a refusal of the daemon command `dismissNotice` (anything not listed is 502): the answer carries the daemon's own sentence. */
const DISMISS_STATUS: Record<string, number> = { unknown: 404, none: 404, live: 409 };

const DISMISS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The body of a Dismiss: `{ machine, id }` or `{ expired: true }`, or why it is not (names the offending field, never its value). */
function parseDismissBody(body: unknown): { ok: true; payload: { machine: string; id: string } | { expired: true } } | { ok: false; problem: string } {
  const expected = 'expected {"machine": "<uuid of the machine that reported the request>", "id": "<request id>"} or {"expired": true}';
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, problem: expected };
  }
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(body));
  const extra = Object.keys(record).find((k) => k !== 'machine' && k !== 'id' && k !== 'expired');
  if (extra !== undefined) {
    return { ok: false, problem: `the field "${extra}" is not accepted: a Dismiss signs nothing and takes no passphrase, this route takes only the machine and the id, or "expired" (${expected})` };
  }
  if (record['expired'] !== undefined) {
    if (record['expired'] !== true || record['machine'] !== undefined || record['id'] !== undefined) {
      return { ok: false, problem: `"expired" must be true and alone (${expected})` };
    }
    return { ok: true, payload: { expired: true } };
  }
  const { machine, id } = record;
  if (typeof machine !== 'string' || !DISMISS_UUID.test(machine)) {
    return { ok: false, problem: `"machine" must be the uuid of the machine that reported the request (the Requests page sends it); ${expected}` };
  }
  if (typeof id !== 'string' || !DISMISS_UUID.test(id)) {
    return { ok: false, problem: `"id" must be the request id, a UUID; ${expected}` };
  }
  return { ok: true, payload: { machine, id } };
}

interface Failure {
  status: number;
  kind: string;
  error: string;
  message: string;
}

function failureOf(err: unknown): Failure {
  if (err instanceof DaemonUnreachableError) return errorBody(503, 'daemon_unreachable', err.message);
  if (err instanceof DaemonAuthError) return errorBody(502, 'daemon_token_refused', err.message);
  // An older daemon does not know a command of this module: the fix is the update, not a retry.
  if (err instanceof DaemonCommandError && /Unknown command/.test(err.message)) return errorBody(502, 'daemon_error', `${err.message}: the daemon is older than this module, update it with \`machine cli update\` and restart it`);
  if (err instanceof DaemonCommandError) return errorBody(502, 'daemon_error', err.message);
  if (err instanceof RequestsAnswerError) return errorBody(502, 'daemon_error', err.message);
  if (err instanceof RelayNotConfiguredError) return errorBody(503, 'relay_not_configured', err.message);
  if (err instanceof RelayRequestError) return errorBody(502, 'relay_error', err.message);
  return errorBody(500, 'internal', err instanceof Error ? err.message : String(err));
}

interface NotInitialized {
  initialized: false;
  message: string;
}

const isNotInitialized = (value: unknown): value is NotInitialized =>
  typeof value === 'object' && value !== null && (value as { initialized?: unknown }).initialized === false;

const notInitialized = (value: NotInitialized): Failure => (errorBody(409, 'not_initialized', value.message));

interface ListAnswerLike {
  enrolled?: unknown;
  note?: unknown;
  self?: { uuid?: unknown; name?: unknown };
  peers?: Array<{ uuid?: unknown; name?: unknown; aliases?: unknown }>;
}

function machineRows(answer: ListAnswerLike): Array<{ uuid: string; name: string; self: boolean; role: string; aliasesText: string }> {
  const rows: Array<{ uuid: string; name: string; self: boolean; role: string; aliasesText: string }> = [];
  if (answer.self !== undefined) rows.push({ uuid: String(answer.self.uuid), name: String(answer.self.name), self: true, role: 'this machine', aliasesText: '' });
  for (const peer of answer.peers ?? []) {
    const aliases = Array.isArray(peer.aliases) ? peer.aliases.map(String) : [];
    rows.push({ uuid: String(peer.uuid), name: String(peer.name), self: false, role: 'peer', aliasesText: aliases.join(', ') });
  }
  return rows;
}

interface NoticeHoldersLike {
  admin?: unknown;
  listKnown?: unknown;
  serial?: unknown;
  recipients?: Array<{ uuid?: unknown; name?: unknown }>;
  holders?: Array<{ uuid?: unknown; text?: unknown }>;
  note?: unknown;
}

/**
 * Who receives request notices and which machine holds the list (request-notices.md), from the daemon command `noticeHolders` (local files, no
 * network). Never fails the machines list: when the daemon cannot tell, the page gets a note that names the fix, not empty columns.
 */
async function noticeColumns(dir: string): Promise<{ decorate: <R extends { uuid: string }>(row: R) => R; text?: string; note?: string }> {
  const untouched = <R extends { uuid: string }>(row: R): R => row;
  let answer: unknown;
  try {
    answer = await callDaemon(dir, 'noticeHolders');
  } catch (err) {
    const failure = failureOf(err);
    const older = failure.kind === 'daemon_error' && failure.error.includes('older than this module');
    return { decorate: untouched, note: older ? 'The daemon is older than this module and cannot tell who receives request notices: update it with `machine cli update` and restart it.' : `Who receives request notices is not shown: ${failure.error}` };
  }
  if (isNotInitialized(answer)) {
    return { decorate: untouched };
  }
  const holders = answer as NoticeHoldersLike;
  const recipients = new Set((holders.recipients ?? []).map((r) => String(r.uuid)));
  const heldText = new Map((holders.holders ?? []).map((h) => [String(h.uuid), String(h.text)]));
  const names = (holders.recipients ?? []).map((r) => String(r.name));
  return {
    decorate: <R extends { uuid: string }>(row: R): R => ({ ...row, receivesNotices: recipients.has(row.uuid) ? 'yes' : 'no', listHeldText: heldText.get(row.uuid) ?? '' }),
    ...(holders.listKnown === true ? { text: `Request notices go to ${names.length === 0 ? 'nobody (the list is empty)' : names.join(', ')} (list serial ${String(holders.serial)}).` } : {}),
    ...(typeof holders.note === 'string' ? { note: holders.note } : {}),
  };
}

interface ReachabilityLike {
  machines?: Array<{ uuid?: unknown; state?: unknown; text?: unknown }>;
}

/**
 * Can this machine reach each peer DIRECTLY now (decision 86), from the daemon command `reachability` (the probe of the daemon, from memory). The text is the one of the CLI.
 * Never fails the machines list: an older daemon gets a note that names the fix, and the column says `unknown` instead of staying empty.
 */
async function reachabilityColumns(dir: string): Promise<{ decorate: <R extends { uuid: string; self: boolean }>(row: R) => R; note?: string }> {
  const byUuid = new Map<string, { state: string; text: string }>();
  let note: string | undefined;
  try {
    const answer = (await callDaemon(dir, 'reachability')) as ReachabilityLike & { initialized?: unknown };
    if (answer.initialized !== false) {
      for (const m of answer.machines ?? []) {
        if (typeof m.uuid === 'string' && typeof m.state === 'string' && typeof m.text === 'string') byUuid.set(m.uuid, { state: m.state, text: m.text });
      }
    }
  } catch (err) {
    const failure = failureOf(err);
    note = failure.kind === 'daemon_error' && failure.error.includes('older than this module')
      ? 'The daemon is older than this module and cannot tell which machines are reachable directly: update it with `machine cli update` and restart it.'
      : `Which machines are reachable directly is not shown: ${failure.error}`;
  }
  return {
    decorate: <R extends { uuid: string; self: boolean }>(row: R): R => {
      if (row.self) return { ...row, reachableState: 'self', reachable: 'this machine' };
      const known = byUuid.get(row.uuid);
      return { ...row, reachableState: known?.state ?? 'unknown', reachable: known?.text ?? 'unknown' };
    },
    ...(note === undefined ? {} : { note }),
  };
}

function candidacyRow(view: CandidacyListView, nowSeconds: number): CandidacyListView & { ageText: string; bindingText: string; statusText: string; canDecide: boolean } {
  let binding: string;
  if (view.rebind) {
    const which = view.boundTokenLabel !== undefined ? `the token labelled "${view.boundTokenLabel}"` : 'another token (the relay did not say which)';
    binding = `The uuid is already bound to ${which}; approving replaces that binding.${view.bindingNote !== undefined ? ` Note: ${view.bindingNote}.` : ''}`;
  } else if (view.uuidBound === true) {
    binding = 'The uuid is already bound to the same token as this candidacy: a re-approval, nothing is rebound.';
  } else if (view.uuidBound === false) {
    binding = 'The uuid is not bound yet: approving creates the binding.';
  } else {
    binding = 'The relay did not say whether the uuid is already bound.';
  }
  const expires = view.expiresAt === undefined ? 'unknown' : view.expiresAt <= nowSeconds ? 'expired' : `in ${ageText(view.expiresAt - nowSeconds)}`;
  // Markdown of the row expansion, never empty. The candidacy code is not shown (decision 55).
  const bindingText = [
    `- name: ${view.name}`,
    `- hostname: ${view.hostname === '' ? 'unknown' : view.hostname}`,
    `- uuid: ${view.uuid ?? 'unknown'}`,
    `- seen from: ${view.observedIp === '' ? 'unknown' : view.observedIp}`,
    `- age: ${ageText(view.ageSeconds)}`,
    `- ${expires === 'unknown' ? 'expires: unknown' : expires === 'expired' ? 'expired' : `expires ${expires}`}`,
    '',
    binding,
    '',
    'Reject refuses the candidate here (no passphrase needed). To approve it, run `machine admin approve` in a terminal: approving from this page is not built yet.',
  ].join('\n');
  // Reject is offered only where the relay can still take a decision: pending (or no status stated) and not expired. A candidacy with problems can still be rejected.
  const canDecide = isCandidacyId(view.id) && (view.relayStatus === undefined || view.relayStatus === 'pending') && (view.expiresAt === undefined || view.expiresAt > nowSeconds);
  const statusText = view.problems.length > 0
    ? `Cannot be approved: ${view.problems.join('; ')}`
    : view.relayStatus === 'approved'
      ? 'Approved by the admin (relay status: approved)'
      : view.relayStatus !== undefined && view.relayStatus !== 'pending'
        ? `Relay status: ${view.relayStatus}`
        : view.rebind
      ? 'Warning: uuid already bound to a token'
      : 'Pending';
  return { ...view, ageText: ageText(view.ageSeconds), bindingText, statusText, canDecide };
}

/**
 * backendEntryPath target declared in manifest.json. app-core calls this once at module load with the module context:
 * routes become /api/modules/machine/<subPath>. Every handler reads the config files at each request (the daemon port,
 * the admin token), so a restarted daemon or a new login is followed without reloading the module.
 */
export default function register(ctx: ModuleContextLike): void {
  const configDir = (): string => resolveModuleConfigDir(process.env);

  // Update test of app-core-cli (decision 65): always 200 in the documented format, read only, about 2 s at most. See health.ts.
  ctx.registerRoute('GET', '/health', async (_req, reply) => reply.code(200).send(await runHealth(configDir())));

  ctx.registerRoute('GET', '/status', async (_req, reply) => {
    try {
      const answer = await callDaemon(configDir(), 'status');
      if (isNotInitialized(answer)) {
        const failure = notInitialized(answer);
        return reply.code(failure.status).send(failure);
      }
      return reply.code(200).send(answer);
    } catch (err) {
      const failure = failureOf(err);
      return reply.code(failure.status).send(failure);
    }
  });

  ctx.registerRoute('GET', '/machines', async (_req, reply) => {
    try {
      const answer = await callDaemon(configDir(), 'list');
      if (isNotInitialized(answer)) {
        const failure = notInitialized(answer);
        return reply.code(failure.status).send(failure);
      }
      const list = answer as ListAnswerLike;
      const notices = await noticeColumns(configDir());
      const reachability = await reachabilityColumns(configDir());
      const machines = machineRows(list).map((row) => reachability.decorate(notices.decorate(row)));
      return reply.code(200).send({
        machines,
        ...(notices.text === undefined ? {} : { noticesText: notices.text }),
        ...(notices.note === undefined ? {} : { noticesNote: notices.note }),
        ...(reachability.note === undefined ? {} : { reachableNote: reachability.note }),
        count: machines.length,
        enrolled: list.enrolled === true,
        ...(typeof list.note === 'string' ? { note: list.note } : {}),
        // The daemon `list` carries neither presence nor addresses (machine-cli adds them in the CLI from the relay): said here so the page never guesses.
        presenceNote: 'Presence and addresses are not shown yet: the daemon list does not carry them (see `machine list` for the relay view).',
      });
    } catch (err) {
      const failure = failureOf(err);
      return reply.code(failure.status).send(failure);
    }
  });

  // The Requests page (decision 73): the audit log of THIS machine through the daemon command `requests` (the reader of `machine requests`).
  ctx.registerRoute('GET', '/requests', async (_req, reply) => {
    try {
      const answer = await callDaemon(configDir(), 'requests');
      if (isNotInitialized(answer)) {
        const failure = notInitialized(answer);
        return reply.code(failure.status).send(failure);
      }
      return reply.code(200).send(requestsPage(answer, Math.floor(Date.now() / 1000)));
    } catch (err) {
      const failure = failureOf(err);
      return reply.code(failure.status).send(failure);
    }
  });

  // The progress of an Allow (decision 86): is the request still held, or how did the hold end? Read-only like /requests (it reveals what the Requests page
  // shows): the page asks every 2 s while a step is pending. `self` is this machine; another machine is its uuid, name or alias.
  ctx.registerRoute('GET', '/hold-progress/:machine/:id', async (req, reply) => {
    const params = typeof req === 'object' && req !== null ? (req as { params?: { machine?: unknown; id?: unknown } }).params : undefined;
    const machine = params?.machine;
    const id = params?.id;
    if (typeof id !== 'string' || !/^[0-9a-f-]{6,36}$/.test(id)) {
      return reply.code(400).send(errorBody(400, 'bad_request', 'the request id must be 6 to 36 hexadecimal characters and "-" (`machine requests` prints it): /hold-progress/<machine|self>/<request id>'));
    }
    if (typeof machine !== 'string' || machine.length === 0 || machine.length > 64) {
      return reply.code(400).send(errorBody(400, 'bad_request', 'the machine must be "self" or the name, alias or uuid of a machine, 1 to 64 characters: /hold-progress/<machine|self>/<request id>'));
    }
    try {
      const answer = (await callDaemon(configDir(), 'holdProgress', undefined, machine === 'self' ? { id } : { id, machine })) as { ok?: unknown; reason?: unknown; message?: unknown };
      if (answer.ok === false) {
        const reason = typeof answer.reason === 'string' ? answer.reason : 'refused';
        const status = reason === 'unknown-peer' ? 404 : reason === 'bad-payload' ? 400 : 502;
        return reply.code(status).send(errorBody(status, reason, typeof answer.message === 'string' ? answer.message : 'the daemon refused the holdProgress command'));
      }
      return reply.code(200).send(answer);
    } catch (err) {
      const failure = failureOf(err);
      return reply.code(failure.status).send(failure);
    }
  });

  // The remote section (decision 74): the page signs a `requests-list` document with the admin key IN THE BROWSER and posts it here; the
  // daemon forwards it to the peer, which checks the signature. This backend never sees the admin key or the passphrase. Sensitive (PIN
  // of app-core) because it makes this machine contact another one; the module header keeps stray posts out.
  ctx.registerRoute(
    'POST',
    '/requests/remote',
    async (req, reply) => {
      const refusal = checkModuleHeader(req);
      if (refusal !== undefined) return reply.code(refusal.status).send(errorBody(refusal.status, 'module_header', refusal.error));
      const body = typeof req === 'object' && req !== null ? (req as { body?: unknown }).body : undefined;
      const { machine, request } = typeof body === 'object' && body !== null ? (body as { machine?: unknown; request?: unknown }) : {};
      if (typeof machine !== 'string' || machine.length === 0 || typeof request !== 'object' || request === null) {
        return reply.code(400).send(errorBody(400, 'bad_request', 'expected {"machine": "<name or uuid>", "request": <requests-list document signed with the admin key>}'));
      }
      try {
        const answer = (await callDaemon(configDir(), 'remoteRequests', REMOTE_TIMEOUT_MS, { peer: machine, request })) as { ok?: boolean; answer?: RequestsListAnswer; reason?: string; message?: string };
        if (answer.ok === true && answer.answer !== undefined) return reply.code(200).send(remoteRequestsPage(answer.answer, Math.floor(Date.now() / 1000)));
        const reason = typeof answer.reason === 'string' ? answer.reason : 'refused';
        return reply.code(REMOTE_STATUS[reason] ?? 502).send(errorBody(REMOTE_STATUS[reason] ?? 502, reason, typeof answer.message === 'string' ? answer.message : 'the peer did not answer with a list'));
      } catch (err) {
        const failure = failureOf(err);
        return reply.code(failure.status).send(failure);
      }
    },
    { effect: 'sensitive' },
  );

  // The Allow button of the Requests page (decision 76, app-module-parity.md P2.0 and P2.2). The admin passphrase and the unlocked key exist ONLY in
  // the browser: the page reads the ENCRYPTED key file here, unlocks it, signs the next policy and posts back only signed documents. These three
  // routes are `sensitive` (the app-core PIN, so a process that merely reaches the port cannot even fetch the key file) and need the module
  // header; they never see, log or forward a passphrase or a key (the post accepts exactly {policy, document}). The daemon still verifies the
  // admin signature, the target and the base version before it stores or delivers anything (hard rule 4).
  const SENSITIVE = { effect: 'sensitive' } as const;
  const viaDaemon = async (req: unknown, reply: ReplyLike, command: string, payload: unknown | undefined, timeoutMs: number | undefined, ok: (result: unknown) => unknown = (r) => r, statuses: Record<string, number> = ALLOW_STATUS): Promise<unknown> => {
    const refusal = checkModuleHeader(req);
    if (refusal !== undefined) return reply.code(refusal.status).send(errorBody(refusal.status, 'module_header', refusal.error));
    try {
      const answer = (await callDaemon(configDir(), command, timeoutMs, payload)) as { ok?: unknown; reason?: unknown; message?: unknown };
      if (typeof answer === 'object' && answer !== null && answer.ok === false) {
        const reason = typeof answer.reason === 'string' ? answer.reason : 'refused';
        const status = statuses[reason] ?? 502;
        return reply.code(status).send(errorBody(status, reason, typeof answer.message === 'string' ? answer.message : `the daemon refused the ${command} command`));
      }
      return reply.code(200).send(ok(answer));
    } catch (err) {
      const failure = failureOf(err);
      return reply.code(failure.status).send(failure);
    }
  };

  ctx.registerRoute('GET', '/admin-key', (req, reply) => viaDaemon(req, reply, 'adminKeyFile', undefined, undefined, (answer) => ({ file: (answer as { file: string }).file })), SENSITIVE);

  ctx.registerRoute('GET', '/allow/:machine', (req, reply) => {
    const machine = typeof req === 'object' && req !== null ? (req as { params?: { machine?: unknown } }).params?.machine : undefined;
    if (typeof machine !== 'string' || machine.length === 0) return reply.code(400).send(errorBody(400, 'bad_request', 'expected the machine (name, alias or uuid) in the path: /allow/<machine>'));
    return viaDaemon(req, reply, 'allowContext', { machine }, undefined);
  }, SENSITIVE);

  ctx.registerRoute('POST', '/allow', (req, reply) => {
    // The header first (a stray request learns nothing about the body rules), then the shape; viaDaemon checks the header again, which is cheap.
    const refusal = checkModuleHeader(req);
    if (refusal !== undefined) return reply.code(refusal.status).send(errorBody(refusal.status, 'module_header', refusal.error));
    const body = typeof req === 'object' && req !== null ? (req as { body?: unknown }).body : undefined;
    const problem = allowBodyProblem(body);
    if (problem !== undefined) return reply.code(400).send(errorBody(400, 'bad_request', problem));
    const { policy, document, noticeRecipients } = body as { policy: unknown; document?: unknown; noticeRecipients?: { signed: unknown; document: unknown } };
    // Only these fields go to the daemon, re-built here: nothing else of the request can travel with them.
    const forwarded = { policy, ...(document === undefined ? {} : { document }), ...(noticeRecipients === undefined ? {} : { noticeRecipients: { signed: noticeRecipients.signed, document: noticeRecipients.document } }) };
    return viaDaemon(req, reply, 'submitPolicy', forwarded, ALLOW_TIMEOUT_MS);
  }, SENSITIVE);

  // The Deny button (hold-for-approval.md): restricting, so no signature and no passphrase, but sensitive (the app-core PIN) like the Allow routes: it answers a waiting caller. Only {id, reason} reach the daemon, re-built here.
  ctx.registerRoute('POST', '/deny', (req, reply) => {
    const refusal = checkModuleHeader(req);
    if (refusal !== undefined) {
      return reply.code(refusal.status).send(errorBody(refusal.status, 'module_header', refusal.error));
    }
    const parsed = parseDenyBody(typeof req === 'object' && req !== null ? (req as { body?: unknown }).body : undefined);
    if (!parsed.ok) {
      return reply.code(400).send(errorBody(400, 'bad_request', parsed.problem));
    }
    const { id, reason, machine } = parsed;
    const rest = reason === undefined ? { id } : { id, reason };
    // Held on another machine: this daemon opens the authenticated channel to it (decision 85); the target decides whether this machine may deny.
    if (machine !== undefined) {
      return viaDaemon(req, reply, 'denyRemote', { peer: machine, ...rest }, REMOTE_DENY_TIMEOUT_MS, (r) => r, DENY_STATUS);
    }
    return viaDaemon(req, reply, 'deny', rest, undefined, (r) => r, DENY_STATUS);
  }, SENSITIVE);

  // The Dismiss and Clear expired buttons (decision 100): a restricting, local action on a display row of notices.json. It answers nobody, signs nothing and touches no
  // target and no audit line, so it is a plain write route (no PIN), unlike Deny. Only {machine, id} or {expired: true} reach the daemon, re-built here.
  ctx.registerRoute('POST', '/dismiss-notice', (req, reply) => {
    const refusal = checkModuleHeader(req);
    if (refusal !== undefined) {
      return reply.code(refusal.status).send(errorBody(refusal.status, 'module_header', refusal.error));
    }
    const parsed = parseDismissBody(typeof req === 'object' && req !== null ? (req as { body?: unknown }).body : undefined);
    if (!parsed.ok) {
      return reply.code(400).send(errorBody(400, 'bad_request', parsed.problem));
    }
    return viaDaemon(req, reply, 'dismissNotice', parsed.payload, undefined, (r) => r, DISMISS_STATUS);
  }, { effect: 'write' });

  // run-log: the Activity page (the commands this machine sent and received), a plain read route in its own file
  registerActivityRoute(ctx, configDir); // run-log
  // The Allowed page (what every machine allows), a plain read route in its own file
  registerAllowedRoute(ctx, configDir);

  // The Reject button of the Candidacies page. A rejection only restricts (hard rule 4): no signature, no passphrase. It spends the relay admin token, so
  // the route is `sensitive` (the app-core PIN). The `x-machine-module` header is NOT required: the row action of the DSL view cannot send a custom header,
  // so the PIN is the gate. No body is read: the id is the path and the decision is fixed in `rejectCandidacy`, so this route can never approve.
  const REJECT_KINDS: Record<number, string> = { 400: 'bad_request', 404: 'not_found', 409: 'not_pending' };
  ctx.registerRoute('POST', '/candidacies/:id/reject', async (req, reply) => {
    const id = typeof req === 'object' && req !== null ? (req as { params?: { id?: unknown } }).params?.id : undefined;
    try {
      await rejectCandidacy(configDir(), typeof id === 'string' ? id : '');
      return reply.code(200).send({ ok: true, id, message: `Candidacy ${String(id)} rejected: the candidate is told on its next check` });
    } catch (err) {
      const kind = err instanceof RelayRequestError ? REJECT_KINDS[err.status] : undefined;
      if (err instanceof RelayRequestError && kind !== undefined) return reply.code(err.status).send(errorBody(err.status, kind, err.message));
      const failure = failureOf(err);
      return reply.code(failure.status).send(failure);
    }
  }, SENSITIVE);

  ctx.registerRoute('GET', '/candidacies', async (_req, reply) => {
    try {
      const now = Math.floor(Date.now() / 1000);
      const views = await listCandidacies(configDir(), now);
      const candidacies = views.map((v) => candidacyRow(v, now));
      // `count` is the field the tab indicator of the manifest reads.
      const { steps: timeline, note: timelineNote } = candidacyTimeline(views, now);
      return reply.code(200).send({ candidacies, count: candidacies.length, timeline, timelineNote });
    } catch (err) {
      const failure = failureOf(err);
      return reply.code(failure.status).send(failure);
    }
  });
}
