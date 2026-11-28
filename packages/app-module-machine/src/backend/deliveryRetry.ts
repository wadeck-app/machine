import { callDaemon } from './daemonClient.js';
import { errorBody, type ErrorBody } from './errorBody.js';
import { checkModuleHeader } from './guard.js';

// Retry delivery (admin-ui.md, "Result and progress UX"). After an approval or a revocation from the page some documents may not be stored. The daemon of the admin machine
// keeps the ones it verified, in memory only, and sends them again: this route carries only the uuid of the subject. No document, no passphrase, nothing signed.
// `sensitive` (app-core PIN: it spends the relay admin token) and the module header (the page component sends it; a DSL action could not).

interface ReplyLike {
  code(status: number): ReplyLike;
  send(body: unknown): unknown;
}

interface RouteContext {
  registerRoute(method: string, subPath: string, handler: (req: unknown, reply: ReplyLike) => unknown, options?: { effect: 'read' | 'write' | 'sensitive' }): void;
}

export interface DeliveryRetryDeps {
  configDir: () => string;
  /** The mapping of the module to an error answer (daemon unreachable, ...). */
  failureOf: (err: unknown) => ErrorBody;
}

// Delivery tries each machine directly first (a few seconds each when it is asleep) then the relay inbox.
const RETRY_TIMEOUT_MS = 90_000;
const RETRY_RULE = 'expected exactly {"uuid": "<uuid of the machine the approval or the revocation was about>"}, nothing else: reload the page and try again';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The HTTP status of a refusal of the daemon command `retryDelivery` (anything not listed is 502). */
const RETRY_STATUS: Record<string, number> = {
  'bad-payload': 400,
  'nothing-retained': 409,
  'no-admin-key': 409,
  'no-admin-token': 409,
  'not-initialized': 409,
  'bad-document': 422,
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function registerDeliveryRetryRoutes(ctx: RouteContext, deps: DeliveryRetryDeps): void {
  ctx.registerRoute('POST', '/delivery-retry', async (req, reply) => {
    const refusal = checkModuleHeader(req);
    if (refusal !== undefined) return reply.code(refusal.status).send(errorBody(refusal.status, 'module_header', refusal.error));
    const body = isObject(req) ? req['body'] : undefined;
    if (!isObject(body) || Object.keys(body).length !== 1 || typeof body['uuid'] !== 'string' || !UUID.test(body['uuid'])) {
      return reply.code(400).send(errorBody(400, 'bad_request', RETRY_RULE));
    }
    try {
      const answer = (await callDaemon(deps.configDir(), 'retryDelivery', RETRY_TIMEOUT_MS, { uuid: body['uuid'] })) as Record<string, unknown>;
      if (isObject(answer) && answer['ok'] === false) {
        const reason = typeof answer['reason'] === 'string' ? answer['reason'] : 'refused';
        const status = RETRY_STATUS[reason] ?? 502;
        return reply.code(status).send(errorBody(status, reason, typeof answer['message'] === 'string' ? answer['message'] : 'the daemon refused the retryDelivery command'));
      }
      return reply.code(200).send(answer);
    } catch (err) {
      const failure = deps.failureOf(err);
      return reply.code(failure.status).send(failure);
    }
  }, { effect: 'sensitive' });
}
