import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { describeRegistration, describeRegistrationFailure, registerModule } from '@wadeck-app/app-core-sdk/register';

/*
 * Talking to app-core (the port, the POST, the pickup file when it is not running, the wording of each
 * outcome) is app-core-sdk's job. What stays here is what only this package knows: where its module is,
 * copying it out of the npm folder, and when to register. Ported from orchestrator-cli; machine has no
 * config key to turn registration off, so there is no `enabled` / dev-instance switch.
 */

/** The module id app-core knows the dashboard by: the prefix of its components and routes. */
export const APP_CORE_MODULE_ID = 'machine';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The first words of the line logged when registration is skipped under the temporary folder (the CLI sends such a line to stderr). */
export const APP_CORE_SKIP_PREFIX = 'app-core registration skipped:';

function realOrResolved(p: string): string {
  const missing: string[] = [];
  let current = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...missing);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...missing);
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** Whether `dir` is `tmp` or below it, on real paths (the nearest existing ancestor is resolved), case-insensitive on Windows. */
export function isUnderTempDir(dir: string, tmp: string): boolean {
  const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = path.relative(fold(realOrResolved(tmp)), fold(realOrResolved(dir)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** app-core's config dir, which APP_CORE_CONFIG_DIR overrides the way app-core itself honours it. */
export function getAppCoreConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env['APP_CORE_CONFIG_DIR'] ?? path.join(os.homedir(), '.config', 'app-core');
}

function appModuleManifestCandidates(packageRoot: string): string[] {
  return [
    path.join(packageRoot, 'app-module', 'manifest.json'),
    path.join(packageRoot, '..', 'app-module-machine', 'dist-module', 'manifest.json'),
  ];
}

/**
 * The module's PACKAGED manifest: inside the installed package (`app-module/`, assembled when the package is
 * built), else the dist-module of the sibling package of a source checkout. The installed one wins, so a
 * checkout next to an install cannot shadow what that install ships. The sibling's source manifest.json is
 * never a candidate: app-core refuses it (no version, no backendEntryPath), only `app-core-cli package`
 * makes a registrable one.
 */
export function findAppModuleManifest(packageRoot: string): string | undefined {
  return appModuleManifestCandidates(packageRoot).find(candidate => fs.existsSync(candidate));
}

/** Where the module is, and whether it is the copy npm installed (which must not be what app-core remembers). */
interface FoundModule {
  manifestPath: string;
  /** The folder holding the manifest. */
  dir: string;
  installed: boolean;
}

function findAppModule(packageRoot: string): FoundModule | undefined {
  const [installed, sibling] = appModuleManifestCandidates(packageRoot) as [string, string];
  if (fs.existsSync(installed)) {
    return { manifestPath: installed, dir: path.dirname(installed), installed: true };
  }
  if (fs.existsSync(sibling)) {
    return { manifestPath: sibling, dir: path.dirname(sibling), installed: false };
  }
  return undefined;
}

const PARTIAL_SUFFIX = '.partial';
/** A partial copy older than this belongs to a staging that died; a younger one may be a concurrent staging, and is left alone. */
const PARTIAL_MAX_AGE_MS = 60 * 60 * 1000;

/** The first symbolic link (or junction) under `dir`, or undefined. */
function findSymbolicLink(dir: string): string | undefined {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) return full;
    if (entry.isDirectory()) {
      const nested = findSymbolicLink(full);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

/** A stamp is a folder name chosen by us (a package version), never a path. */
const STAMP_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function stagedModulesRoot(machineConfigDir: string): string {
  return path.join(machineConfigDir, 'app-module');
}

/**
 * Copies the module out of the npm folder into `<machineConfigDir>/app-module/<stamp>/` and returns the
 * manifest to register.
 *
 * app-core stores the PATH of a manifest and reloads from it at every start. npm replaces the package folder
 * on update and deletes it on uninstall, so a path into node_modules dies. The copy lives in the config dir,
 * which belongs to the user and not to npm.
 *
 * Once per stamp: a complete copy is kept. Written beside the target and renamed, so a crash cannot leave a
 * half-copied folder at the path app-core would load from.
 */
export function stageAppModule(sourceDir: string, machineConfigDir: string, stamp: string): string {
  if (!STAMP_RE.test(stamp)) {
    throw new Error(`Cannot stage the app-core module: "${stamp}" is not a usable version stamp (letters, digits, ".", "_" and "-" only, not starting with a separator).`);
  }
  if (!fs.existsSync(path.join(sourceDir, 'manifest.json'))) {
    throw new Error(`Cannot stage the app-core module: no manifest.json in ${sourceDir}. Rebuild the package with its app-module.`);
  }
  const target = path.join(stagedModulesRoot(machineConfigDir), stamp);
  const manifest = path.join(target, 'manifest.json');
  if (fs.existsSync(manifest)) {
    return manifest;
  }
  const link = findSymbolicLink(sourceDir);
  if (link !== undefined) {
    throw new Error(`Cannot stage the app-core module: ${link} is a symbolic link. A copy would keep it and point outside the module; the packaged module must hold plain files. Rebuild the package with its app-module.`);
  }
  // A name of its own: a daemon start and `machine cli register` can stage the same stamp at the same time.
  const partial = `${target}.${process.pid}-${randomBytes(4).toString('hex')}${PARTIAL_SUFFIX}`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(sourceDir, partial, { recursive: true });
    if (fs.existsSync(manifest)) {
      // Staged by someone else while we copied: theirs is complete, ours is not needed.
      fs.rmSync(partial, { recursive: true, force: true });
      return manifest;
    }
    fs.rmSync(target, { recursive: true, force: true });
    try {
      fs.renameSync(partial, target);
    } catch (renameError) {
      fs.rmSync(partial, { recursive: true, force: true });
      if (!fs.existsSync(manifest)) throw renameError;
    }
  } catch (err) {
    fs.rmSync(partial, { recursive: true, force: true });
    throw new Error(`Cannot stage the app-core module into ${target} (${errorMessage(err)}). It is copied out of the npm folder on purpose, so that updating or removing the package cannot break what app-core remembers.`);
  }
  return manifest;
}

/**
 * Removes the staged copies of every version but `keepStamp`, and returns how many went. Only folders named like a stamp go: a
 * foreign file or folder stays, and so does a recent `.partial` (a concurrent staging); an old one is crash residue and goes.
 * A failure to remove one is skipped: the next start tries again, and a leftover copy costs disk, not correctness.
 */
export function pruneStagedModules(machineConfigDir: string, keepStamp: string): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(stagedModulesRoot(machineConfigDir), { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (entry.name === keepStamp || !entry.isDirectory() || !STAMP_RE.test(entry.name)) {
      continue;
    }
    if (entry.name.endsWith(PARTIAL_SUFFIX)) {
      try {
        if (Date.now() - fs.statSync(path.join(stagedModulesRoot(machineConfigDir), entry.name)).mtimeMs < PARTIAL_MAX_AGE_MS) continue;
      } catch {
        continue;
      }
    }
    try {
      fs.rmSync(path.join(stagedModulesRoot(machineConfigDir), entry.name), { recursive: true, force: true });
      removed++;
    } catch {
      // Still in use or locked: left for the next start.
    }
  }
  return removed;
}

export interface RegisterOnStartOptions {
  /** The installed package's root (the folder holding package.json). */
  packageRoot: string;
  /** This daemon's own config dir: where the module is copied to. Needed for an installed package. */
  machineConfigDir?: string | undefined;
  /** What names this version's copy, normally the package version. Needed for an installed package. */
  moduleStamp?: string | undefined;
  appCoreConfigDir?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** The OS temporary folder (default os.tmpdir()); a machine config dir under it is not registered unless forced or APP_CORE_CONFIG_DIR is set. */
  tmpdir?: string | undefined;
  /** `machine cli register --force-register`: register even from the temporary folder. */
  forceRegister?: boolean | undefined;
  log: (message: string) => void;
}

/**
 * What the daemon (and `machine register`) does about app-core, deciding and logging in one place. Never
 * rejects: whatever goes wrong here is a log line, not a daemon that fails to start.
 */
export async function registerOnStart(options: RegisterOnStartOptions): Promise<void> {
  const { packageRoot, log, env = process.env } = options;
  const appCoreConfigDir = options.appCoreConfigDir ?? getAppCoreConfigDir(env);

  try {
    // A config dir under the temp folder is a probe or a test: app-core would remember a path that will disappear. APP_CORE_CONFIG_DIR is explicit isolation.
    if (
      options.machineConfigDir !== undefined &&
      options.forceRegister !== true &&
      env['APP_CORE_CONFIG_DIR'] === undefined &&
      isUnderTempDir(options.machineConfigDir, options.tmpdir ?? os.tmpdir())
    ) {
      log(`${APP_CORE_SKIP_PREFIX} the configuration folder ${options.machineConfigDir} is under the temporary folder, so the module would be registered from a path that will disappear (a probe or a test). Set APP_CORE_CONFIG_DIR to an isolated app-core folder to register there, or run machine cli register --force-register`);
      return;
    }
    const found = findAppModule(packageRoot);
    if (found === undefined) {
      log(`app-core: no app-module found, not registering. Looked for ${appModuleManifestCandidates(packageRoot).join(' and ')}. A published install should ship one: reinstall machine. In a source checkout, build it with: BUNDLE_VERSION=<version> npm run bundle --workspace=packages/app-module-machine`);
      return;
    }
    // Before anything is copied: a machine that never installed app-core gets no folder, no network call.
    if (!fs.existsSync(appCoreConfigDir)) {
      log(describeRegistration({ status: 'skipped', reason: `app-core is not installed (${appCoreConfigDir} does not exist)` }, APP_CORE_MODULE_ID));
      return;
    }

    let manifestPath = found.manifestPath;
    let copy: { machineConfigDir: string; stamp: string } | undefined;
    if (found.installed) {
      const { machineConfigDir, moduleStamp } = options;
      if (machineConfigDir === undefined || moduleStamp === undefined) {
        throw new Error('an installed app-module is copied before it is registered, and this call gave no machineConfigDir or moduleStamp to copy it with');
      }
      manifestPath = stageAppModule(found.dir, machineConfigDir, moduleStamp);
      copy = { machineConfigDir, stamp: moduleStamp };
    }

    // The SDK reads the config dir from the environment, as app-core itself does.
    const outcome = await registerModule({ id: APP_CORE_MODULE_ID, manifestPath, env: { ...env, APP_CORE_CONFIG_DIR: appCoreConfigDir } });
    log(describeRegistration(outcome, APP_CORE_MODULE_ID));

    // Older copies go only once app-core holds the new path (accepted now, or left as the file it reads at its
    // next start). A refusal or an unconfirmed answer means it may still remember the old one, which must keep working.
    if (copy !== undefined && (outcome.status === 'registered' || outcome.status === 'deferred')) {
      pruneStagedModules(copy.machineConfigDir, copy.stamp);
    }
  } catch (err) {
    log(describeRegistrationFailure(err));
  }
}
