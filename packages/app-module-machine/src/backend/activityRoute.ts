import { ACTIVITY_DEFAULT_PAGE_SIZE } from '@wadeck-app/machine-core';
import { activityPage, activityQueryOf, ActivityAnswerError, ActivityQueryError } from './activity.js';
import { callDaemon, DaemonAuthError, DaemonCommandError, DaemonUnreachableError } from './daemonClient.js';
import { errorBody } from './errorBody.js';

// `GET /activity` (run-log.md): the Activity page. A plain read route (no PIN, no header): it exposes only metadata this machine already holds
// (the commands it sent and received, as typed). The filters are the query string; the daemon validates them and answers a sentence that names the fix.

interface ReplyLike {
  code(status: number): ReplyLike;
  send(body: unknown): unknown;
}

interface RouteContext {
  registerRoute(method: string, subPath: string, handler: (req: unknown, reply: ReplyLike) => unknown): void;
}

interface Failure {
  status: number;
  kind: string;
  error: string;
  message: string;
}

function failureOf(err: unknown): Failure {
  if (err instanceof ActivityQueryError) {
    return errorBody(400, 'bad_query', err.message);
  }
  if (err instanceof DaemonUnreachableError) {
    return errorBody(503, 'daemon_unreachable', err.message);
  }
  if (err instanceof DaemonAuthError) {
    return errorBody(502, 'daemon_token_refused', err.message);
  }
  // An older daemon does not know the command: the fix is the update, not a retry.
  if (err instanceof DaemonCommandError && /Unknown command/.test(err.message)) {
    return errorBody(502, 'daemon_error', `${err.message}: the daemon is older than this module, update it with \`machine cli update\` and restart it`);
  }
  if (err instanceof DaemonCommandError || err instanceof ActivityAnswerError) {
    return errorBody(502, 'daemon_error', err.message);
  }
  return errorBody(500, 'internal', err instanceof Error ? err.message : String(err));
}

/** The HTTP status of a refusal of the daemon command (the reason is the `kind`, with `_` for `-`). */
const REFUSAL_STATUS: Record<string, number> = { 'bad-query': 400 };

export function registerActivityRoute(ctx: RouteContext, configDir: () => string): void {
  ctx.registerRoute('GET', '/activity', async (req, reply) => {
    try {
      const query = activityQueryOf(typeof req === 'object' && req !== null ? (req as { query?: unknown }).query : undefined);
      // A page never depends on the default of the daemon (50, the one of `machine log`): the size is always one of the page's choices.
      if (query['pageSize'] === undefined && query['limit'] === undefined) {
        query['pageSize'] = String(ACTIVITY_DEFAULT_PAGE_SIZE);
      }
      const answer = (await callDaemon(configDir(), 'activity', undefined, query)) as { initialized?: unknown; ok?: unknown; reason?: unknown; message?: unknown };
      if (typeof answer === 'object' && answer !== null && answer.initialized === false) {
        return reply.code(409).send(errorBody(409, 'not_initialized', String(answer.message ?? 'this machine is not initialized: run `machine setup <relay>`')));
      }
      if (typeof answer === 'object' && answer !== null && answer.ok === false) {
        const reason = typeof answer.reason === 'string' ? answer.reason : 'refused';
        const status = REFUSAL_STATUS[reason] ?? 500;
        return reply.code(status).send(errorBody(status, reason.replace(/-/g, '_'), typeof answer.message === 'string' ? answer.message : 'the daemon refused the activity command'));
      }
      return reply.code(200).send(activityPage(answer, Math.floor(Date.now() / 1000)));
    } catch (err) {
      const failure = failureOf(err);
      return reply.code(failure.status).send(failure);
    }
  });
}
