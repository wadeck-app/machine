// A failed load of a page source as ONE line above its table: the cause, then the exact command the message holds (or its fix when it is short). The whole message
// is folded under it (the notification of the shell says it too, but it is gone after a few seconds and the table would read as "nothing here").

/** A failed source as the page reads it (`$ctx.$sourceErrors.<source>`, dsl-renderer). */
export interface SourceError {
  message: string;
  status?: number;
}

/** The longest fix kept in the line when the message holds no command. */
const SHORT_FIX = 100;

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

/**
 * `what`: the sentence that names what could not be loaded ("Could not load the candidacies"). `label`: the line; `details`: the whole message and the HTTP status.
 */
export function loadFailureView(what: string, error: SourceError): { label: string; details: string } {
  const { cause, remainder } = cut(error.message.trim());
  const command = /`([^`]+)`/.exec(error.message)?.[1];
  const fix = command !== undefined ? `Run \`${command}\`.` : remainder !== '' && remainder.length <= SHORT_FIX ? endWithStop(capitalise(remainder)) : '';
  return {
    label: `${what}: ${endWithStop(cause.trim())}${fix === '' ? '' : ` ${fix}`}`,
    details: error.status === undefined ? error.message : `HTTP ${error.status}: ${error.message}`,
  };
}
