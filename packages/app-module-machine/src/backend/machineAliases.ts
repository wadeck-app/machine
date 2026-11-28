import { callDaemon } from './daemonClient.js';
import { errorBody, type ErrorBody } from './errorBody.js';
import { checkModuleHeader } from './guard.js';

// Network aliases from the page (decision 116, admin-ui.md, threat-model.md "Rename and network aliases from the page"). The admin passphrase and the unlocked key exist
// ONLY in the browser: it signs the new list and the documents for the machines. These routes carry what is already signed and sealed; they sign nothing and see no
// passphrase. `sensitive` (app-core PIN: it changes what a reference means on every machine and spends the relay admin token) and they need the module header (the page
// component sends it; a DSL action could not).

interface ReplyLike {
  code(status: number): ReplyLike;
  send(body: unknown): unknown;
}

interface RouteContext {
  registerRoute(method: string, subPath: string, handler: (req: unknown, reply: ReplyLike) => unknown, options?: { effect: 'read' | 'write' | 'sensitive' }): void;
}

export interface AliasesDeps {
  configDir: () => string;
  /** The mapping of the module to an error answer (daemon unreachable, ...). */
  failureOf: (err: unknown) => ErrorBody;
}

// Delivery tries each machine directly first (a few seconds each when it is asleep) then the relay inbox.
const APPLY_TIMEOUT_MS = 90_000;
// A document is at most 16 KiB; far above what a network of a few machines needs, far below an abusive body.
const MAX_BODY_BYTES = 1024 * 1024;
const APPLY_RULE = 'expected exactly {"signed": <signed aliases list>, "documents": [<signed inbox document>...]}, nothing else: reload the page and change the aliases again';

/** The HTTP status of a refusal of the daemon commands `aliasesContext` and `aliasesApply` (anything not listed is 502). */
const ALIASES_STATUS: Record<string, number> = {
  'bad-payload': 400,
  'no-admin-key': 409,
  'not-initialized': 409,
  'aliases-invalid': 409,
  'stale-aliases': 409,
  refused: 409,
  'bad-aliases': 422,
  'bad-document': 422,
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function parseApply(body: unknown): { signed: Record<string, unknown>; documents: unknown[] } | string {
  if (!isObject(body) || Object.keys(body).length !== 2 || !('signed' in body) || !('documents' in body)) return APPLY_RULE;
  const { signed, documents } = body;
  if (!isObject(signed)) return `"signed" must be the signed aliases list: ${APPLY_RULE}`;
  if (!Array.isArray(documents) || !documents.every(isObject)) return `"documents" must be a list of signed documents: ${APPLY_RULE}`;
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) return 'the documents are too large (more than 1 MiB for one change): nothing was installed or delivered. Change the aliases from the terminal instead (`machine admin alias set|rm`)';
  return { signed, documents };
}

export function registerAliasesRoutes(ctx: RouteContext, deps: AliasesDeps): void {
  const SENSITIVE = { effect: 'sensitive' } as const;

  const daemon = async (command: string, payload: unknown, timeoutMs?: number): Promise<{ ok: true; answer: Record<string, unknown> } | { ok: false; failure: ErrorBody }> => {
    const answer = (await callDaemon(deps.configDir(), command, timeoutMs, payload)) as Record<string, unknown>;
    if (isObject(answer) && answer['ok'] === false) {
      const reason = typeof answer['reason'] === 'string' ? answer['reason'] : 'refused';
      const status = ALIASES_STATUS[reason] ?? 502;
      return { ok: false, failure: errorBody(status, reason, typeof answer['message'] === 'string' ? answer['message'] : `the daemon refused the ${command} command`) };
    }
    return { ok: true, answer };
  };

  ctx.registerRoute('GET', '/aliases-context', async (req, reply) => {
    const refusal = checkModuleHeader(req);
    if (refusal !== undefined) return reply.code(refusal.status).send(errorBody(refusal.status, 'module_header', refusal.error));
    try {
      const out = await daemon('aliasesContext', {});
      return out.ok ? reply.code(200).send(out.answer) : reply.code(out.failure.status).send(out.failure);
    } catch (err) {
      const failure = deps.failureOf(err);
      return reply.code(failure.status).send(failure);
    }
  }, SENSITIVE);

  // The page signed the list and the documents with the key it unlocked for this one change. They are signed and sealed: this route cannot read, change or sign them,
  // it hands them to the daemon of the admin machine, which verifies them against the pinned key and the change it plans itself, installs, then delivers.
  ctx.registerRoute('POST', '/aliases', async (req, reply) => {
    const refusal = checkModuleHeader(req);
    if (refusal !== undefined) return reply.code(refusal.status).send(errorBody(refusal.status, 'module_header', refusal.error));
    const parsed = parseApply(isObject(req) ? req['body'] : undefined);
    if (typeof parsed === 'string') return reply.code(400).send(errorBody(400, 'bad_request', parsed));
    try {
      const out = await daemon('aliasesApply', parsed, APPLY_TIMEOUT_MS);
      return out.ok ? reply.code(200).send(out.answer) : reply.code(out.failure.status).send(out.failure);
    } catch (err) {
      const failure = deps.failureOf(err);
      return reply.code(failure.status).send(failure);
    }
  }, SENSITIVE);
}
