# machine

`machine` is a command line and a background daemon that run commands on your own computers, from one of them, under a strict allowlist signed by an administrator machine. A relay (a small server you name once) only introduces the machines to each other and authenticates them: it never carries a command.

Security model:

- Every machine registration and every allowlist (policy) is signed by the admin key. Nothing that widens rights is applied without that signature.
- The allowlist is exact: a command runs only if it matches an entry byte for byte, for that peer. No wildcard, no regex.
- The relay is untrusted and never carries commands. Peers talk directly.
- No message between machines is readable by the relay: the documents the admin leaves in an inbox (allowlists, revocations, new peers) and the approval of a new machine are sealed to the key of the machine they are for. The relay still sees who is addressed, when, how big, the type of document, and the addresses and presence of the machines.
- The admin key is protected by a passphrase you choose. It cannot be recovered.
- Machines talk over mutual TLS 1.3 with pinned keys.
- Every executed (or refused) command is written to a hash-chained audit log on the target.

Details: [threat model](.claude/specs/2026-11-13_machine-network/threat-model.md).

## 1. Install

Requires Node >= 24. The package is published on GitHub Packages (`https://npm.pkg.github.com`); npm needs the scope mapped to that registry and a token that can read packages (standard GitHub Packages setup, not covered here).

```
# ~/.npmrc
@wadeck-app:registry=https://npm.pkg.github.com
```

```
npm install -g @wadeck-app/machine-cli
machine --version
machine cli update          # later: install the latest published version now
```

Each machine needs `orch` for start-at-login (`npm i -g @wadeck-app/orchestrator-cli`).

## 2. Quick start

The name of a machine is its computer name in lowercase (`Midgard2.local` becomes `midgard2`). Use `--name` to override it when the identity is created.

### First machine (it becomes the admin machine)

```
machine setup relay.example.org
```

`setup` prints `Step n/6` headers:

1. Identity: created from the computer name.
2. Admin passphrase: typed twice (12 characters minimum, a warning below 20), then an optional hint (Enter = none). `--generate` makes a random one, shown once. The passphrase cannot be recovered.
3. Relay login: prints a relay login code such as `X35M-M87M`. Open the relay console (Tokens page), compare the code and the source address, then approve once. This gives MACHINE ADMIN rights (can approve machines, cannot manage tokens).
4. Enrolment of this machine: it approves itself with the passphrase just chosen.
5. Allow list: who manages what peers may run on this machine. `[1]` the admin (default, Enter): nothing to set up here, `machine admin allow <this machine> -- <command>` on the admin machine. `[2]` this machine itself: independent of any other machine, a local passphrase is chosen now (the `machine policy local enable` flow). `--policy admin|local` answers without a question (required in scripts; without a terminal and without the flag the default is `admin`, with a warning). The summary and `machine status` show the mode.
6. Summary and next steps.

Run it again after an interruption: what exists is kept.

### Every other machine

On the new machine:

```
machine join relay.example.org
```

It prints a relay login code (machine level: it only gives this machine access to the relay), waits for the admin, then shows a security code. On the admin machine:

```
machine admin approve
```

Once enrolled, `join` asks the same "Allow list" question as `setup` (step before the end; `--policy admin|local` answers it; not asked with `--no-wait`). On the admin machine, `approve` shows the new machine, asks y/N and the admin passphrase, then prints a security code. With several pending machines it lists them: pass the id (`machine admin approve <id>`). A candidacy expires after 15 minutes. After Ctrl-C or a timeout: `machine join --resume`.

### The three kinds of code

| Code | Looks like | What you do |
|---|---|---|
| Relay login code | `X35M-M87M` | Compare it with the one in the relay console, check the source address, approve there. If the console shows several codes, click this one; another code denies the request and you run the command again |
| Pairing code | 8 digits | Scripts only (`machine admin login <code>`) |
| Security code | `31447 56532 70010 53274 49389` | Compare the one shown on the admin machine with the one shown on the new machine: it must read exactly the same. If not, answer `N` on the new machine and run `machine admin revoke <name>` on the admin machine |

### Why the security code is compared on the joining machine

The new machine has no secret shared with the admin yet, so everything the relay sends it can be forged by the relay, including a fake admin key. Only the code differs: the real admin machine shows the code of the real key. Answering `y` without comparing pins the relay's key and makes the relay the administrator of that machine. Compare through your own eyes or a channel the relay does not control. Full explanation: [getting-started.md](.claude/specs/2026-11-13_machine-network/getting-started.md), "Why the security code is compared on the joining machine", and threat model T-05.

### Start at login

On each machine, so it can receive commands:

```
machine startup enable
machine startup status
```

`enable` registers the orch job and starts the daemon now when it is not running (a startup job alone only starts at the next login of orch). Expect `[ok] daemon started (peer port N)`; a daemon that already runs is left alone. `--no-start` registers the job only. On Linux (and everywhere) check it with `machine status` (`daemon: running ...`) or `machine startup status`.

If you see `[warn] the job is registered but the daemon did not start ...`, or `machine status` says `daemon: NOT running`:

- Run `machine daemon` in a terminal: it shows the error that stopped it (Ctrl-C to end it).
- Read `machine cli logs` and `orch logs --job machine`.
- Once fixed, start it with `orch restart-job machine` (or `machine startup enable` again). Do not use `orch trigger machine`: it ignores the liveness check and starts a second daemon.

`join` and `setup` never do it by themselves unless you pass `--auto-startup` (which also starts the daemon; `--no-start` skips that).

## 3. Allow commands

On the admin machine. Nothing is allowed until you sign it.

```
machine admin allow laptop -- ls /var/log
machine admin allow laptop --shell sh -- uptime
machine admin allow laptop --list
machine admin allow laptop --remove -- uptime
```

- It shows the difference, asks y/N and the admin passphrase, signs, and sends the policy through the relay inbox.
- `--shell cmd|ps|bash|sh`: when omitted, the shell is the one of the platform of the ADMIN machine (the command says so with an `[info]` line). From Windows to a Linux target, pass `--shell sh`.
- The command is matched exactly as written: a different spacing or a different shell is a different entry.
- `machine allowed laptop` shows what is allowed there per the last policy signed on this machine (entries per shell, version, date). Read-only, no passphrase. The list installed on the target is asked there: `machine policy allow --list`.
- `--out <file>` writes the signed policy to a file instead of sending it (no admin relay token needed); install it on the target with `machine policy install <signed.json>` or send it with `machine admin distribute --policy <signed.json>`.
- `machine admin allow` assumes the target has no policy signed elsewhere. A target that holds one signed from another machine refuses with `policy changed, reload`.

Several entries at once: write a draft, sign it.

```
{ "v": 1, "target": "<uuid of the target, lowercase v4>", "version": 1, "baseVersion": 0,
  "defaults": [ { "shell": "sh", "command": "uptime" }, { "shell": "sh", "command": "df -h" } ],
  "peers": {} }
```

```
machine admin sign-policy draft.json            # shows it, asks the passphrase, sends it through the relay
machine admin sign-policy draft.json --out signed.json
```

`version` must be `baseVersion + 1`, and `baseVersion` the version currently applied on the target. `machine resolve <machine>` shows which machine a reference means.

### Typed entries and lifetimes

An entry can be a template: fixed words and `<label:type>` placeholders, a whole word or after a flag. A value is accepted only if it is made of the characters its type allows (a short whitelist per type, nothing else) and it never starts with `-`.

```
machine admin allow laptop --shell sh -- "orch logs <job:name> --tail <n:int(1,500)>"
machine admin allow laptop --shell sh --for 2h -- "journalctl -u <u:enum(ssh.service|machine.service)> --lines=<n:int(1,500)> --no-pager"
machine admin allow laptop --shell sh --times 5 -- "task show <id:hexid(8)> --json"
```

| Type | Accepts |
|---|---|
| `int(min,max)` | digits only, no sign, no leading zero, 10 digits at most, inside 0..2147483647 |
| `duration(min,max)` | digits then `s`, `m`, `h` or `d` (`90s`, `2h`), bounds in seconds, at most 365 days |
| `name`, `name(dot)`, `name(max=N)` | letters, digits, `_`, inner `-` (inner single `.` with `dot`), 64 characters (128 at most with `max=`); Windows device names (`con`, `nul`...) refused on a Windows target |
| `port` | `int(1,65535)` |
| `hexid(n)`, `uuid` | lower-case hexadecimal, n characters (at most 64) / canonical 36 characters |
| `enum(a\|b\|c)` | exactly one listed word (letters, digits and `. _ : @ + -`, 64 at most, not starting with `-`) |

- Before the passphrase you read the template, the lifetime, and two accepted and two refused examples built by the same validator (a sanity check, not a safeguard). A malformed `<` or `>` is refused, never kept as an exact entry; an entry is at most 2048 characters with 8 placeholders, and the command it can build is at most 2048 characters.
- A typed entry on a program that no type can make safe (`sudo`, `git -c`, `orch add`, `machine run`, `--token`...) is signed only after a loud `[warn]`. Prefer an exact entry there.
- Lifetime: permanent by default; `--times N` (1 to 10000 calls, counted per entry, not per value), `--for 30m|2h|7d`, `--until 2027-02-01` (end of that day, UTC) or `--until 2027-02-01T18:00Z`; `--for` and `--until` reach at most 365 days. Allowing an entry again with other limits replaces them (`limits updated`). `machine allowed <machine>` shows each entry with its number, `[typed]` for a template and the lifetime (`3 of 5 calls left` on the target).
- `--remove` takes the text of the entry, or `--index <n>` (the number shown by `machine allowed` or `--list`). Several matches (the same text under two shells) are listed and nothing is signed. `machine policy allow --peer <machine>` starts a per-peer list from the PERMANENT default entries only and names the limited ones it leaves out.
- A policy with a typed entry is version 2: a target that is not up to date refuses it (`machine cli update` there first). An exact-only policy stays version 1.
- The refusal a peer sees for a wrong value is the same as for an unknown command. The closest template and the failed rule (token number and rule, never the value) are in the audit log of the target: `machine requests --history`.

### Requests: what peers asked and could not run

```
machine requests                      this machine: commands refused because they are not allowed, newest first, with the command that allows each
machine requests --history [--peer laptop] [--since 3h] [--event refused] [--limit 100]   runs (exit code, duration), refusals, session events
machine requests laptop               admin machine: the pending list of a peer (admin passphrase; nothing runs on the peer)
machine requests --all                every peer, one passphrase; unreachable peers are reported
```

`machine requests` reads the hash-chained audit log of this machine (no daemon needed). A command the policy allows now is not listed. A broken log is a warning with its line, and what follows is marked `[UNVERIFIED]`. The remote list needs the admin key here and peers that run this version; it shows the pending requests only (the history is read on each machine). The Requests page of the app-core module shows the same for this machine. On the admin machine (policy mode admin) each pending row has an Allow button: a confirmation names the machine, shell and exact command, asks the admin passphrase, and signs the new policy IN THE BROWSER (the daemon and the module backend never receive the passphrase or the unlocked key; the page asks the app-core PIN first). It is `machine admin allow` with a browser signature; `machine allowed <machine>` then lists the command. Elsewhere (no admin key, mode local) the row shows the CLI command.

### Who manages the allow list of a machine

| Mode | Who signs the list | Commands |
|---|---|---|
| `admin` (default) | the admin key: delegation to the admin machine | `machine admin allow ...` on the admin machine (above) |
| `local` | this machine's own policy key, protected by a LOCAL passphrase, independent of any other machine | `machine policy ...` on this machine |

```
machine policy local                  # shows the mode of this machine
machine policy local enable           # switch to mode local (--hint <text> sets the passphrase hint)
machine policy allow -- ipconfig      # allow ONE exact command on THIS machine (--shell cmd|ps|bash|sh)
machine policy allow --peer desktop -- uptime   # the own list of one registered peer
machine policy allow --list           # read-only, works in both modes
machine policy allow --remove -- ipconfig
machine policy delegate               # give the list back to the admin
```

- `enable` creates the local policy key (passphrase typed twice, optional hint). The list starts EMPTY: an admin-signed list is kept unused, and `enable` asks y/N when one is in force.
- Every change shows the difference, asks y/N and the local passphrase, signs with the local key and installs the policy on this machine (no relay). Nothing is cached: the passphrase is asked every time. The app-module may later remember the admin passphrase; the CLI never does.
- In mode local, admin-signed policies are refused: `policy refused (wrong-mode): this machine manages its own allow list (machine policy delegate to give it back to the admin)`. `machine admin allow` on this machine is refused too. From another machine nothing tells it the target is in mode local: the refusal comes from the target.
- `delegate` asks y/N and the local passphrase; the list is EMPTY until the admin signs one. The key and the local policy are archived (`*.archived-<keyid8>`), never deleted.
- A forgotten local passphrase has no reset command: see [getting-started.md](.claude/specs/2026-11-13_machine-network/getting-started.md), "Forgotten local passphrase".
- `machine status` and `machine list` show the mode of this machine.

## 4. Run and test

```
machine run laptop -- ls /var/log               # runs one allowed command on a peer
machine run laptop --shell sh -- uptime
machine peer connect laptop --shell sh          # once: the default shell of laptop on this machine
machine allowed laptop                          # what is allowed there (policy signed here)
machine run laptop --address 192.168.1.50:47921 -- uptime   # skip the relay record
machine run laptop --no-wait -- uptime          # refused at once if not allowed (the old behaviour)
machine run laptop --wait 30m -- uptime         # wait up to 30 min for the owner of laptop
machine run-defaults --on-refusal fail          # make --no-wait the default of this machine
machine ping                                    # this machine -> relay, one line per step
machine ping laptop                             # real authenticated channel to a peer; runs nothing
machine ping laptop --count 3
machine list                                    # this machine and its peers, online state per the relay
machine status                                  # identity, enrollment, policy, revocations
```

**`machine run` waits by default.** A command the target does not allow yet is held up to 10 minutes: the owner of the target allows or denies it (`machine requests`, Requests page), an Allow runs it at once. stderr says so once when the target has not answered after 2 s (`waiting up to 10m for laptop to allow it (default; --no-wait to fail at once)`), `--json` stdout stays one document. **A script that relied on an immediate refusal now waits up to 10 minutes: add `--no-wait`**, or run `machine run-defaults --on-refusal fail` once on the machine that runs the script. Precedence, highest first: the flags (`--no-wait`, `--on-refusal wait|fail`, `--wait <10s..60m>`), the machine setting (`machine run-defaults`, file `run-defaults.json`), the built-in default (wait 10m). `--no-wait` with `--wait` is refused. The target holds at most 2 requests per peer and 4 per machine (`hold-limit-peer`, `hold-limit-machine`): wait for its owner to answer them, or use `--no-wait`. See [hold-for-approval.md](.claude/specs/2026-11-13_machine-network/hold-for-approval.md).

The shell is part of the exact entry. `run` uses `--shell`, else the default set with `machine peer connect <machine> --shell` (said on stderr), else the platform of the caller (cmd on Windows, sh elsewhere). A Windows caller reaching a Linux target therefore needs `--shell sh` or the default. When a command is refused as `not-listed` but exists under another shell, the refusal names that shell (only the command you sent, never the list); the caller also prints what the policy signed here allows (10 entries at most).

- `run` needs no local daemon, but the daemon of the TARGET must run (`machine startup enable` there). `machine list` says so per peer.
- `run` returns the exit code of the remote command. Its own failures (refused, unknown machine, no connection) are 255 with the reason on stderr.
- `ping` needs no allowlist entry. `ping <machine>` also does the revocation catch-up with that peer. Exit codes: 0 ok, 1 failure, 2 usage, 3 unknown or ambiguous machine.
- A bare group shows its state, read-only: `machine admin` lists the candidacies waiting for approval (it never approves), `machine peer` the peers, `machine startup` the job status, `machine cli` the versions, `machine alias` the aliases.
- Help: `machine --help`, `machine <group> --help`, `machine <group> <subcommand> --help`.
- A friendlier label: `machine alias set <label> <name>`.
- Revoke a machine: `machine admin revoke <name>` (asks y/N and the passphrase, tells the other machines through the relay).

## 5. Wake a sleeping machine (Wake-on-LAN)

Not verified on real hardware yet (see the end of this file). Tune it per peer.

### How it works

The sender (the machine where you run `machine run` or `machine wake`) sends magic packets over UDP port 9, alternating:

1. a directed broadcast of the subnet shared with the target (first since 2026-11-22), then a probe window;
2. a unicast packet to the known IPv4 address of the target (pinned by you, else the relay record), then a probe window;
3. and so on, until the target answers or the limits are reached. Stored per-peer limits (`--wake-max-unicast`, `--wake-max-broadcast`) keep their meaning; only the default order changed.

Same LAN only: the packets leave from the machine that runs the command, so both machines must share a subnet. Another network gets an explicit error and nothing is sent. Wake-on-LAN gives no acknowledgement: the only proof is the target answering afterwards.

### Prerequisites on the target

- It must SLEEP (suspend), not be shut down. Its daemon starts at login, so a machine woken from power-off without auto-login does not listen.
- `machine startup enable` on the target.
- Wired Ethernet. Wake-on-LAN is a property of the wired network card. A Wi-Fi interface (named `wl...` on Linux) shows no `Wake-on` line in `ethtool` and generally cannot be woken.
- The MAC you give is the WIRED one, not the Wi-Fi one.
- Reserve its IP in your router (DHCP reservation): the unicast packet is sent to the known address, which must stay the right one.

### Linux target, step by step

```
ip -br link                                    # list the interfaces
ip route show default                          # the interface with the default route is the one in use
sudo ethtool <iface> | grep -i wake-on
cat /sys/class/net/<iface>/address             # the wired MAC
```

Read the `ethtool` output:

- `Supports Wake-on:` must contain `g`.
- `Wake-on: d` means disabled.
- `Link detected: no` means no cable.

Enable it (not persistent, lost at reboot):

```
sudo ethtool -s <iface> wol g
```

Persist it. Which recipe applies depends on who manages the interface:

```
nmcli device status
```

- `connected`: NetworkManager manages it. Use recipe 1.
- `unmanaged`, or no `nmcli`: look at `networkctl status <iface>`. A `Link File:` under `/run/systemd/network/10-netplan-...` means netplan generates the link (Ubuntu Server): use recipe 3.
- Otherwise use recipe 2. Warning: systemd applies the FIRST matching `.link` file in alphabetical order, so a `50-wol.link` is ignored when `10-netplan-...` exists (seen on the box of this project: the setting was lost at the reboot).

Recipe 1, NetworkManager (then reconnect that connection):

```
sudo nmcli connection modify "<connection name>" 802-3-ethernet.wake-on-lan magic
```

Recipe 2, any system with systemd-udev, independent of the network manager. Create `/etc/systemd/network/50-wol.link`:

```
[Match]
MACAddress=<wired mac>

[Link]
WakeOnLan=magic
```

Then reboot, or run `sudo udevadm trigger`, and re-check `ethtool <iface> | grep -i wake-on`. UNVERIFIED: it did not work on the box of this project, where netplan's `10-` link file comes first (use recipe 3 there).

Recipe 3, netplan (verified on the box of this project: `Wake-on: g` after a reboot). In the `ethernets:` block of the interface in `/etc/netplan/*.yaml`, add `wakeonlan: true`, keeping the indentation of the other keys:

```
    enp0s31f6:
      match:
        macaddress: <wired mac>
      set-name: enp0s31f6
      wakeonlan: true
```

Apply it with `sudo netplan try` (it goes back by itself after 120 s unless you press Enter), then reboot and re-check `ethtool <iface> | grep -i wake-on`.

Which address is woken: a unicast packet goes to the IP of the peer. If that IP belongs to the Wi-Fi card (the wired port has no IPv4 address, as on the box of this project), a sleeping machine cannot receive it on the wired card: the broadcast is what reaches it. Test each method alone with `machine peer connect <m> --wake-max-broadcast 0` and `--wake-max-unicast 0`.

If the packet still does not wake the machine, enable "Wake on LAN" in the BIOS/UEFI (the name varies: "Wake on PCI-E", "Power on by PCI-E"). Without a screen you cannot reach it: plug one in for a few minutes, or run `systemctl reboot --firmware-setup`. Try `ethtool` first.

macOS and Windows settings (UNVERIFIED, also printed by `machine wake-info`):

- macOS: System Settings, Battery or Energy, "Wake for network access". Keep the Mac on its power adapter.
- Windows: Device Manager, network adapter, Properties, Power Management: tick "Allow this device to wake the computer" and "Only allow a magic packet to wake the computer"; disable Fast Startup.

### On the sender

```
machine peer connect laptop --address 192.168.1.50:47921 --wake-mac aa:bb:cc:dd:ee:ff
machine wake-info laptop        # checklist for the target, filled with what this machine knows (sends nothing)
machine wake laptop             # wake now, wait for the answer, print the measured time
machine peer connect laptop --show      # effective values, "(default)" marks what nobody set
machine peer connect laptop --remove    # forget the settings of that peer
```

- The address and the MAC are typed by you, stored in `connections.json` and never learned from the relay. A pinned address wins over the relay record; `--address` on `run` wins over both.
- After `peer connect` with a MAC, `machine run` and `machine ping` wake the peer when it cannot be reached. `--type direct` keeps it manual (then `--wake` wakes on demand).
- `machine run laptop --wake -- ...` forces the wake for one command, `--no-wake` forbids it. Same on `machine ping laptop`.
- Only an unreachable or silent peer is woken. A refused connection is never woken (the machine answered, so it is awake and no daemon listens: start it there with `machine startup enable`), nor is an authentication, registration or revocation failure.
- A second wake of the same peer within 60 s by `run --wake` or `ping --wake` sends no packet (it still waits). `machine wake` ignores that cooldown.

### Timing options (per peer, on `peer connect`)

| Flag | Default | Range | Meaning |
|---|---|---|---|
| `--wake-probe <s>` | 5 | 1 to 60 | probe window after each packet |
| `--wake-wait <s>` | 90 | 10 to 600 | total wait for the answer |
| `--wake-max-unicast <n>` | 4 | 0 to 8 | unicast packets at most |
| `--wake-max-broadcast <n>` | 4 | 0 to 8 | broadcast packets at most |
| `--wake-connect-timeout <ms>` | 3000 | 200 to 10000 | one probe attempt (connect and handshake) |
| `--wake-settle <s>` | 0 | 0 to 120 | pause after the answer, before the command |
| `--wake-broadcast <ipv4>` | broadcast of the shared subnet | an IPv4 | only needed when no IPv4 address of the peer is known |

A flag changes that value and keeps the others. Values out of range are refused, never clamped.

Tuning: a successful wake prints the measured time, for example `answered after 14.2 s, woken by unicast (probe window 3, 4.2 s into its 5 s)`. When the answer came after more than 80% of a window, it prints the command that raises `--wake-probe` for that peer. If the answer always comes late, raise `--wake-probe` (a slow resume) or `--wake-connect-timeout` (a freshly resumed host answers TCP late and TLS later). "By unicast" names the last packet before the answer, not proof that it was the one that worked.

### Suspend the target with `machine install suspend`

On the Linux target, in a terminal: `machine install suspend` installs, through sudo with your own password, a root-owned script and a sudo rule for the one command `systemctl suspend` (`--dry-run` shows everything first, `--check` reports the state, `--remove` undoes it). It prints the `machine admin allow <machine> --shell sh -- /usr/local/bin/machine-suspend` line to run on the admin machine; after that every trusted peer can suspend the machine with `machine run`, and wake it with `machine wake`. UNVERIFIED on a real box (`.claude/specs/2026-11-13_machine-network/install.md`).

### Trace and limits

- Every packet is recorded in `<configDir>/wake-audit.log` (hash-chained, written before the send; "sent", never "woke"). If the log cannot be written, no packet is sent.
- Verified once, on one machine: a Linux box (wired Intel I219-LM, `Wake-on: g` kept across a reboot with netplan `wakeonlan: true`) suspended with `systemctl suspend` woke from `machine ping` and answered after 12.2 s (packets: unicast, broadcast, unicast, answer 2.2 s into the third 5 s window), on the same LAN.
- Measured on that same box (a Windows sender), which is why the broadcast goes first since 2026-11-22: the default order (unicast first) answered after 13.9 s, the first unicast did nothing and the broadcast sent 6 s later woke it; broadcast only answered after 7 to 7.1 s; unicast only (4 packets) got no answer in the ~9 s observed (not a full 90 s run). The floor is the resume time of the box (about 7 s); a first packet that does not wake it costs one probe window. Why unicast does not wake it is not proven (a suspended host cannot answer ARP, so the sender may not be able to build the frame: unverified). One box only: other machines (Mac, work laptop, Wi-Fi) are unmeasured.
- Probe attempts that fail fast are retried every 500 ms (since 2026-11-22), an attempt that uses its whole `--wake-connect-timeout` is followed at once by the next.
- Not verified: which of the packets woke it in the first run (no acknowledgement); a Mac, a Windows machine, a Wi-Fi target; that a router or switch passes the directed broadcast; resume times of other hardware.
- Not across routers or VPNs. The "waker" role (a machine on the target's LAN that sends the packet for you, phase B) is not built.
- After a suspend the daemon is still running, so a locked screen is fine. A cold boot with disk encryption or without auto-login is not: the daemon does not start until someone logs in.

## 6. Update and uninstall

```
machine cli version         # installed version and latest published
machine cli update          # install the latest version now, then refresh the startup job and restart the daemon
machine cli rollback        # reinstall the version that preceded the last update
machine cli self-check      # check the install
machine startup disable     # stop starting at login, and end the running daemon
```

- The daemon also checks for updates at start and every 30 minutes. `autoUpdate: false` in `<configDir>/config.yml` turns that off; `machine cli update` still works.
- Before accepting an update, the updater runs `machine cli self-check` (release version, Node >= 24, platform package matching, writable folders). A failed check rolls back.
- A remote command still running when the daemon restarts is cut. A development build refuses to update.
- `machine startup disable` first ends the running daemon (`orch kill machine`), then removes the job. It removes only a job it owns; otherwise it refuses and names the command to run.
- Update EVERY machine, then send again what was lost. Since the documents are sealed, a machine that still runs an older build deletes them unread (it logs `N document(s) failed verification and were deleted`). After `machine cli update` everywhere, run `machine admin distribute <machine>` (new or renewed machines, revocations by uuid) and `machine admin distribute --policy <signed.json>` (policies). A machine that receives a clear document from an older admin refuses it and says `PLAINTEXT ... machine cli update`.
- Uninstall: `machine startup disable`, then `npm uninstall -g @wadeck-app/machine-cli`. Delete the configuration folder only if you accept losing the identity and, on the admin machine, the admin key.

## 7. Troubleshooting

`machine cli logs` (`-f` to follow) shows the trace of every command (the command line, its `[ok]`/`[warn]`/`[fail]`/`[info]` lines, exit code, duration) together with the updater and daemon lines. Redacted: everything after `--` is written as `<redacted>`, the value of secret-bearing flags too, 8-digit and 25-digit codes become `<code>`, passphrases are never written. `--help` and `--version` are not traced.

| Symptom | Cause | Fix |
|---|---|---|
| `admin login` or `setup` fails naming the `machine-admin` scope | The relay predates that scope | Update the relay. `machine admin login --full-access` is the explicit opt-in to a full-access token (nothing falls back to it by itself) |
| Join or admin login: request denied | A different code than the one printed was clicked in the relay console, or it was denied | Run the command again and click the code printed in the terminal |
| `no record published yet` | The relay lists a machine only once its daemon has published its address record | On the target, `machine startup enable` (or start the daemon), then `machine list` again |
| `machine ping <machine>` shows an error per address | See the next three rows | `machine ping <machine> --address <host:port>` to test one address |
| Connection refused (`ECONNREFUSED`) | The host answered, no daemon listens | Start the daemon there: `machine startup enable` |
| Timeout, no answer | Host asleep, firewall, or wrong address | Wake it (section 5), check the firewall and the address; `--address` or `peer connect --address` to pin a good one |
| Another key answers | Wrong address | Pin the right one with `machine peer connect <machine> --address ...` |
| `refused by <machine>: no-policy: no policy is installed on this machine yet` | The target has no policy yet. Right after `machine admin allow` the policy is still in the relay inbox of the target: its daemon reads it within about a minute (10 s for the first 5 minutes after its daemon starts) | Retry shortly. `machine run` says `a policy (version N) ... was signed here ... it is not installed yet` when it knows one is on its way. Still refused after a few minutes: is the daemon running there (`machine list`, `machine startup enable` on the target)? Is the target in mode local (`machine status` there)? Otherwise `machine admin allow <machine> -- <command>` on the admin machine |
| Refused during authentication | Not registered there, revoked, clocks apart, or pair secret mismatch | `machine status` on both machines, check the clocks, approve again if revoked |
| `policy changed, reload: this machine is at version N, the document was edited from version M` | The target holds a policy signed from another machine | Read its version with `machine status` there, then sign a draft whose `baseVersion` is that version (section 3) |
| `policy refused (wrong-mode): this machine manages its own allow list` | The target is in policy mode local: it refuses admin-signed policies | On the target, `machine policy allow -- <command>`, or `machine policy delegate` to give the list back to the admin |
| `"<command>" (shell sh) is not allowed for this peer` | The entry does not exist, or exists for another shell | `machine admin allow <machine> --list`, then allow the exact string with the right `--shell` |
| The admin token is refused (invalid or revoked, HTTP 401) | Token revoked in the relay console | `machine admin login --force` and confirm in the console (the old token is forgotten, not revoked: revoke it in the console) |
| `too_many_machines` at `admin approve` | The relay limit per token (10 by default) | `machine admin forget-relay-record <machine>` for machines that are gone |
| Security codes differ | Possible interference on the relay | Answer `N`, then `machine admin revoke <name>` on the admin machine |
| Wake does nothing although `Wake-on: g` | No physical link: `ip -br link` shows `NO-CARRIER`, or `cat /sys/class/net/<iface>/carrier` prints `0`. Wake-on-LAN cannot work without a link | Check the cable, the port and the router. `sudo dmesg \| grep -i <driver or iface>` shows the link up and down events |
| Accents come out as `?` or U+FFFD, `[warn] the output is not valid UTF-8 (probably an OEM code page)` | A Windows target writes its output in a code page that is not UTF-8 and is not one the daemon knows (or its page could not be read). Normally the daemon converts the OEM page of the target (437, 850, 852, 858, 860, 863, 865, 1252) and the caller prints `[info] output decoded from the target's code page cp850` instead | Nothing to do for the `[info]` line. For the `[warn]`: the command may set its own encoding (`chcp 65001`, or `[Console]::OutputEncoding` in `ps`), with the policy entry naming that exact string |
| A woken machine does not answer | See section 5 | `machine wake-info <machine>`; check `Wake-on: g`, the wired MAC, suspend rather than shutdown, the BIOS setting |

## 8. Where things are stored

The configuration folder is `--config-dir`, else `MACHINE_CONFIG_DIR`, else `~/.config/machine`.

```
<configDir>/
  _secrets_/            identity.json, admin.key.json (admin machine), relay.json, relay-admin.json, peers.json
  logs/<day>.ndjson     command, updater and daemon trace (machine cli logs)
  admin.json            pinned admin PUBLIC key
  policy.json           the signed allowlist of this machine (policy-state.json: highest version applied)
  connections.json      per-peer address and wake settings (no secret)
  peer-records.json     highest address record seq seen per peer
  audit.log             hash-chained log of executed and refused commands (daemon)
  wake-audit.log        hash-chained log of the packets sent by this machine
  wake-state.json       last wake per peer (cooldown)
  daemon.port.json      written by the running daemon
  config.yml            optional, autoUpdate
```

Secrets (keys, tokens, pair secrets) live only in `_secrets_/`. They never go to the repository, the logs, the error messages or the audit log. No passphrase goes on a command line or in an environment variable.

## 9. For developers

```
packages/machine-core        pure logic (no I/O): documents, policy, signatures, security code
packages/machine-transport   mutual TLS peer channel
packages/machine-exec        command execution under the policy
packages/machine-cli         CLI, daemon, updater, packaging (the published package)
packages/app-module-machine  admin page module for app-core
packages/dsl-lib-machine     UI components of the admin pages
packages/machine-webcrypto   browser-safe WebCrypto subset of machine-core (admin page)
.claude/specs/2026-11-13_machine-network/   decisions, threat model, specs
```

```
npm test
npm run typecheck
MACHINE_TEST_RELAY_MODULE=<poc-node>/tests/helpers/test-relay.mjs npm run test:relay
```

`test:relay` runs init, onboarding and offboarding against the real relay and needs a poc-node checkout with `npm ci` done (it is not part of `npm test`).

Specs: [decision log](.claude/specs/2026-11-13_machine-network/_index.md), [threat model](.claude/specs/2026-11-13_machine-network/threat-model.md), [getting started](.claude/specs/2026-11-13_machine-network/getting-started.md), [connectivity (Wake-on-LAN)](.claude/specs/2026-11-13_machine-network/connectivity.md), [startup](.claude/specs/2026-11-13_machine-network/startup.md), [packaging and update](.claude/specs/2026-11-13_machine-network/packaging.md).

## Not verified

- Real wake on hardware: one Linux box only (see "Trace and limits"); the router and switch behaviour and other hardware are not verified.
- The macOS and Windows Wake-on-LAN settings; the Linux netplan recipe was run on one target, the NetworkManager recipe was not.
- The BIOS/UEFI names, `systemctl reboot --firmware-setup` and the router DHCP reservation come from general knowledge, not from a run of this project.
- The update chain (`cli update`, `cli rollback`) has not been run for real against the published registry as of the packaging spec.
- The startup job against the real `orch` was verified for a throwaway job only (startup.md).
- The GitHub Packages npm setup shown in section 1.
- The commands in this file were checked against the CLI help and sources, not run end to end for this document.
