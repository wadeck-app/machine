import type { ReadStream, WriteStream } from 'node:tty';

export interface PromptStreams {
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  output: NodeJS.WritableStream;
}

/**
 * Read one secret line from the terminal without echoing it. The ONLY way a passphrase enters the program: never an
 * argument, an environment variable or a pipe, which would leave it in a process list, a shell history or a log.
 */
export function promptHidden(label: string, streams: PromptStreams = { input: process.stdin as ReadStream, output: process.stdout as WriteStream }): Promise<string> {
  const { input, output } = streams;
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(new Error('a passphrase is only read from an interactive terminal: it is never taken from arguments, environment variables or pipes. Run this command in a terminal window'));
  }
  return new Promise((resolve, reject) => {
    let value = '';
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
      for (const ch of chunk.toString('utf8')) {
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
