// A failed load of a page source (`$ctx.$sourceErrors.<source>`: { message, status? }) told by what it IS (admin-ui.md, "A failed source: three cases"). A failing source is not
// always an error and not always our bug, and a command is never the headline:
//   1. internal error (a bug of the module or of this page): the page says so and copies the details;
//   2. not configured (no admin relay token): a to-configure state, with a button that logs in from the page; where the page cannot act (a damaged token file, a machine
//      without identity) the command is folded in the details and copyable;
//   3. external (the relay does not answer): the cause, and Retry.
// `$sourceErrors` carries the message and the HTTP status only (not the `kind` of the backend body), so the decision reads both. The real messages of the backend are
// pinned by app-module-machine backend/failureKinds.test.ts: a reworded message fails there, never silently here.

/** A failed source as the page reads it (`$ctx.$sourceErrors.<source>`, dsl-renderer). */
export interface SourceError {
  message: string;
  status?: number;
}

export type FailureKind = 'not-configured' | 'setup-manual' | 'relay' | 'daemon-down' | 'daemon-old' | 'internal' | 'unexpected';

export interface FailureView {
  kind: FailureKind;
  /** `info`: to configure (not an error); `warning`: something to start; `danger`: an error. */
  tone: 'info' | 'warning' | 'danger';
  /** One sentence. Never a command to run. */
  headline: string;
  /** What to run in a terminal, one command per line; folded in the details, copyable. Absent when there is none. */
  command?: string;
  /** The page can log in to the relay (the admin token is missing). */
  canLogin: boolean;
  /** The whole message and the HTTP status. */
  details: string;
  /** What "Copy details" copies: the cause, the route and the status. */
  copyText: string;
}

/** The route each source of the module pages reads (the YAML `url` of the source; `viewSourceErrors.test.ts` keeps them equal). */
export const SOURCE_ROUTES: Record<string, string> = {
  candidacies: 'GET /api/modules/machine/candidacies',
  machines: 'GET /api/modules/machine/machines',
  requests: 'GET /api/modules/machine/requests',
  allowed: 'GET /api/modules/machine/allowed',
  activity: 'GET /api/modules/machine/activity',
};

/** What each source holds, as the object of "Could not load ...". */
export const SOURCE_SUBJECTS: Record<string, string> = {
  candidacies: 'the candidacies',
  machines: 'the machines',
  requests: 'the requests',
  allowed: 'the allow lists',
  activity: 'the activity',
};

/** The longest fix kept in the headline when the message holds no command. */
const SHORT_FIX = 160;

const capitalise = (s: string): string => (s === '' ? s : s[0]!.toUpperCase() + s.slice(1));
const endWithStop = (s: string): string => `${s.replace(/\.+$/, '')}.`;

/** Where the cause ends (the first ": " or " (" outside parentheses) and where the remainder starts (after the first ": " outside parentheses). */
function cut(message: string): { cause: string; remainder: string } {
  let depth = 0;
  let causeEnd = -1;
  for (let i = 0; i < message.length; i += 1) {
    const c = message[i];
    if (depth === 0 && c === ' ' && message[i + 1] === '(' && causeEnd < 0) {
      causeEnd = i;
    }
    if (c === '(') {
      depth += 1;
    } else if (c === ')') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && c === ':' && message[i + 1] === ' ') {
      return { cause: message.slice(0, causeEnd >= 0 ? causeEnd : i), remainder: message.slice(i + 2) };
    }
  }
  return { cause: causeEnd >= 0 ? message.slice(0, causeEnd) : message, remainder: '' };
}

/** The command the message gives AFTER its cause ("`a` then `b`" gives both, one per line); the first one otherwise. */
function commandOf(after: string): string | undefined {
  const pair = /`([^`]+)` then `([^`]+)`/.exec(after);
  if (pair !== null) return `${pair[1]}\n${pair[2]}`;
  return /`([^`]+)`/.exec(after)?.[1];
}

const NOT_CONFIGURED = /holds no admin relay token/;
// What the page cannot fix by itself: a damaged or refused token file, a relay URL that is not accepted, a machine without identity.
const SETUP_BY_HAND = /relay-admin\.json|the relay URL in |refusing to talk to the relay|the relay refused the admin token|is a plain machine token|has no identity yet/;
const DAEMON_OLD = /older than this module|probably an older version/;
const DAEMON_DOWN = /the machine daemon (is not running|does not answer)|health_token|daemon\.port\.json|the daemon refused the token/;
const RELAY = /^the relay\b|\brelay is unreachable\b/;
// 400 is not here: a bad query (a page past the end typed in the address) is the person's, and its sentence says how to fix it.
const INTERNAL_STATUS = new Set([404, 405, 422, 500]);

export function loadFailureView(subject: string, error: SourceError, source?: string): FailureView {
  const message = error.message.trim();
  const { cause, remainder } = cut(message);
  const cleanCause = endWithStop(cause.trim());
  const after = message.slice(cause.length);
  const details = error.status === undefined ? error.message : `HTTP ${error.status}: ${error.message}`;
  const route = source === undefined ? 'unknown (no source named)' : (SOURCE_ROUTES[source] ?? `unknown (source "${source}" is not one of the module sources)`);
  const copyText = [
    `Machine module: could not load ${subject}`,
    `Source: ${source ?? 'unknown'}`,
    `Route: ${route}`,
    `HTTP status: ${error.status ?? 'none'}`,
    `Message: ${error.message}`,
    `Time: ${new Date().toISOString()}`,
  ].join('\n');
  const base = { details, copyText, canLogin: false };
  const command = commandOf(after);
  const withCommand = command === undefined ? {} : { command };

  if (NOT_CONFIGURED.test(message)) {
    return { ...base, ...withCommand, kind: 'not-configured', tone: 'info', canLogin: true, headline: `To see ${subject}, this machine needs an admin relay token. It has none yet.` };
  }
  if (SETUP_BY_HAND.test(message)) {
    return { ...base, ...withCommand, kind: 'setup-manual', tone: 'info', headline: `Setup needed: ${cleanCause}` };
  }
  if (DAEMON_OLD.test(message)) {
    return { ...base, ...withCommand, kind: 'daemon-old', tone: 'warning', headline: `The machine daemon is older than this module, so ${subject} cannot be loaded.` };
  }
  if (DAEMON_DOWN.test(message)) {
    return { ...base, ...withCommand, kind: 'daemon-down', tone: 'warning', headline: `Could not reach the machine daemon, so ${subject} cannot be loaded.` };
  }
  if (RELAY.test(message)) {
    // The relay answered badly or not at all: the cause, and its short fix when the message gives one (never a command).
    const fix = remainder !== '' && remainder.length <= SHORT_FIX && commandOf(remainder) === undefined ? ` ${endWithStop(capitalise(remainder))}` : '';
    return { ...base, kind: 'relay', tone: 'danger', headline: `Could not load ${subject}: ${cleanCause}${fix}` };
  }
  const daemonFailed = error.status === 502 && /^the daemon /.test(message);
  if ((error.status !== undefined && INTERNAL_STATUS.has(error.status)) || daemonFailed) {
    return { ...base, kind: 'internal', tone: 'danger', headline: `Internal error: ${subject} could not be loaded because of a bug in this page or in the module (HTTP ${error.status}).` };
  }
  // Nothing recognised (no status: the page could not reach the app): said as it is, never presented as a bug.
  const fix = remainder !== '' && remainder.length <= SHORT_FIX ? ` ${endWithStop(capitalise(remainder))}` : '';
  return { ...base, ...withCommand, kind: 'unexpected', tone: 'danger', headline: `Could not load ${subject}: ${cleanCause}${fix}` };
}
