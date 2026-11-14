import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import type { Shell } from '@wadeck-app/machine-core';
import { launchSpec, scrubEnv } from './launch.js';

export interface RunOptions {
  shell: Shell;
  command: string;
  timeoutMs: number;
  /** Applied to stdout and to stderr separately. */
  maxOutputBytes: number;
  /** Environment to scrub; defaults to this process's. */
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export interface RunResult {
  /** null when the command was killed (timeout, output cap). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  /** The output was not valid UTF-8 (for example an OEM code page on Windows) and was decoded lossily. */
  outputNotUtf8: boolean;
  durationMs: number;
}

function decode(chunks: Buffer[]): { text: string; lossy: boolean } {
  const bytes = Buffer.concat(chunks);
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), lossy: false };
  } catch {
    return { text: bytes.toString('utf8'), lossy: true };
  }
}

function killTree(pid: number, env: Record<string, string | undefined>, fallback: () => void): void {
  if (process.platform === 'win32') {
    const root = env.SystemRoot;
    if (!root) return fallback();
    // /T ends the whole tree: a timed-out `cmd` must not leave its children (ping, for loops) running.
    spawn(`${root}\\System32\\taskkill.exe`, ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true }).on('error', fallback);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    fallback();
  }
}

export async function runCommand(options: RunOptions): Promise<RunResult> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error(`timeoutMs must be a positive integer, got ${options.timeoutMs}`);
  if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0) throw new Error(`maxOutputBytes must be a positive integer, got ${options.maxOutputBytes}`);
  const sourceEnv = options.env ?? process.env;
  const spec = launchSpec(options.shell, options.command, process.platform, sourceEnv);
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(spec.file, spec.args, {
      env: scrubEnv(sourceEnv, process.platform),
      cwd: options.cwd ?? homedir(),
      // No stdin: a command that waits for input gets end-of-file instead of hanging.
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
      windowsHide: true,
      // Unix: own process group, so the whole group can be ended.
      detached: process.platform !== 'win32',
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let truncated = false;
    const stop = () => {
      if (child.pid !== undefined) killTree(child.pid, sourceEnv, () => child.kill('SIGKILL'));
    };
    const keep = (chunk: Buffer, store: Buffer[], used: number): number => {
      const room = options.maxOutputBytes - used;
      if (chunk.length > room) {
        if (room > 0) store.push(chunk.subarray(0, room));
        if (!truncated) {
          truncated = true;
          stop();
        }
        return options.maxOutputBytes;
      }
      store.push(chunk);
      return used + chunk.length;
    };
    child.stdout.on('data', (c: Buffer) => (outBytes = keep(c, out, outBytes)));
    child.stderr.on('data', (c: Buffer) => (errBytes = keep(c, err, errBytes)));
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const hint = e.code === 'ENOENT' ? `: "${spec.file}" is not installed or not on PATH on this machine; install it or remove the policy entries that use shell "${options.shell}"` : '';
      reject(new Error(`cannot start shell "${options.shell}" (${e.message})${hint}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const o = decode(out);
      const e = decode(err);
      resolve({
        exitCode: timedOut || truncated ? null : code,
        stdout: o.text,
        stderr: e.text,
        timedOut,
        truncated,
        outputNotUtf8: o.lossy || e.lossy,
        durationMs: Date.now() - started,
      });
    });
  });
}
