import { createHash } from 'node:crypto';
import {
  IDLE_DEFAULT_MINUTES,
  IDLE_RDP_DEFAULT_MINUTES,
  IDLE_SSH_DEFAULT_MINUTES,
  IDLE_DEFAULT_RUNUSER,
  IDLE_DEFAULT_LOGINCTL,
  IDLE_DEFAULT_XPRINTIDLE,
  IDLE_KEEP_AWAKE_RUN,
  IDLE_LOG_TAG,
  IDLE_MAX_MINUTES,
  IDLE_MIN_MINUTES,
  IDLE_SUSPEND_SCRIPT_PATH,
  IDLE_SUSPEND_SERVICE_PATH,
  IDLE_SUSPEND_TIMER_PATH,
  IDLE_SUSPEND_TIMER_UNIT,
  IDLE_SUSPEND_VERSION,
  idleSuspendScript,
  idleSuspendServiceUnit,
  idleSuspendTimerUnit,
  isSafeAbsolutePath,
} from './idleSuspend.js';

// `machine install <id>` (install.md): the registry of what `machine` can install on the machine it runs on, and for each item a PLAN function.
// Pure: no file, no process, no prompt. A plan is DATA (the files to write with their exact content, the commands to run, what the owner does
// next) built from facts the caller measured (platform, user name, absolute tool paths). The executor in machine-cli runs it with an injected
// fs and exec. To add an installable: write its `Installable` (one `plan` function per platform it supports) and push it to INSTALLABLES.

/** A refusal with its cause and fix in the message: printed as is by the command. */
export class InstallError extends Error {}

/** Facts about the machine, measured by the executor (never read here). */
export interface InstallFacts {
  /** `process.platform`: linux, win32, darwin... */
  platform: string;
  /** The user that runs `machine install`: the one the rule is written for. */
  userName: string;
  /** Absolute path of systemctl (`command -v systemctl`). */
  systemctlPath: string;
  /** Absolute path of sudo (`command -v sudo`). */
  sudoPath: string;
  /** The configuration folder of machine of this owner (for the items that read it: idle-suspend). */
  configDir?: string;
  /** `--minutes` of `machine install idle-suspend`. */
  minutes?: number;
  /** The minutes written in the script already installed (so that a status does not call a script with other minutes outdated). */
  installedMinutes?: number;
  /** `--rdp-minutes` of `machine install idle-suspend` (decision 103), and the one written in the script already installed. */
  rdpMinutes?: number;
  installedRdpMinutes?: number;
  /** `--ssh-minutes` of `machine install idle-suspend` (decision 109), and the one written in the script already installed. */
  sshMinutes?: number;
  installedSshMinutes?: number;
  /** Absolute paths of optional tools (`command -v`), absent when not found. */
  tools?: { date?: string; ss?: string; systemdInhibit?: string; logger?: string; journalctl?: string; xprintidle?: string; runuser?: string; loginctl?: string };
}

/** The only user names written into a root-owned file: lowercase letters, digits, `_` and `-`, at most 32, never starting with a digit or `-`. */
export const INSTALL_USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

/** An absolute path written into a script and a sudoers line: no space, comma, colon, equal sign, backslash or control character. */
const SAFE_ABSOLUTE_PATH = /^\/[A-Za-z0-9._+/-]*$/;

/** One command argument: text, or the path of a staged (temporary) file the executor writes first. */
export type PlanArg = string | { stage: string };

/** A file the install leaves on the machine, with its exact content. */
export interface PlannedFile {
  /** Stable id inside the plan: `script`, `sudoers`. */
  id: string;
  /** The installable that owns the file: its id is in the marker line. */
  installable: string;
  path: string;
  /** Octal text, as given to `install -m`. */
  mode: string;
  owner: string;
  group: string;
  content: string;
  sha256: string;
  describe: string;
  /** True when the owner running the command cannot read it (a root-only folder): it is read through `rootReadArgv`. */
  rootOnly: boolean;
}

export interface StageStep {
  kind: 'stage';
  /** The planned file whose content is written to a temporary file (mode 0440 or 0755 as the file, owned by the user). */
  file: string;
  describe: string;
}

export interface RunStep {
  kind: 'run';
  purpose: 'validate' | 'install' | 'remove' | 'activate';
  /** The planned file this step is about: a step is skipped when that file is already up to date. */
  file: string;
  argv: PlanArg[];
  describe: string;
  /** What the owner does when this step fails. */
  fix: string;
}

export type PlanStep = StageStep | RunStep;

export interface InstallPlan {
  id: string;
  /** The version of the content this build ships; part of the marker line. */
  version: number;
  platform: string;
  files: PlannedFile[];
  steps: PlanStep[];
  removeSteps: RunStep[];
  /** A command that exits 0 when the machine behaves as installed (`sudo -n -l ...`, `systemctl is-active ...`): it never prompts. */
  probe: string[];
  /** The tools the plan runs through sudo, for the lines that name them. */
  tools: { sudo: string; systemctl: string };
  /** Set when the probe asks a systemd unit (no sudo): a status of `installed` is then confirmed by it, and the messages speak of the unit. */
  service?: { unit: string };
  /** The configuration folder the item reads (idle-suspend), for the lines that name it. */
  configDir?: string;
  /** One short line of what is configured (`suspends after 30 min idle`), for the status. */
  summary?: string;
  /** Lines the status and the install show besides the summary (what this machine lacks for the item to work fully). */
  notes?: string[];
  /** A command that prints the last decision of the item (journal): read by the status, its failure is never an error. */
  lastDecisionArgv?: string[];
}

export interface Installable {
  id: string;
  description: string;
  /** What it does in at most 80 characters: the second line of the list (the long `description` is in `--dry-run` and `--help`). */
  summaryLine: string;
  /** `process.platform` values this build can install on. */
  platforms: string[];
  /** What the owner accepts by installing AND allowing it: printed in the help and in the output. */
  consequence: string;
  /** Throws `InstallError` on an unsupported platform or a fact that cannot be written safely. */
  plan: (facts: InstallFacts) => InstallPlan;
  /** The lines to print after a success: what was installed, how to test, what to allow on the admin machine, how to use. */
  next: (plan: InstallPlan, machineName: string) => string[];
  /** The lines to print after a removal: what to withdraw on the admin machine. */
  afterRemove: (plan: InstallPlan, machineName: string) => string[];
}

export type InstalledState = 'absent' | 'foreign' | 'current' | 'outdated';

export interface InstalledClass {
  state: InstalledState;
  /** Hash of what is there (not for `absent`). */
  sha256?: string;
  /** The version in the marker of an outdated file. */
  version?: number;
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export const markerLine = (id: string, version: number): string => `# managed by machine install ${id}, version ${version}`;

const FRIENDLY: Record<string, string> = { win32: 'windows', darwin: 'macos' };
export const platformName = (platform: string): string => FRIENDLY[platform] ?? platform;

export function unsupportedMessage(def: Installable, platform: string): string {
  return `not supported on ${platformName(platform)} yet (supported: ${def.platforms.map(platformName).join(', ')})`;
}

/** Exit code of `rootReadArgv` for a file that does not exist (sudo itself answers 1 when it fails: the two never mix). */
export const ROOT_READ_ABSENT = 3;

/** Reads a file as root; exits `ROOT_READ_ABSENT` when it is not there. The path is a constant of a plan, passed as an argument, never spliced into the script. */
export const rootReadArgv = (sudoPath: string, path: string): string[] => [sudoPath, 'sh', '-c', 'test -e "$1" || exit 3; cat -- "$1"', 'machine-install', path];

/** What is at a planned path: nothing, a file machine did not write (no marker of this installable), the shipped content, or an older managed one. */
export function classifyInstalled(file: PlannedFile, found: string | undefined): InstalledClass {
  if (found === undefined) {
    return { state: 'absent' };
  }
  const sha256 = sha256Hex(found);
  const marker = new RegExp(`^# managed by machine install ${file.installable}, version (\\d+)$`, 'm').exec(found);
  if (marker === null) {
    return { state: 'foreign', sha256 };
  }
  if (sha256 === file.sha256) {
    return { state: 'current', sha256 };
  }
  return { state: 'outdated', sha256, version: Number(marker[1]) };
}

// ---------------------------------------------------------------- lifecycle: the states (install.md, "Lifecycle")

/**
 * The state of an installable on this machine. These names are part of the `--json` documents and of the exit-code rule (0 only for `installed`):
 * never rename one.
 */
export type InstallState = 'not installed' | 'installed' | 'outdated' | 'partial' | 'foreign' | 'unsupported here';

/** What was seen of one planned file: `unread` is a root-only file that was not read (its content needs sudo with a password). */
export type FileObservation = InstalledState | 'unread';

export interface ObservedFile {
  path: string;
  rootOnly: boolean;
  observed: FileObservation;
}

/**
 * The verdict over every file of a plan. `sudoLists` answers the non-prompting probe (`sudo -n -l <command>`) for the root-only files that were not
 * read; undefined when it was not asked (then those files are left out of the verdict). A foreign file wins over everything (it is never touched),
 * then an outdated one; otherwise installed needs every part, not installed needs none, anything between is partial with the missing parts named.
 */
export function deriveInstallState(files: ObservedFile[], sudoLists: boolean | undefined): { state: Exclude<InstallState, 'unsupported here'>; missing: string[] } {
  if (files.some((f) => f.observed === 'foreign')) {
    return { state: 'foreign', missing: [] };
  }
  if (files.some((f) => f.observed === 'outdated')) {
    return { state: 'outdated', missing: [] };
  }
  const counted = sudoLists === undefined ? files.filter((f) => f.observed !== 'unread') : files;
  const missing = counted.filter((f) => (f.observed === 'unread' ? sudoLists !== true : f.observed === 'absent')).map((f) => f.path);
  if (missing.length === 0) {
    return { state: 'installed', missing };
  }
  return { state: missing.length === counted.length ? 'not installed' : 'partial', missing };
}

/** The state as a person reads it: `installed` alone does not say that the content is the one this build ships. */
export function stateLabel(state: InstallState): string {
  if (state === 'installed') {
    return 'installed, up to date';
  }
  return state === 'outdated' ? 'outdated (this build ships newer content)' : state;
}

/** The command that moves a state forward (empty for installed and unsupported). `foreignPaths` are the files machine will not touch. */
export function stateNextSteps(id: string, state: InstallState, foreignPaths: string[]): string[] {
  if (state === 'not installed' || state === 'partial') {
    return [`machine install ${id}`];
  }
  if (state === 'outdated') {
    return [`machine install ${id} --refresh`];
  }
  if (state === 'foreign') {
    return [...foreignPaths.map((p) => `sudo rm -- ${p}   (after reading it: machine never touches a file it did not write)`), `machine install ${id}`];
  }
  return [];
}

// ---------------------------------------------------------------- suspend (linux)

const SUSPEND_VERSION = 1;
const SUSPEND_SCRIPT = '/usr/local/bin/machine-suspend';
const SUSPEND_SUDOERS = '/etc/sudoers.d/machine-suspend';

function suspendPlan(facts: InstallFacts): InstallPlan {
  if (!SUSPEND.platforms.includes(facts.platform)) {
    throw new InstallError(unsupportedMessage(SUSPEND, facts.platform));
  }
  if (!INSTALL_USER_PATTERN.test(facts.userName)) {
    throw new InstallError(
      `the user name ${JSON.stringify(facts.userName.slice(0, 40))} cannot be written into a sudoers file by machine (accepted: lowercase letters, digits, "_" and "-", at most 32, not starting with a digit or "-"): run \`machine install suspend\` from an account with such a name, or write the rule by hand`,
    );
  }
  for (const [what, value] of [['systemctl', facts.systemctlPath], ['sudo', facts.sudoPath]] as const) {
    if (!SAFE_ABSOLUTE_PATH.test(value) || value.includes('//') || value.endsWith('/')) {
      throw new InstallError(`the path of ${what} ${JSON.stringify(value.slice(0, 80))} cannot be written into a script and a sudoers line (it must be absolute, with letters, digits and . _ + - / only): check \`command -v ${what}\``);
    }
  }
  const marker = markerLine('suspend', SUSPEND_VERSION);
  const script = [
    '#!/bin/sh',
    marker,
    '# Suspend this box 3 s after the call, so the caller still gets its answer.',
    '# Written by `machine install suspend`; `machine install suspend --remove` removes it.',
    `( sleep 3; exec ${facts.sudoPath} -n ${facts.systemctlPath} suspend ) >/dev/null 2>&1 &`,
    '',
  ].join('\n');
  const sudoers = [
    marker,
    '# Written by `machine install suspend`: this user may suspend this machine without a password (this one command, nothing else).',
    `${facts.userName} ALL=(root) NOPASSWD: ${facts.systemctlPath} suspend`,
    '',
  ].join('\n');
  const file = (id: string, path: string, mode: string, content: string, describe: string, rootOnly: boolean): PlannedFile => ({ id, installable: 'suspend', path, mode, owner: 'root', group: 'root', content, sha256: sha256Hex(content), describe, rootOnly });
  const sudo = facts.sudoPath;
  const installArgv = (mode: string, id: string, path: string): PlanArg[] => [sudo, 'install', '-m', mode, '-o', 'root', '-g', 'root', { stage: id }, path];
  const sudoersFix = `read the message of visudo above; the rule it checked is the single line "${facts.userName} ALL=(root) NOPASSWD: ${facts.systemctlPath} suspend" (see the temporary file named in the command while it exists)`;
  return {
    id: 'suspend',
    version: SUSPEND_VERSION,
    platform: facts.platform,
    files: [
      file('script', SUSPEND_SCRIPT, '0755', script, 'the script `machine run` starts: it suspends this machine 3 s later, so the caller still gets its answer', false),
      // /etc/sudoers.d is root-only on most distributions: the owner cannot even test that the file is there without sudo.
      file('sudoers', SUSPEND_SUDOERS, '0440', sudoers, `the sudo rule that lets ${facts.userName} run ${facts.systemctlPath} suspend (this exact command) without a password`, true),
    ],
    steps: [
      { kind: 'stage', file: 'script', describe: 'write the script to a temporary file (nothing is changed yet)' },
      { kind: 'stage', file: 'sudoers', describe: 'write the sudoers rule to a temporary file (nothing is changed yet)' },
      { kind: 'run', purpose: 'validate', file: 'sudoers', argv: [sudo, 'visudo', '-c', '-f', { stage: 'sudoers' }], describe: 'validate the sudoers rule with visudo before anything is installed', fix: sudoersFix },
      { kind: 'run', purpose: 'install', file: 'script', argv: installArgv('0755', 'script', SUSPEND_SCRIPT), describe: `install the script as ${SUSPEND_SCRIPT} (root-owned, mode 0755)`, fix: `check that /usr/local/bin exists and is writable by root, then run the command again` },
      { kind: 'run', purpose: 'install', file: 'sudoers', argv: installArgv('0440', 'sudoers', SUSPEND_SUDOERS), describe: `install the rule as ${SUSPEND_SUDOERS} (root-owned, mode 0440)`, fix: `check that /etc/sudoers.d exists (is sudo installed with a sudoers.d folder?), then run the command again; the script is already in place and harmless without the rule` },
    ],
    removeSteps: [
      { kind: 'run', purpose: 'remove', file: 'sudoers', argv: [sudo, 'rm', '--', SUSPEND_SUDOERS], describe: `remove the sudo rule ${SUSPEND_SUDOERS}`, fix: `remove it by hand: sudo rm -- ${SUSPEND_SUDOERS}` },
      { kind: 'run', purpose: 'remove', file: 'script', argv: [sudo, 'rm', '--', SUSPEND_SCRIPT], describe: `remove the script ${SUSPEND_SCRIPT}`, fix: `remove it by hand: sudo rm -- ${SUSPEND_SCRIPT}` },
    ],
    probe: [sudo, '-n', '-l', facts.systemctlPath, 'suspend'],
    tools: { sudo, systemctl: facts.systemctlPath },
  };
}

const SUSPEND: Installable = {
  id: 'suspend',
  description: 'let `machine run` suspend this machine (a root-owned script and a sudoers rule for ONE command: systemctl suspend); wake it with `machine wake`',
  summaryLine: 'lets `machine run` suspend this box (one sudoers rule); wake: `machine wake`',
  platforms: ['linux'],
  consequence:
    'Once the command is allowed in the DEFAULT list of this machine, every trusted peer can suspend it (a per-peer list restricts that: `machine policy allow --peer <machine>` in mode local). The rule itself only lets YOUR user run `systemctl suspend` without a password, nothing else.',
  plan: suspendPlan,
  next: (plan, machineName) => {
    const script = plan.files.find((f) => f.id === 'script');
    const sudoers = plan.files.find((f) => f.id === 'sudoers');
    const systemctl = plan.probe[3] ?? 'systemctl';
    return [
      'installed:',
      `  ${script?.path ?? SUSPEND_SCRIPT}   (root-owned script, mode 0755)`,
      `  ${sudoers?.path ?? SUSPEND_SUDOERS}   (root-owned sudo rule, mode 0440)`,
      '',
      'test it here WITHOUT suspending (it lists the command when sudo allows it without a password):',
      `  sudo -n -l ${systemctl} suspend`,
      '',
      'then, on the ADMIN machine, allow the script (the entry is exact, the shell is part of it):',
      `  machine admin allow ${machineName} --shell sh -- ${script?.path ?? SUSPEND_SCRIPT}`,
      '',
      'use it from a trusted machine (the connection answers first, the machine suspends 3 s later) and wake it:',
      `  machine run ${machineName} -- ${script?.path ?? SUSPEND_SCRIPT}`,
      `  machine wake ${machineName}`,
      '',
      `[warn] ${SUSPEND.consequence}`,
    ];
  },
  afterRemove: (plan, machineName) => [
    'on the ADMIN machine, withdraw the entry that allowed the script (it is useless now):',
    `  machine admin allow ${machineName} --shell sh --remove -- ${plan.files.find((f) => f.id === 'script')?.path ?? SUSPEND_SCRIPT}`,
  ],
};

// ---------------------------------------------------------------- idle-suspend (linux)

const missingTool = (what: string, pkg: string): InstallError =>
  new InstallError(`${what} was not found on this machine (\`command -v ${what}\` found nothing): \`machine install idle-suspend\` needs it to take its decision (it is part of ${pkg}). Install it with your package manager and run the command again. Nothing was changed`);

function idleSuspendPlan(facts: InstallFacts): InstallPlan {
  if (!IDLE_SUSPEND.platforms.includes(facts.platform)) {
    throw new InstallError(unsupportedMessage(IDLE_SUSPEND, facts.platform));
  }
  for (const [what, value] of [['systemctl', facts.systemctlPath], ['sudo', facts.sudoPath]] as const) {
    if (!isSafeAbsolutePath(value)) {
      throw new InstallError(`the path of ${what} ${JSON.stringify(value.slice(0, 80))} cannot be written into a script and a command (it must be absolute, with letters, digits and . _ + - / only): check \`command -v ${what}\``);
    }
  }
  const t = facts.tools ?? {};
  const date = t.date ?? (() => { throw missingTool('date', 'coreutils'); })();
  const ss = t.ss ?? (() => { throw missingTool('ss', 'iproute2'); })();
  const systemdInhibit = t.systemdInhibit ?? (() => { throw missingTool('systemd-inhibit', 'systemd'); })();
  const logger = t.logger ?? (() => { throw missingTool('logger', 'util-linux'); })();
  if (facts.configDir === undefined) {
    throw new InstallError('internal: the configuration folder of machine is unknown to `machine install idle-suspend` (the script reads the audit log there)');
  }
  const minutes = facts.minutes ?? facts.installedMinutes ?? IDLE_DEFAULT_MINUTES;
  const rdpMinutes = facts.rdpMinutes ?? facts.installedRdpMinutes ?? IDLE_RDP_DEFAULT_MINUTES;
  const sshMinutes = facts.sshMinutes ?? facts.installedSshMinutes ?? IDLE_SSH_DEFAULT_MINUTES;
  const script = idleSuspendScript({ minutes, rdpMinutes, sshMinutes, root: '', configDir: facts.configDir, tools: { date, ss, systemdInhibit, logger, systemctl: facts.systemctlPath, loginctl: t.loginctl ?? IDLE_DEFAULT_LOGINCTL, runuser: t.runuser ?? IDLE_DEFAULT_RUNUSER, xprintidle: t.xprintidle ?? IDLE_DEFAULT_XPRINTIDLE } });
  const service = idleSuspendServiceUnit();
  const timer = idleSuspendTimerUnit();
  const file = (id: string, path: string, mode: string, content: string, describe: string): PlannedFile => ({ id, installable: 'idle-suspend', path, mode, owner: 'root', group: 'root', content, sha256: sha256Hex(content), describe, rootOnly: false });
  const sudo = facts.sudoPath;
  const systemctl = facts.systemctlPath;
  const installArgv = (mode: string, id: string, path: string): PlanArg[] => [sudo, 'install', '-m', mode, '-o', 'root', '-g', 'root', { stage: id }, path];
  const fixInstall = (dir: string): string => `check that ${dir} exists and is writable by root, then run the command again`;
  return {
    id: 'idle-suspend',
    version: IDLE_SUSPEND_VERSION,
    platform: facts.platform,
    files: [
      file('script', IDLE_SUSPEND_SCRIPT_PATH, '0755', script, `the check: every 2 minutes it suspends this machine when it has been idle for ${minutes} min (no machine peer connection, no ssh session with a terminal that had input in the last ${sshMinutes} min, the keyboard/mouse input idle for ${minutes} min (${rdpMinutes} min when an RDP connection is open), no machine request, load under 0.30, no sleep inhibitor, no keep-awake file)`),
      file('service', IDLE_SUSPEND_SERVICE_PATH, '0644', service, 'the systemd service that runs the script once (as root)'),
      file('timer', IDLE_SUSPEND_TIMER_PATH, '0644', timer, 'the systemd timer that starts the service 2 minutes after boot and every 2 minutes after'),
    ],
    steps: [
      { kind: 'stage', file: 'script', describe: 'write the script to a temporary file (nothing is changed yet)' },
      { kind: 'stage', file: 'service', describe: 'write the service unit to a temporary file (nothing is changed yet)' },
      { kind: 'stage', file: 'timer', describe: 'write the timer unit to a temporary file (nothing is changed yet)' },
      { kind: 'run', purpose: 'install', file: 'script', argv: installArgv('0755', 'script', IDLE_SUSPEND_SCRIPT_PATH), describe: `install the script as ${IDLE_SUSPEND_SCRIPT_PATH} (root-owned, mode 0755)`, fix: fixInstall('/usr/local/bin') },
      { kind: 'run', purpose: 'install', file: 'service', argv: installArgv('0644', 'service', IDLE_SUSPEND_SERVICE_PATH), describe: `install the service as ${IDLE_SUSPEND_SERVICE_PATH} (root-owned, mode 0644)`, fix: fixInstall('/etc/systemd/system') },
      { kind: 'run', purpose: 'install', file: 'timer', argv: installArgv('0644', 'timer', IDLE_SUSPEND_TIMER_PATH), describe: `install the timer as ${IDLE_SUSPEND_TIMER_PATH} (root-owned, mode 0644)`, fix: fixInstall('/etc/systemd/system') },
      { kind: 'run', purpose: 'activate', file: 'service', argv: [sudo, systemctl, 'daemon-reload'], describe: 'tell systemd to read the new units', fix: `run it by hand: sudo ${systemctl} daemon-reload; the files are already in place` },
      { kind: 'run', purpose: 'activate', file: 'timer', argv: [sudo, systemctl, 'enable', IDLE_SUSPEND_TIMER_UNIT], describe: 'enable the timer (it starts at every boot)', fix: `run it by hand: sudo ${systemctl} enable ${IDLE_SUSPEND_TIMER_UNIT}; the files are already in place` },
      { kind: 'run', purpose: 'activate', file: 'timer', argv: [sudo, systemctl, 'restart', IDLE_SUSPEND_TIMER_UNIT], describe: 'start the timer now (the idle counter starts from zero)', fix: `run it by hand: sudo ${systemctl} restart ${IDLE_SUSPEND_TIMER_UNIT}; see why with: ${systemctl} status ${IDLE_SUSPEND_TIMER_UNIT}` },
    ],
    removeSteps: [
      { kind: 'run', purpose: 'remove', file: 'timer', argv: [sudo, systemctl, 'disable', '--now', IDLE_SUSPEND_TIMER_UNIT], describe: 'stop and disable the timer', fix: `run it by hand: sudo ${systemctl} disable --now ${IDLE_SUSPEND_TIMER_UNIT}` },
      { kind: 'run', purpose: 'remove', file: 'timer', argv: [sudo, 'rm', '--', IDLE_SUSPEND_TIMER_PATH], describe: `remove the timer ${IDLE_SUSPEND_TIMER_PATH}`, fix: `remove it by hand: sudo rm -- ${IDLE_SUSPEND_TIMER_PATH}` },
      { kind: 'run', purpose: 'remove', file: 'service', argv: [sudo, 'rm', '--', IDLE_SUSPEND_SERVICE_PATH], describe: `remove the service ${IDLE_SUSPEND_SERVICE_PATH}`, fix: `remove it by hand: sudo rm -- ${IDLE_SUSPEND_SERVICE_PATH}` },
      { kind: 'run', purpose: 'remove', file: 'script', argv: [sudo, 'rm', '--', IDLE_SUSPEND_SCRIPT_PATH], describe: `remove the script ${IDLE_SUSPEND_SCRIPT_PATH}`, fix: `remove it by hand: sudo rm -- ${IDLE_SUSPEND_SCRIPT_PATH}` },
      { kind: 'run', purpose: 'remove', file: 'script', argv: [sudo, systemctl, 'daemon-reload'], describe: 'tell systemd the units are gone', fix: `run it by hand: sudo ${systemctl} daemon-reload` },
    ],
    probe: [systemctl, 'is-active', '--quiet', IDLE_SUSPEND_TIMER_UNIT],
    tools: { sudo, systemctl },
    service: { unit: IDLE_SUSPEND_TIMER_UNIT },
    configDir: facts.configDir,
    summary: `suspends after ${minutes} min idle (RDP: ${rdpMinutes} min, SSH: ${sshMinutes} min)`,
    // Read-only: the install never installs xprintidle (an RDP connection counts as activity until it is there).
    notes: [t.xprintidle === undefined ? 'xprintidle missing, input idleness is not checked, and an RDP connection counts as activity: sudo apt install xprintidle' : `xprintidle found at ${t.xprintidle}: the input idle time is checked (${minutes} min, ${rdpMinutes} min with an RDP connection)`],
    ...(t.journalctl === undefined ? {} : { lastDecisionArgv: [t.journalctl, '-t', IDLE_LOG_TAG, '-n', '1', '--no-pager', '-q', '-o', 'short-iso'] }),
  };
}

const IDLE_SUSPEND: Installable = {
  id: 'idle-suspend',
  description: `suspend this machine by itself when it is really idle (a root systemd timer every 2 min: no machine peer connection, no ssh session with a terminal that had input in the last --ssh-minutes ${IDLE_MIN_MINUTES}..${IDLE_MAX_MINUTES} (default ${IDLE_SSH_DEFAULT_MINUTES}), keyboard/mouse input idle (needs xprintidle: --minutes without an RDP connection, --rdp-minutes ${IDLE_MIN_MINUTES}..${IDLE_MAX_MINUTES}, default ${IDLE_RDP_DEFAULT_MINUTES}, when one is open), no machine request, low load, no sleep inhibitor, no keep-awake file for ${IDLE_DEFAULT_MINUTES} min by default, --minutes ${IDLE_MIN_MINUTES}..${IDLE_MAX_MINUTES}); a disconnected desktop session does not count; wake it with \`machine wake\``,
  summaryLine: 'suspends this box by itself when really idle (root timer, every 2 min)',
  platforms: ['linux'],
  consequence:
    'This only RESTRICTS uptime: the box suspends itself when idle. It adds no network surface and no right for any peer (a peer keeps the box awake only by sending commands, as before). To keep it awake on purpose: touch /run/machine-keep-awake or <config dir>/keep-awake (content "keep awake until <epoch>" for a limited time); remove the file to release it.',
  plan: idleSuspendPlan,
  next: (plan) => {
    const configDir = plan.configDir ?? '<config dir>';
    return [
      'installed:',
      ...plan.files.map((f) => `  ${f.path}   (root-owned, mode ${f.mode})`),
      '',
      `${plan.summary ?? 'idle-suspend'}: checked every 2 minutes; every decision is written to the journal:`,
      `  journalctl -t ${IDLE_LOG_TAG} -n 20      (sudo journalctl ... when your user cannot read the journal)`,
      '',
      'keep the box awake on purpose (a local control of the owner, an orchestrator job can touch it too):',
      `  touch ${IDLE_KEEP_AWAKE_RUN}   or   touch ${configDir}/keep-awake    (remove it to release)`,
      `  echo "keep awake until $(( $(date +%s) + 3600 ))" > ${configDir}/keep-awake    (one more hour, then it is ignored)`,
      '',
      'a disconnected desktop session (xrdp) is NOT counted as activity; an established machine peer connection is; an established ssh connection counts only through a session WITH A TERMINAL (tty) whose last input is more recent than --ssh-minutes (an ssh session without a tty, such as scp, rsync, \`ssh host command\` or the Herdr stream, is never activity by itself: a slow low-CPU job run that way is protected only by the load, the sleep inhibitors and the machine requests; anything unreadable counts as activity and the journal says why); an established RDP connection counts only while the X input of the session is more recent than --rdp-minutes (xprintidle: sudo apt install xprintidle; without it, or when it cannot be read, RDP counts as activity and the journal says why); without an RDP connection the input must be idle for --minutes when xprintidle can be read, otherwise the journal says that input idleness is not checked.',
      'to test quickly: machine install idle-suspend --minutes 5 --refresh, then leave the box alone for 5-7 minutes (the timer checks every 2 minutes); wake it with machine wake.',
      '',
      `[warn] ${IDLE_SUSPEND.consequence}`,
    ];
  },
  afterRemove: () => ['nothing to withdraw on the ADMIN machine: this item has no command for peers. The box no longer suspends by itself.'],
};

/** Every installable of this build. */
export const INSTALLABLES: Installable[] = [SUSPEND, IDLE_SUSPEND];

export const findInstallable = (id: string): Installable | undefined => INSTALLABLES.find((d) => d.id === id);
