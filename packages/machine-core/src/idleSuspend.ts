import { InstallError } from './install.js';

// `machine install idle-suspend` (idle-suspend.md): a root systemd timer that suspends the box when it is REALLY idle, whatever the state of the
// desktop sessions. Pure: no file, no process. `idleDecision` is the specification of the decision; `idleSuspendScript` generates the shell that
// takes the same decision on the box (the golden test in machine-cli runs the script on fake inputs and compares it with `idleDecision`).

/** Lower bound of --minutes and --rdp-minutes (decision 106). The timer fires every 2 min, so a value below 2 acts at the first check after it is reached. */
export const IDLE_MIN_MINUTES = 1;
export const IDLE_MAX_MINUTES = 1440;
export const IDLE_DEFAULT_MINUTES = 30;
/** The timer fires every 2 minutes. */
export const IDLE_CHECK_SECONDS = 120;
/** Longer than this since the last check: the box slept or was off (or the timer stopped), the idle timer restarts from zero. */
export const IDLE_GAP_SECONDS = 300;
/** The 5-minute load average (hundredths) from which the box is busy. */
export const IDLE_LOAD_LIMIT_HUNDREDTHS = 30;
/** A `held` audit entry without its `hold-ended` counts as an open hold for this long (the longest wait of a hold is 1 h). */
export const IDLE_HOLD_STALE_SECONDS = 7200;
/** The lines of the audit log read at each check. */
export const IDLE_AUDIT_TAIL_LINES = 2000;
export const IDLE_RDP_PORT = 3389;
export const IDLE_SSH_PORT = 22;
export const IDLE_STATE_DIR = '/run/machine-idle-suspend';
export const IDLE_STATE_FILE = `${IDLE_STATE_DIR}/since`;
export const IDLE_KEEP_AWAKE_RUN = '/run/machine-keep-awake';
export const IDLE_SUSPEND_VERSION = 7;
/** `--rdp-minutes` default: the input idle time from which an established RDP connection no longer counts as activity (decision 103). */
export const IDLE_RDP_DEFAULT_MINUTES = 20;
/** `--ssh-minutes` default: the input idle time of the TTY of an ssh session from which it no longer counts as activity (decision 111). */
export const IDLE_SSH_DEFAULT_MINUTES = 20;
/**
 * Decision 111: a notty ssh connection (scp, rsync, `ssh host cmd`, the Herdr stream) is activity when the average rate of its TCP connection (bytes_acked +
 * bytes_received of `ss -tin`, sent + received combined) between two checks is at or above this many bytes per second. Measured idle Herdr baseline: 190 to 230 B/s.
 */
export const IDLE_SSH_NOTTY_BYTES_PER_SECOND = 2048;
/** The file of the previous samples (one line per notty connection: `<local> <peer> <epoch> <bytes>`); NOT cleared with the timer state. */
export const IDLE_SSH_SAMPLES_FILE = `${IDLE_STATE_DIR}/ssh-samples`;
/** The causes of an unknown rate, shared by the script and the tests. */
export const IDLE_SSH_RATE_UNKNOWN = {
  first: 'first check of this connection (no previous sample)',
  stale: `previous sample older than ${IDLE_GAP_SECONDS} s`,
  down: 'byte counter went down (a new connection on the same address)',
  clock: 'the clock did not advance since the previous sample',
  previous: 'previous sample unreadable',
  counters: 'bytes_acked or bytes_received missing or not a number in ss -tin',
} as const;
/** Where the script looks for the tools of the RDP input check when `command -v` found none at install time (the Debian/Ubuntu places). */
export const IDLE_DEFAULT_XPRINTIDLE = '/usr/bin/xprintidle';
export const IDLE_DEFAULT_RUNUSER = '/usr/sbin/runuser';
export const IDLE_DEFAULT_LOGINCTL = '/usr/bin/loginctl';
export const IDLE_X11_SOCKET_DIR = '/tmp/.X11-unix';
export const IDLE_SUSPEND_SCRIPT_PATH = '/usr/local/bin/machine-idle-suspend';
export const IDLE_SUSPEND_SERVICE_PATH = '/etc/systemd/system/machine-idle-suspend.service';
export const IDLE_SUSPEND_TIMER_PATH = '/etc/systemd/system/machine-idle-suspend.timer';
export const IDLE_SUSPEND_TIMER_UNIT = 'machine-idle-suspend.timer';
/** The tag of the journal lines: `journalctl -t machine-idle-suspend`. */
export const IDLE_LOG_TAG = 'machine-idle-suspend';

/** One ssh connection of the box (decision 111): `peer` is its remote address:port as ss prints it. */
export type IdleSshConnection =
  | { peer: string; kind: 'pts'; tty: string; idleSeconds: number }
  | { peer: string; kind: 'notty'; rate: number | { unknown: string } };

/** What was read from the box. `null` anywhere means "could not be read": the decision is then NOT idle (fail closed). */
export interface IdleFacts {
  /** One entry per keep-awake file (the run file, the owner's file). `untilEpoch` null: no valid "until": keeps the box awake without end. */
  keepAwake: Array<{ present: false } | { present: true; untilEpoch: number | null }> | null;
  /** ESTABLISHED TCP connections whose LOCAL port is the RDP port, the ssh port, the machine peer port. */
  connections: { rdp: number; ssh: number; peer: number } | null;
  /**
   * Decision 111: every ssh connection of the box (local port 22, in the order of `ss`), classified from the title of its sshd login process: `pts` (a terminal
   * login: the seconds since the last input on its tty, atime of /dev/pts/N; its traffic is ignored) or `notty` (no terminal: the rate in whole B/s over the
   * last two checks, or `{ unknown }` when it cannot be computed: first sight, stale or unusable sample, counter reset: activity, fail closed). `{ unreadable }`:
   * the connections, a login mapping or one idle time could not be read (the cause goes to the journal, ssh then counts as activity: fail closed).
   * Read only when `connections.ssh > 0`; ignored otherwise.
   */
  sshConnections: IdleSshConnection[] | { unreadable: string };
  /** Epoch of the last accepted/completed/held entry of the audit log (null: none in the part read), and the holds without an end. */
  audit: { lastActivityEpoch: number | null; openHolds: number } | null;
  load5Hundredths: number | null;
  /** Inhibitors that block sleep. */
  inhibitors: number | null;
  /** The state file: absent, `{since, last}`, or null when it exists but cannot be used. */
  state: { since: number; last: number } | 'absent' | null;
  /**
   * Seconds since the last X input, the MINIMUM over the X displays; `'missing'`: xprintidle is not installed; `{ unreadable }`: it could not be read
   * (the cause goes to the journal). With an RDP connection both count as activity (fail closed); without one the timer rule alone applies, said in the journal.
   */
  inputIdleSeconds: number | 'missing' | 'no-session' | { unreadable: string };
  /**
   * Decision 105: the input idle time is measured per user SESSION (loginctl: Class=user, State active or online, a Display), not per X socket.
   * The numbers of the X sockets with NO such session (the login greeter...): ignored on purpose and said in the line. Read only with a numeric input.
   * `'no-session'`: loginctl lists no such session.
   */
  ignoredDisplays: number[];
}

export interface IdleDecision {
  suspend: boolean;
  /** The line written to the journal. */
  reason: string;
  /** The state file to leave: null removes it. */
  state: { since: number; last: number } | null;
}

/** The reasons after `not idle: `; the generated script uses the same texts. */
export const IDLE_REASON = {
  keepAwakeUnreadable: 'cannot read the keep-awake files',
  keepAwake: 'keep-awake requested',
  connectionsUnreadable: 'cannot read the connections (ss or the daemon port file)',
  rdp: 'rdp connected',
  rdpNoSession: 'rdp connected but no user session found',
  rdpXprintidleMissing: 'rdp connected (xprintidle is not installed: sudo apt install xprintidle)',
  ssh: 'ssh connected',
  sshSession: 'ssh session',
  sshConnection: 'ssh connection',
  peer: 'machine peer connected',
  auditUnreadable: 'cannot read the machine audit log',
  hold: 'machine request on hold',
  loadUnreadable: 'cannot read the load average',
  inhibitorsUnreadable: 'cannot list the sleep inhibitors',
  inhibitor: 'sleep inhibitor held (block)',
} as const;

const RESTART = {
  unreadable: ' (timer restarted: the state file is unreadable)',
  clock: ' (timer restarted: the clock went back)',
  gap: ' (timer restarted: no check for more than 5 min, the box slept or was off)',
} as const;

const hundredths = (h: number): string => `${Math.floor(h / 100)}.${String(h % 100).padStart(2, '0')}`;

/** `--rdp-minutes` as typed: whole decimal digits, 1 to 1440 (decisions 103, 106). */
export function parseIdleRdpMinutes(text: string): number {
  const n = /^(0|[1-9][0-9]{0,3})$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(n) || n < IDLE_MIN_MINUTES || n > IDLE_MAX_MINUTES) {
    throw new InstallError(`--rdp-minutes must be a whole number of minutes from ${IDLE_MIN_MINUTES} to ${IDLE_MAX_MINUTES} (default ${IDLE_RDP_DEFAULT_MINUTES}), got ${JSON.stringify(text.slice(0, 20))}: for example \`machine install idle-suspend --rdp-minutes 20\``);
  }
  return n;
}

/** `--ssh-minutes` as typed: whole decimal digits, 1 to 1440 (decisions 109, 111). */
export function parseIdleSshMinutes(text: string): number {
  const n = /^(0|[1-9][0-9]{0,3})$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(n) || n < IDLE_MIN_MINUTES || n > IDLE_MAX_MINUTES) {
    throw new InstallError(`--ssh-minutes must be a whole number of minutes from ${IDLE_MIN_MINUTES} to ${IDLE_MAX_MINUTES} (default ${IDLE_SSH_DEFAULT_MINUTES}), got ${JSON.stringify(text.slice(0, 20))}: for example \`machine install idle-suspend --ssh-minutes 20\``);
  }
  return n;
}

/** `--minutes` as typed: whole decimal digits, 1 to 1440. */
export function parseIdleMinutes(text: string): number {
  const n = /^(0|[1-9][0-9]{0,3})$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(n) || n < IDLE_MIN_MINUTES || n > IDLE_MAX_MINUTES) {
    throw new InstallError(`--minutes must be a whole number of minutes from ${IDLE_MIN_MINUTES} to ${IDLE_MAX_MINUTES} (default ${IDLE_DEFAULT_MINUTES}), got ${JSON.stringify(text.slice(0, 20))}: for example \`machine install idle-suspend --minutes 30\``);
  }
  return n;
}

function checkMinutes(minutes: number): void {
  if (!Number.isInteger(minutes) || minutes < IDLE_MIN_MINUTES || minutes > IDLE_MAX_MINUTES) {
    throw new InstallError(`minutes must be a whole number from ${IDLE_MIN_MINUTES} to ${IDLE_MAX_MINUTES}, got ${String(minutes)}`);
  }
}

/** The 5-minute figure of the text of /proc/loadavg in hundredths; null when the text is not what the kernel writes. */
export function parseLoadHundredths(text: string): number | null {
  const field = text.trim().split(/\s+/)[1];
  const m = field === undefined ? null : /^(0|[1-9][0-9]{0,5})\.([0-9]{2})$/.exec(field);
  return m === null ? null : Number(m[1]) * 100 + Number(m[2]);
}

/**
 * THE decision. The checks run in a fixed order and the first that fails names the reason; every unreadable input is "not idle". When all pass the
 * timer runs: it starts at 0, restarts when the clock went back, when the last check is older than IDLE_GAP_SECONDS (the box slept: a wake for a short
 * run must not suspend again at once) or when the state file is unusable, and suspends once `minutes` whole minutes have passed.
 */
export function idleDecision(facts: IdleFacts, now: number, minutes: number, rdpMinutes: number = IDLE_RDP_DEFAULT_MINUTES, sshMinutes: number = IDLE_SSH_DEFAULT_MINUTES): IdleDecision {
  checkMinutes(minutes);
  checkMinutes(rdpMinutes);
  checkMinutes(sshMinutes);
  if (!Number.isInteger(now) || now < 0) {
    throw new InstallError(`the clock must be a whole number of seconds since 1970, got ${String(now)}`);
  }
  const notIdle = (reason: string): IdleDecision => ({ suspend: false, reason: `not idle: ${reason}`, state: null });
  if (facts.keepAwake === null) {
    return notIdle(IDLE_REASON.keepAwakeUnreadable);
  }
  if (facts.keepAwake.some((f) => f.present && (f.untilEpoch === null || f.untilEpoch > now))) {
    return notIdle(IDLE_REASON.keepAwake);
  }
  const c = facts.connections;
  if (c === null) {
    return notIdle(IDLE_REASON.connectionsUnreadable);
  }
  const input = facts.inputIdleSeconds;
  if (typeof input === 'number' && (!Number.isInteger(input) || input < 0)) {
    throw new InstallError(`the input idle time must be a whole number of seconds, got ${String(input)}`);
  }
  // The displays ignored for lack of a user session are said only next to a measured input idle time.
  const ignoredList = facts.ignoredDisplays.map((n) => `:${n}`).join(', ');
  const ignored = typeof input === 'number' && facts.ignoredDisplays.length > 0 ? ` (ignored display${facts.ignoredDisplays.length > 1 ? 's' : ''} ${ignoredList}: no user session)` : '';
  // Decision 103. With an RDP connection the input idle time is the clock (it must reach R minutes); without one it must reach N minutes when it can be read.
  const rdpMode = c.rdp > 0;
  if (rdpMode) {
    if (input === 'missing') {
      return notIdle(IDLE_REASON.rdpXprintidleMissing);
    }
    if (input === 'no-session') {
      return notIdle(IDLE_REASON.rdpNoSession);
    }
    if (typeof input === 'object') {
      return notIdle(`${IDLE_REASON.rdp} (input idle unreadable: ${input.unreadable})`);
    }
    if (input < rdpMinutes * 60) {
      return notIdle(`${IDLE_REASON.rdp} (input ${Math.floor(input / 60)} min ago, needs ${rdpMinutes})${ignored}`);
    }
  }
  // Decision 111: EVERY ssh connection is tested. A pts login is activity while its tty input idle time is below S min (its traffic is ignored); a notty login
  // is activity when its rate is at or above the threshold or unknown. The state of the ssh rule is said on the timer lines.
  let sshNote = '';
  if (c.ssh > 0) {
    const conns = facts.sshConnections;
    if (!Array.isArray(conns)) {
      return notIdle(`${IDLE_REASON.ssh} (cannot read the ssh state: ${conns.unreadable})`);
    }
    let freshest: { tty: string; idleSeconds: number } | undefined;
    for (const x of conns) {
      if (x.kind === 'pts') {
        if (!Number.isInteger(x.idleSeconds) || x.idleSeconds < 0) {
          throw new InstallError(`the ssh tty idle time must be a whole number of seconds, got ${String(x.idleSeconds)}`);
        }
        if (freshest === undefined || x.idleSeconds < freshest.idleSeconds) {
          freshest = x;
        }
      } else if (typeof x.rate === 'number' && (!Number.isInteger(x.rate) || x.rate < 0)) {
        throw new InstallError(`the ssh connection rate must be a whole number of bytes per second, got ${String(x.rate)}`);
      }
    }
    if (freshest !== undefined) {
      if (freshest.idleSeconds < sshMinutes * 60) {
        return notIdle(`${IDLE_REASON.sshSession} ${freshest.tty} active (input ${Math.floor(freshest.idleSeconds / 60)} min ago, needs ${sshMinutes})`);
      }
      sshNote = ` (ssh session ${freshest.tty} idle for ${Math.floor(freshest.idleSeconds / 60)} min, needs ${sshMinutes})`;
    }
    for (const x of conns) {
      if (x.kind !== 'notty') {
        continue;
      }
      if (typeof x.rate === 'object') {
        return notIdle(`${IDLE_REASON.sshConnection} ${x.peer} rate unknown (${x.rate.unknown})`);
      }
      if (x.rate >= IDLE_SSH_NOTTY_BYTES_PER_SECOND) {
        return notIdle(`${IDLE_REASON.sshConnection} ${x.peer} active (${x.rate} B/s, needs ${IDLE_SSH_NOTTY_BYTES_PER_SECOND})`);
      }
      sshNote += ` (ssh connection ${x.peer} quiet: ${x.rate} B/s, under ${IDLE_SSH_NOTTY_BYTES_PER_SECOND})`;
    }
  }
  if (c.peer > 0) {
    return notIdle(IDLE_REASON.peer);
  }
  // Without an RDP connection: a readable input must be N minutes old; an unreadable one is said on every timer line (never silent).
  let inputNote = '';
  if (!rdpMode) {
    if (typeof input === 'number') {
      if (input < minutes * 60) {
        return notIdle(`input ${Math.floor(input / 60)} min ago (needs ${minutes})${ignored}`);
      }
    } else {
      inputNote = ` (input idleness not checked: ${input === 'missing' ? 'xprintidle is not installed' : input === 'no-session' ? 'no user session found' : input.unreadable})`;
    }
  }
  const a = facts.audit;
  if (a === null) {
    return notIdle(IDLE_REASON.auditUnreadable);
  }
  if (a.openHolds > 0) {
    return notIdle(IDLE_REASON.hold);
  }
  if (a.lastActivityEpoch !== null && now - a.lastActivityEpoch < minutes * 60) {
    return notIdle(`machine request in the last ${minutes} min`);
  }
  if (facts.load5Hundredths === null) {
    return notIdle(IDLE_REASON.loadUnreadable);
  }
  if (facts.load5Hundredths >= IDLE_LOAD_LIMIT_HUNDREDTHS) {
    return notIdle(`load ${hundredths(facts.load5Hundredths)} (limit ${hundredths(IDLE_LOAD_LIMIT_HUNDREDTHS)})`);
  }
  if (facts.inhibitors === null) {
    return notIdle(IDLE_REASON.inhibitorsUnreadable);
  }
  if (facts.inhibitors > 0) {
    return notIdle(IDLE_REASON.inhibitor);
  }

  // RDP mode: the input idle time is the clock, so there is no timer on top; the state only proves that the other checks passed on the previous check too.
  const rdpIdle = `rdp connected but no input for ${typeof input === 'number' ? Math.floor(input / 60) : 0} min (needs ${rdpMinutes})`;
  const restart = (why: string): IdleDecision => ({
    suspend: false,
    reason: rdpMode ? `idle: ${rdpIdle}, confirming at the next check${why}${ignored}${sshNote}` : `idle 0/${minutes} min${why}${inputNote}${ignored}${sshNote}`,
    state: { since: now, last: now },
  });
  const s = facts.state;
  if (s === 'absent') {
    return restart('');
  }
  if (s === null || s.since > s.last) {
    return restart(RESTART.unreadable);
  }
  if (s.since > now || s.last > now) {
    return restart(RESTART.clock);
  }
  if (now - s.last > IDLE_GAP_SECONDS) {
    return restart(RESTART.gap);
  }
  if (rdpMode) {
    return { suspend: true, reason: `suspending: ${rdpIdle}${ignored}${sshNote}`, state: null };
  }
  const elapsed = Math.floor((now - s.since) / 60);
  if (elapsed >= minutes) {
    return { suspend: true, reason: `suspending: idle ${elapsed} min${inputNote}${ignored}${sshNote}`, state: null };
  }
  return { suspend: false, reason: `idle ${elapsed}/${minutes} min${inputNote}${ignored}${sshNote}`, state: { since: s.since, last: now } };
}

// ---------------------------------------------------------------- the generated script

export interface IdleScriptOptions {
  minutes: number;
  /** The input idle time from which an established RDP connection no longer counts as activity (decision 103). */
  rdpMinutes: number;
  /** The input idle time of an ssh tty from which the session no longer counts as activity (decision 111). */
  sshMinutes: number;
  /** '' in the shipped script. A relative prefix put before EVERY path the script reads or runs: only the golden test sets it. */
  root: string;
  /** The configuration folder of machine of the owner: the audit log, the daemon port file and the keep-awake file are read there. */
  configDir: string;
  /** Absolute paths measured on the box. */
  tools: { date: string; ss: string; systemdInhibit: string; logger: string; systemctl: string; loginctl: string; runuser: string; xprintidle: string };
}

/** Absolute, only `A-Za-z0-9._+-` and `/`, no empty, `.` or `..` segment, no trailing `/`: safe between single quotes in a root-run script. */
export function isSafeAbsolutePath(path: string): boolean {
  return /^(\/[A-Za-z0-9._+-]+)+$/.test(path) && !path.split('/').some((s) => s === '.' || s === '..');
}

const isSafeRoot = (root: string): boolean => root === '' || (/^[A-Za-z0-9._+-]+(\/[A-Za-z0-9._+-]+)*$/.test(root) && !root.split('/').some((s) => s === '.' || s === '..'));

const marker = `# managed by machine install idle-suspend, version ${IDLE_SUSPEND_VERSION}`;

/** The text after the marker of the installed script: the minutes it was generated with, undefined when the text is not this script. */
export function idleSuspendInstalledMinutes(script: string): number | undefined {
  const m = /^MINUTES=([0-9]{1,4})$/m.exec(script);
  const n = m === null ? NaN : Number(m[1]);
  return Number.isInteger(n) && n >= IDLE_MIN_MINUTES && n <= IDLE_MAX_MINUTES ? n : undefined;
}

/** The ssh minutes the installed script was generated with; undefined for a script of an older version (no `SSH_MINUTES=` line). */
export function idleSuspendInstalledSshMinutes(script: string): number | undefined {
  const m = /^SSH_MINUTES=([0-9]{1,4})$/m.exec(script);
  const n = m === null ? NaN : Number(m[1]);
  return Number.isInteger(n) && n >= IDLE_MIN_MINUTES && n <= IDLE_MAX_MINUTES ? n : undefined;
}

/** The RDP minutes the installed script was generated with; undefined for a script of an older version (no `RDP_MINUTES=` line). */
export function idleSuspendInstalledRdpMinutes(script: string): number | undefined {
  const m = /^RDP_MINUTES=([0-9]{1,4})$/m.exec(script);
  const n = m === null ? NaN : Number(m[1]);
  return Number.isInteger(n) && n >= IDLE_MIN_MINUTES && n <= IDLE_MAX_MINUTES ? n : undefined;
}

export function idleSuspendScript(o: IdleScriptOptions): string {
  checkMinutes(o.minutes);
  checkMinutes(o.rdpMinutes);
  checkMinutes(o.sshMinutes);
  if (!isSafeRoot(o.root)) {
    throw new InstallError(`internal: the test root ${JSON.stringify(o.root.slice(0, 40))} is not a safe relative path`);
  }
  if (!isSafeAbsolutePath(o.configDir)) {
    throw new InstallError(`the configuration folder ${JSON.stringify(o.configDir.slice(0, 80))} cannot be written into a root-run script (it must be absolute, with letters, digits and . _ + - / only, no space): run machine with a --config-dir such as /home/<you>/.config/machine`);
  }
  for (const [what, value] of Object.entries(o.tools)) {
    if (!isSafeAbsolutePath(value)) {
      throw new InstallError(`the path of ${what} ${JSON.stringify(value.slice(0, 80))} cannot be written into a root-run script (it must be absolute, with letters, digits and . _ + - / only): check \`command -v\``);
    }
  }
  const t = o.tools;
  const ts = String.raw`\{"seq":[0-9]+,"prev":"[0-9a-f]+","entry":\{"ts":"([^"]*)","event":"`;
  return String.raw`#!/bin/sh
${marker}
# Suspends this box once it has been idle for MINUTES minutes. Run as root by machine-idle-suspend.timer every 2 minutes.
# Generated by "machine install idle-suspend --minutes <n>": do not edit (the next install rewrites it). See idle-suspend.md.
# EVERY input that cannot be read means "not idle": this script never suspends on an error.
ROOT='${o.root}'
MINUTES=${o.minutes}
RDP_MINUTES=${o.rdpMinutes}
SSH_MINUTES=${o.sshMinutes}
DATE='${t.date}'
SS='${t.ss}'
INHIBIT='${t.systemdInhibit}'
LOGGER='${t.logger}'
SYSTEMCTL='${t.systemctl}'
LOGINCTL='${t.loginctl}'
RUNUSER='${t.runuser}'
XPRINTIDLE='${t.xprintidle}'
AUDIT_LOG='${o.configDir}/audit.log'
PORT_FILE='${o.configDir}/daemon.port.json'
KEEP_AWAKE_USER='${o.configDir}/keep-awake'
KEEP_AWAKE_RUN='${IDLE_KEEP_AWAKE_RUN}'
STATE_DIR='${IDLE_STATE_DIR}'
STATE_FILE='${IDLE_STATE_FILE}'

log() {
  printf '%s\n' "$1"
  "$ROOT$LOGGER" -t ${IDLE_LOG_TAG} -- "$1" >/dev/null 2>&1
}
clear_state() { rm -f -- "$ROOT$STATE_FILE"; }
not_idle() { clear_state; log "not idle: $1"; exit 0; }

now=$("$ROOT$DATE" +%s 2>/dev/null)
case $now in ''|*[!0-9]*) log "cannot read the clock (date failed): not suspending"; exit 1 ;; esac

# (a) keep-awake files: any content keeps the box awake; "until <epoch>" (or "keep awake until <epoch>") only until then.
check_keep_awake() {
  [ -e "$ROOT$1" ] || return 0
  content=$(cat -- "$ROOT$1" 2>/dev/null) || not_idle "${IDLE_REASON.keepAwakeUnreadable}"
  until_epoch=$(printf '%s\n' "$content" | sed -n -E '1{s/^[[:space:]]+//;s/[[:space:]]+$//;s/^(keep awake )?until ([0-9]{1,12})$/\2/p;}')
  if [ -n "$until_epoch" ] && [ "$until_epoch" -le "$now" ]; then return 0; fi
  not_idle "${IDLE_REASON.keepAwake}"
}
check_keep_awake "$KEEP_AWAKE_RUN"
check_keep_awake "$KEEP_AWAKE_USER"

# (b) established connections to RDP, ssh and the machine peer port (read from the daemon port file).
peer_port=''
if [ -e "$ROOT$PORT_FILE" ]; then
  port_json=$(cat -- "$ROOT$PORT_FILE" 2>/dev/null) || not_idle "${IDLE_REASON.connectionsUnreadable}"
  peer_port=$(printf '%s\n' "$port_json" | sed -n -E 's/.*"peerPort"[[:space:]]*:[[:space:]]*([0-9]{1,5}).*/\1/p' | head -n 1)
  [ -n "$peer_port" ] || not_idle "${IDLE_REASON.connectionsUnreadable}"
fi
sockets=$("$ROOT$SS" -Htn state established 2>/dev/null) || not_idle "${IDLE_REASON.connectionsUnreadable}"
rdp=0
ssh=0
peer=0
while read -r c1 c2 c3 c4 rest; do
  case $c1 in ESTAB|estab) local_addr=$c4 ;; *) local_addr=$c3 ;; esac
  port=$(printf '%s\n' "$local_addr" | sed 's/.*://')
  [ "$port" = ${IDLE_RDP_PORT} ] && rdp=$((rdp + 1))
  [ "$port" = ${IDLE_SSH_PORT} ] && ssh=$((ssh + 1))
  if [ -n "$peer_port" ] && [ "$port" = "$peer_port" ]; then peer=$((peer + 1)); fi
done <<EOF
$sockets
EOF
# (b1) Decision 111: EVERY ssh connection is tested. It is read here, before any later check can exit, so the samples of the notty connections are kept at every run
# (they are NOT cleared with the timer state). ss -Htinp prints, per connection, a line with the Process column (every pid of the login: the [priv] parent AND the
# user process) and, tab-indented, the counters. The title of each pid (/proc/<pid>/cmdline, set by sshd) ending in @pts/<n> is a terminal login: activity while the input
# idle time of its tty (atime of /dev/pts/<n>, what w and logind read) is below SSH_MINUTES, its traffic is ignored. A title ending in @notty (scp, rsync, ssh host cmd,
# herdr) is activity when the average rate of its TCP connection since the previous run (bytes_acked + bytes_received, samples file) is at least THRESHOLD B/s, or unknown
# (first sight, sample older than 5 min, counter went down, counters unreadable). Anything unreadable (no login title for the connection, a tty that is not pts/<n>,
# no stat, an atime in the future, no ss, no samples file to write) is activity, with the cause. /dev/pts is never listed (a stale pts has no sshd process).
THRESHOLD=${IDLE_SSH_NOTTY_BYTES_PER_SECOND}
SSH_SAMPLES='${IDLE_SSH_SAMPLES_FILE}'
ssh_fail=''
ssh_pts_secs=''
ssh_pts_tty=''
ssh_block=''
ssh_quiet_note=''
ssh_new_samples=''
ssh_old=''
ssh_cur_open=0
ssh_cur_local=''
ssh_cur_peer=''
ssh_cur_proc=''
ssh_cur_info=''
ssh_fail_set() { [ -n "$ssh_fail" ] || ssh_fail="$1"; }
ssh_unknown() { [ -n "$ssh_block" ] || ssh_block="${IDLE_REASON.sshConnection} $c_peer rate unknown ($1)"; }
ssh_notty() {
  c_acked=$(printf '%s\n' "$c_info" | grep -Eo '(^|[[:space:]])bytes_acked:[^[:space:]]*' | head -n 1 | sed 's/.*://')
  c_recv=$(printf '%s\n' "$c_info" | grep -Eo '(^|[[:space:]])bytes_received:[^[:space:]]*' | head -n 1 | sed 's/.*://')
  printf '%s\n' "$c_acked" | grep -Eq '^(0|[1-9][0-9]{0,17})$' || { ssh_unknown "${IDLE_SSH_RATE_UNKNOWN.counters}"; return 0; }
  printf '%s\n' "$c_recv" | grep -Eq '^(0|[1-9][0-9]{0,17})$' || { ssh_unknown "${IDLE_SSH_RATE_UNKNOWN.counters}"; return 0; }
  c_total=$((c_acked + c_recv))
  ssh_new_samples="$ssh_new_samples$c_local $c_peer $now $c_total
"
  prev_epoch=''
  prev_total=''
  while read -r o_local o_peer o_epoch o_total o_rest; do
    if [ "$o_local" = "$c_local" ] && [ "$o_peer" = "$c_peer" ]; then prev_epoch=$o_epoch; prev_total=$o_total; break; fi
  done <<EOF
$ssh_old
EOF
  [ -n "$prev_epoch" ] || { ssh_unknown "${IDLE_SSH_RATE_UNKNOWN.first}"; return 0; }
  printf '%s\n' "$prev_epoch" | grep -Eq '^(0|[1-9][0-9]{0,11})$' && printf '%s\n' "$prev_total" | grep -Eq '^(0|[1-9][0-9]{0,17})$' || { ssh_unknown "${IDLE_SSH_RATE_UNKNOWN.previous}"; return 0; }
  c_dt=$((now - prev_epoch))
  [ "$c_dt" -gt 0 ] || { ssh_unknown "${IDLE_SSH_RATE_UNKNOWN.clock}"; return 0; }
  [ "$c_dt" -le ${IDLE_GAP_SECONDS} ] || { ssh_unknown "${IDLE_SSH_RATE_UNKNOWN.stale}"; return 0; }
  [ "$c_total" -ge "$prev_total" ] || { ssh_unknown "${IDLE_SSH_RATE_UNKNOWN.down}"; return 0; }
  c_rate=$(( (c_total - prev_total) / c_dt ))
  if [ "$c_rate" -ge "$THRESHOLD" ]; then
    [ -n "$ssh_block" ] || ssh_block="${IDLE_REASON.sshConnection} $c_peer active ($c_rate B/s, needs $THRESHOLD)"
  else
    ssh_quiet_note="$ssh_quiet_note (ssh connection $c_peer quiet: $c_rate B/s, under $THRESHOLD)"
  fi
}
ssh_conn() {
  c_local=$1
  c_peer=$2
  c_proc=$3
  c_info=$4
  c_kind=''
  c_login_pid=''
  for c_pid in $(printf '%s\n' "$c_proc" | grep -Eo 'pid=[0-9]{1,8}' | sed 's/^pid=//'); do
    c_file="$ROOT/proc/$c_pid/cmdline"
    [ -e "$c_file" ] || continue
    c_title=$(tr -d '\000' <"$c_file" 2>/dev/null) || continue
    c_tty=$(printf '%s\n' "$c_title" | sed -n -E 's/^sshd(-session)?: [^ ]+@(.*)$/\2/p')
    [ -n "$c_tty" ] || continue
    c_kind=$c_tty
    c_login_pid=$c_pid
    break
  done
  if [ -z "$c_kind" ]; then ssh_fail_set "no sshd login process (title sshd-session: <user>@<tty>) found for the ssh connection $c_peer"; return 0; fi
  if [ "$c_kind" = notty ]; then ssh_notty; return 0; fi
  printf '%s\n' "$c_kind" | grep -Eq '^pts/[0-9]{1,6}$' || { ssh_fail_set "an sshd login process has an unexpected tty in its title ($c_login_pid)"; return 0; }
  c_atime=$(stat -c %X -- "$ROOT/dev/$c_kind" 2>/dev/null) || { ssh_fail_set "cannot read the idle time of $c_kind (stat /dev/$c_kind failed)"; return 0; }
  printf '%s\n' "$c_atime" | grep -Eq '^[0-9]{1,12}$' || { ssh_fail_set "stat printed no number for /dev/$c_kind"; return 0; }
  [ "$c_atime" -le "$now" ] || { ssh_fail_set "the last input of $c_kind is in the future (clock or tty error)"; return 0; }
  c_secs=$((now - c_atime))
  if [ -z "$ssh_pts_tty" ] || [ "$c_secs" -lt "$ssh_pts_secs" ]; then ssh_pts_secs=$c_secs; ssh_pts_tty=$c_kind; fi
}
ssh_flush() {
  [ "$ssh_cur_open" -eq 1 ] || return 0
  ssh_cur_open=0
  printf '%s\n' "$ssh_cur_local" | grep -Eqx '[][0-9A-Za-z:.%_-]+' && printf '%s\n' "$ssh_cur_peer" | grep -Eqx '[][0-9A-Za-z:.%_-]+' || { ssh_fail_set "cannot parse an address of the ssh connections printed by ss"; return 0; }
  ssh_conn "$ssh_cur_local" "$ssh_cur_peer" "$ssh_cur_proc" "$ssh_cur_info"
}
read_ssh() {
  ssh_listing=$("$ROOT$SS" -Htinp state established '( sport = :${IDLE_SSH_PORT} )' 2>/dev/null </dev/null) || { ssh_fail_set "cannot list the ssh connections ($SS -tinp failed)"; return 0; }
  if [ -e "$ROOT$SSH_SAMPLES" ]; then ssh_old=$(cat -- "$ROOT$SSH_SAMPLES" 2>/dev/null) || { ssh_fail_set "cannot read $SSH_SAMPLES"; ssh_old=''; }; fi
  while IFS= read -r ssh_line; do
    ssh_trim=$(printf '%s\n' "$ssh_line" | sed 's/^[[:space:]]*//')
    case $ssh_trim in
      '') continue ;;
      ESTAB*|estab*|[0-9]*) ;;
      *) ssh_cur_info="$ssh_cur_info $ssh_trim"; continue ;;
    esac
    ssh_flush
    read -r c1 c2 c3 c4 c5 c6 <<EOT
$ssh_trim
EOT
    case $c1 in ESTAB|estab) ssh_cur_local=$c4; ssh_cur_peer=$c5; ssh_cur_proc=$c6 ;; *) ssh_cur_local=$c3; ssh_cur_peer=$c4; ssh_cur_proc=$c5 ;; esac
    ssh_cur_info=''
    ssh_cur_open=1
  done <<EOF
$ssh_listing
EOF
  ssh_flush
  if mkdir -p -- "$ROOT$STATE_DIR" 2>/dev/null && { printf '%s' "$ssh_new_samples" > "$ROOT$SSH_SAMPLES"; } 2>/dev/null; then :; else ssh_fail_set "cannot write $SSH_SAMPLES"; fi
}
# Without an ssh connection the samples are dropped (a vanished connection leaves no entry).
if [ "$ssh" -gt 0 ]; then read_ssh; else rm -f -- "$ROOT$SSH_SAMPLES"; fi
# (b2) the input idle time (xprintidle, ms), measured per logind SESSION (decision 105): the minimum over the user sessions that have an X display, each read as its user.
# input_kind: num (input_secs), missing (no xprintidle), nosession (no such session), bad (input_cause). ignored_text names the X sockets that no such session uses.
input_kind=num
input_secs=''
input_cause=''
ignored_text=''
input_bad() { input_kind=bad; input_cause="$1"; }
read_input() {
  [ -x "$ROOT$XPRINTIDLE" ] || { input_kind=missing; return 0; }
  [ -x "$ROOT$LOGINCTL" ] || { input_bad "loginctl is not installed ($LOGINCTL)"; return 0; }
  [ -x "$ROOT$RUNUSER" ] || { input_bad "runuser is not installed ($RUNUSER)"; return 0; }
  session_list=$("$ROOT$LOGINCTL" list-sessions --no-legend 2>/dev/null </dev/null) || { input_bad "loginctl list-sessions failed"; return 0; }
  min_idle=''
  measured=' '
  while read -r sid rest; do
    [ -n "$sid" ] || continue
    printf '%s\n' "$sid" | grep -Eq '^[A-Za-z0-9]{1,16}$' || { input_bad "loginctl printed an unexpected session id"; return 0; }
    props=$("$ROOT$LOGINCTL" show-session "$sid" -p Name -p Type -p Display -p Class -p State 2>/dev/null </dev/null) || { input_bad "loginctl show-session $sid failed"; return 0; }
    s_class=$(printf '%s\n' "$props" | sed -n 's/^Class=//p' | head -n 1)
    s_state=$(printf '%s\n' "$props" | sed -n 's/^State=//p' | head -n 1)
    s_display=$(printf '%s\n' "$props" | sed -n 's/^Display=//p' | head -n 1)
    s_name=$(printf '%s\n' "$props" | sed -n 's/^Name=//p' | head -n 1)
    [ "$s_class" = user ] || continue
    case $s_state in active|online) ;; *) continue ;; esac
    [ -n "$s_display" ] || continue
    printf '%s\n' "$s_name" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$' || { input_bad "the name of session $sid is not a plain user name"; return 0; }
    printf '%s\n' "$s_display" | grep -Eq '^:[0-9]{1,4}$' || { input_bad "session $sid has an unexpected display"; return 0; }
    num=$(printf '%s\n' "$s_display" | sed 's/^://')
    home=$(sed -n -E 's/^'"$s_name"':[^:]*:[0-9]*:[0-9]*:[^:]*:([^:]*):.*/\1/p' "$ROOT/etc/passwd" 2>/dev/null | head -n 1)
    printf '%s\n' "$home" | grep -Eq '^(/[A-Za-z0-9._+-]+)+$' || { input_bad "no usable home folder for $s_name in /etc/passwd"; return 0; }
    out=$(DISPLAY=":$num" XAUTHORITY="$home/.Xauthority" "$ROOT$RUNUSER" -u "$s_name" -- "$ROOT$XPRINTIDLE" 2>/dev/null </dev/null) || { input_bad "xprintidle failed on :$num as $s_name"; return 0; }
    printf '%s\n' "$out" | grep -Eq '^[0-9]{1,15}$' || { input_bad "xprintidle printed no number on :$num"; return 0; }
    secs=$((out / 1000))
    if [ -z "$min_idle" ] || [ "$secs" -lt "$min_idle" ]; then min_idle=$secs; fi
    measured="$measured$num "
  done <<EOF
$session_list
EOF
  [ -n "$min_idle" ] || { input_kind=nosession; return 0; }
  input_secs=$min_idle
  # The X sockets that no measured session uses (the login greeter...) are ignored on purpose, and said.
  ignored_list=''
  ignored_count=0
  for sock in "$ROOT${IDLE_X11_SOCKET_DIR}"/X*; do
    [ -e "$sock" ] || continue
    num=$(printf '%s\n' "$sock" | sed 's/.*\/X//')
    printf '%s\n' "$num" | grep -Eq '^[0-9]{1,4}$' || continue
    case $measured in *" $num "*) continue ;; esac
    if [ -z "$ignored_list" ]; then ignored_list=":$num"; else ignored_list="$ignored_list, :$num"; fi
    ignored_count=$((ignored_count + 1))
  done
  if [ "$ignored_count" -eq 1 ]; then ignored_text=" (ignored display $ignored_list: no user session)"; fi
  if [ "$ignored_count" -gt 1 ]; then ignored_text=" (ignored displays $ignored_list: no user session)"; fi
}
read_input
# With an RDP connection the input idle time is the clock: activity until it reaches RDP_MINUTES, and no timer on top (decision 103).
rdp_mode=0
if [ "$rdp" -gt 0 ]; then
  rdp_mode=1
  [ "$input_kind" != missing ] || not_idle "${IDLE_REASON.rdpXprintidleMissing}"
  [ "$input_kind" != nosession ] || not_idle "${IDLE_REASON.rdpNoSession}"
  [ "$input_kind" != bad ] || not_idle "${IDLE_REASON.rdp} (input idle unreadable: $input_cause)"
  if [ "$input_secs" -lt $((RDP_MINUTES * 60)) ]; then not_idle "${IDLE_REASON.rdp} (input $((input_secs / 60)) min ago, needs $RDP_MINUTES)$ignored_text"; fi
fi
# Decision 111 verdict (the connections were read in (b1)): unreadable is activity, then a pts login with recent input, then a notty connection that is busy or whose rate is unknown.
ssh_note=''
if [ "$ssh" -gt 0 ]; then
  [ -z "$ssh_fail" ] || not_idle "${IDLE_REASON.ssh} (cannot read the ssh state: $ssh_fail)"
  if [ -n "$ssh_pts_tty" ]; then
    if [ "$ssh_pts_secs" -lt $((SSH_MINUTES * 60)) ]; then
      not_idle "${IDLE_REASON.sshSession} $ssh_pts_tty active (input $((ssh_pts_secs / 60)) min ago, needs $SSH_MINUTES)"
    fi
    ssh_note=" (ssh session $ssh_pts_tty idle for $((ssh_pts_secs / 60)) min, needs $SSH_MINUTES)"
  fi
  [ -z "$ssh_block" ] || not_idle "$ssh_block"
  ssh_note="$ssh_note$ssh_quiet_note"
fi
[ "$peer" -eq 0 ] || not_idle "${IDLE_REASON.peer}"
# Without an RDP connection: a readable input must be MINUTES old; an unreadable one is said on every timer line.
input_note=''
if [ "$rdp_mode" -eq 0 ]; then
  case $input_kind in
    num) if [ "$input_secs" -lt $((MINUTES * 60)) ]; then not_idle "input $((input_secs / 60)) min ago (needs $MINUTES)$ignored_text"; fi ;;
    missing) input_note=' (input idleness not checked: xprintidle is not installed)' ;;
    nosession) input_note=' (input idleness not checked: no user session found)' ;;
    *) input_note=" (input idleness not checked: $input_cause)" ;;
  esac
fi

# (c) the machine audit log: a request accepted, completed or held in the last MINUTES minutes, or a hold still open.
epoch_of() {
  printf '%s\n' "$1" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$' || not_idle "${IDLE_REASON.auditUnreadable}"
  EPOCH=$("$ROOT$DATE" -u -d "$1" +%s 2>/dev/null)
  case $EPOCH in ''|*[!0-9]*) not_idle "${IDLE_REASON.auditUnreadable}" ;; esac
}
audit_tail=$(tail -n ${IDLE_AUDIT_TAIL_LINES} -- "$ROOT$AUDIT_LOG" 2>/dev/null) || not_idle "${IDLE_REASON.auditUnreadable}"
last_ts=$(printf '%s\n' "$audit_tail" | sed -n -E 's/^${ts}(accepted|completed|held)".*$/\1/p' | tail -n 1)
last_activity=''
if [ -n "$last_ts" ]; then
  epoch_of "$last_ts"
  last_activity=$EPOCH
fi
held=$(printf '%s\n' "$audit_tail" | sed -n -E 's/^${ts}held","source":"[^"]*","id":"([^"]+)".*$/\1 \2/p' | tail -n 50)
ended=$(printf '%s\n' "$audit_tail" | sed -n -E 's/^\{"seq":[0-9]+,"prev":"[0-9a-f]+","entry":\{"ts":"[^"]*","event":"hold-ended","source":"[^"]*","id":"([^"]+)".*$/\1/p')
open_holds=0
if [ -n "$held" ]; then
  while read -r held_ts held_id; do
    epoch_of "$held_ts"
    [ $((now - EPOCH)) -le ${IDLE_HOLD_STALE_SECONDS} ] || continue
    if printf '%s\n' "$ended" | grep -Fxq -- "$held_id"; then continue; fi
    open_holds=$((open_holds + 1))
  done <<EOF
$held
EOF
fi
[ "$open_holds" -eq 0 ] || not_idle "${IDLE_REASON.hold}"
if [ -n "$last_activity" ] && [ $((now - last_activity)) -lt $((MINUTES * 60)) ]; then
  not_idle "machine request in the last $MINUTES min"
fi

# (d) the 5-minute load average.
loadavg=$(cat -- "$ROOT/proc/loadavg" 2>/dev/null) || not_idle "${IDLE_REASON.loadUnreadable}"
read -r l1 l5 l15 rest <<EOF
$loadavg
EOF
printf '%s\n' "$l5" | grep -Eq '^(0|[1-9][0-9]{0,5})\.[0-9]{2}$' || not_idle "${IDLE_REASON.loadUnreadable}"
IFS=. read -r load_int load_frac <<EOF
$l5
EOF
load_frac=$(printf '%s' "$load_frac" | sed 's/^0//')
load=$((load_int * 100 + load_frac))
if [ "$load" -ge ${IDLE_LOAD_LIMIT_HUNDREDTHS} ]; then
  not_idle "$(printf 'load %d.%02d (limit ${hundredths(IDLE_LOAD_LIMIT_HUNDREDTHS)})' $((load / 100)) $((load % 100)))"
fi

# (e) an inhibitor in block mode that covers sleep.
inhibitors=$("$ROOT$INHIBIT" --list --no-legend --no-pager 2>/dev/null) || not_idle "${IDLE_REASON.inhibitorsUnreadable}"
blocking=$(printf '%s\n' "$inhibitors" | grep -Ec '(^|[^[:alnum:]_-])sleep([^[:alnum:]_-]|$).*[[:space:]]block[[:space:]]*$')
[ "$blocking" = 0 ] || not_idle "${IDLE_REASON.inhibitor}"

# Idle now: the timer. The state file holds "<since> <last check>" in epoch seconds.
mkdir -p -- "$ROOT$STATE_DIR" 2>/dev/null || { log "cannot create $STATE_DIR: not suspending"; exit 1; }
state=none
state_since=''
state_last=''
if [ -e "$ROOT$STATE_FILE" ]; then
  state=bad
  if state_text=$(cat -- "$ROOT$STATE_FILE" 2>/dev/null); then
    if printf '%s\n' "$state_text" | grep -Eq '^[0-9]{1,12} [0-9]{1,12}$'; then
      read -r state_since state_last <<EOF
$state_text
EOF
      if [ "$state_since" -le "$state_last" ]; then state=ok; fi
    fi
  fi
fi
write_state() {
  printf '%s %s\n' "$1" "$now" > "$ROOT$STATE_FILE" 2>/dev/null || { log "cannot write $STATE_FILE: not suspending"; exit 1; }
}
rdp_idle_text="rdp connected but no input for $((input_secs / 60)) min (needs $RDP_MINUTES)"
restart() {
  write_state "$now"
  if [ "$rdp_mode" -eq 1 ]; then log "idle: $rdp_idle_text, confirming at the next check$1$ignored_text$ssh_note"; else log "idle 0/$MINUTES min$1$input_note$ignored_text$ssh_note"; fi
  exit 0
}
case $state in
  none) restart '' ;;
  bad) restart '${RESTART.unreadable}' ;;
esac
if [ "$state_since" -gt "$now" ] || [ "$state_last" -gt "$now" ]; then restart '${RESTART.clock}'; fi
if [ $((now - state_last)) -gt ${IDLE_GAP_SECONDS} ]; then restart '${RESTART.gap}'; fi
suspend_now() {
  clear_state
  log "$1"
  "$ROOT$SYSTEMCTL" --no-block suspend || { log "cannot suspend: systemctl suspend failed"; exit 1; }
  exit 0
}
# RDP mode: the other checks have passed on the previous check too (the state is recent), the input idle time is the clock.
if [ "$rdp_mode" -eq 1 ]; then suspend_now "suspending: $rdp_idle_text$ignored_text$ssh_note"; fi
elapsed=$(( (now - state_since) / 60 ))
if [ "$elapsed" -ge "$MINUTES" ]; then suspend_now "suspending: idle $elapsed min$input_note$ignored_text$ssh_note"; fi
write_state "$state_since"
log "idle $elapsed/$MINUTES min$input_note$ignored_text$ssh_note"
`;
}

export function idleSuspendServiceUnit(): string {
  return [
    marker,
    '# Written by `machine install idle-suspend`; `machine install idle-suspend --remove` removes it.',
    '[Unit]',
    'Description=machine: suspend this box when it has been idle for a while (see /usr/local/bin/machine-idle-suspend)',
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${IDLE_SUSPEND_SCRIPT_PATH}`,
    // The script writes its decision to the journal itself (logger -t).
    'StandardOutput=null',
    'Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    '',
  ].join('\n');
}

export function idleSuspendTimerUnit(): string {
  return [
    marker,
    '# Written by `machine install idle-suspend`; `machine install idle-suspend --remove` removes it.',
    '[Unit]',
    'Description=machine: check every 2 minutes whether this box is idle',
    '',
    '[Timer]',
    'OnBootSec=2min',
    `OnUnitActiveSec=${IDLE_CHECK_SECONDS / 60}min`,
    'AccuracySec=10s',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
}
