import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import type { Shell } from '@wadeck-app/machine-core';
import { defaultKeepAwakeWrapper, launchSpec, resolveOnPath, scrubEnv, windowsSystemRoot, withKeepAwake } from './launch.js';
import { detectOemCodePage } from './oemCodePage.js';
import { decodeOutput } from './outputDecode.js';

export interface RunOptions {
  shell: Shell;
  command: string;
  timeoutMs: number;
  /** Applied to stdout and to stderr separately. */
  maxOutputBytes: number;
  /** Environment to scrub; defaults to this process's. */
  env?: Record<string, string | undefined>;
  cwd?: string;
  /**
   * The payload of an entry that declares an input (stdin-input.md, R1): written to the stdin PIPE of the spawned process and the stream is ended; it is never
   * put on the command line or in the environment. Absent: stdin is closed as before (a command that waits for input gets end-of-file). An empty payload is an
   * empty stream. A command that does not read is not an error (EPIPE, or EOF on Windows, is ignored).
   */
  stdin?: Uint8Array;
  /** The OEM code page of the machine, used to decode output that is not UTF-8 (Windows cmd and ps only). Defaults to the registry value, read once. Tests inject it. */
  oemCodePage?: () => Promise<number | undefined>;
  /** Called once when the shell process exists (the spawn succeeded). It is never called when the launch fails. */
  onStarted?: () => void;
  /** Program that holds the Mac awake while the command runs (`caffeinate -s`, T-71). Defaults to `/usr/bin/caffeinate` on macOS and to none elsewhere; tests inject a fake. */
  keepAwakeWrapper?: string;
  /** macOS: finds a program by name before it is wrapped (`pwsh`). Defaults to a search of the PATH; tests inject it. */
  resolveProgram?: (name: string) => string | undefined;
  /** Windows: starts taskkill for the tree end. Defaults to `spawn`; tests inject a taskkill that fails or does nothing. */
  taskkill?: (file: string, args: string[]) => ChildProcess;
  /** After the end of the tree is requested, how long to wait for the output pipes to close before the run is ended anyway (a grandchild may hold them). Default 5000. */
  killGraceMs?: number;
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
  /** The output was not UTF-8 and was converted from this code page of the machine (for example `cp850`); absent otherwise. */
  decodedFrom?: string;
  durationMs: number;
}

function killTree(pid: number, env: Record<string, string | undefined>, fallback: () => void, taskkill: NonNullable<RunOptions['taskkill']>): void {
  if (process.platform === 'win32') {
    const root = windowsSystemRoot(env);
    if (!root) return fallback();
    let fellBack = false;
    const once = () => {
      if (!fellBack) {
        fellBack = true;
        fallback();
      }
    };
    // /T ends the whole tree: a timed-out `cmd` must not leave its children (ping, for loops) running. A taskkill that cannot start or
    // that runs and fails (non-zero) falls back to ending the shell itself.
    const t = taskkill(`${root}\\System32\\taskkill.exe`, ['/T', '/F', '/PID', String(pid)]);
    t.once('error', once);
    t.once('exit', (code) => {
      if (code !== 0) {
        once();
      }
    });
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
  let plain = launchSpec(options.shell, options.command, process.platform, sourceEnv);
  const wrapper = options.keepAwakeWrapper ?? defaultKeepAwakeWrapper(process.platform);
  if (wrapper !== undefined) {
    try {
      accessSync(wrapper, constants.X_OK);
    } catch {
      // Never run unwrapped: the Mac could sleep under the job.
      throw new Error(`"${wrapper}" is missing or not executable: on macOS every command runs under it so that the Mac keeps awake while the job runs (T-71); restore it (it ships with macOS) before running commands on this machine`);
    }
  }
  if (wrapper !== undefined && plain.file === 'pwsh') {
    // Resolved here so that a missing pwsh is reported as such, not as a failure of the wrapper with an ordinary non-zero exit.
    const resolved = (options.resolveProgram ?? ((name: string) => resolveOnPath(name, scrubEnv(sourceEnv, process.platform).PATH)))('pwsh');
    if (resolved === undefined) {
      throw new Error(`cannot start shell "${options.shell}": "pwsh" is not installed or not on the PATH of the daemon on this machine; install PowerShell 7 (pwsh) or remove the policy entries that use shell "${options.shell}"`);
    }
    plain = { ...plain, file: resolved };
  }
  const spec = wrapper === undefined ? plain : withKeepAwake(plain, wrapper);
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(spec.file, spec.args, {
      env: scrubEnv(sourceEnv, process.platform),
      cwd: options.cwd ?? homedir(),
      // No stdin unless the entry declares an input: a command that waits for input gets end-of-file instead of hanging.
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] as ['ignore' | 'pipe', 'pipe', 'pipe'],
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
      windowsHide: true,
      // Unix: own process group, so the whole group can be ended.
      detached: process.platform !== 'win32',
    }) as ChildProcessByStdio<Writable | null, Readable, Readable>;
    child.once('spawn', () => options.onStarted?.());
    if (options.stdin !== undefined && child.stdin !== null) {
      // A command that exits or closes its stdin without reading makes the write fail with EPIPE: that is the command's business, not an error.
      child.stdin.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EPIPE' || e.code === 'EOF' || e.code === 'ERR_STREAM_DESTROYED' || e.code === 'ECONNRESET') return;
        clearTimeout(timer);
        stop();
        reject(new Error(`cannot write the input to "${options.shell}": ${e.message}`));
      });
      child.stdin.end(Buffer.from(options.stdin));
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let truncated = false;
    let killed = false;
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      // Only the output is converted, after the command ran: the approved string is never touched (T-15). The OEM code page is
      // asked only for output that is not UTF-8, and only on Windows for the shells that write it (cmd, ps).
      const oem = process.platform === 'win32' && (options.shell === 'cmd' || options.shell === 'ps') ? (options.oemCodePage ?? (() => detectOemCodePage(sourceEnv))) : async () => undefined;
      Promise.all([decodeOutput(out, truncated, oem), decodeOutput(err, truncated, oem)]).then(([o, e]) => {
        const decodedFrom = [o.decodedFrom, e.decodedFrom].find((p) => p !== undefined);
        resolve({
          exitCode: killed ? null : code,
          stdout: o.text,
          stderr: e.text,
          timedOut,
          truncated,
          outputNotUtf8: o.lossy || e.lossy,
          ...(decodedFrom !== undefined ? { decodedFrom } : {}),
          durationMs: Date.now() - started,
        });
      }, reject);
    };
    const stop = () => {
      // A shell that already exited must not be killed: its PID may belong to someone else by now.
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return false;
      killed = true;
      killTree(child.pid, sourceEnv, () => child.kill('SIGKILL'), options.taskkill ?? ((file, args) => spawn(file, args, { stdio: 'ignore', windowsHide: true })));
      // Hard bound: a grandchild that survived and holds the pipes must not keep this run (and the slot of the caller) in flight.
      grace ??= setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        settle(null);
      }, options.killGraceMs ?? 5000);
      return true;
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
      if (stop()) timedOut = true;
    }, options.timeoutMs);
    // A broken pipe must become a rejected run, never an uncaught exception in the daemon.
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('error', (e) => {
        clearTimeout(timer);
        stop();
        reject(new Error(`cannot read the output of "${options.shell}": ${e.message}`));
      });
    }
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const hint = e.code === 'ENOENT' ? `: "${spec.file}" is not installed or not on PATH on this machine; install it or remove the policy entries that use shell "${options.shell}"` : '';
      reject(new Error(`cannot start shell "${options.shell}" (${e.message})${hint}`));
    });
    child.on('close', (code) => settle(code));
  });
}
