import {
  IDLE_SUSPEND_SCRIPT_PATH,
  INSTALLABLES,
  InstallError,
  classifyInstalled,
  deriveInstallState,
  idleSuspendInstalledMinutes,
  platformName,
  stateLabel,
  stateNextSteps,
  unsupportedMessage,
  type FileObservation,
  type InstallFacts,
  type InstallPlan,
  type InstallState,
  type InstalledClass,
  type Installable,
  type PlannedFile,
} from '@wadeck-app/machine-core';
import type { InstallEnv } from './installEnv.js';

// The STATUS of an installable on this machine (install.md, "Lifecycle"): read-only, never asks a password, never changes a file.
// Used by `machine install` (the list), `machine install status`, `<id> --check` and the one line of `machine status`.

/** What the outside world answered for the user-readable files; the root-only ones are not read (their content needs sudo with a password). */
export interface Seen {
  file: PlannedFile;
  /** False when the file was not read (a root-only file, or a dry run). */
  read: boolean;
  cls: InstalledClass | undefined;
  found: string | undefined;
}

const VISIBLE_MAX = 80;

/** What a child process wrote, safe for a terminal: control characters (escape sequences) are replaced, the length is bounded. */
export function visible(text: string, max = 2000): string {
  const trimmed = text.trim();
  const cut = trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed;
  return cut.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '?');
}

async function toolPath(env: InstallEnv, tool: string, missing: string): Promise<string> {
  const r = await env.exec(['sh', '-c', `command -v ${tool}`]);
  const found = r.code === 0 ? r.stdout.trim() : '';
  if (found === '') {
    throw new InstallError(missing);
  }
  if (!found.startsWith('/')) {
    throw new InstallError(`\`command -v ${tool}\` answered ${JSON.stringify(visible(found, VISIBLE_MAX))}, which is not an absolute path (a shell function or alias?): the path is written into a script that runs with a scrubbed environment, so it must be absolute. Install the real ${tool} or fix your shell profile`);
  }
  return found;
}

/** An optional tool: its absolute path, undefined when it is not there (the plan that needs it says so). */
async function optionalToolPath(env: InstallEnv, tool: string): Promise<string | undefined> {
  const r = await env.exec(['sh', '-c', `command -v ${tool}`]);
  const found = r.code === 0 ? r.stdout.trim() : '';
  return found.startsWith('/') ? found : undefined;
}

/** The facts of this machine that the plans are built from. Throws `InstallError` (cause and fix) when a tool is missing. */
export async function measure(env: InstallEnv): Promise<InstallFacts> {
  const systemctlPath = await toolPath(env, 'systemctl', 'systemctl was not found on this machine (`command -v systemctl` found nothing): `machine install suspend` needs systemd, because suspending is `systemctl suspend`. Nothing was changed');
  const sudoPath = await toolPath(env, 'sudo', 'sudo was not found on this machine (`command -v sudo` found nothing): machine installs root-owned files through sudo, with your own password. Install sudo (as root, with your package manager) and run the command again. Nothing was changed');
  const base: InstallFacts = { platform: env.platform, userName: env.userName(), systemctlPath, sudoPath };
  if (env.platform !== 'linux') {
    return base;
  }
  // What idle-suspend needs besides systemctl and sudo; a missing one is reported by that plan only (suspend does not need them).
  const [date, ss, systemdInhibit, logger, journalctl] = await Promise.all(['date', 'ss', 'systemd-inhibit', 'logger', 'journalctl'].map((t) => optionalToolPath(env, t)));
  const tools = { ...(date === undefined ? {} : { date }), ...(ss === undefined ? {} : { ss }), ...(systemdInhibit === undefined ? {} : { systemdInhibit }), ...(logger === undefined ? {} : { logger }), ...(journalctl === undefined ? {} : { journalctl }) };
  // Without --minutes the script keeps the minutes it was installed with (so that a status does not call it outdated).
  let installedMinutes: number | undefined;
  if (env.context?.minutes === undefined) {
    try {
      const text = env.fs.readText(IDLE_SUSPEND_SCRIPT_PATH);
      installedMinutes = text === undefined ? undefined : idleSuspendInstalledMinutes(text);
    } catch {
      // Unreadable: the status of the item reports it, with its cause.
      installedMinutes = undefined;
    }
  }
  return {
    ...base,
    tools,
    ...(env.context === undefined ? {} : { configDir: env.context.configDir }),
    ...(env.context?.minutes === undefined ? {} : { minutes: env.context.minutes }),
    ...(installedMinutes === undefined ? {} : { installedMinutes }),
  };
}

/** Reads the user-readable files; a root-only file is `unread` here. */
export function observeReadable(env: InstallEnv, plan: InstallPlan): Seen[] {
  return plan.files.map((file) => {
    if (file.rootOnly) {
      return { file, read: false, cls: undefined, found: undefined };
    }
    let found: string | undefined;
    try {
      found = env.fs.readText(file.path);
    } catch (e) {
      throw new InstallError(`${(e as Error).message}: check the permissions of that path (machine reads it to know whether it wrote it); nothing was changed`);
    }
    return { file, read: true, cls: classifyInstalled(file, found), found };
  });
}

export const observationOf = (s: Seen): FileObservation => (s.read ? (s.cls as InstalledClass).state : 'unread');

/** One file of a status document: `state` is a class (absent, current, outdated, foreign) or what sudo said about the root-only ones. */
export interface FileStatus {
  id: string;
  path: string;
  state: string;
  sha256?: string;
  shippedSha256: string;
}

export interface ItemStatus {
  id: string;
  description: string;
  platforms: string[];
  supportedHere: boolean;
  state: InstallState;
  /** Why this machine cannot install it (state `unsupported here`). */
  reason?: string;
  files: FileStatus[];
  /** The parts that are not there (state `partial` or `not installed`). */
  missing: string[];
  /** The answer of the non-prompting probe; undefined when it was not asked. */
  sudoAllowsCommand?: boolean;
  nextSteps: string[];
  /** What is configured and the last decision of the item (`suspends after 30 min idle`, `last decision: ...`). */
  details?: string[];
  /** The last decision line of the journal, when it was read. */
  lastDecision?: string;
}

export const LISTED_BY_SUDO = 'listed by sudo';
export const NOT_LISTED_BY_SUDO = 'not listed by sudo';
export const NOT_READ = 'not read';

export function fileStatuses(seen: Seen[], sudoAllows: boolean | undefined): FileStatus[] {
  return seen.map((s) => {
    const state = s.read ? (s.cls as InstalledClass).state : sudoAllows === undefined ? NOT_READ : sudoAllows ? LISTED_BY_SUDO : NOT_LISTED_BY_SUDO;
    return { id: s.file.id, path: s.file.path, state, ...(s.cls?.sha256 === undefined ? {} : { sha256: s.cls.sha256 }), shippedSha256: s.file.sha256 };
  });
}

export interface StatusRead {
  status: ItemStatus;
  plan: InstallPlan;
  seen: Seen[];
}

/**
 * The state of one installable whose plan is built. `sudoProbe` runs `sudo -n -l <command>` (never prompts, changes nothing): without it the root-only
 * files are left out of the verdict, so `partial` cannot be told from `installed`.
 */
export async function readStatus(def: Installable, plan: InstallPlan, env: InstallEnv, sudoProbe: boolean): Promise<StatusRead> {
  const seen = observeReadable(env, plan);
  const hasRootOnly = seen.some((s) => !s.read);
  const sudoAllows = sudoProbe && hasRootOnly ? (await env.exec(plan.probe)).code === 0 : undefined;
  const verdict = deriveInstallState(
    seen.map((s) => ({ path: s.file.path, rootOnly: s.file.rootOnly, observed: observationOf(s) })),
    sudoAllows,
  );
  const foreign = seen.filter((s) => s.cls?.state === 'foreign').map((s) => s.file.path);
  let state: InstallState = verdict.state;
  let missing = verdict.missing;
  let nextSteps = stateNextSteps(def.id, verdict.state, foreign);
  // An item that runs as a systemd unit is installed only when the unit runs (a timer disabled by hand leaves every file current).
  if (state === 'installed' && plan.service !== undefined && (await env.exec(plan.probe)).code !== 0) {
    state = 'partial';
    missing = [`${plan.service.unit} is not running (systemctl is-active)`];
    nextSteps = [`machine install ${def.id} --refresh`];
  }
  const details: string[] = plan.summary === undefined ? [] : [plan.summary];
  let lastDecision: string | undefined;
  if (plan.lastDecisionArgv !== undefined && state !== 'not installed' && state !== 'foreign') {
    lastDecision = await readLastDecision(env, plan.lastDecisionArgv);
    details.push(lastDecision === undefined ? `last decision: not readable by your user (try: sudo ${plan.lastDecisionArgv.join(' ')})` : `last decision: ${lastDecision}`);
  }
  const status: ItemStatus = {
    id: def.id,
    description: def.description,
    platforms: def.platforms,
    supportedHere: true,
    state,
    files: fileStatuses(seen, sudoAllows),
    missing,
    ...(sudoAllows === undefined ? {} : { sudoAllowsCommand: sudoAllows }),
    nextSteps,
    ...(details.length === 0 ? {} : { details }),
    ...(lastDecision === undefined ? {} : { lastDecision }),
  };
  return { status, plan, seen };
}

/** The last line the item wrote to the journal; undefined when it cannot be read or there is none. A failure is never an error of the status. */
async function readLastDecision(env: InstallEnv, argv: string[]): Promise<string | undefined> {
  try {
    const r = await env.exec(argv);
    const line = r.code === 0 ? (r.stdout.trim().split('\n').pop() ?? '').trim() : '';
    return line === '' || line.startsWith('--') ? undefined : visible(line, 300);
  } catch {
    return undefined;
  }
}

const unsupported = (def: Installable, reason: string, supportedHere: boolean): ItemStatus => ({
  id: def.id,
  description: def.description,
  platforms: def.platforms,
  supportedHere,
  state: 'unsupported here',
  reason,
  files: [],
  missing: [],
  nextSteps: [],
});

/**
 * The status of EVERY installable, for `machine install` and `machine install status`. One item that cannot be installed here (platform, a missing
 * tool, a user name that cannot be written) is reported `unsupported here` with the reason, never an error of the list.
 */
export async function listStatuses(env: InstallEnv): Promise<ItemStatus[]> {
  const out: ItemStatus[] = [];
  for (const def of INSTALLABLES) {
    if (!def.platforms.includes(env.platform)) {
      out.push(unsupported(def, unsupportedMessage(def, env.platform), false));
      continue;
    }
    let plan: InstallPlan;
    try {
      plan = def.plan(await measure(env));
    } catch (refusal) {
      if (!(refusal instanceof InstallError)) {
        throw refusal;
      }
      out.push(unsupported(def, refusal.message, false));
      continue;
    }
    out.push((await readStatus(def, plan, env, true)).status);
  }
  return out;
}

/** One line per item for the list and `install status`. */
export function statusBlock(s: ItemStatus, platform: string): string[] {
  const here = s.supportedHere ? `supported on this machine (${platformName(platform)})` : `not supported here`;
  const lines = [`  ${s.id}   platforms: ${s.platforms.join(', ')}   ${here}`, `      ${s.description}`, `      state: ${stateLabel(s.state)}`];
  if (s.reason !== undefined) {
    lines.push(`      why: ${s.reason}`);
  }
  if (s.missing.length > 0 && s.state === 'partial') {
    lines.push(`      missing: ${s.missing.join(', ')}`);
  }
  for (const detail of s.details ?? []) {
    lines.push(`      ${detail}`);
  }
  if (s.nextSteps.length > 0) {
    lines.push(`      next: ${s.nextSteps.join(' ; ')}`);
  }
  return lines;
}

/**
 * The lines of `machine status` for the installed items: read-only, no sudo at all (the root-only files are not asked about), nothing for an item that is
 * not installed here. An item whose plan cannot be built on this machine (platform, a missing tool) has nothing installed by this build: nothing printed.
 */
export async function installedStatusLines(env: InstallEnv): Promise<{ lines: string[]; items: Array<{ id: string; state: InstallState }> }> {
  const lines: string[] = [];
  const items: Array<{ id: string; state: InstallState }> = [];
  for (const def of INSTALLABLES) {
    if (!def.platforms.includes(env.platform)) {
      continue;
    }
    let plan: InstallPlan;
    try {
      plan = def.plan(await measure(env));
    } catch (e) {
      if (!(e instanceof InstallError)) {
        throw e;
      }
      continue;
    }
    try {
      const { status } = await readStatus(def, plan, env, false);
      if (status.state === 'installed') {
        lines.push(`installed: ${def.id} (up to date${(status.details ?? []).map((d) => `; ${d}`).join('')})`);
        items.push({ id: def.id, state: status.state });
      } else if (status.state === 'outdated') {
        lines.push(`[warn] installed: ${def.id} is outdated: run machine install ${def.id} --refresh`);
        items.push({ id: def.id, state: status.state });
      } else if (status.state === 'partial') {
        lines.push(`[warn] installed: ${def.id} is incomplete (${status.missing.join(', ')}): run ${status.nextSteps[0] ?? `machine install ${def.id}`}`);
        items.push({ id: def.id, state: status.state });
      }
    } catch (e) {
      lines.push(`[warn] installed items: ${def.id} not read: ${(e as Error).message}`);
    }
  }
  return { lines, items };
}
