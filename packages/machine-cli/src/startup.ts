import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join, resolve, win32 } from 'node:path';
import { ConfigDir } from '@wadeck-app/shared-cli/ConfigDir';
import { planBundleLink, syncBundleLink, type BundleLinkFs, type BundleLinkPlan, type BundleLinkReport } from './bundleLink.js';
import { daemonPortFile, readDaemonState, type DaemonState } from './daemonPortFile.js';
import { pruneStaged, stagedLauncher, stageWrapper, WRAPPER_NAME, wrapperScript, wrapperState, type BinaryDeps, type PruneResult } from './platformBinary.js';

// Registration of the daemon as an orch startup job (spec: startup.md, packaging.md). Library only: no I/O besides
// running orch and staging the launcher.

/** Id of the orch job. */
export const STARTUP_JOB_ID = 'machine';
/** orch can start its daemon on a first call: give it time, but never hang forever. */
const ORCH_TIMEOUT_MS = 60_000;
const NOT_INSTALLED = 'orch is not installed: npm i -g @wadeck-app/orchestrator-cli';
/** The bundle the Go launcher is built to find (ci/launcher.config.json, packaging.md section 3.3). */
export const LAUNCHER_BUNDLE_SPEC = '@wadeck-app/machine-cli/machine.cjs';

export class StartupError extends Error {}

/** orch is not on this machine: callers that can do without it (post-update) test the type, not the wording. */
export class OrchNotInstalledError extends StartupError {
  constructor() {
    super(NOT_INSTALLED);
  }
}

/** The program to run for orch. Production never sets it (there is no option for it); tests inject a stub. */
export interface OrchCommand {
  file: string;
  /** Arguments put before the orch ones (the script of a stub run by node). */
  args?: string[];
}

/**
 * Which command the job runs:
 * - `launcher`: the STAGED launcher (`<configDir>/bin/<stamp>/machine[.exe]`, a copy of the platform package binary).
 * - `launcher-wrapper`: Windows only, when the launcher cannot find the bundle by itself: `wscript.exe //B //Nologo <staged>\machine-daemon.vbs`,
 *   a generated script that sets LAUNCHER_BUNDLE_OVERRIDE and runs the staged launcher (orch.cmd cannot carry an environment variable).
 * - `development`: `node <bundle> daemon`, for a checkout or the development bundle (no launcher package installed).
 */
export type DaemonForm = 'launcher' | 'launcher-wrapper' | 'development';

/** What is running, to build the command orch must run later. */
export interface DaemonSource {
  platform: NodeJS.Platform;
  /** Absolute path of node (used by the development form). */
  execPath: string;
  /** Absolute path of the bundle run by node: the launcher form needs it too, to name it in the override. */
  scriptPath?: string;
  /** Present for the launcher form. `bundleOverride` is the bundle to hand over as LAUNCHER_BUNDLE_OVERRIDE, when the launcher cannot find it by itself. */
  launcher?: { exe: string; bundleOverride?: string; wrapper?: WrapperPlan };
}

/** The Windows wrapper: wscript.exe (absolute), the staged script and its exact content (configuration folder included). */
export interface WrapperPlan {
  wscript: string;
  vbs: string;
  content: string;
}

export interface StartupContext {
  configDir: string;
  orch?: OrchCommand;
  /** Tests: a ready-made source, which bypasses staging and pruning. */
  daemon?: DaemonSource;
  /** Decides how the real orch is started (Windows runs `orch.cmd` through cmd.exe). */
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** Library only (no CLI flag): another job id than `machine`, for a check against the real orch that must not touch the real job. */
  id?: string;
  /** Library only (no CLI flag): false leaves `--restart-on-exit` out. Default true. */
  restartOnExit?: boolean;
  /** Absolute path of the running bundle. Default: the script node runs. */
  bundlePath?: string;
  /** Platform, resolver and fs of the launcher lookup (tests). */
  binary?: BinaryDeps;
  /** Tests: the fs of the Windows node_modules junction (bundleLink.ts). */
  bundleLinkFs?: BundleLinkFs;
  /** `enable` starts the daemon now when it is not running. false (`--no-start`, post-update) registers the job only. Default true. */
  start?: boolean;
  /** How long `enable` waits for the started daemon to write its port file. Default 15 s (orch's own wait for a restart is 15 s). */
  startWaitMs?: number;
  /** Poll interval of that wait (tests). Default 200 ms. */
  startPollMs?: number;
  /** Tests: whether a pid is alive. Default: process.kill(pid, 0). */
  isAlive?: (pid: number) => boolean;
}

const START_WAIT_MS = 15_000;
const START_POLL_MS = 200;

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

/** First 12 hex digits of the sha256 of the wrapper script: the argument that ties the job command to the script content. */
export function wrapperHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}

/** The shell string orch will run: the staged launcher form or the `"<node>" "<bundle>" daemon` development form. */
export function daemonCommand(source: DaemonSource, configDir?: string): string {
  const q = (v: string) => quoteArg(v, source.platform);
  if (source.scriptPath === undefined || !/\.(cjs|mjs|js)$/.test(source.scriptPath)) {
    throw new StartupError(
      `machine startup needs the single-file bundle, but it runs from ${source.scriptPath ?? 'no script'}: build the bundle with \`npm run bundle\` and run \`node dist/machine.cjs startup enable\``,
    );
  }
  let command: string;
  if (source.launcher) {
    const { exe, bundleOverride, wrapper } = source.launcher;
    if (source.platform !== 'win32') {
      // orch passes the string to sh and does not support a quote inside a path of this form (orch-owner, packaging.md section 8).
      for (const path of [exe, bundleOverride, configDir]) {
        if (path !== undefined && path.includes("'")) {
          throw new StartupError(`the path ${path} contains a single quote, which orch cannot carry in the launcher command: move machine (or its configuration folder) to a path without it`);
        }
      }
    }
    if (bundleOverride !== undefined && source.platform === 'win32') {
      // The wrapper script carries the override and the configuration folder; the job command only names the script.
      // The script ignores its argument: the content hash changes the command when only the script changes (a moved bundle), so `orch --restart-if-changed` restarts the daemon.
      if (wrapper !== undefined) return `${q(wrapper.wscript)} //B //Nologo ${q(wrapper.vbs)} ${wrapperHash(wrapper.content)}`;
      throw new StartupError(
        `the launcher cannot find the bundle ${bundleOverride} from its staged folder: it only looks under <folder of node>\\node_modules\\${LAUNCHER_BUNDLE_SPEC}, and the Windows job cannot carry LAUNCHER_BUNDLE_OVERRIDE through orch.cmd. Make the global modules of machine live next to node.exe (npm prefix = the folder of node.exe), run \`npm i -g @wadeck-app/machine-cli\` again, then \`machine startup enable\``,
      );
    }
    command = `${bundleOverride === undefined ? '' : `LAUNCHER_BUNDLE_OVERRIDE=${q(bundleOverride)} `}${q(exe)} daemon`;
  } else {
    command = `${q(source.execPath)} ${q(source.scriptPath)} daemon`;
  }
  return configDir === undefined ? command : `${command} --config-dir ${q(configDir)}`;
}

/**
 * LAUNCHER_BUNDLE_OVERRIDE to hand the launcher, or undefined for none (port of orch launcher-bundle.ts). The launcher,
 * staged outside node_modules, finds the bundle by itself only at `<folder of node>/node_modules/<spec>`; any other bundle
 * (a checkout, a Windows global prefix in %APPDATA%, a Unix prefix with lib/) must be named.
 */
export function launcherBundleOverride(opts: { bundle: string; spec: string; nodeDir: string | null; realpath?: (p: string) => string }): string | undefined {
  if (opts.nodeDir === null) return opts.bundle;
  const real = opts.realpath ?? realpathSync;
  const found = join(opts.nodeDir, 'node_modules', ...opts.spec.split('/'));
  try {
    return real(found) === real(opts.bundle) ? undefined : opts.bundle;
  } catch {
    // The launcher's own lookup (a stat) fails the same way: it would not find the bundle, so it must be told.
    return opts.bundle;
  }
}

/** Which form a stored command is, from its first program: the staged launcher, node, or something else (not guessed). */
export function registeredForm(command: string): DaemonForm | 'unknown' {
  const rest = command.replace(/^LAUNCHER_BUNDLE_OVERRIDE='(?:[^']|'\\'')*'\s+/, '');
  if (/^"[^"]*[\\/]wscript\.exe"\s+\/\/B\s+\/\/Nologo\s+"[^"]*[\\/]machine-daemon\.vbs"(?:\s+[0-9a-f]{12})?$/i.test(rest)) return 'launcher-wrapper';
  const program = /^"([^"]*)"/.exec(rest)?.[1] ?? /^'((?:[^']|'\\'')*)'/.exec(rest)?.[1];
  if (program === undefined) return 'unknown';
  const name = (program.split(/[\\/]/).pop() ?? '').toLowerCase();
  if (/^machine(\.exe)?$/.test(name)) return 'launcher';
  if (/^node(\.exe)?$/.test(name)) return 'development';
  return 'unknown';
}

/** What `enable` would run now, how it was built, and what to do after orch accepted it. */
interface DaemonPlan {
  source: DaemonSource;
  form: DaemonForm;
  /** Why the development form is used (absent for the launcher form). */
  formNote?: string;
  /** The wrapper of the launcher-wrapper form (status compares its file). */
  wrapper?: WrapperPlan;
  /** Launcher form built from the real package: the stamp to keep when pruning. */
  keepStamp?: string;
  /** Windows, launcher that cannot find the bundle itself, bundle under a node_modules: the junction to keep in the staged folder. */
  bundleLink?: BundleLinkPlan;
}

function planDaemon(ctx: StartupContext, stage: boolean): DaemonPlan {
  if (ctx.daemon) return { source: ctx.daemon, form: ctx.daemon.launcher ? 'launcher' : 'development' };
  const platform = ctx.platform ?? process.platform;
  const env = ctx.env ?? process.env;
  const bundle = ctx.bundlePath ?? (process.argv[1] ? resolve(process.argv[1]) : undefined);
  const base: DaemonSource = { platform, execPath: process.execPath, ...(bundle === undefined ? {} : { scriptPath: bundle }) };
  const staged = stagedLauncher(resolve(ctx.configDir), { platform, ...ctx.binary }, stage);
  if (staged.kind === 'absent') {
    return {
      source: base,
      form: 'development',
      formNote: `development form (node + bundle): ${staged.reason}, so this is a checkout or the development bundle. The installed release (npm i -g @wadeck-app/machine-cli) registers the staged launcher instead`,
    };
  }
  if (bundle === undefined) {
    throw new StartupError('machine startup cannot tell which bundle is running (no script): run it as `machine startup enable` from the installed package');
  }
  const nodeFound = findOnPath('node', env, platform);
  const bundleOverride = launcherBundleOverride({ bundle, spec: LAUNCHER_BUNDLE_SPEC, nodeDir: nodeFound === undefined ? null : dirname(nodeFound) });
  const wrapper = platform === 'win32' && bundleOverride !== undefined ? windowsWrapper(ctx, staged.exe, bundleOverride, env, stage) : undefined;
  const bundleLink = bundleOverride === undefined ? null : planBundleLink({ platform, bundle, spec: LAUNCHER_BUNDLE_SPEC, stageDir: win32.dirname(staged.exe) });
  return {
    source: { ...base, launcher: { exe: staged.exe, ...(bundleOverride === undefined ? {} : { bundleOverride }), ...(wrapper === undefined ? {} : { wrapper }) } },
    form: wrapper === undefined ? 'launcher' : 'launcher-wrapper',
    ...(wrapper === undefined ? {} : { wrapper }),
    keepStamp: staged.stamp,
    ...(bundleLink === null ? {} : { bundleLink }),
  };
}

/** The --config-dir value of the job, or undefined for the default folder: orch's own environment is not the user's. */
function nonDefaultConfigDir(ctx: StartupContext): string | undefined {
  const dir = resolve(ctx.configDir);
  return dir === resolve(ConfigDir.get('machine')) ? undefined : dir;
}

/** %SystemRoot%\System32\wscript.exe from the environment, absolute or refused. */
function wscriptPath(env: Record<string, string | undefined>): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR;
  if (root === undefined || !/^[A-Za-z]:\\/.test(root)) {
    const got = root === undefined ? 'not set' : `not an absolute Windows path (${root})`;
    throw new StartupError(
      `cannot find wscript.exe: SystemRoot is ${got}. The Windows startup wrapper runs %SystemRoot%\\System32\\wscript.exe: run machine from a normal Windows session (SystemRoot set), then \`machine startup enable\``,
    );
  }
  return win32.join(root, 'System32', 'wscript.exe');
}

/** Generates machine-daemon.vbs next to the staged launcher (written only when `stage`), every path validated. */
function windowsWrapper(ctx: StartupContext, exe: string, bundle: string, env: Record<string, string | undefined>, stage: boolean): WrapperPlan {
  const wscript = wscriptPath(env);
  const vbs = win32.join(win32.dirname(exe), WRAPPER_NAME);
  const configDir = nonDefaultConfigDir(ctx);
  try {
    const content = wrapperScript({ exe, bundle, ...(configDir === undefined ? {} : { configDir }) });
    if (stage) stageWrapper(vbs, content, ctx.binary?.fs);
    return { wscript, vbs, content };
  } catch (e) {
    throw new StartupError((e as Error).message);
  }
}

/** The command `enable` writes now. `--config-dir` is added only when this is not the default folder: orch's own environment is not the user's. */
function expectedCommand(ctx: StartupContext, plan: DaemonPlan): string {
  return daemonCommand(plan.source, nonDefaultConfigDir(ctx));
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
    if (found === undefined) return Promise.reject(new OrchNotInstalledError());
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
      reject(e.code === 'ENOENT' ? new OrchNotInstalledError() : new StartupError(`cannot run orch: ${e.message}`));
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

/** State of the local daemon after `enable`: `started` only when this call started it. `reason` says why it is not running (cause and fix). */
export interface DaemonOutcome {
  running: boolean;
  started: boolean;
  pid?: number;
  peerPort?: number;
  reason?: string;
}

export interface EnableResult {
  action: 'added' | 'updated' | 'unchanged';
  daemon: DaemonOutcome;
  id: string;
  command: string;
  portFile: string;
  form: DaemonForm;
  /** Why the development form was used (absent for the launcher form). */
  formNote?: string;
  /** Older staged launcher folders removed after orch accepted the job (launcher form built from the real package only). */
  pruned?: PruneResult;
  /** Windows: the junction that lets the staged launcher find the bundle by itself (absent when none is needed). A failure is reported here, not thrown: the wrapper still carries the job. */
  bundleLink?: BundleLinkReport;
}

export async function enableStartup(ctx: StartupContext): Promise<EnableResult> {
  // The new launcher is staged BEFORE orch is called and the old ones are pruned only AFTER orch returned 0: the stored job may still name an old folder until then (orch-owner rule).
  const plan = planDaemon(ctx, true);
  const command = expectedCommand(ctx, plan);
  const bundleLink = plan.bundleLink === undefined ? undefined : syncBundleLink(plan.bundleLink, ctx.bundleLinkFs);
  const portFile = daemonPortFile(resolve(ctx.configDir));
  const id = ctx.id ?? STARTUP_JOB_ID;
  // Read before orch is called: an outdated command makes `ensure --restart-if-changed` restart a running daemon, and that restart must not be mistaken for "down".
  const before = readDaemonState(resolve(ctx.configDir), ctx.isAlive);
  const restart = ctx.restartOnExit === false ? [] : ['--restart-on-exit'];
  const args = ['ensure', 'startup', id, '--command', command, ...restart, '--timeout', '0', '--restart-if-changed', '--liveness-strategy', 'portFile', '--liveness-port-file', portFile, '--json'];
  const result = await runOrch(ctx, args);
  if (result.code !== 0) throw orchFailure(result, args, 'machine startup enable');
  const action = parseOutcome(result.stdout, ['added', 'updated', 'unchanged'] as const, 'added, updated or unchanged');
  const pruned = plan.keepStamp === undefined ? undefined : pruneStaged(resolve(ctx.configDir), plan.keepStamp, ctx.binary?.fs);
  const daemon = await ensureDaemonRunning(ctx, id, before);
  return { action, daemon, id, command, portFile, form: plan.form, ...(plan.formNote === undefined ? {} : { formNote: plan.formNote }), ...(pruned === undefined ? {} : { pruned }), ...(bundleLink === undefined ? {} : { bundleLink }) };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const runningOutcome = (state: Extract<DaemonState, { running: true }>, started: boolean): DaemonOutcome => ({ running: true, started, pid: state.pid, peerPort: state.peerPort });

/** Cause and fix when the daemon did not come up: the daemon prints its own error in a terminal, and its log keeps the rest. */
function notStartedReason(cause: string, id: string): string {
  return `${cause}. Run \`machine daemon\` in a terminal to see its error, then \`machine cli logs\` (or \`orch logs --job ${id}\`) for the log of the job; once fixed, run \`orch restart-job ${id}\` (never \`orch trigger\`: it ignores the liveness check and starts a second instance)`;
}

/**
 * A `startup` job only starts when orch starts (login), so after `enable` the daemon may be down. When it is, `orch restart-job <id>`
 * starts it (it honours the liveness check, unlike `orch trigger`), then the port file is awaited. A daemon that already runs is left alone
 * (an outdated command was already restarted by `ensure --restart-if-changed`). Never throws: the job is registered either way.
 */
async function ensureDaemonRunning(ctx: StartupContext, id: string, before: DaemonState): Promise<DaemonOutcome> {
  if (before.running) return runningOutcome(before, false);
  const configDir = resolve(ctx.configDir);
  const down: DaemonOutcome = { running: false, started: false, ...(before.problem === undefined ? {} : { reason: before.problem }) };
  if (ctx.start === false) return down;
  const waitMs = ctx.startWaitMs ?? START_WAIT_MS;
  const seconds = Math.max(1, Math.round(waitMs / 1000));
  const args = ['restart-job', id, '--json'];
  let result: OrchResult;
  try {
    result = await runOrch(ctx, args);
  } catch (e) {
    return { running: false, started: false, reason: notStartedReason(`orch could not be asked to start the job: ${(e as Error).message}`, id) };
  }
  if (result.code !== 0) {
    // Skipped by the liveness check: orch saw a live daemon (the file may have been written in between).
    const now = readDaemonState(configDir, ctx.isAlive);
    if (now.running) return runningOutcome(now, false);
    return { running: false, started: false, reason: notStartedReason(`the job is registered but orch did not start it: ${restartJobReason(result)}`, id) };
  }
  const deadline = Date.now() + waitMs;
  for (;;) {
    const state = readDaemonState(configDir, ctx.isAlive);
    if (state.running) return runningOutcome(state, true);
    if (Date.now() >= deadline) {
      const note = state.problem === undefined ? 'no daemon.port.json from a live daemon appeared' : state.problem;
      return { running: false, started: false, reason: notStartedReason(`the job is registered but the daemon did not start within ${seconds} s: ${note}`, id) };
    }
    await sleep(ctx.startPollMs ?? START_POLL_MS);
  }
}

/** What orch says when `restart-job` did not start the job: the `reason` of its JSON answer, else its own output. */
function restartJobReason(result: OrchResult): string {
  const json = parseJson(result.stdout);
  const reason = typeof json === 'object' && json !== null ? (json as { reason?: unknown }).reason : undefined;
  if (typeof reason === 'string' && reason.length > 0) return reason;
  return result.stderr.trim() || result.stdout.trim() || `exit ${result.code} with no message`;
}

/**
 * Whether a stored job is the one `enable` writes: a command of a form machine registers (strictly: the daemon subcommand, optionally
 * --config-dir) AND the liveness port file of this configuration folder. A job with the same id failing either test is not ours.
 * orch has no owner field and `ensure` compares only the flags passed, so no marker is added: a job that matches both is the same daemon anyway.
 */
export function isMachineJob(job: { command: string; portFile?: string }, ctx: StartupContext): boolean {
  const form = registeredForm(job.command);
  if (form === 'unknown') return false;
  if (form !== 'launcher-wrapper' && !/\sdaemon(?:\s+--config-dir\s+(?:"[^"]*"|'(?:[^']|'\\'')*'))?$/.test(job.command)) return false;
  return job.portFile !== undefined && samePath(job.portFile, daemonPortFile(resolve(ctx.configDir)), ctx);
}

function samePath(a: string, b: string, ctx: StartupContext): boolean {
  const norm = (p: string) => ((ctx.platform ?? process.platform) === 'win32' ? p.toLowerCase() : p).replace(/\\/g, '/');
  return norm(a) === norm(b);
}

/** The liveness port file of a job as orch answers it (`liveness.portFile`), at the top of the answer or under `job`. */
function findPortFile(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null) return undefined;
  const nested = (json as { job?: unknown }).job;
  const holder = typeof nested === 'object' && nested !== null ? nested : json;
  const portFile = (holder as { liveness?: { portFile?: unknown } | null }).liveness?.portFile;
  return typeof portFile === 'string' ? portFile : undefined;
}

export interface DisableResult {
  outcome: 'removed' | 'absent';
  id: string;
  /** A running instance of the job (the daemon and its launcher tree) was ended before the job was removed. */
  stopped: boolean;
}

/**
 * `orch kill <id>` (orch cli.ts): text only, no --json. Exit 0 with `Job "<id>" killed[ (N instances)]` or `Job "<id>" is not running` (idempotent);
 * exit 1 for an unknown job or a failure. A manual kill is not restarted by restartOnExit. `orch remove` alone removes the job but NOT its running instance.
 */
async function stopInstance(ctx: StartupContext, id: string): Promise<boolean> {
  const args = ['kill', id];
  const kept = `the startup job "${id}" was NOT removed and its daemon may still be running: fix the cause, then run \`machine startup disable\` again`;
  const result = await runOrch(ctx, args);
  if (result.code !== 0) throw new StartupError(`${orchFailure(result, args, 'machine startup disable').message}\n${kept}`);
  const text = result.stdout.trim();
  // "not running" first: its text can add "pending restart was cancelled", which is not the end of an instance.
  if (/\bis not running\b/.test(text)) return false;
  if (/\bkilled\b/.test(text)) return true;
  throw new StartupError(`orch did not say whether the job "${id}" was killed or not running. Its output was: ${text || '(empty)'}\n${kept}`);
}

export async function disableStartup(ctx: StartupContext): Promise<DisableResult> {
  const id = ctx.id ?? STARTUP_JOB_ID;
  const showArgs = ['show', id, '--json'];
  const shown = await runOrch(ctx, showArgs);
  // Exit 3 of orch show: no such job, nothing to remove.
  if (shown.code === 3) return { outcome: 'absent', id, stopped: false };
  if (shown.code !== 0) throw orchFailure(shown, showArgs, 'machine startup disable');
  const command = findCommand(shown.stdout);
  if (command === undefined) {
    throw new StartupError(`orch show answered with no command field, so the job "${id}" cannot be checked before removal. Its output was: ${shown.stdout.trim() || '(empty)'}`);
  }
  if (!isMachineJob({ command, portFile: findPortFile(parseJson(shown.stdout)) }, ctx)) {
    throw new StartupError(
      `the orch job "${id}" was not created by machine (its command is: ${command}; machine's job runs its daemon with the liveness port file ${daemonPortFile(resolve(ctx.configDir))}), so it was NOT removed. If it is yours, remove it with \`orch remove ${id}\`; otherwise leave it`,
    );
  }
  // `orch remove` leaves the running instance alive: end it first, and remove the job only once that worked (nothing half done).
  const stopped = await stopInstance(ctx, id);
  const args = ['remove', id, '--if-exists'];
  const result = await runOrch(ctx, args);
  if (result.code !== 0) throw orchFailure(result, args, 'machine startup disable');
  return { outcome: parseOutcome(result.stdout, ['removed', 'absent'] as const, 'removed or absent'), id, stopped };
}

export interface StatusResult {
  exists: boolean;
  id: string;
  /** What `enable` would write now. */
  expected: string;
  /** Command stored in the orch job (when it exists). */
  command?: string;
  upToDate?: boolean;
  /** Form `enable` would register now, and why it is the development form when it is. */
  expectedForm: DaemonForm;
  formNote?: string;
  /** Form of the stored command (when the job exists). */
  registeredForm?: DaemonForm | 'unknown';
  /** Wrapper form only: whether the staged script is the one `enable` would write now. */
  wrapper?: 'current' | 'missing' | 'different';
  /** Windows: the junction of the staged folder, checked and repaired when missing or stale (the only thing status writes). */
  bundleLink?: BundleLinkReport;
  /** Other orch jobs whose liveness port file is this daemon's: two supervisors on one daemon fight over it. */
  conflicts: { id: string; command: string }[];
  /** Whether the local daemon runs (daemon.port.json and a live pid; read only, no network). */
  daemon: DaemonState;
}

/** Every orch job other than `id` with the same liveness port file as this configuration folder. */
async function portFileConflicts(ctx: StartupContext, id: string): Promise<{ id: string; command: string }[]> {
  const args = ['list', '--json'];
  const result = await runOrch(ctx, args);
  if (result.code !== 0) throw orchFailure(result, args, 'machine startup status');
  const json = parseJson(result.stdout);
  const jobs = Array.isArray(json) ? json : (json as { jobs?: unknown } | undefined)?.jobs;
  if (!Array.isArray(jobs)) {
    throw new StartupError(`orch list did not answer a list of jobs, so duplicate jobs on the port file cannot be checked. Its output was: ${result.stdout.trim() || '(empty)'}`);
  }
  const portFile = daemonPortFile(resolve(ctx.configDir));
  const found: { id: string; command: string }[] = [];
  for (const job of jobs as { id?: unknown; command?: unknown }[]) {
    if (typeof job !== 'object' || job === null || typeof job.id !== 'string' || job.id === id) continue;
    const other = findPortFile(job);
    if (other !== undefined && samePath(other, portFile, ctx)) found.push({ id: job.id, command: typeof job.command === 'string' ? job.command : '(no command)' });
  }
  return found;
}

export async function startupStatus(ctx: StartupContext): Promise<StatusResult> {
  const id = ctx.id ?? STARTUP_JOB_ID;
  const plan = planDaemon(ctx, false);
  const expected = expectedCommand(ctx, plan);
  const base = { id, expected, expectedForm: plan.form, daemon: readDaemonState(resolve(ctx.configDir), ctx.isAlive), ...(plan.formNote === undefined ? {} : { formNote: plan.formNote }) };
  const args = ['show', id, '--json'];
  const result = await runOrch(ctx, args);
  // Exit 3 of orch show: no such job.
  if (result.code === 3) return { exists: false, ...base, conflicts: await portFileConflicts(ctx, id) };
  if (result.code !== 0) throw orchFailure(result, args, 'machine startup status');
  const command = findCommand(result.stdout);
  if (command === undefined) throw new StartupError(`orch show answered with no command field, so the job cannot be compared. Its output was: ${result.stdout.trim() || '(empty)'}`);
  let wrapper: 'current' | 'missing' | 'different' | undefined;
  if (plan.wrapper !== undefined) {
    try {
      wrapper = wrapperState(plan.wrapper.vbs, plan.wrapper.content, ctx.binary?.fs);
    } catch (e) {
      throw new StartupError((e as Error).message);
    }
  }
  const bundleLink = plan.bundleLink === undefined ? undefined : syncBundleLink(plan.bundleLink, ctx.bundleLinkFs);
  const upToDate = command === expected && (wrapper === undefined || wrapper === 'current');
  return { exists: true, ...base, conflicts: await portFileConflicts(ctx, id), command, upToDate, registeredForm: registeredForm(command), ...(wrapper === undefined ? {} : { wrapper }), ...(bundleLink === undefined ? {} : { bundleLink }) };
}

/** The `command` string at the top of the answer or inside a `job` object. */
function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

function findCommand(stdout: string): string | undefined {
  const json = parseJson(stdout);
  if (typeof json !== 'object' || json === null) return undefined;
  const top = (json as { command?: unknown }).command;
  if (typeof top === 'string') return top;
  const nested = (json as { job?: { command?: unknown } }).job?.command;
  return typeof nested === 'string' ? nested : undefined;
}
