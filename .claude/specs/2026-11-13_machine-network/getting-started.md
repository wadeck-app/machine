# Getting started

**Version:** v0.6 (2026-11-19). Implements decisions 51 to 62. The flows were run against the real relay by `npm run test:relay` (see ux-audit-2026-11-15.md).

## Commands per case

| Case | Commands | Human steps |
|---|---|---|
| First machine (also the admin) | `machine setup <relay>` | choose the admin passphrase (typed twice, asked again after a typo, 3 attempts) and an optional hint; confirm the relay login code in the relay console, once (MACHINE ADMIN: can approve machines, cannot manage tokens) |
| Another machine | `machine join <relay>` there, `machine admin approve` on the admin machine | type the relay login code on the relay page; on the admin machine: y/N and the passphrase; on both machines: compare the security code |
| Allow a command | `machine admin allow <machine> -- <command>` on the admin machine | y/N and the passphrase |
| Start at login (each machine) | `machine startup enable` | none; never automatic unless `--auto-startup` |
| Test the connection | `machine ping` (path to the relay), `machine ping <machine>` (channel to a peer) | none; runs nothing, needs no allowlist entry |
| Reach a machine that sleeps (same LAN) | `machine peer connect <machine> --address <ip>:<port> --wake-mac <mac>` once, then `machine run` / `machine ping` as usual; `machine peer wake <machine>` to wake now | type the MAC of the target (never learned from the relay) |

The relay is named once (`<relay>` is a host or URL), then stored. A machine that holds the admin key and runs `machine join <relay>` approves itself (needs `machine admin login` first, or use `setup`). The token of `setup` is the machine token AND the admin token of the first machine (one file content in `relay.json` and `relay-admin.json`); `machine admin login` on another machine adds `<name> admin`. A relay without the `machine-admin` scope fails loudly: update it; `machine admin login --full-access` (a full-access token that can also manage tokens) is the explicit opt-in.

## The codes (decision 55)

| Code | Looks like | Where it comes from | What you do with it |
|---|---|---|---|
| Relay login code (admin) | `X35M-M87M` | printed by `setup` and `machine admin login` with MACHINE ADMIN (can approve machines, cannot manage tokens) | compare it with the code the relay console shows (Tokens page lists the request "<name>" or "<name> admin"), check the source address is this computer, then approve; if the console shows several codes, click this one (a different code denies the request and you run the command again): nothing to copy |
| Relay login code (machine) | `X35M-M87M` | printed by `join` | type it in the relay console: it only gives this machine access to the relay |
| Pairing code | 8 digits | relay console, Tokens, Add token, "Limited to scopes", machine-admin | only for scripts (`machine admin login <code>`); with `--full-access` on a relay that predates the full-access login (`[warn]` line, then it is asked, WITHOUT "Limited to scopes") |
| Security code | `31447 56532 70010 53274 49389` | printed on the admin machine after it signs, and on the new machine | compare the two: it must read exactly the same on both. If not, `machine admin revoke <name>` |

The candidacy code (base32, `XXXX-XXXX-XXXX-XXXX`) is internal: the admin machine recomputes and checks it, nothing to compare. `--verbose` (join, setup, admin approve) and `--json` show it.

Security code: 25 digits, 83 bits. `--yes-final-code` takes it quoted or as five words.

## What the new machine and the admin see

New machine (`machine join <relay>`):

```
Relay login code for "laptop" on <relay>. Type it on the relay page (it only gives this machine access to the relay, it is not the security code):

  TH9B-3MHH

Relay page: <relay page>
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
machine peer wake <machine>                  wake now, wait for the answer, print the measured time
machine run <machine> --wake|--no-wake ...   force or forbid the wake for this command (same on machine ping <machine>)
```

| Setting | Flag | Default | Range | Meaning |
|---|---|---|---|---|
| `probeSeconds` | `--wake-probe` | 5 | 1 to 60 | probe window after each packet |
| `waitSeconds` | `--wake-wait` | 90 | 10 to 600 | total wait for the answer |
| `maxUnicast` | `--wake-max-unicast` | 4 | 0 to 8 | unicast packets at most |
| `maxBroadcast` | `--wake-max-broadcast` | 4 | 0 to 8 | broadcast packets at most |
| `connectTimeoutMs` | `--wake-connect-timeout` | 1000 | 200 to 10000 | one probe attempt |
| `settleSeconds` | `--wake-settle` | 0 | 0 to 120 | pause after the answer, before the command |
| `wake.broadcast` | `--wake-broadcast` | the broadcast of the shared subnet | an IPv4 | only needed when no IPv4 address of the peer is known |

- Order: unicast to the pinned (or last known) IPv4 address, probe, directed broadcast, probe, alternating; success stops at once. A flag changes that value and keeps the others.
- Tuning: a wake prints `answered after 14.2 s, woken by unicast (probe window 3, 4.2 s into its 5 s)`; after more than 80% of a window it prints the command that raises `probeSeconds`. "By unicast" names the last packet before the answer: Wake-on-LAN gives no acknowledgement.
- Only an unreachable or silent peer is woken, never an authentication, registration or revocation failure. A second wake of the same peer within 60 s sends no packet (it still waits).
- The target must SLEEP, not be shut down: its daemon starts at login, so a machine woken from power-off without auto-login does not listen. BIOS/UEFI and driver Wake-on-LAN settings are on the target (on Linux `ethtool <interface>` shows `Wake-on: g`); Wi-Fi targets are unreliable.
- Trace: `<configDir>/wake-audit.log` (who woke what, how many packets, hash-chained); the settings are in `connections.json` (no secret).

## Rules a user meets

- Name: the computer name, lowercase (`Midgard2.local` becomes `midgard2`); `--name` overrides it at creation. It is the signed reference. A friendlier label: `machine alias set <label> <name>`, accepted wherever a machine is named.
- Passphrase: 12 characters minimum, a warning below 20; a typo or a too-short entry is asked again (3 attempts, then nothing is created); prompts are short, the explanation is printed above them; `--generate` or an empty answer gives a random one, shown once. It cannot be recovered.
- Passphrase hint (decision 57): optional, asked after the confirmation (Enter = none) or `--hint <text>` (admin init, setup); 80 printable ASCII characters, never the passphrase itself (refused if it contains it). Shown as `Hint: ...` above every unlock prompt on every machine. Stored in clear in the key file: see the threat model.
- Times are local with a relative hint (`expires in 15 min (16:07)`); `--json` keeps ISO strings and epoch seconds.
- `machine run <machine> -- <command>` needs no local daemon. The daemon of the TARGET machine must run (`machine startup enable` there) to receive the policy and the command. `machine list` says so per peer: `On "laptop" run machine startup enable ... then run machine list again here`.
- `machine admin allow` assumes the target has no policy when none was signed on this machine; a target holding a policy signed elsewhere refuses it ("policy changed, reload").
- After `machine admin revoke`, `machine status` lists the revoked machines apart (`laptop  uuid 5c8179d2  revocation installed here 3 min ago (15:52)`); `machine admin forget-relay-record laptop` and `machine admin distribute laptop` take the name, the uuid or a uuid prefix.
- `join --no-wait`, `join --resume`, `admin login <code>`, `admin approve <id>`, `init`, `admin init` stay for scripts and interrupted runs.
- Diagnosis: every command writes a trace into `<configDir>/logs/<day>.ndjson` (the command line, its `[ok]`/`[warn]`/`[fail]`/`[info]` lines, the exit code and duration); `machine cli logs` (`-f` to follow) shows it, together with the updater and daemon lines. 8-digit and 25-digit codes are replaced by `<code>`; passphrases and the generated passphrase are never written. `--help` and `--version` are not traced. A log that cannot be written is a `[warn]` on stderr.
