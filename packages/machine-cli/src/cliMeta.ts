import { registerOnStart, type RegisterOnStartOptions } from './appCoreRegistration.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemonClient } from '@wadeck-app/singleton-daemon-kit';
import { cliLogsCommand, cliRollbackCommand, cliUpdateCommand, cliVersionCommand } from '@wadeck-app/shared-cli/CliMetaCommands';
import { execNpm } from '@wadeck-app/shared-cli/NpmRunner';
import { UpdateManager } from '@wadeck-app/shared-cli/UpdateManager';
import { devBuildRefusalMessage, isReleaseVersion } from '@wadeck-app/shared-cli/ReleaseVersion';
import { EXIT, type CommandContext } from './cliTypes.js';
import { makeCommands } from './commands.js';
import { postUpdate, type PostUpdateDeps } from './postUpdate.js';
import { findLauncher } from './platformBinary.js';
import { runSelfCheck, type SelfCheckResult } from './selfCheck.js';
import { enableStartup, startupStatus, StartupError, type StartupContext } from './startup.js';
import { spawnPostUpdate } from './updater/spawnPostUpdate.js';
import { UPDATER_BUNDLE_NAME } from './updateScheduling.js';
import { updateNotice } from './updateNotice.js';
import { appVersion } from './version.js';

// `machine cli version | update | rollback | self-check | logs | post-update`: thin front-end. The update itself is the updater
// bundle (src/updater/entry.ts); the shared-cli commands do the version / update / rollback / logs plumbing.

export const PACKAGE_NAME = '@wadeck-app/machine-cli';
const SUBCOMMANDS = 'version | update | rollback | self-check | logs | post-update | register';
const USAGE = `usage: machine cli ${SUBCOMMANDS}`;

/** Everything that touches the world, injectable through `io.cliMeta` (tests only: there is no command line option for it). */
export interface CliMetaDeps {
  version: string;
  /** The updater bundle, next to machine.cjs. */
  updaterPath: string;
  runUpdater: (updaterPath: string, rawArgs: string[]) => Promise<void>;
  showVersion: (pkgName: string, current: string) => Promise<void>;
  showLogs: (configDir: string, opts: { follow?: boolean }) => Promise<void>;
  rollback: (pkgName: string, configDir: string) => Promise<void>;
  /** Runs `cli post-update` of the install that is on disk now (after a rollback this process still holds the replaced files). */
  spawnPostUpdate: () => Promise<{ code: number; output: string }>;
  selfCheck: () => Promise<SelfCheckResult>;
  /** Offers the admin page module to app-core now (the daemon does the same at each start). */
  register: (options: RegisterOnStartOptions) => Promise<void>;
  postUpdate: Partial<Pick<PostUpdateDeps, 'startup' | 'daemon'>>;
}

/**
 * Shows the result of a background update on stderr (so --json stdout stays one document). A terminal state is shown once and cleared;
 * 'applying' is the updater's journal and stays (its next run repairs it).
 */
export function printUpdateNotice(configDir: string, stderr: (text: string) => void): void {
  const notice = updateNotice(new UpdateManager(PACKAGE_NAME, configDir).readAndClearState());
  if (notice) stderr(`[machine] ${notice.text}\n`);
}

/** The folder of the running bundle (the installed package folder); from the sources, the src folder. */
function packageRoot(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** The running daemon, through the same client the other commands use. */
function daemonControl(configDir: string, version: string): PostUpdateDeps['daemon'] & { running: () => Promise<boolean> } {
  const client = createDaemonClient({ configDir, commands: makeCommands(configDir, version) });
  return {
    running: () => client.isRunning(),
    version: async () => ((await client.isRunning()) ? (await client.version()).version : undefined),
    quit: async () => {
      await (client as unknown as { send(command: string): Promise<unknown> }).send('quit');
      for (let i = 0; i < 100 && (await client.isRunning()); i++) await new Promise((r) => setTimeout(r, 100));
      if (await client.isRunning()) throw new Error('the daemon did not stop within 10 seconds');
    },
  };
}

function defaultSpawnPostUpdate(configDir: string, say: (text: string) => void): () => Promise<{ code: number; output: string }> {
  return async () => {
    let npmRoot: string;
    try {
      npmRoot = execNpm(['root', '-g'], { timeout: 10_000 }).trim();
    } catch (e) {
      say(`[fail] cannot resolve 'npm root -g': ${(e as Error).message}\n`);
      return { code: 1, output: '' };
    }
    return spawnPostUpdate({ nodeExe: process.execPath, npmRoot, configDir, env: process.env });
  };
}

function resolveDeps(ctx: CommandContext): CliMetaDeps {
  const o = ctx.io.cliMeta ?? {};
  const version = o.version ?? appVersion();
  const configDir = ctx.configDir;
  const startupCtx: StartupContext = { configDir, env: ctx.env, ...ctx.io.startup };
  const daemon = daemonControl(configDir, version);
  return {
    version,
    updaterPath: o.updaterPath ?? join(packageRoot(), UPDATER_BUNDLE_NAME),
    runUpdater: o.runUpdater ?? ((updaterPath, rawArgs) => cliUpdateCommand(updaterPath, PACKAGE_NAME, { rawArgs })),
    showVersion: o.showVersion ?? ((pkg, current) => cliVersionCommand(pkg, current)),
    showLogs: o.showLogs ?? ((dir, opts) => cliLogsCommand(dir, opts)),
    rollback: o.rollback ?? ((pkg, dir) => cliRollbackCommand(pkg, dir)),
    spawnPostUpdate: o.spawnPostUpdate ?? defaultSpawnPostUpdate(configDir, (t) => ctx.io.stderr(t)),
    register: o.register ?? registerOnStart,
    selfCheck:
      o.selfCheck ??
      (() =>
        runSelfCheck({
          version,
          configDir,
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
          wrapperManifest: () => JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as { optionalDependencies?: Record<string, string> },
          findLauncher: () => findLauncher(),
          daemonVersion: () => daemon.version(),
        })),
    postUpdate: {
      startup: o.postUpdate?.startup ?? {
        status: async () => {
          try {
            return await startupStatus(startupCtx);
          } catch (e) {
            // No orch means no startup job: not every user supervises the daemon with orch, and that must not make every update a failure.
            if (e instanceof StartupError && e.message.startsWith('orch is not installed')) return { exists: false };
            throw e;
          }
        },
        enable: () => enableStartup(startupCtx),
      },
      daemon: o.postUpdate?.daemon ?? daemon,
    },
  };
}

/** Runs `fn` with MACHINE_CONFIG_DIR set to the directory in use: a child (the updater) resolves its directory from the environment only. */
async function withConfigDirEnv<T>(configDir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.MACHINE_CONFIG_DIR;
  process.env.MACHINE_CONFIG_DIR = configDir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.MACHINE_CONFIG_DIR;
    else process.env.MACHINE_CONFIG_DIR = previous;
  }
}

export async function runCliMeta(ctx: CommandContext): Promise<number> {
  const { rest, args, io, emit, fail, configDir } = ctx;
  const [sub, ...extra] = rest;
  if (sub === undefined || !['version', 'update', 'rollback', 'self-check', 'logs', 'post-update', 'register'].includes(sub)) {
    return fail(`${sub === undefined ? 'cli needs a subcommand' : `unknown cli subcommand "${sub}"`}: ${USAGE}`, EXIT.usage);
  }
  if (extra.length > 0) return fail(`unexpected argument "${extra[0]}" for \`machine cli ${sub}\`: ${USAGE}`, EXIT.usage);
  if (args.quiet && sub !== 'self-check') return fail('--quiet only applies to `machine cli self-check`', EXIT.usage);
  if (args.follow && sub !== 'logs') return fail('--follow only applies to `machine cli logs`', EXIT.usage);

  const deps = resolveDeps(ctx);
  const devRefusal = (): number | undefined => (isReleaseVersion(deps.version) ? undefined : fail(devBuildRefusalMessage('machine', deps.version)));

  try {
    switch (sub) {
      case 'version':
        await deps.showVersion(PACKAGE_NAME, deps.version);
        return EXIT.ok;
      case 'register': {
        // Explicit request: no development-build skip here, the user asked for it. Every outcome of registerOnStart is a log line.
        const lines: string[] = [];
        await deps.register({ packageRoot: packageRoot(), machineConfigDir: configDir, moduleStamp: deps.version, log: (line) => lines.push(`${line}
`) });
        emit({ version: deps.version, log: lines.map((l) => l.trimEnd()) }, lines.join(''));
        return EXIT.ok;
      }
      case 'logs':
        await deps.showLogs(configDir, { follow: args.follow });
        return EXIT.ok;
      case 'update': {
        // Before anything else: a repo-built bundle is older than every published version, so the updater would run `npm install -g`
        // over the real install. The updater refuses too.
        const refused = devRefusal();
        if (refused !== undefined) return refused;
        if (!existsSync(deps.updaterPath)) return fail(`updater not found: ${deps.updaterPath} (this is not an installed release: install it with \`npm install -g ${PACKAGE_NAME}\`)`);
        io.stderr('[warn] an update restarts the daemon when it runs under the startup job: a remote command still running is cut\n');
        try {
          await withConfigDirEnv(configDir, () => deps.runUpdater(deps.updaterPath, args.force ? ['--force'] : []));
        } catch (e) {
          return fail(`${(e as Error).message}. State: ${join(configDir, 'update-state.json')}; log: \`machine cli logs\`; by hand: npm install -g ${PACKAGE_NAME}@latest`);
        }
        return EXIT.ok;
      }
      case 'rollback': {
        const refused = devRefusal();
        if (refused !== undefined) return refused;
        io.stderr('[warn] a rollback restarts the daemon when it runs under the startup job: a remote command still running is cut\n');
        await deps.rollback(PACKAGE_NAME, configDir);
        const post = await deps.spawnPostUpdate();
        if (post.output.length > 0) io.stderr(post.output.endsWith('\n') ? post.output : `${post.output}\n`);
        if (post.code !== 0) return fail('the previous version is installed, but post-update failed: the startup job or the running daemon may still use the newer one. Fix the cause above, then run: machine cli post-update');
        return EXIT.ok;
      }
      case 'self-check': {
        const r = await deps.selfCheck();
        const shown = args.quiet ? r.checks.filter((c) => !c.ok) : r.checks;
        emit(r, shown.map((c) => (c.ok ? `[ok] ${c.name}\n` : `[fail] ${c.name}: ${c.detail ?? 'failed'}\n`)).join(''));
        return r.ok ? EXIT.ok : EXIT.failure;
      }
      default: {
        // post-update: the new install, after an update or a rollback.
        const lines: string[] = [];
        const result = await postUpdate({ newVersion: deps.version, ...(deps.postUpdate as Pick<PostUpdateDeps, 'startup' | 'daemon'>), say: (line) => lines.push(line) });
        emit({ ...result, newVersion: deps.version }, lines.join(''));
        return EXIT.ok;
      }
    }
  } catch (e) {
    if (e instanceof StartupError) return fail(e.message);
    return fail((e as Error).message);
  }
}
