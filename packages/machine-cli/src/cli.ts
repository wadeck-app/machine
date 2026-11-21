import { createDaemonClient } from '@wadeck-app/singleton-daemon-kit';
import { parseAdvertise } from './addressDiscovery.js';
import { whenText } from './humanTime.js';
import { addRelayView, relayLines } from './listPresence.js';
import type { RevokedMachine } from './network.js';
import { runNetworkCommand } from './cliNetwork.js';
import { printUpdateNotice, runCliMeta } from './cliMeta.js';
import { daemonStateText, runStartupCommand } from './cliStartup.js';
import { readDaemonState } from './daemonPortFile.js';
import { groupHelpText, helpRequest, unknownSubcommandMessage } from './cliHelp.js';
import { runWake, runWakeInfo } from './cliWake.js';
import { runRequests } from './cliRequests.js';
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

Command groups (admin, peer, startup, cli, alias, policy):
  machine <group>                    shows the current state of the group, read-only (admin: the candidacies waiting for approval;
                                     peer: the peers; startup: the job status; cli: the versions; alias: the aliases; policy: its help)
  machine <group> --help             the help of that group (also \`machine help <group>\`); \`machine <group> <subcommand> --help\` for one

Getting started (one command per machine; the name of a machine is the computer name, lowercase):
  first machine (it also becomes the admin machine):
    machine setup <relay>            creates the admin key (you choose its passphrase), does ONE relay login (you confirm
                                     it once in the relay console), approves itself and enrolls
  every other machine:
    machine join <relay>             on the new machine: waits for the admin and finishes by itself; shows the
                                     security code to compare with the admin machine
    machine admin approve            on the admin machine: shows the new machine, asks y/N and the passphrase, prints the
                                     security code (with several pending machines it lists them: pass the id)
  allow a command on a machine (admin machine):
    machine admin allow <machine> -- <command>      (--list shows what is allowed, --remove withdraws it)
    machine allowed <machine>                       what is allowed there per the policy signed here (read-only)
    The shell is part of the exact entry: \`--shell sh\` on a Linux target even from Windows, then \`machine run <machine> --shell sh -- <command>\`
    (or once: \`machine peer connect <machine> --shell sh\`, the default shell of that machine on this one)
  then, on each machine: machine startup enable (starts the daemon now and at each login; never done by itself unless join/setup --auto-startup)
  check the connection (runs nothing on the peer, needs no allowlist entry; the revocation hello is the real catch-up, see ping below):
    machine ping                     this machine's path to the relay, one line per step ([ok] / [warn] / [fail] with cause and fix)
    machine ping <machine>           the real authenticated channel to a peer, like ping(8): handshake and hello times
  reach a machine that sleeps (same LAN only; the Wake-on-LAN packets are sent from THIS machine):
    machine peer connect <machine> --address <ip>:<port> --wake-mac <aa:bb:cc:dd:ee:ff>
                                     once: pins the address and the MAC you type (never learned from the relay); then
                                     \`machine run\` and \`machine ping\` wake the machine when it cannot be reached
    machine wake <machine>           wake it now and wait for it to answer: prints each step and the measured time
    machine wake-info <machine>      checklist to prepare THE TARGET (BIOS/driver, per-system settings, daemon at login, its MAC)
    A refused connection (the machine answers, no daemon listens) is never woken: start the daemon there.
    The target must SLEEP (suspend), not be shut down: its daemon starts at login, so a machine woken from power-off
    without auto-login does not listen. Wake-on-LAN gives no acknowledgement: BIOS/driver settings are on the target
  Stays manual: the passphrase, the one confirmation in the relay console (relay login code) and the security-code comparison (the human steps).
  Three kinds of code, never mixed: the relay login codes (XXXX-XXXX, shown here, confirmed in the relay console), the pairing code (8
  digits, shown by the relay console: scripts) and the security code (25 digits in five groups, compared between two machines: the one that protects you).

Commands:
  setup <relay> [--generate] [--hint <text>] [--name <name>] [--auto-startup] [--policy admin|local]
                                     the first machine in one command: identity (name from the computer name), admin key
                                     (passphrase typed twice, or --generate for a random one), ONE relay login (a request you
                                     confirm in the relay console: MACHINE ADMIN, it can approve machines and cannot manage tokens;
                                     the token is both the relay token of this machine and its admin token), self-approval
                                     (the passphrase just chosen signs it) and enrollment. Run it again after an interruption:
                                     what exists is kept. Other machines never create an admin key: they use join
  init [--name <name>]               create this machine's UUID and identity key only (optional: setup and join do it). The
                                     name is --name or the computer name, normalised to lowercase letters, digits and hyphens
                                     (a note says what was changed); it is the stable reference signed at enrollment, a
                                     friendlier local label is \`machine alias set <label> <name>\`
  status                            identity, whether the daemon runs, enrollment state, policy, revocation version and peers last seen
                                     behind on it, the machines revoked here (name, uuid, when), what was left out
  list                               this machine and its registered peers (and the revocation version each peer
                                     announced at its last handshake); with a relay also their last known
                                     addresses and whether the relay says they are online (a relay problem is a
                                     warning line, never an error)
  resolve <reference>                show which machine a reference means
  allowed <machine>                  what the machine allows: for a peer the last policy signed on THIS machine (entries per shell,
                                     version, when it was signed here) and a line saying the installed list is asked there with
                                     \`machine policy allow --list\`; for this machine the installed policy and its mode. Read-only, no passphrase
  alias list | set <alias> <ref> | rm <alias>
  run <machine> [--address <host:port>] [--wake | --no-wake] [--shell cmd|ps|bash|sh] -- <command...>
                                     run one allowed command on a peer. Without --address the addresses come from
                                     the relay (the signed address record of the peer, verified against its
                                     registration), tried in order with 3 s each; --address overrides it and is the
                                     only way without a relay. Before the command, the two machines compare their
                                     admin revocation lists and hand each other what the other lacks (a revocation the
                                     relay never delivered still arrives); a peer that turns out revoked is refused.
                                     Addresses pinned with \`peer connect\` win over the relay record. A peer configured
                                     for Wake-on-LAN (or --wake) that cannot be reached (unreachable or no answer, never an
                                     authentication failure) is woken, then retried; --no-wake forbids it
  ping [<machine>] [--count <n>] [--address <host:port>] [--wake | --no-wake] [--json]
                                     without a machine: relay.json, the relay answers (time, version), the token is accepted and its
                                     access level (machine, machine-admin, full), the local daemon runs, this machine's address record is
                                     published (age, presence); exit 0 only when no step fails. With a machine (name, alias, uuid or
                                     prefix, resolved like run): the addresses come from --address or the signed record of the relay, exactly
                                     as for run, then the mutual TLS 1.3 channel opens (key pinned, pair secret proven) and the revocation
                                     hello (the same one run sends first) is answered; no command is sent, so nothing is executed, no
                                     allowlist entry is needed and the peer audits nothing when the hello is answered. The hello is the real
                                     revocation catch-up: admin-signed revocation lists may be installed here, the peer's version is recorded
                                     here and yours there, and it uses one of the peer's 6 revocation exchanges per minute (shared with run).
                                     Reports each address tried, the handshake time,
                                     the hello round trip, the registration (serial, admin key id) and whether the revocation lists matched
                                     (a refused hello is "not compared", not a difference).
                                     --count <n> (1 to 10, default 1) opens n connections one second apart and prints min/avg/max (the
                                     hello is sent in the first 4 only: a peer allows 6 revocation exchanges per minute). Exit 0 ok, 1
                                     failure, 2 usage, 3 unknown or ambiguous machine. --wake / --no-wake as for run (one wake per ping)
  daemon [--api-port <n>] [--peer-port <n>] [--peer-host <host>] [--advertise <host[:port]>]...
                                     run the daemon in the foreground (started by orch). With a relay (after join)
                                     it publishes its signed address record: the non-loopback interface addresses
                                     with the peer port, or ONLY the --advertise ones when given (repeatable, up
                                     to 8: a NAT, a hostname, a VPN, an SSH tunnel; without a port the peer port is
                                     used). With nothing to publish it says why and publishes nothing
  stop                               stop the running daemon
  join [<relay-host-or-url> | <code>] [--relay <url>] [--force] [--no-wait] [--timeout <seconds>] [--yes-final-code <code>] [--prompt-timeout <s>] [--auto-startup] [--name <name>] [--policy admin|local]
                                     one command: the identity is created when there is none (--name, else the computer name). Step "Allow list": who
                                     manages what peers may run here, the admin (default) or this machine; --policy answers it (required without a terminal, else the default is admin and said). On the
                                     machine that holds the admin key it approves its own enrollment (one passphrase, nothing to compare;
                                     needs the admin relay token: \`machine admin login\`, or use \`machine setup\`). On any other machine it
                                     prints what the admin runs (\`machine admin approve\`), waits, then shows the security code, which must read exactly the same on the admin machine
                                     --timeout (default 900 s) is the wait for the admin; it never outlasts the candidacy (15 min)
                                     or the device code. An approval received but not confirmed is kept 15 minutes only:
                                     later it is discarded and nothing is pinned (ask the admin again: join --resume).
                                     get a relay token, post this machine's candidacy (with its uuid), wait for the
                                     admin's approval, then show the security code and enroll. Without a code: device
                                     login. It prints a code and a page; open the page (any browser), compare the
                                     code with the one the console shows, check that the source address and the label
                                     match this machine, then approve (click the code when the console lists several).
                                     Nothing is typed here, no terminal is needed (SSH works). Ctrl-C or a lost session during
                                     the device login stores nothing: run \`machine join <relay>\` again for a new code
                                     (the device code is never printed nor saved).
                                     The argument: only digits (spaces and hyphens allowed, 1234 5678) = pairing
                                     code of the admin (fallback, claimed instead of a device login); anything
                                     else = the relay, a URL or a bare host (relay.example.com means
                                     https://relay.example.com). There is no default relay: name it the first time (a pairing
                                     code needs --relay too); later runs reuse the one stored in relay.json.
                                     --relay <url> is the same as the relay argument (not both)
                                     join never starts anything at login by itself; it ends by suggesting
                                     \`machine startup enable\`. --auto-startup runs it as the last step: it also starts the daemon
                                     now (--no-start: register only); a failure there is reported and makes join exit 1; the join
                                     itself is not undone
  startup [status | enable | disable]  start the daemon at login through an orch startup job named "machine"
                                     (needs orch: npm i -g @wadeck-app/orchestrator-cli). enable creates or refreshes
                                     the job (run it again after moving machine) and starts the daemon now when it is not
                                     running (--no-start: register only); disable removes it; status shows
                                     whether the daemon runs, whether the job exists, its command, the form registered (staged launcher, staged launcher through a wscript wrapper on Windows, or development node + bundle) and whether it is up to date (exit 0 either way).
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
  cli register [--force-register]    offer the admin page module to app-core now (the daemon does it at each start). Skipped, exit 0
                                     with one line on stderr, when the config dir is under the OS temporary folder (a probe or a test)
                                     unless APP_CORE_CONFIG_DIR names an isolated app-core folder; --force-register overrides

Administration (enrollment through the relay, or by files):
  admin login [<code>] [--relay <url>] [--force] [--full-access]
                                     without a code: shows a code to confirm in the relay console (Tokens page; MACHINE ADMIN:
                                     can approve machines, cannot manage tokens) and keeps the token in _secrets_/relay-admin.json;
                                     a relay that predates the machine-admin scope fails loudly (update it), nothing falls back to
                                     full access by itself. --full-access: the explicit opt-in to a FULL-ACCESS token (it can also
                                     manage tokens; a [warn] says so). With a code: claims a pairing code of the relay console
                                     (scripts; Tokens, Add token, Limited to scopes: machine-admin). A plain machine token is refused,
                                     and so is a FULL-ACCESS pairing unless --full-access is given with the code
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
  peer connect <machine> [--type direct|ping-if-not-reachable-magic-packet] [--address <host:port>]...
                [--wake-mac <aa:bb:cc:dd:ee:ff>] [--wake-broadcast <ipv4>] [--wake-probe <s>] [--wake-wait <s>]
                [--wake-max-unicast <n>] [--wake-max-broadcast <n>] [--wake-connect-timeout <ms>] [--wake-settle <s>]
                                     how THIS machine reaches a peer (stored in connections.json, no secret). --address pins
                                     addresses (up to 8) that win over the relay record. A MAC turns on the wake: unicast to the
                                     peer address, a probe window, a directed broadcast, a probe window, alternating, never more
                                     than --wake-max-unicast and --wake-max-broadcast (default 4 each, at most 8 each), the
                                     whole wait <= --wake-wait (default 90, 10 to 600), each probe window --wake-probe (default 5,
                                     1 to 60), each probe attempt (connect and handshake) --wake-connect-timeout (default 3000 ms, 200 to 10000), --wake-settle seconds of
                                     pause after the answer (default 0). Only toward the subnet this machine shares with the peer.
                                     A flag changes that value and keeps the others. UNVERIFIED on real hardware: tune per peer
  peer connect <machine> --shell cmd|ps|bash|sh | --no-shell
                                     the default shell of \`machine run <machine>\` on this machine (strict, shown by --show, removed by
                                     --no-shell or --remove). \`run\` uses --shell, else this default (said on stderr), else the platform
                                     of this machine (cmd on Windows, sh elsewhere)
  peer connect <machine> --show      the effective values, (default) marks what nobody set
  peer connect <machine> --remove    forget the settings of that peer
  wake <machine> [--address <host:port>] [--json]
                                     send the wake now (the same steps), wait for the peer to answer, print the measured time
                                     and a hint when the answer came late in a probe window. Exit 0 answers, 1 not. The 60 s cooldown
                                     between wakes applies to \`run --wake\` and \`ping --wake\`; this explicit command ignores it (the
                                     packet limits still apply)
  wake-info <machine>                checklist to prepare THE TARGET for Wake-on-LAN: what this machine knows (pinned address, MAC),
                                     the BIOS/UEFI and per-system settings (Linux ethtool and NetworkManager; macOS and Windows
                                     lines are marked UNVERIFIED), the machine-side requirements (suspend not shut down, daemon
                                     at login, same LAN), how to find the MAC, and the \`machine peer connect\` command to run here.
                                     Plain text, reads local files only, sends nothing. Exit 0, 3 unknown machine
  requests [--limit <n>] [--json]    the commands peers asked THIS machine to run that were refused because they are not allowed, grouped
                                     by machine, shell and command (count, first and last time), newest first, with the exact command that
                                     allows each (\`machine admin allow <this machine> ...\`, or \`machine policy allow ...\` in mode local).
                                     Read-only: reads this machine's audit.log (hash chain verified, a broken chain is a warning with its
                                     line), no daemon needed. A command the policy allows now is not listed. At most 100 groups (--limit)
  requests --history [--peer <machine>] [--since <30m|2h|3d|date>] [--event run|refused|session|document] [--limit <n>] [--json]
                                     what happened here: runs (exit code, duration), refusals with their reason, session and document
                                     events; chronological, the last 50 by default (--limit up to 1000); --since 2026-11-20 or 3h
  requests <machine> [--limit <n>]   ADMIN machine only: ask that peer for its pending list over the authenticated channel (one read-only
                                     frame signed with the admin key: the passphrase is asked, nothing is run or changed on the peer; the
                                     peer audits it and allows 6 per minute). A peer that is too old says so: \`machine cli update\` there
  requests --all [--limit <n>]       the same for every trusted peer, one passphrase; a peer that cannot be reached is reported, the others
                                     are still shown (exit 1). Pending list only: the history of a machine is read on that machine
  peer forget-record <peer>          forget the highest address record seq seen for ONE peer (y/N). Only after confirming
                                     out of band that the peer was reinstalled: it lifts the rollback check for that peer once
  policy install <signed.json>       install a policy for this machine: signed by the admin (mode admin, the default) or by the local policy key (mode local)
  policy local [enable [--hint <text>]]
                                     who manages the allow list of THIS machine. Bare: shows the mode. enable: this machine manages
                                     its own list with its own policy key and a LOCAL passphrase (typed twice, asked every time you
                                     change the list, nothing is cached); admin-signed policies are then refused and the list starts
                                     EMPTY. It never enrols a machine and never lifts a revocation: those stay with the admin
  policy allow [--shell <s>] [--peer <machine>] -- <command>
                                     mode local: allow ONE exact command on THIS machine (difference, y/N, local passphrase, signed with
                                     the local key, installed here, no relay); --remove withdraws it; --peer edits the own list of one
                                     registered peer; --list shows what is allowed (read-only, no passphrase, any mode)
  policy delegate                    mode local: give the list back to the admin (asks the local passphrase). The list becomes EMPTY
                                     until the admin signs one; the local key is archived next to its place

Options:
  --json                 machine-readable output
  --count <n>            rounds of machine ping <machine> (1 to 10, one second apart; min/avg/max)
  --relay <url>          relay for \`join\` and \`admin login\` (no default: required the first time, then the stored one is reused; https only, http on 127.0.0.1 for tests)
  --verbose              also show the candidacy code (join, setup, admin approve): internal by default, the admin machine recomputes
                         and checks it itself; the security code is the one to compare
  --prompt-timeout <s>   limit for every question to a person (y/N, passphrase, security code): 1 to 3600 s, default 120; on expiry the
                         question is cancelled, nothing is assumed and nothing is signed, pinned or revoked (join, admin approve|revoke|sign-policy|distribute|register|login)
  --out <file>           write a signed document or bundle to a file (--force to overwrite)
  --name <name>          machine name for init, join, setup when the identity is created (normalised: lowercase letters, digits, hyphens)
  --generate             random admin passphrase for admin init and setup (no question)
  --hint <text>          hint shown at every passphrase prompt, for admin init, setup and policy local enable (optional, max 80 printable ASCII characters, stored in clear in the key file: never write the passphrase in it)
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
  const out: Parsed = { positional: [], passthrough: [], json: false, help: false, version: false, replace: false, force: false, resume: false, noWait: false, reject: false, autoStartup: false, noStart: false, fullAccess: false, verbose: false, quiet: false, generate: false, list: false, remove: false, follow: false, forceRegister: false, advertise: [], addressList: [], wake: false, noWake: false, show: false, noShell: false, optionLike: [] };
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
    else if (a === '--no-start') out.noStart = true;
    else if (a === '--full-access') out.fullAccess = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--generate') out.generate = true;
    else if (a === '--list') out.list = true;
    else if (a === '--remove') out.remove = true;
    else if (a === '--follow' || a === '-f') out.follow = true;
    else if (a === '--force-register') out.forceRegister = true;
    else if (a === '--history') out.history = true;
    else if (a === '--all') out.all = true;
    else if (a === '--since') out.since = valueOf('--since');
    else if (a === '--event') out.event = valueOf('--event');
    else if (a === '--limit') out.limit = valueOf('--limit');
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
    else if (a === '--peer') out.peer = valueOf('--peer');
    else if (a === '--out') out.out = valueOf('--out');
    else if (a === '--policy') out.policy = valueOf('--policy');
    else if (a === '--address') {
      const v = valueOf('--address');
      out.addressList.push(v);
      out.address ??= v;
    } else if (a === '--wake') out.wake = true;
    else if (a === '--no-wake') out.noWake = true;
    else if (a === '--show') out.show = true;
    else if (a === '--no-shell') out.noShell = true;
    else if (a === '--type') out.type = valueOf('--type');
    else if (a === '--wake-mac') out.wakeMac = valueOf('--wake-mac');
    else if (a === '--wake-broadcast') out.wakeBroadcast = valueOf('--wake-broadcast');
    else if (a === '--wake-probe') out.wakeProbe = valueOf('--wake-probe');
    else if (a === '--wake-wait') out.wakeWait = valueOf('--wake-wait');
    else if (a === '--wake-max-unicast') out.wakeMaxUnicast = valueOf('--wake-max-unicast');
    else if (a === '--wake-max-broadcast') out.wakeMaxBroadcast = valueOf('--wake-max-broadcast');
    else if (a === '--wake-connect-timeout') out.wakeConnectTimeout = valueOf('--wake-connect-timeout');
    else if (a === '--wake-settle') out.wakeSettle = valueOf('--wake-settle');
    else if (a === '--count') out.count = valueOf('--count');
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
    log = parsed.help || parsed.version || helpRequest(parsed.positional, parsed.help) !== undefined ? undefined : openCliLog(resolveConfigDir(parsed.configDir, env), argv, io.stderr);
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
  // `--help`, `help`, `<group> help`, `help <group>`, `<group> <sub> --help`: no configuration directory, nothing logged.
  const help = helpRequest(args.positional, args.help);
  if (help !== undefined) {
    if (help.kind === 'error') {
      io.stderr(`[fail] ${help.message}\n`);
      return EXIT.usage;
    }
    io.stdout(help.kind === 'text' ? help.text : HELP);
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
  const maxPositional: Record<string, number> = { init: 0, status: 0, list: 0, daemon: 0, stop: 0, resolve: 1, join: 1, setup: 1, ping: 1, wake: 1, 'wake-info': 1, allowed: 1, requests: 1 };
  const allowed = maxPositional[command];
  if (allowed !== undefined && rest.length > allowed) {
    return fail(`unexpected argument "${rest[allowed]}" for \`machine ${command}\`: see \`machine --help\``, EXIT.usage);
  }
  const policyAllow = command === 'policy' && rest[0] === 'allow';
  if (args.passthrough.length > 0 && command !== 'run' && !(command === 'admin' && rest[0] === 'allow') && !policyAllow) {
    return fail('"--" is only used by `machine run`, `machine admin allow` and `machine policy allow` (it introduces the command line)', EXIT.usage);
  }
  const peerConnect = command === 'peer' && rest[0] === 'connect';
  if ((args.list || args.remove) && !(command === 'admin' && rest[0] === 'allow') && !policyAllow && !(peerConnect && args.remove && !args.list)) {
    return fail('--list and --remove only apply to `machine admin allow` and `machine policy allow` (`machine admin allow <machine> --list`, `machine policy allow --remove -- <command>`); --remove also applies to `machine peer connect <machine> --remove`', EXIT.usage);
  }
  if (args.peer !== undefined && !policyAllow && command !== 'requests') {
    return fail('--peer only applies to `machine policy allow` (`machine policy allow --peer <machine> -- <command>` edits the own list of a peer) and to `machine requests --history`', EXIT.usage);
  }
  const requestsOptions: Array<[string, unknown]> = [['--history', args.history], ['--all', args.all], ['--since', args.since], ['--event', args.event], ['--limit', args.limit]];
  const requestsOption = requestsOptions.find(([, v]) => v !== undefined);
  if (requestsOption !== undefined && command !== 'requests') {
    return fail(`${requestsOption[0] as string} only applies to \`machine requests\` (the requests refused by this machine: pending list, or --history)`, EXIT.usage);
  }
  if (args.wake && args.noWake) return fail('--wake and --no-wake cannot be combined: --wake forces the wake of a peer that cannot be reached, --no-wake forbids it', EXIT.usage);
  if ((args.wake || args.noWake) && command !== 'run' && command !== 'ping') {
    return fail(`${args.wake ? '--wake' : '--no-wake'} only applies to \`machine run\` and \`machine ping\` (it wakes the peer when it cannot be reached; \`machine wake <machine>\` wakes it now)`, EXIT.usage);
  }
  if (!peerConnect) {
    const settings: Array<[string, unknown]> = [['--show', args.show || undefined], ['--no-shell', args.noShell || undefined], ['--type', args.type], ['--wake-mac', args.wakeMac], ['--wake-broadcast', args.wakeBroadcast], ['--wake-probe', args.wakeProbe], ['--wake-wait', args.wakeWait], ['--wake-max-unicast', args.wakeMaxUnicast], ['--wake-max-broadcast', args.wakeMaxBroadcast], ['--wake-connect-timeout', args.wakeConnectTimeout], ['--wake-settle', args.wakeSettle]];
    const used = settings.find(([, v]) => v !== undefined);
    if (used) return fail(`${used[0]} only applies to \`machine peer connect\` (\`machine peer connect <machine> ...\` sets how this machine reaches a peer: pinned addresses, Wake-on-LAN)`, EXIT.usage);
    if (args.addressList.length > 1) return fail('--address can be given only once here (the several-address form is `machine peer connect <machine> --address <host:port> --address <host:port>`)', EXIT.usage);
  }
  if (args.generate && !(command === 'setup' || (command === 'admin' && rest[0] === 'init'))) {
    return fail('--generate only applies to `machine admin init` and `machine setup` (a random admin passphrase instead of a chosen one)', EXIT.usage);
  }

  if (args.hint !== undefined) {
    if (!(command === 'setup' || (command === 'admin' && rest[0] === 'init') || (command === 'policy' && rest[0] === 'local' && rest[1] === 'enable'))) return fail('--hint only applies to `machine admin init`, `machine setup` and `machine policy local enable` (a hint shown at every passphrase prompt)', EXIT.usage);
    // The rules that do not depend on the passphrase fail now, before anything is asked.
    const problem = checkHint(args.hint);
    if (!problem.ok) return fail(`--hint: ${problem.message}`, EXIT.usage);
  }
  // --policy is a signed file for `admin distribute --policy <file>` and admin|local for join and setup (decision 70): nowhere else.
  if (args.policy !== undefined && !(command === 'join' || command === 'setup' || (command === 'admin' && rest[0] === 'distribute'))) {
    return fail('--policy only applies to `machine join` and `machine setup` (--policy admin|local: who manages the allow list of this machine) and to `machine admin distribute --policy <signed.json>`', EXIT.usage);
  }
  if (args.policy !== undefined && (command === 'join' || command === 'setup') && args.policy !== 'admin' && args.policy !== 'local') {
    return fail(`--policy must be "admin" (the admin signs the allow list, the default) or "local" (this machine manages its own), got "${args.policy}"`, EXIT.usage);
  }
  if (args.count !== undefined && command !== 'ping') return fail('--count only applies to `machine ping <machine>` (the number of rounds, 1 to 10)', EXIT.usage);
  if (args.advertise.length > 0 && command !== 'daemon') return fail('--advertise only applies to `machine daemon` (it chooses the addresses the daemon publishes in its address record)', EXIT.usage);
  if (args.verbose && !(command === 'join' || command === 'setup' || (command === 'admin' && (rest[0] === 'approve' || rest.length === 0)))) {
    return fail('--verbose only applies to `machine join`, `machine setup`, `machine admin` and `machine admin approve` (it also shows the candidacy code, which is internal by default)', EXIT.usage);
  }
  if (args.quiet && command !== 'cli') return fail('--quiet only applies to `machine cli self-check`', EXIT.usage);
  if (args.forceRegister && command !== 'cli') return fail('--force-register only applies to `machine cli register`', EXIT.usage);
  if (args.follow && command !== 'cli') return fail('--follow only applies to `machine cli logs`', EXIT.usage);
  if (args.fullAccess && !(command === 'admin' && rest[0] === 'login')) {
    return fail('--full-access only applies to `machine admin login` (a FULL-ACCESS token, which can also manage tokens; without it the admin token is limited to machine rights)', EXIT.usage);
  }
  if (args.noStart) {
    const forEnable = command === 'startup' && rest[0] === 'enable';
    if (!forEnable && command !== 'join' && command !== 'setup') {
      return fail('--no-start only applies to `machine startup enable`, `machine join` and `machine setup` (with --auto-startup): it registers the startup job without starting the daemon now', EXIT.usage);
    }
    if (!forEnable && !args.autoStartup) return fail('--no-start on `machine join` and `machine setup` only has a meaning with --auto-startup (without it no startup job is created and no daemon is started)', EXIT.usage);
  }
  if (args.autoStartup && command !== 'join' && command !== 'setup') return fail('--auto-startup only applies to `machine join` and `machine setup` (to start machine at login by itself, run `machine startup enable`)', EXIT.usage);

  if (args.promptTimeout !== undefined) {
    const seconds = Number(args.promptTimeout);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_PROMPT_TIMEOUT_SECONDS) {
      return fail(`--prompt-timeout must be a whole number of seconds from 1 to ${MAX_PROMPT_TIMEOUT_SECONDS}, got "${args.promptTimeout}"`, EXIT.usage);
    }
    // Refused rather than silently ignored: a command that never prompts has nothing to limit.
    const prompts = command === 'join' || command === 'setup' || (command === 'requests' && (rest.length > 0 || args.all === true)) || (command === 'admin' && ['init', 'allow', 'approve', 'revoke', 'sign-policy', 'distribute', 'register', 'login', 'forget-relay-record'].includes(rest[0] ?? '') || (command === 'peer' && rest[0] === 'forget-record') || (command === 'policy' && (rest[0] === 'allow' || rest[0] === 'delegate' || (rest[0] === 'local' && rest[1] === 'enable'))));
    if (!prompts) return fail('--prompt-timeout only applies to the commands that ask a question: join, setup, admin init, admin approve, admin allow, admin revoke, admin sign-policy, admin distribute, admin register, admin login, admin forget-relay-record, policy allow, policy delegate, policy local enable, requests <machine>', EXIT.usage);
  }

  // `machine policy` alone: no read-only view of the policy exists, so the help of the group (decision 66). Needs no configuration directory.
  if (command === 'policy' && rest.length === 0) {
    io.stdout(groupHelpText('policy'));
    return EXIT.ok;
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
    if (command === 'wake') return await runWake(ctx);
    if (command === 'wake-info') return runWakeInfo(ctx);
    // `machine requests` reads this machine's audit log; `requests <machine>` and `--all` ask the peers (admin machine, handled with the network commands).
    if (command === 'requests' && rest.length === 0 && args.all !== true) return await runRequests(ctx);

    // Bare groups (decision 66): `machine peer` shows what `machine list` shows, `machine alias` what `machine alias list` shows.
    const bareView = command === 'peer' && rest.length === 0;
    const effective = bareView ? 'list' : command;
    if (!bareView) {
      const handled = await runNetworkCommand(command, ctx);
      if (handled !== undefined) return handled;
    }

    // Everything else goes through the daemon when it runs and through the same code in-process when it does not.
    const client = createDaemonClient({ configDir, commands: makeCommands(configDir, appVersion) });
    const notInitialized = (r: { initialized?: boolean; message?: string }): r is NotInitialized => r.initialized === false;

    switch (effective) {
      case 'stop': {
        if (!(await client.isRunning())) {
          emit({ stopped: false }, '[ok] daemon was not running\n');
          return EXIT.ok;
        }
        await (client as unknown as { send(command: string): Promise<unknown> }).send('quit');
        for (let i = 0; i < 50 && (await client.isRunning()); i++) await new Promise((r) => setTimeout(r, 100));
        if (await client.isRunning()) return fail('the daemon did not stop within 5 seconds: end it with `orch kill machine` if orch runs it (`orch stop` would stop the orch daemon, not this job)');
        emit({ stopped: true }, '[ok] daemon stopped\n');
        return EXIT.ok;
      }
      case 'status': {
        const r = (await client.send('status')) as StatusAnswer | NotInitialized;
        if (notInitialized(r)) return fail(r.message);
        // Read only and local (daemon.port.json and a live pid): `status` never starts the daemon and asks no network.
        const daemon = readDaemonState(configDir, io.startup?.isAlive);
        const lines = [
          `${r.name} (${r.uuid})`,
          `version: ${r.version}`,
          `config: ${r.configDir}`,
          ...daemonStateText(daemon, 'start it with machine startup enable (at login) or machine daemon').trimEnd().split('\n'),
          r.enrolled ? `enrolled, ${r.peers} peer(s), ${r.policyVersion === undefined ? 'no policy (every command is refused)' : `policy version ${r.policyVersion}`}` : (r.note ?? 'not enrolled'),
          r.policyMode === 'local'
            ? `policy mode: local (this machine manages its own allow list, policy key ${r.localPolicyKeyId ?? 'unknown: policy-mode.json is damaged'})`
            : 'policy mode: admin (allow list signed by the admin)',
          ...(r.revocationVersion === undefined ? [] : [`revocations: version ${r.revocationVersion}`]),
          ...revokedBlock(r.revoked ?? [], Math.floor((io.now?.() ?? new Date()).getTime() / 1000)),
          ...(r.peersBehind ?? []).map((p) => `[warn] ${p.name} announced revocation version ${p.revocationVersionSeen} at its last handshake (this machine holds ${r.revocationVersion}) and its revocations differ from this machine's: it may still trust a revoked machine until it meets a peer that has the lists; run "machine admin distribute <revoked machine>" or make it connect to one`),
          ...(r.problems ?? []).map((p) => `[warn] ${p}`),
        ];
        emit({ ...r, daemon }, `${lines.join('\n')}\n`);
        return EXIT.ok;
      }
      case 'list': {
        const r = (await client.send('list')) as ListAnswer | NotInitialized;
        if (notInitialized(r)) return fail(r.message);
        // With a relay: the addresses and the presence the relay knows. A relay problem is a warning line here, never an error of `list`.
        const nowSeconds = Math.floor((io.now?.() ?? new Date()).getTime() / 1000);
        const view = await addRelayView(configDir, r, nowSeconds, undefined, { allowLocal: io.allowLoopbackPeers === true });
        const lines = [`${r.self.name} (${r.self.uuid}) [this machine]${r.self.aliases.length ? ` aliases: ${r.self.aliases.join(', ')}` : ''} policy: ${r.policyMode}`,...view.peers.flatMap((p) => [`${p.name} (${p.uuid})${p.aliases.length ? ` aliases: ${p.aliases.join(', ')}` : ''} policy: unknown`, ...(p.revocationVersionSeen === undefined ? [] : [`  revocations: version ${p.revocationVersionSeen} at the last handshake`]), ...relayLines(p.relay, nowSeconds)])];
        if (r.revocationWarning !== undefined) io.stderr(`[warn] ${r.revocationWarning}
`);
        if (view.relayWarning !== undefined) io.stderr(`[warn] ${view.relayWarning}\n`);
        emit(view, `${lines.join('\n')}\n${r.note ? `${r.note}\n` : ''}${bareView ? 'more: machine peer --help (info, import, connect, wake, forget-record)\n' : ''}`);
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
        // `machine alias` alone (decision 66) is `machine alias list`, with the way to the other subcommands.
        const bareAlias = rest.length === 0;
        const [sub = 'list', a, b] = rest;
        const arity: Record<string, number> = { list: 0, set: 2, rm: 1 };
        const expected = sub === undefined ? undefined : arity[sub];
        if (expected !== undefined && rest.length - 1 > expected) return fail(`unexpected argument "${rest[expected + 1]}" for \`machine alias ${sub}\``, EXIT.usage);
        if (sub === 'list') {
          const aliases = (await client.send('aliasList')) as Record<string, string>;
          emit(aliases, `${Object.keys(aliases).length ? `${Object.entries(aliases).map(([k, v]) => `${k} -> ${v}`).join('\n')}\n` : 'no alias\n'}${bareAlias ? 'more: machine alias --help (set, rm)\n' : ''}`);
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
        return fail(unknownSubcommandMessage('alias', sub), EXIT.usage);
      }
      default:
        return fail(`unknown command "${command}": see \`machine --help\``, EXIT.usage);
    }
  } catch (e) {
    return fail((e as Error).message, e instanceof UsageError || e instanceof MachineNameError ? EXIT.usage : EXIT.failure);
  }
}
