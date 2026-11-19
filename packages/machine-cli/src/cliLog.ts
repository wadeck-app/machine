import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** What ends in the log: the status lines a command prints. Anything else (the passphrase generated once, tables, codes) stays out. */
const STATUS_LINE = /^\[(ok|warn|warning|fail|info)\]/;
/**
 * Never written, whatever the argument: pairing codes (8 digits), security codes (25 digits, plain or in five groups of five),
 * relay login codes (XXXX-XXXX, not a part of a longer dashed word such as a UUID).
 */
const CODE = /\b\d{5}( \d{5}){4}\b|\b\d{8}\b|\b\d{25}\b|(?<![A-Za-z0-9-])[A-Z0-9]{4}-[A-Z0-9]{4}(?![A-Za-z0-9-])/g;
/** Flags whose value may hold a secret or free text: the value is never logged. */
const SECRET_VALUE_FLAGS = new Set(['--hint', '--passphrase', '--secret-from']);
/** Logs older than this many days are deleted when a command opens the log. */
const KEEP_DAYS = 30;
const LOG_FILE = /^\d{4}-\d{2}-\d{2}\.ndjson$/;

export function redact(text: string): string {
  return text.replace(CODE, '<code>');
}

/** Control characters (ESC, CR, newlines, other C0, DEL, C1) become a space: a message cannot forge a log line or drive the terminal. */
export function stripControl(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

/** The command line as logged: everything after `--` and the value of the flags that may hold a secret are replaced by <redacted>. */
export function commandForLog(args: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--') {
      out.push('--', '<redacted>');
      break;
    }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    if (SECRET_VALUE_FLAGS.has(name)) {
      out.push(name, '<redacted>');
      if (eq === -1 && i + 1 < args.length && args[i + 1] !== '--') i++;
    } else out.push(a);
  }
  return redact(out.join(' '));
}

/** Best effort, never fatal: deletes the `<day>.ndjson` files older than KEEP_DAYS days. */
function rotate(folder: string, nowMs: number): void {
  try {
    for (const f of readdirSync(folder)) {
      if (!LOG_FILE.test(f)) continue;
      try {
        if (nowMs - statSync(join(folder, f)).mtimeMs > KEEP_DAYS * 86_400_000) unlinkSync(join(folder, f));
      } catch {
        // one file that cannot be removed does not matter
      }
    }
  } catch {
    // no folder yet, or unreadable: nothing to rotate
  }
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
      appendFileSync(join(configDir, 'logs', `${day}.ndjson`), `${JSON.stringify({ ts: new Date(now()).toISOString(), level: 'info', msg: stripControl(msg) })}\n`);
    } catch (e) {
      if (!warned) {
        warned = true;
        warn(`[warn] cannot write the command log in ${join(configDir, 'logs')}: ${(e as Error).message}\n`);
      }
    }
  };
  rotate(join(configDir, 'logs'), started);
  write(`cmd: ${commandForLog(args)}`);
  return {
    output: (text) => {
      for (const line of text.split('\n')) if (STATUS_LINE.test(line)) write(redact(line));
    },
    finish: (exitCode) => write(`exit ${exitCode} after ${now() - started} ms`),
  };
}
