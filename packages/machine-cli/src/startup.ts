import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { isSea } from 'node:sea';
import { delimiter, join, resolve } from 'node:path';
import { ConfigDir } from '@wadeck-app/shared-cli/ConfigDir';
import { daemonPortFile } from './daemonPortFile.js';

// Registration of the daemon as an orch startup job (spec: startup.md). Library only: no I/O besides running orch.

/** Id of the orch job. */
export const STARTUP_JOB_ID = 'machine';
/** orch can start its daemon on a first call: give it time, but never hang forever. */
const ORCH_TIMEOUT_MS = 60_000;
const NOT_INSTALLED = 'orch is not installed: npm i -g @wadeck-app/orchestrator-cli';

export class StartupError extends Error {}

/** The program to run for orch. Production never sets it (there is no option for it); tests inject a stub. */
export interface OrchCommand {
  file: string;
  /** Arguments put before the orch ones (the script of a stub run by node). */
  args?: string[];
}

/** What is running, to build the command orch must run later. */
export interface DaemonSource {
  platform: NodeJS.Platform;
  /** Absolute path of the running executable (node for the bundle, the binary itself for a native build). */
  execPath: string;
  /** Absolute path of the bundle run by node. Unused for a native binary. */
  scriptPath?: string;
  native: boolean;
}

export interface StartupContext {
  configDir: string;
  orch?: OrchCommand;
  daemon?: DaemonSource;
  /** Decides how the real orch is started (Windows runs `orch.cmd` through cmd.exe). */
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
}

export function currentDaemonSource(): DaemonSource {
  const script = process.argv[1];
  return { platform: process.platform, execPath: process.execPath, ...(script ? { scriptPath: resolve(script) } : {}), native: isSea() };
}

/** Windows: double quotes (cmd.exe). Elsewhere: single quotes, a quote inside becomes '\'' . */
export function quoteArg(value: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    for (const bad of ['"', '%']) {
      if (value.includes(bad)) throw new StartupError(`the path ${value} contains ${bad}, which cannot be quoted safely for cmd.exe: move machine to a path without it`);
    }
    return `"${value}"`;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** The shell string orch will run: `"<node>" "<bundle>" daemon`, or `"<exe>" daemon` for a native binary. */
export function daemonCommand(source: DaemonSource, configDir?: string): string {
  const q = (v: string) => quoteArg(v, source.platform);
  let command: string;
  if (source.native) {
    command = `${q(source.execPath)} daemon`;
  } else {
    if (source.scriptPath === undefined || !/\.(cjs|mjs|js)$/.test(source.scriptPath)) {
      throw new StartupError(
        `machine startup needs the single-file bundle or a native binary, but it runs from ${source.scriptPath ?? 'no script'}: build the bundle with \`npm run bundle\` and run \`node dist/machine.cjs startup enable\``,
      );
    }
    command = `${q(source.execPath)} ${q(source.scriptPath)} daemon`;
  }
  return configDir === undefined ? command : `${command} --config-dir ${q(configDir)}`;
}

/** The command `enable` writes now. `--config-dir` is added only when this is not the default folder: orch's own environment is not the user's. */
function expectedCommand(ctx: StartupContext): string {
  const source = ctx.daemon ?? currentDaemonSource();
  const dir = resolve(ctx.configDir);
  return daemonCommand(source, dir === resolve(ConfigDir.get('machine')) ? undefined : dir);
}

/** First match of `name` on PATH (Windows: with a PATHEXT extension; a bare file is a shim that cmd.exe cannot run). */
export function findOnPath(name: string, env: Record<string, string | undefined>, platform: NodeJS.Platform): string | undefined {
  const separator = platform === 'win32' ? ';' : delimiter;
  const folders = (env.PATH ?? env.Path ?? '').split(separator).filter((f) => f.length > 0);
  const extensions = platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e.length > 0).map((e) => e.toLowerCase()) : [''];
  for (const folder of folders) {
    for (const ext of extensions) {
      const candidate = join(folder, `${name}${ext}`);
      if (!existsSync(candidate)) continue;
      if (platform !== 'win32') {
        try {
          accessSync(candidate, constants.X_OK);
        } catch {
          continue;
        }
      }
      return candidate;
    }
  }
  return undefined;
}

/** One command line for cmd.exe: program and arguments quoted, quotes inside an argument escaped. */
export function buildShellLine(file: string, args: string[]): string {
  for (const part of [file, ...args]) {
    const meta = /[&|<>^%]/.exec(part);
    if (meta) throw new StartupError(`cannot pass "${meta[0]}" to orch through cmd.exe (in: ${part}): move machine to a path without it`);
  }
  return [file, ...args].map((p) => `"${p.replace(/"/g, '\\"')}"`).join(' ');
}

interface OrchResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runOrch(ctx: StartupContext, args: string[]): Promise<OrchResult> {
  const platform = ctx.platform ?? process.platform;
  let file: string;
  let argv: string[];
  let shell = false;
  if (ctx.orch) {
    file = ctx.orch.file;
    argv = [...(ctx.orch.args ?? []), ...args];
  } else if (platform === 'win32') {
    const found = findOnPath('orch', ctx.env ?? process.env, platform);
    if (found === undefined) return Promise.reject(new StartupError(NOT_INSTALLED));
    if (/\.exe$/i.test(found)) {
      file = found;
      argv = args;
    } else {
      // orch.cmd is a batch file: it needs cmd.exe.
      file = buildShellLine(found, args);
      argv = [];
      shell = true;
    }
  } else {
    file = 'orch';
    argv = args;
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, argv, { windowsHide: true, shell, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new StartupError(`orch did not answer within ${ORCH_TIMEOUT_MS / 1000} s (orch ${args.join(' ')}): run \`orch status\` to see whether its daemon is stuck`));
    }, ORCH_TIMEOUT_MS);
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new StartupError(NOT_INSTALLED) : new StartupError(`cannot run orch: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** Never silent: every non-zero exit of orch becomes a message that says what to do. */
function orchFailure(result: OrchResult, args: string[], retry: string): StartupError {
  const output = result.stderr.trim() || result.stdout.trim();
  switch (result.code) {
    case 2:
      return new StartupError(`the orch daemon could not be started: run \`orch status\`${output ? ` (orch said: ${output})` : ''}`);
    case 4:
      return new StartupError(
        `internal error: orch refused its arguments (usage error, exit 4): \`orch ${args.join(' ')}\`${output ? ` (orch said: ${output})` : ''}. This is a bug of machine, or the installed orch is older than the one machine expects (npm i -g @wadeck-app/orchestrator-cli)`,
      );
    case 1:
      return new StartupError(`orch failed (exit 1): ${output || '(no message)'}\nfix what orch reports, then run \`${retry}\` again`);
    default:
      return new StartupError(`orch failed (exit ${result.code}) on \`orch ${args.join(' ')}\`: ${output || '(no message)'}\nrun \`orch status\`, then \`${retry}\` again`);
  }
}

/** `added machine`, or JSON in which one string field holds the outcome (the JSON shape is not part of the frozen contract). */
function parseOutcome<T extends string>(stdout: string, allowed: readonly T[], what: string): T {
  const text = stdout.trim();
  const fail = () => new StartupError(`orch did not say ${what}. Its output was: ${text || '(empty)'}`);
  const pick = (value: unknown): T | undefined => (typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined);
  try {
    const json: unknown = JSON.parse(text);
    const direct = pick(json);
    if (direct) return direct;
    if (typeof json === 'object' && json !== null) {
      for (const value of Object.values(json)) {
        const found = pick(value);
        if (found) return found;
      }
    }
    throw fail();
  } catch (e) {
    if (e instanceof StartupError) throw e;
  }
  const first = /^(\S+)/.exec(text)?.[1];
  const word = pick(first);
  if (word) return word;
  throw fail();
}

export interface EnableResult {
  action: 'added' | 'updated' | 'unchanged';
  id: string;
  command: string;
  portFile: string;
}

export async function enableStartup(ctx: StartupContext): Promise<EnableResult> {
  const command = expectedCommand(ctx);
  const portFile = daemonPortFile(resolve(ctx.configDir));
  const args = ['ensure', 'startup', STARTUP_JOB_ID, '--command', command, '--restart-on-exit', '--timeout', '0', '--restart-if-changed', '--liveness-strategy', 'portFile', '--liveness-port-file', portFile, '--json'];
  const result = await runOrch(ctx, args);
  if (result.code !== 0) throw orchFailure(result, args, 'machine startup enable');
  return { action: parseOutcome(result.stdout, ['added', 'updated', 'unchanged'] as const, 'added, updated or unchanged'), id: STARTUP_JOB_ID, command, portFile };
}

export interface DisableResult {
  outcome: 'removed' | 'absent';
  id: string;
}

export async function disableStartup(ctx: StartupContext): Promise<DisableResult> {
  const args = ['remove', STARTUP_JOB_ID, '--if-exists'];
  const result = await runOrch(ctx, args);
  if (result.code !== 0) throw orchFailure(result, args, 'machine startup disable');
  return { outcome: parseOutcome(result.stdout, ['removed', 'absent'] as const, 'removed or absent'), id: STARTUP_JOB_ID };
}

export interface StatusResult {
  exists: boolean;
  id: string;
  /** What `enable` would write now. */
  expected: string;
  /** Command stored in the orch job (when it exists). */
  command?: string;
  upToDate?: boolean;
}

export async function startupStatus(ctx: StartupContext): Promise<StatusResult> {
  const expected = expectedCommand(ctx);
  const args = ['show', STARTUP_JOB_ID, '--json'];
  const result = await runOrch(ctx, args);
  // Exit 3 of orch show: no such job.
  if (result.code === 3) return { exists: false, id: STARTUP_JOB_ID, expected };
  if (result.code !== 0) throw orchFailure(result, args, 'machine startup status');
  const command = findCommand(result.stdout);
  if (command === undefined) throw new StartupError(`orch show answered with no command field, so the job cannot be compared. Its output was: ${result.stdout.trim() || '(empty)'}`);
  return { exists: true, id: STARTUP_JOB_ID, expected, command, upToDate: command === expected };
}

/** The `command` string at the top of the answer or inside a `job` object. */
function findCommand(stdout: string): string | undefined {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof json !== 'object' || json === null) return undefined;
  const top = (json as { command?: unknown }).command;
  if (typeof top === 'string') return top;
  const nested = (json as { job?: { command?: unknown } }).job?.command;
  return typeof nested === 'string' ? nested : undefined;
}
