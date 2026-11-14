import { createDaemonClient } from '@wadeck-app/singleton-daemon-kit';
import { runNetworkCommand } from './cliNetwork.js';
import { EXIT, UsageError, type CliIo, type CommandContext, type Parsed } from './cliTypes.js';
import { makeCommands, type AliasAnswer, type ListAnswer, type NotInitialized, type ResolveAnswer, type StatusAnswer } from './commands.js';
import { startMachineDaemon } from './daemonEntry.js';
import { initMachine } from './identity.js';
import { resolveConfigDir } from './paths.js';
import { appVersion } from './version.js';

export { EXIT, type CliIo } from './cliTypes.js';

const HELP = `machine - private network between your machines

Usage: machine <command> [options]

Commands:
  init --name <name>                 create this machine's UUID and identity key
  status                             identity, enrollment state, policy, what was left out
  list                               this machine and its registered peers
  resolve <reference>                show which machine a reference means
  alias list | set <alias> <ref> | rm <alias>
  run <machine> --address <host:port> [--shell cmd|ps|bash|sh] -- <command...>
                                     run one allowed command on a peer
  daemon [--api-port <n>] [--peer-port <n>] [--peer-host <host>]
                                     run the daemon in the foreground (started by orch)
  stop                               stop the running daemon
  join [<code>] [--relay <url>] [--force] [--no-wait] [--timeout <seconds>] [--yes-final-code <code>]
                                     join the relay with a pairing code from the admin (asked at the prompt when
                                     omitted), post this machine's candidacy, print the code to compare, wait for
                                     the admin's approval, then show the final code and enroll
  join --resume [--timeout <seconds>] [--yes-final-code <code>]
                                     continue after Ctrl-C or a timeout with the saved token (posts a new
                                     candidacy when the previous one expired)

Administration (enrollment through the relay, or by files):
  admin login [<code>] [--relay <url>] [--force]
                                     claim a FULL-ACCESS pairing code of the relay console and keep the token in
                                     _secrets_/relay-admin.json (a machine-scoped token is refused)
  admin approve [<id>] [--relay <url>] [--days <n>] [--reject]
                                     without id: list the pending candidacies (id, name, host, address, age, code);
                                     with an id (or unique prefix): show it, compare the code with the candidate's
                                     screen (y/N, terminal only, no way to skip it), type the admin passphrase,
                                     sign and send the approval, then print the final code to compare again;
                                     --reject refuses it (no passphrase)
  admin init                         create the admin key on this machine (passphrase shown once)
  admin sign-policy <draft.json>     sign a policy draft after showing it (--out <file>, else stdout)
  admin register <info.json> --out <bundle.json> [--days <n>] [--secret-from <bundle.json>]
                                     sign a machine's registration; the bundle holds a secret
  admin pin <admin.json>             trust the admin key of another machine
  peer info [--out <file>]           this machine's public identity, to give to the admin
  peer import <bundle.json>          trust a peer from an admin-signed bundle
  policy install <signed.json>       install a policy signed by the admin for this machine

Options:
  --json                 machine-readable output
  --relay <url>          relay for \`join\` and \`admin login\` (default https://relay.example.test; https only, http on 127.0.0.1 for tests)
  --out <file>           write a signed document or bundle to a file (--force to overwrite)
  --config-dir <path>    configuration directory (default: MACHINE_CONFIG_DIR or ~/.config/machine)
  --help, -h             this help

A reference is a machine name, a local alias, a UUID or a unique UUID prefix of 4+ hex characters.
Everything after "--" in \`run\` is the command, sent exactly as written.

Exit codes: 0 ok, 1 failure (relay failures included, reason on stderr), 2 usage error, 3 unknown or ambiguous machine reference.
\`run\` returns the exit code of the remote command; its own failures (refused by the peer, unknown machine,
no connection) are 255 with the reason on stderr.
`;

function parse(argv: string[]): Parsed {
  const out: Parsed = { positional: [], passthrough: [], json: false, help: false, replace: false, force: false, resume: false, noWait: false, reject: false };
  const split = argv.indexOf('--');
  const own = split === -1 ? argv : argv.slice(0, split);
  if (split !== -1) out.passthrough = argv.slice(split + 1);
  for (let i = 0; i < own.length; i++) {
    const a = own[i] as string;
    const valueOf = (flag: string): string => {
      const v = own[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
      return v;
    };
    if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--replace') out.replace = true;
    else if (a === '--force') out.force = true;
    else if (a === '--resume') out.resume = true;
    else if (a === '--no-wait') out.noWait = true;
    else if (a === '--reject') out.reject = true;
    else if (a === '--timeout') out.timeout = valueOf('--timeout');
    else if (a === '--yes-final-code') out.yesFinalCode = valueOf('--yes-final-code');
    else if (a === '--name') out.name = valueOf('--name');
    else if (a === '--out') out.out = valueOf('--out');
    else if (a === '--address') out.address = valueOf('--address');
    else if (a === '--shell') out.shell = valueOf('--shell');
    else if (a === '--days') out.days = valueOf('--days');
    else if (a === '--secret-from') out.secretFrom = valueOf('--secret-from');
    else if (a === '--peer-port') out.peerPort = valueOf('--peer-port');
    else if (a === '--api-port') out.apiPort = valueOf('--api-port');
    else if (a === '--peer-host') out.peerHost = valueOf('--peer-host');
    else if (a === '--relay') out.relay = valueOf('--relay');
    else if (a === '--config-dir') out.configDir = valueOf('--config-dir');
    else if (a === '--passphrase' || a.startsWith('--passphrase=')) {
      throw new UsageError('a passphrase is never accepted as an argument (it would stay in your shell history and in the process list): it is typed at the prompt');
    } else if (a.startsWith('--')) throw new UsageError(`unknown option "${a}": see \`machine --help\``);
    else out.positional.push(a);
  }
  return out;
}

export async function runCli(argv: string[], io: CliIo, env: Record<string, string | undefined> = process.env): Promise<number> {
  let args: Parsed;
  try {
    args = parse(argv);
  } catch (e) {
    io.stderr(`[fail] ${(e as Error).message}\n`);
    return EXIT.usage;
  }
  if (args.help) {
    io.stdout(HELP);
    return EXIT.ok;
  }
  const [command, ...rest] = args.positional;
  if (command === undefined) {
    io.stderr(`[fail] no command given\n\n${HELP}`);
    return EXIT.usage;
  }

  const fail = (message: string, code: number = EXIT.failure): number => {
    io.stderr(`[fail] ${message}\n`);
    return code;
  };
  const emit = (value: unknown, text: string): void => io.stdout(args.json ? `${JSON.stringify(value, null, 2)}\n` : text);

  // Commands that take no positional argument refuse one instead of silently ignoring a typo.
  const maxPositional: Record<string, number> = { init: 0, status: 0, list: 0, daemon: 0, stop: 0, resolve: 1, join: 1 };
  const allowed = maxPositional[command];
  if (allowed !== undefined && rest.length > allowed) {
    return fail(`unexpected argument "${rest[allowed]}" for \`machine ${command}\`: see \`machine --help\``, EXIT.usage);
  }
  if (args.passthrough.length > 0 && command !== 'run') {
    return fail(`"--" is only used by \`machine run\` (it introduces the command to run on the peer)`, EXIT.usage);
  }

  try {
    const configDir = resolveConfigDir(args.configDir, env);
    const ctx: CommandContext = { args, rest, io, configDir, env, fail, emit };

    if (command === 'init') {
      if (args.name === undefined) return fail('init needs --name <name>, for example `machine init --name desktop`', EXIT.usage);
      const m = initMachine(configDir, args.name);
      emit({ uuid: m.uuid, name: m.name }, `[ok] initialized "${m.name}"\nuuid: ${m.uuid}\nnext: \`machine admin init\` on the admin machine, or \`machine peer info\` to give to the admin\n`);
      return EXIT.ok;
    }

    if (command === 'daemon') {
      const number = (value: string | undefined, flag: string): number | undefined => {
        if (value === undefined) return undefined;
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0 || n > 65535) throw new UsageError(`${flag} must be a port number (0 to 65535), got "${value}"`);
        return n;
      };
      const peerPort = number(args.peerPort, '--peer-port');
      const apiPort = number(args.apiPort, '--api-port');
      const daemon = await startMachineDaemon(configDir, {
        version: appVersion(),
        ...(apiPort !== undefined ? { port: apiPort } : {}),
        ...(peerPort !== undefined ? { peerPort } : {}),
        ...(args.peerHost ? { peerHost: args.peerHost } : {}),
        log: (line) => io.stderr(`[machine] ${line}\n`),
      });
      io.stdout(`[ok] machine daemon: local API 127.0.0.1:${daemon.port}, peers on port ${daemon.peerPort} (config ${configDir})\n`);
      await daemon.stopped;
      return EXIT.ok;
    }

    const handled = await runNetworkCommand(command, ctx);
    if (handled !== undefined) return handled;

    // Everything else goes through the daemon when it runs and through the same code in-process when it does not.
    const client = createDaemonClient({ configDir, commands: makeCommands(configDir, appVersion) });
    const notInitialized = (r: { initialized?: boolean; message?: string }): r is NotInitialized => r.initialized === false;

    switch (command) {
      case 'stop': {
        if (!(await client.isRunning())) {
          emit({ stopped: false }, '[ok] daemon was not running\n');
          return EXIT.ok;
        }
        await (client as unknown as { send(command: string): Promise<unknown> }).send('quit');
        for (let i = 0; i < 50 && (await client.isRunning()); i++) await new Promise((r) => setTimeout(r, 100));
        if (await client.isRunning()) return fail('the daemon did not stop within 5 seconds: stop its process (orch: `orch stop` on the machine job)');
        emit({ stopped: true }, '[ok] daemon stopped\n');
        return EXIT.ok;
      }
      case 'status': {
        const r = (await client.send('status')) as StatusAnswer | NotInitialized;
        if (notInitialized(r)) return fail(r.message);
        const lines = [
          `${r.name} (${r.uuid})`,
          `version: ${r.version}`,
          `config: ${r.configDir}`,
          r.enrolled ? `enrolled, ${r.peers} peer(s), ${r.policyVersion === undefined ? 'no policy (every command is refused)' : `policy version ${r.policyVersion}`}` : (r.note ?? 'not enrolled'),
          ...(r.problems ?? []).map((p) => `[warn] ${p}`),
        ];
        emit(r, `${lines.join('\n')}\n`);
        return EXIT.ok;
      }
      case 'list': {
        const r = (await client.send('list')) as ListAnswer | NotInitialized;
        if (notInitialized(r)) return fail(r.message);
        const lines = [`${r.self.name} (${r.self.uuid}) [this machine]`, ...r.peers.map((p) => `${p.name} (${p.uuid})${p.aliases.length ? ` aliases: ${p.aliases.join(', ')}` : ''}`)];
        emit(r, `${lines.join('\n')}\n${r.note ? `${r.note}\n` : ''}`);
        return EXIT.ok;
      }
      case 'resolve': {
        const ref = rest[0];
        if (ref === undefined) return fail('resolve needs a reference: `machine resolve <name|alias|uuid>`', EXIT.usage);
        const r = (await client.send('resolve', { ref })) as ResolveAnswer;
        if ('initialized' in r) return fail(r.message);
        if (!r.ok) return fail(r.message, EXIT.reference);
        emit(r, `${r.uuid}${r.name ? ` (${r.name})` : ''} via ${r.via}\n`);
        return EXIT.ok;
      }
      case 'alias': {
        const [sub, a, b] = rest;
        const arity: Record<string, number> = { list: 0, set: 2, rm: 1 };
        const expected = sub === undefined ? undefined : arity[sub];
        if (expected !== undefined && rest.length - 1 > expected) return fail(`unexpected argument "${rest[expected + 1]}" for \`machine alias ${sub}\``, EXIT.usage);
        if (sub === 'list') {
          const aliases = (await client.send('aliasList')) as Record<string, string>;
          emit(aliases, Object.keys(aliases).length ? `${Object.entries(aliases).map(([k, v]) => `${k} -> ${v}`).join('\n')}\n` : 'no alias\n');
          return EXIT.ok;
        }
        if (sub === 'set') {
          if (a === undefined || b === undefined) return fail('usage: machine alias set <alias> <reference>', EXIT.usage);
          const r = (await client.send('aliasSet', { alias: a, ref: b, replace: args.replace })) as AliasAnswer;
          if ('initialized' in r) return fail(r.message);
          if (!r.ok) return fail(r.message, r.reason === 'conflict' ? EXIT.failure : EXIT.reference);
          emit(r, `[ok] ${r.alias} -> ${r.uuid}${r.previous ? ` (was ${r.previous})` : ''}\n`);
          return EXIT.ok;
        }
        if (sub === 'rm') {
          if (a === undefined) return fail('usage: machine alias rm <alias>', EXIT.usage);
          const r = (await client.send('aliasRemove', { alias: a })) as { ok: boolean; message?: string };
          if (!r.ok) return fail(r.message ?? 'no such alias');
          emit(r, `[ok] removed ${a}\n`);
          return EXIT.ok;
        }
        return fail('usage: machine alias list | set <alias> <reference> | rm <alias>', EXIT.usage);
      }
      default:
        return fail(`unknown command "${command}": see \`machine --help\``, EXIT.usage);
    }
  } catch (e) {
    return fail((e as Error).message, e instanceof UsageError ? EXIT.usage : EXIT.failure);
  }
}
