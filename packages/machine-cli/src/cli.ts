import { createDaemonClient } from '@wadeck-app/singleton-daemon-kit';
import { parseAdvertise } from './addressDiscovery.js';
import { addRelayView, relayLines } from './listPresence.js';
import { runNetworkCommand } from './cliNetwork.js';
import { runStartupCommand } from './cliStartup.js';
import { EXIT, UsageError, type CliIo, type CommandContext, type Parsed } from './cliTypes.js';
import { makeCommands, type AliasAnswer, type ListAnswer, type NotInitialized, type ResolveAnswer, type StatusAnswer } from './commands.js';
import { startMachineDaemon } from './daemonEntry.js';
import { initMachine } from './identity.js';
import { MAX_PROMPT_TIMEOUT_SECONDS } from './prompt.js';
import { resolveConfigDir } from './paths.js';
import { appVersion } from './version.js';

export { EXIT, type CliIo } from './cliTypes.js';

const HELP = `machine - private network between your machines

Usage: machine <command> [options]

Commands:
  init --name <name>                 create this machine's UUID and identity key
  status                             identity, enrollment state, policy, revocation version and peers last seen
                                     behind on it, what was left out
  list                               this machine and its registered peers (and the revocation version each peer
                                     announced at its last handshake); with a relay also their last known
                                     addresses and whether the relay says they are online (a relay problem is a
                                     warning line, never an error)
  resolve <reference>                show which machine a reference means
  alias list | set <alias> <ref> | rm <alias>
  run <machine> [--address <host:port>] [--shell cmd|ps|bash|sh] -- <command...>
                                     run one allowed command on a peer. Without --address the addresses come from
                                     the relay (the signed address record of the peer, verified against its
                                     registration), tried in order with 3 s each; --address overrides it and is the
                                     only way without a relay. Before the command, the two machines compare their
                                     admin revocation lists and hand each other what the other lacks (a revocation the
                                     relay never delivered still arrives); a peer that turns out revoked is refused
  daemon [--api-port <n>] [--peer-port <n>] [--peer-host <host>] [--advertise <host[:port]>]...
                                     run the daemon in the foreground (started by orch). With a relay (after join)
                                     it publishes its signed address record: the non-loopback interface addresses
                                     with the peer port, or ONLY the --advertise ones when given (repeatable, up
                                     to 8: a NAT, a hostname, a VPN, an SSH tunnel; without a port the peer port is
                                     used). With nothing to publish it says why and publishes nothing
  stop                               stop the running daemon
  join [<relay-host-or-url> | <code>] [--relay <url>] [--force] [--no-wait] [--timeout <seconds>] [--yes-final-code <code>] [--prompt-timeout <s>] [--auto-startup]
                                     --timeout (default 900 s) is the wait for the admin; it never outlasts the candidacy (15 min)
                                     or the device code. An approval received but not confirmed is kept 15 minutes only:
                                     later it is discarded and nothing is pinned (ask the admin again: join --resume).
                                     get a relay token, post this machine's candidacy (with its uuid), wait for the
                                     admin's approval, then show the final code and enroll. Without a code: device
                                     login. It prints a code and a page; open the page (any browser), check that
                                     the address and label match this machine and type the code there. Nothing is
                                     typed here, no terminal is needed (SSH works). Ctrl-C or a lost session during
                                     the device login stores nothing: run \`machine join <relay>\` again for a new code
                                     (the device code is never printed nor saved).
                                     The argument: only digits (spaces and hyphens allowed, 1234 5678) = pairing
                                     code of the admin (fallback, claimed instead of a device login); anything
                                     else = the relay, a URL or a bare host (relay.example.com means
                                     https://relay.example.com). There is no default relay: name it the first time (a pairing
                                     code needs --relay too); later runs reuse the one stored in relay.json.
                                     --relay <url> is the same as the relay argument (not both)
                                     join never starts anything at login by itself; it ends by suggesting
                                     \`machine startup enable\`. --auto-startup runs it as the last step (a failure
                                     there is reported and makes join exit 1; the join itself is not undone)
  startup enable | disable | status  start the daemon at login through an orch startup job named "machine"
                                     (needs orch: npm i -g @wadeck-app/orchestrator-cli). enable creates or refreshes
                                     the job (run it again after moving machine); disable removes it; status shows
                                     whether it exists, its command, the form registered (staged launcher, staged launcher through a wscript wrapper on Windows, or development node + bundle) and whether it is up to date (exit 0 either way).
                                     It never runs \`orch install\`: if orch does not start at login, run it yourself
  join --resume [--timeout <seconds>] [--yes-final-code <code>]
                                     continue after Ctrl-C or a timeout with the saved token (posts a new
                                     candidacy when the previous one expired or was posted without uuid)

Administration (enrollment through the relay, or by files):
  admin login [<code>] [--relay <url>] [--force]
                                     claim a FULL-ACCESS pairing code of the relay console and keep the token in
                                     _secrets_/relay-admin.json (a machine-scoped token is refused)
  admin approve [<id>] [--relay <url>] [--days <n>] [--reject]
                                     without id: list the pending candidacies (id, name, host, address, age, code);
                                     with an id (or unique prefix): show it (the code is information only), ask
                                     "approve this machine?" (y/N, terminal only, no way to skip it), type the admin
                                     passphrase, sign and send the approval, then print the FINAL code: the one
                                     comparison. On the new machine it must read exactly the same; if not, run
                                     \`admin revoke\`. Then the other peers are told about the new machine through the
                                     relay (a failure is reported and exits 1, the approval stands; finish with
                                     \`admin distribute\`). --reject refuses a candidacy (no passphrase)
  admin revoke <machine>             revoke a trusted machine (name, alias, uuid or prefix): shows it, asks y/N,
                                     admin passphrase, installs the signed revocation, then (with the admin relay
                                     token) sends it to every other machine through the relay and removes the revoked
                                     machine from the relay. Without the token only THIS machine is updated, and a
                                     line says how to inform the others
  admin distribute <machine|uuid>    send again what an approval or a revocation sends: the peer documents of a trusted
                                     machine (to it and to each other peer), or the revocation of a machine revoked
                                     here (by uuid). Safe to run again: same ids, nothing duplicated. Admin passphrase
  admin distribute --policy <signed.json>
                                     send a policy signed earlier (admin sign-policy --out) to its target machine
  admin forget-relay-record <machine|uuid>
                                     remove the record, the binding of the uuid to a token and the inbox of a machine on
                                     the relay (y/N, needs the admin relay token, no passphrase): the way to make room when
                                     the relay answers \`too_many_machines\` (50 machines per token) at \`admin approve\`, for
                                     machines that are gone. A machine that comes back must run \`join --resume\` and be
                                     approved again; what waited in its inbox is gone (admin distribute sends it again).
                                     After a token change it is not needed: a new join and an approval rebind the uuid
  admin init                         create the admin key on this machine (passphrase shown once)
  admin sign-policy <draft.json>     sign a policy draft after showing it (--out <file>, else stdout); with the admin relay
                                     token it is also sent to its target machine through the relay
  admin register <info.json> --out <bundle.json> [--days <n>] [--secret-from <bundle.json>]
                                     sign a machine's registration; the bundle holds a secret
  admin pin <admin.json>             trust the admin key of another machine
  peer info [--out <file>]           this machine's public identity, to give to the admin
  peer import <bundle.json>          trust a peer from an admin-signed bundle
  peer forget-record <peer>          forget the highest address record seq seen for ONE peer (y/N). Only after confirming
                                     out of band that the peer was reinstalled: it lifts the rollback check for that peer once
  policy install <signed.json>       install a policy signed by the admin for this machine

Options:
  --json                 machine-readable output
  --relay <url>          relay for \`join\` and \`admin login\` (no default: required the first time, then the stored one is reused; https only, http on 127.0.0.1 for tests)
  --prompt-timeout <s>   limit for every question to a person (y/N, passphrase, final code): 1 to 3600 s, default 120; on expiry the
                         question is cancelled, nothing is assumed and nothing is signed, pinned or revoked (join, admin approve|revoke|sign-policy|distribute|register|login)
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
  const out: Parsed = { positional: [], passthrough: [], json: false, help: false, replace: false, force: false, resume: false, noWait: false, reject: false, autoStartup: false, advertise: [] };
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
    else if (a === '--auto-startup') out.autoStartup = true;
    else if (a === '--timeout') out.timeout = valueOf('--timeout');
    else if (a === '--prompt-timeout') out.promptTimeout = valueOf('--prompt-timeout');
    else if (a === '--yes-final-code') out.yesFinalCode = valueOf('--yes-final-code');
    else if (a === '--name') out.name = valueOf('--name');
    else if (a === '--out') out.out = valueOf('--out');
    else if (a === '--policy') out.policy = valueOf('--policy');
    else if (a === '--address') out.address = valueOf('--address');
    else if (a === '--shell') out.shell = valueOf('--shell');
    else if (a === '--days') out.days = valueOf('--days');
    else if (a === '--secret-from') out.secretFrom = valueOf('--secret-from');
    else if (a === '--peer-port') out.peerPort = valueOf('--peer-port');
    else if (a === '--api-port') out.apiPort = valueOf('--api-port');
    else if (a === '--peer-host') out.peerHost = valueOf('--peer-host');
    else if (a === '--advertise') out.advertise.push(valueOf('--advertise'));
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

  if (args.advertise.length > 0 && command !== 'daemon') return fail('--advertise only applies to `machine daemon` (it chooses the addresses the daemon publishes in its address record)', EXIT.usage);
  if (args.autoStartup && command !== 'join') return fail('--auto-startup only applies to `machine join` (to start machine at login by itself, run `machine startup enable`)', EXIT.usage);

  if (args.promptTimeout !== undefined) {
    const seconds = Number(args.promptTimeout);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_PROMPT_TIMEOUT_SECONDS) {
      return fail(`--prompt-timeout must be a whole number of seconds from 1 to ${MAX_PROMPT_TIMEOUT_SECONDS}, got "${args.promptTimeout}"`, EXIT.usage);
    }
    // Refused rather than silently ignored: a command that never prompts has nothing to limit.
    const prompts = command === 'join' || (command === 'admin' && ['approve', 'revoke', 'sign-policy', 'distribute', 'register', 'login', 'forget-relay-record'].includes(rest[0] ?? '') || (command === 'peer' && rest[0] === 'forget-record'));
    if (!prompts) return fail('--prompt-timeout only applies to the commands that ask a question: join, admin approve, admin revoke, admin sign-policy, admin distribute, admin register, admin login, admin forget-relay-record', EXIT.usage);
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
      // Validated before anything starts: a typo must not cost a daemon that publishes the wrong addresses.
      let advertise: ReturnType<typeof parseAdvertise>;
      try {
        advertise = parseAdvertise(args.advertise);
      } catch (e) {
        throw new UsageError((e as Error).message);
      }
      const daemon = await startMachineDaemon(configDir, {
        ...(advertise.length > 0 ? { advertise } : {}),
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

    if (command === 'startup') return await runStartupCommand(ctx);

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
          ...(r.revocationVersion === undefined ? [] : [`revocations: version ${r.revocationVersion}`]),
          ...(r.peersBehind ?? []).map((p) => `[warn] ${p.name} announced revocation version ${p.revocationVersionSeen} at its last handshake (this machine holds ${r.revocationVersion}) and its revocations differ from this machine's: it may still trust a revoked machine until it meets a peer that has the lists; run "machine admin distribute <revoked machine>" or make it connect to one`),
          ...(r.problems ?? []).map((p) => `[warn] ${p}`),
        ];
        emit(r, `${lines.join('\n')}\n`);
        return EXIT.ok;
      }
      case 'list': {
        const r = (await client.send('list')) as ListAnswer | NotInitialized;
        if (notInitialized(r)) return fail(r.message);
        // With a relay: the addresses and the presence the relay knows. A relay problem is a warning line here, never an error of `list`.
        const view = await addRelayView(configDir, r, Math.floor((io.now?.() ?? new Date()).getTime() / 1000), undefined, { allowLocal: io.allowLoopbackPeers === true });
        const lines = [`${r.self.name} (${r.self.uuid}) [this machine]`, ...view.peers.flatMap((p) => [`${p.name} (${p.uuid})${p.aliases.length ? ` aliases: ${p.aliases.join(', ')}` : ''}`, ...(p.revocationVersionSeen === undefined ? [] : [`  revocations: version ${p.revocationVersionSeen} at the last handshake`]), ...relayLines(p.relay)])];
        if (r.revocationWarning !== undefined) io.stderr(`[warn] ${r.revocationWarning}
`);
        if (view.relayWarning !== undefined) io.stderr(`[warn] ${view.relayWarning}\n`);
        emit(view, `${lines.join('\n')}\n${r.note ? `${r.note}\n` : ''}`);
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
