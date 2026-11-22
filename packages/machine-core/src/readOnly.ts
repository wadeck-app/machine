// Is this command line READ-ONLY, so that the Allow page may pre-select "Permanent" for it (hold-for-approval.md, "Read-only requests"). Pure, no I/O;
// copied byte for byte into machine-webcrypto (a test keeps the copies identical).
//
// The daemon runs the text through a shell (`sh -c`, `cmd /c`, PowerShell -EncodedCommand), so any metacharacter turns a harmless command into a dangerous
// one. Therefore this is a WHITELIST at every level, with no list of bad things anywhere:
//   1. the whole text is made of letters, digits, a single space between words and `-_./:=,@+` (no quote, no redirection, no substitution, no glob,
//      no non-ASCII), at most MAX_READ_ONLY_TEXT characters and MAX_WORDS words;
//   2. the first word is a command of the table for THIS shell (case sensitive, no path to it, no assignment in front);
//   3. every other word is a flag of that command's table (with the kind of value it takes), the start of one of its sub-commands, or a positional
//      of the kind the table says (a unit name, an interface, a number, a path).
// Anything else is "not read-only", which only means the owner starts from the usual default. The verdict is a PRE-SELECTION: it never allows anything,
// the owner still signs.

export type ReadOnlyVerdict = { readOnly: true; why: string } | { readOnly: false };

export const MAX_READ_ONLY_TEXT = 512;
const MAX_WORDS = 16;
const TEXT_CHARS = /^[A-Za-z0-9 \-_./:=,@+]+$/;

type ValueKind = 'int' | 'word' | 'list' | 'time' | 'prio';
type FlagKind = 'none' | ValueKind;
type PositionalKind = 'word' | 'psstyle' | 'filepath' | 'listpath';

export interface ReadOnlyRule {
  name: string;
  shells: readonly string[];
  /** What the owner reads in the tooltip: why this form changes nothing. */
  note: string;
  /** The words that follow the name and are not options, one alternative per allowed sub-command; `[[]]` is the bare command. */
  leads: readonly (readonly string[])[];
  /** Options without a value that may be written together, `-la`. */
  cluster?: string;
  /** The exact options (and, for some, the kind of the value that follows, as `--name value` or `--name=value`). */
  flags?: Readonly<Record<string, FlagKind>>;
  /** At least one of these options must be present (the command does something else without them). */
  need?: readonly string[];
  /** At most this many options (the ones of `flags`; their values do not count). */
  maxFlags?: number;
  /** The words after the lead. Absent: none. */
  rest?: { kind: PositionalKind; min: number; max: number };
}

const POSIX = ['sh', 'bash'] as const;
const WINDOWS = ['cmd', 'ps'] as const;
const BARE: readonly (readonly string[])[] = [[]];

/** Parts of a path that make it a place of secrets, compared in lower case anywhere in the path. A second barrier behind the table of readable roots. */
export const SECRET_NAME_MARKERS: readonly string[] = [
  '_secrets_', 'ssh', 'gnupg', 'gpg', 'shadow', 'passwd', 'password', 'passphrase', 'sudoers', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'authorized_keys', 'known_hosts',
  '.env', 'token', 'secret', 'credential', 'private', 'keyring', 'keychain', 'wallet', 'cookie', '.pem', '.key', '.pfx', '.p12', '.kdbx', 'netrc', 'aws', 'npmrc', 'pgpass',
  'kube', 'htpasswd',
];

/** The files readable with cat, head, tail and wc: these roots and these exact files only. */
const READABLE_ROOTS: readonly string[] = ['/sys/', '/usr/share/'];
const READABLE_FILES: readonly string[] = [
  '/etc/hostname', '/etc/os-release', '/etc/lsb-release', '/etc/issue', '/etc/hosts', '/etc/fstab', '/etc/timezone', '/etc/resolv.conf', '/etc/machine-info', '/etc/systemd/logind.conf',
  '/proc/cpuinfo', '/proc/meminfo', '/proc/uptime', '/proc/loadavg', '/proc/version',
];

/** True when the path is not an absolute, normalised path without a secret marker. */
function pathProblem(path: string, trailingSlash: boolean): boolean {
  if (!path.startsWith('/') || path.includes('//')) {
    return true;
  }
  const body = path === '/' ? '/' : trailingSlash && path.endsWith('/') ? path.slice(0, -1) : path;
  if (body !== '/') {
    for (const segment of body.split('/').slice(1)) {
      if (segment === '' || segment === '.' || segment === '..') {
        return true;
      }
    }
  }
  const lower = path.toLowerCase();
  return SECRET_NAME_MARKERS.some((marker) => lower.includes(marker));
}

function filePathOk(path: string): boolean {
  return !pathProblem(path, false) && (READABLE_FILES.includes(path) || READABLE_ROOTS.some((root) => path.startsWith(root) && path.length > root.length));
}

/** A directory or file named only to be listed or measured (ls, df): any absolute place that holds no secret marker. */
function listPathOk(path: string): boolean {
  return !pathProblem(path, true);
}

const INT = /^[0-9]{1,5}$/;
const WORD = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,127}$/;
const LIST = /^[A-Za-z0-9][A-Za-z0-9_.,:=@+-]{0,127}$/;
// journalctl --since/--until: a relative time (-10min), a day, a clock time, or one of its words. A text with a space needs quotes: not recognised.
const TIME = /^(?:[-+]?[0-9]{1,6}(?:s|sec|m|min|h|hr|d|day|days|w|week|weeks)?|today|yesterday|now|tomorrow|[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{2}:[0-9]{2}(?::[0-9]{2})?)$/;
const LEVEL = '(?:[0-7]|emerg|alert|crit|err|warning|notice|info|debug)';
const PRIO = new RegExp(`^${LEVEL}(?:\\.\\.${LEVEL})?$`);
const PS_STYLE = /^[auxwef]{2,6}$/;

function valueOk(kind: ValueKind, value: string): boolean {
  switch (kind) {
    case 'int':
      return INT.test(value);
    case 'word':
      return WORD.test(value);
    case 'list':
      return LIST.test(value);
    case 'time':
      return TIME.test(value);
    case 'prio':
      return PRIO.test(value);
  }
}

function positionalOk(kind: PositionalKind, value: string): boolean {
  switch (kind) {
    case 'word':
      return WORD.test(value);
    case 'psstyle':
      return PS_STYLE.test(value);
    case 'filepath':
      return filePathOk(value);
    case 'listpath':
      return listPathOk(value);
  }
}

const NET_FLAGS: Readonly<Record<string, FlagKind>> = { '-4': 'none', '-6': 'none', '-s': 'none', '-br': 'none' };
const IP_OBJECTS = ['addr', 'address', 'link', 'route', 'neigh', 'neighbour'];

/** The table. Every entry is an exact grammar: what is not written here is not read-only. */
export const READ_ONLY_COMMANDS: readonly ReadOnlyRule[] = [
  { name: 'ls', shells: POSIX, note: 'lists names, changes nothing', leads: BARE, cluster: 'lahtr1FSdi', rest: { kind: 'listpath', min: 0, max: 4 } },
  { name: 'pwd', shells: POSIX, note: 'prints the current folder', leads: BARE, flags: { '-P': 'none', '-L': 'none' } },
  { name: 'date', shells: POSIX, note: 'prints the clock (the forms that set it are not accepted)', leads: BARE, flags: { '-u': 'none', '--utc': 'none', '-I': 'none' } },
  { name: 'hostname', shells: POSIX, note: 'prints the host name (a name argument would set it: not accepted)', leads: BARE, flags: { '-f': 'none', '-s': 'none', '-i': 'none', '-I': 'none', '-d': 'none' } },
  { name: 'hostnamectl', shells: POSIX, note: 'status only (set-* and hostname <name> are not accepted)', leads: [[], ['status']], flags: { '--no-pager': 'none' } },
  { name: 'uname', shells: POSIX, note: 'prints the system name and version', leads: BARE, cluster: 'asnrvmpio' },
  { name: 'uptime', shells: POSIX, note: 'prints the time since boot', leads: BARE, flags: { '-p': 'none', '-s': 'none', '--pretty': 'none', '--since': 'none' } },
  { name: 'whoami', shells: POSIX, note: 'prints the user name', leads: BARE },
  { name: 'id', shells: POSIX, note: 'prints the user and group ids', leads: BARE, cluster: 'ugGnr', rest: { kind: 'word', min: 0, max: 1 } },
  { name: 'df', shells: POSIX, note: 'prints the disk usage', leads: BARE, cluster: 'hHTikPa', rest: { kind: 'listpath', min: 0, max: 4 } },
  { name: 'free', shells: POSIX, note: 'prints the memory usage once (no repeat option)', leads: BARE, cluster: 'hbkmgtwl', flags: { '--human': 'none' } },
  {
    name: 'ps',
    shells: POSIX,
    note: 'lists processes, changes nothing',
    leads: BARE,
    cluster: 'eAfaxuwlHF',
    flags: { '-p': 'int', '-C': 'word', '-u': 'word', '-o': 'list' },
    rest: { kind: 'psstyle', min: 0, max: 1 },
  },
  { name: 'pgrep', shells: POSIX, note: 'finds processes by name, signals nothing', leads: BARE, cluster: 'alfixno', flags: { '-u': 'word' }, rest: { kind: 'word', min: 1, max: 1 } },
  { name: 'cat', shells: POSIX, note: 'prints a file under /sys, /usr/share or a listed /etc and /proc file, never a secret location', leads: BARE, cluster: 'n', rest: { kind: 'filepath', min: 1, max: 4 } },
  { name: 'head', shells: POSIX, note: 'prints the start of a readable file', leads: BARE, flags: { '-n': 'int', '-c': 'int' }, rest: { kind: 'filepath', min: 1, max: 4 } },
  { name: 'tail', shells: POSIX, note: 'prints the end of a readable file (no follow option)', leads: BARE, flags: { '-n': 'int', '-c': 'int' }, rest: { kind: 'filepath', min: 1, max: 4 } },
  { name: 'wc', shells: POSIX, note: 'counts in a readable file', leads: BARE, cluster: 'lwcm', rest: { kind: 'filepath', min: 1, max: 4 } },
  {
    name: 'journalctl',
    shells: POSIX,
    note: 'reads the journal (no vacuum, rotate, flush, sync, key or catalog option, no follow)',
    leads: BARE,
    flags: {
      '-b': 'none', '-k': 'none', '-r': 'none', '-q': 'none', '--no-pager': 'none', '--no-hostname': 'none', '--system': 'none', '--user': 'none', '--list-boots': 'none', '--disk-usage': 'none',
      '--since': 'time', '--until': 'time', '-u': 'word', '--unit': 'word', '-n': 'int', '--lines': 'int', '-p': 'prio', '--priority': 'prio', '-o': 'word', '--output': 'word', '-t': 'word', '--identifier': 'word',
    },
  },
  {
    name: 'systemctl',
    shells: POSIX,
    note: 'reads the state of units (start, stop, restart, enable, mask, suspend, reboot and the other changes are not accepted)',
    leads: [['show'], ['status'], ['is-active'], ['is-enabled'], ['is-failed'], ['get-default'], ['list-units'], ['list-unit-files'], ['cat']],
    flags: {
      '--no-pager': 'none', '--user': 'none', '--system': 'none', '-a': 'none', '--all': 'none', '-l': 'none', '--full': 'none', '--value': 'none', '--failed': 'none',
      '-p': 'list', '--property': 'list', '-t': 'word', '--type': 'word', '--state': 'word', '-n': 'int', '--lines': 'int', '-o': 'word', '--output': 'word',
    },
    rest: { kind: 'word', min: 0, max: 8 },
  },
  {
    name: 'loginctl',
    shells: POSIX,
    note: 'reads the sessions and users (terminate, lock, kill and the other changes are not accepted)',
    leads: [['list-sessions'], ['show-session'], ['show-user'], ['list-users'], ['session-status']],
    flags: { '--no-pager': 'none', '-p': 'list', '--property': 'list', '--value': 'none', '-a': 'none', '--all': 'none', '-l': 'none', '--full': 'none' },
    rest: { kind: 'word', min: 0, max: 4 },
  },
  { name: 'systemd-inhibit', shells: POSIX, note: 'only --list, which lists the inhibitors (any other form runs a command)', leads: BARE, flags: { '--list': 'none', '--no-pager': 'none' }, need: ['--list'] },
  {
    name: 'ethtool',
    shells: POSIX,
    note: 'shows ONE property of an interface (every option that sets, flashes, tests or restarts is not accepted)',
    leads: BARE,
    flags: {
      '-i': 'none', '--driver': 'none', '-S': 'none', '--statistics': 'none', '-g': 'none', '--show-ring': 'none', '-c': 'none', '--show-coalesce': 'none', '-a': 'none', '--show-pause': 'none',
      '-k': 'none', '--show-features': 'none', '--show-offload': 'none', '-l': 'none', '--show-channels': 'none', '--show-eee': 'none', '--show-fec': 'none', '-P': 'none', '--show-permaddr': 'none',
      '-T': 'none', '--show-time-stamping': 'none',
    },
    maxFlags: 1,
    rest: { kind: 'word', min: 1, max: 1 },
  },
  {
    name: 'ip',
    shells: POSIX,
    note: 'shows addresses, links, routes or neighbours (add, del, set, flush and the other changes are not accepted)',
    leads: IP_OBJECTS.flatMap((object) => [[object], [object, 'show']]),
    flags: NET_FLAGS,
  },
  { name: 'node', shells: POSIX, note: 'prints its version, runs nothing', leads: BARE, flags: { '--version': 'none', '-v': 'none' }, need: ['--version', '-v'] },
  { name: 'npm', shells: POSIX, note: 'prints its version, runs nothing', leads: BARE, flags: { '--version': 'none', '-v': 'none' }, need: ['--version', '-v'] },
  {
    name: 'machine',
    shells: POSIX,
    note: 'reads the state of this machine (run, admin, policy, cli update and the other changes are not accepted)',
    leads: [['cli', 'version'], ['allowed'], ['status'], ['install', 'status'], ['log']],
    flags: { '--json': 'none', '--limit': 'int', '--since': 'time' },
  },
  {
    name: 'orch',
    shells: POSIX,
    note: 'reads the jobs (add, remove, restart and the other changes are not accepted, no follow)',
    leads: [['list'], ['status'], ['show'], ['logs']],
    flags: { '--json': 'none', '--tail': 'int' },
    rest: { kind: 'word', min: 0, max: 1 },
  },
  // Windows: the host answers about itself, nothing takes an argument that acts (whoami /logoff, ipconfig /release, tasklist /s are not accepted).
  { name: 'hostname', shells: WINDOWS, note: 'prints the host name', leads: BARE },
  { name: 'whoami', shells: WINDOWS, note: 'prints the user name', leads: BARE },
  { name: 'ver', shells: ['cmd'], note: 'prints the Windows version', leads: BARE },
  { name: 'systeminfo', shells: WINDOWS, note: 'prints the system information', leads: BARE },
  { name: 'ipconfig', shells: WINDOWS, note: 'shows the network settings (release, renew and flushdns are not accepted)', leads: BARE, flags: { '/all': 'none' } },
  { name: 'tasklist', shells: WINDOWS, note: 'lists processes (no remote option)', leads: BARE, flags: { '/v': 'none', '/svc': 'none' } },
  { name: 'Get-Date', shells: ['ps'], note: 'prints the clock', leads: BARE },
  { name: 'Get-ComputerInfo', shells: ['ps'], note: 'prints the computer information', leads: BARE },
  { name: 'Get-Process', shells: ['ps'], note: 'lists processes (no remote option)', leads: BARE, flags: { '-Name': 'word' } },
  { name: 'Get-Service', shells: ['ps'], note: 'lists services (no remote option)', leads: BARE, flags: { '-Name': 'word' } },
];

/** Checks the words after the name against one rule; the matched lead on success. */
function matchRule(rule: ReadOnlyRule, args: readonly string[]): string[] | undefined {
  const flags = rule.flags ?? {};
  const positionals: string[] = [];
  const seen = new Set<string>();
  let flagCount = 0;
  for (let i = 0; i < args.length; i++) {
    const word = args[i] as string;
    const exact = Object.hasOwn(flags, word) ? (flags[word] as FlagKind) : undefined;
    if (exact !== undefined) {
      flagCount++;
      seen.add(word);
      if (exact !== 'none') {
        // The value is the next word and must be a value of the kind (so `-u --rotate` is not a unit).
        const value = args[i + 1];
        if (value === undefined || !valueOk(exact, value)) {
          return undefined;
        }
        i++;
      }
      continue;
    }
    if (word.startsWith('-')) {
      const eq = word.indexOf('=');
      if (eq > 0) {
        const name = word.slice(0, eq);
        const kind = Object.hasOwn(flags, name) ? (flags[name] as FlagKind) : undefined;
        if (kind === undefined || kind === 'none' || !valueOk(kind, word.slice(eq + 1))) {
          return undefined;
        }
        flagCount++;
        seen.add(name);
        continue;
      }
      // `-la`: a single dash and letters that are all options without a value of this command.
      const cluster = rule.cluster;
      if (cluster !== undefined && /^-[A-Za-z0-9]+$/.test(word) && [...word.slice(1)].every((c) => cluster.includes(c))) {
        continue;
      }
      return undefined;
    }
    positionals.push(word);
  }
  if (rule.maxFlags !== undefined && flagCount > rule.maxFlags) {
    return undefined;
  }
  if (rule.need !== undefined && !rule.need.some((name) => seen.has(name))) {
    return undefined;
  }
  // The longest sub-command first (`ip addr show` before `ip addr`).
  for (const lead of [...rule.leads].sort((a, b) => b.length - a.length)) {
    if (lead.length > positionals.length || !lead.every((w, i) => positionals[i] === w)) {
      continue;
    }
    const rest = positionals.slice(lead.length);
    const allowed = rule.rest ?? { kind: 'word' as const, min: 0, max: 0 };
    if (rest.length < allowed.min || rest.length > allowed.max || !rest.every((p) => positionalOk(allowed.kind, p))) {
      continue;
    }
    return [...lead];
  }
  return undefined;
}

/**
 * Whether `commandText`, as run by `shell` (`sh`, `bash`, `cmd`, `ps`), is a command of the table written in the form of the table. `why` names the rule, for
 * the tooltip of the owner. Any other input, of any type, is not read-only.
 */
export function classifyReadOnly(shell: string, commandText: string): ReadOnlyVerdict {
  const no: ReadOnlyVerdict = { readOnly: false };
  if (typeof shell !== 'string' || typeof commandText !== 'string' || commandText.length === 0 || commandText.length > MAX_READ_ONLY_TEXT || !TEXT_CHARS.test(commandText)) {
    return no;
  }
  // One space between words, none at the ends: any other layout is another text, not recognised.
  const words = commandText.split(' ');
  if (words.length > MAX_WORDS || words.some((w) => w === '')) {
    return no;
  }
  const name = words[0] as string;
  for (const rule of READ_ONLY_COMMANDS) {
    if (rule.name !== name || !rule.shells.includes(shell)) {
      continue;
    }
    const lead = matchRule(rule, words.slice(1));
    if (lead !== undefined) {
      return { readOnly: true, why: `${[name, ...lead].join(' ')}: ${rule.note}. The text holds only letters, digits and - _ . / : = , @ +, so the shell has nothing to interpret.` };
    }
  }
  return no;
}
