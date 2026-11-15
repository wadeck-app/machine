import { createDaemonClient } from '@wadeck-app/singleton-daemon-kit';
import { parseAdvertise } from './addressDiscovery.js';
import { whenText } from './humanTime.js';
import { addRelayView, relayLines } from './listPresence.js';
import type { RevokedMachine } from './network.js';
import { runNetworkCommand } from './cliNetwork.js';
import { printUpdateNotice, runCliMeta } from './cliMeta.js';
import { runStartupCommand } from './cliStartup.js';
import { EXIT, UsageError, type CliIo, type CommandContext, type Parsed } from './cliTypes.js';
import { makeCommands, type AliasAnswer, type ListAnswer, type NotInitialized, type ResolveAnswer, type StatusAnswer } from './commands.js';
import { startMachineDaemon } from './daemonEntry.js';
import { checkHint } from '@wadeck-app/machine-core';
import { chooseMachineName, initMachine } from './identity.js';
import { MachineNameError } from './errors.js';
import { MAX_PROMPT_TIMEOUT_SECONDS } from './prompt.js';
import { resolveConfigDir } from './paths.js';
import { openCliLog, type CliLog } from './cliLog.js';
import { appVersion } from './version.js';

export { EXIT, type CliIo } from './cliTypes.js';

const HELP = `machine - private network between your machines

Usage: machine <command> [options]

Getting started (one command per machine; the name of a machine is the computer name, lowercase):
  first machine (it also becomes the admin machine):
    machine setup <relay>            creates the admin key (you choose its passphrase), does the full-access login and the
                                     device login (you type each code in the relay console), approves itself and enrolls
  every other machine:
    machine join <relay>             on the new machine: waits for the admin and finishes by itself; shows the
                                     security code to compare with the admin machine
    machine admin approve            on the admin machine: shows the new machine, asks y/N and the passphrase, prints the
                                     security code (with several pending machines it lists them: pass the id)
  allow a command on a machine (admin machine):
    machine admin allow <machine> -- <command>      (--list shows what is allowed, --remove withdraws it)
  then, on each machine: machine startup enable (start at login; never done by itself unless join/setup --auto-startup)
  Stays manual: the passphrase, the codes typed in the relay console (full-access login code, relay login code) and the security-code comparison (the human steps).
  Three kinds of code, never mixed: the relay login codes (XXXX-XXXX, shown here, typed in the relay console), the pairing code (8
  digits, shown by the relay console: scripts, or a relay without the full-access login) and the security code (25 digits in five groups, compared between two machines: the one that protects you).

Commands:
  setup <relay> [--generate] [--hint <text>] [--name <name>] [--auto-startup]
                                     the first machine in one command: identity (name from the computer name), admin key
                                     (passphrase typed twice, or --generate for a random one), the full-access login
                                     (a request you confirm in the relay console, kept for next time), device login, self-approval
                                     (the passphrase just chosen signs it) and enrollment. Run it again after an interruption:
                                     what exists is kept. Other machines never create an admin key: they use join
  init [--name <name>]               create this machine's UUID and identity key only (optional: setup and join do it). The
                                     name is --name or the computer name, normalised to lowercase letters, digits and hyphens
                                     (a note says what was changed); it is the stable reference signed at enrollment, a
                                     friendlier local label is \`machine alias set <label> <name>\`
  status                            identity, enrollment state, policy, revocation version and peers last seen
                                     behind on it, the machines revoked here (name, uuid, when), what was left out
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
  join [<relay-host-or-url> | <code>] [--relay <url>] [--force] [--no-wait] [--timeout <seconds>] [--yes-final-code <code>] [--prompt-timeout <s>] [--auto-startup] [--name <name>]
                                     one command: the identity is created when there is none (--name, else the computer name). On the
                                     machine that holds the admin key it approves its own enrollment (one passphrase, nothing to compare;
                                     needs the admin relay token: \`machine admin login\`, or use \`machine setup\`). On any other machine it
                                     prints what the admin runs (\`machine admin approve\`), waits, then shows the security code, which must read exactly the same on the admin machine
                                     --timeout (default 900 s) is the wait for the admin; it never outlasts the candidacy (15 min)
                                     or the device code. An approval received but not confirmed is kept 15 minutes only:
                                     later it is discarded and nothing is pinned (ask the admin again: join --resume).
                                     get a relay token, post this machine's candidacy (with its uuid), wait for the
                                     admin's approval, then show the security code and enroll. Without a code: device
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
  join --resume [--timeout <seconds>] [--yes-final-code "<security code>"]   (quote the code: it has spaces)
                                     continue after Ctrl-C or a timeout with the saved token (posts a new
                                     candidacy when the previous one expired or was posted without uuid)
  cli version                        installed version and the latest published one
  cli update                         install the latest published version now (even with autoUpdate: false in
                                     config.yml), then refresh the startup job and restart the daemon when it runs
                                     under it; a remote command still running is cut. A development build refuses.
                                     The daemon also checks at start and every 30 minutes (autoUpdate: false in
                                     <config dir>/config.yml turns that off)
  cli rollback                       reinstall the version that preceded the last update, then refresh and restart as update
  cli self-check [--quiet]           check the install (release version, Node >= 22, platform package pinned by this
                                     package, writable config dir and launcher folder); run by the updater before it
                                     accepts an update. Exit 1 when a check fails
  cli logs [--follow | -f]           the updater and daemon log of today (<config dir>/logs)
  cli post-update                    run by the updater after an update: refresh the startup job when it exists and restart
                                     the daemon when it runs an older version (run it yourself when the updater says so)

Administration (enrollment through the relay, or by files):
  admin login [<code>] [--relay <url>] [--force]
                                     without a code: FULL-ACCESS login, shows a code to type in the relay console (Tokens page)
                                     and keeps the token in _secrets_/relay-admin.json; a relay that predates it falls back
                                     to a pairing code, with a [warn] line. With a code: claims a FULL-ACCESS pairing code
                                     of the relay console (scripts). A machine-scoped token is refused either way
  admin approve [<id>] [--relay <url>] [--days <n>] [--reject]
                                     without id: no pending candidacy says so; exactly ONE goes straight to its details; several are listed
                                     (id, name, host, address, age) and you pass the id;
                                     the details, then ask
                                     "approve this machine?" (y/N, terminal only, no way to skip it), type the admin
                                     passphrase, sign and send the approval, then print the SECURITY code of the new
                                     machine (25 digits): the one comparison. On the new machine it must read exactly the same; if not, run
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
                                     the relay answers \`too_many_machines\` (the relay limit: 10 per token by default, configurable on the relay) at \`admin approve\`, for
                                     machines that are gone. A machine that comes back must run \`join --resume\` and be
                                     approved again; what waited in its inbox is gone (admin distribute sends it again).
                                     After a token change it is not needed: a new join and an approval rebind the uuid
  admin init [--generate] [--hint <text>]
                                     create the admin key on this machine. You choose its passphrase (hidden prompt, typed
                                     twice; at least 12 characters, 6 different, not only digits; below 20 a warning says a
                                     stolen machine could allow offline guessing, an encrypted copy of the key is on every
                                     machine). --generate, or an empty answer, makes a random one (100 bits, shown once). An optional hint
                                     (Enter = none, or --hint) is shown above every passphrase prompt on every machine
  admin allow <machine> [--shell cmd|ps|bash|sh] [--out <file>] -- <command...>
                                     allow ONE exact command on a machine (for every trusted peer): builds the next policy
                                     version from the last one signed here, shows the difference, asks y/N and the admin
                                     passphrase, signs, and sends it through the relay inbox (or installs it here when the
                                     machine is this one; --out writes the signed file, the way without an admin relay
                                     token). Without --shell: this machine's platform, said. --remove withdraws a command,
                                     --list shows what is allowed. Nothing widens without your signature
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
  --verbose              also show the candidacy code (join, setup, admin approve): internal by default, the admin machine recomputes
                         and checks it itself; the security code is the one to compare
  --prompt-timeout <s>   limit for every question to a person (y/N, passphrase, security code): 1 to 3600 s, default 120; on expiry the
                         question is cancelled, nothing is assumed and nothing is signed, pinned or revoked (join, admin approve|revoke|sign-policy|distribute|register|login)
  --out <file>           write a signed document or bundle to a file (--force to overwrite)
  --name <name>          machine name for init, join, setup when the identity is created (normalised: lowercase letters, digits, hyphens)
  --generate             random admin passphrase for admin init and setup (no question)
  --hint <text>          hint shown at every passphrase prompt, for admin init and setup (optional, max 80 printable ASCII characters, stored in clear in the key file: never write the passphrase in it)
  --config-dir <path>    configuration directory (default: MACHINE_CONFIG_DIR or ~/.config/machine)
  --help, -h             this help
  --version              print the version of this build (stamped in a release bundle) and exit

A reference is a machine name, a local alias, a UUID or a unique UUID prefix of 4+ hex characters.
Everything after "--" in \`run\` is the command, sent exactly as written.

Exit codes: 0 ok, 1 failure (relay failures included, reason on stderr), 2 usage error, 3 unknown or ambiguous machine reference.
\`run\` returns the exit code of the remote command; its own failures (refused by the peer, unknown machine,
no connection) are 255 with the reason on stderr.
`;

/** The revoked machines of `machine status`, apart from the peers: not trusted here, each with the uuid that names it for `forget-relay-record`. */
function revokedBlock(revoked: RevokedMachine[], nowSeconds: number): string[] {
  if (revoked.length === 0) return [];
  return [
    '',
    `revoked machines (${revoked.length}), refused here until approved again:`,
    ...revoked.map((m) => `  ${m.name ?? '(name unknown)'}  uuid ${m.uuid.slice(0, 8)}  ${m.installedAt === undefined ? 'revocation installed here: date not recorded' : `revocation installed here ${whenText(m.installedAt, nowSeconds)}`}${m.name !== undefined ? `  (remove it from the relay: machine admin forget-relay-record ${m.name})` : `  (remove it from the relay: machine admin forget-relay-record ${m.uuid})`}`),
  ];
}

function parse(argv: string[]): Parsed {
  const out: Parsed = { positional: [], passthrough: [], json: false, help: false, version: false, replace: false, force: false, resume: false, noWait: false, reject: false, autoStartup: false, verbose: false, quiet: false, generate: false, list: false, remove: false, follow: false, advertise: [], optionLike: [] };
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
    else if (a === '--version') out.version = true;
    else if (a === '--replace') out.replace = true;
    else if (a === '--force') out.force = true;
    else if (a === '--resume') out.resume = true;
    else if (a === '--no-wait') out.noWait = true;
    else if (a === '--reject') out.reject = true;
    else if (a === '--auto-startup') out.autoStartup = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--generate') out.generate = true;
    else if (a === '--list') out.list = true;
    else if (a === '--remove') out.remove = true;
    else if (a === '--follow' || a === '-f') out.follow = true;
    else if (a === '--timeout') out.timeout = valueOf('--timeout');
    else if (a === '--prompt-timeout') out.promptTimeout = valueOf('--prompt-timeout');
    else if (a === '--yes-final-code') {
      // The security code has five groups of five digits: typed without quotes the shell splits it, the groups are one value again.
      let code = valueOf('--yes-final-code');
      while (/^\d{5}$/.test(code.split(' ').at(-1) as string) && /^\d{5}$/.test(own[i + 1] ?? '')) code += ` ${own[++i] as string}`;
      out.yesFinalCode = code;
    }
    else if (a === '--name') out.name = valueOf('--name');
    else if (a === '--hint') out.hint = valueOf('--hint');
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
    } else if (a.startsWith('--')) {
      // A candidacy id is 128 random bits in base64url: one in 4096 starts with "--". After `admin approve` it is kept as the id; the command refuses it when no pending candidacy matches.
      if (out.positional[0] === 'admin' && out.positional[1] === 'approve' && out.positional.length === 2 && /^--[A-Za-z0-9_-]+$/.test(a)) {
        out.optionLike.push(a);
        out.positional.push(a);
      } else throw new UsageError(`unknown option "${a}": see \`machine --help\``);
    } else out.positional.push(a);
  }
  return out;
}

/** Runs one command and leaves its trace in the log of the configuration directory (`machine cli logs`). */
export async function runCli(argv: string[], io: CliIo, env: Record<string, string | undefined> = process.env): Promise<number> {
  let log: CliLog | undefined;
  try {
    // A command line that does not parse has no configuration directory to write to: the command itself reports it.
    // --help and --version need no configuration directory and say nothing worth diagnosing.
    const parsed = parse(argv);
    log = parsed.help || parsed.version ? undefined : openCliLog(resolveConfigDir(parsed.configDir, env), argv, io.stderr);
  } catch {
    log = undefined;
  }
  if (log === undefined) return runCommandLine(argv, io, env);
  const opened = log;
  const traced: CliIo = { ...io, stdout: (t) => (opened.output(t), io.stdout(t)), stderr: (t) => (opened.output(t), io.stderr(t)) };
  let code = 1;
  try {
    code = await runCommandLine(argv, traced, env);
    return code;
  } catch (e) {
    opened.output(`[fail] unexpected error: ${(e as Error).message}`);
    throw e;
  } finally {
    opened.finish(code);
  }
}

async function runCommandLine(argv: string[], io: CliIo, env: Record<string, string | undefined>): Promise<number> {
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
  // Before everything else (no config folder, no daemon, no update notice): CI reads it from the generated bundle.
  if (args.version) {
    io.stdout(`${appVersion()}\n`);
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
  const maxPositional: Record<string, number> = { init: 0, status: 0, list: 0, daemon: 0, stop: 0, resolve: 1, join: 1, setup: 1 };
  const allowed = maxPositional[command];
  if (allowed !== undefined && rest.length > allowed) {
    return fail(`unexpected argument "${rest[allowed]}" for \`machine ${command}\`: see \`machine --help\``, EXIT.usage);
  }
  if (args.passthrough.length > 0 && command !== 'run' && !(command === 'admin' && rest[0] === 'allow')) {
    return fail('"--" is only used by `machine run` and `machine admin allow` (it introduces the command line)', EXIT.usage);
  }
  if ((args.list || args.remove) && !(command === 'admin' && rest[0] === 'allow')) {
    return fail('--list and --remove only apply to `machine admin allow` (`machine admin allow <machine> --list`, `machine admin allow <machine> --remove -- <command>`)', EXIT.usage);
  }
  if (args.generate && !(command === 'setup' || (command === 'admin' && rest[0] === 'init'))) {
    return fail('--generate only applies to `machine admin init` and `machine setup` (a random admin passphrase instead of a chosen one)', EXIT.usage);
  }

  if (args.hint !== undefined) {
    if (!(command === 'setup' || (command === 'admin' && rest[0] === 'init'))) return fail('--hint only applies to `machine admin init` and `machine setup` (a hint shown at every passphrase prompt)', EXIT.usage);
    // The rules that do not depend on the passphrase fail now, before anything is asked.
    const problem = checkHint(args.hint);
    if (!problem.ok) return fail(`--hint: ${problem.message}`, EXIT.usage);
  }
  if (args.advertise.length > 0 && command !== 'daemon') return fail('--advertise only applies to `machine daemon` (it chooses the addresses the daemon publishes in its address record)', EXIT.usage);
  if (args.verbose && !(command === 'join' || command === 'setup' || (command === 'admin' && rest[0] === 'approve'))) {
    return fail('--verbose only applies to `machine join`, `machine setup` and `machine admin approve` (it also shows the candidacy code, which is internal by default)', EXIT.usage);
  }
  if (args.quiet && command !== 'cli') return fail('--quiet only applies to `machine cli self-check`', EXIT.usage);
  if (args.follow && command !== 'cli') return fail('--follow only applies to `machine cli logs`', EXIT.usage);
  if (args.autoStartup && command !== 'join' && command !== 'setup') return fail('--auto-startup only applies to `machine join` and `machine setup` (to start machine at login by itself, run `machine startup enable`)', EXIT.usage);

  if (args.promptTimeout !== undefined) {
    const seconds = Number(args.promptTimeout);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_PROMPT_TIMEOUT_SECONDS) {
      return fail(`--prompt-timeout must be a whole number of seconds from 1 to ${MAX_PROMPT_TIMEOUT_SECONDS}, got "${args.promptTimeout}"`, EXIT.usage);
    }
    // Refused rather than silently ignored: a command that never prompts has nothing to limit.
    const prompts = command === 'join' || command === 'setup' || (command === 'admin' && ['init', 'allow', 'approve', 'revoke', 'sign-policy', 'distribute', 'register', 'login', 'forget-relay-record'].includes(rest[0] ?? '') || (command === 'peer' && rest[0] === 'forget-record'));
    if (!prompts) return fail('--prompt-timeout only applies to the commands that ask a question: join, setup, admin init, admin approve, admin allow, admin revoke, admin sign-policy, admin distribute, admin register, admin login, admin forget-relay-record', EXIT.usage);
  }

  try {
    const configDir = resolveConfigDir(args.configDir, env);
    const ctx: CommandContext = { args, rest, io, configDir, env, fail, emit };

    // The result of a background update, once, on stderr. Not for `daemon` (it reads the state for its update-loop guard) nor `cli` (the updater and post-update).
    if (command !== 'daemon' && command !== 'cli') printUpdateNotice(configDir, io.cliMeta?.version ?? appVersion(), io.stderr);

    if (command === 'init') {
      // Optional: `machine join` and `machine setup` create the identity themselves. The name comes from --name or from the computer name.
      const choice = chooseMachineName(args.name, io.hostname);
      const m = initMachine(configDir, choice.name);
      if (choice.note !== undefined) io.stderr(`[info] ${choice.note}\n`);
      emit({ uuid: m.uuid, name: m.name }, `[ok] initialized "${m.name}"\nuuid: ${m.uuid}\nnext: \`machine setup <relay>\` on the first machine of the network, \`machine join <relay>\` on the others\n`);
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
    if (command === 'cli') return await runCliMeta(ctx);

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
          ...revokedBlock(r.revoked ?? [], Math.floor((io.now?.() ?? new Date()).getTime() / 1000)),
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
        const nowSeconds = Math.floor((io.now?.() ?? new Date()).getTime() / 1000);
        const view = await addRelayView(configDir, r, nowSeconds, undefined, { allowLocal: io.allowLoopbackPeers === true });
        const lines = [`${r.self.name} (${r.self.uuid}) [this machine]${r.self.aliases.length ? ` aliases: ${r.self.aliases.join(', ')}` : ''}`,...view.peers.flatMap((p) => [`${p.name} (${p.uuid})${p.aliases.length ? ` aliases: ${p.aliases.join(', ')}` : ''}`, ...(p.revocationVersionSeen === undefined ? [] : [`  revocations: version ${p.revocationVersionSeen} at the last handshake`]), ...relayLines(p.relay, nowSeconds)])];
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
          // References are case-insensitive: "Home" is stored as "home", and the CLI says so.
          if (a !== a.toLowerCase()) io.stderr(`[info] alias stored as "${a.toLowerCase()}" (references are case-insensitive)\n`);
          const r = (await client.send('aliasSet', { alias: a.toLowerCase(), ref: b, replace: args.replace })) as AliasAnswer;
          if ('initialized' in r) return fail(r.message);
          if (!r.ok) return fail(r.message, r.reason === 'conflict' ? EXIT.failure : EXIT.reference);
          emit(r, `[ok] ${r.alias} -> ${r.uuid}${r.previous ? ` (was ${r.previous})` : ''}\n`);
          return EXIT.ok;
        }
        if (sub === 'rm') {
          if (a === undefined) return fail('usage: machine alias rm <alias>', EXIT.usage);
          const r = (await client.send('aliasRemove', { alias: a.toLowerCase() })) as { ok: boolean; message?: string };
          if (!r.ok) return fail(r.message ?? 'no such alias');
          emit(r, `[ok] removed ${a.toLowerCase()}\n`);
          return EXIT.ok;
        }
        return fail('usage: machine alias list | set <alias> <reference> | rm <alias>', EXIT.usage);
      }
      default:
        return fail(`unknown command "${command}": see \`machine --help\``, EXIT.usage);
    }
  } catch (e) {
    return fail((e as Error).message, e instanceof UsageError || e instanceof MachineNameError ? EXIT.usage : EXIT.failure);
  }
}
