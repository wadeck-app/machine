import { callDaemon } from './daemonClient.js';
import { errorBody, type ErrorBody } from './errorBody.js';
import { checkModuleHeader } from './guard.js';

// Rename from the page (admin-ui.md, threat-model.md "Rename and network aliases from the page"). The admin passphrase and the unlocked key exist ONLY in the browser: it
// signs the re-issued registration of the machine and the documents that carry it. These routes carry what is already signed and sealed; they sign nothing and see no
// passphrase. `sensitive` (app-core PIN: it changes the name this machine trusts a machine under and spends the relay admin token) and they need the module header
// (the page component sends it; a DSL action could not).

interface ReplyLike {
  code(status: number): ReplyLike;
  send(body: unknown): unknown;
}

interface RouteContext {
  registerRoute(method: string, subPath: string, handler: (req: unknown, reply: ReplyLike) => unknown, options?: { effect: 'read' | 'write' | 'sensitive' }): void;
}

export interface RenameDeps {
  configDir: () => string;
  /** The mapping of the module to an error answer (daemon unreachable, ...). */
  failureOf: (err: unknown) => ErrorBody;
}

// Delivery tries each machine directly first (a few seconds each when it is asleep) then the relay inbox.
const APPLY_TIMEOUT_MS = 90_000;
// A document is at most 16 KiB; far above what a network of a few machines needs, far below an abusive body.
const MAX_BODY_BYTES = 1024 * 1024;
const APPLY_RULE = 'expected exactly {"uuid": "<uuid>", "signed": <re-issued signed registration>, "documents": [<signed inbox document>...], "noticeRecipients": <signed list, or null>}, nothing else: reload the page and rename again';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The HTTP status of a refusal of the daemon commands `renameContext` and `renameApply` (anything not listed is 502). */
const RENAME_STATUS: Record<string, number> = {
  'bad-payload': 400,
  'no-admin-key': 409,
  'not-initialized': 409,
  self: 409,
  'not-trusted': 409,
  revoked: 409,
  'notice-recipients-invalid': 409,
  'stale-notice-recipients': 409,
  'aliases-invalid': 409,
  refused: 409,
  'bad-registration': 422,
  'bad-document': 422,
  'bad-notice-recipients': 422,
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function parseApply(body: unknown): { uuid: string; signed: Record<string, unknown>; documents: unknown[]; noticeRecipients: unknown } | string {
  if (!isObject(body) || Object.keys(body).length !== 4 || !('uuid' in body) || !('signed' in body) || !('documents' in body) || !('noticeRecipients' in body)) return APPLY_RULE;
  const { uuid, signed, documents, noticeRecipients } = body;
  if (typeof uuid !== 'string' || !UUID.test(uuid)) return `"uuid" is not the uuid of the machine to rename: ${APPLY_RULE}`;
  if (!isObject(signed)) return `"signed" must be the signed registration: ${APPLY_RULE}`;
  if (!Array.isArray(documents) || !documents.every(isObject)) return `"documents" must be a list of signed documents: ${APPLY_RULE}`;
  if (noticeRecipients !== null && !isObject(noticeRecipients)) return `"noticeRecipients" must be a signed list or null: ${APPLY_RULE}`;
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) return 'the documents are too large (more than 1 MiB for one rename): nothing was installed or delivered. Rename from the terminal instead (`machine admin rename <machine> <new-name>`)';
  return { uuid, signed, documents, noticeRecipients };
}

export function registerRenameRoutes(ctx: RouteContext, deps: RenameDeps): void {
  const SENSITIVE = { effect: 'sensitive' } as const;

  const daemon = async (command: string, payload: unknown, timeoutMs?: number): Promise<{ ok: true; answer: Record<string, unknown> } | { ok: false; failure: ErrorBody }> => {
    const answer = (await callDaemon(deps.configDir(), command, timeoutMs, payload)) as Record<string, unknown>;
    if (isObject(answer) && answer['ok'] === false) {
      const reason = typeof answer['reason'] === 'string' ? answer['reason'] : 'refused';
      const status = RENAME_STATUS[reason] ?? 502;
      return { ok: false, failure: errorBody(status, reason, typeof answer['message'] === 'string' ? answer['message'] : `the daemon refused the ${command} command`) };
    }
    return { ok: true, answer };
  };

  ctx.registerRoute('GET', '/rename-context/:uuid', async (req, reply) => {
    const refusal = checkModuleHeader(req);
    if (refusal !== undefined) return reply.code(refusal.status).send(errorBody(refusal.status, 'module_header', refusal.error));
    const uuid = isObject(req) && isObject(req['params']) ? req['params']['uuid'] : undefined;
    if (typeof uuid !== 'string' || !UUID.test(uuid)) return reply.code(400).send(errorBody(400, 'bad_request', 'expected the uuid of the machine to rename in the path: /rename-context/<uuid>'));
    try {
      const out = await daemon('renameContext', { uuid });
      return out.ok ? reply.code(200).send(out.answer) : reply.code(out.failure.status).send(out.failure);
    } catch (err) {
      const failure = deps.failureOf(err);
      return reply.code(failure.status).send(failure);
    }
  }, SENSITIVE);

  // The page signed the registration and the documents with the key it unlocked for this one rename. They are signed and sealed: this route cannot read, change or sign
  // them, it hands them to the daemon of the admin machine, which verifies them against the pinned key and the rename it plans itself, installs, then delivers.
  ctx.registerRoute('POST', '/rename', async (req, reply) => {
    const refusal = checkModuleHeader(req);
    if (refusal !== undefined) return reply.code(refusal.status).send(errorBody(refusal.status, 'module_header', refusal.error));
    const parsed = parseApply(isObject(req) ? req['body'] : undefined);
    if (typeof parsed === 'string') return reply.code(400).send(errorBody(400, 'bad_request', parsed));
    try {
      const out = await daemon('renameApply', parsed, APPLY_TIMEOUT_MS);
      return out.ok ? reply.code(200).send(out.answer) : reply.code(out.failure.status).send(out.failure);
    } catch (err) {
      const failure = deps.failureOf(err);
      return reply.code(failure.status).send(failure);
    }
  }, SENSITIVE);
}
