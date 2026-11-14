// violations-suppress: ts/no-barrel-index app-core requires the backend entry of an app-module to be src/backend/index.ts (app-core-cli check)
import { listCandidacies, RelayNotConfiguredError, RelayRequestError, type CandidacyListView } from './candidacies.js';
import { resolveModuleConfigDir } from './configDir.js';
import { callDaemon, DaemonAuthError, DaemonCommandError, DaemonUnreachableError } from './daemonClient.js';

// Backend of the machine module. Slice 1: read-only routes only. No route here signs, spends the relay token or changes
// anything (decision D25: signing happens in the browser). Local-API limit, stated honestly: app-core checks only Host and
// Origin, so ANY local process can call these routes as the user; they hand out what that process could read from the files
// of the same user anyway. `guard.ts` (x-machine-module) is for the routes of the later slices that sign or spend the token.

/** The minimal part of the app-core ModuleContext this module uses (the SDK package is not a dependency of this slice). */
export interface ModuleContextLike {
  registerRoute(method: string, subPath: string, handler: (req: unknown, reply: ReplyLike) => unknown): void;
}

export interface ReplyLike {
  code(status: number): ReplyLike;
  send(body: unknown): unknown;
}

interface Failure {
  status: number;
  kind: string;
  error: string;
}

function failureOf(err: unknown): Failure {
  if (err instanceof DaemonUnreachableError) return { status: 503, kind: 'daemon_unreachable', error: err.message };
  if (err instanceof DaemonAuthError) return { status: 502, kind: 'daemon_token_refused', error: err.message };
  if (err instanceof DaemonCommandError) return { status: 502, kind: 'daemon_error', error: err.message };
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

const ageText = (seconds: number): string => (seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`);

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
