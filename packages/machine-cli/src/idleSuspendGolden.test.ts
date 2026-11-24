import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendAudit, GENESIS_HASH, idleDecision, idleSuspendScript, type IdleFacts, type Json } from '@wadeck-app/machine-core';

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
  /** Decision 109: the traffic idle time from which an established ssh connection no longer counts (default 20). */
  sshMinutes?: number;
  /** What `ss -Htin state established '( sport = :22 )'` prints (two lines per socket), 'fail', or 'derive': every ssh socket of `ss` with a busy info line (traffic 1 s ago). */
  sshInfo?: string[] | 'fail' | 'derive';
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
  sshInfo: 'derive',
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
  // Read only with an ssh connection: the default fake ss info says traffic 1 s ago (decision 109).
  sshTrafficIdleSeconds: 1,
  audit: { lastActivityEpoch: NOW - 5 * H, openHolds: 0 },
  load5Hundredths: 8,
  inhibitors: 0,
  state: { since: NOW - 12 * M, last: NOW - 120 },
  // What the default world's display says (7200000 ms).
  inputIdleSeconds: 7200,
  ignoredDisplays: [],
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
/** The TCP info line of `ss -i` (iproute2), indented by a tab and a space: a real layout, `lastsnd`, `lastrcv` and `lastack` in milliseconds. */
/** The values a broken ss could print instead of milliseconds. */
type UnparsableMs = 'abc' | '5ms';
const info = (lastsnd: number | UnparsableMs, lastrcv: number | UnparsableMs): string => `\t cubic wscale:7,7 rto:204 rtt:3.4/1.7 ato:40 mss:1448 pmtu:1500 rcvmss:1448 advmss:1448 cwnd:10 bytes_sent:5129 bytes_acked:5129 bytes_received:3597 segs_out:60 segs_in:46 data_segs_out:36 data_segs_in:27 send 34Mbps lastsnd:${lastsnd} lastrcv:${lastrcv} lastack:${lastsnd} pacing_rate 68Mbps delivery_rate 12Mbps delivered:37 app_limited busy:2412ms rcv_space:14480 rcv_ssthresh:64088 minrtt:0.9 snd_wnd:64128`;
const busyInfo = info(1000, 1000);
const ssh6b = '0      0      [::ffff:10.0.0.1]:22   [::ffff:10.0.0.10]:40001';
const ssh6c = '0      0      [::ffff:10.0.0.1]:22   [::ffff:10.0.0.11]:40002';
const SSH_CAUSE = {
  failed: 'ss -i failed',
  noConnection: 'ss -i lists no ssh connection (it closed since the first listing?)',
  noInfo: 'ss -i printed a connection without its TCP info line',
  orphan: 'ss -i printed a TCP info line without a connection',
  noField: 'ss -i printed no lastrcv or lastsnd on a connection (iproute2 too old?)',
  unparsable: 'ss -i printed an unparsable lastrcv or lastsnd',
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
  { name: 'last check 301 s ago (the box slept): restarts', world: { state: `${NOW - 3 * H} ${NOW - 301}` }, facts: { state: { since: NOW - 3 * H, last: NOW - 301 } } },
  { name: 'last check exactly 300 s ago: same run', world: { state: `${NOW - 31 * M} ${NOW - 300}` }, facts: { state: { since: NOW - 31 * M, last: NOW - 300 } } },
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
  { name: 'established ssh over IPv6-mapped address', world: { ss: [ssh6] }, facts: { connections: { rdp: 0, ssh: 1, peer: 0 } } },
  { name: 'established machine peer connection', world: { ss: [peer] }, facts: { connections: { rdp: 0, ssh: 0, peer: 1 } } },
  { name: 'peer port file absent: a connection to that port is not counted', world: { ss: [peer], portFile: 'absent' }, facts: { connections: { rdp: 0, ssh: 0, peer: 0 } } },
  { name: 'peer port file with garbage', world: { portFile: '{not json' }, facts: { connections: null } },
  { name: 'peer port file unreadable', world: { portFile: 'unreadable' }, facts: { connections: null } },
  { name: 'ss fails', world: { ss: 'fail' }, facts: { connections: null } },
  { name: 'ss prints the state column', world: { ss: ['ESTAB  0      0      192.168.1.10:3389   192.168.1.99:52311'], displays: RECENT }, facts: { connections: onRdp, inputIdleSeconds: 600 } },
  { name: 'outgoing ssh and RDP from this box are not counted', world: { ss: ['0      0      192.168.1.10:51000   192.168.1.77:22', '0      0      192.168.1.10:51001   192.168.1.78:3389', '0      0      192.168.1.10:2222   192.168.1.78:40000'] } },
  { name: 'RDP and ssh together: rdp named first', world: { ss: [ssh6, rdp, peer], displays: RECENT }, facts: { connections: { rdp: 1, ssh: 1, peer: 1 }, inputIdleSeconds: 600 } },
  { name: 'two ssh connections', world: { ss: [ssh6, ssh6] }, facts: { connections: { rdp: 0, ssh: 2, peer: 0 } } },

  // ---- decision 109: an ssh connection is activity only while its TRAFFIC (ss -Htin: min(lastrcv, lastsnd)) is more recent than S (default 20 min)
  { name: 'ssh, traffic 1 s ago (the default fake): activity, minutes shown', world: { ss: [ssh6] }, facts: { connections: onSsh(), sshTrafficIdleSeconds: 1 } },
  { name: 'ssh, traffic 3 min ago on both directions: activity', world: { ss: [ssh6], sshInfo: [ssh6, info(180000, 180000)] }, facts: { connections: onSsh(), sshTrafficIdleSeconds: 180 } },
  { name: 'ssh, traffic S*60-1 s ago (1199999 ms): still activity', world: { ss: [ssh6], sshInfo: [ssh6, info(1199999, 1199999)] }, facts: { connections: onSsh(), sshTrafficIdleSeconds: 1199 } },
  { name: 'ssh, traffic exactly S*60 s ago (1200000 ms), timer at 12 min: not activity, said in the timer line', world: { ss: [ssh6], sshInfo: [ssh6, info(1200000, 1200000)] }, facts: { connections: onSsh(), sshTrafficIdleSeconds: 1200 } },
  { name: 'ssh, traffic S*60 s ago, timer at 47 min: suspends and says the ssh connection was ignored', world: { ss: [ssh6], sshInfo: [ssh6, info(1200000, 1200000)], state: `${NOW - 47 * M} ${NOW - 120}` }, facts: { connections: onSsh(), sshTrafficIdleSeconds: 1200, state: { since: NOW - 47 * M, last: NOW - 120 } } },
  { name: 'ssh, idle for hours, no state file: restart line carries the ssh suffix', world: { ss: [ssh6], sshInfo: [ssh6, info(7200000, 7200000)], state: 'absent' }, facts: { connections: onSsh(), sshTrafficIdleSeconds: 7200, state: 'absent' } },
  { name: 'ssh: lastrcv is the older one, lastsnd the recent one: the MINIMUM counts (activity)', world: { ss: [ssh6], sshInfo: [ssh6, info(30000, 7200000)] }, facts: { connections: onSsh(), sshTrafficIdleSeconds: 30 } },
  { name: 'ssh: lastsnd is the older one, lastrcv the recent one: the MINIMUM counts (activity)', world: { ss: [ssh6], sshInfo: [ssh6, info(7200000, 45000)] }, facts: { connections: onSsh(), sshTrafficIdleSeconds: 45 } },
  { name: 'ssh: lastrcv 25 min, lastsnd 40 min: not activity, 25 min named', world: { ss: [ssh6], sshInfo: [ssh6, info(2400000, 1500000)] }, facts: { connections: onSsh(), sshTrafficIdleSeconds: 1500 } },
  { name: 'ssh, ms rounded down to whole seconds: 1200999 ms is 1200 s', world: { ss: [ssh6], sshInfo: [ssh6, info(1200999, 1200999)] }, facts: { connections: onSsh(), sshTrafficIdleSeconds: 1200 } },
  { name: 'three ssh connections, one busy (1 min), two idle (2 h): the busy one counts', world: { ss: [ssh6, ssh6b, ssh6c], sshInfo: [ssh6, info(7200000, 7200000), ssh6b, info(60000, 60000), ssh6c, info(7200000, 7200000)] }, facts: { connections: onSsh(3), sshTrafficIdleSeconds: 60 } },
  { name: 'two ssh connections both idle (2 h and 40 min): not activity, the shorter idle time is named, timer at 47 min', world: { ss: [ssh6, ssh6b], sshInfo: [ssh6, info(7200000, 7200000), ssh6b, info(2400000, 2400000)], state: `${NOW - 47 * M} ${NOW - 120}` }, facts: { connections: onSsh(2), sshTrafficIdleSeconds: 2400, state: { since: NOW - 47 * M, last: NOW - 120 } } },
  { name: 'ssh: one busy, one idle and one WITHOUT an info line (last): fail closed, with the cause', world: { ss: [ssh6, ssh6b, ssh6c], sshInfo: [ssh6, info(1000, 1000), ssh6b, info(7200000, 7200000), ssh6c] }, facts: { connections: onSsh(3), sshTrafficIdleSeconds: { unreadable: SSH_CAUSE.noInfo } } },
  { name: 'ssh: a connection without an info line in the MIDDLE: fail closed even if the others are idle', world: { ss: [ssh6, ssh6b, ssh6c], sshInfo: [ssh6, info(7200000, 7200000), ssh6b, ssh6c, info(7200000, 7200000)] }, facts: { connections: onSsh(3), sshTrafficIdleSeconds: { unreadable: SSH_CAUSE.noInfo } } },
  { name: 'ssh: ss -i fails: fail closed', world: { ss: [ssh6], sshInfo: 'fail' }, facts: { connections: onSsh(), sshTrafficIdleSeconds: { unreadable: SSH_CAUSE.failed } } },
  { name: 'ssh: ss -i lists nothing (the connection closed in between): fail closed', world: { ss: [ssh6], sshInfo: [] }, facts: { connections: onSsh(), sshTrafficIdleSeconds: { unreadable: SSH_CAUSE.noConnection } } },
  { name: 'ssh: an info line without a connection: fail closed', world: { ss: [ssh6], sshInfo: [busyInfo, ssh6, busyInfo] }, facts: { connections: onSsh(), sshTrafficIdleSeconds: { unreadable: SSH_CAUSE.orphan } } },
  { name: 'ssh: no lastrcv field (old iproute2): fail closed', world: { ss: [ssh6], sshInfo: [ssh6, '\t cubic wscale:7,7 rto:204 rtt:3.4/1.7 lastsnd:7200000 lastack:7200000'] }, facts: { connections: onSsh(), sshTrafficIdleSeconds: { unreadable: SSH_CAUSE.noField } } },
  { name: 'ssh: no lastsnd field: fail closed', world: { ss: [ssh6], sshInfo: [ssh6, '\t cubic wscale:7,7 rto:204 rtt:3.4/1.7 lastrcv:7200000 lastack:7200000'] }, facts: { connections: onSsh(), sshTrafficIdleSeconds: { unreadable: SSH_CAUSE.noField } } },
  { name: 'ssh: an info line with no TCP info at all (only the congestion control): fail closed', world: { ss: [ssh6], sshInfo: [ssh6, '\t cubic'] }, facts: { connections: onSsh(), sshTrafficIdleSeconds: { unreadable: SSH_CAUSE.noField } } },
  { name: 'ssh: lastrcv is not a number: fail closed', world: { ss: [ssh6], sshInfo: [ssh6, info(7200000, 'abc')] }, facts: { connections: onSsh(), sshTrafficIdleSeconds: { unreadable: SSH_CAUSE.unparsable } } },
  { name: 'ssh: lastsnd is negative: fail closed', world: { ss: [ssh6], sshInfo: [ssh6, info(-5, 7200000)] }, facts: { connections: onSsh(), sshTrafficIdleSeconds: { unreadable: SSH_CAUSE.unparsable } } },
  { name: 'ssh: lastrcv has a unit suffix: fail closed', world: { ss: [ssh6], sshInfo: [ssh6, info(7200000, '5ms')] }, facts: { connections: onSsh(), sshTrafficIdleSeconds: { unreadable: SSH_CAUSE.unparsable } } },
  { name: 'ssh: one idle connection and one unparsable: fail closed, never the idle one alone', world: { ss: [ssh6, ssh6b], sshInfo: [ssh6, info(7200000, 7200000), ssh6b, info(1, 'abc')] }, facts: { connections: onSsh(2), sshTrafficIdleSeconds: { unreadable: SSH_CAUSE.unparsable } } },
  { name: 'ssh-minutes 1: traffic 59 s ago (59999 ms) is activity', world: { sshMinutes: 1, ss: [ssh6], sshInfo: [ssh6, info(59999, 59999)] }, facts: { connections: onSsh(), sshTrafficIdleSeconds: 59 } },
  { name: 'ssh-minutes 1: traffic exactly 60 s ago is not activity', world: { sshMinutes: 1, ss: [ssh6], sshInfo: [ssh6, info(60000, 60000)] }, facts: { connections: onSsh(), sshTrafficIdleSeconds: 60 } },
  { name: 'ssh-minutes 1440: traffic 86399 s ago (86399999 ms) is activity', world: { sshMinutes: 1440, ss: [ssh6], sshInfo: [ssh6, info(86399999, 86399999)] }, facts: { connections: onSsh(), sshTrafficIdleSeconds: 86399 } },
  { name: 'ssh-minutes 1440: traffic exactly 86400 s ago is not activity, timer at 47 min: suspends', world: { sshMinutes: 1440, ss: [ssh6], sshInfo: [ssh6, info(86400000, 86400000)], state: `${NOW - 47 * M} ${NOW - 120}` }, facts: { connections: onSsh(), sshTrafficIdleSeconds: 86400, state: { since: NOW - 47 * M, last: NOW - 120 } } },
  { name: 'ssh idle for hours AND a peer connection: the peer still counts unconditionally', world: { ss: [ssh6, peer], sshInfo: [ssh6, info(7200000, 7200000)] }, facts: { connections: { rdp: 0, ssh: 1, peer: 1 }, sshTrafficIdleSeconds: 7200 } },
  { name: 'ssh idle for hours AND a request 10 min ago: the audit rule stays unconditional', world: { ss: [ssh6], sshInfo: [ssh6, info(7200000, 7200000)], audit: audit(accepted(10 * M)) }, facts: { connections: onSsh(), sshTrafficIdleSeconds: 7200, audit: { lastActivityEpoch: NOW - 10 * M, openHolds: 0 } } },
  { name: 'ssh idle for hours AND an open hold: the hold stays unconditional', world: { ss: [ssh6], sshInfo: [ssh6, info(7200000, 7200000)], audit: audit(held(90 * M, 'h1')) }, facts: { connections: onSsh(), sshTrafficIdleSeconds: 7200, audit: { lastActivityEpoch: NOW - 90 * M, openHolds: 1 } } },
  { name: 'ssh idle for hours but a high load: the load is the reason', world: { ss: [ssh6], sshInfo: [ssh6, info(7200000, 7200000)], load: '0.01 5.00 0.01 1/2 3\n' }, facts: { connections: onSsh(), sshTrafficIdleSeconds: 7200, load5Hundredths: 500 } },
  { name: 'ssh idle for hours AND a recent input (no rdp): the input is the reason', world: { ss: [ssh6], sshInfo: [ssh6, info(7200000, 7200000)], displays: RECENT }, facts: { connections: onSsh(), sshTrafficIdleSeconds: 7200, inputIdleSeconds: 600 } },
  { name: 'ssh idle for hours, xprintidle missing, timer at 47 min: the suffix follows the input note', world: { ss: [ssh6], sshInfo: [ssh6, info(7200000, 7200000)], xprintidle: 'absent', state: `${NOW - 47 * M} ${NOW - 120}` }, facts: { connections: onSsh(), sshTrafficIdleSeconds: 7200, inputIdleSeconds: 'missing', state: { since: NOW - 47 * M, last: NOW - 120 } } },
  { name: 'ssh idle for hours, a greeter display ignored: the suffix follows the ignored display', world: { ss: [ssh6], sshInfo: [ssh6, info(7200000, 7200000)], displays: [disp('FAIL', '0', 'root', false), disp(7200000)] }, facts: { connections: onSsh(), sshTrafficIdleSeconds: 7200, ignoredDisplays: [0] } },
  { name: 'rdp idle for hours AND ssh idle for hours: suspends, both ignored connections are said', world: { ss: [rdp, ssh6], sshInfo: [ssh6, info(7200000, 7200000)], displays: [disp(21600000)] }, facts: { connections: { rdp: 1, ssh: 1, peer: 0 }, inputIdleSeconds: 21600, sshTrafficIdleSeconds: 7200 } },
  { name: 'rdp idle for hours AND ssh idle for hours, no state: confirms at the next check, ssh said', world: { ss: [rdp, ssh6], sshInfo: [ssh6, info(7200000, 7200000)], displays: [disp(21600000)], state: 'absent' }, facts: { connections: { rdp: 1, ssh: 1, peer: 0 }, inputIdleSeconds: 21600, sshTrafficIdleSeconds: 7200, state: 'absent' } },
  { name: 'rdp recent AND ssh idle: rdp is the reason, ss -i is not even needed', world: { ss: [rdp, ssh6], sshInfo: 'fail', displays: RECENT }, facts: { connections: { rdp: 1, ssh: 1, peer: 0 }, inputIdleSeconds: 600, sshTrafficIdleSeconds: { unreadable: SSH_CAUSE.failed } } },
  { name: 'outgoing ssh (peer port 22) is not an ssh connection to this box: ss -i is not asked, idle', world: { ss: ['0      0      192.168.1.10:51000   192.168.1.77:22'], sshInfo: 'fail' }, facts: { sshTrafficIdleSeconds: { unreadable: SSH_CAUSE.failed } } },

  // ---- decision 103, RDP connected: the input idle time is the clock (R = 20 min), no timer on top
  { name: 'rdp, input 10 min ago: activity, the minutes and the threshold are shown', world: { ss: [rdp], displays: RECENT }, facts: { connections: onRdp, inputIdleSeconds: 600 } },
  { name: 'rdp, input 0 s ago', world: { ss: [rdp], displays: [disp(999)] }, facts: { connections: onRdp, inputIdleSeconds: 0 } },
  { name: 'rdp, input 19 min 59 s ago (R*60-1): still activity', world: { ss: [rdp], displays: [disp(1199999)] }, facts: { connections: onRdp, inputIdleSeconds: 1199 } },
  { name: 'rdp, input exactly 20 min ago (R*60): suspends at the next check, the state is fresh, no 30-minute timer', world: { ss: [rdp], displays: [disp(1200000)], state: `${NOW - 120} ${NOW - 120}` }, facts: { connections: onRdp, inputIdleSeconds: 1200, state: { since: NOW - 120, last: NOW - 120 } } },
  { name: 'rdp, input 25 min ago (more than R, less than N = 30): suspends', world: { ss: [rdp], displays: [disp(1500000)] }, facts: { connections: onRdp, inputIdleSeconds: 1500 } },
  { name: 'rdp, input 6 h ago, a 12-minute-old state: suspends (the timer minutes do not matter)', world: { ss: [rdp], displays: [disp(21600000)] }, facts: { connections: onRdp, inputIdleSeconds: 21600 } },
  { name: 'rdp, input idle, no state file (first pass or a wake): confirms at the next check, does not suspend', world: { ss: [rdp], displays: [disp(3600000)], state: 'absent' }, facts: { connections: onRdp, inputIdleSeconds: 3600, state: 'absent' } },
  { name: 'rdp, input idle, the box slept (gap 301 s): confirms again', world: { ss: [rdp], displays: [disp(3600000)], state: `${NOW - 3 * H} ${NOW - 301}` }, facts: { connections: onRdp, inputIdleSeconds: 3600, state: { since: NOW - 3 * H, last: NOW - 301 } } },
  { name: 'rdp, input idle, last check exactly 300 s ago: same run, suspends', world: { ss: [rdp], displays: [disp(3600000)], state: `${NOW - 3 * H} ${NOW - 300}` }, facts: { connections: onRdp, inputIdleSeconds: 3600, state: { since: NOW - 3 * H, last: NOW - 300 } } },
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
  { name: 'rdp idle for hours AND ssh: ssh still counts unconditionally', world: { ss: [rdp, ssh6], displays: [disp(21600000)] }, facts: { connections: { rdp: 1, ssh: 1, peer: 0 }, inputIdleSeconds: 21600 } },
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
  { name: 'a session of Class greeter on :0 is ignored', world: { displays: [disp('FAIL', '0', 'gdm'), disp(7200000)], sessions: [{ id: 'c1', name: 'gdm', display: ':0', cls: 'greeter' }, { id: 's10', name: 'alice', display: ':10' }] }, facts: { inputIdleSeconds: 7200, ignoredDisplays: [0] } },
  { name: 'a session with no display (ssh, tty) is skipped without a word', world: { ss: [rdp], displays: [disp(7200000)], sessions: [{ id: 'c3', name: 'alice', display: '', type: 'tty' }, { id: 's10', name: 'alice', display: ':10' }] }, facts: { connections: onRdp, inputIdleSeconds: 7200 } },
  { name: 'only a session with no display AND an RDP connection: no user session', world: { ss: [rdp], displays: [], sessions: [{ id: 'c3', name: 'alice', display: '', type: 'tty' }] }, facts: { connections: onRdp, inputIdleSeconds: 'no-session' } },
  { name: 'the session user is not a plain name (space and quote): unreadable', world: { ss: [rdp], displays: [disp(7200000, '10', "Bad User'x")] }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'the name of session s10 is not a plain user name' } } },
  { name: 'the session user starts with a digit: not a plain name, unreadable', world: { ss: [rdp], displays: [disp(7200000, '10', '1user')] }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'the name of session s10 is not a plain user name' } } },
  { name: 'the session display is not :<n> (a screen suffix): unreadable', world: { ss: [rdp], displays: [disp(7200000)], sessions: [{ id: 's10', name: 'alice', display: ':10.0' }] }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'session s10 has an unexpected display' } } },
  { name: 'loginctl is not installed (rdp): unreadable', world: { ss: [rdp], loginctl: 'absent' }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'loginctl is not installed (/usr/bin/loginctl)' } } },
  { name: 'loginctl list-sessions fails (rdp): unreadable', world: { ss: [rdp], sessionsListFails: true }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'loginctl list-sessions failed' } } },
  { name: 'loginctl show-session fails for one session (rdp): unreadable', world: { ss: [rdp], displays: [disp(7200000)], sessions: [{ id: 's10', name: 'alice', display: ':10', showFails: true }] }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'loginctl show-session s10 failed' } } },
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
  { name: 'ssh connected AND a recent input: ssh is named first', world: { ss: [ssh6], displays: RECENT }, facts: { connections: { rdp: 0, ssh: 1, peer: 0 }, inputIdleSeconds: 600 } },
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
  // Decision 109: `ss -Htn state established` prints the sockets; `ss -Htin state established '( sport = :22 )'` prints each ssh socket on TWO lines (the TCP info line is indented).
  if (w.ss === 'fail') {
    put(`${root}/usr/bin/ss`, outputOf('fail'), 0o755);
  } else {
    put(`${root}/usr/bin/ss`, `#!/bin/sh\nif [ "$1" = "-Htin" ]; then\n  [ -f ss-info.out ] || exit 1\n  cat ss-info.out\nelse\n  cat ss-plain.out\nfi\n`, 0o755);
    put('ss-plain.out', w.ss.length === 0 ? '' : `${w.ss.join('\n')}\n`);
    if (w.sshInfo !== 'fail') {
      const lines = w.sshInfo === 'derive' ? w.ss.filter((l) => /^(ESTAB\s+)?\S+\s+\S+\s+\S*:22\s/.test(l)).flatMap((l) => [l, busyInfo]) : w.sshInfo;
      put('ss-info.out', lines.length === 0 ? '' : `${lines.join('\n')}\n`);
    }
  }
  put(`${root}/usr/bin/systemd-inhibit`, outputOf(w.inhibit), 0o755);
  fill(`${root}${CONFIG}/daemon.port.json`, w.portFile);
  fill(`${root}${CONFIG}/audit.log`, w.audit, 'missing');
  fill(`${root}/proc/loadavg`, w.load, 'missing');
  fill(`${root}/run/machine-keep-awake`, w.keepRun);
  fill(`${root}${CONFIG}/keep-awake`, w.keepUser);
  fill(`${root}/run/machine-idle-suspend/since`, w.state);
  // Decision 105: the X sockets, the logind sessions (derived from the displays that have a session unless the row lists them), the passwd file and the tools of the input check.
  put(`${root}/etc/passwd`, w.passwd);
  folder(`${root}/tmp/.X11-unix`);
  for (const d of w.displays) {
    put(`${root}/tmp/.X11-unix/X${d.n}`, '');
    put(`xp-${d.n}`, d.out === '' ? '' : `${d.out}\n`);
  }
  const sessions: SessionSpec[] = w.sessions === 'derive' ? w.displays.filter((d) => d.session !== false).map((d) => ({ id: `s${d.n}`, name: d.owner, display: `:${d.n}` })) : w.sessions;
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
  writeFileSync(join(dir, 'machine-idle-suspend.sh'), idleSuspendScript({ minutes: w.minutes, rdpMinutes: w.rdpMinutes, sshMinutes: w.sshMinutes, root, configDir: CONFIG, tools: TOOLS }), { mode: 0o755 });
}

describe.skipIf(SKIPPED_ON_PURPOSE)('idleSuspendScript on a fake root decides like idleDecision', () => {
  it.each(ROWS.map((r) => [r.name, r] as const))('%s', (_name, row) => {
    const world: Required<World> = { ...DEFAULT_WORLD, ...row.world };
    const facts: IdleFacts = { ...DEFAULT_FACTS, ...row.facts };
    const expected = idleDecision(facts, world.now, world.minutes, world.rdpMinutes, world.sshMinutes);
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

  it('the table covers every decision kind of idleDecision (suspend, wait, each not-idle reason, each restart)', () => {
    const reasons = new Set(
      ROWS.map((r) => idleDecision({ ...DEFAULT_FACTS, ...r.facts }, NOW, r.world?.minutes ?? 30, r.world?.rdpMinutes ?? 20, r.world?.sshMinutes ?? 20).reason.replace(/\d+(\.\d+)?/g, '#')),
    );
    for (const needle of ['ssh connected (traffic # min ago, needs #)', '(ssh connected but no traffic for # min, needs #)', 'ssh connected (traffic idle unreadable: ss -i printed a connection without its TCP info line)', 'suspending: idle # min', 'idle #/# min', 'keep-awake requested', 'cannot read the keep-awake files', 'rdp connected', 'ssh connected', 'machine peer connected', 'cannot read the connections', 'machine request in the last # min', 'machine request on hold', 'rdp connected (input # min ago, needs #)', 'suspending: rdp connected but no input for # min (needs #)', 'confirming at the next check', 'not idle: input # min ago (needs #)', 'input idleness not checked: xprintidle is not installed', 'input idleness not checked: no user session found', 'rdp connected but no user session found', '(ignored display :#: no user session)', 'rdp connected (xprintidle is not installed: sudo apt install xprintidle)', 'rdp connected (input idle unreadable: xprintidle failed on :# as alice)','cannot read the machine audit log', 'load # (limit #)', 'cannot read the load average', 'sleep inhibitor held', 'cannot list the sleep inhibitors', 'the clock went back', 'the state file is unreadable', 'no check for more than # min']) {
      expect([...reasons].some((x) => x.includes(needle)), needle).toBe(true);
    }
  });
});
