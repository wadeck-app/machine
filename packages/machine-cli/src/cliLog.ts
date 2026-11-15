import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** What ends in the log: the status lines a command prints. Anything else (the passphrase generated once, tables, codes) stays out. */
const STATUS_LINE = /^\[(ok|warn|warning|fail|info)\]/;
/** Pairing codes (8 digits) and security codes (25 digits) are never written, whatever the argument. */
const CODE = /\b\d{8}\b|\b\d{25}\b/g;

export function redact(text: string): string {
  return text.replace(CODE, '<code>');
}

export interface CliLog {
  /** One log line per status line of the text, as it is printed. */
  output: (text: string) => void;
  finish: (exitCode: number) => void;
}

/**
 * The trace of one command in `<configDir>/logs/<day>.ndjson`, the file `machine cli logs` shows. A log that cannot be written
 * is said once on stderr (the command still runs): a missing trace must never be a surprise when something has to be diagnosed.
 */
export function openCliLog(configDir: string, args: string[], warn: (text: string) => void, now: () => number = Date.now): CliLog {
  const started = now();
  let warned = false;
  const write = (msg: string): void => {
    try {
      const day = new Date(now()).toISOString().slice(0, 10);
      mkdirSync(join(configDir, 'logs'), { recursive: true });
      appendFileSync(join(configDir, 'logs', `${day}.ndjson`), `${JSON.stringify({ ts: new Date(now()).toISOString(), level: 'info', msg })}\n`);
    } catch (e) {
      if (!warned) {
        warned = true;
        warn(`[warn] cannot write the command log in ${join(configDir, 'logs')}: ${(e as Error).message}\n`);
      }
    }
  };
  write(redact(`cmd: ${args.join(' ')}`));
  return {
    output: (text) => {
      for (const line of text.split('\n')) if (STATUS_LINE.test(line)) write(redact(line));
    },
    finish: (exitCode) => write(`exit ${exitCode} after ${now() - started} ms`),
  };
}
