# macOS idle-suspend and wake-on-LAN (M2 Pro MacBook Pro)

STATUS 2026-11-26: a SKELETON exists in `machine-core` (`idleSuspendDarwin.ts`, `idleSuspendPlatform.ts`): platform dispatch of script and scheduler, the launchd plist shape (label ASSUMED U8, root, `StartInterval` = cadence of decision 113, no `RunAtLoad`), shared option validation, and `IDLE_DARWIN_MEASUREMENTS` mapping each unvalidated probe (resume-detection, ssh-classification, input-idle, power-assertions, connections, load-average, clock-parse, keep-awake-path, suspend-actuator) to its test of section 2. Every probe throws `not implemented: needs Mac measurement <id>`; the darwin script is not written. `machine install idle-suspend` on darwin is refused with the reason (`IDLE_DARWIN_UNAVAILABLE`); `platforms` stays `['linux']` until the measurements are in. Gaps in section 2: no test for a wake counter (resume detection) nor for the sshd login title / tty idle time (ssh classification). Open for the plan phase: the plist marker is an XML comment while `classifyInstalled` matches `# managed by ...`.

Below: SPEC, mostly NOT BUILT. Nothing here is code, a decision taken by the user, or measured on a Mac. User request 2026-11-23: "ajouter un idle-suspend pour le mac et pouvoir faire pareil pour le wake-on-LAN sur mon M2 Pro, j'aimerais pouvoir m'en servir comme la thinkcentre". Recorded as decision 108 (`_index.md`). Reference items: `idle-suspend.md` (Linux), `install.md` (lifecycle), `connectivity.md` (wake, section 9 measurements).

Tags: SOURCE (url + quote), SOURCE-3P (third party, not Apple: a claim by an author, weaker), USER (stated by the user), ASSUMED (no source, to measure), MEASURED (never: no Mac was reachable for this spec). Quotes were read through a page-summarising fetch tool: re-check the wording at the URL before relying on one.

## 1. Goal and non-goals

Goal: the MacBook Pro is a spare computer used like the thinkcentre: it suspends itself when really idle and `machine wake` / the auto-wake of `machine run` and `machine ping` can wake it.

USER facts (2026-11-23), the target configuration:
- MacBook Pro M2 family, host name `MacBook-Pro-de-Wadeck`, macOS version UNKNOWN.
- Used with the LID CLOSED if possible (to save the screen), on AC POWER, on ETHERNET (not Wi-Fi). No external display or keyboard was mentioned: UNKNOWN, asked in section 2.
- MEASURED by the user on his Mac (2026-11-23, pasted output): `pmset -g` shows `womp 0` (WoL is OFF today), `standby 1`, `powernap 1`, `hibernatemode 3`, `networkoversleep 0`, `tcpkeepalive 1`, and `sleep 1 (sleep prevented by powerd)`; `HIDIdleTime` is readable as the normal user (62007761666 ns = 62 s, so the unit is nanoseconds); three ports named "Ethernet Adapter" (`en4`, `en6`, `en7`) have locally administered MACs (first octet 62): none of them is shown to be the real hardware MAC, so the MAC to pin for the wake is NOT yet identified (never written in this repo).
- The M2 MacBook Pro has no built-in Ethernet port: ethernet means a dock or an adapter (ASSUMED, which one is UNKNOWN: measured in section 2).

Non-goals: Wi-Fi-only wake (section 4: no promise); powered-off wake (SOURCE below: impossible); a new right for any peer; a new peer command; changing the Linux item; shipping any code before the measurements of section 2 are in.

## 2. Facts to measure on the Mac before any code

All commands are READ-ONLY except test 12, which puts the Mac to sleep and says so. Paste the output (hide nothing, the relay host and MAC are not asked for).

| # | Command | Tells us |
|---|---|---|
| 1 | `sw_vers; sysctl hw.model; uname -m` | macOS version (which man pages and `launchctl` forms apply), model id, arm64 confirmed |
| 2 | `system_profiler SPHardwareDataType` | exact model (M2 Pro/Max), chip |
| 3 | `pmset -g` | active settings: `sleep`, `displaysleep`, `womp`, `powernap`, `standby`, `ttyskeepawake`, `lidwake`, `disablesleep` if shown, `hibernatemode` |
| 4 | `pmset -g custom` | the same per power source (AC, battery): the AC column is the one that matters |
| 5 | `pmset -g \| grep -E 'womp\|lidwake\|disablesleep\|sleep'` | is `womp` shown at all; the exact key names on this macOS |
| 6 | `pmset -g ps` | on AC or battery, battery state |
| 7 | `pmset -g assertions` | which sleep assertions are held now and by which process; the names `PreventUserIdleSystemSleep`, `PreventSystemSleep` as printed (no Apple man page lists them, section 3) |
| 8 | `pmset -g log \| grep -E 'Sleep\|Wake\|Clamshell\|Lid' \| tail -60` | sleep and wake reasons, with the lid closed too: shows whether the Mac slept at lid close and what woke it |
| 9 | `ioreg -c IOHIDSystem \| grep HIDIdleTime` then the same as `sudo`: `sudo ioreg -c IOHIDSystem \| grep HIDIdleTime` | the input idle time (ASSUMED nanoseconds), readable as user and as root. Run it twice 30 s apart with no input, and once after closing the lid for 1 min (open the lid, run again; SSH in from another machine to do it closed if the Mac stays awake) |
| 10 | `networksetup -listallhardwareports; route -n get default \| grep interface` | the hardware ports and the one carrying the default route; tells whether the active link is the dock/adapter or Wi-Fi |
| 11 | `ifconfig <interface from 10>` (the Ethernet one) and `system_profiler SPEthernetDataType` | link state, MAC of the NIC to pin for the wake, chipset of the adapter or dock |
| 12 | WAKE TEST (puts the Mac to sleep, see below) | whether a lid-closed, AC, Ethernet Mac wakes on a magic packet |
| 13 | `who; netstat -an -p tcp \| grep ESTABLISHED; sudo lsof -nP -iTCP -sTCP:LISTEN \| grep -E ':(22\|5900\|3283)'` | sessions, established connections (the local `ip.port` format of BSD netstat), listeners for ssh 22, screen sharing 5900, remote management 3283; the machine peer port is in `<configDir>/daemon.port.json` |
| 14 | `sysctl -n vm.loadavg; uptime` | load average format (BSD) |
| 15 | `command -v pmset caffeinate launchctl ioreg netstat lsof logger stat date sysctl networksetup; date -j -f '%Y-%m-%dT%H:%M:%SZ' 2026-11-23T10:00:00Z +%s` | tool paths (all expected in `/usr/bin`, `/usr/sbin`, `/bin`: ASSUMED) and that BSD `date -j -f` works |
| 16 | `ls -lde /Library/LaunchDaemons /Library/LaunchDaemons/* \| head; ls -ld /usr/local /usr/local/bin /usr/local/libexec /var/run` | the owner and mode every launchd plist has on this Mac, and whether the ancestors of the script path are writable by a non-root user (section 5) |
| 17 | `launchctl print system/com.apple.xpc.launchd 2>&1 \| head -3; sudo launchctl print-disabled system \| head -3` | whether a status can read launchd without a password (the `probe` of `install.md` must never prompt) |
| 18 | `sudo -k; pmset sleepnow` (as the normal user, expect a password prompt or a refusal; if it sleeps the Mac, note it) | whether `pmset sleepnow` needs root (no source says, section 3) |

Test 12 protocol (wake from lid closed). Needs a second machine on the same wired LAN, the Mac's Ethernet MAC from test 11 and its IP.
1. Mac: on AC, Ethernet connected, `sudo pmset -c womp 1`, then `pmset -g custom` shows `womp 1` on AC. Note whether `System Settings > Battery > Options > Wake for network access` shows "Only on Power Adapter" or "Always".
2. Variant A (lid OPEN control): from the Mac `pmset sleepnow`; wait 60 s; from the other machine `ping -c 3 <ip>` (expect no answer) then `machine wake <peer>` or any magic-packet sender; record whether it answers and after how long.
3. Variant B (lid CLOSED, no external display): close the lid first, wait until it is asleep (`ping` from the other machine stops answering; if it never sleeps or stays reachable, note that: it is a fact), send the magic packet as in A, wait 60 s, record.
4. Variant C (lid closed with an external display and keyboard, or a dummy HDMI plug, only if he has one): same.
5. Afterwards `pmset -g log | grep -E 'Wake|DarkWake|Clamshell'` on the Mac: the wake reason and time of each attempt, and `uptime`. Revert: `sudo pmset -c womp <previous value>` (it is 0 today, section 1).
6. Repeat the best variant with the dock NIC and the adapter NIC separately (which of `en4`, `en6`, `en7` is the real NIC: `networksetup -listallhardwareports` plus `ifconfig` `ether` of the one with status active; the MAC to pin is the hardware address printed there, check it is not a locally administered one, first octet with bit 2 set).
7. Delay: send the packet 30 min after sleep, then 8 h after sleep (`hibernatemode 3` and `standby 1` may turn a long sleep into a hibernation).
8. If a wake happens: note whether it is a dark wake (display off) and how many seconds the Mac stays reachable: from the other machine `ping` every second and `machine ping <peer>` immediately after the packet; `machine` can only run if the Mac stays awake long enough to connect (reports above: 5 to 10 s, 7 s).
9. Keep-awake alternative, lid closed no display, AC: `caffeinate -s` in a Terminal for 10 min, close the lid, from the other machine `ping` for the 10 min; then `pmset -g log | grep -E 'Sleep|Clamshell'`. Stop it with Ctrl-C after reopening.

## 2a. Measured on the real Mac (2026-11-27, read-only over ssh)

MacBook Pro M2 Pro (Mac14,10), macOS 26.5.2, arm64. Read-only commands of section 2 (rows 1-4, 6-10, 13-16 and `pmset -g therm`); rows 11, 12, 17, 18 not done yet.

| Fact | Measured |
|---|---|
| Tool paths | `pmset caffeinate ioreg netstat lsof logger stat date sysctl networksetup` all present (`/usr/bin`, `/usr/sbin`, `/bin`); `launchctl` is `/bin/launchctl` |
| `pmset -g` keys | `sleep`, `displaysleep`, `womp`, `powernap`, `standby`, `ttyskeepawake`, `tcpkeepalive`, `hibernatemode`, `networkoversleep`, `disksleep`; no `disablesleep`, no `lidwake`, no `acwake` printed |
| Wake for network | `womp 1` on AC, `womp 0` on battery (the "currently in use" block showed 0 because the Mac was on battery) |
| Sleep timers | `sleep 1` on AC and battery (the system sleeps 1 min after the last activity when nothing holds it), `displaysleep 30` on AC / 10 on battery, `ttyskeepawake 1` |
| Native idle sleep already works | log: `Entering Sleep state due to 'Idle Sleep'` with ssh sessions open whose ttys were idle; while the display is on `powerd` holds `PreventUserIdleSystemSleep` "Prevent sleep while display is on" |
| Dark wakes | the Mac wakes 2-3 s every 15-30 min (`DarkWake ... SleepService`, backupd/CoreAnalytics) and every 2 h (mDNSResponder upkeep): a script triggered by time may run in a dark wake |
| Resume signal | `sysctl kern.waketime` and `kern.sleeptime` exist and match the `pmset -g log` `Wake` and `Sleep` lines to the second (waketime 13:00:25 = log "Wake from Deep Idle"); NOT yet checked: whether a dark wake also moves `kern.waketime` |
| Input idle | `ioreg -c IOHIDSystem \| grep HIDIdleTime` readable as a normal user over ssh; value in nanoseconds (19460818958 = 19.5 s, consistent with a UserIsActive timeout) |
| Assertions | names printed as `PreventUserIdleSystemSleep`, `PreventSystemSleep`, `UserIsActive`, `NetworkClientActive`; an assertion line carries pid, name and timeout |
| BSD date | `date -j -f '%Y-%m-%dT%H:%M:%SZ'` reads the text as LOCAL time and ignores the `Z` (1795424400 = 09:00Z for 10:00Z): the script must use `date -j -u -f` (1795428000, correct) |
| BSD netstat | `ESTABLISHED` lines have `ip.port` (address then dot then port), e.g. `a.b.c.d.22 e.f.g.h.61199` |
| Load average | `sysctl -n vm.loadavg` gives `{ 9.41 4.57 4.87 }` (braces); idle load was not measured (the owner was working: a 0.30 limit like Linux is NOT valid here without an idle measurement) |
| Network | USB 2.5G Ethernet adapter active at 1000baseT, Wi-Fi also active, the default route is on Wi-Fi: Ethernet is NOT the primary link now (wake over Ethernet needs it primary) |
| Directories | `/Library/LaunchDaemons` root:wheel 755; `/usr/local` root:wheel 755; `/usr/local/bin` does NOT exist; `/var/run` root:daemon 775 |
| Thermal | `pmset -g therm`: no thermal, performance or CPU power warning recorded |
| Power state at the time | on battery (28 %), user active on the console |

Consequence for the design: macOS already sleeps by itself when idle and counts an active tty (`ttyskeepawake`), so a custom root script may not be needed. Simplest candidate: `machine install` sets `pmset` (sleep timer on AC, `womp 1`) and the daemon holds a `caffeinate -i` assertion while a request runs. Whether a notty ssh (Herdr) holds the Mac awake is NOT measured. Decision for the owner (U10), before any code.

### 2b. Wake test 1 (2026-11-27, lid OPEN, AC, `womp 1`, USB Ethernet adapter, user away)

| Step | Measured |
|---|---|
| `ssh mac-m2 pmset sleepnow` as the normal user | prints `Sleeping now...`, no password; the ping stops 8 s later; the log says `Entering Sleep state due to 'Software Sleep pid=...'` (so `pmset sleepnow` needs no root, test 18) |
| 3 magic packets (broadcast, UDP 9, MAC of the adapter) 62 s after the sleep | NO wake: `pmset -g log` shows no `Wake` between the sleep (13:16:13) and the next DarkWake (13:31:40, `rtc/SleepService`) |
| Ping while asleep | answered 4 times in 15 min (13:18:43, 13:22:23, 13:25:00, 13:29:43) while the log shows no wake: cause UNKNOWN (not a logged wake, so a ping answer is NOT a proof of wake) |
| Dark wakes on AC | every 15 min (`SleepService`, `rtc`), 45 s each (`Sleep Service Back to Sleep`, `Maintenance Sleep`), then every 2 h `upkeep wake` |
| Sleep proxy | `dns-sd -B _sleep-proxy._udp local` for 6 s found no Bonjour Sleep Proxy on the LAN |
| Adapter | Lenovo 2.5G USB-C to RJ45, vendor 0x0bda product 0x8156 (Realtek) |
| Charge Limit | the Mac charged 31 % (13:16) to 80 % (13:57) while asleep and stayed at `80%; AC attached; not charging`: the 80 % limit works |
| Battery health | 119 cycles, condition Normal, maximum capacity 100 % |

Conclusion so far: a magic packet to this USB Ethernet adapter does not wake this Mac (one test, lid open). Apple's wake for network access relies on a Bonjour Sleep Proxy (an Apple TV, HomePod or an awake Mac on the LAN), and none was found. The only periodic wakes are the 15 min dark wakes of 45 s.

### 2c. Wake over Wi-Fi (2026-11-27 15:15-15:23, lid open, AC, Wi-Fi address fixed by the owner)

| Observation | Measured |
|---|---|
| Ethernet adapter | `en8` status inactive at 15:15 (adapter no longer linked); the Wi-Fi address kept answering |
| Two network accesses to the sleeping Mac | a ping at 15:15:3x and an ssh connection at 15:23:11, each followed in the SAME second by `DarkWake ... due to smc.sysState.Wake(0x70070000) wifibt SMC.OutboxNotEmpty` in `pmset -g log`; the ssh connected and ran its command (no password, no timeout) |
| Who was at the Mac | nobody: `HIDIdleTime` 1936 s (32 min), `UserIsActive 0` |
| Duration of a dark wake | 15:15:41 to 15:16:27 (46 s) then `Entering Sleep state due to 'Maintenance Sleep'`; dark wakes by the clock last 45-61 s |
| `kern.waketime` | moves at a DARK wake (15:23:11 = the DarkWake line): a change of `kern.waketime` is NOT a user resume |
| Ping while asleep | the Wi-Fi address answers pings while `pmset -g log` shows the system asleep (15:16:27-15:23:11): a ping answer is not a proof of wake |
| `pmset sleepnow` during a dark wake | printed `Sleeping now...` but the Mac stayed reachable (the sleep came 17 s later, `Maintenance Sleep`) |

Full wake from a dark wake (15:25:08, lid open, AC): over ssh, `caffeinate -u -t 12` (man page: "declare that user is active; if the display is off, turns the display on") produced `DarkWake to FullWake from Deep Idle [CDNVA] : due to HID Activity` and `Display is turned on`; `powerd` then held `PreventUserIdleSystemSleep` "Prevent sleep while display is on". So a connection (dark wake) plus `caffeinate -u` is a way to a full wake without any magic packet. Not measured: lid closed, how long the Mac stays up afterwards.

Run commands with the display OFF (owner goal 2026-11-27: the point is to run commands, a dark display is a perk), lid open, AC:

| Assertion held over ssh after the dark wake | Result |
|---|---|
| `caffeinate -i -t 100` (PreventUserIdleSystemSleep) | NOT enough: the Mac still went to `Maintenance Sleep` 45 s after the wake (15:31:06 to 15:31:51) and the ssh stalled |
| `caffeinate -s -t 100` (PreventSystemSleep, AC only) | WORKS: `DarkWake ... 126 secs` (15:35:09 to 15:37:15), the ssh session stayed alive the whole time (checks every 18 s), no `Display is turned on` in the log; `Maintenance Sleep` came 3 s after the assertion ended |

So: connection (dark wake, display off) plus `caffeinate -s` for the duration of the job keeps the Mac usable with the display off, and it sleeps again by itself right after. `-s` has no effect on battery power (man page), so on battery the Mac can still sleep under a job. Also seen: keepalive packets of an open ssh session wake a sleeping Mac (dark wake) the same way as a first connection.

Two observations, same cause string both times: wake for network access works over Wi-Fi for this Mac (lid open, AC). Not yet measured: the delay from the first packet to a usable ssh, lid closed, and whether a port other than 22 (the machine peer port) triggers the wake.

### 2d. Enrollment and wake with the `machine` CLI (2026-11-28 10:37-11:00, lid CLOSED, AC)

Conditions, read on the Mac: `ioreg` `AppleClamshellState = Yes` (lid closed; `pmset -g log`: `Clamshell Sleep` 2026-11-27 17:30:20 and 17:44:08, nobody opened it since), `AppleClamshellCausesSleep = No`, `AC attached; not charging` at 80% (charge limit), `pmset -g`: `sleep 1 (sleep prevented by powerd)`, `displaysleep 30`, `womp 1`, `ttyskeepawake 1`. The earlier statement "lid open" in the notes of 2026-11-28 was an assumption: every result below is lid closed.

| Observation | Measured |
|---|---|
| Wake by `machine wake` | `connections.json` of midgard2: type `ping-if-not-reachable-magic-packet`, the Wi-Fi (en0) MAC as wake MAC, `--wake-wait 60`, `--wake-probe 15`, one broadcast. Mac asleep since 10:54:04 (`Maintenance Sleep`). `machine wake` at 10:54:24: first packet at 0.5 s (hedge), answered at 1.1 s. `pmset -g log`: `DarkWake ... wifibt SMC.OutboxNotEmpty` at 10:54:26. One measurement; the packet or the TCP connection woke it: not distinguishable (decision of 2c: the Wi-Fi connection wakes it) |
| `machine ping` without a wake window | the default of `type direct` tries ONE connection of 3 s: asleep (10:53:01) it failed twice (`no answer from 192.168.1.211:47921 within 3000 ms`) while an ICMP ping answered in 92 ms (asleep, as in 2c); the third ping, once the Mac was awake, answered (handshake 25.3 ms, hello 16.1 ms). A sleeping Mac needs a wake type with a window, not `direct` |
| Dark wake cadence this morning | sleeps/wakes of 22-100 s: 10:50:21 Sleep, 10:52:01 DarkWake (46 s), 10:52:47 Sleep, 10:53:18 DarkWake (46 s), 10:54:04 Sleep, 10:54:26 DarkWake. Yesterday 15:15-15:35 the dark wakes were about 15 min apart. Cause of the shorter cadence not established (ssh sessions and keepalive packets of my own tests were open) |
| Enrollment | `machine join` from midgard2 over ssh (no terminal): candidacy posted, approved from the Candidacies page at 10:45, the Mac printed its security code `19349 56268 78835 95644 83443` and stopped (`no terminal to confirm the security code ... the admin key was NOT pinned`), then `machine join --resume --yes-final-code "<code>"` pinned the admin key `6d6f2446353bbb027ebd7ddc4d1df56b` and trusted midgard2 |
| Security code comparison | NOT done visually: the user clicked "Codes match" on the page without the Mac code in front of them (the Mac code was in a log read over ssh, not shown to them). The relay purged the candidacy afterwards, its random lives only in the Mac's candidacy file: the admin side cannot recompute the code. What was verified instead: (1) the admin key id printed by the Mac equals the admin key id of midgard2 (`admin.json`), (2) after `machine startup enable` on the Mac, `machine ping` from midgard2: `proved the identity key pinned by its registration and the pair secret (mutual TLS 1.3)`, revocation lists equal (version 0). (1)+(2) exclude a swapped admin key and a swapped candidate key, but they replace the human comparison of the protocol: decision to take again at the next onboarding (show the Mac code to the user BEFORE the approval, keep the admin code recallable, see admin-ui.md) |
| Startup job | `machine startup enable` over ssh: staged launcher job added, daemon started on peer port 47921, `netstat` LISTEN `*.47921`; the version shown after the update was `2026.11.28-219-93357566` |
| Pitfalls found | (a) `/usr/bin/machine` is a macOS system tool: with `/usr/bin` first in PATH `machine join --resume` printed `machine: no arguments accepted`; the CLI is `~/.nvm/versions/node/v24.11.1/bin/machine`. (b) a non-login ssh has no node in PATH: the launcher printed `env: node: No such file or directory` until the nvm bin folder was added to PATH. (c) three relay login requests were approved for one machine (two `join` runs lost, one `--force`): one candidacy per identity key at a time, `409 Another token already has a pending candidacy with this identity key` until it expires (15 min) |
| Alias | `machine alias set mac-m2 macbook-pro-de-wadeck` on midgard2 (local label; the signed name is unchanged, rename is decision-pending, see admin-ui.md) |

Not measured yet: battery power (`caffeinate -s` has no effect there), a command through `machine run` under `caffeinate -s` (no allow entry on the Mac yet), a held request while the Mac sleeps, wake-to-run delay of a real command, the stability of the dark wake cadence over hours, and the wake of the Mac by the peer port 47921 alone (the 1.1 s above used the hedged packet and the connection together).

## 3. Facts from sources (power management, launchd)

| Fact | Source |
|---|---|
| `pmset sleepnow` exists: "sleepnow - causes an immediate system sleep." | SOURCE https://keith.github.io/xcode-man-pages/pmset.1.html (also https://www.manpagez.com/man/1/pmset/) |
| Root: "pmset must be run as root in order to modify any settings." Whether `sleepnow` (an action, not a setting) needs root: no source found | SOURCE same page; the `sleepnow` question is UNKNOWN, test 18 |
| `womp`: "wake on ethernet magic packet (value = 0/1). Same as 'Wake for network access' in System Settings." Ethernet only in the wording; Wi-Fi is not mentioned | SOURCE https://keith.github.io/xcode-man-pages/pmset.1.html |
| `powernap`: "enable/disable Power Nap on supported machines (value = 0/1)" | SOURCE same page |
| `lidwake`: "wake the machine when the laptop lid (or clamshell) is opened (value = 0/1)". The man page says nothing on running with the lid closed | SOURCE same page |
| `ttyskeepawake`: "prevent idle system sleep when any tty (e.g. remote login session) is 'active'. A tty is 'inactive' only when its idle time exceeds the system sleep timer." So an ssh session with a tty can keep an idle Mac awake (default value: no source found) | SOURCE https://www.manpagez.com/man/1/pmset/ |
| `-g assertions`: "displays a summary of power assertions. Assertions may prevent system sleep or display sleep." The type names `PreventUserIdleSystemSleep` and `PreventSystemSleep` are in none of the man pages or Apple pages read: no source found for their meaning | SOURCE https://keith.github.io/xcode-man-pages/pmset.1.html; names UNKNOWN until test 7 |
| `-g log`: "displays a history of sleeps, wakes, and other power management events. This log is for admin & debugging purposes." | SOURCE same page |
| `pmset disablesleep` is NOT in the pmset man page read (current Xcode man pages). Third-party reports: "the one built-in switch is sudo pmset disablesleep 1", "turns sleep off for the whole system, on battery too", "stays on after a restart until someone turns it off again" (needs "Apple silicon and macOS 26 or later" per that author) | SOURCE-3P https://github.com/artginzburg/macOS-should-ship-with/issues/1 (a promotional post by a tool author) |
| `caffeinate`: `-i` "Create an assertion to prevent the system from idle sleeping."; `-s` "Create an assertion to prevent the system from sleeping." and "This assertion is valid only when system is running on AC power."; `-t` timeout; `-w` waits for a pid | SOURCE https://keith.github.io/xcode-man-pages/caffeinate.8.html |
| Lid closed with no external display: "Setting Keep computer awake to On does not keep a MacBook awake after the lid is closed with no external display." "-i prevents idle system sleep (idle timer). Lid close is not idle sleep." "A hard veto of lid-close sleep is sudo pmset disablesleep 1 (or equivalent)", "a global, privileged, thermal-sensitive change"; the maintainer avoids it "because of thermal and battery safety risks" | SOURCE-3P https://github.com/stablyai/orca/issues/20194 (an issue of another project: chip and macOS version not given) |
| Closed lid WITH an external display: the MacBook Pro guide says only "you can close the lid and continue to use it with connected accessories" (display and accessories such as keyboard and mouse); it says nothing on sleep, power adapter or the word "clamshell" | SOURCE https://support.apple.com/guide/macbook-pro/connect-an-external-display-apd8cdd74f57/mac |
| No Apple source found on: Apple silicon MacBook closed with NO external display (sleeps or not), the heat or battery effect of `disablesleep`, and `HIDIdleTime` (the ioreg key is ASSUMED to exist and to count nanoseconds, test 9) | no source found |
| launchd `StartInterval`: "This optional key causes the job to be started every N seconds." Two wordings: older "If the system is asleep, the job will be started the next time the computer wakes up" (intervals merged); newer a firing "is skipped if the system is asleep or the job is already running". Either way a sleep makes a gap, which the 300 s gap rule of the Linux design already treats as a restart | SOURCE https://www.manpagez.com/man/5/launchd.plist/ and https://keith.github.io/xcode-man-pages/launchd.plist.5.html |
| `UserName`: "This optional key specifies the user to run the job as." Applies only to the privileged (system) domain. A LaunchDaemon with no `UserName` runs as root (Apple: `launchd` runs as root, "Do not set the user or group ID for your daemon. Include the UserName, UID... keys") | SOURCE same pages and https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html |
| Ownership: "Daemons and agents that are installed globally must be owned by the root user." and "All daemons and agents must not be group writable or world writable." (the parenthetical says mode `600` or `400`, while system plists are usually 0644: test 16 shows what this Mac has) | SOURCE https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html (archived document, old). Whether the PROGRAM and its folders must be root-owned: no source found (a root job running a user-writable script would be a privilege escalation anyway: section 5) |
| Directory: "Property list files describing daemons are installed in /Library/LaunchDaemons"; `/Library/LaunchDaemons`: "System-wide daemons provided by the administrator." | SOURCE same pages |
| `launchctl bootstrap` / `bootout` / `print` forms: no page read. ASSUMED for the plan, tested by the golden test only as argv, to measure (test 17) | no source found |

## 4. Wake-on-LAN for this MacBook

Known from sources:
- "Wake for network access" exists on laptops under Battery > Options, with a pop-up menu; it "lets your Mac wake briefly so users can access shared services". SOURCE https://support.apple.com/guide/mac-help/set-sleep-and-wake-settings-mchle41a6ccd/mac and https://support.apple.com/guide/mac-help/share-your-mac-resources-when-its-in-sleep-mh27905/mac ("Some of the options may not be available, depending on your Mac"). Those pages describe waking by "a user on another computer" accessing shared resources and a periodic wake to advertise them; they do not say "magic packet", Wi-Fi, Ethernet or lid.
- The options of the pop-up are "Always", "Only on Power Adapter" or "Never" on laptops. SOURCE-3P https://en.wikipedia.org/wiki/Wake-on-LAN (the Apple page does not list them).
- The author of the Sleep Proxy, https://stuartcheshire.org/SleepProxy/ (an old page, AirPort era, Energy Saver prefs): "Sleep Proxy wakeup is supported on all Macs connected via Ethernet."; the sleeping Mac "needs to have 'Wake for network access' enabled"; "In the case of a laptop, due to power management rules enforced by the current system software, it needs both (a) to be connected to AC power and (b) to have a display available (either lid open, or an external display connected)."; for Wi-Fi: waking is possible in principle "but there have been reports of it not working reliably", and needs a base station that supports Wake on Wireless LAN. That page is about proxy-initiated wake (a Bonjour service request seen by an always-on AirPort or Apple TV), which is not our magic packet.
- A Sleep Proxy wakes a Mac only for Bonjour-advertised services, not for a ping; ssh (port 22) is the exception. SOURCE https://stuartcheshire.org/SleepProxy/ . `machine` is not a Bonjour service: it is not covered.
- Wi-Fi in general: "Most 802.11 wireless interfaces do not maintain a link in low-power states"; Wi-Fi needs Wake on Wireless LAN. SOURCE-3P https://en.wikipedia.org/wiki/Wake-on-LAN . Our own analysis said the same: `connectivity.md` 4.1 ("unreliable in general (GK). Do not promise it").
- From a powered-off Mac: "it is not possible to wake up a Mac computer from a powered-off state". SOURCE-3P same Wikipedia page. Safe sleep exists on laptops (state saved, then possible full shutdown if the battery is exhausted): https://support.apple.com/guide/mac-help/what-is-safe-sleep-mh10328/mac . `pmset standby` "causes kernel power management to automatically hibernate a machine after it has slept for a specified time period", "defaults to ON for supported hardware" (same pmset page): a long sleep may be a hibernation; whether a magic packet wakes a hibernated Apple silicon Mac: no source found.
- The M2 family MacBook Pro Wi-Fi is 802.11ax (https://support.apple.com/guide/deployment/wi-fi-ethernet-specifications-apple-devices-dep268652e6c/web, listing "MacBook Pro 16-inch, M2, 2023" and the 14-inch): the page says nothing on wake.

What this means for the user's configuration (lid closed, AC, Ethernet):
- Wi-Fi: no Apple source says a sleeping Wi-Fi MacBook wakes on a magic packet; the two sources that discuss it say "not reliably" and "must be employed". VERDICT: reliable wake of a sleeping Wi-Fi-only MacBook by a magic packet is NOT supported by any source found; do not promise it. Not the user's setup (Ethernet).
- Ethernet + AC + lid OPEN: matches the only documented case (Cheshire: Ethernet, AC, display available). Whether the NIC of a dock or USB/Thunderbolt adapter keeps listening in sleep and honours `womp`: no source found (depends on the adapter, ASSUMED); test 12 variant A.
- VERDICT after section 4a: reports found for Ethernet + AC + lid closed + no display: 0 positive, 1 direct negative; Apple Silicon wake over any link is mostly reported as failing. Plan on "a magic packet will NOT wake this Mac" until test 12 proves otherwise; section 4a lists the real alternatives.
- Ethernet + AC + lid CLOSED with NO external display: the only source that mentions it says a laptop needs "a display available (either lid open, or an external display connected)" for the Sleep Proxy wake. By that source a lid-closed, display-less Mac is NOT a supported wake case; a raw magic packet to the NIC is not discussed by any Apple source. Unknown, test 12 variant B decides. SOURCE-3P also says the Mac sleeps at lid close with no external display whatever `caffeinate` says, so the Mac may be asleep as soon as the lid closes.
- Lid closed WITH an external display and keyboard (closed-display use, section 3): the Mac stays usable; wake rules unknown (variant C).
- `machine` side, unchanged: the sender pins the NIC MAC (`machine peer connect --wake-mac`), `planWakeSteps` sends broadcast then unicast (connectivity.md 8, 9.1: on the Linux box unicast alone never woke it, broadcast did). The Mac's wake time after a magic packet is unknown (Linux: about 7 s).
- If the Mac must be on a LAN reachable only through Wi-Fi at some other time: nothing changes here, same verdict as above.

Alternatives and cost:

| Option | What it gives | Cost |
|---|---|---|
| A. Ethernet dock + AC + `womp 1` + lid open or external display | the documented case | the lid stays open (or a display is connected): contradicts "lid closed to save the screen" unless the screen is turned off (`displaysleep`), which keeps the Mac wakeable (an open lid with the display asleep: UNMEASURED) |
| B. Keep the Mac awake instead of sleeping it: `caffeinate -s` (AC only) or `pmset -c sleep 0` | always reachable, no wake needed | power and heat; with the lid closed and no external display `caffeinate` does not stop the lid sleep (SOURCE-3P); `pmset disablesleep 1` would, with the thermal and battery warnings above (SOURCE-3P); a closed lid with no display hides the heat |
| C. A waker peer on the same LAN (todo #48 wake phase B, `connectivity.md` 4.5) | wake from another network | a new signed right and threat-model rows (rule 10: not decided, not built); does not solve a Mac that cannot be woken at all |
| D. Wake by hand (open the lid / key press) | works, SOURCE: "Press a key on the keyboard, or click the mouse or trackpad" and "On a Mac laptop, open the display." (https://support.apple.com/guide/mac-help/put-your-mac-to-sleep-or-wake-it-mh10330/mac) | not remote |
| E. Wi-Fi only and sleeping | not supported by any source | do not offer |

## 4a. Evidence from user reports (2026-11-23 research)

Reported to this spec by a second research agent (pages fetched through the Stack Exchange API, the PullPush Reddit archive, GitHub and Hacker News APIs); I did NOT re-fetch them. M = the reporter measured it, A = the reporter asserted it. All are third-party and anecdotal. Hardware is as the report states it.

Result: magic packet on Apple Silicon MacBook, AC, Ethernet, lid closed, no display: 0 positive, 1 direct negative. Overall 1 positive (anecdotal, with an external display) against 8 negative (6 Apple Silicon or unspecified, 2 Intel).

| Report | Setup | Result | M/A |
|---|---|---|---|
| reddit.com/r/MacOS/comments/1bi3hbp (2024-03-18) | M1 MBP 13, Sonoma 14.4, USB-C Ethernet adapter, womp on | cannot wake, not even the login screen | M |
| same thread | M1 Air, Wi-Fi | cannot wake | M |
| github.com/Ylianst/MeshAgent/issues/238 (2024-04-04) | M1 Air, Wi-Fi | agent offline while asleep | M |
| apple.stackexchange.com/q/435148 | M1 Mac mini, Ethernet | no wake, or awake 5 to 10 s then asleep again | M |
| talk.tidbits.com/t/wake-on-lan-with-apple-silicon/33183 (2026-03-31) | M1 Mac mini, womp 1, same subnet | WoL failed; TeamViewer support says not reliable on Apple Silicon | M |
| apple.stackexchange.com/q/461244 (2023-06) | 2019 Intel MBP, Ventura, lid closed, USB-C Ethernet | WoL fails | M |
| reddit.com/r/apple/comments/151up54 (2023-07) | MBP (chip not stated), clamshell WITH external monitor, AC | a WoL app wakes it every time | A |
| news.ycombinator.com/item?id=45159910 | M-series MacBooks, lid shut | stay asleep with WoL off, occasional misbehaviour with it on | M |
| github.com/gjovanov/roomler-ai/issues/1154 | MacBook, AC, lid open or closed, womp 1 | "Clamshell Sleep" on AC despite power assertions; a dozing Mac went back to sleep 47 times in about 1 h 43, 7 s after each wake (sleep behaviour, not WoL) | M |
| github.com/NousResearch/hermes-agent/pull/134353 (2026-10) | Apple Silicon MacBook, AC, lid closed, display not stated | `caffeinate -s` kept it awake; `caffeinate -i` and `pmset sleep 0` did not (Clamshell Sleep after about 5 s) | M |
| github.com/clintcan/macrdp/pull/107 | AC, lid closed | Clamshell Sleep on AC; an RDP SYN does not wake it | M |
| apple.stackexchange.com/q/454554 | M2 MBP 2022, HDMI monitor, lid closed, `disablesleep 1` | on battery cannot be woken from the keyboard, on AC can | M |
| apple.stackexchange.com/q/464592 | M1 Air, macOS 13.5.1, lid open, AC | still sleeps after about 2 h despite `disablesleep 1` | M |
| apple.stackexchange.com/q/443145 | Intel MBP, Catalina, HDMI display | WoL gives a dark wake (display stays off) | M |

Pending: a 48 h soak in github.com/abyssparanoia/varjo/issues/7 (M1 Max MBP 16, macOS 27.2, lid closed, `sleep 0`, `womp 1`): no result yet.

Contradictions, unresolved:
- `caffeinate -s` holds a lid-closed Mac awake on AC (hermes, M) versus "caffeinate cannot" (stablyai/orca#20194, section 3). Reconciliation offered: `-i` fails, `-s` works; only hermes measured `-s`. Not tested on the user's Mac.
- HN 33850511 (2022) asserts "Wake for network access" is not WoL on Apple Silicon; HN 50432465 (2026-11) says WoL works when enabled. Neither measured.

Recipes seen, NONE measured for our exact case (AC, Ethernet, lid closed, no display): `caffeinate -s` on AC; `pmset -a disablesleep 1` (failed on an M1 Air lid open); Amphetamine closed-display mode (greyed out on an M2, q/454554); a dummy HDMI plug (recommended on apple.stackexchange.com/q/415539, not measured); a Bonjour Sleep Proxy (Apple TV or HomePod) handles Bonjour services only, not WoL.

UNKNOWN, to settle on the user's Mac: whether a wired, AC, lid-closed, no-display M2 MBP honours a magic packet at all; the behaviour of a dock or adapter NIC in sleep; the length of a dark wake; the effect of `hibernatemode` and `standby` (the Mac has `hibernatemode 3`, `standby 1`).

## 5. Idle-suspend design for macOS

### 5.00 Final design (2026-11-27, decision 114c, option C; supersedes 5.0 to 5.3 and U1 to U3)

- Sleep: the native macOS sleep timer (`pmset sleep`, already `1` min on this Mac, measured 2a). No root script, no LaunchDaemon, no `idleDecision` port.
- Wake: a network connection (ping, ssh, keepalive) wakes the sleeping Mac into a dark wake of about 45 s with the display off (2c, over Wi-Fi, AC, lid open). No magic packet needed.
- Job: every command run through `machine-exec` on darwin is started as `/usr/bin/caffeinate -s <shell and args>` (`withKeepAwake`, `runCommand`). The assertion ends with the child; the Mac sleeps again 3 s later (measured 2c). `-i` is not enough, `-u` and `-d` are not used (the display stays off).
- Daemon: holds no assertion.
- `machine-exec` fails the run when `/usr/bin/caffeinate` is missing or not executable (never runs unwrapped). Everything else (exit code, output cap, timeout tree kill, argv) is unchanged. Threat model: T-71.
- `machine install idle-suspend` stays refused on macOS; the message points here.
- Caveat: `-s` has no effect on battery (man page), so on battery the Mac can still sleep under a job.

Open points to measure on the Mac (none done):

| # | Question |
|---|---|
| M1 | Battery: does a job survive a dark wake end without AC? Expected no (man page); how long does it run, and does the job die or freeze? |
| M2 | Held request while asleep: a `run --wait` or detached job started at a dark wake, then the connection idle: does the Mac sleep when the job ends, and does a held request (no child) wake it? |
| M3 | Lid closed (AC, no display): does a connection wake it, and does `caffeinate -s` keep it up? |
| M4 | Delay from the first packet to a usable ssh/peer connection; whether peer port (not 22) wakes it. |
| M5 | `caffeinate -s <path> <args>` without `--` with a real `/bin/sh -c "<cmd starting with ->"`: confirm the utility's args are never parsed as options (argv is passed after the utility; unverified on macOS). |
| M6 | Real run on macOS of `runCommand` (exit code, tree kill on timeout, output cap) through the real `caffeinate`; the tests use a fake wrapper. |
| M7 | MEASURED (2026-11-27, real Mac, security review A2, A4): `caffeinate -s <utility> <args>` execs the utility (the spawned pid becomes the utility) and a separate caffeinate helper, a child in the same process group, holds the assertion and exits when the utility ends. (1) Exit code and signal seen by the parent are the utility's own (a signal death shows as 143 through sh). (2) A group kill (`process.kill(-pid)`, detached) ends both. (3) Killing only the helper leaves the utility running unwrapped (LOW, same-user local actor only; accepted, the job is not failed). (4) Option-looking args after the utility reach it untouched (`-s -u -d` arrived as `$0 $1 $2`); a command text starting with a dash fails identically with and without the wrapper (sh behavior). |

Superseded sections below stay as the record of the alternative (A/B, root script).

### 5.0x Original principle

Principle: the decision is the same pure function `idleDecision` of `machine-core` (checks 1 to 5, the state file, the 300 s gap rule, `N` minutes). Only the FACT sources and the actuator change. Parity with `idle-suspend.md`; nothing below is built.

### 5.0 First check: is it needed at all?

macOS has its own idle sleep timer (`pmset sleep <minutes>`, "system sleep timer (value in minutes, or 0 to disable)") that already honours power assertions. On Linux the built-in logind rule failed for a known reason (xrdp session keeps `IdleHint=no`). On the Mac the reason it would fail is UNKNOWN: tests 3, 4, 7 show whether `sleep` is set, and which assertion (including ssh tty, `ttyskeepawake`) keeps it awake. If the Mac sleeps correctly with `sudo pmset -c sleep 15` and the only gap is "an established machine peer connection or a recent machine request must keep it awake", a smaller item may do. DECISION U1.

### 5.1 Facts (macOS sources, `idleDecision` unchanged)

| Check | Linux source | macOS source (ASSUMED until measured) |
|---|---|---|
| 1 keep-awake | `/run/machine-keep-awake`, `<config dir>/keep-awake` | `/var/run/machine-keep-awake` (`/run` does not exist on macOS: ASSUMED, test 16) and `<config dir>/keep-awake`, same format |
| 2 connections | `ss -Htn state established`, ports 3389, 22, `peerPort` | `netstat -an -p tcp`, lines with `ESTABLISHED`, LOCAL address `ip.port` (BSD format, the last dot); ports 22 (Remote Login), 5900 (Screen Sharing), 3283 (Remote Management), `peerPort`. 5900 and 3283 act as the RDP row: counted only while the input idle is under R min |
| 2b / input idle | `xprintidle` per logind session | `ioreg -c IOHIDSystem`, `HIDIdleTime` (ASSUMED nanoseconds), read by the root script directly if test 9 shows root can read it, else as the console user (`stat -f %Su /dev/console`, `launchctl asuser <uid>`). No session list is needed: one value for the machine. Lid closed: HIDIdleTime may keep growing or be meaningless (UNKNOWN, test 9): then the rule "input must be idle N min" is true while a person sits at an attached keyboard? Decided only after test 9 |
| 3 audit log | `<config dir>/audit.log`, `date -u -d` | same file; timestamps parsed with BSD `date -j -u -f '%Y-%m-%dT%H:%M:%S'` (ISO with milliseconds: strip them first); no GNU `-d` |
| 4 load | `/proc/loadavg` | `sysctl -n vm.loadavg` (`{ 0.52 0.40 0.31 }`: the middle number is the 5-min average) |
| 5 sleep blockers | `systemd-inhibit --list` lines on `sleep` ending in `block` | `pmset -g assertions`: an assertion of type `PreventUserIdleSystemSleep` or `PreventSystemSleep` with count above 0 blocks; ignore list for the ones that are always there (names from test 7; `powerd`/`caffeinate` we start are not ignored). Display-only assertions do not count. ASSUMED parse |
| actuator | `systemctl --no-block suspend` | `pmset sleepnow` as root (the daemon is root; no sudo). With a held `disablesleep 1` whether `sleepnow` still sleeps: UNKNOWN (test 18 variant after disablesleep is a later test) |
| state dir | `/run/machine-idle-suspend/since` | `/var/run/machine-idle-suspend/since` (root-owned 0755 dir, ASSUMED cleared at boot like `/run`: boot persistence of a stale file is covered by the gap and clock rules) |
| journal | `logger -t machine-idle-suspend`, `journalctl -t` | `/usr/bin/logger -t machine-idle-suspend` AND a one-line file `/var/run/machine-idle-suspend/last` (0644, rewritten each check) because `journalctl` does not exist and reading the unified log needs `log show` with a predicate (cost and permissions UNMEASURED); `status` reads the `last` file without sudo |
| resume protection | 300 s gap rule | unchanged (works even if launchd skips firings during sleep, section 3) |

Fail closed everywhere, as Linux: any unreadable fact (netstat, HIDIdleTime, assertions, load, audit log) is "not idle", the cause in the line (P-2).

### 5.2 Mechanism

- A LaunchDaemon, root: `/Library/LaunchDaemons/com.wadeck.machine-idle-suspend.plist` (label to confirm, U8), `root:wheel`, 0644, no `UserName` key (runs as root), `ProgramArguments` = [absolute script path], `StartInterval` 120 (a fixed cadence of the v7 design; decision 113 gives the Linux timer 30 s, 1 min or 2 min, to decide for macOS), `RunAtLoad` false (the Linux timer waits 2 min after boot; a gap rule covers the first check), `StandardOutPath`/`StandardErrorPath` unset (the script logs itself). Marker as a first-line XML comment `<!-- managed by machine install idle-suspend, version 1 -->` (the plist grammar accepts comments, ASSUMED: plutil -lint in the golden test and in the install step).
- Script: POSIX `sh` generated by a darwin variant of `idleSuspendScript`, `root:wheel` 0755. Path: NOT in a folder a non-root user can write (a root job running a user-writable file is a privilege escalation; Apple says only plists "must be owned by the root user" and "not group writable or world writable", nothing on the program: no source found, so the rule is ours). Candidates `/usr/local/libexec/machine-idle-suspend`, `/Library/Application Support/machine/machine-idle-suspend`; the plan refuses (loudly, with the fix) when any ancestor directory is not root-owned or is group/world writable (read with `stat -f '%Su %Sp'`). Test 16 shows if `/usr/local` exists and its owner (U5).
- Steps (sudo on the owner's terminal, no y/N, decision 107): stage, validate (`plutil -lint` on the staged plist and `sh -n` on the script: a failed validation installs nothing), `sudo install -m 0755 -o root -g wheel` script, `sudo install -m 0644 -o root -g wheel` plist, `sudo launchctl bootstrap system <plist>` (ASSUMED form; a reinstall is `bootout` then `bootstrap`; `kickstart` optional), probe = a read that never prompts (test 17 decides: `launchctl print system/<label>`, else a freshness check on the `last` file, else `sudo -n`). Remove: `bootout`, `rm` plist, script, state dir; post-check as in `install.md`. `--dry-run`, `--check`, `--refresh`, `--remove`, `status`, the marker rules, foreign-file refusal and `--minutes`/`--rdp-minutes` (the latter named for the remote-session rule; U7) are the generic lifecycle, unchanged.
- No sudoers rule and no peer command for idle-suspend itself: the daemon is root. A peer-triggered `suspend` like the Linux item (`machine run <mac> -- machine-suspend`) is a separate decision U3: it needs a sudoers rule exactly when `pmset sleepnow` needs root (test 18; no source), and the same "every trusted peer can suspend this machine" consequence as T-51 (e).

### 5.3 What is reusable and what differs

Reusable as is (docs; code not re-read for this spec except the lines named): `idleDecision` and its constants (`idleSuspend.ts`: `IDLE_GAP_SECONDS` 300 (floor; the gap is now `max(300, 10 x cadence)` and the cadence 30, 60 or 120 s follows the three minutes options, decision 113: `IDLE_CHECK_SECONDS` was removed), load limit 0.30, audit tail 2000), the `Installable` shape and lifecycle contract (`install.md`), marker/foreign/outdated states, status wrapping, `machine status` line, `summaryLine`, the plan/steps/`removeSteps`/`probe` data, the executor's fs/exec injection, the CLI flags.

Differs (darwin only):
- `install.ts` `platforms: ['linux']` of `IDLE_SUSPEND` (line 418) gains `'darwin'`; `FRIENDLY` already maps `darwin` to `macos`. The unsupported text `not supported on macos yet (supported: linux)` becomes the platform list.
- Facts: tool paths measured by the executor (`pmset`, `launchctl`, `ioreg`, `netstat`, `sysctl`, `logger`, `stat`, `date`, `plutil`), no `ss`, `systemd-inhibit`, `loginctl`, `runuser`, `xprintidle`, `journalctl`, `systemctl`.
- Files: plist instead of two units, no `service` probe (that field is systemd-specific in `install.md`).
- Script template: a second generator (BSD `date -j -f`, `stat -f`, `sed -E` without GNU extensions, no `\+`, `\|` or `\b` in `grep`, `sort`/`awk` as in POSIX). A shared "decision tail" (state file, gap, suspend) stays one template to avoid two divergent copies (U6).
- Constants: state dir, keep-awake path, ports, script path, version number of the darwin script.

## 6. Threat model deltas (to add to `threat-model.md` when built)

Row T-69 (proposed, not added yet, "spec only"): `machine install idle-suspend` on macOS.

| Item | Treatment |
|---|---|
| Right for a peer | none: no network surface, no command, no sudoers rule (idle-suspend); a peer keeps the Mac awake only by sending commands. Hard rules 1 to 11 untouched |
| Sudo | the owner's password at the terminal, typed to sudo (hard rule 8); no terminal is a refusal (`install.md`) |
| Root script | generated from a fixed template, validated integer minutes and whitelisted absolute paths only (T-51/T-68 rule); root:wheel 0755, in a folder with no non-root-writable ancestor, checked by the plan; a `foreign` file is never touched |
| Plist | root:wheel 0644 in `/Library/LaunchDaemons` (Apple: owned by root, not group/world writable); no `UserName` |
| Inputs the owner can write (keep-awake, audit log) | can only prevent or, by the owner, allow the suspend of his own Mac (as Linux) |
| `pmset disablesleep 1` (only if U2 chooses it) | a global privileged change that widens nothing for peers but removes the Mac's own protection against sleep/heat; never done silently, always with a revert path: needs its own T-row and a note in `install.md` |
| Wake | magic packets keep the existing T-rows (connectivity.md 4.6, decision 62); a closed-lid Mac cannot be made reliably wakeable by any packet: nothing here changes sender-side limits |
| Fail closed | unreadable fact = not idle; unwritable state, unreadable clock, failing `pmset sleepnow` exit 1 after logging the cause |

## 7. Decisions needed from the user

| # | Question | Options | Recommendation |
|---|---|---|---|
| U1 | Build the item, or first fix with the built-in timer? | (a) measure, then `sudo pmset -c sleep N` and do nothing else: zero code, but a machine peer connection or a run in progress is not a "reason to stay awake" (assertions only); (b) build `idle-suspend` for macOS (L): parity and the audit-log/peer rules | measure first (tests 3, 4, 7); build (b) only if (a) does not fit, and say why in the spec |
| U2 | Lid closed with no external display: what is the goal? | (a) accept that the Mac sleeps at lid close and is woken by opening it (nothing to build, no remote wake); (b) `pmset disablesleep 1` to stay awake closed (privileged, global, thermal and battery warnings, SOURCE-3P): needs its own T-row, a `machine install` item to set and revert it, never default; (c) an external display (or a dummy one: no source found) for the documented closed-display case; (d) lid open, display asleep | Not (b) first (section 4a: `disablesleep 1` failed once lid open). Measure `caffeinate -s` lid closed on AC (test 12 step 9, the only recipe reported to work, by one agent report), then (c) with a dummy HDMI plug or (d); decide after tests 8, 12 |
| U3 | Peer-triggered suspend on the Mac (the Linux `suspend` item)? | (a) none (idle-suspend only); (b) a darwin `suspend` item with a sudoers rule for `pmset sleepnow` | (a); (b) only if test 18 shows root is needed AND he wants `machine run <mac> -- suspend` |
| U4 | Wake-on-LAN claim | (a) say "supported only if test 12 passes, with the variant that passed"; (b) support only Ethernet + AC + lid open; (c) none | (a), with the starting assumption "not wakeable" (section 4a: 0 positive reports for his exact setup): until test 12 passes, `machine wake-info` says remote wake of this Mac is not supported and recommends keep-awake (`caffeinate -s` on AC) or a waker peer; after a pass it prints the variant that passed |
| U5 | Script folder | `/usr/local/libexec` vs `/Library/Application Support/machine` | decide after test 16 |
| U6 | One template with a platform branch vs two generators | one tail, two fact-readers (less drift) vs two full scripts (simpler to read) | one decision tail, two fact blocks, both under the same golden decision table |
| U7 | Option names | keep `--rdp-minutes` (documented as "remote screen session: ssh excluded, 5900, 3283") vs a neutral alias | keep, say so in help |
| U8 | Label / file names, minimum macOS version | `com.wadeck.machine-idle-suspend` ASSUMED; version set from test 1 | confirm |
| U9 | Should `machine install` ever set `pmset womp` / `sleep` itself? | (a) never: `machine wake-info` prints the command for the owner; (b) a `mac-wake` item that runs `sudo pmset -c womp 1` and records the old value for `--remove` | (a) first; (b) only after test 12 passes |

## 8. Implementation plan (TDD, each phase test-first, none started)

| Phase | Work | Tests first | Effort |
|---|---|---|---|
| 0 | The user runs section 2 and pastes the output; update this file with MEASURED rows, resolve U1 to U3 | none (docs) | S (user) |
| 1 | machine-core pure parsers and facts: `netstat` ESTABLISHED lines to ports, `vm.loadavg`, `HIDIdleTime` to seconds, `pmset -g assertions` to blockers, BSD ISO date handling; platform list gains darwin; darwin constants | table tests with captured real outputs from phase 0 (never invented samples) | M |
| 2 | darwin script template (`idleSuspendScript` variant) | golden test on a fake root as `idleSuspendGolden.test.ts`: fake BSD `date`, `netstat`, `pmset`, `ioreg`, `sysctl`, `logger`, `stat`, `/etc/passwd` not needed; every row of the `idleDecision` table; runs under macOS `sh` AND the CI Linux `sh`: no GNU-only `date -d`, `sed -r`, `grep -P`, `\+`, `\|`; the test fails (never skips) when a needed tool is missing | M |
| 3 | plan: plist, validation (`plutil -lint`, `sh -n`), steps (`install -m ... -o root -g wheel`, `launchctl bootstrap`/`bootout`), ancestor-ownership refusal, probe, `--refresh`, `--remove` | `installIdleSuspend.test.ts` darwin cases, `install.test.ts` lifecycle, a test that a user-writable ancestor refuses with the fix | M |
| 4 | executor facts for darwin (tool paths), CLI text (`macos` in the platform lines, note lines for the missing facts), `status` reading the `last` file, `--json` | `cliInstallIdleSuspend.test.ts` darwin, `cliInstall.test.ts` | S |
| 5 | docs: `idle-suspend.md` darwin section, `install.md`, `threat-model.md` T-69, `connectivity.md` macOS rows; `machine wake-info` darwin text from U4/U9 | doc/help drift tests that exist | S |
| 6 | real-Mac round: install, `--check`, a real suspend, a real wake (tests 12 again), record MEASURED, fix the "unverified" lists | manual checklist, as the Linux section "Unverified on a real box" | M (user time) |

Total: L (about 3 M phases plus user measurements). Cross-platform CI note: the golden test must run where the repo's CI runs (Windows, Ubuntu, macOS jobs exist per the commit log); the macOS job then runs the script with the real BSD tools only for syntax (`sh -n`), the decision rows with fakes.

## 9. Side effects and equivalent patterns (no action taken)

- `connectivity.md` section 7 already lists "That the Mac wakes from sleep on a magic packet at all" as not verified; this spec adds the sources, not a measurement.
- The same facts (no remote wake of a closed laptop) apply to a Windows laptop: not examined here.
