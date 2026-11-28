// Contextual help of the command groups (admin, peer, startup, cli, alias, policy): `machine <group> --help`, `machine <group> help`,
// `machine help <group>` and `machine <group> <sub> --help`. Pure text: no configuration directory, no daemon, no relay (decision 66).

interface SubHelp {
  name: string;
  /** What follows `machine <group> `. */
  usage: string;
  /** One line: what it does. */
  text: string;
  /** The arguments and options that apply, one line each. */
  options?: string[];
  examples: string[];
}

interface GroupHelp {
  name: string;
  summary: string;
  /** What `machine <group>` alone does. */
  bare: string;
  subs: SubHelp[];
  /** 2 or 3 examples of the group, shown by the group help. */
  examples: string[];
}

const GLOBAL = ['--config-dir <path>   configuration directory (default: MACHINE_CONFIG_DIR or ~/.config/machine)', '--json               machine-readable output, one JSON document (where the command supports it)'];

const GROUPS: GroupHelp[] = [
  {
    name: 'admin',
    summary: 'administration of the network, on the machine that holds the admin key',
    bare: 'lists the candidacies waiting for approval (read-only: nothing is asked, nothing is approved)',
    subs: [
      {
        name: 'init',
        usage: 'init [--generate] [--hint <text>]',
        text: 'create the admin key on this machine (you choose its passphrase)',
        options: ['--generate   a random passphrase (100 bits, shown once) instead of a chosen one', '--hint <text>   hint shown above every passphrase prompt (max 80 printable ASCII characters, stored in clear)'],
        examples: ['machine admin init', 'machine admin init --generate'],
      },
      {
        name: 'login',
        usage: 'login [<code>] [--relay <url>] [--force] [--full-access]',
        text: 'get the admin token of the relay (confirmed once in the relay console)',
        options: ['<code>   a pairing code of the relay console (scripts); without it a code is shown to confirm in the console', '--relay <url>   the relay (named once, then the stored one is reused)', '--force   replace the saved admin token', '--full-access   explicit opt-in to a FULL-ACCESS token (it can also manage tokens)'],
        examples: ['machine admin login --relay relay.example.com', 'machine admin login 12345678 --relay relay.example.com'],
      },
      {
        name: 'approve',
        usage: 'approve [<id>] [--relay <url>] [--days <n>] [--reject] [--verbose]',
        text: 'list the pending candidacies, or approve one (details, y/N, passphrase, security code)',
        options: ['<id>   the candidacy (a unique prefix is enough); with exactly one pending it is optional', '--days <n>   validity of the registration, 1 to 3650 (default 365)', '--reject   refuse the candidacy (needs the id, no passphrase)', '--verbose   also show the candidacy code'],
        examples: ['machine admin approve', 'machine admin approve k3Fz', 'machine admin approve k3Fz --reject'],
      },
      {
        name: 'revoke',
        usage: 'revoke <machine>',
        text: 'revoke a trusted machine (y/N, passphrase), tell the other machines through the relay',
        options: ['<machine>   name, alias, uuid or unique uuid prefix'],
        examples: ['machine admin revoke laptop'],
      },
      {
        name: 'rename',
        usage: 'rename <machine> <new-name>',
        text: 'rename a trusted machine without enrolling it again: re-issues its signed registration (same uuid and key, new name, serial + 1, same expiry), tells every machine',
        options: [
          '<machine>   name, alias, uuid or unique uuid prefix (not the admin machine itself: not supported yet)',
          '<new-name>   lowercase letters, digits and hyphens, at most 32 (a typed name is normalised, and said); refused when another machine has it, when it only differs from one by hyphens, or when it is a local alias of another machine',
          'asks y/N, then the admin passphrase (typed once, never kept); needs the admin relay token to tell the others',
          'when the machine already has that name, the documents of the last rename are sent again (the retry of a failed sending, nothing is signed again)',
          'policies, aliases and connection settings follow the machine through its uuid; references by the OLD name stop working',
        ],
        examples: ['machine admin rename macbook-pro-de-wadeck mac-m2', 'machine admin rename mac-m2 mac-m2'],
      },
      {
        name: 'allow',
        usage: 'allow <machine> [--shell cmd|ps|bash|sh] [--times <n> | --for <duration> | --until <date>] [--renew] [--out <file>] [--list | --remove [--index <n>]] -- <command...>',
        text: 'allow ONE command on a machine (signed policy): exact, or a typed template with <label:type> placeholders; list or withdraw what is allowed',
        options: [
          '--shell   the shell of the command, part of the entry (default: this machine platform, said; a Linux target needs --shell sh from Windows)',
          'template   fixed words and placeholders: <n:int(1,500)>, <j:name>, <t:duration(1,3600)>, <p:port>, <i:hexid(8)>, <u:uuid>, <s:enum(a|b)>; a flag value is --lines=<n:int(1,500)>; a value never starts with "-"',
          '--times <n>   at most n calls (1 to 10000); the counter is per entry, not per value',
          '--for <duration>   valid for 30m, 2h, 7d ... from now (at most 365d)',
          '--until <date>   valid until 2027-02-01 (end of that day, UTC) or 2027-02-01T18:00Z (at most 365 days away); permanent without --times, --for and --until',
          '--renew   replace an entry that is used up or expired even with the SAME limits, and start its counter again (the held request waiting for it then runs); other limits replace the old ones without it',
          '--out <file>   write the signed policy to a file instead of sending it',
          '--list   show what is allowed on the machine, numbered (no command)',
          '--remove   withdraw the command (by its text, --shell narrows it) or --index <n>, the number shown by --list or `machine allowed`',
        ],
        examples: [
          'machine admin allow laptop -- "ipconfig /all"',
          'machine admin allow laptop --shell sh --times 20 -- "orch logs <job:name> --tail <n:int(1,500)>"',
          'machine admin allow laptop --for 2h -- "journalctl -u <u:enum(ssh.service|machine.service)> --lines=<n:int(1,500)> --no-pager"',
          'machine admin allow laptop --list',
          'machine admin allow laptop --remove --index 2',
        ],
      },
      {
        name: 'distribute',
        usage: 'distribute <machine|uuid> | distribute --policy <signed.json>',
        text: 'send again what an approval, a revocation or a signed policy sends (safe to repeat)',
        options: ['<machine|uuid>   a trusted machine, or the uuid of a machine revoked here', '--policy <file>   a policy signed earlier (admin sign-policy --out)'],
        examples: ['machine admin distribute laptop', 'machine admin distribute --policy policy-laptop.json'],
      },
      {
        name: 'forget-relay-record',
        usage: 'forget-relay-record <machine|uuid>',
        text: 'remove a machine record, token binding and inbox from the relay (makes room under the limit)',
        options: ['<machine|uuid>   the machine to forget (y/N, needs the admin relay token, no passphrase)'],
        examples: ['machine admin forget-relay-record old-laptop'],
      },
      {
        name: 'pin',
        usage: 'pin <admin.json>',
        text: 'trust the admin key of another machine (file mode, no relay)',
        options: ['<admin.json>   the public admin key file'],
        examples: ['machine admin pin admin.json'],
      },
      {
        name: 'register',
        usage: 'register <info.json> --out <bundle.json> [--days <n>] [--secret-from <bundle.json>]',
        text: 'sign the registration of a machine (file mode, no relay); the bundle holds a secret',
        options: ['<info.json>   written by `machine peer info` on the other machine', '--out <file>   the bundle to write (required, never printed)', '--days <n>   validity, 1 to 3650 (default 365)', '--secret-from <bundle.json>   reuse the pair secret of another bundle'],
        examples: ['machine admin register laptop-info.json --out laptop-bundle.json'],
      },
      {
        name: 'sign-policy',
        usage: 'sign-policy <draft.json> [--out <file>]',
        text: 'sign a policy draft after showing it; sent to its target machine when an admin token exists',
        options: ['<draft.json>   the policy draft', '--out <file>   write the signed policy to a file (default: stdout)'],
        examples: ['machine admin sign-policy draft.json --out signed.json'],
      },
    ],
    examples: ['machine admin', 'machine admin approve', 'machine admin allow laptop -- "ipconfig /all"'],
  },
  {
    name: 'peer',
    summary: 'the other machines: trust them, tell how to reach and wake them',
    bare: 'shows the peers this machine knows, like `machine list`',
    subs: [
      {
        name: 'info',
        usage: 'info [--out <file>]',
        text: 'print this machine public identity, to give to the admin (file mode)',
        options: ['--out <file>   write it to a file (--force to overwrite)'],
        examples: ['machine peer info --out my-info.json'],
      },
      {
        name: 'import',
        usage: 'import <bundle.json>',
        text: 'trust a peer from an admin-signed bundle (file mode)',
        options: ['<bundle.json>   written by `machine admin register`'],
        examples: ['machine peer import laptop-bundle.json'],
      },
      {
        name: 'connect',
        usage: 'connect <machine> [--shell cmd|ps|bash|sh | --no-shell] [--address <host:port>]... [--type direct|ping-if-not-reachable-magic-packet] [--wake-mac <mac>] [--show | --remove]',
        text: 'how THIS machine reaches a peer: pinned addresses, Wake-on-LAN (stored locally, no secret)',
        options: [
          '--shell cmd|ps|bash|sh   default shell of `machine run <machine>` here (used when run has no --shell, else the platform of this machine); --no-shell forgets it',
          '--address <host:port>   pin an address (repeatable, up to 8); wins over the relay record',
          '--wake-mac <aa:bb:cc:dd:ee:ff>   the MAC to wake (typed by you, never taken from the relay)',
          '--wake-broadcast <ipv4>, --wake-probe <s>, --wake-wait <s>, --wake-max-unicast <n>, --wake-max-broadcast <n>, --wake-connect-timeout <ms>, --wake-settle <s>, --wake-hedge <ms>   wake tuning (see `machine --help`)',
          '--show   the effective values; --remove   forget the settings of that peer',
        ],
        examples: ['machine peer connect laptop --shell sh', 'machine peer connect laptop --address 192.168.1.20:47921 --wake-mac aa:bb:cc:dd:ee:ff', 'machine peer connect laptop --show'],
      },
      {
        name: 'forget-record',
        usage: 'forget-record <peer>',
        text: 'forget the highest address record seen for ONE peer (only after it was reinstalled)',
        options: ['<peer>   name, alias, uuid or prefix (y/N)'],
        examples: ['machine peer forget-record laptop'],
      },
    ],
    examples: ['machine peer', 'machine peer connect laptop --address 192.168.1.20:47921'],
  },
  {
    name: 'startup',
    summary: 'start the daemon at login through an orch startup job named "machine"',
    bare: 'shows the status of the startup job (the same as `machine startup status`)',
    subs: [
      { name: 'status', usage: 'status', text: 'does the job exist, its command, the form registered, is it up to date, does the daemon run (exit 0 either way)', examples: ['machine startup status', 'machine startup status --json'] },
      {
        name: 'enable',
        usage: 'enable [--no-start]',
        text: 'create or refresh the job (run it again after moving machine) and start the daemon now when it is not running (a startup job alone only starts at the next login of orch; a running daemon is left alone); never runs `orch install`',
        options: ['--no-start   register the job without starting the daemon now'],
        examples: ['machine startup enable', 'machine startup enable --no-start'],
      },
      { name: 'disable', usage: 'disable', text: 'end the running daemon and remove the job', examples: ['machine startup disable'] },
    ],
    examples: ['machine startup', 'machine startup enable'],
  },
  {
    name: 'cli',
    summary: 'this installation: version, update, logs',
    bare: 'shows the installed and the latest published version (the same as `machine cli version`)',
    subs: [
      { name: 'version', usage: 'version', text: 'installed version and the latest published one', examples: ['machine cli version'] },
      { name: 'update', usage: 'update [--force]', text: 'install the latest published version now, refresh the startup job, restart the daemon', options: ['--force   passed to the updater'], examples: ['machine cli update'] },
      { name: 'rollback', usage: 'rollback', text: 'reinstall the version that preceded the last update', examples: ['machine cli rollback'] },
      { name: 'self-check', usage: 'self-check [--quiet]', text: 'check the install (version, Node, platform package, writable folders); exit 1 when a check fails', options: ['--quiet   show only the failed checks'], examples: ['machine cli self-check', 'machine cli self-check --quiet'] },
      { name: 'logs', usage: 'logs [--follow | -f]', text: 'the updater and daemon log of today', options: ['--follow, -f   keep printing new lines'], examples: ['machine cli logs', 'machine cli logs -f'] },
      { name: 'post-update', usage: 'post-update', text: 'run by the updater after an update: refresh the startup job, restart an older daemon', examples: ['machine cli post-update'] },
      { name: 'register', usage: 'register [--force-register]', text: 'offer the admin page module to app-core now (the daemon does it at each start)', options: ['--force-register   register even when the config dir is under the OS temporary folder'], examples: ['machine cli register'] },
    ],
    examples: ['machine cli', 'machine cli update', 'machine cli logs -f'],
  },
  {
    name: 'alias',
    summary: 'local labels for machines (a reference is a name, an alias, a uuid or a unique uuid prefix)',
    bare: 'lists the aliases (the same as `machine alias list`)',
    subs: [
      { name: 'list', usage: 'list', text: 'the aliases of this machine', examples: ['machine alias list', 'machine alias list --json'] },
      { name: 'set', usage: 'set <alias> <reference> [--replace]', text: 'point an alias at a machine', options: ['--replace   replace an alias that already points elsewhere'], examples: ['machine alias set home desktop'] },
      { name: 'rm', usage: 'rm <alias>', text: 'remove an alias', examples: ['machine alias rm home'] },
    ],
    examples: ['machine alias', 'machine alias set home desktop', 'machine alias rm home'],
  },
  {
    name: 'policy',
    summary: 'the policy of THIS machine (what peers may run here)',
    bare: 'prints this help (`machine policy allow --list` shows what is allowed here, `machine status` the policy version and mode)',
    subs: [
      { name: 'install', usage: 'install <signed.json>', text: 'install a policy for this machine (file mode): signed by the admin in mode admin, by the local policy key in mode local', options: ['<signed.json>   written by `machine admin sign-policy --out` or `machine admin allow --out`'], examples: ['machine policy install signed.json'] },
      {
        name: 'allow',
        usage: 'allow [--shell <s>] [--peer <machine>] [--times <n> | --for <duration> | --until <date>] [--renew] -- <command> | allow --remove (-- <command> | --index <n>) | allow --list',
        text: 'mode local: allow ONE command (exact, or a typed template with <label:type> placeholders, see `machine admin allow --help`) on THIS machine (signed with the local policy key, asks the local passphrase), withdraw it, or list what is allowed (read-only, any mode)',
        options: [
          '--shell   the shell of the command (default: this machine platform, said)',
          '--peer <machine>   edit the own list of that registered peer (it then replaces the default list for that peer; a new list copies only the PERMANENT default entries and names the ones left out)',
          '--times <n> | --for <duration> | --until <date>   limit the entry (permanent by default); allowing it again with other limits replaces them',
          '--renew   replace an entry that is used up or expired even with the SAME limits, and start its counter again',
          '--remove   withdraw the command, or --index <n> (the number shown by --list)',
          '--list   show what is allowed here, numbered, with the calls left (no passphrase)',
        ],
        examples: ['machine policy allow -- "ipconfig /all"', 'machine policy allow --peer desktop --shell ps --for 1h -- "Get-Date"', 'machine policy allow --list', 'machine policy allow --remove --index 3'],
      },
      {
        name: 'local',
        usage: 'local [enable [--hint <text>]]',
        text: 'who manages the allow list of this machine: bare shows the mode; enable makes THIS machine manage its own list with its own policy key and a local passphrase (admin-signed policies are then refused, the list starts EMPTY)',
        options: ['enable   create the local policy key (passphrase typed twice, optional hint) and switch to mode local', '--hint <text>   the passphrase hint, no question'],
        examples: ['machine policy local', 'machine policy local enable'],
      },
      { name: 'delegate', usage: 'delegate', text: 'mode local: give the allow list back to the admin (asks the local passphrase). The list becomes EMPTY until the admin signs one; the local key is archived', examples: ['machine policy delegate'] },
    ],
    examples: ['machine policy local enable', 'machine policy allow -- "ipconfig /all"', 'machine policy allow --list', 'machine policy delegate', 'machine policy install signed.json'],
  },
  {
    name: 'install',
    summary: 'set up an item on THIS machine (a local command: run it in a terminal here, never remotely)',
    bare: 'lists what can be installed, with its platforms and its STATE on this machine (not installed, installed up to date, outdated, partial, foreign, unsupported here); read-only, never asks a password',
    subs: [
      {
        name: 'status',
        usage: 'status [--json]',
        text: 'the same list as `machine install`, spelled out: every item with its state on this machine and the command that moves it forward. Read-only; it runs no command that changes anything and asks no password (it asks sudo -n, which never prompts, whether the rule is there)',
        options: ['--json   one document: platform and installables[{id, state, supportedHere, files[{path, state}], missing, nextSteps}]'],
        examples: ['machine install status', 'machine install status --json'],
      },
      {
        name: 'suspend',
        usage: 'suspend [--dry-run | --check | --refresh | --remove] [--yes] [--json]',
        text: 'Linux only: let `machine run` suspend this machine. Installs two root-owned files through sudo (your own password, typed to sudo itself): the script /usr/local/bin/machine-suspend and the sudoers rule /etc/sudoers.d/machine-suspend, which lets your user run `systemctl suspend` (this one command) without a password. Prints every file and command, then runs them (no question: the sudo password is the confirmation, Ctrl-C stops before any step)',
        options: [
          '--dry-run   print the plan (files, commands) and change nothing, not even by running sudo; needs no terminal',
          '--check   the status of this item: installed / not installed / outdated (this build ships another content) / partial (names the missing part) / foreign (a file machine did not write, never touched), without changing anything and without a password; exit 0 only when installed and up to date, 1 for every other state, 2 for a usage error',
          '--refresh   force: write the whole plan again (both files), re-validate with visudo and re-verify, even when the status says up to date; prints the plan and runs it like the install (no question), refuses a foreign file the same way. Use it to repair a rule or a script changed by hand: the status cannot read the root-only rule without your password, refresh rewrites it whatever it holds',
          '--remove   remove exactly what was installed (the rule, then the script), after showing them; a file machine did not write is never touched; afterwards the status must read not installed, else it fails with what is left (path, owner) and the sudo command to remove it',
          '--yes   kept for compatibility, no question is asked any more (sudo asks your password: a terminal is required, e.g. `ssh -t` on a remote box)',
          'Safe to run again: "already installed, up to date"; an outdated script is replaced after the plan shows the hashes. A file at those paths without the "# managed by machine install suspend" line is refused',
          'After it: allow it on the ADMIN machine with `machine admin allow <this machine> --shell sh -- /usr/local/bin/machine-suspend`, call it with `machine run <this machine> -- /usr/local/bin/machine-suspend`, wake it with `machine wake <this machine>`',
          'Consequence: once the command is allowed in the DEFAULT list, every trusted peer can suspend this machine (a per-peer list restricts that: `machine policy allow --peer <machine>` in mode local)',
        ],
        examples: ['machine install suspend --dry-run', 'machine install suspend', 'machine install suspend --check', 'machine install suspend --refresh', 'machine install suspend --remove'],
      },
      {
        name: 'idle-suspend',
        usage: 'idle-suspend [--minutes <1..1440>] [--rdp-minutes <1..1440>] [--ssh-minutes <1..1440>] [--wake-grace-minutes <1..60>] [--dry-run | --check | --refresh | --remove] [--yes] [--json]',
        text: 'Linux only: suspend THIS machine by itself when it is really idle, whatever the state of the desktop sessions (a disconnected xrdp session does not keep it awake). Installs three root-owned files through sudo (your own password, typed to sudo itself): the script /usr/local/bin/machine-idle-suspend and the systemd service and timer machine-idle-suspend (checked every 30 s, 1 min or 2 min, from the smallest of the three minutes options). Prints every file and command, then runs them (no question: the sudo password is the confirmation, Ctrl-C stops before any step)',
        options: [
          '--minutes <1..1440>   idle time before the suspend, default 30; without it an installed script keeps its minutes. The timer runs every 30 s, 1 min or 2 min (the smallest of --minutes, --rdp-minutes and --ssh-minutes decides: below 10 min every 30 s, 10 to 30 min every 1 min, above 30 min every 2 min), so a value below the cadence acts at the first check after it is reached (1 min: at most about 30 s later); very small values can suspend the box between two commands of a short pause: your own choice, it only restricts uptime (no new right for any peer)',
          '--rdp-minutes <1..1440>   input idle time from which an ESTABLISHED RDP connection no longer keeps the box awake, default 20; the box then suspends at the next check once the other checks pass (no extra timer). Without it an installed script keeps its value',
          '--ssh-minutes <1..1440>   input idle time of the TTY (last keystroke, as `w` shows it) from which an ssh session no longer keeps the box awake, default 20; the most recent tty counts, and its traffic is ignored. Anything unreadable (no sshd login process for the connection, no stat of the tty) counts as activity, said in the journal. A connection WITHOUT a tty (scp, rsync, `ssh host command`, the permanent Herdr stream) is tested by its traffic instead: it keeps the box awake while its average rate between two checks (sent + received, one check apart) is at least 2048 B/s (an idle Herdr stream is about 200 B/s), and on its first check (the suspend is delayed by one check). Known limit: a job under 2048 B/s with a low load can still be cut by the suspend (use a tty, `systemd-inhibit --what=sleep` or the keep-awake file for it). Without the flag an installed script keeps its value',
          '--wake-grace-minutes <1..60>   default 5: after every resume the box is not suspended automatically for that long (xprintidle counts the sleep, so right after a wake every reading says idle). A resume is a move of the kernel counter /sys/power/suspend_stats/success, seen at the first check after the wake (at most one cadence late; the grace counts from that check). A counter that cannot be read counts as a resume ONCE and is named on every journal line afterwards, so the grace never blocks for ever. Journal: `not idle: wake grace (N min left)`. Without the flag an installed script keeps its value',
          'Idle means ALL true for that long: no established machine peer connection; every established ssh connection (22) is tested: one with a tty counts while its last input is more recent than --ssh-minutes, one without a tty counts while its traffic is at least 2048 B/s; an established RDP connection (3389) counts only while the X input of the session (xprintidle: sudo apt install xprintidle) is more recent than that time, and always counts when xprintidle is missing or unreadable; no machine request accepted, completed or held in the audit log and no open hold; load average over 5 min under 0.30; no sleep inhibitor in block mode; no /run/machine-keep-awake and no <config dir>/keep-awake file (content "keep awake until <epoch>" limits it in time)',
          'Anything unreadable counts as NOT idle: it never suspends on an error. After a resume nothing suspends the box for --wake-grace-minutes, then the idle time restarts from zero. Every check writes ONE line to the journal (2880 lines a day at 30 s). The first check at or after the threshold only confirms ("idle ... confirming at the next check"), the next one suspends: with an RDP connection the box suspends --rdp-minutes + 1 to 2 checks after the last input (20 min, checked every 1 min: 21 to 22 min), without one about 2 x --minutes (the input must be --minutes old, then the --minutes timer); --dry-run and --check print the delay computed for your options. Every decision is in the journal: journalctl -t machine-idle-suspend; --check and `machine status` show the last one when your user can read the journal',
          '--dry-run   print the plan (files, commands) and change nothing, not even by running sudo; needs no terminal',
          '--check   the status of this item (also whether the timer runs), without changing anything and without a password; exit 0 only when installed and up to date, 1 for every other state, 2 for a usage error',
          '--refresh   write the whole plan again (all three files) and restart the timer; use it to change --minutes or to repair a file changed by hand',
          '--remove   disable the timer, then remove exactly the three files; a file machine did not write is never touched; afterwards the status must read not installed',
          '--yes   kept for compatibility, no question is asked any more (sudo asks your password: a terminal is required, e.g. `ssh -t` on a remote box)',
          'Consequence: it only RESTRICTS uptime (the box suspends itself); no network surface, no right for any peer. Keep it awake on purpose with the keep-awake files',
        ],
        examples: ['machine install idle-suspend --dry-run', 'machine install idle-suspend --minutes 30', 'machine install idle-suspend --minutes 5 --rdp-minutes 20 --ssh-minutes 20 --refresh', 'machine install idle-suspend --check', 'machine install idle-suspend --remove'],
      },
    ],
    examples: ['machine install', 'machine install status', 'machine install suspend --dry-run', 'machine install suspend', 'machine install suspend --refresh'],
  },
];

export const GROUP_NAMES: string[] = GROUPS.map((g) => g.name);

const find = (name: string | undefined): GroupHelp | undefined => GROUPS.find((g) => g.name === name);

/** The usage error of an unknown subcommand: names it, the one-line list of the group and where the help is. */
export function unknownSubcommandMessage(group: string, sub: string | undefined): string {
  const g = find(group);
  if (g === undefined) throw new Error(`no help for the command group "${group}"`);
  // `machine peer wake` was renamed `machine wake`: a user of the old form is told, not left with a bare "unknown".
  const renamed = group === 'peer' && sub === 'wake' ? ' (`machine peer wake` was renamed: use `machine wake <machine>`)' : '';
  const what = sub === undefined ? `${group} needs a subcommand` : `unknown ${group} subcommand "${sub}"${renamed}`;
  return `${what}: machine ${group} ${g.subs.map((s) => s.name).join(' | ')}; see \`machine ${group} --help\``;
}

function indentLines(lines: string[], indent: string): string[] {
  return lines.map((l) => `${indent}${l}`);
}

function groupText(g: GroupHelp): string {
  const lines = [
    `machine ${g.name} - ${g.summary}`,
    '',
    `Usage: machine ${g.name} [<subcommand>] [options]`,
    `Without a subcommand, \`machine ${g.name}\` ${g.bare}.`,
    '',
    'Subcommands:',
  ];
  for (const s of g.subs) {
    lines.push('', `  ${s.usage}`, `      ${s.text}`);
    for (const o of s.options ?? []) lines.push(`        ${o}`);
  }
  lines.push('', 'Options of every command:', ...indentLines(GLOBAL, '  '), '', 'Examples:', ...indentLines(g.examples, '  '), '', `One subcommand: machine ${g.name} <subcommand> --help. All commands: machine --help`);
  return `${lines.join('\n')}\n`;
}

function subText(g: GroupHelp, s: SubHelp): string {
  const lines = [`machine ${g.name} ${s.usage}`, '', s.text, ''];
  if (s.options !== undefined && s.options.length > 0) lines.push('Arguments and options:', ...indentLines(s.options, '  '), '');
  lines.push('Options of every command:', ...indentLines(GLOBAL, '  '), '', 'Examples:', ...indentLines(s.examples, '  '), '', `All subcommands: machine ${g.name} --help`);
  return `${lines.join('\n')}\n`;
}

/** The answer of a help request: text for stdout (exit 0), or a usage error for stderr (exit 2). */
export type HelpAnswer = { kind: 'global' } | { kind: 'text'; text: string } | { kind: 'error'; message: string };

function topic(group: string | undefined, sub: string | undefined): HelpAnswer {
  const g = find(group);
  if (g === undefined) {
    return { kind: 'error', message: `unknown help topic "${group}": the command groups are ${GROUP_NAMES.join(', ')}; \`machine --help\` lists every command` };
  }
  if (sub === undefined) return { kind: 'text', text: groupText(g) };
  const s = g.subs.find((x) => x.name === sub);
  if (s === undefined) return { kind: 'error', message: unknownSubcommandMessage(g.name, sub) };
  return { kind: 'text', text: subText(g, s) };
}

/** The help of a group, for a bare group that has no read-only view of its own. */
export function groupHelpText(group: string): string {
  const answer = topic(group, undefined);
  if (answer.kind !== 'text') throw new Error(`no help for the command group "${group}"`);
  return answer.text;
}

/**
 * Is this command line a help request, and what does it ask? `--help`, `machine help [<group> [<sub>]]`,
 * `machine <group> help [<sub>]`, `machine <group> <sub> --help`. Anything else: undefined.
 */
export function helpRequest(positional: string[], helpFlag: boolean): HelpAnswer | undefined {
  const [first, second, third] = positional;
  if (first === 'help') return second === undefined ? { kind: 'global' } : topic(second, third);
  if (find(first) !== undefined) {
    if (second === 'help') return topic(first, third);
    if (helpFlag) return topic(first, second);
  }
  return helpFlag ? { kind: 'global' } : undefined;
}
