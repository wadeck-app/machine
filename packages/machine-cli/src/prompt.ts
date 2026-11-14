import { StringDecoder } from 'node:string_decoder';
import type { ReadStream, WriteStream } from 'node:tty';

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
export function promptHidden(label: string, streams: PromptStreams = defaultStreams()): Promise<string> {
  const { input, output } = streams;
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

    const finish = (done: () => void) => {
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
export function promptLine(label: string, streams: PromptStreams = defaultStreams()): Promise<string> {
  const { input, output } = streams;
  if (!input.isTTY) return Promise.reject(new Error('no interactive terminal to ask the question'));
  return new Promise((resolve, reject) => {
    output.write(label);
    input.resume();
    let value = '';
    const decoder = new StringDecoder('utf8');
    const finish = (done: () => void) => {
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
