import { IDLE_MAX_MINUTES, IDLE_MIN_MINUTES, INSTALLABLES, InstallError, findInstallable, parseIdleMinutes, parseIdleRdpMinutes, type Installable } from '@wadeck-app/machine-core';
import { EXIT, type CliIo, type CommandContext, type Parsed } from './cliTypes.js';
import { NotInitializedError } from './errors.js';
import { readMachine } from './identity.js';
import { realInstallEnv, type InstallEnv } from './installEnv.js';
import { runInstallFlow, type FlowOptions } from './installFlow.js';
import { installedStatusLines, listStatuses, statusBlock, type ItemStatus } from './installStatus.js';

// `machine install [<id> | status] [--dry-run | --check | --refresh | --remove] [--yes]`: thin front-end over installFlow.ts, installStatus.ts and the registry of machine-core.
// LOCAL ONLY: no daemon command, peer frame or app-module route exists for it (hard rule 7: the daemon is never elevated).

const USAGE = 'machine install <id> [--dry-run | --check | --refresh | --remove] [--yes] [--minutes <n>] [--rdp-minutes <n>] [--json]';

/** The flags of `install` used where they do not belong, or in a combination that means nothing. Undefined when the command line is fine. */
export function installFlagProblem(command: string, rest: string[], args: Parsed): string | undefined {
  if (args.minutes !== undefined) {
    if (command !== 'install' || rest[0] !== 'idle-suspend') {
      return `--minutes only applies to \`machine install idle-suspend\` (the idle time before the box suspends, ${IDLE_MIN_MINUTES} to ${IDLE_MAX_MINUTES}): \`machine install idle-suspend --minutes 30\``;
    }
    if (args.check || args.remove) {
      return `--minutes sets what is installed: it goes with the install, --refresh or --dry-run of \`machine install idle-suspend\`, not with ${args.check ? '--check' : '--remove'}`;
    }
    try {
      parseIdleMinutes(args.minutes);
    } catch (e) {
      if (!(e instanceof InstallError)) {
        throw e;
      }
      return (e as Error).message;
    }
  }
  if (args.rdpMinutes !== undefined) {
    if (command !== 'install' || rest[0] !== 'idle-suspend') {
      return `--rdp-minutes only applies to \`machine install idle-suspend\` (the input idle time from which an open RDP connection no longer keeps the box awake, ${IDLE_MIN_MINUTES} to ${IDLE_MAX_MINUTES}): \`machine install idle-suspend --rdp-minutes 20\``;
    }
    if (args.check || args.remove) {
      return `--rdp-minutes sets what is installed: it goes with the install, --refresh or --dry-run of \`machine install idle-suspend\`, not with ${args.check ? '--check' : '--remove'}`;
    }
    try {
      parseIdleRdpMinutes(args.rdpMinutes);
    } catch (e) {
      if (!(e instanceof InstallError)) {
        throw e;
      }
      return (e as Error).message;
    }
  }
  const used: string[] = [...(args.yes ? ['--yes'] : []), ...(args.dryRun ? ['--dry-run'] : []), ...(args.check ? ['--check'] : []), ...(args.refresh ? ['--refresh'] : [])];
  if (command !== 'install') {
    return used.length === 0 ? undefined : `${used.join(', ')} only apply to \`machine install <id>\` (see \`machine install --help\`)`;
  }
  const flags = [...used, ...(args.remove ? ['--remove'] : [])];
  if (rest[0] === 'status' && flags.length > 0) {
    return `\`machine install status\` takes no \`${flags[0] as string}\` (it only reads, and accepts --json): to act on one item run \`machine install <id> ${flags[0] as string}\``;
  }
  if (rest.length === 0 && flags.length > 0) {
    return `${flags[0] as string} needs an id: ${USAGE} (\`machine install\` lists the ids)`;
  }
  if (args.check && flags.length > 1) {
    return `--check only reads: it cannot be combined with ${flags.filter((f) => f !== '--check').join(' or ')}`;
  }
  if (args.refresh && args.remove) {
    return '--refresh (writes the plan again) and --remove (removes it) cannot be combined: choose one';
  }
  return undefined;
}

function listText(statuses: ItemStatus[], columns: number | undefined): string {
  const lines = ['machine install: what can be set up on THIS machine, and its state (a local command: never remote)', ''];
  const now = Date.now();
  for (const status of statuses) {
    lines.push(...statusBlock(status, { columns, now }));
  }
  lines.push(
    '',
    `Usage: ${USAGE}`,
    '  machine install status            this list again (read-only, no password; --json for scripts)',
    '  machine install <id> --check      the state of one item; exit 0 only when installed and up to date',
    '  machine install <id> --dry-run    the full description, every file and command; changes nothing',
    '  machine install <id>              prints them, then runs them with sudo (your own password is the confirmation; Ctrl-C stops)',
    '  machine install <id> --refresh    writes the whole plan again (repairs what was changed by hand)',
    '  machine install <id> --remove     removes exactly what was installed',
    'More: machine install --help',
  );
  return `${lines.join('\n')}\n`;
}

/** The lines of `machine status` for the installed items (read-only, no sudo): see installedStatusLines. */
export const installedItemsForStatus = (io: CliIo, configDir: string): ReturnType<typeof installedStatusLines> => installedStatusLines({ ...realInstallEnv(), ...io.install, context: { configDir: io.install?.context?.configDir ?? configDir } });

export async function runInstallCommand(ctx: CommandContext): Promise<number> {
  const { args, rest, io, emit, fail, configDir } = ctx;
  // What the plans take from the command line: the configuration folder (idle-suspend reads its audit log) and --minutes (checked by installFlagProblem).
  // A test double may name another configuration folder; --minutes always comes from the command line.
  const context = { configDir: io.install?.context?.configDir ?? configDir, ...(args.minutes === undefined ? {} : { minutes: parseIdleMinutes(args.minutes) }), ...(args.rdpMinutes === undefined ? {} : { rdpMinutes: parseIdleRdpMinutes(args.rdpMinutes) }) };
  const env: InstallEnv = { ...realInstallEnv(), ...io.install, context };
  // `machine install` and `machine install status` are the same read-only list, with the state of every item on this machine.
  if (rest.length === 0 || rest[0] === 'status') {
    const statuses = await listStatuses(env);
    // The width logic of `machine log --follow`: the terminal's own (a test double may give it), unknown when the output is not a terminal.
    const columns = io.columns?.() ?? (io.columns === undefined && process.stdout.isTTY ? process.stdout.columns : undefined);
    emit({ platform: env.platform, installables: statuses }, listText(statuses, columns));
    return EXIT.ok;
  }
  const id = rest[0] as string;
  const def: Installable | undefined = findInstallable(id);
  if (def === undefined) {
    return fail(`unknown installable ${JSON.stringify(id.slice(0, 40))}: \`machine install\` lists them (${INSTALLABLES.map((d) => d.id).join(', ')})`, EXIT.usage);
  }

  const mode: FlowOptions['mode'] = args.check ? 'check' : args.remove ? 'remove' : args.refresh ? 'refresh' : 'install';
  // The name of this machine is only needed for the lines printed after a change; a machine without an identity still installs, with a warning.
  let machineName: string | undefined;
  if (mode !== 'check' && !args.dryRun) {
    try {
      machineName = readMachine(configDir).name;
    } catch (e) {
      if (!(e instanceof NotInitializedError)) {
        throw e;
      }
    }
  }
  // With --json stdout is ONE document: the prose goes to stderr.
  const say = args.json ? io.stderr : io.stdout;
  const result = await runInstallFlow(
    def,
    { mode, dryRun: args.dryRun, yes: args.yes, ...(machineName === undefined ? {} : { machineName }) },
    env,
    {
      say,
      warn: io.stderr,
    },
  );
  if (args.json) {
    emit(result.document, '');
  }
  return result.exit;
}
