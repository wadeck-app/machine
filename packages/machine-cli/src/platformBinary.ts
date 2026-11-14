import * as nodeFs from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';

// The launcher (Go, singleton-daemon-kit) ships in one npm package per platform. It is never run from node_modules:
// npm moves that folder aside on update, and a running exe cannot be moved or copied on Windows. It is copied to
// <configDir>/bin/<stamp>/ and the orch job runs the copy (spec: packaging.md sections 1.6, 3.4 and 8).
// Pure functions: platform, arch, resolver and fs are injectable; nothing here reads the process.

/** The one table of supported platforms: package suffix and the file name of the launcher in that package. */
export const PLATFORM_TARGETS: Record<string, { fileName: string }> = {
  'win32-x64': { fileName: 'machine.exe' },
  'darwin-arm64': { fileName: 'machine' },
  'linux-x64': { fileName: 'machine' },
};

const PACKAGE_PREFIX = '@wadeck-app/machine-cli-';
const REINSTALL = 'npm i -g @wadeck-app/machine-cli';

/** The subset of node:fs used here. */
export type FsLike = Pick<typeof nodeFs, 'statSync' | 'mkdirSync' | 'copyFileSync' | 'renameSync' | 'readdirSync' | 'rmSync' | 'readFileSync' | 'writeFileSync'>;

export interface BinaryDeps {
  platform?: NodeJS.Platform;
  arch?: string;
  /** Like require.resolve: the absolute path of `<package>/<file>`, throws with code MODULE_NOT_FOUND when it is not installed. */
  resolve?: (specifier: string) => string;
  fs?: FsLike;
}

/** `os-arch` key: arm64 stays arm64, any other arch counts as x64 (the table decides whether it is supported). */
export function platformKey(platform: string, arch: string): string {
  return `${platform}-${arch === 'arm64' ? 'arm64' : 'x64'}`;
}

export function platformPackageName(key: string): string {
  return `${PACKAGE_PREFIX}${key}`;
}

export function unsupportedPlatformMessage(key: string): string {
  return `this platform (${key}) has no launcher package; supported: ${Object.keys(PLATFORM_TARGETS).join(', ')}`;
}

export type FoundLauncher = { kind: 'found'; source: string; stamp: string; fileName: string };
export type AbsentLauncher = { kind: 'absent'; reason: string };

function defaultResolve(specifier: string): string {
  return createRequire(import.meta.url).resolve(specifier);
}

function isNotFound(e: unknown): boolean {
  return (e as { code?: string }).code === 'MODULE_NOT_FOUND';
}

/**
 * The launcher inside the installed platform package, and the version of that package (the staging stamp: not the
 * version of the main package, which changes at every build). Not installed or unsupported platform: `absent` with the
 * reason. Anything else that goes wrong (unreadable manifest, a version that is not a folder name) is an error: no
 * made-up stamp.
 */
export function findLauncher(deps: BinaryDeps = {}): FoundLauncher | AbsentLauncher {
  const key = platformKey(deps.platform ?? process.platform, deps.arch ?? process.arch);
  const target = PLATFORM_TARGETS[key];
  if (target === undefined) return { kind: 'absent', reason: unsupportedPlatformMessage(key) };
  const pkg = platformPackageName(key);
  const resolve = deps.resolve ?? defaultResolve;
  let source: string;
  try {
    source = resolve(`${pkg}/${target.fileName}`);
  } catch (e) {
    if (isNotFound(e)) return { kind: 'absent', reason: `the launcher package ${pkg} is not installed` };
    throw e;
  }
  const fs = deps.fs ?? nodeFs;
  const manifest = join(dirname(source), 'package.json');
  let version: unknown;
  try {
    version = (JSON.parse(fs.readFileSync(manifest, 'utf8') as string) as { version?: unknown }).version;
  } catch (e) {
    throw new Error(`found the launcher at ${source} but cannot read ${manifest} (${(e as Error).message}): reinstall with \`${REINSTALL}\``);
  }
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`found the launcher at ${source} but ${manifest} has no "version" field, which names the staged folder: reinstall with \`${REINSTALL}\``);
  }
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(version)) {
    throw new Error(`the version "${version}" of ${pkg} cannot be used as a folder name: reinstall with \`${REINSTALL}\``);
  }
  return { kind: 'found', source, stamp: version, fileName: target.fileName };
}

/** Where the launcher is run from: `<configDir>/bin/<stamp>/<name>`. */
export function stagedBinaryPath(configDir: string, stamp: string, fileName: string): string {
  return join(configDir, 'bin', stamp, fileName);
}

/**
 * Copies the launcher out of node_modules, once per stamp, and returns the path to run. A short copy (interrupted) is
 * replaced; the copy goes to `<target>.partial` then is renamed. Throws instead of falling back to the source path: a
 * silent fallback would put the Windows EBUSY on update back without a word.
 */
export function stageBinary(source: string, configDir: string, stamp: string, fs: FsLike = nodeFs): string {
  const target = stagedBinaryPath(configDir, stamp, basename(source));
  let sourceSize: number;
  try {
    sourceSize = fs.statSync(source).size;
  } catch (e) {
    throw new Error(`Cannot stage the launcher: ${source} is not readable (${(e as Error).message}): reinstall with \`${REINSTALL}\``);
  }
  try {
    if (fs.statSync(target).size === sourceSize) return target;
  } catch {
    // Not staged yet: the normal case for a new stamp.
  }
  try {
    fs.mkdirSync(dirname(target), { recursive: true });
    const partial = `${target}.partial`;
    fs.copyFileSync(source, partial);
    fs.renameSync(partial, target);
  } catch (e) {
    throw new Error(
      `Cannot stage the launcher to ${target} (${(e as Error).message}). It is copied out of node_modules on purpose: npm cannot update a package while one of its executables runs, so the orch job must never run the file where npm installed it (${source}). Check that ${dirname(dirname(target))} is writable and not locked, then run \`machine startup enable\` again`,
    );
  }
  return target;
}

export interface PruneResult {
  removed: string[];
  /** Stamps that could not be removed (a running image cannot be deleted on Windows): retried at the next enable. */
  skipped: string[];
}

/** Removes the staged folders of every stamp but `keepStamp`. A failure is reported in `skipped`, never raised. */
export function pruneStaged(configDir: string, keepStamp: string, fs: FsLike = nodeFs): PruneResult {
  const result: PruneResult = { removed: [], skipped: [] };
  const binDir = join(configDir, 'bin');
  let entries: nodeFs.Dirent[];
  try {
    entries = fs.readdirSync(binDir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keepStamp) continue;
    try {
      fs.rmSync(join(binDir, entry.name), { recursive: true });
      result.removed.push(entry.name);
    } catch {
      result.skipped.push(entry.name);
    }
  }
  return result;
}

/** Name of the generated Windows wrapper, staged next to the launcher (so pruning and ensure-before-prune apply to it). */
export const WRAPPER_NAME = 'machine-daemon.vbs';

/**
 * One value that goes into the generated script. ASCII only, on purpose: wscript reads a .vbs as ANSI (the system code
 * page), so a UTF-8 file would silently turn an accented path into another path; UTF-16 would work but is not a plain
 * text file anyone can diff or review, so a non-ASCII path is refused with the fix instead. A quote cannot occur in a
 * Windows path and would end the VBS string; `%` is expanded by WshShell.Run in the command line.
 */
function scriptValue(value: string, what: string): string {
  const fail = (why: string) => new Error(`the ${what} ${JSON.stringify(value)} contains ${why}, which the Windows startup wrapper cannot carry: move machine (or its configuration folder) to a path without it`);
  if (!/^[A-Za-z]:\\/.test(value)) throw new Error(`the ${what} ${JSON.stringify(value)} is not an absolute Windows path (like C:\\...): move machine (or its configuration folder) to such a path`);
  if (/[\x00-\x1f\x7f]/.test(value)) throw fail('a control character');
  if (/[^\x00-\x7f]/.test(value)) throw fail('a non-ASCII character');
  if (value.includes('"')) throw fail('a double quote');
  if (value.includes('%')) throw fail('a percent sign');
  return value;
}

/**
 * The text of machine-daemon.vbs. A fixed template: only the three paths computed by machine are inserted, after
 * validation. Sets LAUNCHER_BUNDLE_OVERRIDE for the child only (the process environment of the script), runs the staged
 * launcher hidden (window style 0) and waits for it (so orch sees a running job), and quits with its exit code (so
 * restartOnExit works). CRLF line endings, ASCII.
 */
export function wrapperScript(opts: { exe: string; bundle: string; configDir?: string }): string {
  const exe = scriptValue(opts.exe, 'launcher path');
  const bundle = scriptValue(opts.bundle, 'bundle path');
  const configDir = opts.configDir === undefined ? undefined : scriptValue(opts.configDir, 'configuration folder');
  // In a VBS string a quote is written twice: the command line is "<exe>" daemon [--config-dir "<dir>"].
  const command = `""${exe}"" daemon${configDir === undefined ? '' : ` --config-dir ""${configDir}""`}`;
  return [
    "' Generated by machine startup enable (do not edit: it is rewritten at every enable).",
    "' Sets LAUNCHER_BUNDLE_OVERRIDE for the launcher only, runs it hidden and waits for it, so orch supervises the job and restartOnExit sees its exit code.",
    'Option Explicit',
    'Dim shell, env, code',
    'Set shell = CreateObject("WScript.Shell")',
    'Set env = shell.Environment("Process")',
    `env("LAUNCHER_BUNDLE_OVERRIDE") = "${bundle}"`,
    `code = shell.Run("${command}", 0, True)`,
    'WScript.Quit code',
    '',
  ].join('\r\n');
}

/** Writes the script (`<path>.partial` then rename); an identical file is left alone. Throws with the fix, never falls back. */
export function stageWrapper(path: string, content: string, fs: FsLike = nodeFs): void {
  if (wrapperState(path, content, fs) === 'current') return;
  try {
    fs.mkdirSync(dirname(path), { recursive: true });
    const partial = `${path}.partial`;
    fs.writeFileSync(partial, content, 'ascii');
    fs.renameSync(partial, path);
  } catch (e) {
    throw new Error(`Cannot write the startup wrapper ${path} (${(e as Error).message}): check that ${dirname(path)} is writable and not locked, then run \`machine startup enable\` again`);
  }
}

/** Whether the script on disk is the expected one. */
export function wrapperState(path: string, content: string, fs: FsLike = nodeFs): 'current' | 'missing' | 'different' {
  let found: string;
  try {
    found = fs.readFileSync(path, 'utf8') as string;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw new Error(`Cannot read the startup wrapper ${path} (${(e as Error).message}): check its permissions, then run \`machine startup enable\``);
  }
  return found === content ? 'current' : 'different';
}

export type StagedLauncher ={ kind: 'staged'; exe: string; stamp: string; source: string };

/**
 * The staged launcher of the installed platform package. `stage` false only computes the path (status never copies).
 * `absent` when there is no launcher package: a checkout or the development bundle.
 */
export function stagedLauncher(configDir: string, deps: BinaryDeps, stage: boolean): StagedLauncher | AbsentLauncher {
  const found = findLauncher(deps);
  if (found.kind === 'absent') return found;
  const exe = stage ? stageBinary(found.source, configDir, found.stamp, deps.fs) : stagedBinaryPath(configDir, found.stamp, found.fileName);
  return { kind: 'staged', exe, stamp: found.stamp, source: found.source };
}
