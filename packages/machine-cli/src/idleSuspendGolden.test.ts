import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendAudit, findInstallable, GENESIS_HASH, IDLE_RESUME_CAUSE, IDLE_SSH_RATE_UNKNOWN, idleDecision, idleGapSeconds, idleResume, idleSuspendInstalledCadenceSeconds, idleSuspendScript, idleSuspendTimerUnit, type IdleFacts, type IdleResumeRecord, type IdleSshConnection, type Json } from '@wadeck-app/machine-core';

// GOLDEN TEST (idle-suspend.md): the generated shell script, run with `sh` on a fake root (fake /proc, fake ss, fake systemd-inhibit, fake audit log,
// fake keep-awake files, a fake clock), must reach the SAME decision as `idleDecision` on the table below. Each row states the world twice: as files
// (what the script reads) and as facts (what the pure function decides on), written by hand and independently.
// Needs a POSIX `sh` with GNU date/sed/grep/tail (any Linux, Git Bash on Windows): a missing one is an error, never a skip.

const NOW = 1_800_000_000;
const CONFIG = '/home/alice/.config/machine';
const TOOLS = { date: '/usr/bin/date', ss: '/usr/bin/ss', systemdInhibit: '/usr/bin/systemd-inhibit', logger: '/usr/bin/logger', systemctl: '/usr/bin/systemctl', loginctl: '/usr/bin/loginctl', runuser: '/usr/sbin/runuser', xprintidle: '/usr/bin/xprintidle' };
const iso = (epoch: number): string => new Date(epoch * 1000).toISOString();

type Entry = Record<string, Json>;
/** One audit line as the daemon writes it: `{ts, ...entry}`, entry keys in the order of peerService.ts. */
const auditLines = (entries: Entry[]): string => {
  let prev = GENESIS_HASH;
  return entries
    .map((entry, seq) => {
      const { line, hash } = appendAudit({ prevHash: prev, seq, entry });
      prev = hash;
      return line;
    })
    .join('\n') + '\n';
};
const accepted = (ago: number, id = 'r1'): Entry => ({ ts: iso(NOW - ago), event: 'accepted', source: 'laptop', id, shell: 'sh', command: 'ls' });
const completed = (ago: number, id = 'r1'): Entry => ({ ts: iso(NOW - ago), event: 'completed', id, exitCode: 0, timedOut: false });
const held = (ago: number, id: string): Entry => ({ ts: iso(NOW - ago), event: 'held', source: 'laptop', id, shell: 'sh', command: 'rm -rf x', deadline: NOW + 60 });
const holdEnded = (ago: number, id: string): Entry => ({ ts: iso(NOW - ago), event: 'hold-ended', source: 'laptop', id, shell: 'sh', command: 'rm -rf x', outcome: 'allowed' });
const started = (ago: number): Entry => ({ ts: iso(NOW - ago), event: 'daemon-started', version: '1.0.0' });
const H = 3600;
const M = 60;

/** What the fake box holds. `unreadable`: something exists at the path but cannot be read (a folder). */
interface World {
  now?: number;
  minutes?: number;
  /** Decision 103: the input idle time from which an established RDP connection no longer counts (default 20). */
  rdpMinutes?: number;
  /** Decision 111: the input idle time of the tty from which an ssh session no longer counts (default 20). */
  sshMinutes?: number;
  /** Decision 113: how long the script does not suspend after a resume (default 5). */
  wakeGraceMinutes?: number;
  /** Decision 113: the kernel counter file (`/sys/power/suspend_stats/success`): its text, 'absent' (no file) or 'unreadable' (a folder). */
  resumeCounter?: string | 'absent' | 'unreadable';
  /** Decision 113: the record of the previous pass in /run/machine-idle-suspend/resume: its text, 'absent' or 'unreadable' (a folder). */
  resume?: string | 'absent' | 'unreadable';
  /** The sshd processes of the fake /proc ('derive': a [priv] and a notty login per ssh socket of `ss`) and the pts files they imply (atime = now - idle). */
  sshProcs?: SshProc[] | 'derive';
  /** /dev/pts/N files that no sshd process owns (a stale pts): their atime is now - idle. */
  stalePts?: Array<{ n: number; idle: number }>;
  /** Decision 111: the TCP counters of the ssh connections (one entry per ssh line of `ss`, in order; default 100 B/s over 120 s) as `ss -Htinp` prints them. */
  sshNet?: NetSpec[];
  /** The samples file of the previous run: 'auto' (one line per ssh connection from `sshNet`, plus `sshSamplesExtra`; absent when there is none), 'absent', 'unreadable' (a folder) or the raw text. */
  sshSamples?: string | 'auto' | 'absent' | 'unreadable';
  /** Lines appended to the samples file in 'auto' mode (a connection that has vanished). */
  sshSamplesExtra?: string;
  /** `ss -Htinp` fails (the plain `ss -Htn` works). */
  sshListFails?: boolean;
  keepRun?: string | 'unreadable';
  keepUser?: string | 'unreadable';
  ss?: string[] | 'fail';
  portFile?: string | 'unreadable' | 'absent';
  audit?: string | 'missing' | 'unreadable';
  load?: string | 'missing';
  inhibit?: string[] | 'fail';
  state?: string | 'absent' | 'unreadable';
/** Decision 105: the X sockets of the box (/tmp/.X11-unix/X<n>): the owner of the session on it, what xprintidle prints ('FAIL': it exits 1), and whether a logind session runs on it (default yes: the greeter has none). */  displays?: Array<{ n: string; owner: string; out: string; session?: boolean }>;  /** The logind sessions: derived from the displays that have one ('derive'), or listed by the row. */  sessions?: SessionSpec[] | 'derive';  /** loginctl list-sessions fails. */  sessionsListFails?: boolean;  loginctl?: 'present' | 'absent';
  passwd?: string;
  xprintidle?: 'present' | 'absent';
  runuser?: 'present' | 'absent';
}

const DEFAULT_WORLD: Required<World> = {
  now: NOW,
  minutes: 30,
  rdpMinutes: 20,
  sshMinutes: 20,
  wakeGraceMinutes: 5,
  // The counter did not move for 3 hours: no resume to protect.
  resumeCounter: '40\n',
  resume: `40 ${NOW - 3 * 3600}\n`,
  sshProcs: 'derive',
  stalePts: [],
  sshNet: [],
  sshSamples: 'auto',
  sshSamplesExtra: '',
  sshListFails: false,
  keepRun: 'absent',
  keepUser: 'absent',
  ss: [],
  portFile: JSON.stringify({ pid: 4242, port: 5555, peerPort: 4242 }),
  audit: auditLines([started(6 * H), accepted(5 * H), completed(5 * H)]),
  load: '0.05 0.08 0.01 1/200 1234\n',
  inhibit: [
    'NetworkManager      0   root 987 NetworkManager  sleep                                      NetworkManager needs to turn off networks delay',
    'xfce4-power-manager 1000 alice 55 xfce4-power-manager handle-power-key:handle-suspend-key:handle-lid-switch Xfce handles these events block',
  ],
  state: `${NOW - 12 * M} ${NOW - 120}`,
  // The xrdp display :10 of alice, 2 hours since the last input (7200000 ms): a quiet box.
  displays: [{ n: '10', owner: 'alice', out: '7200000' }],
  passwd: 'root:x:0:0:root:/root:/bin/bash\nalice:x:1000:1000:Alice:/home/alice:/bin/bash\nbob:x:1001:1001:Bob:/home/bob:/bin/sh\n',
  xprintidle: 'present',
  runuser: 'present',
  loginctl: 'present',
  sessions: 'derive',
  sessionsListFails: false,
};

const DEFAULT_FACTS: IdleFacts = {
  keepAwake: [{ present: false }, { present: false }],
  connections: { rdp: 0, ssh: 0, peer: 0 },
  // Read only with an ssh connection (decision 111): no tty session by default.
  sshConnections: [],
  audit: { lastActivityEpoch: NOW - 5 * H, openHolds: 0 },
  load5Hundredths: 8,
  inhibitors: 0,
  state: { since: NOW - 12 * M, last: NOW - 120 },
  // What the default world's display says (7200000 ms).
  inputIdleSeconds: 7200,
  ignoredDisplays: [],
  resume: { counter: 40, stored: { kind: 'counter', counter: 40, seenAt: NOW - 3 * 3600 } },
};

/** A logind session of the fake box (loginctl show-session): defaults Class=user, State=active, Type=x11. */
interface SessionSpec {
  id: string;
  name: string;
  display: string;
  cls?: string;
  state?: string;
  type?: string;
  showFails?: boolean;
}

/** The counters of one ssh connection in `ss -Htinp` and its previous sample. The previous total is 1000 and bytes_received 1000; the bytes_acked make the delta. */
interface NetSpec {
  /** Bytes (acked + received) gained since the previous sample (default 12000: 100 B/s over 120 s). */
  delta?: number;
  /** Seconds since the previous sample (default 120), or 'none': no sample of this connection. */
  dt?: number | 'none';
  /** The total of the previous sample (default 1000). */
  prevTotal?: number;
  /** bytes_acked as printed (default: makes `delta`). */
  acked?: string;
  /** bytes_received as printed (default 1000), or 'absent': the field is not printed. */
  received?: string | 'absent';
  /** No counter line at all. */
  info?: 'absent';
  /** ss prints the state column. */
  estab?: boolean;
  /** The Process column is not printed (ss run without root). */
  column?: 'none';
}

interface Row {
  name: string;
  world?: World;
  facts?: Partial<IdleFacts>;
}

const rdp = '0      0      192.168.1.10:3389   192.168.1.99:52311';
const onRdp = { rdp: 1, ssh: 0, peer: 0 };
/** A display of the fake box: the milliseconds xprintidle prints ('FAIL': it exits 1), its number and its owner. */
const disp = (out: { toString: () => string }, n = '10', owner = 'alice', session = true): { n: string; owner: string; out: string; session: boolean } => ({ n, owner, out: String(out), session });
/** The xrdp display :10 with an input 10 minutes ago. */
const RECENT = [disp(600000)];
const ssh6 = '0      0      [::ffff:10.0.0.1]:22   [::ffff:10.0.0.9]:40000';
const peer = '0      0      192.168.1.10:4242   192.168.1.50:50001';
/** A process of the fake /proc as sshd names it (its cmdline is the title). idle: seconds since the last input of the pts of its title (atime of /dev/pts/N), 'missing' (no such file), 'future' (atime ahead of the clock). */
interface SshProc {
  pid: number;
  title: string;
  idle?: number | 'missing' | 'future';
}
const pts = (n: number, idle: number | 'missing' | 'future'): SshProc => ({ pid: 3000 + n, title: `sshd-session: alice@pts/${n}`, idle });
const notty = (n: number): SshProc => ({ pid: 4000 + n, title: 'sshd-session: alice@notty' });
const priv = (n: number): SshProc => ({ pid: 2000 + n, title: 'sshd-session: alice [priv]' });
const t = (n: number, idleSeconds: number, peer = P6): IdleSshConnection => ({ peer, kind: 'pts', tty: `pts/${n}`, idleSeconds });
/** A notty connection with this rate (B/s), or an unknown one with this cause. */
const nt = (rate: number, peer = P6): IdleSshConnection => ({ peer, kind: 'notty', rate });
const ntu = (unknown: string, peer = P6): IdleSshConnection => ({ peer, kind: 'notty', rate: { unknown } });
const ssh6b = '0      0      [::ffff:10.0.0.1]:22   [::ffff:10.0.0.10]:40001';
const P6 = '[::ffff:10.0.0.9]:40000';
const P6b = '[::ffff:10.0.0.10]:40001';
const P6c = '[::ffff:10.0.0.11]:40002';
const ssh6c = '0      0      [::ffff:10.0.0.1]:22   [::ffff:10.0.0.11]:40002';
const SSH_CAUSE = {
  noProc: (peer: string): string => `no sshd login process (title sshd-session: <user>@<tty>) found for the ssh connection ${peer}`,
  list: 'cannot list the ssh connections (/usr/bin/ss -tinp failed)',
  samples: 'cannot read /run/machine-idle-suspend/ssh-samples',
  stat: 'cannot read the idle time of pts/1 (stat /dev/pts/1 failed)',
  future: 'the last input of pts/1 is in the future (clock or tty error)',
  badTty: 'an sshd login process has an unexpected tty in its title (3001)',
};
const onSsh = (n = 1): IdleFacts['connections'] => ({ rdp: 0, ssh: n, peer: 0 });
const audit = (...e: Entry[]): string => auditLines([started(6 * H), ...e]);

const ROWS: Row[] = [
  // ---- the timer
  { name: 'idle 12 of 30 minutes' },
  { name: 'no state file: starts at 0', world: { state: 'absent' }, facts: { state: 'absent' } },
  { name: 'exactly 30 minutes: suspends', world: { state: `${NOW - 30 * M} ${NOW - 120}` }, facts: { state: { since: NOW - 30 * M, last: NOW - 120 } } },
  { name: '29 min 59 s: still waiting', world: { state: `${NOW - 30 * M + 1} ${NOW - 120}` }, facts: { state: { since: NOW - 30 * M + 1, last: NOW - 120 } } },
  { name: '47 minutes: suspends', world: { state: `${NOW - 47 * M} ${NOW - 120}` }, facts: { state: { since: NOW - 47 * M, last: NOW - 120 } } },
  { name: 'last check 601 s ago (the box slept, cadence 1 min, gap 600 s): restarts', world: { state: `${NOW - 3 * H} ${NOW - 601}` }, facts: { state: { since: NOW - 3 * H, last: NOW - 601 } } },
  { name: 'last check exactly 600 s ago (cadence 1 min): same run', world: { state: `${NOW - 31 * M} ${NOW - 600}` }, facts: { state: { since: NOW - 31 * M, last: NOW - 600 } } },
  { name: 'cadence 30 s (minutes 5): last check 301 s ago restarts, the message says 5 min', world: { minutes: 5, state: `${NOW - 3 * H} ${NOW - 301}` }, facts: { state: { since: NOW - 3 * H, last: NOW - 301 } } },
  { name: 'cadence 30 s (minutes 5): last check exactly 300 s ago: same run', world: { minutes: 5, state: `${NOW - 31 * M} ${NOW - 300}` }, facts: { state: { since: NOW - 31 * M, last: NOW - 300 } } },
  { name: 'cadence 2 min (31/31/31): last check 1201 s ago restarts, the message says 20 min', world: { minutes: 31, rdpMinutes: 31, sshMinutes: 31, state: `${NOW - 3 * H} ${NOW - 1201}` }, facts: { state: { since: NOW - 3 * H, last: NOW - 1201 } } },
  { name: 'cadence 2 min (31/31/31): last check exactly 1200 s ago: same run', world: { minutes: 31, rdpMinutes: 31, sshMinutes: 31, state: `${NOW - 40 * M} ${NOW - 1200}` }, facts: { state: { since: NOW - 40 * M, last: NOW - 1200 } } },
  { name: 'cadence 2 min: 12 min of 31 is counted in time', world: { minutes: 31, rdpMinutes: 31, sshMinutes: 31, state: `${NOW - 12 * M} ${NOW - 120}` }, facts: { state: { since: NOW - 12 * M, last: NOW - 120 } } },
  { name: 'cadence 30 s (minutes 5): 4 of 5 minutes is counted in time, the last pass 30 s ago', world: { minutes: 5, state: `${NOW - 4 * M} ${NOW - 30}` }, facts: { state: { since: NOW - 4 * M, last: NOW - 30 } } },
  { name: 'clock went back (since in the future)', world: { state: `${NOW + 10} ${NOW + 10}` }, facts: { state: { since: NOW + 10, last: NOW + 10 } } },
  { name: 'clock went back (last in the future)', world: { state: `${NOW - 3600} ${NOW + 1}` }, facts: { state: { since: NOW - 3600, last: NOW + 1 } } },
  { name: 'state file with garbage', world: { state: 'abc def\n' }, facts: { state: null } },
  { name: 'state file with a third field', world: { state: `${NOW - 3600} ${NOW - 100} 7\n` }, facts: { state: null } },
  { name: 'state file empty', world: { state: '' }, facts: { state: null } },
  { name: 'state file: since after last', world: { state: `${NOW - 10} ${NOW - 3600}` }, facts: { state: null } },
  { name: 'minutes 5: suspends at 5', world: { minutes: 5, state: `${NOW - 5 * M} ${NOW - 120}` }, facts: { state: { since: NOW - 5 * M, last: NOW - 120 } } },
  { name: 'minutes 5: 4 of 5', world: { minutes: 5, state: `${NOW - 4 * M} ${NOW - 120}` }, facts: { state: { since: NOW - 4 * M, last: NOW - 120 } } },
  { name: 'minutes 1440: 1439 of 1440 with a quiet log', world: { minutes: 1440, displays: [disp(90000000)], state: `${NOW - 1439 * M} ${NOW - 120}`, audit: audit(accepted(3 * 86400)) }, facts: { inputIdleSeconds: 90000, state: { since: NOW - 1439 * M, last: NOW - 120 }, audit: { lastActivityEpoch: NOW - 3 * 86400, openHolds: 0 } } },

  // ---- keep-awake files
  { name: 'keep-awake run file, empty', world: { keepRun: '' }, facts: { keepAwake: [{ present: true, untilEpoch: null }, { present: false }] } },
  { name: 'keep-awake user file, any text', world: { keepUser: 'because\n' }, facts: { keepAwake: [{ present: false }, { present: true, untilEpoch: null }] } },
  { name: 'keep-awake until the future', world: { keepRun: `keep awake until ${NOW + 100}\n` }, facts: { keepAwake: [{ present: true, untilEpoch: NOW + 100 }, { present: false }] } },
  { name: 'keep-awake "until <epoch>" short form, CRLF', world: { keepUser: `until ${NOW + 100}\r\n` }, facts: { keepAwake: [{ present: false }, { present: true, untilEpoch: NOW + 100 }] } },
  { name: 'keep-awake until now: expired, ignored', world: { keepRun: `keep awake until ${NOW}\n` }, facts: { keepAwake: [{ present: true, untilEpoch: NOW }, { present: false }] } },
  { name: 'keep-awake until the past: ignored', world: { keepRun: `keep awake until ${NOW - 5000}\n`, keepUser: `until 1\n` }, facts: { keepAwake: [{ present: true, untilEpoch: NOW - 5000 }, { present: true, untilEpoch: 1 }] } },
  { name: 'keep-awake "until abc": not a date, keeps awake', world: { keepRun: 'keep awake until abc\n' }, facts: { keepAwake: [{ present: true, untilEpoch: null }, { present: false }] } },
  { name: 'keep-awake with 13 digits: not a date, keeps awake', world: { keepRun: 'until 1111111111111\n' }, facts: { keepAwake: [{ present: true, untilEpoch: null }, { present: false }] } },
  { name: 'keep-awake: only the first line counts', world: { keepRun: `until ${NOW - 5}\nuntil ${NOW + 5000}\n` }, facts: { keepAwake: [{ present: true, untilEpoch: NOW - 5 }, { present: false }] } },
  { name: 'keep-awake path is unreadable', world: { keepUser: 'unreadable' }, facts: { keepAwake: null } },

  // ---- connections
  { name: 'established RDP, recent input', world: { ss: [rdp], displays: RECENT }, facts: { connections: onRdp, inputIdleSeconds: 600 } },
  { name: 'established ssh over IPv6-mapped address (a quiet notty connection)', world: { ss: [ssh6] }, facts: { connections: { rdp: 0, ssh: 1, peer: 0 }, sshConnections: [nt(100)] } },
  { name: 'established machine peer connection', world: { ss: [peer] }, facts: { connections: { rdp: 0, ssh: 0, peer: 1 } } },
  { name: 'peer port file absent: a connection to that port is not counted', world: { ss: [peer], portFile: 'absent' }, facts: { connections: { rdp: 0, ssh: 0, peer: 0 } } },
  { name: 'peer port file with garbage', world: { portFile: '{not json' }, facts: { connections: null } },
  { name: 'peer port file unreadable', world: { portFile: 'unreadable' }, facts: { connections: null } },
  { name: 'ss fails', world: { ss: 'fail' }, facts: { connections: null } },
  { name: 'ss prints the state column', world: { ss: ['ESTAB  0      0      192.168.1.10:3389   192.168.1.99:52311'], displays: RECENT }, facts: { connections: onRdp, inputIdleSeconds: 600 } },
  { name: 'outgoing ssh and RDP from this box are not counted', world: { ss: ['0      0      192.168.1.10:51000   192.168.1.77:22', '0      0      192.168.1.10:51001   192.168.1.78:3389', '0      0      192.168.1.10:2222   192.168.1.78:40000'] } },
  { name: 'RDP and ssh together: rdp named first', world: { ss: [ssh6, rdp, peer], displays: RECENT }, facts: { connections: { rdp: 1, ssh: 1, peer: 1 }, inputIdleSeconds: 600 } },
  { name: 'two ssh connections (two quiet notty connections)', world: { ss: [ssh6, ssh6b] }, facts: { connections: { rdp: 0, ssh: 2, peer: 0 }, sshConnections: [nt(100), nt(100, P6b)] } },

  // ---- decision 111: an ssh connection is activity only through a session WITH A TTY whose input idle time (atime of /dev/pts/N) is below S (default 20 min)
  { name: 'ssh, tty session with input 3 min ago: activity, names the tty and the minutes', world: { ss: [ssh6], sshProcs: [pts(1, 180)] }, facts: { connections: onSsh(), sshConnections: [t(1, 180)] } },
  { name: 'ssh, tty input S*60-1 s ago (1199 s): still activity', world: { ss: [ssh6], sshProcs: [pts(1, 1199)] }, facts: { connections: onSsh(), sshConnections: [t(1, 1199)] } },
  { name: 'ssh, tty input exactly S*60 s ago, timer at 12 min: not activity, said in the timer line', world: { ss: [ssh6], sshProcs: [pts(1, 1200)] }, facts: { connections: onSsh(), sshConnections: [t(1, 1200)] } },
  { name: 'ssh, tty input S*60 s ago, timer at 47 min: suspends and says the session was idle', world: { ss: [ssh6], sshProcs: [pts(1, 1200)], state: `${NOW - 47 * M} ${NOW - 120}` }, facts: { connections: onSsh(), sshConnections: [t(1, 1200)], state: { since: NOW - 47 * M, last: NOW - 120 } } },
  { name: 'ssh, tty idle for hours, no state file: the restart line carries the ssh suffix', world: { ss: [ssh6], sshProcs: [pts(1, 7200)], state: 'absent' }, facts: { connections: onSsh(), sshConnections: [t(1, 7200)], state: 'absent' } },
  { name: 'ssh, tty input 0 s ago', world: { ss: [ssh6], sshProcs: [pts(2, 0)] }, facts: { connections: onSsh(), sshConnections: [t(2, 0)] } },
  { name: 'ssh: the real process tree (a [priv] parent, the pts login, a bash) : the login is found, the others ignored', world: { ss: [ssh6], sshProcs: [priv(1), pts(1, 120), { pid: 77, title: 'bash' }] }, facts: { connections: onSsh(), sshConnections: [t(1, 120)] } },
  { name: 'ssh: an older sshd titles the process "sshd: alice@pts/2": the same', world: { ss: [ssh6], sshProcs: [{ pid: 3002, title: 'sshd: alice@pts/2', idle: 60 }] }, facts: { connections: onSsh(), sshConnections: [t(2, 60)] } },
  { name: 'ssh: the Herdr tree ([priv] then @notty) only, with a STALE fresh /dev/pts/0 that no sshd process owns: quiet, the stale pts is never counted', world: { ss: [ssh6], sshProcs: [priv(1), notty(1)], stalePts: [{ n: 0, idle: 30 }] }, facts: { connections: onSsh(), sshConnections: [nt(100)] } },
  { name: 'ssh: a fresh pts login AND the Herdr notty tree: the pts login blocks', world: { ss: [ssh6, ssh6b], sshProcs: [priv(1), pts(1, 47), priv(2), notty(2)] }, facts: { connections: onSsh(2), sshConnections: [t(1, 47), nt(100, P6b)] } },
  { name: 'ssh: a connection but NO sshd login process at all (other server, hidden /proc): fail closed, with the cause', world: { ss: [ssh6], sshProcs: [] }, facts: { connections: onSsh(), sshConnections: { unreadable: SSH_CAUSE.noProc(P6) } } },
  { name: 'ssh: only [priv] processes (a login still being set up): fail closed', world: { ss: [ssh6], sshProcs: [priv(1)] }, facts: { connections: onSsh(), sshConnections: { unreadable: SSH_CAUSE.noProc(P6) } } },
  { name: 'ssh: the title carries a tty that is not pts/N (tty1): fail closed, never stat-ed', world: { ss: [ssh6], sshProcs: [{ pid: 3001, title: 'sshd-session: alice@tty1' }] }, facts: { connections: onSsh(), sshConnections: { unreadable: SSH_CAUSE.badTty } } },
  { name: 'ssh: the title carries a path (pts/../x): fail closed, never stat-ed', world: { ss: [ssh6], sshProcs: [{ pid: 3001, title: 'sshd-session: alice@pts/../x' }] }, facts: { connections: onSsh(), sshConnections: { unreadable: SSH_CAUSE.badTty } } },
  { name: 'rdp recent AND ssh with no sshd login process: rdp is the reason, the ssh state is not even needed', world: { ss: [rdp, ssh6], sshProcs: [], displays: RECENT }, facts: { connections: { rdp: 1, ssh: 1, peer: 0 }, inputIdleSeconds: 600, sshConnections: { unreadable: SSH_CAUSE.noProc(P6) } } },
  { name: 'outgoing ssh (peer port 22) is not an ssh connection to this box: the processes are not read, idle', world: { ss: ['0      0      192.168.1.10:51000   192.168.1.77:22'], sshProcs: [] }, facts: { sshConnections: { unreadable: SSH_CAUSE.noProc(P6) } } },
  { name: 'ssh, ONLY a session without tty at 100 B/s (idle Herdr), timer at 12 min: quiet, said in the timer line', world: { ss: [ssh6], sshProcs: [notty(9)] }, facts: { connections: onSsh(), sshConnections: [nt(100)] } },
  { name: 'ssh, ONLY a session without tty at 100 B/s, timer at 47 min: suspends and says the connection was quiet', world: { ss: [ssh6], sshProcs: [notty(9)], state: `${NOW - 47 * M} ${NOW - 120}` }, facts: { connections: onSsh(), sshConnections: [nt(100)], state: { since: NOW - 47 * M, last: NOW - 120 } } },
  { name: 'ssh, no tty and no state file: restart line carries the quiet suffix', world: { ss: [ssh6], sshProcs: [notty(9)], state: 'absent' }, facts: { connections: onSsh(), sshConnections: [nt(100)], state: 'absent' } },
  { name: 'ssh: a session without tty AND a tty session with fresh input: the tty session blocks', world: { ss: [ssh6, ssh6b], sshProcs: [notty(9), pts(3, 60)] }, facts: { connections: onSsh(2), sshConnections: [nt(100), t(3, 60, P6b)] } },
  { name: 'ssh: a quiet session without tty AND a tty session idle for hours: not activity, the idle tty is named first, then the quiet connection', world: { ss: [ssh6, ssh6b], sshProcs: [notty(9), pts(3, 7200)] }, facts: { connections: onSsh(2), sshConnections: [nt(100), t(3, 7200, P6b)] } },
  { name: 'ssh: three tty sessions, the MINIMUM counts and names its tty (pts/2, 90 s)', world: { ss: [ssh6, ssh6b, ssh6c], sshProcs: [pts(0, 7200), pts(2, 90), pts(4, 3600)] }, facts: { connections: onSsh(3), sshConnections: [t(0, 7200), t(2, 90, P6b), t(4, 3600, P6c)] } },
  { name: 'ssh: two tty sessions with the same idle time: the first in the order of ss is named', world: { ss: [ssh6, ssh6b], sshProcs: [pts(5, 90), pts(2, 90)] }, facts: { connections: onSsh(2), sshConnections: [t(5, 90), t(2, 90, P6b)] } },
  { name: 'ssh: two tty sessions both idle (2 h and 40 min): not activity, the shorter idle time is named, timer at 47 min', world: { ss: [ssh6, ssh6b], sshProcs: [pts(0, 7200), pts(1, 2400)], state: `${NOW - 47 * M} ${NOW - 120}` }, facts: { connections: onSsh(2), sshConnections: [t(0, 7200), t(1, 2400, P6b)], state: { since: NOW - 47 * M, last: NOW - 120 } } },
  { name: 'ssh: a fresh tty session but no established ssh connection (stale session): not read, idle', world: { sshProcs: [pts(1, 5)] }, facts: { sshConnections: [t(1, 5)] } },
  { name: 'ssh: the tty idle time is unreadable (no /dev/pts/N): fail closed, with the cause', world: { ss: [ssh6], sshProcs: [{ ...pts(1, 0), idle: 'missing' }] }, facts: { connections: onSsh(), sshConnections: { unreadable: SSH_CAUSE.stat } } },
  { name: 'ssh: the last input is in the future (atime ahead of the clock): fail closed', world: { ss: [ssh6], sshProcs: [{ ...pts(1, 0), idle: 'future' }] }, facts: { connections: onSsh(), sshConnections: { unreadable: SSH_CAUSE.future } } },
  { name: 'ssh: one tty session idle for hours and one unreadable: fail closed, never the idle one alone', world: { ss: [ssh6, ssh6b], sshProcs: [pts(0, 7200), { ...pts(1, 0), idle: 'missing' }] }, facts: { connections: onSsh(2), sshConnections: { unreadable: SSH_CAUSE.stat } } },
  // ---- decision 111 (corrected): a notty connection is activity at 2048 B/s or more (average since the previous check), or when its rate is unknown
  { name: 'ssh notty at 5000 B/s: activity, named with its peer and rate', world: { ss: [ssh6], sshNet: [{ delta: 600000 }] }, facts: { connections: onSsh(), sshConnections: [nt(5000)] } },
  { name: 'ssh notty at 200 B/s, timer at 47 min: suspends, says the connection was quiet', world: { ss: [ssh6], sshNet: [{ delta: 24000 }], state: `${NOW - 47 * M} ${NOW - 120}` }, facts: { connections: onSsh(), sshConnections: [nt(200)], state: { since: NOW - 47 * M, last: NOW - 120 } } },
  { name: 'ssh notty exactly at the threshold (2048 B/s): activity', world: { ss: [ssh6], sshNet: [{ delta: 245760 }] }, facts: { connections: onSsh(), sshConnections: [nt(2048)] } },
  { name: 'ssh notty one byte under the threshold (2047 B/s): quiet', world: { ss: [ssh6], sshNet: [{ delta: 245759 }] }, facts: { connections: onSsh(), sshConnections: [nt(2047)] } },
  { name: 'ssh notty, previous sample exactly 300 s old: usable (100 B/s)', world: { ss: [ssh6], sshNet: [{ dt: 300, delta: 30000 }] }, facts: { connections: onSsh(), sshConnections: [nt(100)] } },
  { name: 'ssh notty, previous sample 301 s old: rate unknown, activity', world: { ss: [ssh6], sshNet: [{ dt: 301, delta: 30100 }] }, facts: { connections: onSsh(), sshConnections: [ntu(IDLE_SSH_RATE_UNKNOWN.stale)] } },
  { name: 'ssh notty, first sight (no samples file): rate unknown, activity', world: { ss: [ssh6], sshSamples: 'absent' }, facts: { connections: onSsh(), sshConnections: [ntu(IDLE_SSH_RATE_UNKNOWN.first)] } },
  { name: 'ssh notty, the samples file holds other connections only: first sight of this one', world: { ss: [ssh6], sshNet: [{ dt: 'none' }], sshSamplesExtra: `[::ffff:10.0.0.1]:22 [::ffff:10.0.0.99]:1 ${NOW - 120} 500\n` }, facts: { connections: onSsh(), sshConnections: [ntu(IDLE_SSH_RATE_UNKNOWN.first)] } },
  { name: 'ssh notty, the counter went down (a new connection on the same address): activity', world: { ss: [ssh6], sshNet: [{ prevTotal: 5000000 }] }, facts: { connections: onSsh(), sshConnections: [ntu(IDLE_SSH_RATE_UNKNOWN.down)] } },
  { name: 'ssh notty, the previous sample is from the same second: the clock did not advance, activity', world: { ss: [ssh6], sshNet: [{ dt: 0, delta: 0 }] }, facts: { connections: onSsh(), sshConnections: [ntu(IDLE_SSH_RATE_UNKNOWN.clock)] } },
  { name: 'ssh notty, the previous sample is damaged: activity', world: { ss: [ssh6], sshSamples: '[::ffff:10.0.0.1]:22 [::ffff:10.0.0.9]:40000 abc def\n' }, facts: { connections: onSsh(), sshConnections: [ntu(IDLE_SSH_RATE_UNKNOWN.previous)] } },
  { name: 'ssh notty, bytes_acked is not a number: activity', world: { ss: [ssh6], sshNet: [{ acked: '12x' }] }, facts: { connections: onSsh(), sshConnections: [ntu(IDLE_SSH_RATE_UNKNOWN.counters)] } },
  { name: 'ssh notty, bytes_received is not printed: activity', world: { ss: [ssh6], sshNet: [{ received: 'absent' }] }, facts: { connections: onSsh(), sshConnections: [ntu(IDLE_SSH_RATE_UNKNOWN.counters)] } },
  { name: 'ssh notty, no counter line at all: activity', world: { ss: [ssh6], sshNet: [{ info: 'absent' }] }, facts: { connections: onSsh(), sshConnections: [ntu(IDLE_SSH_RATE_UNKNOWN.counters)] } },
  { name: 'ssh notty, the listing carries the state column: read the same', world: { ss: [ssh6], sshNet: [{ estab: true, delta: 24000 }] }, facts: { connections: onSsh(), sshConnections: [nt(200)] } },
  { name: 'ssh pts login with huge traffic since the previous check (a terminal printing output) but idle input, timer at 47 min: the traffic is ignored, suspends', world: { ss: [ssh6], sshProcs: [priv(1), pts(1, 7200)], sshNet: [{ delta: 900000000 }], state: `${NOW - 47 * M} ${NOW - 120}` }, facts: { connections: onSsh(), sshConnections: [t(1, 7200)], state: { since: NOW - 47 * M, last: NOW - 120 } } },
  { name: 'ssh notty above the threshold AND a pts login idle for hours: the notty connection blocks', world: { ss: [ssh6, ssh6b], sshProcs: [pts(1, 7200), notty(2)], sshNet: [{}, { delta: 600000 }] }, facts: { connections: onSsh(2), sshConnections: [t(1, 7200), nt(5000, P6b)] } },
  { name: 'ssh two notty connections, one quiet one busy: the busy one blocks', world: { ss: [ssh6, ssh6b], sshProcs: [notty(1), notty(2)], sshNet: [{ delta: 24000 }, { delta: 600000 }] }, facts: { connections: onSsh(2), sshConnections: [nt(200), nt(5000, P6b)] } },
  { name: 'ssh two notty connections, both quiet: both are said on the timer line', world: { ss: [ssh6, ssh6b], sshProcs: [notty(1), notty(2)], sshNet: [{ delta: 24000 }, { delta: 36000 }] }, facts: { connections: onSsh(2), sshConnections: [nt(200), nt(300, P6b)] } },
  { name: 'ssh two notty connections, one quiet one new: the new one (rate unknown) blocks', world: { ss: [ssh6, ssh6b], sshProcs: [notty(1), notty(2)], sshNet: [{}, { dt: 'none' }] }, facts: { connections: onSsh(2), sshConnections: [nt(100), ntu(IDLE_SSH_RATE_UNKNOWN.first, P6b)] } },
  { name: 'ssh mapping failure: the Process column is not printed (ss without root): fail closed with the connection named', world: { ss: [ssh6], sshNet: [{ column: 'none' }] }, facts: { connections: onSsh(), sshConnections: { unreadable: SSH_CAUSE.noProc(P6) } } },
  { name: 'ssh: ss -Htinp fails (the plain ss works): fail closed with the cause', world: { ss: [ssh6], sshListFails: true }, facts: { connections: onSsh(), sshConnections: { unreadable: SSH_CAUSE.list } } },
  { name: 'ssh: the samples file cannot be read or written (a folder): fail closed with the cause', world: { ss: [ssh6], sshSamples: 'unreadable' }, facts: { connections: onSsh(), sshConnections: { unreadable: SSH_CAUSE.samples } } },
  { name: 'ssh-minutes 1: tty input 59 s ago is activity', world: { sshMinutes: 1, ss: [ssh6], sshProcs: [pts(1, 59)] }, facts: { connections: onSsh(), sshConnections: [t(1, 59)] } },
  { name: 'ssh-minutes 1: tty input exactly 60 s ago is not activity', world: { sshMinutes: 1, ss: [ssh6], sshProcs: [pts(1, 60)] }, facts: { connections: onSsh(), sshConnections: [t(1, 60)] } },
  { name: 'ssh-minutes 1440: tty input 86399 s ago is activity', world: { sshMinutes: 1440, ss: [ssh6], sshProcs: [pts(1, 86399)] }, facts: { connections: onSsh(), sshConnections: [t(1, 86399)] } },
  { name: 'ssh-minutes 1440: tty input exactly 86400 s ago is not activity, timer at 47 min: suspends', world: { sshMinutes: 1440, ss: [ssh6], sshProcs: [pts(1, 86400)], state: `${NOW - 47 * M} ${NOW - 120}` }, facts: { connections: onSsh(), sshConnections: [t(1, 86400)], state: { since: NOW - 47 * M, last: NOW - 120 } } },
  { name: 'ssh tty idle for hours AND a peer connection: the peer still counts unconditionally', world: { ss: [ssh6, peer], sshProcs: [pts(1, 7200)] }, facts: { connections: { rdp: 0, ssh: 1, peer: 1 }, sshConnections: [t(1, 7200)] } },
  { name: 'ssh tty idle for hours AND a request 10 min ago: the audit rule stays unconditional', world: { ss: [ssh6], sshProcs: [pts(1, 7200)], audit: audit(accepted(10 * M)) }, facts: { connections: onSsh(), sshConnections: [t(1, 7200)], audit: { lastActivityEpoch: NOW - 10 * M, openHolds: 0 } } },
  { name: 'ssh tty idle for hours AND an open hold: the hold stays unconditional', world: { ss: [ssh6], sshProcs: [pts(1, 7200)], audit: audit(held(90 * M, 'h1')) }, facts: { connections: onSsh(), sshConnections: [t(1, 7200)], audit: { lastActivityEpoch: NOW - 90 * M, openHolds: 1 } } },
  { name: 'ssh without tty (quiet) but a high load: the load is the reason (the limit of a slow notty job)', world: { ss: [ssh6], sshProcs: [notty(9)], load: '0.01 5.00 0.01 1/2 3\n' }, facts: { connections: onSsh(), sshConnections: [nt(100)], load5Hundredths: 500 } },
  { name: 'ssh without tty (quiet) but a sleep inhibitor in block mode: the inhibitor is the reason', world: { ss: [ssh6], sshProcs: [notty(9)], inhibit: ['Steam 1000 alice 9 steam sleep Playing block'] }, facts: { connections: onSsh(), sshConnections: [nt(100)], inhibitors: 1 } },
  { name: 'ssh tty idle for hours AND a recent X input (no rdp): the input is the reason', world: { ss: [ssh6], sshProcs: [pts(1, 7200)], displays: RECENT }, facts: { connections: onSsh(), sshConnections: [t(1, 7200)], inputIdleSeconds: 600 } },
  { name: 'ssh tty idle for hours, xprintidle missing, timer at 47 min: the suffix follows the input note', world: { ss: [ssh6], sshProcs: [pts(1, 7200)], xprintidle: 'absent', state: `${NOW - 47 * M} ${NOW - 120}` }, facts: { connections: onSsh(), sshConnections: [t(1, 7200)], inputIdleSeconds: 'missing', state: { since: NOW - 47 * M, last: NOW - 120 } } },
  { name: 'ssh tty idle for hours, a greeter display ignored: the suffix follows the ignored display', world: { ss: [ssh6], sshProcs: [pts(1, 7200)], displays: [disp('FAIL', '0', 'root', false), disp(7200000)] }, facts: { connections: onSsh(), sshConnections: [t(1, 7200)], ignoredDisplays: [0] } },
  { name: 'rdp idle for hours AND ssh tty idle for hours: suspends, both ignored connections are said', world: { ss: [rdp, ssh6], sshProcs: [pts(1, 7200)], displays: [disp(21600000)] }, facts: { connections: { rdp: 1, ssh: 1, peer: 0 }, inputIdleSeconds: 21600, sshConnections: [t(1, 7200)] } },
  { name: 'rdp idle for hours AND ssh tty idle for hours, no state: confirms at the next check, ssh said', world: { ss: [rdp, ssh6], sshProcs: [pts(1, 7200)], displays: [disp(21600000)], state: 'absent' }, facts: { connections: { rdp: 1, ssh: 1, peer: 0 }, inputIdleSeconds: 21600, sshConnections: [t(1, 7200)], state: 'absent' } },
  { name: 'rdp idle for hours AND a fresh ssh tty session: ssh blocks', world: { ss: [rdp, ssh6], sshProcs: [pts(1, 30)], displays: [disp(21600000)] }, facts: { connections: { rdp: 1, ssh: 1, peer: 0 }, inputIdleSeconds: 21600, sshConnections: [t(1, 30)] } },

  // ---- decision 103, RDP connected: the input idle time is the clock (R = 20 min), no timer on top
  { name: 'rdp, input 10 min ago: activity, the minutes and the threshold are shown', world: { ss: [rdp], displays: RECENT }, facts: { connections: onRdp, inputIdleSeconds: 600 } },
  { name: 'rdp, input 0 s ago', world: { ss: [rdp], displays: [disp(999)] }, facts: { connections: onRdp, inputIdleSeconds: 0 } },
  { name: 'rdp, input 19 min 59 s ago (R*60-1): still activity', world: { ss: [rdp], displays: [disp(1199999)] }, facts: { connections: onRdp, inputIdleSeconds: 1199 } },
  { name: 'rdp, input exactly 20 min ago (R*60): suspends at the next check, the state is fresh, no 30-minute timer', world: { ss: [rdp], displays: [disp(1200000)], state: `${NOW - 120} ${NOW - 120}` }, facts: { connections: onRdp, inputIdleSeconds: 1200, state: { since: NOW - 120, last: NOW - 120 } } },
  { name: 'rdp, input 25 min ago (more than R, less than N = 30): suspends', world: { ss: [rdp], displays: [disp(1500000)] }, facts: { connections: onRdp, inputIdleSeconds: 1500 } },
  { name: 'rdp, input 6 h ago, a 12-minute-old state: suspends (the timer minutes do not matter)', world: { ss: [rdp], displays: [disp(21600000)] }, facts: { connections: onRdp, inputIdleSeconds: 21600 } },
  { name: 'rdp, input idle, no state file (first pass or a wake): confirms at the next check, does not suspend', world: { ss: [rdp], displays: [disp(3600000)], state: 'absent' }, facts: { connections: onRdp, inputIdleSeconds: 3600, state: 'absent' } },
  { name: 'rdp, input idle, the box slept (gap 601 s, cadence 1 min): confirms again', world: { ss: [rdp], displays: [disp(3600000)], state: `${NOW - 3 * H} ${NOW - 601}` }, facts: { connections: onRdp, inputIdleSeconds: 3600, state: { since: NOW - 3 * H, last: NOW - 601 } } },
  { name: 'rdp, input idle, last check exactly 600 s ago: same run, suspends', world: { ss: [rdp], displays: [disp(3600000)], state: `${NOW - 3 * H} ${NOW - 600}` }, facts: { connections: onRdp, inputIdleSeconds: 3600, state: { since: NOW - 3 * H, last: NOW - 600 } } },
  { name: 'rdp, cadence 30 s (9/9/9), input idle: the pass after the confirming one (30 s ago) suspends', world: { minutes: 9, rdpMinutes: 9, sshMinutes: 9, ss: [rdp], displays: [disp(3600000)], state: `${NOW - 30} ${NOW - 30}` }, facts: { connections: onRdp, inputIdleSeconds: 3600, state: { since: NOW - 30, last: NOW - 30 } } },
  { name: 'rdp, cadence 30 s (9/9/9), input idle, no state: confirming at the next check', world: { minutes: 9, rdpMinutes: 9, sshMinutes: 9, ss: [rdp], displays: [disp(3600000)], state: 'absent' }, facts: { connections: onRdp, inputIdleSeconds: 3600, state: 'absent' } },
  { name: 'rdp, cadence 2 min (31/31/31), input idle, last pass 2 min ago: suspends', world: { minutes: 31, rdpMinutes: 31, sshMinutes: 31, ss: [rdp], displays: [disp(7200000)], state: `${NOW - 120} ${NOW - 120}` }, facts: { connections: onRdp, inputIdleSeconds: 7200, state: { since: NOW - 120, last: NOW - 120 } } },
  { name: 'rdp, input idle, state file with garbage: confirms again, says why', world: { ss: [rdp], displays: [disp(3600000)], state: 'abc def\n' }, facts: { connections: onRdp, inputIdleSeconds: 3600, state: null } },
  { name: 'rdp, input idle, clock went back: confirms again, says why', world: { ss: [rdp], displays: [disp(3600000)], state: `${NOW + 10} ${NOW + 10}` }, facts: { connections: onRdp, inputIdleSeconds: 3600, state: { since: NOW + 10, last: NOW + 10 } } },
  { name: 'rdp-minutes 5: input 4 min 59 s ago is activity', world: { rdpMinutes: 5, ss: [rdp], displays: [disp(299999)] }, facts: { connections: onRdp, inputIdleSeconds: 299 } },
  { name: 'rdp-minutes 5: input exactly 5 min ago suspends', world: { rdpMinutes: 5, ss: [rdp], displays: [disp(300000)] }, facts: { connections: onRdp, inputIdleSeconds: 300 } },
  { name: 'minutes 5 does not shorten the RDP wait (R = 20): input 10 min ago is activity', world: { minutes: 5, ss: [rdp], displays: RECENT }, facts: { connections: onRdp, inputIdleSeconds: 600 } },
  { name: 'two displays: the MINIMUM counts (the recent one is second)', world: { ss: [rdp], displays: [disp(7200000), disp(120000, '11', 'bob')] }, facts: { connections: onRdp, inputIdleSeconds: 120 } },
  { name: 'two displays: the MINIMUM counts (the recent one is first)', world: { ss: [rdp], displays: [disp(60000, '0'), disp(7200000, '10', 'bob')] }, facts: { connections: onRdp, inputIdleSeconds: 60 } },
  { name: 'two displays, both idle for hours: the RDP connection does not count', world: { ss: [rdp], displays: [disp(7200000), disp(3600000, '11', 'bob')] }, facts: { connections: onRdp, inputIdleSeconds: 3600 } },
  { name: 'rdp, xprintidle is not installed: activity', world: { ss: [rdp], xprintidle: 'absent' }, facts: { connections: onRdp, inputIdleSeconds: 'missing' } },
  { name: 'rdp, runuser is not installed: activity', world: { ss: [rdp], runuser: 'absent' }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'runuser is not installed (/usr/sbin/runuser)' } } },
  { name: 'rdp, no user session at all (no sockets): activity, the line says so', world: { ss: [rdp], displays: [] }, facts: { connections: onRdp, inputIdleSeconds: 'no-session' } },
  { name: 'rdp, xprintidle fails on the display: activity', world: { ss: [rdp], displays: [disp('FAIL')] }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'xprintidle failed on :10 as alice' } } },
  { name: 'rdp, xprintidle prints text: activity', world: { ss: [rdp], displays: [disp('Cannot open display')] }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'xprintidle printed no number on :10' } } },
  { name: 'rdp, xprintidle prints nothing: activity', world: { ss: [rdp], displays: [disp('')] }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'xprintidle printed no number on :10' } } },
  { name: 'rdp, xprintidle prints a negative number: activity', world: { ss: [rdp], displays: [disp(-5)] }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'xprintidle printed no number on :10' } } },
  { name: 'rdp, one display reads and the other fails: fail closed', world: { ss: [rdp], displays: [disp(7200000), disp('FAIL', '11', 'bob')] }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'xprintidle failed on :11 as bob' } } },
  { name: 'rdp, the user of the session is not a plain user name: activity', world: { ss: [rdp], displays: [disp(7200000, '10', "Bad User'x")] }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'the name of session s10 is not a plain user name' } } },
  { name: 'rdp, the user of the session has no home folder in /etc/passwd: activity', world: { ss: [rdp], displays: [disp(7200000, '10', 'carol')] }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'no usable home folder for carol in /etc/passwd' } } },
  { name: 'rdp, the home folder of the owner is not a safe path: activity', world: { ss: [rdp], displays: RECENT, passwd: 'alice:x:1000:1000::/home/al ice:/bin/sh\n' }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'no usable home folder for alice in /etc/passwd' } } },
  { name: 'rdp idle for hours AND a quiet ssh connection without tty: not activity, said', world: { ss: [rdp, ssh6], displays: [disp(21600000)] }, facts: { connections: { rdp: 1, ssh: 1, peer: 0 }, inputIdleSeconds: 21600, sshConnections: [nt(100)] } },
  { name: 'rdp idle for hours AND a peer connection: the peer still counts', world: { ss: [rdp, peer], displays: [disp(21600000)] }, facts: { connections: { rdp: 1, ssh: 0, peer: 1 }, inputIdleSeconds: 21600 } },
  { name: 'rdp idle for hours but a high load: the load is the reason', world: { ss: [rdp], displays: [disp(21600000)], load: '0.01 5.00 0.01 1/2 3\n' }, facts: { connections: onRdp, inputIdleSeconds: 21600, load5Hundredths: 500 } },
  { name: 'rdp idle for hours but a request 10 min ago: the request is the reason', world: { ss: [rdp], displays: [disp(21600000)], audit: audit(accepted(10 * M)) }, facts: { connections: onRdp, inputIdleSeconds: 21600, audit: { lastActivityEpoch: NOW - 10 * M, openHolds: 0 } } },
  { name: 'rdp idle for hours but a sleep inhibitor in block mode', world: { ss: [rdp], displays: [disp(21600000)], inhibit: ['Steam 1000 alice 9 steam sleep Playing block'] }, facts: { connections: onRdp, inputIdleSeconds: 21600, inhibitors: 1 } },
  { name: 'rdp idle for hours but keep-awake: the keep-awake file wins', world: { ss: [rdp], displays: [disp(21600000)], keepRun: '' }, facts: { connections: onRdp, inputIdleSeconds: 21600, keepAwake: [{ present: true, untilEpoch: null }, { present: false }] } },

  // ---- decision 105: the input is measured per logind SESSION; a display without a user session (the greeter) is ignored and said
  { name: 'greeter :0 (xprintidle fails there, no session) AND the user session :10, recent input: measured on :10 only, :0 said', world: { ss: [rdp], displays: [disp('FAIL', '0', 'root', false), disp(600000)] }, facts: { connections: onRdp, inputIdleSeconds: 600, ignoredDisplays: [0] } },
  { name: 'greeter :0 AND the user session :10 idle 25 min, rdp: suspends, :0 said', world: { ss: [rdp], displays: [disp('FAIL', '0', 'root', false), disp(1500000)] }, facts: { connections: onRdp, inputIdleSeconds: 1500, ignoredDisplays: [0] } },
  { name: 'greeter :0 AND the user session :10 idle 25 min, rdp, no state: confirms, :0 said', world: { ss: [rdp], displays: [disp('FAIL', '0', 'root', false), disp(1500000)], state: 'absent' }, facts: { connections: onRdp, inputIdleSeconds: 1500, ignoredDisplays: [0], state: 'absent' } },
  { name: 'greeter :0 AND the user session, no rdp, input idle: the timer line says :0', world: { displays: [disp('FAIL', '0', 'root', false), disp(7200000)] }, facts: { inputIdleSeconds: 7200, ignoredDisplays: [0] } },
  { name: 'greeter :0 AND the user session, no rdp, recent input: not idle, :0 said', world: { displays: [disp('FAIL', '0', 'root', false), disp(60000)] }, facts: { inputIdleSeconds: 60, ignoredDisplays: [0] } },
  { name: 'two displays without session are listed in one phrase', world: { displays: [disp('FAIL', '0', 'root', false), disp(500, '1', 'root', false), disp(7200000)] }, facts: { inputIdleSeconds: 7200, ignoredDisplays: [0, 1] } },
  { name: 'the user session display fails (greeter fine): unreadable, with the display and the user', world: { ss: [rdp], displays: [disp(0, '0', 'root', false), disp('FAIL')] }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'xprintidle failed on :10 as alice' } } },
  { name: 'greeter only (no user session) AND an RDP connection: unreadable, says no user session', world: { ss: [rdp], displays: [disp('FAIL', '0', 'root', false)] }, facts: { connections: onRdp, inputIdleSeconds: 'no-session' } },
  { name: 'two user sessions: the MINIMUM counts, the greeter is ignored', world: { ss: [rdp], displays: [disp('FAIL', '0', 'root', false), disp(7200000), disp(300000, '11', 'bob')] }, facts: { connections: onRdp, inputIdleSeconds: 300, ignoredDisplays: [0] } },
  { name: 'a closing session is ignored (its display is said, its recent input does not count)', world: { ss: [rdp], displays: [disp(7200000), disp(60000, '11', 'bob')], sessions: [{ id: 's10', name: 'alice', display: ':10' }, { id: 's11', name: 'bob', display: ':11', state: 'closing' }] }, facts: { connections: onRdp, inputIdleSeconds: 7200, ignoredDisplays: [11] } },
  { name: 'an online session counts like an active one', world: { ss: [rdp], displays: [disp(300000)], sessions: [{ id: 's10', name: 'alice', display: ':10', state: 'online' }] }, facts: { connections: onRdp, inputIdleSeconds: 300 } },
  { name: 'a session with no display (ssh, tty) is skipped without a word', world: { ss: [rdp], displays: [disp(7200000)], sessions: [{ id: 'c3', name: 'alice', display: '', type: 'tty' }, { id: 's10', name: 'alice', display: ':10' }] }, facts: { connections: onRdp, inputIdleSeconds: 7200 } },
  { name: 'only a session with no display AND an RDP connection: no user session', world: { ss: [rdp], displays: [], sessions: [{ id: 'c3', name: 'alice', display: '', type: 'tty' }] }, facts: { connections: onRdp, inputIdleSeconds: 'no-session' } },
  { name: 'the session user is not a plain name (space and quote): unreadable', world: { ss: [rdp], displays: [disp(7200000, '10', "Bad User'x")] }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'the name of session s10 is not a plain user name' } } },
  { name: 'the session user starts with a digit: not a plain name, unreadable', world: { ss: [rdp], displays: [disp(7200000, '10', '1user')] }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'the name of session s10 is not a plain user name' } } },
  { name: 'the session display is not :<n> (a screen suffix): unreadable', world: { ss: [rdp], displays: [disp(7200000)], sessions: [{ id: 's10', name: 'alice', display: ':10.0' }] }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'session s10 has an unexpected display' } } },
  { name: 'loginctl is not installed (rdp): unreadable', world: { ss: [rdp], loginctl: 'absent' }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'loginctl is not installed (/usr/bin/loginctl)' } } },
  { name: 'loginctl list-sessions fails (rdp): unreadable', world: { ss: [rdp], sessionsListFails: true }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'loginctl list-sessions failed' } } },
  { name: 'loginctl is not installed, no rdp: the timer only, with the cause', world: { loginctl: 'absent' }, facts: { inputIdleSeconds: { unreadable: 'loginctl is not installed (/usr/bin/loginctl)' } } },
  { name: 'loginctl list-sessions fails, no rdp: the timer only, with the cause', world: { sessionsListFails: true }, facts: { inputIdleSeconds: { unreadable: 'loginctl list-sessions failed' } } },

  // ---- decision 103, NO RDP connection: the input must be idle for N min when it can be read, then the N-minute timer
  { name: 'no rdp, input 29 min 59 s ago (N*60-1): not idle', world: { displays: [disp(1799999)] }, facts: { inputIdleSeconds: 1799 } },
  { name: 'no rdp, input 0 s ago: not idle', world: { displays: [disp(500)] }, facts: { inputIdleSeconds: 0 } },
  { name: 'no rdp, input exactly 30 min ago (N*60): the check passes, the timer runs', world: { displays: [disp(1800000)] }, facts: { inputIdleSeconds: 1800 } },
  { name: 'no rdp, input 30 min ago and the timer at 47 min: suspends', world: { displays: [disp(1800000)], state: `${NOW - 47 * M} ${NOW - 120}` }, facts: { inputIdleSeconds: 1800, state: { since: NOW - 47 * M, last: NOW - 120 } } },
  { name: 'minutes 5, no rdp: input 4 min 59 s ago is not idle', world: { minutes: 5, displays: [disp(299999)] }, facts: { inputIdleSeconds: 299 } },
  { name: 'minutes 5, no rdp: input exactly 5 min ago, the timer at 5 min: suspends', world: { minutes: 5, displays: [disp(300000)], state: `${NOW - 5 * M} ${NOW - 120}` }, facts: { inputIdleSeconds: 300, state: { since: NOW - 5 * M, last: NOW - 120 } } },
  { name: 'no rdp, the minimum over two displays is the recent one: not idle', world: { displays: [disp(7200000), disp(60000, '11', 'bob')] }, facts: { inputIdleSeconds: 60 } },
  { name: 'no rdp, xprintidle is not installed: the timer only, said in the line', world: { xprintidle: 'absent' }, facts: { inputIdleSeconds: 'missing' } },
  { name: 'no rdp, xprintidle is not installed, the timer at 47 min: suspends and says so', world: { xprintidle: 'absent', state: `${NOW - 47 * M} ${NOW - 120}` }, facts: { inputIdleSeconds: 'missing', state: { since: NOW - 47 * M, last: NOW - 120 } } },
  { name: 'no rdp, xprintidle is not installed, no state: restart line says so too', world: { xprintidle: 'absent', state: 'absent' }, facts: { inputIdleSeconds: 'missing', state: 'absent' } },
  { name: 'no rdp, runuser is not installed: the timer only, with the cause', world: { runuser: 'absent' }, facts: { inputIdleSeconds: { unreadable: 'runuser is not installed (/usr/sbin/runuser)' } } },
  { name: 'no rdp, no user session: the timer only, with the cause', world: { displays: [] }, facts: { inputIdleSeconds: 'no-session' } },
  { name: 'no rdp, xprintidle fails: the timer only, with the cause', world: { displays: [disp('FAIL')] }, facts: { inputIdleSeconds: { unreadable: 'xprintidle failed on :10 as alice' } } },
  { name: 'no rdp, xprintidle prints text: the timer only, with the cause', world: { displays: [disp('oops')] }, facts: { inputIdleSeconds: { unreadable: 'xprintidle printed no number on :10' } } },
  { name: 'no rdp, one display fails and the other is recent: the input is unreadable, the timer only', world: { displays: [disp(60000), disp('FAIL', '11', 'bob')] }, facts: { inputIdleSeconds: { unreadable: 'xprintidle failed on :11 as bob' } } },
  { name: 'no rdp, a recent input AND a high load: the input is named first', world: { displays: RECENT, load: '0.01 5.00 0.01 1/2 3\n' }, facts: { inputIdleSeconds: 600, load5Hundredths: 500 } },
  { name: 'no rdp, a recent input AND an unreadable audit log: the input is named first', world: { displays: RECENT, audit: 'missing' }, facts: { inputIdleSeconds: 600, audit: null } },
  { name: 'no rdp, an idle input AND an unreadable audit log: the audit log is the reason', world: { audit: 'missing' }, facts: { audit: null } },
  { name: 'ssh connection without tty (quiet) AND a recent input: the input is the reason', world: { ss: [ssh6], displays: RECENT }, facts: { connections: { rdp: 0, ssh: 1, peer: 0 }, inputIdleSeconds: 600, sshConnections: [nt(100)] } },
  { name: 'no rdp, a recent input AND a high load, xprintidle missing: the load only (no note on a not-idle line)', world: { xprintidle: 'absent', load: '0.01 5.00 0.01 1/2 3\n' }, facts: { inputIdleSeconds: 'missing', load5Hundredths: 500 } },

  // ---- the machine audit log
  { name: 'request accepted 10 min ago', world: { audit: audit(accepted(10 * M)) }, facts: { audit: { lastActivityEpoch: NOW - 10 * M, openHolds: 0 } } },
  { name: 'request completed 29 min ago', world: { audit: audit(accepted(35 * M), completed(29 * M)) }, facts: { audit: { lastActivityEpoch: NOW - 29 * M, openHolds: 0 } } },
  { name: 'last request exactly 30 min ago: outside the window', world: { audit: audit(completed(30 * M)) }, facts: { audit: { lastActivityEpoch: NOW - 30 * M, openHolds: 0 } } },
  { name: 'last request 29 min 59 s ago: inside', world: { audit: audit(completed(30 * M - 1)) }, facts: { audit: { lastActivityEpoch: NOW - 30 * M + 1, openHolds: 0 } } },
  { name: 'open hold 90 min old', world: { audit: audit(held(90 * M, 'h1')) }, facts: { audit: { lastActivityEpoch: NOW - 90 * M, openHolds: 1 } } },
  { name: 'hold 90 min old that ended', world: { audit: audit(held(90 * M, 'h1'), holdEnded(80 * M, 'h1')) }, facts: { audit: { lastActivityEpoch: NOW - 90 * M, openHolds: 0 } } },
  { name: 'one of two holds still open', world: { audit: audit(held(90 * M, 'h1'), held(85 * M, 'h2'), holdEnded(80 * M, 'h1')) }, facts: { audit: { lastActivityEpoch: NOW - 85 * M, openHolds: 1 } } },
  { name: 'hold older than 2 h without end is stale (daemon crashed)', world: { audit: audit(held(3 * H, 'h1')) }, facts: { audit: { lastActivityEpoch: NOW - 3 * H, openHolds: 0 } } },
  { name: 'hold ended for ANOTHER id does not close it', world: { audit: audit(held(90 * M, 'h1'), holdEnded(80 * M, 'h10')) }, facts: { audit: { lastActivityEpoch: NOW - 90 * M, openHolds: 1 } } },
  { name: 'forged event text inside a command is not an event', world: { audit: audit({ ts: iso(NOW - 1 * M), event: 'refused', source: 'laptop', id: 'x', command: 'x","event":"accepted","ts":"2026-11-22T10:00:00.000Z' }) }, facts: { audit: { lastActivityEpoch: null, openHolds: 0 } } },
  { name: 'forged hold inside a command is not a hold', world: { audit: audit({ ts: iso(NOW - 1 * M), event: 'refused', source: 'laptop', id: 'x', command: '","event":"held","source":"a","id":"zzz' }) }, facts: { audit: { lastActivityEpoch: null, openHolds: 0 } } },
  { name: 'audit log with only daemon-started and other events', world: { audit: audit({ ts: iso(NOW - 1 * M), event: 'requests-list', source: 'laptop' }) }, facts: { audit: { lastActivityEpoch: null, openHolds: 0 } } },
  { name: 'empty audit log', world: { audit: '' }, facts: { audit: { lastActivityEpoch: null, openHolds: 0 } } },
  { name: 'audit log missing (machine never ran here)', world: { audit: 'missing' }, facts: { audit: null } },
  { name: 'audit log unreadable', world: { audit: 'unreadable' }, facts: { audit: null } },
  { name: 'audit entry with a damaged timestamp', world: { audit: audit({ ts: 'yesterday', event: 'accepted', source: 'laptop', id: 'x' }) }, facts: { audit: null } },
  { name: 'request stamped in the future (clock error)', world: { audit: audit(accepted(-500)) }, facts: { audit: { lastActivityEpoch: NOW + 500, openHolds: 0 } } },

  // ---- load
  { name: 'load 0.29', world: { load: '0.01 0.29 0.01 1/2 3\n' }, facts: { load5Hundredths: 29 } },
  { name: 'load 0.30', world: { load: '0.01 0.30 0.01 1/2 3\n' }, facts: { load5Hundredths: 30 } },
  { name: 'load 0.08 (leading zero is not octal)', world: { load: '0.01 0.08 0.01 1/2 3\n' }, facts: { load5Hundredths: 8 } },
  { name: 'load 0.09', world: { load: '0.01 0.09 0.01 1/2 3\n' }, facts: { load5Hundredths: 9 } },
  { name: 'load 12.07', world: { load: '9.00 12.07 3.00 1/2 3\n' }, facts: { load5Hundredths: 1207 } },
  { name: 'load 0.00', world: { load: '0.00 0.00 0.00 1/2 3\n' }, facts: { load5Hundredths: 0 } },
  { name: 'load with a comma', world: { load: '0,01 0,29 0,01 1/2 3\n' }, facts: { load5Hundredths: null } },
  { name: 'load garbage', world: { load: 'a b c\n' }, facts: { load5Hundredths: null } },
  { name: 'load with one decimal', world: { load: '0.1 0.2 0.1 1/2 3\n' }, facts: { load5Hundredths: null } },
  { name: 'loadavg missing', world: { load: 'missing' }, facts: { load5Hundredths: null } },

  // ---- sleep inhibitors
  { name: 'a delay-mode sleep inhibitor and a block that is not about sleep: idle', world: {}, facts: {} },
  { name: 'a sleep inhibitor in block mode', world: { inhibit: ['gnome-session 1000 alice 7 gnome-session sleep:shutdown:idle Gnome needs to finish block'] }, facts: { inhibitors: 1 } },
  { name: 'a block inhibitor on sleep only', world: { inhibit: ['Steam 1000 alice 9 steam sleep Playing a game block'] }, facts: { inhibitors: 1 } },
  { name: 'a block inhibitor on idle only does not stop the suspend', world: { inhibit: ['Firefox 1000 alice 9 firefox idle Playing video block'] } },
  { name: 'a word "sleep" in the name of a delay inhibitor is not a block', world: { inhibit: ['sleep-helper 0 root 1 helper shutdown waiting delay'] } },
  { name: 'systemd-inhibit fails', world: { inhibit: 'fail' }, facts: { inhibitors: null } },

  // ---- decision 113: resume detection and the wake grace (the kernel counter /sys/power/suspend_stats/success and the record of the previous pass)
  { name: 'resume: the counter moved (41 after 40): wake grace, 5 min left, every other reading says idle', world: { resumeCounter: '41\n' }, facts: { resume: { counter: 41, stored: { kind: 'counter', counter: 40, seenAt: NOW - 3 * H } } } },
  { name: 'resume: two suspends since the last pass (counter 42 after 40): one grace from now', world: { resumeCounter: '42\n' }, facts: { resume: { counter: 42, stored: { kind: 'counter', counter: 40, seenAt: NOW - 3 * H } } } },
  { name: 'resume: the counter is LOWER than the record (a reset): treated as a resume', world: { resumeCounter: '3\n' }, facts: { resume: { counter: 3, stored: { kind: 'counter', counter: 40, seenAt: NOW - 3 * H } } } },
  { name: 'resume: no record yet (first pass or a reboot cleared /run): grace', world: { resume: 'absent' }, facts: { resume: { counter: 40, stored: 'absent' } } },
  { name: 'resume: the record is garbage: grace', world: { resume: 'abc def\n' }, facts: { resume: { counter: 40, stored: null } } },
  { name: 'resume: the record has a third field: unusable, grace', world: { resume: `40 ${NOW - 100} 7\n` }, facts: { resume: { counter: 40, stored: null } } },
  { name: 'resume: the record is empty: unusable, grace', world: { resume: '' }, facts: { resume: { counter: 40, stored: null } } },
  { name: 'grace: the counter was seen 100 s ago: 4 min left (rounded up)', world: { resume: `40 ${NOW - 100}\n` }, facts: { resume: { counter: 40, stored: { kind: 'counter', counter: 40, seenAt: NOW - 100 } } } },
  { name: 'grace: seen 299 s ago: 1 min left', world: { resume: `40 ${NOW - 299}\n` }, facts: { resume: { counter: 40, stored: { kind: 'counter', counter: 40, seenAt: NOW - 299 } } } },
  { name: 'grace over exactly at 300 s: the timer restarts (the grace had cleared the state)', world: { resume: `40 ${NOW - 300}\n`, state: 'absent' }, facts: { resume: { counter: 40, stored: { kind: 'counter', counter: 40, seenAt: NOW - 300 } }, state: 'absent' } },
  { name: 'grace over, a 31 min old state: suspends (the other checks passed on the previous pass too)', world: { resume: `40 ${NOW - 301}\n`, state: `${NOW - 31 * M} ${NOW - 60}` }, facts: { resume: { counter: 40, stored: { kind: 'counter', counter: 40, seenAt: NOW - 301 } }, state: { since: NOW - 31 * M, last: NOW - 60 } } },
  { name: 'grace in rdp mode: input idle for an hour, a fresh state: no suspend inside the grace', world: { ss: [rdp], displays: [disp(3600000)], resume: `40 ${NOW - 60}\n`, state: `${NOW - 3 * H} ${NOW - 30}` }, facts: { connections: onRdp, inputIdleSeconds: 3600, resume: { counter: 40, stored: { kind: 'counter', counter: 40, seenAt: NOW - 60 } }, state: { since: NOW - 3 * H, last: NOW - 30 } } },
  { name: 'grace over in rdp mode, no state: confirming at the next check', world: { ss: [rdp], displays: [disp(3600000)], resume: `40 ${NOW - 300}\n`, state: 'absent' }, facts: { connections: onRdp, inputIdleSeconds: 3600, resume: { counter: 40, stored: { kind: 'counter', counter: 40, seenAt: NOW - 300 } }, state: 'absent' } },
  { name: 'grace: a record from the future (the clock went back): restarts from now, 5 min left', world: { resume: `40 ${NOW + 7200}\n` }, facts: { resume: { counter: 40, stored: { kind: 'counter', counter: 40, seenAt: NOW + 7200 } } } },
  { name: 'grace of 1 minute (the lower bound): 1 min left', world: { wakeGraceMinutes: 1, resumeCounter: '41\n' }, facts: { resume: { counter: 41, stored: { kind: 'counter', counter: 40, seenAt: NOW - 3 * H } } } },
  { name: 'grace of 60 minutes (the upper bound): 60 min left', world: { wakeGraceMinutes: 60, resumeCounter: '41\n' }, facts: { resume: { counter: 41, stored: { kind: 'counter', counter: 40, seenAt: NOW - 3 * H } } } },
  { name: 'grace of 60 minutes, seen 59 min ago: 1 min left', world: { wakeGraceMinutes: 60, resume: `40 ${NOW - 59 * M}\n` }, facts: { resume: { counter: 40, stored: { kind: 'counter', counter: 40, seenAt: NOW - 59 * M } } } },
  { name: 'grace: a high load keeps its own reason (the grace is checked after the others)', world: { resumeCounter: '41\n', load: '0.01 5.00 0.01 1/2 3\n' }, facts: { load5Hundredths: 500, resume: { counter: 41, stored: { kind: 'counter', counter: 40, seenAt: NOW - 3 * H } } } },
  { name: 'grace: a sleep inhibitor keeps its own reason', world: { resumeCounter: '41\n', inhibit: ['Steam 1000 alice 9 steam sleep Playing block'] }, facts: { inhibitors: 1, resume: { counter: 41, stored: { kind: 'counter', counter: 40, seenAt: NOW - 3 * H } } } },
  { name: 'grace: a recent input keeps its own reason (no rdp)', world: { resumeCounter: '41\n', displays: RECENT }, facts: { inputIdleSeconds: 600, resume: { counter: 41, stored: { kind: 'counter', counter: 40, seenAt: NOW - 3 * H } } } },
  { name: 'grace: keep-awake keeps its own reason, and the record is still updated', world: { resumeCounter: '41\n', keepRun: '' }, facts: { keepAwake: [{ present: true, untilEpoch: null }, { present: false }], resume: { counter: 41, stored: { kind: 'counter', counter: 40, seenAt: NOW - 3 * H } } } },
  { name: 'grace: unreadable connections keep their own reason, and the record is still updated', world: { resumeCounter: '41\n', ss: 'fail' }, facts: { connections: null, resume: { counter: 41, stored: { kind: 'counter', counter: 40, seenAt: NOW - 3 * H } } } },
  { name: 'grace with an established ssh connection that is quiet: still the grace, the ssh note is not on a not-idle line', world: { resumeCounter: '41\n', ss: [ssh6], sshProcs: [priv(1), pts(1, 7200)] }, facts: { connections: onSsh(), sshConnections: [t(1, 7200)], resume: { counter: 41, stored: { kind: 'counter', counter: 40, seenAt: NOW - 3 * H } } } },
  { name: 'counter file missing, no record: grace once, the cause on the line', world: { resumeCounter: 'absent', resume: 'absent' }, facts: { resume: { counter: { unreadable: IDLE_RESUME_CAUSE.unreadable }, stored: 'absent' } } },
  { name: 'counter file is a folder (unreadable), no record: grace once, the cause on the line', world: { resumeCounter: 'unreadable', resume: 'absent' }, facts: { resume: { counter: { unreadable: IDLE_RESUME_CAUSE.unreadable }, stored: 'absent' } } },
  { name: 'counter file holds text: not a number, grace once', world: { resumeCounter: 'abc\n', resume: 'absent' }, facts: { resume: { counter: { unreadable: IDLE_RESUME_CAUSE.notNumber }, stored: 'absent' } } },
  { name: 'counter file is empty: not a number', world: { resumeCounter: '', resume: 'absent' }, facts: { resume: { counter: { unreadable: IDLE_RESUME_CAUSE.notNumber }, stored: 'absent' } } },
  { name: 'counter file holds a negative number: not a number', world: { resumeCounter: '-3\n', resume: 'absent' }, facts: { resume: { counter: { unreadable: IDLE_RESUME_CAUSE.notNumber }, stored: 'absent' } } },
  { name: 'counter file holds a number with a leading zero: not a whole number the kernel writes', world: { resumeCounter: '037\n', resume: 'absent' }, facts: { resume: { counter: { unreadable: IDLE_RESUME_CAUSE.notNumber }, stored: 'absent' } } },
  { name: 'counter unreadable for 100 s already: 4 min of the one grace left, same record start', world: { resumeCounter: 'absent', resume: `unreadable ${NOW - 100}\n` }, facts: { resume: { counter: { unreadable: IDLE_RESUME_CAUSE.unreadable }, stored: { kind: 'unreadable', seenAt: NOW - 100 } } } },
  { name: 'counter unreadable for an hour: the grace is over, it no longer blocks, the cause stays on the line (suspending)', world: { resumeCounter: 'absent', resume: `unreadable ${NOW - 3600}\n`, state: `${NOW - 31 * M} ${NOW - 60}` }, facts: { state: { since: NOW - 31 * M, last: NOW - 60 }, resume: { counter: { unreadable: IDLE_RESUME_CAUSE.unreadable }, stored: { kind: 'unreadable', seenAt: NOW - 3600 } } } },
  { name: 'counter unreadable for an hour, timer at 12 of 30: the cause is on the timer line too', world: { resumeCounter: 'absent', resume: `unreadable ${NOW - 3600}\n`, state: `${NOW - 12 * M} ${NOW - 60}` }, facts: { state: { since: NOW - 12 * M, last: NOW - 60 }, resume: { counter: { unreadable: IDLE_RESUME_CAUSE.unreadable }, stored: { kind: 'unreadable', seenAt: NOW - 3600 } } } },
  { name: 'counter unreadable for an hour, a high load: the cause is on a not-idle line too', world: { resumeCounter: 'absent', resume: `unreadable ${NOW - 3600}\n`, load: '0.01 5.00 0.01 1/2 3\n' }, facts: { load5Hundredths: 500, resume: { counter: { unreadable: IDLE_RESUME_CAUSE.unreadable }, stored: { kind: 'unreadable', seenAt: NOW - 3600 } } } },
  { name: 'counter readable again after an unreadable record: adopted without a new grace (window of the record kept)', world: { resumeCounter: '40\n', resume: `unreadable ${NOW - 3600}\n` }, facts: { resume: { counter: 40, stored: { kind: 'unreadable', seenAt: NOW - 3600 } } } },
  { name: 'counter readable again 100 s after the unreadable record: its grace goes on (4 min left)', world: { resumeCounter: '40\n', resume: `unreadable ${NOW - 100}\n` }, facts: { resume: { counter: 40, stored: { kind: 'unreadable', seenAt: NOW - 100 } } } },
  { name: 'counter that was readable and is not any more: a new grace once', world: { resumeCounter: 'absent' }, facts: { resume: { counter: { unreadable: IDLE_RESUME_CAUSE.unreadable }, stored: { kind: 'counter', counter: 40, seenAt: NOW - 3 * H } } } },
  { name: 'counter unreadable, an unreadable record in the future: restarts the grace from now', world: { resumeCounter: 'absent', resume: `unreadable ${NOW + 7200}\n` }, facts: { resume: { counter: { unreadable: IDLE_RESUME_CAUSE.unreadable }, stored: { kind: 'unreadable', seenAt: NOW + 7200 } } } },

  // ---- precedence: the first failing check names the reason
  { name: 'RDP connected AND load high AND a request: rdp first', world: { ss: [rdp], displays: RECENT, load: '0.01 5.00 0.01 1/2 3\n', audit: audit(accepted(1 * M)) }, facts: { connections: onRdp, inputIdleSeconds: 600, load5Hundredths: 500, audit: { lastActivityEpoch: NOW - M, openHolds: 0 } } },
  { name: 'keep-awake wins over everything', world: { keepUser: 'x', ss: 'fail', audit: 'missing', load: 'missing', inhibit: 'fail' }, facts: { keepAwake: [{ present: false }, { present: true, untilEpoch: null }], connections: null, audit: null, load5Hundredths: null, inhibitors: null } },
  { name: 'unreadable connections win over an unreadable audit log', world: { ss: 'fail', audit: 'missing' }, facts: { connections: null, audit: null } },
  { name: 'request in the window wins over a high load', world: { audit: audit(accepted(1 * M)), load: '0.01 5.00 0.01 1/2 3\n' }, facts: { audit: { lastActivityEpoch: NOW - M, openHolds: 0 }, load5Hundredths: 500 } },
  { name: 'high load wins over a block inhibitor', world: { load: '0.01 5.00 0.01 1/2 3\n', inhibit: ['Steam 1000 alice 9 steam sleep Playing block'] }, facts: { load5Hundredths: 500, inhibitors: 1 } },
];

let base: string;
const cleanup: string[] = [];

// The generated script is for a Linux box (`machine install idle-suspend` is Linux only) and needs GNU date. A macOS runner has BSD date (`date: illegal option -- d`, CI of cbeb183): the golden test is skipped there ON PURPOSE, never on Linux or Windows (Git Bash), where a missing tool stays an error.
const SKIPPED_ON_PURPOSE = process.platform === 'darwin';

beforeAll(() => {
  if (SKIPPED_ON_PURPOSE) {
    return;
  }
  const probe = spawnSync('sh', ['-c', 'date -u -d 2026-11-22T10:00:00.000Z +%s && sed -n -E "s/(a)/\\1/p" /dev/null && grep -Eq a /dev/null; tail -n 1 /dev/null'], { encoding: 'utf8' });
  if (probe.error !== undefined || probe.stdout.trim() !== String(Date.parse('2026-11-22T10:00:00.000Z') / 1000)) {
    throw new Error(`the golden test needs a POSIX sh with GNU date, sed -E, grep -E and tail on the PATH (a Linux box or Git Bash): ${probe.error?.message ?? `got ${JSON.stringify(probe.stdout)} ${probe.stderr}`}`);
  }
  base = mkdtempSync(join(tmpdir(), 'machine-idle-golden-'));
});
afterAll(() => {
  if (SKIPPED_ON_PURPOSE) {
    return;
  }
  rmSync(base, { recursive: true, force: true });
});

function build(dir: string, w: Required<World>): void {
  const put = (path: string, content: string, mode = 0o644): void => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content, { mode });
  };
  const folder = (path: string): void => {
    mkdirSync(join(dir, path), { recursive: true });
  };
  const fill = (path: string, v: string, whenAbsent: string | undefined = 'absent'): void => {
    if (v === whenAbsent) {
      return;
    }
    if (v === 'unreadable') {
      folder(path);
    }
    else put(path, v);
  };
  const root = 'fakeroot';
  put('now', `${w.now}\n`);
  put(`${root}/usr/bin/date`, '#!/bin/sh\nif [ "$1" = "+%s" ]; then cat now; else exec date "$@"; fi\n', 0o755);
  put(`${root}/usr/bin/logger`, '#!/bin/sh\nprintf "%s\\n" "$*" >> logger.log\n', 0o755);
  put(`${root}/usr/bin/systemctl`, '#!/bin/sh\nprintf "%s\\n" "$*" >> suspended\n', 0o755);
  const outputOf = (lines: string[] | 'fail'): string => (lines === 'fail' ? '#!/bin/sh\nexit 1\n' : `#!/bin/sh\ncat <<'EOT'\n${lines.join('\n')}\nEOT\n`);
  put(`${root}/usr/bin/systemd-inhibit`, outputOf(w.inhibit), 0o755);
  fill(`${root}${CONFIG}/daemon.port.json`, w.portFile);
  fill(`${root}${CONFIG}/audit.log`, w.audit, 'missing');
  fill(`${root}/proc/loadavg`, w.load, 'missing');
  fill(`${root}/run/machine-keep-awake`, w.keepRun);
  fill(`${root}${CONFIG}/keep-awake`, w.keepUser);
  fill(`${root}/run/machine-idle-suspend/since`, w.state);
  // Decision 113: the kernel counter of the successful suspends and the record of the previous pass.
  fill(`${root}/sys/power/suspend_stats/success`, w.resumeCounter);
  fill(`${root}/run/machine-idle-suspend/resume`, w.resume);
  // Decision 105: the X sockets, the logind sessions (derived from the displays that have a session unless the row lists them), the passwd file and the tools of the input check.
  put(`${root}/etc/passwd`, w.passwd);
  folder(`${root}/tmp/.X11-unix`);
  for (const d of w.displays) {
    put(`${root}/tmp/.X11-unix/X${d.n}`, '');
    put(`xp-${d.n}`, d.out === '' ? '' : `${d.out}\n`);
  }
  const x11Sessions: SessionSpec[] = w.sessions === 'derive' ? w.displays.filter((d) => d.session !== false).map((d) => ({ id: `s${d.n}`, name: d.owner, display: `:${d.n}` })) : w.sessions;
  // Decision 111: the ssh logins are processes of the fake /proc whose cmdline is the title sshd sets (NUL terminated); the pts of a title is a fake /dev/pts/N whose atime is now - idle.
  const procs: SshProc[] = w.sshProcs === 'derive' ? (w.ss === 'fail' ? [] : w.ss).filter((l) => /^(ESTAB\s+)?\S+\s+\S+\s+\S*:22\s/.test(l)).flatMap((_l, i) => [priv(10 + i), notty(10 + i)]) : w.sshProcs;
  const sessions: SessionSpec[] = x11Sessions;
  const setAtime = (path: string, atime: number): void => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '');
    utimesSync(path, atime, atime);
  };
  for (const p of procs) {
    put(`${root}/proc/${p.pid}/cmdline`, `${p.title}\0`);
    const m = /@(pts\/[0-9]+)$/.exec(p.title);
    if (m !== null && p.idle !== undefined && p.idle !== 'missing') {
      setAtime(join(dir, root, 'dev', m[1] as string), p.idle === 'future' ? w.now + 600 : w.now - p.idle);
    }
  }
  // `ss -Htn state established` prints the sockets; `ss -Htinp state established '( sport = :22 )'` (decision 111) prints the ssh ones with the Process column and the counters line.
  const sshConns = (w.ss === 'fail' ? [] : w.ss)
    .map((l) => l.trim().split(/\s+/))
    .map((tok) => (tok[0] === 'ESTAB' ? tok.slice(1) : tok))
    .filter((tok) => /:22$/.test(tok[2] ?? ''))
    .map((tok) => ({ local: tok[2] as string, peer: tok[3] as string }));
  const logins = procs.filter((p) => p.title.includes('@'));
  const privs = procs.filter((p) => p.title.includes('[priv]'));
  const net = (i: number): NetSpec => w.sshNet[i] ?? {};
  const listing = sshConns.map((c, i) => {
    const login = logins[i];
    const pids = login === undefined ? (privs[i] === undefined ? [] : [privs[i]!.pid]) : [login.pid, ...procs.filter((p) => p.pid === 2000 + (login.pid % 1000) && p.title.includes('[priv]')).map((p) => p.pid)];
    const column = net(i).column === 'none' || pids.length === 0 ? '' : ` users:(${pids.map((p) => `("sshd-session",pid=${p},fd=9)`).join(',')})`;
    const delta = net(i).delta ?? 12000;
    const received = net(i).received ?? '1000';
    const counters = `bytes_sent:894134 bytes_retrans:508 bytes_acked:${net(i).acked ?? String(delta)}${received === 'absent' ? '' : ` bytes_received:${received}`} segs_out:6333 segs_in:5217`;
    const head = `${net(i).estab === true ? 'ESTAB ' : ''}0      0      ${c.local}   ${c.peer}${column}`;
    return net(i).info === 'absent' ? head : `${head}\n\tcubic wscale:7,7 rto:204 rtt:1.2/0.6 mss:1448 pmtu:1500 rcvmss:1448 advmss:1448 cwnd:10 ${counters}`;
  });
  if (w.ss === 'fail') {
    put(`${root}/usr/bin/ss`, outputOf('fail'), 0o755);
  } else {
    put(`${root}/usr/bin/ss`, '#!/bin/sh\ncase "$*" in\n  *-Htinp*) [ -f ss-ssh.out ] || exit 1; cat ss-ssh.out ;;\n  *) cat ss-plain.out ;;\nesac\n', 0o755);
    put('ss-plain.out', w.ss.length === 0 ? '' : `${w.ss.join('\n')}\n`);
    if (!w.sshListFails) {
      put('ss-ssh.out', listing.length === 0 ? '' : `${listing.join('\n')}\n`);
    }
  }
  // The samples file of the previous run (decision 111): one line per connection with a previous sample, plus the extra lines.
  const autoSamples =
    sshConns
      .flatMap((c, i) => {
        const dt = net(i).dt;
        return dt === 'none' ? [] : [`${c.local} ${c.peer} ${w.now - (dt ?? 120)} ${net(i).prevTotal ?? 1000}\n`];
      })
      .join('') + w.sshSamplesExtra;
  if (w.sshSamples === 'auto') {
    if (autoSamples !== '') {
      put(`${root}/run/machine-idle-suspend/ssh-samples`, autoSamples);
    }
  } else if (w.sshSamples === 'unreadable') {
    folder(`${root}/run/machine-idle-suspend/ssh-samples`);
  } else if (w.sshSamples !== 'absent') {
    put(`${root}/run/machine-idle-suspend/ssh-samples`, w.sshSamples);
  }
  for (const x of w.stalePts) {
    setAtime(join(dir, root, 'dev/pts', String(x.n)), w.now - x.idle);
  }
  if (w.loginctl === 'present') {
    // loginctl list-sessions --no-legend: `<id> <uid> <name> <seat> <tty>`; loginctl show-session <id> -p ...: the properties (no file: it fails).
    put(`${root}/usr/bin/loginctl`, '#!/bin/sh\ncase "$1" in\n  list-sessions) [ -f sessions.list ] || exit 1; cat sessions.list ;;\n  show-session) [ -f "session-$2" ] || exit 1; cat "session-$2" ;;\n  *) exit 64 ;;\nesac\n', 0o755);
    if (!w.sessionsListFails) {
      put('sessions.list', sessions.map((s) => `${s.id} 1000 ${s.name} seat0 -\n`).join(''));
    }
    for (const s of sessions) {
      if (s.showFails !== true) {
        put(`session-${s.id}`, `Name=${s.name}\nType=${s.type ?? 'x11'}\nDisplay=${s.display}\nClass=${s.cls ?? 'user'}\nState=${s.state ?? 'active'}\n`);
      }
    }
  }
  // runuser -u <user> -- <command>: runs the command as is, and records user, DISPLAY and XAUTHORITY.
  if (w.runuser === 'present') {
    put(`${root}/usr/sbin/runuser`, '#!/bin/sh\n[ "$1" = "-u" ] && [ "$3" = "--" ] || exit 64\nprintf "%s %s %s\\n" "$2" "$DISPLAY" "$XAUTHORITY" >> runuser.log\nshift 3\nexec "$@"\n', 0o755);
  }
  // xprintidle: prints the file of the display (FAIL: exits 1; the milliseconds since the last input otherwise).
  if (w.xprintidle === 'present') {
    put(`${root}/usr/bin/xprintidle`, '#!/bin/sh\nf="xp-${DISPLAY#:}"\n[ -f "$f" ] || exit 1\nv=$(cat "$f")\n[ "$v" = "FAIL" ] && exit 1\nprintf "%s\\n" "$v"\n', 0o755);
  }
  // The config folder exists even when a file is missing (a missing audit log is a missing FILE).
  folder(`${root}${CONFIG}`);
  writeFileSync(join(dir, 'machine-idle-suspend.sh'), idleSuspendScript({ minutes: w.minutes, rdpMinutes: w.rdpMinutes, sshMinutes: w.sshMinutes, wakeGraceMinutes: w.wakeGraceMinutes, root, configDir: CONFIG, tools: TOOLS }), { mode: 0o755 });
}

describe.skipIf(SKIPPED_ON_PURPOSE)('idleSuspendScript on a fake root decides like idleDecision', () => {
  it.each(ROWS.map((r) => [r.name, r] as const))('%s', (_name, row) => {
    const world: Required<World> = { ...DEFAULT_WORLD, ...row.world };
    const facts: IdleFacts = { ...DEFAULT_FACTS, ...row.facts };
    const expected = idleDecision(facts, world.now, world.minutes, world.rdpMinutes, world.sshMinutes, world.wakeGraceMinutes);
    const dir = mkdtempSync(join(base, 'run-'));
    cleanup.push(dir);
    build(dir, world);
    const r = spawnSync('sh', ['machine-idle-suspend.sh'], { cwd: dir, encoding: 'utf8' });
    expect(r.error, String(r.error)).toBeUndefined();
    expect(r.stderr, 'the script writes nothing to stderr').toBe('');
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout.trim()).toBe(expected.reason);
    // The journal gets the same line (logger -t machine-idle-suspend -- <reason>).
    expect(readFileSync(join(dir, 'logger.log'), 'utf8').trim()).toBe(`-t machine-idle-suspend -- ${expected.reason}`);
    // Suspended exactly when idleDecision says so, by the one command.
    const suspendedFile = join(dir, 'suspended');
    expect(existsSync(suspendedFile)).toBe(expected.suspend);
    if (expected.suspend) {
      expect(readFileSync(suspendedFile, 'utf8').trim()).toBe('--no-block suspend');
    }
    // Decision 113: the record of the resume detection left behind (written at EVERY pass, whatever the verdict) is the one idleResume computes.
    const resumeFile = join(dir, 'fakeroot/run/machine-idle-suspend/resume');
    const wantRecord: IdleResumeRecord = idleResume(facts.resume, world.now, world.wakeGraceMinutes).record;
    expect(readFileSync(resumeFile, 'utf8')).toBe(wantRecord.kind === 'counter' ? `${wantRecord.counter} ${wantRecord.seenAt}\n` : `unreadable ${wantRecord.seenAt}\n`);
    // The state file left behind.
    const stateFile = join(dir, 'fakeroot/run/machine-idle-suspend/since');
    if (expected.state === null) {
      expect(existsSync(stateFile)).toBe(false);
    } else {
      expect(readFileSync(stateFile, 'utf8')).toBe(`${expected.state.since} ${expected.state.last}\n`);
    }
  });

  it('a state path that cannot be written (a folder) never suspends: it logs why and exits 1', () => {
    const dir = mkdtempSync(join(base, 'run-'));
    cleanup.push(dir);
    build(dir, { ...DEFAULT_WORLD, state: 'unreadable' });
    const r = spawnSync('sh', ['machine-idle-suspend.sh'], { cwd: dir, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^cannot write \/run\/machine-idle-suspend\/since: not suspending$/m);
    expect(existsSync(join(dir, 'suspended'))).toBe(false);
  });

  it('decision 113: a resume record that cannot be written (a folder) never suspends: it logs why and exits 1, before any check', () => {
    const dir = mkdtempSync(join(base, 'run-'));
    cleanup.push(dir);
    build(dir, { ...DEFAULT_WORLD, resume: 'unreadable', state: `${NOW - 40 * M} ${NOW - 60}` });
    const r = spawnSync('sh', ['machine-idle-suspend.sh'], { cwd: dir, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^cannot write \/run\/machine-idle-suspend\/resume: not suspending$/m);
    expect(r.stderr).toBe('');
    expect(existsSync(join(dir, 'suspended'))).toBe(false);
  });

  it('decision 113: the cadence is in the unit text AND in the script (the gap), from the same three options: the plan of the registry writes both', () => {
    const def = findInstallable('idle-suspend');
    if (def === undefined) {
      throw new Error('idle-suspend is not registered');
    }
    const facts = { platform: 'linux', userName: 'alice', systemctlPath: '/usr/bin/systemctl', sudoPath: '/usr/bin/sudo', configDir: CONFIG, tools: { date: TOOLS.date, ss: TOOLS.ss, systemdInhibit: TOOLS.systemdInhibit, logger: TOOLS.logger } };
    const table: Array<[number, number, number, number]> = [
      [9, 9, 9, 30],
      [30, 20, 20, 60],
      [10, 10, 10, 60],
      [31, 31, 31, 120],
      [60, 45, 40, 120],
      [9, 45, 45, 30],
    ];
    for (const [minutes, rdpMinutes, sshMinutes, cadence] of table) {
      const plan = def.plan({ ...facts, minutes, rdpMinutes, sshMinutes, wakeGraceMinutes: 7 });
      const timer = plan.files.find((f) => f.id === 'timer')?.content ?? '';
      const script = plan.files.find((f) => f.id === 'script')?.content ?? '';
      expect(idleSuspendInstalledCadenceSeconds(timer), `${minutes}/${rdpMinutes}/${sshMinutes}`).toBe(cadence);
      expect(timer).toBe(idleSuspendTimerUnit(cadence));
      expect(script).toContain(`\nGAP_SECONDS=${idleGapSeconds(cadence)}\n`);
      expect(script).toContain('\nWAKE_GRACE_MINUTES=7\n');
    }
  });

  it('a clock that cannot be read never suspends', () => {
    const dir = mkdtempSync(join(base, 'run-'));
    cleanup.push(dir);
    build(dir, { ...DEFAULT_WORLD, state: `${NOW - 3600} ${NOW - 100}` });
    writeFileSync(join(dir, 'fakeroot/usr/bin/date'), '#!/bin/sh\necho not-a-number\n', { mode: 0o755 });
    const r = spawnSync('sh', ['machine-idle-suspend.sh'], { cwd: dir, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/cannot read the clock/);
    expect(existsSync(join(dir, 'suspended'))).toBe(false);
  });

  it('decision 103: each display is read as its owner with its own DISPLAY and XAUTHORITY, with or without an RDP connection; xprintidle missing: nothing is run', () => {
    const run = (w: Required<World>): string => {
      const dir = mkdtempSync(join(base, 'run-'));
      cleanup.push(dir);
      build(dir, w);
      const r = spawnSync('sh', ['machine-idle-suspend.sh'], { cwd: dir, encoding: 'utf8' });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      return existsSync(join(dir, 'runuser.log')) ? readFileSync(join(dir, 'runuser.log'), 'utf8') : '';
    };
    const displays = [disp(7200000), disp(3600000, '11', 'bob')];
    expect(run({ ...DEFAULT_WORLD, ss: [rdp], displays })).toBe('alice :10 /home/alice/.Xauthority\nbob :11 /home/bob/.Xauthority\n');
    const both = 'alice :10 /home/alice/.Xauthority\nbob :11 /home/bob/.Xauthority\n';
    expect(run({ ...DEFAULT_WORLD, ss: [ssh6], displays })).toBe(both);
    expect(run({ ...DEFAULT_WORLD, ss: [], displays })).toBe(both);
    expect(run({ ...DEFAULT_WORLD, ss: [], displays, xprintidle: 'absent' })).toBe('');
  });

  // Decision 111 (corrected): the samples file is kept between the runs, whatever the verdict of a run (a not-idle verdict clears the timer, never the samples).
  const run = (dir: string): { stdout: string; stderr: string; status: number | null } => spawnSync('sh', ['machine-idle-suspend.sh'], { cwd: dir, encoding: 'utf8' });
  const samplesPath = (dir: string): string => join(dir, 'fakeroot/run/machine-idle-suspend/ssh-samples');
  it('decision 111: a connection seen for the first time blocks once, the next check measures its rate (the samples survive the not-idle verdict)', () => {
    const dir = mkdtempSync(join(base, 'run-'));
    cleanup.push(dir);
    build(dir, { ...DEFAULT_WORLD, ss: [ssh6], sshSamples: 'absent' });
    const first = run(dir);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(first.stdout.trim()).toBe(`not idle: ssh connection ${P6} rate unknown (${IDLE_SSH_RATE_UNKNOWN.first})`);
    expect(readFileSync(samplesPath(dir), 'utf8')).toBe(`[::ffff:10.0.0.1]:22 ${P6} ${NOW} 13000\n`);
    // Two minutes later 24000 more bytes (200 B/s): quiet, so not a reason any more; the timer was cleared by the first verdict and restarts.
    writeFileSync(join(dir, 'now'), `${NOW + 120}\n`);
    writeFileSync(join(dir, 'ss-ssh.out'), `0      0      [::ffff:10.0.0.1]:22   ${P6} users:(("sshd-session",pid=4010,fd=9),("sshd-session",pid=2010,fd=9))\n\tcubic bytes_sent:1 bytes_acked:36000 bytes_received:1000 segs_out:1\n`);
    const second = run(dir);
    expect(second.stdout.trim()).toBe(`idle 0/30 min (ssh connection ${P6} quiet: 200 B/s, under 2048)`);
    expect(existsSync(join(dir, 'suspended'))).toBe(false);
    expect(readFileSync(samplesPath(dir), 'utf8')).toBe(`[::ffff:10.0.0.1]:22 ${P6} ${NOW + 120} 37000\n`);
  });
  it('decision 111: the entries of connections that no longer exist are dropped from the samples file', () => {
    const dir = mkdtempSync(join(base, 'run-'));
    cleanup.push(dir);
    build(dir, { ...DEFAULT_WORLD, ss: [ssh6], sshSamplesExtra: `[::ffff:10.0.0.1]:22 [::ffff:10.0.0.99]:1 ${NOW - 120} 500\n` });
    expect(readFileSync(samplesPath(dir), 'utf8')).toContain('10.0.0.99');
    const r = run(dir);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(samplesPath(dir), 'utf8')).toBe(`[::ffff:10.0.0.1]:22 ${P6} ${NOW} 13000\n`);
  });
  it('decision 111: without any ssh connection the samples file is removed', () => {
    const dir = mkdtempSync(join(base, 'run-'));
    cleanup.push(dir);
    build(dir, { ...DEFAULT_WORLD, ss: [], sshSamples: `[::ffff:10.0.0.1]:22 ${P6} ${NOW - 120} 1000\n` });
    expect(existsSync(samplesPath(dir))).toBe(true);
    expect(run(dir).status).toBe(0);
    expect(existsSync(samplesPath(dir))).toBe(false);
  });
  it('decision 111: a pts login does not store a sample (only notty connections are measured)', () => {
    const dir = mkdtempSync(join(base, 'run-'));
    cleanup.push(dir);
    build(dir, { ...DEFAULT_WORLD, ss: [ssh6], sshProcs: [priv(1), pts(1, 7200)], sshSamples: 'absent' });
    expect(run(dir).status).toBe(0);
    expect(readFileSync(samplesPath(dir), 'utf8')).toBe('');
  });

  it('the table covers every decision kind of idleDecision (suspend, wait, each not-idle reason, each restart)', () => {
    const reasons = new Set(
      ROWS.map((r) => idleDecision({ ...DEFAULT_FACTS, ...r.facts }, NOW, r.world?.minutes ?? 30, r.world?.rdpMinutes ?? 20, r.world?.sshMinutes ?? 20, r.world?.wakeGraceMinutes ?? 5).reason.replace(/\d+(\.\d+)?/g, '#')),
    );
    for (const needle of ['ssh session pts/# active (input # min ago, needs #)', '(ssh session pts/# idle for # min, needs #)', 'B/s, needs #)', 'rate unknown (first check of this connection', 'quiet: # B/s, under #)', 'ssh connected (cannot read the ssh state: cannot read the idle time of pts/# (stat /dev/pts/# failed))', 'cannot read the ssh state: no sshd login process', 'suspending: idle # min', 'idle #/# min', 'keep-awake requested', 'cannot read the keep-awake files', 'rdp connected', 'ssh connected', 'machine peer connected', 'cannot read the connections', 'machine request in the last # min', 'machine request on hold', 'rdp connected (input # min ago, needs #)', 'suspending: rdp connected but no input for # min (needs #)', 'confirming at the next check', 'not idle: input # min ago (needs #)', 'input idleness not checked: xprintidle is not installed', 'input idleness not checked: no user session found', 'rdp connected but no user session found', '(ignored display :#: no user session)', 'rdp connected (xprintidle is not installed: sudo apt install xprintidle)', 'rdp connected (input idle unreadable: xprintidle failed on :# as alice)','cannot read the machine audit log', 'wake grace (# min left)', 'resume detection off: cannot read /sys/power/suspend_stats/success (missing or unreadable)', 'resume detection off: /sys/power/suspend_stats/success does not hold a whole number', 'no check for more than # min', 'load # (limit #)', 'cannot read the load average', 'sleep inhibitor held', 'cannot list the sleep inhibitors', 'the clock went back', 'the state file is unreadable', 'no check for more than # min']) {
      expect([...reasons].some((x) => x.includes(needle)), needle).toBe(true);
    }
  });
});
