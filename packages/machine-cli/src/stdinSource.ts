import { readFileSync, statSync } from 'node:fs';
import { INPUT_MAX_BYTES_CEILING } from '@wadeck-app/machine-core';

// `machine run --stdin <file|->`: where the payload comes from. A file, or the standard input of THIS command (`-`). The payload is data: it is read here,
// sent in the frame, and never put on a command line, in an environment or in a log (R1, R4).

export interface StdinSourceIo {
  /** Tests inject the standard input; the default reads `process.stdin` up to one byte past the ceiling. */
  readStdin?: () => Promise<Buffer>;
  /** Tests inject it; the default is `process.stdin.isTTY`. */
  stdinIsTty?: boolean;
}

export type StdinRead = { ok: true; payload: Buffer } | { ok: false; kind: 'usage' | 'too-large'; message: string };

const CEILING_TEXT = `${INPUT_MAX_BYTES_CEILING / 1024} KiB`;
const tooLarge = (what: string, bytes: string): StdinRead => ({ ok: false, kind: 'too-large', message: `${what} is ${bytes}, above the ${CEILING_TEXT} that \`machine run\` can send on stdin (the hard ceiling of the protocol): send less. Nothing was sent` });

/** Reads at most one byte more than the ceiling: a stream of any size never fills the memory of this command. */
async function readProcessStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    chunks.push(buffer);
    size += buffer.length;
    if (size > INPUT_MAX_BYTES_CEILING) {
      break;
    }
  }
  return Buffer.concat(chunks);
}

export async function readStdinPayload(source: string, io: StdinSourceIo): Promise<StdinRead> {
  if (source === '') {
    return { ok: false, kind: 'usage', message: '--stdin needs a file, or - for the standard input: `machine run <machine> --stdin request.json -- <command>`' };
  }
  if (source === '-') {
    // A terminal has no payload to give: say so instead of waiting for typed input. An injected reader (tests) is never a terminal unless said.
    const tty = io.stdinIsTty ?? (io.readStdin === undefined && process.stdin.isTTY === true);
    if (tty) {
      return { ok: false, kind: 'usage', message: '--stdin - reads the standard input of this command, but it is a terminal: pipe the payload, for example `cat request.json | machine run <machine> --stdin - -- <command>`, or give a file with --stdin request.json. Nothing was sent' };
    }
    const payload = await (io.readStdin ?? readProcessStdin)();
    return payload.length > INPUT_MAX_BYTES_CEILING ? tooLarge('the standard input', `more than ${CEILING_TEXT}`) : { ok: true, payload };
  }
  let size: number;
  try {
    const stat = statSync(source);
    if (!stat.isFile()) {
      return { ok: false, kind: 'usage', message: `--stdin ${source}: it is not a file; give a file, or - for the standard input. Nothing was sent` };
    }
    size = stat.size;
  } catch (e) {
    return { ok: false, kind: 'usage', message: `--stdin ${source}: cannot read the file (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); check the path, or pipe the payload with --stdin -. Nothing was sent` };
  }
  if (size > INPUT_MAX_BYTES_CEILING) {
    return tooLarge(`the file ${source}`, `${size} bytes`);
  }
  try {
    return { ok: true, payload: readFileSync(source) };
  } catch (e) {
    return { ok: false, kind: 'usage', message: `--stdin ${source}: cannot read the file (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}). Nothing was sent` };
  }
}
