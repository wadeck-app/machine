// violations-suppress: ts/no-barrel-index app-core requires the backend entry of an app-module to be src/backend/index.ts (app-core-cli check)
import { ageText, listCandidacies,RelayNotConfiguredError, RelayRequestError, type CandidacyListView } from './candidacies.js';
import { resolveModuleConfigDir } from './configDir.js';
import { callDaemon, DaemonAuthError, DaemonCommandError, DaemonUnreachableError } from './daemonClient.js';
import { runHealth } from './health.js';
import { checkModuleHeader } from './guard.js';
import { remoteRequestsPage, requestsPage, RequestsAnswerError } from './requests.js';
import type { RequestsListAnswer } from '@wadeck-app/machine-core';

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

/** Storing a policy may include one call to the relay. */
const ALLOW_TIMEOUT_MS = 20_000;

/** Why a body is not `{ policy, document? }` (names the offending field, never its value); undefined when it is. */
function allowBodyProblem(body: unknown): string | undefined {
  const expected = 'expected {"policy": <signed policy>, "document": <signed inbox document, for another machine>}: the page signs them in the browser';
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return expected;
  const record = body as Record<string, unknown>;
  const extra = Object.keys(record).find((k) => k !== 'policy' && k !== 'document');
  if (extra !== undefined) return `the field "${extra}" is not accepted: this route takes only the signed policy and its document, never a passphrase or a key (${expected})`;
  const signed = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { body?: unknown }).body === 'object' && (v as { body?: unknown }).body !== null && typeof (v as { signature?: unknown }).signature === 'string';
  if (!signed(record['policy'])) return `"policy" must be a signed policy ({ body, signature }); ${expected}`;
  if (record['document'] !== undefined && !signed(record['document'])) return `"document" must be a signed document ({ body, signature }); ${expected}`;
  return undefined;
}

interface Failure {
  status: number;
  kind: string;
  error: string;
}

function failureOf(err: unknown): Failure {
  if (err instanceof DaemonUnreachableError) return { status: 503, kind: 'daemon_unreachable', error: err.message };
  if (err instanceof DaemonAuthError) return { status: 502, kind: 'daemon_token_refused', error: err.message };
  // An older daemon does not know a command of this module: the fix is the update, not a retry.
  if (err instanceof DaemonCommandError && /Unknown command/.test(err.message)) return { status: 502, kind: 'daemon_error', error: `${err.message}: the daemon is older than this module, update it with \`machine cli update\` and restart it` };
  if (err instanceof DaemonCommandError) return { status: 502, kind: 'daemon_error', error: err.message };
  if (err instanceof RequestsAnswerError) return { status: 502, kind: 'daemon_error', error: err.message };
  if (err instanceof RelayNotConfiguredError) return { status: 503, kind: 'relay_not_configured', error: err.message };
  if (err instanceof RelayRequestError) return { status: 502, kind: 'relay_error', error: err.message };
  return { status: 500, kind: 'internal', error: err instanceof Error ? err.message : String(err) };
}

interface NotInitialized {
  initialized: false;
  message: string;
}

const isNotInitialized = (value: unknown): value is NotInitialized =>
  typeof value === 'object' && value !== null && (value as { initialized?: unknown }).initialized === false;

const notInitialized = (value: NotInitialized): Failure => ({ status: 409, kind: 'not_initialized', error: value.message });

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

function candidacyRow(view: CandidacyListView): CandidacyListView & { ageText: string; bindingText: string; statusText: string } {
  let bindingText = '';
  if (view.rebind) {
    const which = view.boundTokenLabel !== undefined ? `the token labelled "${view.boundTokenLabel}"` : 'another token (the relay did not say which)';
    bindingText = `The uuid is already bound to ${which}; approving replaces that binding.${view.bindingNote !== undefined ? ` Note: ${view.bindingNote}.` : ''}`;
  } else if (view.uuidBound === true) {
    bindingText = 'The uuid is already bound to the same token as this candidacy: a re-approval, nothing is rebound.';
  }
  const statusText = view.problems.length > 0
    ? `Cannot be approved: ${view.problems.join('; ')}`
    : view.rebind
      ? 'Warning: uuid already bound to a token'
      : 'Pending';
  return { ...view, ageText: ageText(view.ageSeconds), bindingText, statusText };
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
      const machines = machineRows(list);
      return reply.code(200).send({
        machines,
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

  // The remote section (decision 74): the page signs a `requests-list` document with the admin key IN THE BROWSER and posts it here; the
  // daemon forwards it to the peer, which checks the signature. This backend never sees the admin key or the passphrase. Sensitive (PIN
  // of app-core) because it makes this machine contact another one; the module header keeps stray posts out.
  ctx.registerRoute(
    'POST',
    '/requests/remote',
    async (req, reply) => {
      const refusal = checkModuleHeader(req);
      if (refusal !== undefined) return reply.code(refusal.status).send({ status: refusal.status, kind: 'module_header', error: refusal.error });
      const body = typeof req === 'object' && req !== null ? (req as { body?: unknown }).body : undefined;
      const { machine, request } = typeof body === 'object' && body !== null ? (body as { machine?: unknown; request?: unknown }) : {};
      if (typeof machine !== 'string' || machine.length === 0 || typeof request !== 'object' || request === null) {
        return reply.code(400).send({ status: 400, kind: 'bad_request', error: 'expected {"machine": "<name or uuid>", "request": <requests-list document signed with the admin key>}' });
      }
      try {
        const answer = (await callDaemon(configDir(), 'remoteRequests', REMOTE_TIMEOUT_MS, { peer: machine, request })) as { ok?: boolean; answer?: RequestsListAnswer; reason?: string; message?: string };
        if (answer.ok === true && answer.answer !== undefined) return reply.code(200).send(remoteRequestsPage(answer.answer, Math.floor(Date.now() / 1000)));
        const reason = typeof answer.reason === 'string' ? answer.reason : 'refused';
        return reply.code(REMOTE_STATUS[reason] ?? 502).send({ status: REMOTE_STATUS[reason] ?? 502, kind: reason, error: typeof answer.message === 'string' ? answer.message : 'the peer did not answer with a list' });
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
  const viaDaemon = async (req: unknown, reply: ReplyLike, command: string, payload: unknown | undefined, timeoutMs: number | undefined, ok: (result: unknown) => unknown = (r) => r): Promise<unknown> => {
    const refusal = checkModuleHeader(req);
    if (refusal !== undefined) return reply.code(refusal.status).send({ status: refusal.status, kind: 'module_header', error: refusal.error });
    try {
      const answer = (await callDaemon(configDir(), command, timeoutMs, payload)) as { ok?: unknown; reason?: unknown; message?: unknown };
      if (typeof answer === 'object' && answer !== null && answer.ok === false) {
        const reason = typeof answer.reason === 'string' ? answer.reason : 'refused';
        const status = ALLOW_STATUS[reason] ?? 502;
        return reply.code(status).send({ status, kind: reason, error: typeof answer.message === 'string' ? answer.message : `the daemon refused the ${command} command` });
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
    if (typeof machine !== 'string' || machine.length === 0) return reply.code(400).send({ status: 400, kind: 'bad_request', error: 'expected the machine (name, alias or uuid) in the path: /allow/<machine>' });
    return viaDaemon(req, reply, 'allowContext', { machine }, undefined);
  }, SENSITIVE);

  ctx.registerRoute('POST', '/allow', (req, reply) => {
    // The header first (a stray request learns nothing about the body rules), then the shape; viaDaemon checks the header again, which is cheap.
    const refusal = checkModuleHeader(req);
    if (refusal !== undefined) return reply.code(refusal.status).send({ status: refusal.status, kind: 'module_header', error: refusal.error });
    const body = typeof req === 'object' && req !== null ? (req as { body?: unknown }).body : undefined;
    const problem = allowBodyProblem(body);
    if (problem !== undefined) return reply.code(400).send({ status: 400, kind: 'bad_request', error: problem });
    const { policy, document } = body as { policy: unknown; document?: unknown };
    // Only these two fields go to the daemon, re-built here: nothing else of the request can travel with them.
    return viaDaemon(req, reply, 'submitPolicy', document === undefined ? { policy } : { policy, document }, ALLOW_TIMEOUT_MS);
  }, SENSITIVE);

  ctx.registerRoute('GET', '/candidacies', async (_req, reply) => {
    try {
      const views = await listCandidacies(configDir(), Math.floor(Date.now() / 1000));
      const candidacies = views.map(candidacyRow);
      // `count` is the field the tab indicator of the manifest reads.
      return reply.code(200).send({ candidacies, count: candidacies.length });
    } catch (err) {
      const failure = failureOf(err);
      return reply.code(failure.status).send(failure);
    }
  });
}
