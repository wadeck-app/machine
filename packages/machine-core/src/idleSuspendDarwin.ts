import { IDLE_WAKE_GRACE_MAX_MINUTES, IDLE_WAKE_GRACE_MIN_MINUTES, idleCadenceSeconds, idleGapSeconds, isSafeAbsolutePath, type IdleCadenceSeconds, type IdleScriptOptions } from './idleSuspend.js';
import { InstallError } from './installError.js';

// `machine install idle-suspend` on macOS (decision 108, macos-idle-suspend-wake.md): the SKELETON. Pure: no file, no process.
// What exists: the launchd plist shape (a root LaunchDaemon started every `cadence` seconds), the options shared with Linux, and a table of the probes
// that are NOT validated on a real Mac. What does not exist: the darwin script. Every probe fails LOUDLY with the measurement it waits for; nothing
// is guessed (no silent fallback). The decision itself (`idleDecision`, the cadence, the gap rule) is the platform-neutral code of idleSuspend.ts.

/** Label of the LaunchDaemon. ASSUMED, to confirm with the user (U8 of the spec). */
export const IDLE_DARWIN_LABEL = 'com.wadeck.machine-idle-suspend';
/** `/Library/LaunchDaemons`: "System-wide daemons provided by the administrator" (spec section 3). */
export const IDLE_DARWIN_PLIST_PATH = `/Library/LaunchDaemons/${IDLE_DARWIN_LABEL}.plist`;
/** The version of the darwin content; independent of IDLE_SUSPEND_VERSION (the Linux script). */
export const IDLE_DARWIN_VERSION = 1;

/** The probes of the darwin script that were never run on a real Mac. */
export type IdleDarwinProbeId = 'resume-detection' | 'ssh-classification' | 'input-idle' | 'power-assertions' | 'connections' | 'load-average' | 'clock-parse' | 'keep-awake-path' | 'suspend-actuator';

/** For each probe: the test of section 2 of macos-idle-suspend-wake.md that measures it (or the statement that the spec has none yet) and what it is. */
export const IDLE_DARWIN_MEASUREMENTS: Record<IdleDarwinProbeId, { test: string; what: string }> = {
  'resume-detection': { test: 'test 8 (pmset -g log) gives sleep and wake events, but no monotonic wake counter like /sys/power/suspend_stats/success was measured: no test yet for the counter', what: 'detect a resume (Linux: the kernel suspend counter)' },
  'ssh-classification': { test: 'test 13 (who, netstat, lsof) lists sessions and connections, but the sshd login process title, the tty/notty split and the tty input idle time are not in the list: no test yet for those', what: 'classify an ssh connection as tty or notty and read its idle time' },
  'input-idle': { test: 'test 9 (ioreg -c IOHIDSystem, HIDIdleTime, as user and as root, lid open and closed)', what: 'the keyboard/mouse input idle time' },
  'power-assertions': { test: 'test 7 (pmset -g assertions)', what: 'the sleep blockers (Linux: systemd-inhibit)' },
  connections: { test: 'test 13 (netstat -an -p tcp, ports 22, 5900, 3283)', what: 'the established connections to ssh, screen sharing and the machine peer port' },
  'load-average': { test: 'test 14 (sysctl -n vm.loadavg)', what: 'the 5-minute load average' },
  'clock-parse': { test: 'test 15 (date -j -f on an ISO timestamp)', what: 'the audit log timestamps and the clock with the BSD date' },
  'keep-awake-path': { test: 'test 16 (/var/run and the ancestors of the script path)', what: 'where the run-time files (keep-awake, state) live and who may write there' },
  'suspend-actuator': { test: 'test 18 (pmset sleepnow, with and without root)', what: 'the command that suspends the Mac' },
};

const MEASUREMENT_FILE = 'macos-idle-suspend-wake.md';

/** Thrown by every probe and by the script generator: names each measurement the Mac must provide before the probe can be written. */
export class IdleDarwinNotImplemented extends InstallError {
  readonly probes: IdleDarwinProbeId[];
  constructor(probes: IdleDarwinProbeId[]) {
    super(`not implemented: ${probes.map((id) => `needs Mac measurement ${id} (${IDLE_DARWIN_MEASUREMENTS[id].test}; ${MEASUREMENT_FILE}; it must give: ${IDLE_DARWIN_MEASUREMENTS[id].what})`).join('; ')}. Nothing was guessed and nothing was changed`);
    this.probes = probes;
  }
}

/** Every probe of the darwin script calls this until its measurement is in: it never returns. */
export function idleDarwinProbe(id: IdleDarwinProbeId): never {
  throw new IdleDarwinNotImplemented([id]);
}

/** Why `machine install idle-suspend` is refused on macOS; appended to the unsupported message of the item (never silent: P-2). */
export const IDLE_DARWIN_UNAVAILABLE = `idle-suspend is not available on macOS yet: its probes (resume detection, ssh tty/notty classification, input idle time, power assertions...) are not validated on a real Mac, and a script that guesses them could suspend a Mac that is in use. Run the read-only measurements of section 2 of ${MEASUREMENT_FILE} on the Mac and report the output. Nothing was changed`;

export interface IdleDarwinOptions {
  minutes: number;
  rdpMinutes: number;
  sshMinutes: number;
  wakeGraceMinutes: number;
}

/**
 * The options of the darwin item, validated like Linux (same bounds, same cadence function). `--rdp-minutes` keeps its name; whether it means the
 * screen-sharing/VNC connections (5900, 3283) on macOS is not decided (U7 of the spec).
 */
export function idleSuspendDarwinPlan(o: IdleDarwinOptions): { cadenceSeconds: IdleCadenceSeconds; gapSeconds: number } {
  const cadenceSeconds = idleCadenceSeconds(o.minutes, o.rdpMinutes, o.sshMinutes);
  if (!Number.isInteger(o.wakeGraceMinutes) || o.wakeGraceMinutes < IDLE_WAKE_GRACE_MIN_MINUTES || o.wakeGraceMinutes > IDLE_WAKE_GRACE_MAX_MINUTES) {
    throw new InstallError(`the wake grace must be a whole number of minutes from ${IDLE_WAKE_GRACE_MIN_MINUTES} to ${IDLE_WAKE_GRACE_MAX_MINUTES}, got ${String(o.wakeGraceMinutes)}`);
  }
  return { cadenceSeconds, gapSeconds: idleGapSeconds(cadenceSeconds) };
}

/**
 * The launchd job: a system daemon (no `UserName`: launchd runs it as root), started every `cadenceSeconds`, not at load (the gap rule covers the
 * first pass). The marker is an XML comment (the Linux files use `#`: classifyInstalled needs a darwin marker rule before this file can be planned).
 */
export function idleSuspendDarwinPlist(o: { cadenceSeconds: number; scriptPath: string }): string {
  idleGapSeconds(o.cadenceSeconds);
  if (!isSafeAbsolutePath(o.scriptPath)) {
    throw new InstallError(`the script path ${JSON.stringify(o.scriptPath.slice(0, 80))} cannot be written into a root-run launchd plist (it must be absolute, with letters, digits and . _ + - / only, no space)`);
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    `<!-- managed by machine install idle-suspend, version ${IDLE_DARWIN_VERSION} -->`,
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${IDLE_DARWIN_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${o.scriptPath}</string>`,
    '  </array>',
    '  <key>StartInterval</key>',
    `  <integer>${o.cadenceSeconds}</integer>`,
    '  <key>RunAtLoad</key>',
    '  <false/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** The darwin script is NOT written: it needs every measurement of the table. Options are validated first, so a bad option is the error shown. */
export function idleSuspendDarwinScript(o: IdleScriptOptions): never {
  idleSuspendDarwinPlan(o);
  throw new IdleDarwinNotImplemented(Object.keys(IDLE_DARWIN_MEASUREMENTS) as IdleDarwinProbeId[]);
}
