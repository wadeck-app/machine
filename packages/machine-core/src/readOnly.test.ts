import { describe, expect, it } from 'vitest';
import { classifyReadOnly, READ_ONLY_COMMANDS, SECRET_NAME_MARKERS } from './readOnly.js';

// The classifier only decides a PRE-SELECTION (Permanent) in the Allow UI; the owner still signs. A false positive pre-selects Permanent for a command that is
// not read-only, so the table below is the hostile corpus: every line of NOT must stay false, whatever is added to the whitelist later.
// (The secret locations are covered through SECRET_NAME_MARKERS below, so this file holds no literal path of a credential store.)

const NOT: Array<[string, string, string]> = [
  // [shell, command, why it is refused]
  ['sh', 'cat /etc/hostname; rm -rf /', 'semicolon'],
  ['sh', 'cat /etc/hostname && id', 'and'],
  ['sh', 'cat /etc/hostname || id', 'or'],
  ['sh', 'cat x > y', 'redirection'],
  ['sh', 'cat /etc/hostname > /etc/passwd', 'redirection'],
  ['sh', 'cat < /etc/hostname', 'input redirection'],
  ['sh', 'ls $(reboot)', 'substitution'],
  ['sh', 'ls `id`', 'backtick'],
  ['sh', 'ls | sh', 'pipe'],
  ['sh', 'ls $HOME', 'variable'],
  ['sh', 'ls *', 'glob'],
  ['sh', 'ls ?', 'glob'],
  ['sh', 'ls [a]', 'glob'],
  ['sh', 'ls ~', 'tilde'],
  ['sh', 'ls #x', 'comment'],
  ['sh', 'ls !x', 'history'],
  ['sh', 'ls \\x', 'backslash'],
  ['sh', "ls 'x'", 'quote'],
  ['sh', 'ls "x"', 'quote'],
  ['sh', 'ls {a,b}', 'brace'],
  ['sh', 'ls (x)', 'paren'],
  ['sh', 'ls\nreboot', 'newline'],
  ['sh', 'ls\r\nreboot', 'crlf'],
  ['sh', 'ls\treboot', 'tab'],
  ['sh', 'ls\u0000reboot', 'nul'],
  ['sh', 'ls &', 'background'],
  ['sh', 'ls /tmp', 'no-break space'],
  ['sh', 'lѕ', 'cyrillic s look-alike'],
  ['sh', 'ѕystemctl status x', 'cyrillic s look-alike first letter'],
  ['sh', 'hostnаme', 'cyrillic a look-alike'],
  ['sh', 'ls ／', 'full width slash'],
  ['sh', 'LS', 'uppercase'],
  ['sh', 'Hostname', 'capitalised'],
  ['sh', 'DATE', 'uppercase'],
  ['sh', 'systemctl STATUS x', 'uppercase subcommand'],
  ['sh', 'ls -L', 'uppercase flag not in table'],
  ['sh', 'ls ', 'trailing space'],
  ['sh', ' ls', 'leading space'],
  ['sh', 'ls  -l', 'double space'],
  ['sh', 'ls -l ', 'trailing space after flag'],
  ['sh', '', 'empty'],
  ['sh', ' ', 'space only'],
  ['sh', `ls ${'a'.repeat(2048)}`, 'long'],
  ['sh', 'a'.repeat(2048), 'long word'],
  ['sh', 'journalctl --vacuum-size=1M', 'vacuum'],
  ['sh', 'journalctl --vacuum-time=1d', 'vacuum'],
  ['sh', 'journalctl --rotate', 'rotate'],
  ['sh', 'journalctl --flush', 'flush'],
  ['sh', 'journalctl --sync', 'sync'],
  ['sh', 'journalctl --setup-keys', 'setup-keys'],
  ['sh', 'journalctl --update-catalog', 'update-catalog'],
  ['sh', 'journalctl -f', 'follow never ends'],
  ['sh', 'journalctl --follow', 'follow never ends'],
  ['sh', 'journalctl --vacuum-s=1M', 'abbreviated long option'],
  ['sh', 'journalctl --since', 'value missing'],
  ['sh', 'journalctl --since --vacuum-size=1M', 'value is an option'],
  ['sh', 'journalctl -u --rotate', 'value is an option'],
  ['sh', 'journalctl --since=x;id', 'meta'],
  ['sh', 'journalctl -n x', 'count is not a number'],
  ['sh', 'systemctl suspend', 'suspend'],
  ['sh', 'systemctl stop x', 'stop'],
  ['sh', 'systemctl start x', 'start'],
  ['sh', 'systemctl restart x', 'restart'],
  ['sh', 'systemctl enable x', 'enable'],
  ['sh', 'systemctl disable x', 'disable'],
  ['sh', 'systemctl mask x', 'mask'],
  ['sh', 'systemctl reboot', 'reboot'],
  ['sh', 'systemctl poweroff', 'poweroff'],
  ['sh', 'systemctl set-default graphical.target', 'set-default'],
  ['sh', 'systemctl edit x', 'edit'],
  ['sh', 'systemctl daemon-reload', 'daemon-reload'],
  ['sh', 'systemctl', 'no subcommand'],
  ['sh', 'systemctl status x -H root@host', 'remote'],
  ['sh', 'systemctl show x --root=/tmp', 'root'],
  ['sh', 'systemctl show x -p', 'value missing'],
  ['sh', 'systemctl -p stop', 'no subcommand'],
  ['sh', 'systemctl --no-pager stop x', 'flag before the subcommand'],
  ['sh', 'loginctl terminate-session c2', 'terminate'],
  ['sh', 'loginctl lock-session c2', 'lock'],
  ['sh', 'loginctl kill-session c2', 'kill'],
  ['sh', 'loginctl poweroff', 'poweroff'],
  ['sh', 'ethtool -s enp0s31f6 advertise 0x008', 'set'],
  ['sh', 'ethtool --change enp0s31f6 advertise 0x008', 'change'],
  ['sh', 'ethtool -E enp0s31f6', 'eeprom write'],
  ['sh', 'ethtool -f enp0s31f6 x', 'flash'],
  ['sh', 'ethtool -p enp0s31f6', 'identify'],
  ['sh', 'ethtool -t enp0s31f6', 'self test'],
  ['sh', 'ethtool -r enp0s31f6', 'restart autoneg'],
  ['sh', 'ethtool -A enp0s31f6', 'set pause'],
  ['sh', 'ethtool -C enp0s31f6', 'set coalesce'],
  ['sh', 'ethtool -G enp0s31f6', 'set ring'],
  ['sh', 'ethtool -K enp0s31f6', 'set features'],
  ['sh', 'ethtool -L enp0s31f6', 'set channels'],
  ['sh', 'ethtool -N enp0s31f6', 'set nfc'],
  ['sh', 'ethtool -U enp0s31f6', 'set ntuple'],
  ['sh', 'ethtool --set-eee enp0s31f6 eee off', 'set-eee'],
  ['sh', 'ethtool --show-eee enp0s31f6 eee off', 'show flag with setting words'],
  ['sh', 'ethtool enp0s31f6 advertise 0x008', 'settings after the interface'],
  ['sh', 'ethtool enp0s31f6 wol d', 'wol'],
  ['sh', 'ethtool', 'no interface'],
  ['sh', 'ethtool -i', 'no interface'],
  ['sh', 'ip addr add 10.0.0.1/24 dev eth0', 'add'],
  ['sh', 'ip addr del 10.0.0.1/24 dev eth0', 'del'],
  ['sh', 'ip link set eth0 down', 'set'],
  ['sh', 'ip route flush all', 'flush'],
  ['sh', 'ip route show flush all', 'flush after show'],
  ['sh', 'ip neigh flush all', 'flush'],
  ['sh', 'ip l set eth0 down', 'abbreviation'],
  ['sh', 'ip -n x addr', 'netns option'],
  ['sh', 'ip', 'bare'],
  ['sh', 'cat /etc/shadow', 'shadow'],
  ['sh', 'cat /etc/passwd', 'passwd'],
  ['sh', 'cat /etc/gshadow', 'gshadow'],
  ['sh', 'cat /etc/sudoers', 'sudoers'],
  ['sh', 'cat /home/u/.config/machine/_secrets_/admin.json', 'secrets'],
  ['sh', 'cat /home/u/.env', 'dotenv'],
  ['sh', 'cat /home/u/id_rsa', 'private key'],
  ['sh', 'cat /sys/token', 'token'],
  ['sh', 'cat /sys/TOKEN', 'token upper case'],
  ['sh', 'cat /usr/share/x/id_ed25519', 'id_ed25519'],
  ['sh', 'cat /usr/share/x/secret.txt', 'secret'],
  ['sh', 'cat /usr/share/x/server.pem', 'pem'],
  ['sh', 'cat ../../etc/shadow', 'dot dot'],
  ['sh', 'cat /sys/../etc/shadow', 'dot dot inside'],
  ['sh', 'cat /sys/..', 'dot dot last'],
  ['sh', 'cat /sys//power', 'double slash'],
  ['sh', 'cat relative/file', 'relative path'],
  ['sh', 'cat x', 'relative path'],
  ['sh', 'cat', 'no path (reads stdin)'],
  ['sh', 'cat -', 'stdin'],
  ['sh', 'cat /proc/1/environ', 'process environment'],
  ['sh', 'cat /proc/self/environ', 'process environment'],
  ['sh', 'cat /home/u/notes.txt', 'outside the readable roots'],
  ['sh', 'cat /var/log/auth.log', 'outside the readable roots'],
  ['sh', 'ls /home/u/../../etc', 'dot dot in a listing'],
  ['sh', 'ls ..', 'dot dot'],
  ['sh', 'ls relative', 'relative listing path'],
  ['sh', 'tail -f /sys/power/state', 'follow'],
  ['sh', 'tail -F /sys/power/state', 'follow'],
  ['sh', 'tail --follow /sys/power/state', 'follow'],
  ['sh', 'head -n x /sys/power/state', 'count'],
  ['sh', 'wc --files0-from=/etc/hostname', 'files0-from'],
  ['sh', 'git -c core.pager=sh log', 'git -c'],
  ['sh', 'git status', 'git runs code of the repository configuration'],
  ['sh', 'git log', 'git'],
  ['sh', 'git diff', 'git'],
  ['sh', 'git branch --list', 'git'],
  ['sh', 'git --exec-path=/tmp status', 'git'],
  ['sh', 'git config --list', 'git'],
  ['sh', 'docker ps', 'docker not recognised'],
  ['sh', 'kubectl get pods', 'kubectl not recognised'],
  ['sh', 'find / -delete', 'find'],
  ['sh', 'find /tmp', 'find'],
  ['sh', 'grep -rhE ^Idle /etc/systemd/logind.conf', 'grep'],
  ['sh', 'grep x /etc/hostname', 'grep'],
  ['sh', 'sed -n 1p /etc/hostname', 'sed'],
  ['sh', 'awk 1 /etc/hostname', 'awk'],
  ['sh', 'tee /tmp/x', 'tee'],
  ['sh', 'xargs ls', 'xargs'],
  ['sh', 'curl http://x', 'curl'],
  ['sh', 'wget http://x', 'wget'],
  ['sh', 'dd if=/dev/zero of=/dev/sda', 'dd'],
  ['sh', 'tar xf x.tar', 'tar'],
  ['sh', 'rm -rf /', 'rm'],
  ['sh', 'rm x', 'rm'],
  ['sh', 'mv a b', 'mv'],
  ['sh', 'cp a b', 'cp'],
  ['sh', 'chmod 777 x', 'chmod'],
  ['sh', 'kill 1', 'kill'],
  ['sh', 'sudo ls', 'sudo'],
  ['sh', 'sudo -n ls', 'sudo'],
  ['sh', 'sh', 'sh'],
  ['sh', 'bash', 'bash'],
  ['sh', 'bash -c ls', 'bash'],
  ['sh', 'env', 'env'],
  ['sh', 'env ls', 'env'],
  ['sh', 'nohup ls', 'nohup'],
  ['sh', 'FOO=bar ls', 'assignment in front'],
  ['sh', 'LD_PRELOAD=/tmp/x.so ls', 'assignment in front'],
  ['sh', './ls', 'relative executable'],
  ['sh', '/bin/ls', 'path to an executable'],
  ['sh', '/tmp/ls', 'path to an executable'],
  ['sh', 'ls --color=always', 'flag not in the table'],
  ['sh', 'ls -l --', 'double dash'],
  ['sh', 'ls --help', 'help flag not in the table'],
  ['sh', 'date -s 2020-01-01', 'sets the clock'],
  ['sh', 'date --set=2020-01-01', 'sets the clock'],
  ['sh', 'date 010100002020', 'positional sets the clock'],
  ['sh', 'hostname evil', 'sets the host name'],
  ['sh', 'hostname -F /etc/hostname', 'sets the host name'],
  ['sh', 'hostnamectl set-hostname x', 'set-hostname'],
  ['sh', 'hostnamectl hostname x', 'sets in recent versions'],
  ['sh', 'hostnamectl set-chassis laptop', 'set-chassis'],
  ['sh', 'hostnamectl status x', 'extra word'],
  ['sh', 'systemd-inhibit', 'runs a shell'],
  ['sh', 'systemd-inhibit ls', 'runs a command'],
  ['sh', 'systemd-inhibit --list ls', 'extra word'],
  ['sh', 'systemd-inhibit --what=sleep sleep 5', 'runs a command'],
  ['sh', 'node', 'repl'],
  ['sh', 'node -e 1', 'code'],
  ['sh', 'node x.js', 'script'],
  ['sh', 'node --version x', 'extra word'],
  ['sh', 'npm install', 'install'],
  ['sh', 'npm run x', 'run'],
  ['sh', 'npm --version --foo', 'extra flag'],
  ['sh', 'machine run laptop -- ls', 'run'],
  ['sh', 'machine admin allow x -- ls', 'admin'],
  ['sh', 'machine cli update', 'update'],
  ['sh', 'machine cli rollback', 'rollback'],
  ['sh', 'machine install suspend', 'install suspend'],
  ['sh', 'machine install status --remove', 'remove'],
  ['sh', 'machine log --follow', 'follow'],
  ['sh', 'machine log -f', 'follow'],
  ['sh', 'machine startup disable', 'disable'],
  ['sh', 'orch add job', 'add'],
  ['sh', 'orch logs a --follow', 'follow'],
  ['sh', 'orch logs a -f', 'follow'],
  ['sh', 'orch restart-job x', 'restart'],
  ['sh', 'orch remove x', 'remove'],
  ['sh', 'ps -ef --forest;id', 'meta'],
  ['sh', 'ps -k x', 'flag not in the table'],
  ['sh', 'pgrep -f x -P', 'flag not in the table'],
  ['sh', 'pkill x', 'pkill'],
  ['sh', 'free -s 1', 'never ends'],
  ['sh', 'df --output=x', 'flag not in the table'],
  ['sh', 'uname -n evil;x', 'meta'],
  ['sh', 'id root; id', 'meta'],
  ['sh', 'uptime -x', 'flag not in the table'],
  // The shell is part of the question: a name of another family is not recognised.
  ['cmd', 'ls', 'posix command in cmd'],
  ['ps', 'cat /etc/hostname', 'posix command in ps'],
  ['cmd', 'Get-Date', 'cmdlet in cmd'],
  ['sh', 'Get-Date', 'cmdlet in sh'],
  ['sh', 'ver', 'cmd builtin in sh'],
  ['sh', 'systeminfo', 'windows command in sh'],
  ['cmd', 'whoami /logoff', 'logs off'],
  ['cmd', 'whoami /all', 'not in the table'],
  ['cmd', 'ipconfig /release', 'release'],
  ['cmd', 'ipconfig /renew', 'renew'],
  ['cmd', 'ipconfig /flushdns', 'flushdns'],
  ['cmd', 'ipconfig /registerdns', 'registerdns'],
  ['cmd', 'tasklist /s remote', 'remote'],
  ['cmd', 'tasklist /u x /p y', 'credentials'],
  ['cmd', 'tasklist /fi "imagename eq x"', 'quote'],
  ['cmd', 'hostname & calc', 'ampersand'],
  ['cmd', 'hostname && calc', 'ampersand'],
  ['cmd', 'hostname | more', 'pipe'],
  ['cmd', 'hostname > x', 'redirection'],
  ['cmd', 'hostname %COMSPEC%', 'percent'],
  ['cmd', 'hostname ^& calc', 'caret'],
  ['cmd', 'HOSTNAME', 'uppercase'],
  ['cmd', 'Hostname', 'capitalised'],
  ['cmd', 'ver /x', 'extra flag'],
  ['cmd', 'systeminfo /s host', 'remote'],
  ['cmd', 'shutdown /s', 'shutdown'],
  ['cmd', 'net user x /add', 'net'],
  ['cmd', 'powershell Get-Date', 'powershell'],
  ['ps', 'Get-Date; calc', 'meta'],
  ['ps', 'Get-Date | Out-File x', 'pipe'],
  ['ps', 'Get-Date -Format "x"', 'quote'],
  ['ps', 'Get-Date -Format x', 'flag not in the table'],
  ['ps', 'get-date', 'lower case cmdlet'],
  ['ps', 'GET-DATE', 'upper case cmdlet'],
  ['ps', 'Get-Content /etc/hostname', 'Get-Content'],
  ['ps', 'Get-ChildItem', 'Get-ChildItem'],
  ['ps', 'Get-Process $x', 'variable'],
  ['ps', 'Get-Process -Name x -ComputerName y', 'remote'],
  ['ps', 'Get-Service -ComputerName y', 'remote'],
  ['ps', 'Stop-Process -Name x', 'Stop-Process'],
  ['ps', 'Remove-Item x', 'Remove-Item'],
  ['ps', 'Invoke-Expression x', 'Invoke-Expression'],
  ['ps', 'iex x', 'iex'],
  ['ps', 'Get-Process -Name', 'value missing'],
  ['ps', 'ver', 'ver is a cmd builtin'],
  ['ps', 'whoami /logoff', 'logs off'],
  ['ps', 'ipconfig /renew', 'renew'],
  // Not a shell of the product.
  ['zsh', 'ls', 'unknown shell'],
  ['', 'ls', 'unknown shell'],
  ['SH', 'ls', 'unknown shell'],
];

// The commands that run on the real boxes today (the user's list), plus the other documented forms.
const YES: Array<[string, string]> = [
  ['sh', 'ls'],
  ['sh', 'ls -l'],
  ['sh', 'ls -la /usr/share/xsessions'],
  ['sh', 'ls /usr/share/xsessions'],
  ['sh', 'pwd'],
  ['sh', 'hostname'],
  ['sh', 'hostname -f'],
  ['sh', 'date'],
  ['sh', 'date -u'],
  ['sh', 'hostnamectl'],
  ['sh', 'hostnamectl status'],
  ['sh', 'hostnamectl --no-pager'],
  ['sh', 'uname'],
  ['sh', 'uname -a'],
  ['sh', 'uname -r'],
  ['sh', 'uptime'],
  ['sh', 'uptime -p'],
  ['sh', 'whoami'],
  ['sh', 'id'],
  ['sh', 'id -un'],
  ['sh', 'df'],
  ['sh', 'df -h /'],
  ['sh', 'free'],
  ['sh', 'free -h'],
  ['sh', 'ps'],
  ['sh', 'ps aux'],
  ['sh', 'ps -ef'],
  ['sh', 'ps -p 1'],
  ['sh', 'pgrep xfce4-power'],
  ['sh', 'pgrep -a xfce4-power'],
  ['sh', 'ethtool enp0s31f6'],
  ['sh', 'ethtool -i enp0s31f6'],
  ['sh', 'ethtool -S enp0s31f6'],
  ['sh', 'ethtool --show-eee enp0s31f6'],
  ['sh', 'ethtool --show-ring enp0s31f6'],
  ['sh', 'systemctl get-default'],
  ['sh', 'systemctl is-active xrdp gnome-remote-desktop'],
  ['sh', 'systemctl is-enabled xrdp'],
  ['sh', 'systemctl is-failed xrdp'],
  ['sh', 'systemctl status xrdp --no-pager'],
  ['sh', 'systemctl show x -p y --no-pager'],
  ['sh', 'systemctl show -p ActiveState xrdp'],
  ['sh', 'systemctl list-units'],
  ['sh', 'systemctl list-unit-files'],
  ['sh', 'systemctl cat xrdp'],
  ['sh', 'systemctl --no-pager status xrdp'],
  ['sh', 'systemd-inhibit --list'],
  ['sh', 'loginctl list-sessions'],
  ['sh', 'loginctl list-users'],
  ['sh', 'loginctl show-session c2 -p Type -p IdleHint'],
  ['sh', 'loginctl show-user wadeck'],
  ['sh', 'loginctl session-status c2'],
  ['sh', 'journalctl -b --since -10min --no-pager'],
  ['sh', 'journalctl -b --since=-10min --no-pager'],
  ['sh', 'journalctl -u xrdp -n 50 --no-pager'],
  ['sh', 'journalctl -k -p err --no-pager'],
  ['sh', 'journalctl --since 2026-11-22 --until 10:00:00'],
  ['sh', 'cat /sys/power/pm_wakeup_irq'],
  ['sh', 'cat /etc/hostname'],
  ['sh', 'cat /etc/os-release'],
  ['sh', 'head -n 5 /etc/os-release'],
  ['sh', 'tail -n 5 /sys/power/state'],
  ['sh', 'wc -l /etc/hostname'],
  ['sh', 'ip addr'],
  ['sh', 'ip addr show'],
  ['sh', 'ip link'],
  ['sh', 'ip route'],
  ['sh', 'ip neigh show'],
  ['sh', 'ip -4 addr show'],
  ['sh', 'node --version'],
  ['sh', 'node -v'],
  ['sh', 'npm --version'],
  ['sh', 'npm -v'],
  ['sh', 'machine cli version'],
  ['sh', 'machine allowed'],
  ['sh', 'machine status'],
  ['sh', 'machine install status'],
  ['sh', 'machine log'],
  ['sh', 'machine log --limit 20'],
  ['sh', 'orch list'],
  ['sh', 'orch status'],
  ['sh', 'orch show machine'],
  ['sh', 'orch logs machine --tail=20'],
  ['bash', 'ls'],
  ['bash', 'systemctl get-default'],
  ['cmd', 'hostname'],
  ['cmd', 'whoami'],
  ['cmd', 'ver'],
  ['cmd', 'systeminfo'],
  ['cmd', 'ipconfig'],
  ['cmd', 'ipconfig /all'],
  ['cmd', 'tasklist'],
  ['ps', 'hostname'],
  ['ps', 'whoami'],
  ['ps', 'ipconfig /all'],
  ['ps', 'Get-Date'],
  ['ps', 'Get-ComputerInfo'],
  ['ps', 'Get-Process'],
  ['ps', 'Get-Process -Name node'],
  ['ps', 'Get-Service'],
  ['ps', 'Get-Service -Name Spooler'],
];

describe('classifyReadOnly: the commands that are recognised', () => {
  it.each(YES)('%s: %s', (shell, command) => {
    const verdict = classifyReadOnly(shell, command);
    expect(verdict.readOnly).toBe(true);
    if (verdict.readOnly) {
      expect(verdict.why.length).toBeGreaterThan(10);
      // The reason names the command that matched, for the tooltip of the owner.
      expect(verdict.why).toContain(command.split(' ')[0] as string);
    }
  });
});

describe('classifyReadOnly: every hostile or unknown command is refused', () => {
  it.each(NOT)('%s: %j (%s)', (shell, command) => {
    expect(classifyReadOnly(shell, command)).toEqual({ readOnly: false });
  });

  it('never throws on any input type', () => {
    for (const value of [undefined, null, 1, {}, [], Symbol('x'), 'ls'.repeat(10000)]) {
      expect(classifyReadOnly('sh', value as never)).toEqual({ readOnly: false });
    }
    expect(classifyReadOnly(undefined as never, 'ls')).toEqual({ readOnly: false });
  });

  it('the YES and NOT tables do not overlap', () => {
    const yes = new Set(YES.map(([s, c]) => `${s}\u0001${c}`));
    for (const [shell, command] of NOT) expect(yes.has(`${shell}\u0001${command}`)).toBe(false);
  });

  it('every secret marker makes a path unreadable, in any case and anywhere in the path', () => {
    expect(SECRET_NAME_MARKERS.length).toBeGreaterThan(10);
    for (const marker of SECRET_NAME_MARKERS) {
      expect(marker).toMatch(/^[a-z0-9\-_.]+$/);
      for (const path of [`/sys/${marker}`, `/sys/x${marker}`, `/sys/${marker}x`, `/sys/${marker.toUpperCase()}`, `/usr/share/a/${marker}/b`, `/etc/${marker}`]) {
        expect(classifyReadOnly('sh', `cat ${path}`)).toEqual({ readOnly: false });
        expect(classifyReadOnly('sh', `ls ${path}`)).toEqual({ readOnly: false });
        expect(classifyReadOnly('sh', `head -n 1 ${path}`)).toEqual({ readOnly: false });
      }
    }
  });
});

describe('classifyReadOnly: property checks over the whitelisted characters', () => {
  // A small deterministic generator (no Math.random): the failure of a run is the failure of every run.
  const next = (seed: { n: number }): number => {
    seed.n = (Math.imul(seed.n, 1664525) + 1013904223) >>> 0;
    return seed.n;
  };
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_./:=,@+';
  const known = new Set(READ_ONLY_COMMANDS.map((c) => c.name));

  it('lists a table that is not empty and holds none of the commands that are never read-only', () => {
    expect(known.size).toBeGreaterThan(20);
    for (const never of ['find', 'grep', 'sed', 'awk', 'tee', 'xargs', 'curl', 'wget', 'dd', 'tar', 'rm', 'mv', 'cp', 'chmod', 'kill', 'sudo', 'sh', 'bash', 'env', 'nohup', 'git', 'docker', 'kubectl', 'zsh', 'python', 'perl', 'ssh', 'su', 'eval', 'exec', 'source', 'ln', 'touch', 'mkdir']) {
      expect(known.has(never)).toBe(false);
    }
  });

  it('never recognises a line whose first word is outside the table (50000 random lines)', () => {
    const seed = { n: 12345 };
    for (let i = 0; i < 50000; i++) {
      const length = 1 + (next(seed) % 40);
      let text = '';
      for (let j = 0; j < length; j++) text += ALPHABET[next(seed) % ALPHABET.length];
      const first = text.split(' ')[0] as string;
      for (const shell of ['sh', 'bash', 'cmd', 'ps']) {
        const verdict = classifyReadOnly(shell, text);
        if (verdict.readOnly) {
          expect(known.has(first)).toBe(true);
        }
      }
    }
  });

  it('a recognised line is always normalised, made of whitelisted characters only, and starts with a command of the table (random tails behind every command)', () => {
    const seed = { n: 777 };
    let recognised = 0;
    for (let i = 0; i < 30000; i++) {
      const command = READ_ONLY_COMMANDS[next(seed) % READ_ONLY_COMMANDS.length] as (typeof READ_ONLY_COMMANDS)[number];
      const words = [command.name];
      const count = next(seed) % 5;
      for (let w = 0; w < count; w++) {
        let word = '';
        const length = 1 + (next(seed) % 12);
        for (let j = 0; j < length; j++) word += ALPHABET.replace(' ', '')[next(seed) % (ALPHABET.length - 1)];
        words.push(word);
      }
      const text = words.join(' ');
      for (const shell of command.shells) {
        const verdict = classifyReadOnly(shell, text);
        if (verdict.readOnly) {
          recognised++;
          expect(text).toMatch(/^[A-Za-z0-9\-_./:=,@+]+( [A-Za-z0-9\-_./:=,@+]+)*$/);
          expect(text.split(' ')[0]).toBe(command.name);
        }
      }
    }
    // The generator does reach the recognised side (a bare command is drawn often), so the assertions above are not vacuous.
    expect(recognised).toBeGreaterThan(50);
  });

  it('flips to false when any single character outside the whitelist is added to a recognised line (every YES line, every other ASCII character)', () => {
    const outside: string[] = [];
    for (let code = 1; code < 128; code++) {
      const c = String.fromCharCode(code);
      if (!/^[A-Za-z0-9\-_./:=,@+ ]$/.test(c)) {
        outside.push(c);
      }
    }
    expect(outside.length).toBeGreaterThan(50);
    for (const [shell, command] of YES) {
      for (const c of outside) {
        expect(classifyReadOnly(shell, `${command}${c}`)).toEqual({ readOnly: false });
        expect(classifyReadOnly(shell, `${command} ${c}`)).toEqual({ readOnly: false });
        expect(classifyReadOnly(shell, `${c}${command}`)).toEqual({ readOnly: false });
        expect(classifyReadOnly(shell, `${command.slice(0, 1)}${c}${command.slice(1)}`)).toEqual({ readOnly: false });
      }
    }
  });

  it('every YES line is refused with one extra option that exists in no table', () => {
    for (const [shell, command] of YES) {
      expect(classifyReadOnly(shell, `${command} --definitely-not-an-option`)).toEqual({ readOnly: false });
      expect(classifyReadOnly(shell, `${command} -Z`)).toEqual({ readOnly: false });
    }
  });
});
