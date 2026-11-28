import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { SHELLS, commandTextProblem, type Shell } from '@wadeck-app/machine-core';

export interface LaunchSpec {
  file: string;
  args: string[];
  /** Windows only: pass `args` to CreateProcess exactly as given (cmd needs it; Node's default would re-quote). */
  windowsVerbatimArguments: boolean;
}

export type Platform = NodeJS.Platform;

function powershellArgs(command: string): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')];
}

/** Windows environment names are case-insensitive, a copied plain object is not: look the name up the Windows way. */
export function windowsSystemRoot(env: Record<string, string | undefined>): string | undefined {
  const name = Object.keys(env).find((k) => k.toUpperCase() === 'SYSTEMROOT');
  return name === undefined ? undefined : env[name];
}

/**
 * How to start one approved command (T-15): the shell is named, the approved string travels as ONE argument and is
 * never normalized, escaped or re-quoted by us. cmd uses `/s` so that exactly our outer quotes are stripped; PowerShell
 * receives the string base64-encoded so that no quoting layer exists at all.
 */
export function launchSpec(shell: Shell, command: string, platform: Platform, env: Record<string, string | undefined>): LaunchSpec {
  if (!(SHELLS as readonly string[]).includes(shell)) throw new Error(`unknown shell "${String(shell)}": expected one of ${SHELLS.join(', ')}`);
  const problem = commandTextProblem(command);
  if (problem) throw new Error(`refusing to launch: ${problem}`);

  if (platform === 'win32') {
    if (shell === 'bash' || shell === 'sh') {
      throw new Error(`shell "${shell}" is not supported on Windows (bash.exe may be WSL, a different machine state): use "cmd" or "ps" in the policy entry`);
    }
    const root = windowsSystemRoot(env);
    if (!root) throw new Error('SystemRoot is not set in the daemon environment: cannot locate the Windows shells; start the daemon from a normal Windows session');
    if (shell === 'cmd') {
      return { file: `${root}\\System32\\cmd.exe`, args: ['/d', '/v:off', '/s', '/c', `"${command}"`], windowsVerbatimArguments: true };
    }
    return { file: `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, args: powershellArgs(command), windowsVerbatimArguments: false };
  }

  if (shell === 'cmd') throw new Error('shell "cmd" only exists on Windows: use "sh", "bash" or "ps" in the policy entry for this machine');
  if (shell === 'ps') {
    // Resolved through the daemon's PATH (no fixed install location for PowerShell 7 on Unix).
    return { file: 'pwsh', args: powershellArgs(command), windowsVerbatimArguments: false };
  }
  if (shell === 'bash') return { file: '/bin/bash', args: ['--noprofile', '--norc', '-c', command], windowsVerbatimArguments: false };
  return { file: '/bin/sh', args: ['-c', command], windowsVerbatimArguments: false };
}

const WINDOWS_ENV = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES',
  'COMPUTERNAME', 'USERNAME', 'USERDOMAIN', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
  // A path (no secret). Measured on the windows-latest runner (CI run 46129290430, env bisect): powershell.exe hung for more than 25 s without this one and ran in 0.3 s with it. The reason is not established.
  'PSMODULEANALYSISCACHEPATH',
];
const UNIX_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'TZ'];

/** Explicit allow-list (T-18): a secret in the daemon environment can never reach a command. */
export function scrubEnv(env: Record<string, string | undefined>, platform: Platform): Record<string, string> {
  const out: Record<string, string> = {};
  const windows = platform === 'win32';
  const allowed = new Set(windows ? WINDOWS_ENV : UNIX_ENV);
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const lookup = windows ? name.toUpperCase() : name;
    if (allowed.has(lookup) || (!windows && name.startsWith('LC_'))) out[name] = value;
  }
  // cmd searches the current folder (the home folder here) before PATH unless told not to: a program planted there must never win.
  if (windows) out.NoDefaultCurrentDirectoryInExePath = '1';
  return out;
}

/** Unix: the first executable file named `name` in the directories of `PATH`, as the shell would find it; undefined when there is none. */
export function resolveOnPath(name: string, pathValue: string | undefined): string | undefined {
  for (const dir of (pathValue ?? '').split(':')) {
    // An empty entry means the current folder to a shell: never resolve to it.
    if (dir === '' || !isAbsolute(dir)) {
      continue;
    }
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // not here
    }
  }
  return undefined;
}

/**
 * macOS only (T-71): every command runs under `caffeinate -s`, so the Mac cannot sleep while the job runs (a network connection wakes
 * it into a dark wake of about 45 s; only `-s` keeps it up with the display off, `-i` does not). Other platforms: no wrapper.
 */
export function defaultKeepAwakeWrapper(platform: Platform): string | undefined {
  return platform === 'darwin' ? '/usr/bin/caffeinate' : undefined;
}

/**
 * `caffeinate -s <utility> [args]` runs the utility and holds the assertion until it exits. The utility is the shell (an absolute path
 * or `pwsh`, never starting with `-`), so no `--` is needed; its arguments are passed through untouched.
 */
export function withKeepAwake(spec: LaunchSpec, wrapper: string): LaunchSpec {
  return { file: wrapper, args: ['-s', spec.file, ...spec.args], windowsVerbatimArguments: spec.windowsVerbatimArguments };
}
