import { INSTALLABLES, findInstallable, type Installable } from '@wadeck-app/machine-core';
import { EXIT, type CliIo, type CommandContext, type Parsed } from './cliTypes.js';
import { NotInitializedError } from './errors.js';
import { readMachine } from './identity.js';
import { realInstallEnv, type InstallEnv } from './installEnv.js';
import { runInstallFlow, type FlowOptions } from './installFlow.js';
import { installedStatusLines, listStatuses, statusBlock, type ItemStatus } from './installStatus.js';
import { promptLine } from './prompt.js';

// `machine install [<id> | status] [--dry-run | --check | --refresh | --remove] [--yes]`: thin front-end over installFlow.ts, installStatus.ts and the registry of machine-core.
// LOCAL ONLY: no daemon command, peer frame or app-module route exists for it (hard rule 7: the daemon is never elevated).

const USAGE = 'machine install <id> [--dry-run | --check | --refresh | --remove] [--yes] [--json]';

/** The flags of `install` used where they do not belong, or in a combination that means nothing. Undefined when the command line is fine. */
export function installFlagProblem(command: string, rest: string[], args: Parsed): string | undefined {
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

function listText(platform: string, statuses: ItemStatus[]): string {
  const lines = ['machine install: what machine can set up on THIS machine, and its state here (local command: run it in a terminal here, never remotely)', ''];
  for (const status of statuses) {
    lines.push(...statusBlock(status, platform));
  }
  lines.push(
    '',
    `Usage: ${USAGE}`,
    '  machine install status            this list again (read-only, no password; --json for scripts)',
    '  machine install <id> --check      the state of one item; exit 0 only when installed and up to date',
    '  machine install <id> --dry-run    shows every file and command, changes nothing',
    '  machine install <id>              shows them, asks y/N, then runs them with sudo (your own password)',
    '  machine install <id> --refresh    writes the whole plan again, even when up to date (repairs a file or a rule changed by hand)',
    '  machine install <id> --remove     removes exactly what was installed',
    'More: machine install --help',
  );
  return `${lines.join('\n')}\n`;
}

/** The lines of `machine status` for the installed items (read-only, no sudo): see installedStatusLines. */
export const installedItemsForStatus = (io: CliIo): ReturnType<typeof installedStatusLines> => installedStatusLines({ ...realInstallEnv(), ...io.install });

export async function runInstallCommand(ctx: CommandContext): Promise<number> {
  const { args, rest, io, emit, fail, configDir } = ctx;
  const env: InstallEnv = { ...realInstallEnv(), ...io.install };
  // `machine install` and `machine install status` are the same read-only list, with the state of every item on this machine.
  if (rest.length === 0 || rest[0] === 'status') {
    const statuses = await listStatuses(env);
    emit({ platform: env.platform, installables: statuses }, listText(env.platform, statuses));
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
      confirm: async (question) => /^y(es)?$/i.test((await (io.ask ?? ((label: string) => promptLine(label)))(question)).trim()),
    },
  );
  if (args.json) {
    emit(result.document, '');
  }
  return result.exit;
}
