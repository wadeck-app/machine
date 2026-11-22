import { InstallError } from './install.js';

// `machine install idle-suspend` (idle-suspend.md): a root systemd timer that suspends the box when it is REALLY idle, whatever the state of the
// desktop sessions. Pure: no file, no process. `idleDecision` is the specification of the decision; `idleSuspendScript` generates the shell that
// takes the same decision on the box (the golden test in machine-cli runs the script on fake inputs and compares it with `idleDecision`).

export const IDLE_MIN_MINUTES = 5;
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
export const IDLE_SUSPEND_VERSION = 2;
/** Where the script looks for the tools of the RDP input check when `command -v` found none at install time (the Debian/Ubuntu places). */
export const IDLE_DEFAULT_XPRINTIDLE = '/usr/bin/xprintidle';
export const IDLE_DEFAULT_RUNUSER = '/usr/sbin/runuser';
export const IDLE_DEFAULT_STAT = '/usr/bin/stat';
export const IDLE_X11_SOCKET_DIR = '/tmp/.X11-unix';
export const IDLE_SUSPEND_SCRIPT_PATH = '/usr/local/bin/machine-idle-suspend';
export const IDLE_SUSPEND_SERVICE_PATH = '/etc/systemd/system/machine-idle-suspend.service';
export const IDLE_SUSPEND_TIMER_PATH = '/etc/systemd/system/machine-idle-suspend.timer';
export const IDLE_SUSPEND_TIMER_UNIT = 'machine-idle-suspend.timer';
/** The tag of the journal lines: `journalctl -t machine-idle-suspend`. */
export const IDLE_LOG_TAG = 'machine-idle-suspend';

/** What was read from the box. `null` anywhere means "could not be read": the decision is then NOT idle (fail closed). */
export interface IdleFacts {
  /** One entry per keep-awake file (the run file, the owner's file). `untilEpoch` null: no valid "until": keeps the box awake without end. */
  keepAwake: Array<{ present: false } | { present: true; untilEpoch: number | null }> | null;
  /** ESTABLISHED TCP connections whose LOCAL port is the RDP port, the ssh port, the machine peer port. */
  connections: { rdp: number; ssh: number; peer: number } | null;
  /** Epoch of the last accepted/completed/held entry of the audit log (null: none in the part read), and the holds without an end. */
  audit: { lastActivityEpoch: number | null; openHolds: number } | null;
  load5Hundredths: number | null;
  /** Inhibitors that block sleep. */
  inhibitors: number | null;
  /** The state file: absent, `{since, last}`, or null when it exists but cannot be used. */
  state: { since: number; last: number } | 'absent' | null;
  /**
   * Only read when `connections.rdp > 0`. Seconds since the last X input, the MINIMUM over the X displays; `'missing'`: xprintidle is not installed;
   * `{ unreadable }`: it could not be read (the cause goes to the journal). Both count as activity (fail closed).
   */
  rdpInputIdleSeconds: number | 'missing' | { unreadable: string };
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
  rdpXprintidleMissing: 'rdp connected (xprintidle is not installed: sudo apt install xprintidle)',
  ssh: 'ssh connected',
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

/** `--minutes` as typed: whole decimal digits, 5 to 1440. */
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
export function idleDecision(facts: IdleFacts, now: number, minutes: number): IdleDecision {
  checkMinutes(minutes);
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
  // An RDP connection is activity only while the X input of the session is recent (decision 102).
  let rdpNote = '';
  if (c.rdp > 0) {
    const input = facts.rdpInputIdleSeconds;
    if (input === 'missing') {
      return notIdle(IDLE_REASON.rdpXprintidleMissing);
    }
    if (typeof input === 'object') {
      return notIdle(`${IDLE_REASON.rdp} (input idle unreadable: ${input.unreadable})`);
    }
    if (!Number.isInteger(input) || input < 0) {
      throw new InstallError(`the input idle time must be a whole number of seconds, got ${String(input)}`);
    }
    if (input < minutes * 60) {
      return notIdle(`${IDLE_REASON.rdp} (input ${Math.floor(input / 60)} min ago)`);
    }
    rdpNote = ` (rdp connected but no input for ${Math.floor(input / 60)} min)`;
  }
  if (c.ssh > 0) {
    return notIdle(IDLE_REASON.ssh);
  }
  if (c.peer > 0) {
    return notIdle(IDLE_REASON.peer);
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

  const restart = (why: string): IdleDecision => ({ suspend: false, reason: `idle 0/${minutes} min${why}${rdpNote}`, state: { since: now, last: now } });
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
  const elapsed = Math.floor((now - s.since) / 60);
  if (elapsed >= minutes) {
    return { suspend: true, reason: `suspending: idle ${elapsed} min${rdpNote}`, state: null };
  }
  return { suspend: false, reason: `idle ${elapsed}/${minutes} min${rdpNote}`, state: { since: s.since, last: now } };
}

// ---------------------------------------------------------------- the generated script

export interface IdleScriptOptions {
  minutes: number;
  /** '' in the shipped script. A relative prefix put before EVERY path the script reads or runs: only the golden test sets it. */
  root: string;
  /** The configuration folder of machine of the owner: the audit log, the daemon port file and the keep-awake file are read there. */
  configDir: string;
  /** Absolute paths measured on the box. */
  tools: { date: string; ss: string; systemdInhibit: string; logger: string; systemctl: string; stat: string; runuser: string; xprintidle: string };
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

export function idleSuspendScript(o: IdleScriptOptions): string {
  checkMinutes(o.minutes);
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
DATE='${t.date}'
SS='${t.ss}'
INHIBIT='${t.systemdInhibit}'
LOGGER='${t.logger}'
SYSTEMCTL='${t.systemctl}'
STAT='${t.stat}'
RUNUSER='${t.runuser}'
XPRINTIDLE='${t.xprintidle}'
AUDIT_LOG='${o.configDir}/audit.log'
PORT_FILE='${o.configDir}/daemon.port.json'
KEEP_AWAKE_USER='${o.configDir}/keep-awake'
KEEP_AWAKE_RUN='${IDLE_KEEP_AWAKE_RUN}'
STATE_DIR='${IDLE_STATE_DIR}'
STATE_FILE='${IDLE_STATE_FILE}'

rdp_note=''
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
if [ "$rdp" -gt 0 ]; then
  # An RDP connection is activity only while the X input of the session is recent: the minimum idle time (xprintidle, ms) over the X displays, each read as its owner.
  [ -x "$ROOT$XPRINTIDLE" ] || not_idle "${IDLE_REASON.rdpXprintidleMissing}"
  rdp_unreadable() { not_idle "${IDLE_REASON.rdp} (input idle unreadable: $1)"; }
  [ -x "$ROOT$RUNUSER" ] || rdp_unreadable "runuser is not installed ($RUNUSER)"
  [ -x "$ROOT$STAT" ] || rdp_unreadable "stat is not installed ($STAT)"
  min_idle=''
  for sock in "$ROOT${IDLE_X11_SOCKET_DIR}"/X*; do
    [ -e "$sock" ] || continue
    num=$(printf '%s\n' "$sock" | sed 's/.*\/X//')
    printf '%s\n' "$num" | grep -Eq '^[0-9]{1,4}$' || continue
    owner=$("$ROOT$STAT" -c %U -- "$sock" 2>/dev/null) || rdp_unreadable "cannot read the owner of :$num"
    printf '%s\n' "$owner" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$' || rdp_unreadable "the owner of :$num is not a plain user name"
    home=$(sed -n -E 's/^'"$owner"':[^:]*:[0-9]*:[0-9]*:[^:]*:([^:]*):.*/\1/p' "$ROOT/etc/passwd" 2>/dev/null | head -n 1)
    printf '%s\n' "$home" | grep -Eq '^(/[A-Za-z0-9._+-]+)+$' || rdp_unreadable "no usable home folder for $owner in /etc/passwd"
    out=$(DISPLAY=":$num" XAUTHORITY="$home/.Xauthority" "$ROOT$RUNUSER" -u "$owner" -- "$ROOT$XPRINTIDLE" 2>/dev/null) || rdp_unreadable "xprintidle failed on :$num as $owner"
    printf '%s\n' "$out" | grep -Eq '^[0-9]{1,15}$' || rdp_unreadable "xprintidle printed no number on :$num"
    secs=$((out / 1000))
    if [ -z "$min_idle" ] || [ "$secs" -lt "$min_idle" ]; then min_idle=$secs; fi
  done
  [ -n "$min_idle" ] || rdp_unreadable "no X display in ${IDLE_X11_SOCKET_DIR}"
  if [ "$min_idle" -lt $((MINUTES * 60)) ]; then not_idle "${IDLE_REASON.rdp} (input $((min_idle / 60)) min ago)"; fi
  rdp_note=" (rdp connected but no input for $((min_idle / 60)) min)"
fi
[ "$ssh" -eq 0 ] || not_idle "${IDLE_REASON.ssh}"
[ "$peer" -eq 0 ] || not_idle "${IDLE_REASON.peer}"

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
restart() {
  write_state "$now"
  log "idle 0/$MINUTES min$1$rdp_note"
  exit 0
}
case $state in
  none) restart '' ;;
  bad) restart '${RESTART.unreadable}' ;;
esac
if [ "$state_since" -gt "$now" ] || [ "$state_last" -gt "$now" ]; then restart '${RESTART.clock}'; fi
if [ $((now - state_last)) -gt ${IDLE_GAP_SECONDS} ]; then restart '${RESTART.gap}'; fi
elapsed=$(( (now - state_since) / 60 ))
if [ "$elapsed" -ge "$MINUTES" ]; then
  clear_state
  log "suspending: idle $elapsed min$rdp_note"
  "$ROOT$SYSTEMCTL" --no-block suspend || { log "cannot suspend: systemctl suspend failed"; exit 1; }
  exit 0
fi
write_state "$state_since"
log "idle $elapsed/$MINUTES min$rdp_note"
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
