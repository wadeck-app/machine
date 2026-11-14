import { StringDecoder } from 'node:string_decoder';
import type { ReadStream, WriteStream } from 'node:tty';

// Every step that waits for a human has a limit (security: a stale prompt must not be answerable later, by a person who
// came back or by a replayed terminal). Reaching it is an error that names the prompt, never an implicit answer.
export const DEFAULT_PROMPT_TIMEOUT_SECONDS = 120;
export const MAX_PROMPT_TIMEOUT_SECONDS = 3600;

/** Injected in tests so that a 120 s limit takes no time. */
export interface PromptTimer {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}
export const realPromptTimer: PromptTimer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface PromptLimits {
  timeoutSeconds: number;
  timer?: PromptTimer;
}

/** The person did not answer in time: the prompt was cancelled and nothing was done with it. */
export class PromptTimeoutError extends Error {
  constructor(
    readonly promptLabel: string,
    readonly seconds: number,
  ) {
    super(`no answer to the prompt "${promptLabel.trim()}" within ${seconds} s: it was cancelled and no answer was assumed`);
  }
}

/**
 * Add the limit to a prompt that cannot cancel itself (an injected one). A value that arrives after the limit is
 * dropped, never used.
 */
export function withPromptTimeout(ask: (label: string) => Promise<string>, limits: PromptLimits): (label: string) => Promise<string> {
  const timer = limits.timer ?? realPromptTimer;
  return (label) =>
    new Promise<string>((resolve, reject) => {
      let settled = false;
      const handle = timer.set(() => {
        if (settled) return;
        settled = true;
        reject(new PromptTimeoutError(label, limits.timeoutSeconds));
      }, limits.timeoutSeconds * 1000);
      ask(label).then(
        (value) => {
          if (settled) return;
          settled = true;
          timer.clear(handle);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          timer.clear(handle);
          reject(error);
        },
      );
    });
}

export interface PromptStreams {
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  output: NodeJS.WritableStream;
}

// The prompt goes to stderr: stdout may be redirected to a file that must stay clean (signed documents).
function defaultStreams(): PromptStreams {
  return { input: process.stdin as ReadStream, output: process.stderr as WriteStream };
}

/**
 * Read one secret line from the terminal without echoing it. The ONLY way a passphrase enters the program: never an
 * argument, an environment variable or a pipe, which would leave it in a process list, a shell history or a log.
 */
export function promptHidden(label: string, streams: PromptStreams = defaultStreams(), limits: PromptLimits = { timeoutSeconds: DEFAULT_PROMPT_TIMEOUT_SECONDS }): Promise<string> {
  const { input, output } = streams;
  const timer = limits.timer ?? realPromptTimer;
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(new Error('a passphrase is only read from an interactive terminal: it is never taken from arguments, environment variables or pipes. Run this command in a terminal window'));
  }
  return new Promise((resolve, reject) => {
    let value = '';
    // A multibyte character can arrive split across two chunks (paste, Windows console).
    const decoder = new StringDecoder('utf8');
    output.write(label);
    input.setRawMode?.(true);
    input.resume();
    // On the limit the typed characters are dropped with the buffer and the terminal is given back.
    const handle = timer.set(() => {
      value = '';
      finish(() => reject(new PromptTimeoutError(label, limits.timeoutSeconds)));
    }, limits.timeoutSeconds * 1000);

    const finish = (done: () => void) => {
      timer.clear(handle);
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.setRawMode?.(false);
      input.pause();
      output.write('\n');
      done();
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of typeof chunk === 'string' ? chunk : decoder.write(chunk)) {
        if (ch === '\r' || ch === '\n') return finish(() => resolve(value));
        if (ch === '\u0003') return finish(() => reject(new Error('cancelled: no passphrase was entered')));
        if (ch === '\u007f' || ch === '\b') value = Array.from(value).slice(0, -1).join('');
        else if (ch >= ' ') value += ch;
      }
    };
    const onEnd = () => finish(() => reject(new Error('the terminal input ended before Enter was pressed')));
    input.on('data', onData);
    input.on('end', onEnd);
  });
}

/** One visible line from the terminal (for a y/N question). Rejects without a terminal: an answer is never read from a pipe. */
export function promptLine(label: string, streams: PromptStreams = defaultStreams(), limits: PromptLimits = { timeoutSeconds: DEFAULT_PROMPT_TIMEOUT_SECONDS }): Promise<string> {
  const { input, output } = streams;
  const timer = limits.timer ?? realPromptTimer;
  if (!input.isTTY) return Promise.reject(new Error('no interactive terminal to ask the question'));
  return new Promise((resolve, reject) => {
    output.write(label);
    input.resume();
    let value = '';
    const decoder = new StringDecoder('utf8');
    const handle = timer.set(() => finish(() => reject(new PromptTimeoutError(label, limits.timeoutSeconds))), limits.timeoutSeconds * 1000);
    const finish = (done: () => void) => {
      timer.clear(handle);
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.pause();
      done();
    };
    const onData = (chunk: Buffer | string) => {
      value += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      const nl = value.search(/[\r\n]/);
      if (nl !== -1) finish(() => resolve(value.slice(0, nl)));
    };
    const onEnd = () => finish(() => reject(new Error('the terminal input ended before Enter was pressed')));
    input.on('data', onData);
    input.on('end', onEnd);
  });
}
