// `machine run --json` (decision 114, D5): EVERY outcome prints exactly ONE JSON document on stdout, a result as well as a refusal, an unreachable peer, an
// unknown machine or a usage error. The exit code of the process is unchanged (the remote code, 255 for a failure of machine). Pure, no I/O.
//
// `code` is a CONTRACT with scripts (task-owner): stable strings, never renamed or removed once released; a new case adds a string at the end.

export const RUN_CODES = [
  'ok',
  'refused:not-allowed',
  'refused:input-not-allowed',
  'refused:input-too-large',
  'refused:input-chars',
  'refused:input-format',
  'refused:other',
  'unreachable',
  'timeout',
  'denied',
  'target-too-old',
  'unknown-machine',
  'usage',
  'failed',
] as const;
export type RunCode = (typeof RUN_CODES)[number];

/** What the peer sent back for a command that ran. */
export interface ResultAnswer {
  type: 'result';
  id: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  outputNotUtf8: boolean;
  decodedFrom?: string;
  durationMs: number;
}

/** What the peer sent back for a command it refused. */
export interface RefusedAnswer {
  type: 'refused';
  id?: string;
  reason: string;
  message: string;
}

/** The keys every failure document has, whatever the cause: the shape of a result without a command behind it. */
interface FailureShape {
  code: RunCode;
  message: string;
  exitCode: null;
  stdout: '';
  stderr: '';
  timedOut: false;
  truncated: false;
}

export type ResultDocument = ResultAnswer & { code: RunCode; message: string };
export type RefusalDocument = FailureShape & { type: 'refused'; id?: string; reason: string };
export type ErrorDocument = FailureShape & { type: 'error' };
export type RunDocument = ResultDocument | RefusalDocument | ErrorDocument;

const NOT_ALLOWED = ['not-listed', 'no-policy', 'expired', 'exhausted'];

/** The code of a refusal of the target. `sentInput`: this run sent a payload. */
function refusalCode(reason: string, sentInput: boolean): RunCode {
  if (NOT_ALLOWED.includes(reason)) return 'refused:not-allowed';
  switch (reason) {
    case 'input-not-allowed':
      return 'refused:input-not-allowed';
    case 'input-too-large':
      return 'refused:input-too-large';
    case 'input-chars':
      return 'refused:input-chars';
    case 'input-format':
      return 'refused:input-format';
    case 'denied':
      return 'denied';
    // An older target reads the signed body of a request with an input as malformed: it never ignores an input (fail closed), the caller says it is too old.
    case 'malformed':
      return sentInput ? 'target-too-old' : 'refused:other';
    default:
      return 'refused:other';
  }
}

/** A command that ran: the peer's answer as is, plus the code and a sentence. The exit code of the command is NOT a code: it stays in `exitCode`. */
export function resultDocument(answer: ResultAnswer): ResultDocument {
  const code: RunCode = answer.timedOut ? 'timeout' : 'ok';
  const message = answer.timedOut
    ? 'the command was stopped: it exceeded the time limit of the peer'
    : answer.truncated
      ? 'the command was stopped: its output exceeded the limit of the peer'
      : `the command ran and exited with code ${answer.exitCode === null ? 'none' : answer.exitCode}`;
  return { ...answer, code, message };
}

/** A refusal of the target. `message` is the human sentence printed on stderr (cause and fix). */
export function refusalDocument(answer: RefusedAnswer, message: string, context: { sentInput: boolean }): RefusalDocument {
  return {
    type: 'refused',
    code: refusalCode(answer.reason, context.sentInput),
    message,
    ...(answer.id !== undefined ? { id: answer.id } : {}),
    reason: answer.reason,
    exitCode: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    truncated: false,
  };
}

/** Anything that is neither a result nor a refusal: no connection, unknown machine, usage error, a failure of machine. */
export function failureDocument(code: RunCode, message: string): ErrorDocument {
  return { type: 'error', code, message, exitCode: null, stdout: '', stderr: '', timedOut: false, truncated: false };
}

/** A thrown error to a code. `unreachable`: the caller knows from the type of the error (no address, no connection, the wake could not help). */
export function classifyRunFailure(error: { message: string; unreachable?: boolean }): RunCode {
  if (error.message.startsWith('no answer from the peer within')) return 'timeout';
  return error.unreachable === true ? 'unreachable' : 'failed';
}
