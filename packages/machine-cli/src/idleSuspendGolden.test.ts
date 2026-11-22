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
const TOOLS = { date: '/usr/bin/date', ss: '/usr/bin/ss', systemdInhibit: '/usr/bin/systemd-inhibit', logger: '/usr/bin/logger', systemctl: '/usr/bin/systemctl', stat: '/usr/bin/stat', runuser: '/usr/sbin/runuser', xprintidle: '/usr/bin/xprintidle' };
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
  keepRun?: string | 'unreadable';
  keepUser?: string | 'unreadable';
  ss?: string[] | 'fail';
  portFile?: string | 'unreadable' | 'absent';
  audit?: string | 'missing' | 'unreadable';
  load?: string | 'missing';
  inhibit?: string[] | 'fail';
  state?: string | 'absent' | 'unreadable';
  /** Decision 102: the X displays of the box (a socket in /tmp/.X11-unix): its number, its owner ('fail': stat fails) and what xprintidle prints ('FAIL': it exits 1). */
  displays?: Array<{ n: string; owner: string | 'fail'; out: string }>;
  passwd?: string;
  xprintidle?: 'present' | 'absent';
  runuser?: 'present' | 'absent';
}

const DEFAULT_WORLD: Required<World> = {
  now: NOW,
  minutes: 30,
  rdpMinutes: 20,
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
};

const DEFAULT_FACTS: IdleFacts = {
  keepAwake: [{ present: false }, { present: false }],
  connections: { rdp: 0, ssh: 0, peer: 0 },
  audit: { lastActivityEpoch: NOW - 5 * H, openHolds: 0 },
  load5Hundredths: 8,
  inhibitors: 0,
  state: { since: NOW - 12 * M, last: NOW - 120 },
  // What the default world's display says (7200000 ms).
  inputIdleSeconds: 7200,
};

interface Row {
  name: string;
  world?: World;
  facts?: Partial<IdleFacts>;
}

const rdp = '0      0      192.168.1.10:3389   192.168.1.99:52311';
const onRdp = { rdp: 1, ssh: 0, peer: 0 };
/** A display of the fake box: the milliseconds xprintidle prints ('FAIL': it exits 1), its number and its owner. */
const disp = (out: { toString: () => string }, n = '10', owner = 'alice'): { n: string; owner: string; out: string } => ({ n, owner, out: String(out) });
/** The xrdp display :10 with an input 10 minutes ago. */
const RECENT = [disp(600000)];
const ssh6 = '0      0      [::ffff:10.0.0.1]:22   [::ffff:10.0.0.9]:40000';
const peer = '0      0      192.168.1.10:4242   192.168.1.50:50001';
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
  { name: 'rdp, no X display at all: activity', world: { ss: [rdp], displays: [] }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'no X display in /tmp/.X11-unix' } } },
  { name: 'rdp, xprintidle fails on the display: activity', world: { ss: [rdp], displays: [disp('FAIL')] }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'xprintidle failed on :10 as alice' } } },
  { name: 'rdp, xprintidle prints text: activity', world: { ss: [rdp], displays: [disp('Cannot open display')] }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'xprintidle printed no number on :10' } } },
  { name: 'rdp, xprintidle prints nothing: activity', world: { ss: [rdp], displays: [disp('')] }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'xprintidle printed no number on :10' } } },
  { name: 'rdp, xprintidle prints a negative number: activity', world: { ss: [rdp], displays: [disp(-5)] }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'xprintidle printed no number on :10' } } },
  { name: 'rdp, one display reads and the other fails: fail closed', world: { ss: [rdp], displays: [disp(7200000), disp('FAIL', '11', 'bob')] }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'xprintidle failed on :11 as bob' } } },
  { name: 'rdp, the owner of the display cannot be read: activity', world: { ss: [rdp], displays: [disp(7200000, '10', 'fail')] }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'cannot read the owner of :10' } } },
  { name: 'rdp, the owner is not a plain user name: activity', world: { ss: [rdp], displays: [disp(7200000, '10', "Bad User'x")] }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'the owner of :10 is not a plain user name' } } },
  { name: 'rdp, the owner has no home folder in /etc/passwd: activity', world: { ss: [rdp], displays: [disp(7200000, '10', 'carol')] }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'no usable home folder for carol in /etc/passwd' } } },
  { name: 'rdp, the home folder of the owner is not a safe path: activity', world: { ss: [rdp], displays: RECENT, passwd: 'alice:x:1000:1000::/home/al ice:/bin/sh\n' }, facts: { connections: onRdp, inputIdleSeconds: { unreadable: 'no usable home folder for alice in /etc/passwd' } } },
  { name: 'rdp idle for hours AND ssh: ssh still counts unconditionally', world: { ss: [rdp, ssh6], displays: [disp(21600000)] }, facts: { connections: { rdp: 1, ssh: 1, peer: 0 }, inputIdleSeconds: 21600 } },
  { name: 'rdp idle for hours AND a peer connection: the peer still counts', world: { ss: [rdp, peer], displays: [disp(21600000)] }, facts: { connections: { rdp: 1, ssh: 0, peer: 1 }, inputIdleSeconds: 21600 } },
  { name: 'rdp idle for hours but a high load: the load is the reason', world: { ss: [rdp], displays: [disp(21600000)], load: '0.01 5.00 0.01 1/2 3\n' }, facts: { connections: onRdp, inputIdleSeconds: 21600, load5Hundredths: 500 } },
  { name: 'rdp idle for hours but a request 10 min ago: the request is the reason', world: { ss: [rdp], displays: [disp(21600000)], audit: audit(accepted(10 * M)) }, facts: { connections: onRdp, inputIdleSeconds: 21600, audit: { lastActivityEpoch: NOW - 10 * M, openHolds: 0 } } },
  { name: 'rdp idle for hours but a sleep inhibitor in block mode', world: { ss: [rdp], displays: [disp(21600000)], inhibit: ['Steam 1000 alice 9 steam sleep Playing block'] }, facts: { connections: onRdp, inputIdleSeconds: 21600, inhibitors: 1 } },
  { name: 'rdp idle for hours but keep-awake: the keep-awake file wins', world: { ss: [rdp], displays: [disp(21600000)], keepRun: '' }, facts: { connections: onRdp, inputIdleSeconds: 21600, keepAwake: [{ present: true, untilEpoch: null }, { present: false }] } },

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
  { name: 'no rdp, no X display: the timer only, with the cause', world: { displays: [] }, facts: { inputIdleSeconds: { unreadable: 'no X display in /tmp/.X11-unix' } } },
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
  put(`${root}/usr/bin/ss`, outputOf(w.ss), 0o755);
  put(`${root}/usr/bin/systemd-inhibit`, outputOf(w.inhibit), 0o755);
  fill(`${root}${CONFIG}/daemon.port.json`, w.portFile);
  fill(`${root}${CONFIG}/audit.log`, w.audit, 'missing');
  fill(`${root}/proc/loadavg`, w.load, 'missing');
  fill(`${root}/run/machine-keep-awake`, w.keepRun);
  fill(`${root}${CONFIG}/keep-awake`, w.keepUser);
  fill(`${root}/run/machine-idle-suspend/since`, w.state);
  // Decision 102: the X displays, the passwd file and the three tools of the RDP input check (fake: they only read files of the fake box).
  put(`${root}/etc/passwd`, w.passwd);
  folder(`${root}/tmp/.X11-unix`);
  for (const d of w.displays) {
    put(`${root}/tmp/.X11-unix/X${d.n}`, '');
    if (d.owner !== 'fail') {
      put(`owner-X${d.n}`, `${d.owner}\n`);
    }
    put(`xp-${d.n}`, d.out === '' ? '' : `${d.out}\n`);
  }
  // stat -c %U -- <socket>: the owner is a file of the fake box (absent: stat fails).
  put(`${root}/usr/bin/stat`, '#!/bin/sh\nn=${4##*/}\n[ "$1" = "-c" ] && [ "$2" = "%U" ] && [ "$3" = "--" ] && [ -f "owner-$n" ] && cat "owner-$n"\n', 0o755);
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
  writeFileSync(join(dir, 'machine-idle-suspend.sh'), idleSuspendScript({ minutes: w.minutes, rdpMinutes: w.rdpMinutes, root, configDir: CONFIG, tools: TOOLS }), { mode: 0o755 });
}

describe.skipIf(SKIPPED_ON_PURPOSE)('idleSuspendScript on a fake root decides like idleDecision', () => {
  it.each(ROWS.map((r) => [r.name, r] as const))('%s', (_name, row) => {
    const world: Required<World> = { ...DEFAULT_WORLD, ...row.world };
    const facts: IdleFacts = { ...DEFAULT_FACTS, ...row.facts };
    const expected = idleDecision(facts, world.now, world.minutes, world.rdpMinutes);
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
    const displays = [{ n: '10', owner: 'alice', out: '7200000' }, { n: '11', owner: 'bob', out: '3600000' }];
    expect(run({ ...DEFAULT_WORLD, ss: [rdp], displays })).toBe('alice :10 /home/alice/.Xauthority\nbob :11 /home/bob/.Xauthority\n');
    const both = 'alice :10 /home/alice/.Xauthority\nbob :11 /home/bob/.Xauthority\n';
    expect(run({ ...DEFAULT_WORLD, ss: [ssh6], displays })).toBe(both);
    expect(run({ ...DEFAULT_WORLD, ss: [], displays })).toBe(both);
    expect(run({ ...DEFAULT_WORLD, ss: [], displays, xprintidle: 'absent' })).toBe('');
  });

  it('the table covers every decision kind of idleDecision (suspend, wait, each not-idle reason, each restart)', () => {
    const reasons = new Set(
      ROWS.map((r) => idleDecision({ ...DEFAULT_FACTS, ...r.facts }, NOW, r.world?.minutes ?? 30, r.world?.rdpMinutes ?? 20).reason.replace(/\d+(\.\d+)?/g, '#')),
    );
    for (const needle of ['suspending: idle # min', 'idle #/# min', 'keep-awake requested', 'cannot read the keep-awake files', 'rdp connected', 'ssh connected', 'machine peer connected', 'cannot read the connections', 'machine request in the last # min', 'machine request on hold', 'rdp connected (input # min ago, needs #)', 'suspending: rdp connected but no input for # min (needs #)', 'confirming at the next check', 'not idle: input # min ago (needs #)', 'input idleness not checked: xprintidle is not installed', 'input idleness not checked: no X display', 'rdp connected (xprintidle is not installed: sudo apt install xprintidle)', 'rdp connected (input idle unreadable: no X display', 'rdp connected (input idle unreadable: xprintidle failed on :# as alice)','cannot read the machine audit log', 'load # (limit #)', 'cannot read the load average', 'sleep inhibitor held', 'cannot list the sleep inhibitors', 'the clock went back', 'the state file is unreadable', 'no check for more than # min']) {
      expect([...reasons].some((x) => x.includes(needle)), needle).toBe(true);
    }
  });
});
