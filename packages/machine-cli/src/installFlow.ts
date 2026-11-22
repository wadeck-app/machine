import {
  InstallError,
  ROOT_READ_ABSENT,
  classifyInstalled,
  rootReadArgv,
  shellQuote,
  unsupportedMessage,
  type InstallFacts,
  type InstallPlan,
  type InstalledClass,
  type InstalledState,
  type Installable,
  type PlanArg,
  type PlannedFile,
} from '@wadeck-app/machine-core';
import type { ExecResult, InstallEnv } from './installEnv.js';

// `machine install <id> [--dry-run | --check | --remove] [--yes]` (install.md): runs the plan of an installable with an injected fs and exec.
// A LOCAL command: it refuses without a terminal, and the only root actions are `sudo` child processes that share the terminal of the owner,
// so the password is typed to sudo itself. machine never reads, stores, logs or passes it (threat-model hard rules 7 and 8).

export interface FlowOptions {
  mode: 'install' | 'remove' | 'check';
  /** Print the plan (install or remove) and change nothing, not even by running sudo. */
  dryRun: boolean;
  /** Skip the y/N question. It never replaces the terminal. */
  yes: boolean;
  /** The name of this machine, for the lines to run next; undefined when it has no identity yet. */
  machineName?: string;
}

export interface FlowIo {
  say: (text: string) => void;
  warn: (text: string) => void;
  confirm: (question: string) => Promise<boolean>;
}

export interface FlowResult {
  exit: number;
  document: Record<string, unknown>;
}

const NAME_PLACEHOLDER = '<this machine name>';
const SHORT = 12;
const short = (sha256: string | undefined): string => (sha256 === undefined ? 'none' : sha256.slice(0, SHORT));

/** What a child process wrote, safe for a terminal: control characters (escape sequences) are replaced, the length is bounded. */
function visible(text: string, max = 2000): string {
  const trimmed = text.trim();
  const cut = trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed;
  return cut.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '?');
}

// Before the temporary folder exists the staged files are shown as <temp dir>/<name> (not quoted: it is a placeholder, not a path).
const display = (argv: PlanArg[], stageDir: string | undefined): string => argv.map((a) => (typeof a === 'string' ? shellQuote(a) : stageDir === undefined ? `<temp dir>/${a.stage}` : shellQuote(`${stageDir}/${a.stage}`))).join(' ');

function failureText(what: string, command: string, r: ExecResult): string {
  const how = r.code === null ? `it could not run: ${r.error ?? 'unknown cause'}` : `exit code ${r.code}`;
  const said = visible(r.stderr);
  return `${what}\n  command: ${command}\n  ${how}${said === '' ? '' : `\n  stderr: ${said.replace(/\n/g, '\n          ')}`}`;
}

async function toolPath(env: InstallEnv, tool: string, missing: string): Promise<string> {
  const r = await env.exec(['sh', '-c', `command -v ${tool}`]);
  const found = r.code === 0 ? r.stdout.trim() : '';
  if (found === '') {
    throw new InstallError(missing);
  }
  if (!found.startsWith('/')) {
    throw new InstallError(`\`command -v ${tool}\` answered ${JSON.stringify(visible(found, 80))}, which is not an absolute path (a shell function or alias?): the path is written into a script that runs with a scrubbed environment, so it must be absolute. Install the real ${tool} or fix your shell profile`);
  }
  return found;
}

async function measure(env: InstallEnv): Promise<InstallFacts> {
  const systemctlPath = await toolPath(env, 'systemctl', 'systemctl was not found on this machine (`command -v systemctl` found nothing): `machine install suspend` needs systemd, because suspending is `systemctl suspend`. Nothing was changed');
  const sudoPath = await toolPath(env, 'sudo', 'sudo was not found on this machine (`command -v sudo` found nothing): machine installs root-owned files through sudo, with your own password. Install sudo (as root, with your package manager) and run the command again. Nothing was changed');
  return { platform: env.platform, userName: env.userName(), systemctlPath, sudoPath };
}

interface Seen {
  file: PlannedFile;
  /** False when the file was not read (a root-only file in a dry run). */
  read: boolean;
  cls: InstalledClass | undefined;
  found: string | undefined;
}

async function readRootOnly(env: InstallEnv, plan: InstallPlan, file: PlannedFile, sudoPath: string): Promise<string | undefined> {
  const argv = rootReadArgv(sudoPath, file.path);
  const r = await env.exec(argv);
  if (r.code === 0) {
    return r.stdout;
  }
  if (r.code === ROOT_READ_ABSENT) {
    return undefined;
  }
  throw new InstallError(`${failureText(`cannot read ${file.path} (root-only) to compare it with what this build ships: nothing was changed`, `sudo sh -c ... ${file.path}`, r)}\n  fix: check your sudo password and that your user may use sudo, then run the command again (\`--dry-run\` reads no root file)`);
}

async function inspect(env: InstallEnv, plan: InstallPlan, io: FlowIo, readRoot: boolean): Promise<Seen[]> {
  const out: Seen[] = [];
  const sudoPath = plan.probe[0] ?? 'sudo';
  let announced = false;
  for (const file of plan.files) {
    if (file.rootOnly && !readRoot) {
      out.push({ file, read: false, cls: undefined, found: undefined });
      continue;
    }
    let found: string | undefined;
    if (file.rootOnly) {
      if (!announced) {
        io.say(`[info] sudo may ask YOUR password now, to read ${file.path} (a root-only file); nothing is changed yet\n`);
        announced = true;
      }
      found = await readRootOnly(env, plan, file, sudoPath);
    } else {
      try {
        found = env.fs.readText(file.path);
      } catch (e) {
        throw new InstallError(`${(e as Error).message}: check the permissions of that path (machine reads it to know whether it wrote it); nothing was changed`);
      }
    }
    out.push({ file, read: true, cls: classifyInstalled(file, found), found });
  }
  return out;
}

function refuseForeign(def: Installable, seen: Seen[]): void {
  const foreign = seen.find((s) => s.cls?.state === 'foreign');
  if (foreign === undefined) {
    return;
  }
  throw new InstallError(
    `${foreign.file.path} exists and was not written by \`machine install ${def.id}\` (it has no "# managed by machine install ${def.id}, version <n>" line): machine never overwrites or removes a file it did not write. Nothing was changed. Read it, and when you do not need it remove it yourself: sudo rm -- ${foreign.file.path}`,
  );
}

function stateLine(s: Seen, dryRun: boolean): string {
  if (!s.read) {
    return `  ${s.file.path}: not read (a root-only file${dryRun ? ': --dry-run runs nothing, not even sudo' : ''})`;
  }
  const c = s.cls as InstalledClass;
  if (c.state === 'absent') {
    return `  ${s.file.path}: absent`;
  }
  if (c.state === 'current') {
    return `  ${s.file.path}: up to date (sha256 ${short(c.sha256)})`;
  }
  if (c.state === 'outdated') {
    return `  ${s.file.path}: OUTDATED, written by machine (version ${c.version ?? '?'}, sha256 ${short(c.sha256)}); this build ships sha256 ${short(s.file.sha256)}`;
  }
  return `  ${s.file.path}: not written by machine`;
}

function fileBlock(file: PlannedFile): string[] {
  return [`  ${file.path}   (owner ${file.owner}:${file.group}, mode ${file.mode}, sha256 ${short(file.sha256)})`, `    ${file.describe}`, ...file.content.split('\n').filter((l, i, all) => !(i === all.length - 1 && l === '')).map((l) => `    | ${l}`)];
}

/** A command is shown after a `$`; a step that is only machine writing a temporary file has no command. */
function stepLines(steps: Array<{ describe: string; command?: string }>): string[] {
  return steps.flatMap((s, i) => [`  ${i + 1}. ${s.describe}`, ...(s.command === undefined ? [] : [`     $ ${s.command}`])]);
}

const nameOf = (o: FlowOptions): string => o.machineName ?? NAME_PLACEHOLDER;
const missingNameWarning = (o: FlowOptions): string[] => (o.machineName === undefined ? ['[warn] this machine has no name yet (no identity: run `machine join <relay>` or `machine setup <relay>` first): replace <this machine name> with the name of this machine'] : []);

const documentFiles = (seen: Seen[]): Array<Record<string, unknown>> => seen.map((s) => ({ id: s.file.id, path: s.file.path, state: s.read ? (s.cls as InstalledClass).state : 'not read', ...(s.cls?.sha256 === undefined ? {} : { sha256: s.cls.sha256 }), shippedSha256: s.file.sha256 }));

export async function runInstallFlow(def: Installable, options: FlowOptions, env: InstallEnv, io: FlowIo): Promise<FlowResult> {
  if (!def.platforms.includes(env.platform)) {
    throw new InstallError(unsupportedMessage(def, env.platform));
  }
  const changes = options.mode !== 'check' && !options.dryRun;
  if (changes && !env.isTty()) {
    throw new InstallError(
      `\`machine install ${def.id}${options.mode === 'remove' ? ' --remove' : ''}\` needs an interactive terminal: it runs sudo, and sudo asks YOUR password there (machine never reads it, and never takes it from an argument, an environment variable or a pipe). Run it in a terminal on this machine (over SSH: ssh -t <machine>); \`--dry-run\` and \`--check\` need no terminal. Nothing was changed`,
    );
  }
  const facts = await measure(env);
  const plan = def.plan(facts);
  if (options.mode === 'check') {
    return checkFlow(def, plan, env, io);
  }
  if (options.mode === 'remove') {
    return removeFlow(def, plan, env, io, options);
  }
  return installFlow(def, plan, env, io, options);
}

// ---------------------------------------------------------------- check

/** The script is compared byte for byte; the root-only rule is only known as "sudo allows the command" (see install.md). */
function checkState(script: InstalledState, sudoAllows: boolean): string {
  if (script === 'foreign' || script === 'outdated') {
    return script;
  }
  if (script === 'current') {
    return sudoAllows ? 'installed' : 'partial';
  }
  return sudoAllows ? 'partial' : 'not installed';
}

async function checkFlow(def: Installable, plan: InstallPlan, env: InstallEnv, io: FlowIo): Promise<FlowResult> {
  // The rule is in a root-only folder: --check never asks for a password, it asks sudo (-n: never prompts) whether the command is allowed.
  const seen: Seen[] = [];
  for (const file of plan.files) {
    if (file.rootOnly) {
      seen.push({ file, read: false, cls: undefined, found: undefined });
      continue;
    }
    let found: string | undefined;
    try {
      found = env.fs.readText(file.path);
    } catch (e) {
      throw new InstallError(`${(e as Error).message}: check the permissions of that path`);
    }
    seen.push({ file, read: true, cls: classifyInstalled(file, found), found });
  }
  const probe = await env.exec(plan.probe);
  const allowed = probe.code === 0;
  const script = seen.find((s) => !s.file.rootOnly) as Seen;
  const scriptState = (script.cls as InstalledClass).state;
  const state = checkState(scriptState, allowed);
  const command = plan.probe.join(' ');
  io.say(`${def.id} on ${env.platform}: ${state}\n`);
  for (const s of seen) {
    if (s.read) {
      io.say(`${stateLine(s, false)}\n`);
    }
    else io.say(`  ${s.file.path}: ${allowed ? 'sudo lists the command without a password' : 'sudo does not list the command without a password (or it would ask one)'} (\`${command}\`); the content of this root-only file is not compared here: \`machine install ${def.id}\` compares it, with your sudo password\n`);
  }
  if (state === 'not installed') {
    io.say(`install it with: machine install ${def.id}\n`);
  }
  if (state === 'outdated') {
    io.say(`replace it with: machine install ${def.id}\n`);
  }
  if (state === 'partial') {
    io.say(`finish it with: machine install ${def.id}  (it writes what is missing)\n`);
  }
  if (state === 'foreign') {
    io.say(`${script.file.path} was not written by machine: it is never touched; ${`sudo rm -- ${script.file.path}`} removes it when you do not need it\n`);
  }
  return { exit: state === 'installed' ? 0 : 1, document: { id: def.id, action: 'check', platform: env.platform, state, files: documentFiles(seen), sudoAllowsCommand: allowed } };
}

// ---------------------------------------------------------------- install

function selectSteps(plan: InstallPlan, todo: PlannedFile[]): InstallPlan['steps'] {
  const ids = new Set(todo.map((f) => f.id));
  return plan.steps.filter((s) => ids.has(s.file));
}

async function installFlow(def: Installable, plan: InstallPlan, env: InstallEnv, io: FlowIo, options: FlowOptions): Promise<FlowResult> {
  io.say(`machine install ${def.id}: ${def.description}\nthis machine: ${env.platform}, user ${env.userName()}, systemctl ${plan.probe[3] ?? '?'}, sudo ${plan.probe[0] ?? '?'}\n\n`);
  const seen = await inspect(env, plan, io, !options.dryRun);
  refuseForeign(def, seen);
  const todo = seen.filter((s) => !s.read || (s.cls as InstalledClass).state !== 'current').map((s) => s.file);
  const base = { id: def.id, action: 'install', platform: env.platform, dryRun: options.dryRun, files: documentFiles(seen) };
  io.say(`state:\n${seen.map((s) => stateLine(s, options.dryRun)).join('\n')}\n`);
  const nextLines = (): void => {
    io.say(`\n${def.next(plan, nameOf(options)).join('\n')}\n`);
    for (const w of missingNameWarning(options)) io.warn(`${w}\n`);
  };
  if (todo.length === 0) {
    io.say(`\n[ok] ${def.id} is already installed, up to date: nothing to do\n`);
    nextLines();
    return { exit: 0, document: { ...base, state: 'installed', applied: false } };
  }
  const steps = selectSteps(plan, todo);
  io.say(`\nfiles that will be written (root-owned):\n${todo.flatMap((f) => fileBlock(f)).join('\n')}\n`);
  const outdated = seen.filter((s) => s.read && (s.cls as InstalledClass).state === 'outdated');
  if (outdated.length > 0) {
    io.say(`\n${outdated.map((s) => `the installed ${s.file.path} (sha256 ${short(s.cls?.sha256)}) will be REPLACED by the one this build ships (sha256 ${short(s.file.sha256)})`).join('\n')}\n`);
  }
  io.say(`\ncommands that will run (sudo asks YOUR password, in this terminal: machine never sees it):\n${stepLines(steps.map((s) => (s.kind === 'stage' ? { describe: `${s.describe} (<temp dir>/${s.file})` } : { describe: s.describe, command: display(s.argv, undefined) }))).join('\n')}\n`);
  io.say(`\n${def.consequence}\n`);
  if (options.dryRun) {
    io.say('\n[ok] dry run: nothing was changed, no command was run\n');
    return { exit: 0, document: { ...base, state: 'not applied', applied: false, steps: steps.map((s) => ({ describe: s.describe, ...(s.kind === 'run' ? { command: display(s.argv, undefined) } : {}) })) } };
  }
  if (!options.yes && !(await io.confirm('\nApply this plan? [y/N] '))) {
    io.say('\ncancelled: nothing was changed\n');
    return { exit: 1, document: { ...base, state: 'cancelled', applied: false } };
  }
  const installed: string[] = [];
  const dir = env.fs.makeTempDir();
  try {
    for (const step of steps) {
      if (step.kind === 'stage') {
        const file = plan.files.find((f) => f.id === step.file) as PlannedFile;
        env.fs.writeFile(`${dir}/${file.id}`, file.content, parseInt(file.mode, 8));
        continue;
      }
      const argv = step.argv.map((a) => (typeof a === 'string' ? a : `${dir}/${a.stage}`));
      io.say(`\n${step.describe}\n  $ ${display(step.argv, dir)}\n`);
      const r = await env.exec(argv);
      if (r.code !== 0) {
        const state = installed.length === 0 ? 'nothing was installed.' : `${installed.join(' and ')} ${installed.length === 1 ? 'is' : 'are'} installed (the rest is not): run the command again to finish, or \`machine install ${def.id} --remove\` to remove it.`;
        throw new InstallError(`${failureText(`step failed: ${step.describe}`, display(step.argv, dir), r)}\n  state: ${state}\n  fix: ${step.fix}`);
      }
      if (step.purpose === 'install') {
        installed.push((plan.files.find((f) => f.id === step.file) as PlannedFile).path);
      }
    }
  } finally {
    env.fs.removeDir(dir);
  }
  const probe = await env.exec(plan.probe);
  if (probe.code !== 0) {
    io.say(`\n[fail] installed, but sudo does not list the command without a password: \`${plan.probe.join(' ')}\` exited ${probe.code ?? 'abnormally'}${probe.stderr.trim() === '' ? '' : ` (${visible(probe.stderr, 300)})`}. Another sudoers rule may override the new one (the LAST matching rule wins; list them with \`sudo -l\`), or sudo does not read /etc/sudoers.d here\n`);
    return { exit: 1, document: { ...base, state: 'installed, not verified', applied: true } };
  }
  io.say(`\n[ok] ${def.id} installed and verified (sudo lists the command without a password)\n`);
  nextLines();
  return { exit: 0, document: { ...base, state: 'installed', applied: true, nextSteps: def.next(plan, nameOf(options)) } };
}

// ---------------------------------------------------------------- remove

async function removeFlow(def: Installable, plan: InstallPlan, env: InstallEnv, io: FlowIo, options: FlowOptions): Promise<FlowResult> {
  io.say(`machine install ${def.id} --remove\n\n`);
  const seen = await inspect(env, plan, io, !options.dryRun);
  refuseForeign(def, seen);
  const present = seen.filter((s) => !s.read || (s.cls as InstalledClass).state !== 'absent');
  const base = { id: def.id, action: 'remove', platform: env.platform, dryRun: options.dryRun, files: documentFiles(seen) };
  io.say(`state:\n${seen.map((s) => stateLine(s, options.dryRun)).join('\n')}\n`);
  if (present.length === 0) {
    io.say(`\n[ok] ${def.id} is not installed: nothing to remove\n`);
    return { exit: 0, document: { ...base, state: 'not installed', applied: false } };
  }
  const ids = new Set(present.map((s) => s.file.id));
  const steps = plan.removeSteps.filter((s) => ids.has(s.file));
  io.say(`\nfiles that will be removed (all written by machine):\n${present.flatMap((s) => fileBlock({ ...s.file, content: s.found ?? s.file.content })).join('\n')}\n`);
  io.say(`\ncommands that will run (sudo asks YOUR password, in this terminal: machine never sees it):\n${stepLines(steps.map((s) => ({ describe: s.describe, command: display(s.argv, undefined) }))).join('\n')}\n`);
  if (options.dryRun) {
    io.say('\n[ok] dry run: nothing was changed, no command was run\n');
    return { exit: 0, document: { ...base, state: 'not applied', applied: false } };
  }
  if (!options.yes && !(await io.confirm('\nRemove these files? [y/N] '))) {
    io.say('\ncancelled: nothing was changed\n');
    return { exit: 1, document: { ...base, state: 'cancelled', applied: false } };
  }
  const removed: string[] = [];
  for (const step of steps) {
    const argv = step.argv.map((a) => (typeof a === 'string' ? a : ''));
    io.say(`\n${step.describe}\n  $ ${display(step.argv, undefined)}\n`);
    const r = await env.exec(argv);
    if (r.code !== 0) {
      const state = removed.length === 0 ? 'nothing was removed.' : `${removed.join(' and ')} ${removed.length === 1 ? 'was' : 'were'} removed (the rest is still there): run the command again.`;
      throw new InstallError(`${failureText(`step failed: ${step.describe}`, display(step.argv, undefined), r)}\n  state: ${state}\n  fix: ${step.fix}`);
    }
    removed.push((plan.files.find((f) => f.id === step.file) as PlannedFile).path);
  }
  io.say(`\n[ok] ${def.id} removed: ${removed.join(', ')}\n\n${def.afterRemove(plan, nameOf(options)).join('\n')}\n`);
  for (const w of missingNameWarning(options)) io.warn(`${w}\n`);
  return { exit: 0, document: { ...base, state: 'not installed', applied: true, removed } };
}
