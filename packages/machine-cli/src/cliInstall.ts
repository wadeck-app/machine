import { INSTALLABLES, findInstallable, platformName, unsupportedMessage, type Installable } from '@wadeck-app/machine-core';
import { EXIT, type CommandContext, type Parsed } from './cliTypes.js';
import { NotInitializedError } from './errors.js';
import { readMachine } from './identity.js';
import { realInstallEnv, type InstallEnv } from './installEnv.js';
import { runInstallFlow, type FlowOptions } from './installFlow.js';
import { promptLine } from './prompt.js';

// `machine install [<id>] [--dry-run | --check | --remove] [--yes]`: thin front-end over installFlow.ts and the registry of machine-core.
// LOCAL ONLY: no daemon command, peer frame or app-module route exists for it (hard rule 7: the daemon is never elevated).

const USAGE = 'machine install <id> [--dry-run | --check | --remove] [--yes] [--json]';

/** The flags of `install` used where they do not belong, or in a combination that means nothing. Undefined when the command line is fine. */
export function installFlagProblem(command: string, rest: string[], args: Parsed): string | undefined {
  const used: string[] = [...(args.yes ? ['--yes'] : []), ...(args.dryRun ? ['--dry-run'] : []), ...(args.check ? ['--check'] : [])];
  if (command !== 'install') {
    return used.length === 0 ? undefined : `${used.join(', ')} only apply to \`machine install <id>\` (see \`machine install --help\`)`;
  }
  const flags = [...used, ...(args.remove ? ['--remove'] : [])];
  if (rest.length === 0 && flags.length > 0) {
    return `${flags[0] as string} needs an id: ${USAGE} (\`machine install\` lists the ids)`;
  }
  if (args.check && flags.length > 1) {
    return `--check only reads: it cannot be combined with ${flags.filter((f) => f !== '--check').join(' or ')}`;
  }
  return undefined;
}

function listText(platform: string): string {
  const lines = ['machine install: what machine can set up on THIS machine (local command: run it in a terminal here, never remotely)', ''];
  for (const d of INSTALLABLES) {
    const here = d.platforms.includes(platform);
    lines.push(`  ${d.id}   platforms: ${d.platforms.join(', ')}   ${here ? `supported on this machine (${platformName(platform)})` : unsupportedMessage(d, platform)}`, `      ${d.description}`);
  }
  lines.push('', `Usage: ${USAGE}`, '  machine install <id> --dry-run   shows every file and command, changes nothing', '  machine install <id>             shows them, asks y/N, then runs them with sudo (your own password)', 'More: machine install --help');
  return `${lines.join('\n')}\n`;
}

export async function runInstallCommand(ctx: CommandContext): Promise<number> {
  const { args, rest, io, emit, fail, configDir } = ctx;
  const env: InstallEnv = { ...realInstallEnv(), ...io.install };
  if (rest.length === 0) {
    emit(
      { platform: env.platform, installables: INSTALLABLES.map((d) => ({ id: d.id, description: d.description, platforms: d.platforms, supportedHere: d.platforms.includes(env.platform) })) },
      listText(env.platform),
    );
    return EXIT.ok;
  }
  const id = rest[0] as string;
  const def: Installable | undefined = findInstallable(id);
  if (def === undefined) {
    return fail(`unknown installable ${JSON.stringify(id.slice(0, 40))}: \`machine install\` lists them (${INSTALLABLES.map((d) => d.id).join(', ')})`, EXIT.usage);
  }

  const mode: FlowOptions['mode'] = args.check ? 'check' : args.remove ? 'remove' : 'install';
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
