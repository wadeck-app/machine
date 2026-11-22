# Getting started

**Version:** v0.7 (2026-11-20). Implements decisions 51 to 62, 66 and 67. The flows were run against the real relay by `npm run test:relay` (see ux-audit-2026-11-15.md).

The user-facing guide (install, quick start, allow, run, Wake-on-LAN, troubleshooting) is the root `README.md`; it is also the npm package page of `@wadeck-app/machine-cli` (copied into the wrapper by `generate-platform-packages`).

## Commands per case

| Case | Commands | Human steps |
|---|---|---|
| First machine (also the admin) | `machine setup <relay>` | choose the admin passphrase (typed twice, asked again after a typo, 3 attempts) and an optional hint; confirm the relay login code in the relay console, once (MACHINE ADMIN: can approve machines, cannot manage tokens) |
| Another machine | `machine join <relay>` there, `machine admin approve` on the admin machine | compare the relay login code with the one in the relay console and approve (nothing is typed); on the admin machine: y/N and the passphrase; on both machines: compare the security code |
| Allow a command | `machine admin allow <machine> -- <command>` on the admin machine (a typed template and `--times` / `--for` / `--until`: see "Rules a user meets") | y/N and the passphrase |
| Start the daemon now and at each login (each machine) | `machine startup enable` (`--no-start` registers only; `machine status` shows `daemon: running` or `NOT running` with the fix) | none; never automatic unless `--auto-startup` |
| Stop starting at login | `machine startup disable` | none; also ends the running daemon of the job |
| Test the connection | `machine ping` (path to the relay), `machine ping <machine>` (channel to a peer) | none; runs nothing, needs no allowlist entry |
| Reach a machine that sleeps (same LAN) | `machine peer connect <machine> --address <ip>:<port> --wake-mac <mac>` once, then `machine run` / `machine ping` as usual; `machine wake <machine>` to wake now | type the MAC of the target (never learned from the relay) |

The relay is named once (`<relay>` is a host or URL), then stored. A machine that holds the admin key and runs `machine join <relay>` approves itself (needs `machine admin login` first, or use `setup`). The token of `setup` is the machine token AND the admin token of the first machine (one file content in `relay.json` and `relay-admin.json`); `machine admin login` on another machine adds `<name> admin`. A relay without the `machine-admin` scope fails loudly: update it; `machine admin login --full-access` (a full-access token that can also manage tokens) is the explicit opt-in.

## The codes (decision 55)

| Code | Looks like | Where it comes from | What you do with it |
|---|---|---|---|
| Relay login code (admin) | `X35M-M87M` | printed by `setup` and `machine admin login` with MACHINE ADMIN (can approve machines, cannot manage tokens) | compare it with the code the relay console shows (Tokens page lists the request "<name>" or "<name> admin"), check the source address is this computer, then approve; if the console shows several codes, click this one (a different code denies the request and you run the command again): nothing to copy |
| Relay login code (machine) | `X35M-M87M` | printed by `join` | compare it with the code the relay console shows (source address too), then approve; if the console shows several codes, click this one: it only gives this machine access to the relay |
| Pairing code | 8 digits | relay console, Tokens, Add token, "Limited to scopes", machine-admin | only for scripts (`machine admin login <code>`); with `--full-access` on a relay that predates the full-access login (`[warn]` line, then it is asked, WITHOUT "Limited to scopes") |
| Security code | `31447 56532 70010 53274 49389` | printed on the admin machine after it signs, and on the new machine | compare the two: it must read exactly the same on both. If not, `machine admin revoke <name>` |

The candidacy code (base32, `XXXX-XXXX-XXXX-XXXX`) is internal: the admin machine recomputes and checks it, nothing to compare. `--verbose` (join, setup, admin approve) and `--json` show it.

Security code: 25 digits, 83 bits. `--yes-final-code` takes it quoted or as five words.

## What the new machine and the admin see

New machine (`machine join <relay>`):

```
Relay login code for "laptop" on <relay> (it only gives this machine access to the relay, it is not the security code):

  TH9B-3MHH

Relay page: <relay page>
Compare this code with the one in the relay console (the Tokens page lists the request "laptop", marked machine), check that the source address is this computer, then approve. If the console shows several codes, click this one.
...
Candidacy LLADk3BpEqJkNFQuHZT_cA posted: it expires in 15 min (16:07).
On the admin machine run: machine admin approve
When the admin approves, a security code appears there and here: compare them, they must read exactly the same.
The admin approved this machine. Security code of "laptop" (this machine) with admin key ab5e... It must read exactly the same on "desktop":

  31447 56532 70010 53274 49389
```

Admin machine (`machine admin approve`):

```
Candidacy LLADk3BpEqJkNFQuHZT_cA
  name       laptop
  ...
  created    now (15:52), expires in 15 min (16:07)

After you sign, a security code is shown here and on "laptop": it must read exactly the same on both.
...
Security code of "laptop" (admin key ab5e...):

  31447 56532 70010 53274 49389

It must read exactly the same on "laptop". If it differs, run: machine admin revoke laptop
```

## Why the security code is compared on the joining machine

**What it is.** 25 digits computed from three values: the key of the new machine, the admin key and a random value of this enrollment. The admin machine computes it from its own key; the new machine computes it from the admin key it received in the approval.

**The attack it catches.** The relay sits between the two machines. If it answers the new machine with its own admin key (and registrations signed by it), everything the new machine can check still looks valid. Only the code differs: the new machine shows a code for the relay's key, the admin machine shows the code for the real one. Two different codes mean the admin key offered to the new machine is not the admin's.

**What you do.**

1. Read the code on the new machine and the code on the admin machine (each names the other machine). Use your own eyes, or a channel the relay does not control (voice, in person, another device of yours).
2. Same digits: answer `y` on the new machine. It then pins the admin key.
3. Different digits: answer `N`. Nothing is pinned. On the admin machine run `machine admin revoke <name>` (the registration it signed for the new machine exists until then).

**Why a message from the admin through the relay cannot replace it.** The new machine has no secret shared with the admin before the enrollment, so it cannot tell a real "the code is fine" from one the relay wrote. Any confirmation that travels through the relay can be forged by the relay. The decision is also taken on the new machine because that is where the key is pinned: an approval of the admin side alone cannot stop a pin the relay induced.

**`y/N` versus `--yes-final-code`.** At the `[y/N]` question the machine cannot know that you compared. With `--yes-final-code "<code>"` (for a script or a run without terminal, on `join` or `join --resume`) you type the code read on the admin machine and the new machine checks it against its own: a mistyped code, or a code of another key, stops the pin. It still cannot know where the typed code came from: copying it from a message that crossed the relay brings the forgery back.

**What is not protected if you answer `y` without reading.** The admin key you pin is the relay's. A pinned admin key signs the policies and registrations this machine accepts (threat model T-05, hard rule 4), so the relay becomes the administrator of this machine. No other check on the new machine can detect it: they verify against the admin key the approval itself carries. The prompt says it in one line: `Why: the relay could have swapped the admin key; only the same code on both screens proves it did not.` The first machine of a network (`setup`) created the admin key itself: there is no code to compare.

Technical side: threat-model.md, T-05 and "Security code on the joining machine".

## Step headers (decision 67)

The multi-step commands print `Step n/N: <title>` between their steps, after a blank line and a line of 25 `=`. They go to the same stream as the text around them (stderr with `--json`), are plain ASCII and never reach the command log. There is no `--quiet` for these commands.

Numbering rule, the same everywhere: N counts the steps of the path this run takes.

- A step that is already done (identity, admin key, relay token or received approval already there) is counted and printed as one line, `Step 1/5: Identity (already done)`, with no separator.
- A step that does not exist on this path is not counted: no code comparison when this machine approves itself or with `--no-wait`; no distribution when nobody is there to tell.
- A path of one step prints no header: listing, `--reject`, `admin login <code>`, a usage error.

| Command | Steps (full path) |
|---|---|
| `setup` | Identity, Admin passphrase, Relay login, Enrolment of this machine, Allow list, Summary and next steps (6) |
| `join` | Identity, Relay login, Candidacy posted (waiting for the admin, or approved by this machine), Security code comparison, Allow list, Done (6; 5 without the comparison; `--no-wait` has no Allow list and ends with Next steps, 4) |
| `admin approve` | Pending candidacy, Passphrase and signature, Security code, Documents distributed (4; 3 when nobody is left to tell) |
| `admin init` | Admin passphrase, Done (2) |
| `admin login` (console) | Relay login, Done (2) |

## Testing the connection (decision 61)

```
machine ping                      this machine -> relay: relay.json, relay answers (ms, version), token accepted + access level,
                                  local daemon running, own address record published (age, presence). Exit 0 only if no step fails
machine ping <machine> [--count 3] [--address host:port] [--json]
                                  this machine -> peer: address(es) tried, mutual TLS handshake (ms), hello round trip (ms),
                                  registration (serial, admin key id), revocation lists same or exchanged. Nothing is executed
```

- `[fail]` lines go to stderr with cause and fix; a stopped local daemon fails the first form (it publishes the address and receives commands) although `machine run` does not need it.
- First form: the relay time includes DNS and TLS setup (first request); the token time is on the warm connection. A full-access token is a `[warn]` (a machine never needs it); a loopback-only address record is a `[warn]` (peers refuse it).
- Second form, a failure names each address with its error: nothing listens (daemon stopped there), no answer (firewall, asleep), another key answers (wrong address), refused during authentication (not registered there, revoked, clocks, pair secret), no record on the relay (`machine startup enable` there). Exit 1; unknown or ambiguous machine 3; usage 2.
- `--count n` (1 to 10) opens n connections one second apart and prints min/avg/max; the hello is sent in the first 4 only (a peer allows 6 revocation exchanges per minute).

## Waking a sleeping machine (decision 62)

Same LAN only: the packets are sent from THIS machine, so the caller and the target must share a subnet (a machine on another network gets an explicit error and nothing is sent). Nothing is verified on real hardware yet: tune it per peer.

```
machine peer connect <machine> --address 192.168.1.40:47921 --wake-mac aa:bb:cc:dd:ee:ff
    pins the address (it wins over the relay record) and the MAC (typed by you); machine run and machine ping then wake the machine
    when it cannot be reached (type ping-if-not-reachable-magic-packet; --type direct keeps it manual, then --wake wakes on demand)
machine peer connect <machine> --show        the effective values, "(default)" marks what nobody set
machine peer connect <machine> --remove      forget the settings of that peer
machine wake <machine>                       wake now, wait for the answer, print the measured time (ignores the 60 s cooldown)
machine wake-info <machine>                  checklist to prepare THE TARGET: its BIOS/driver/system settings, daemon at login, how to find its MAC,
                                             and the command above filled with what this machine knows (reads local files, sends nothing)
machine run <machine> --wake|--no-wake ...   force or forbid the wake for this command (same on machine ping <machine>)
```

| Setting | Flag | Default | Range | Meaning |
|---|---|---|---|---|
| `probeSeconds` | `--wake-probe` | 5 | 1 to 60 | probe window after each packet |
| `waitSeconds` | `--wake-wait` | 90 | 10 to 600 | total wait for the answer |
| `maxUnicast` | `--wake-max-unicast` | 4 | 0 to 8 | unicast packets at most |
| `maxBroadcast` | `--wake-max-broadcast` | 4 | 0 to 8 | broadcast packets at most |
| `connectTimeoutMs` | `--wake-connect-timeout` | 3000 | 200 to 10000 | one probe attempt (connect and handshake) |
| `settleSeconds` | `--wake-settle` | 0 | 0 to 120 | pause after the answer, before the command |
| `wake.broadcast` | `--wake-broadcast` | the broadcast of the shared subnet | an IPv4 | only needed when no IPv4 address of the peer is known |

- Order (broadcast first since 2026-11-22, measured on one box only): directed broadcast, probe, unicast to the pinned (or last known) IPv4 address, probe, alternating; success stops at once. A flag changes that value and keeps the others.
- Tuning: a wake prints `answered after 14.2 s, woken by unicast (probe window 3, 4.2 s into its 5 s)`; after more than 80% of a window it prints the command that raises `probeSeconds`. "By unicast" names the last packet before the answer: Wake-on-LAN gives no acknowledgement.
- Only an unreachable or silent peer is woken, never an authentication, registration or revocation failure. A refused connection is not woken either: the machine answered, so it is awake and no daemon listens; the output says to start the daemon there (`machine startup enable`). A second wake of the same peer within 60 s by `run --wake` or `ping --wake` sends no packet (it still waits); `machine wake` is explicit and ignores that cooldown (the packet limits still apply).
- The target must SLEEP, not be shut down: its daemon starts at login, so a machine woken from power-off without auto-login does not listen. BIOS/UEFI and driver Wake-on-LAN settings are on the target (on Linux `ethtool <interface>` shows `Wake-on: g`); Wi-Fi targets are unreliable. `machine wake-info <machine>` prints this checklist for the target (macOS and Windows lines are marked UNVERIFIED).
- Trace: `<configDir>/wake-audit.log` (who woke what, how many packets, hash-chained); the settings are in `connections.json` (no secret).

## Who manages the allow list of a machine (decision 68, asked at join: decision 70)

`machine join` and `machine setup` ask it in the step "Allow list", once the machine is enrolled:

```
Who manages the allow list of this machine (the commands its peers may run here)?
  [1] the admin (default): delegated, nothing to set up here; on the admin machine run `machine admin allow laptop -- <command>`
  [2] this machine itself: independent of any other machine; you choose a local passphrase now (`machine policy local enable`)
Choice [1]:
```

`--policy admin|local` answers it (scripts). Without a terminal and without the flag the default is `admin` and a `[warn]` says so. The summary shows `allow list: managed by the admin (policy mode admin)` (or local); `machine status` shows it later. No admin signature is involved: the choice is local to this machine.

| Mode | Who signs the list | Edit with | Use for |
|---|---|---|---|
| `admin` (default) | the admin key | `machine admin allow <machine> -- <command>` on the admin machine | machines you administer from one place |
| `local` | the machine's own policy key, local passphrase | `machine policy allow -- <command>` on that machine | a machine that must not depend on the admin machine (work laptop) |

```
machine policy local enable [--hint <text>]   this machine manages its own list: new policy key, passphrase typed twice; the list starts EMPTY
machine policy allow [--shell s] [--peer <machine>] -- <command>   difference, y/N, local passphrase, signed and installed here (no relay)
machine policy allow --remove -- <command>    withdraw        machine policy allow --list   read-only, no passphrase, any mode
machine policy delegate                       give the list back to the admin: EMPTY until the admin signs one; local key archived
machine status                                shows "policy mode"; machine list shows it for this machine (peers: unknown)
```

- The passphrase is asked every time; nothing is cached. It cannot be recovered.
- Mode `local` refuses admin-signed policies (inbox or `policy install`, audited), mode `admin` refuses locally signed ones. It never enrols a machine and never lifts a revocation: trust still comes from the admin.
- `machine admin allow <machine>` cannot tell that the target is in mode `local` (a peer's mode is not published): the target refuses the document and says why. Allow on the target itself: `machine policy allow`.
- Forgotten local passphrase: the list stays as it is. To go back to the admin: stop the daemon (`machine startup disable`, or `orch kill machine`), delete `policy-mode.json` and `policy-local.json` in the config dir and `_secrets_/policy.key.json`, start the daemon, then have the admin sign a policy (`machine admin allow <this machine> -- <command>`).

## Requests: what peers asked and could not run (decisions 73 and 74)

A command a peer sends that is not allowed is refused and written to the audit log of the target. `machine requests` reads that log; nothing is run or changed.

```
machine requests                  the pending list of THIS machine: refused because not allowed, newest first, with the exact command to allow each
machine requests --history [--peer <machine>] [--since 30m|2h|3d|2026-11-20] [--event run|refused|session|document] [--limit <n>]
machine requests <machine>        admin machine: the pending list of a peer (asks the admin passphrase; nothing is run on the peer)
machine requests --all            the same for every peer, one passphrase; a peer that cannot be reached is reported, the others are shown
```

```
requests waiting for approval on laptop (2 commands refused because not allowed, newest first):
  thinkcentre -> sh "df -h"  1 time, first 21:59 (1 min ago), last 21:59 (1 min ago)
      machine admin allow laptop --shell sh -- "df -h"
  thinkcentre -> sh "ls"  3 times, first 18:55 (3 h ago), last 21:55 (5 min ago)
      machine admin allow laptop --shell sh -- ls
```

- Pending groups are (machine, shell, command). A command the policy allows now is not listed. Up to 100 groups (`--limit`), the total is shown.
- In mode `local` the next command is `machine policy allow ...`, to run on that machine. In mode `admin`, `machine admin allow` allows the command for every peer (the default list).
- A broken audit log is a `[warn]` with its line and the verified part is still listed; what follows the break is marked `[UNVERIFIED]` and never pending. Keep a copy, then move the file away (the daemon refuses to start on a broken log).
- The remote view needs the admin key on the machine that asks and a peer that runs this version (`peer too old: update it with machine cli update`). It lists the pending requests only; a peer allows 6 such lists per minute and audits each one. The history is read on each machine.
- **`machine run` waits by default (decision 81).** A not-yet-allowed request is held up to 10 min instead of being refused at once. **A script that relied on the immediate refusal now waits up to 10 min: add `--no-wait` to its `machine run` calls, or run `machine run-defaults --on-refusal fail` once on the machine that runs it.** Flags: `--no-wait` (= `--on-refusal fail`), `--wait <10s..60m>` (implies `--on-refusal wait`), `--on-refusal wait|fail`; `--no-wait` with `--wait` is refused. Precedence: flags, then the machine setting (`machine run-defaults [--on-refusal wait|fail] [--wait 10m] [--reset]`, file `run-defaults.json` in the config folder, a damaged file is an error naming the fix), then the built-in default (wait 10m). `machine run-defaults` and the last line of `machine status` show the effective value and where it comes from. When the wait comes from the default or the setting, stderr says once, when the target has not answered after 2 s (an allowed command prints nothing), `waiting up to 10m for <machine> to allow it (default; --no-wait to fail at once)`. The hold limits (2 per peer, 4 per machine) apply to default runs: `hold-limit-peer` / `hold-limit-machine` say to wait for the owner to answer the pending ones, or to use `--no-wait`. A target that runs a version without the hold refuses at once and the caller warns (`did not hold the request`, update it with `machine cli update`).
- `machine run <machine> --wait 10m -- <command>` (10 s to 60 min; the target caps it at 30 min by default and says so) keeps a not-yet-allowed request open instead of refusing it at once: the owner sees it first in `machine requests` and on the Requests page (time left, Allow, Deny). An Allow (the same signed entry as always, even `--times 1`) runs it at once; `machine requests --deny <id> [--reason <text>]` (no passphrase) answers `refused: denied`; the deadline answers `refused: not-listed` with `waited 10m, nobody answered`. 2 held requests per peer and 4 per machine; a restart of the target daemon ends them (the caller sees the connection end and can resend). Progress goes to stderr every 30 s, `--json` stdout stays one document. Spec: hold-for-approval.md.
- `machine requests <machine>` and `--all` also list what the peer HOLDS (WAITING NOW, with the exact `machine admin allow` command: it reaches the target directly, or through the relay inbox (5 s poll while it holds a request), and the held run then proceeds). Deny a held request on the target (`machine requests --deny <id>` there). `--full` shows whole commands. If a held request uses `cmd` and the target is Linux/macOS, the caller needs `--shell sh`.
- Direct delivery (decision 86): `machine admin allow`, the Allow button, revoke, approve and `notify-to` first hand the signed document to the machine over the peer channel; the output says `Delivered directly to <m> (installed, 0.4 s)`, or `<m> is not reachable directly: stored in the relay inbox ...` with the cause. `machine list` and the Machines page show `reachable:` per machine. After Allow the page lists the steps (signed, delivered, installs, released) with a progress bar; it shows a success only when the target reports the end of the hold, else `no confirmation from <m>` after 3 minutes.
- The Requests page shows this machine and, on the admin machine, a "Load the other machines" button (PIN, admin passphrase each time) that adds the held and refused requests of every peer, with a machine filter and Allow per machine.
- Request notices (decisions 83, 84): a target that holds or refuses a request tells the machines of an admin-signed list, without any passphrase on the target. A machine that joins receives the list with its approval (nothing to run). `machine status` shows `request notices: sent to <machines>` or `no recipient list yet`. On the admin machine `machine admin notify-to --list` shows the recipients and, per machine, whether it holds the current list (`machine requests <machine>` confirms it); `machine admin notify-to <machine>...` chooses the recipients and sends the list to every trusted machine. A machine on an older build deletes the list unread: `machine cli update` there first. Spec: request-notices.md.

## What was sent and received: `machine log` and the Activity page (decision 82)

- `machine run` records every run it sends in `<config dir>/run-log/` (when, to whom, the command as typed, how it ended). 5 MiB per file, the newest 5 files are kept. Never put a secret in a command: it is stored.
- `machine log` lists what this machine sent and received, newest first: `machine log --sent --since 2h`, `machine log --machine nas --outcome refused`, `machine log --text df --limit 100 --offset 100`, `--json` for scripts.
- The module page Activity shows the same list with direction, machine, outcome and period filters.
- `[warn] this run is NOT recorded in the run log`: the run itself went through; fix the permissions or free the disk of the folder named. See run-log.md.

## Setting up the target: `machine install` (decision 87)

Run in a terminal ON the target (a local command, never remote). First item: `suspend`, Linux only; see `install.md`.

```
machine install                      list what can be installed, where, and its state here (alias: machine install status; --json)
machine install suspend --dry-run    every file and command, nothing changed (no terminal needed)
machine install suspend              the same, then y/N, then sudo (your own password) installs the script and the sudo rule
machine install suspend --check      installed / not installed / outdated, no password
machine install suspend --remove     remove exactly what it installed
```

It then prints the line for the admin machine (`machine admin allow <machine> --shell sh -- /usr/local/bin/machine-suspend`), how to run it and how to wake the machine (`machine wake <machine>`). Once allowed in the default list, every trusted peer can suspend the machine; a per-peer list restricts that. Windows and macOS: `not supported on <platform> yet (supported: linux)`.

## Rules a user meets
States: `not installed`, `installed` ("installed, up to date"), `outdated`, `partial` (names the missing part), `foreign` (a file machine did not write: never touched), `unsupported here`. `machine status` prints one line for the installed items (`installed: suspend (up to date)` or a `[warn]` with `--refresh`), nothing when none is installed. See `install.md`, "Lifecycle".


- Command groups (decision 66): `machine <group>` alone shows the current state, read-only: `admin` the candidacies waiting for approval (never asks, never approves; `machine admin approve [<id>]` does), `peer` the peers, `startup` the job status, `cli` the versions, `alias` the aliases, `policy` its help. `machine <group> --help` (or `machine <group> help`, `machine help <group>`) is the help of the group, `machine <group> <subcommand> --help` of one subcommand. An unknown subcommand is a usage error (exit 2) with the list.

- Name: the computer name, lowercase (`Midgard2.local` becomes `midgard2`); `--name` overrides it at creation. It is the signed reference. A friendlier label: `machine alias set <label> <name>`, accepted wherever a machine is named.
- Passphrase: 12 characters minimum, a warning below 20; a typo or a too-short entry is asked again (3 attempts, then nothing is created); prompts are short, the explanation is printed above them; `--generate` or an empty answer gives a random one, shown once. It cannot be recovered.
- Passphrase hint (decision 57): optional, asked after the confirmation (Enter = none) or `--hint <text>` (admin init, setup); 80 printable ASCII characters, never the passphrase itself (refused if it contains it). Shown as `Hint: ...` above every unlock prompt on every machine. Stored in clear in the key file: see the threat model.
- Times are local with a relative hint (`expires in 15 min (16:07)`); `--json` keeps ISO strings and epoch seconds.
- Typed entries and lifetimes (decision 79): `machine admin allow <machine> --shell sh --times 5 -- "orch logs <job:name> --tail <n:int(1,500)>"`. A placeholder is `<label:type>` (types `int(min,max)`, `duration(min,max)`, `name`, `port`, `hexid(n)`, `uuid`, `enum(a|b)`), each accepting only a short whitelist of characters; a value never starts with `-`. Before the passphrase the command prints the template, the lifetime and two accepted and two refused examples; a typed entry on `sudo`, `git -c`, `orch add` ... is signed only after a loud `[warn]`. Lifetime: permanent by default, `--times N`, `--for 2h`, `--until 2027-02-01` (at most 10000 calls / 365 days); allowing again with other limits replaces them. `--remove` takes the text or `--index <n>` (the number `machine allowed` shows); a text held under several shells is listed, nothing signed. A policy with a typed entry is version 2: the target needs `machine cli update` first. Details: `typed-parameters.md`.
- The shell is part of the exact entry (decision 71). From a Windows machine to a Linux target: `machine admin allow thinkcentre --shell sh -- ls`, then `machine run thinkcentre --shell sh -- ls`, or once `machine peer connect thinkcentre --shell sh` (default shell of that machine on this one; `--no-shell` removes it). `machine admin allow` prints the exact `machine run` that matches. A `not-listed` refusal says when the same command exists under another shell. `machine allowed <machine>` lists what the policy signed here allows (read-only).
- `machine run <machine> -- <command>` needs no local daemon. The daemon of the TARGET machine must run (`machine startup enable` there) to receive the policy and the command. `machine list` says so per peer: `On "laptop" run machine startup enable ... then run machine list again here`.
- `no-policy` right after `machine admin allow` (decision 70): the policy is in the relay inbox of the target, not installed yet. A target without a policy reads its inbox every 10 s for the first 5 minutes after its daemon starts, else every 60 s: retry shortly. `machine run` adds `a policy (version N) for <machine> was signed here <age> and sent through the relay: it is not installed yet; retry in about N s` when it recorded one less than 15 minutes ago. Still refused after a few minutes: is the daemon of the target running (`machine list`, `machine startup enable` there)? Is the target in mode local (`machine status` there; it refuses admin-signed policies)?
- `machine admin allow` assumes the target has no policy when none was signed on this machine; a target holding a policy signed elsewhere refuses it ("policy changed, reload").
- After `machine admin revoke`, `machine status` lists the revoked machines apart (`laptop  uuid 5c8179d2  revocation installed here 3 min ago (15:52)`); `machine admin forget-relay-record laptop` and `machine admin distribute laptop` take the name, the uuid or a uuid prefix.
- `join --no-wait`, `join --resume`, `admin login <code>`, `admin approve <id>`, `init`, `admin init` stay for scripts and interrupted runs.
- Diagnosis: every command writes a trace into `<configDir>/logs/<day>.ndjson` (the command line, its `[ok]`/`[warn]`/`[fail]`/`[info]` lines, the exit code and duration); `machine cli logs` (`-f` to follow) shows it, together with the updater and daemon lines. 8-digit and 25-digit codes are replaced by `<code>`; passphrases and the generated passphrase are never written. `--help` and `--version` are not traced. A log that cannot be written is a `[warn]` on stderr.
