import { allowedPage, AllowedAnswerError } from './allowed.js';
import { callDaemon, DaemonAuthError, DaemonCommandError, DaemonUnreachableError } from './daemonClient.js';

// `GET /allowed`: the Allowed page. A plain read route (no PIN, no header): it exposes the allow lists this machine already holds, as text.
// No network call, no key, no signature, nothing written: the daemon reads local files only.

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
}

function failureOf(err: unknown): Failure {
  if (err instanceof DaemonUnreachableError) {
    return { status: 503, kind: 'daemon_unreachable', error: err.message };
  }
  if (err instanceof DaemonAuthError) {
    return { status: 502, kind: 'daemon_token_refused', error: err.message };
  }
  // An older daemon does not know the command: the fix is the update, not a retry.
  if (err instanceof DaemonCommandError && /Unknown command/.test(err.message)) {
    return { status: 502, kind: 'daemon_error', error: `${err.message}: the daemon is older than this module, update it with \`machine cli update\` and restart it` };
  }
  if (err instanceof DaemonCommandError || err instanceof AllowedAnswerError) {
    return { status: 502, kind: 'daemon_error', error: err.message };
  }
  return { status: 500, kind: 'internal', error: err instanceof Error ? err.message : String(err) };
}

export function registerAllowedRoute(ctx: RouteContext, configDir: () => string): void {
  ctx.registerRoute('GET', '/allowed', async (_req, reply) => {
    try {
      const answer = (await callDaemon(configDir(), 'allowed')) as { initialized?: unknown; message?: unknown };
      if (typeof answer === 'object' && answer !== null && answer.initialized === false) {
        return reply.code(409).send({ status: 409, kind: 'not_initialized', error: String(answer.message ?? 'this machine is not initialized: run `machine setup <relay>`') });
      }
      return reply.code(200).send(allowedPage(answer, Math.floor(Date.now() / 1000)));
    } catch (err) {
      const failure = failureOf(err);
      return reply.code(failure.status).send(failure);
    }
  });
}
