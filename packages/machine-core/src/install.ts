import { createHash } from 'node:crypto';

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
  purpose: 'validate' | 'install' | 'remove';
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
  /** A command that exits 0 when the machine behaves as installed (`sudo -n -l ...`): it never prompts. */
  probe: string[];
}

export interface Installable {
  id: string;
  description: string;
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
  };
}

const SUSPEND: Installable = {
  id: 'suspend',
  description: 'let `machine run` suspend this machine (a root-owned script and a sudoers rule for ONE command: systemctl suspend); wake it with `machine wake`',
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

/** Every installable of this build. */
export const INSTALLABLES: Installable[] = [SUSPEND];

export const findInstallable = (id: string): Installable | undefined => INSTALLABLES.find((d) => d.id === id);
