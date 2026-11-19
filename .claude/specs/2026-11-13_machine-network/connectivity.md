# Connectivity strategies and Wake-on-LAN -- Machine Network

**Status:** analysis, nothing decided, no code. Proposed decision number: 61 (not recorded in `_index.md` yet).
**Trigger:** the Linux box and the M2 Pro Mac sleep; `machine run` must wake them when they cannot be reached.
Tags: [V] read in the repo; [GK] general knowledge, not verified here; UNVERIFIED = must be tested on the real device.

## 1. Current state

| Topic | Fact |
|---|---|
| Who chooses the address | Caller: `--address` if given, else the relay record of the peer. Nothing is stored per peer [V `cliNetwork.ts:467-485`] |
| Relay path | `resolvePeerAddresses` -> `getMachine(uuid)`, record verified against the admin-signed registration, highest seq kept in `peer-records.json` (rollback refused), loopback/unspecified/link-local destinations dropped [V `peerAddresses.ts:122-177`, `addressRecord.ts:109-112`] |
| Order and timeout | Published order, each address 3 s (connect + TLS + pair proof) [V `peerAddresses.ts:230-248`, `cliNetwork.ts:482`] |
| `--address` | One `host:port`, the relay is not asked, NO per-address timeout is passed, so the 10 s handshake default applies [V `cliNetwork.ts:467-471`, `channel.ts:13,346`]. Loopback is allowed (only `hostProblem` runs, not `destinationProblem`) [V `addressRecord.ts:120-128`]: an SSH `-L` tunnel already works |
| Published by the target | Up to 8 `{host,port}` signed with its identity key: `--advertise`, else the bound `--peer-host`, else discovered interfaces (private ranges first, virtual names last). Republished on change and every 7 days; the heartbeat is 60 s [V `addressDiscovery.ts:24-57,132-160`, `addressPublisher.ts:21,163-221`, `relay-api.md:103-108`] |
| Presence | Relay `online` = last heartbeat under 120 s; informational only: `online:false` is a `[warn]`, the addresses are tried anyway [V `cliNetwork.ts:479-481`, `relay-api.md:112`] |
| Unreachable | Every failure is kept; `PeerAddressError` "could not connect to any of the N address(es) ... may be off, behind a router ... or `--address`"; `run` exits 255 (decision 49) [V `peerAddresses.ts:245-247`, `cliNetwork.ts:421-424`] |
| Failure kinds | Untyped: `connectToPeer` rejects with plain strings ("cannot reach", "no answer within", pin mismatch, "failed the pair secret proof") [V `channel.ts:364-391`]. A wake logic must not fire on an authentication failure, so the failure needs a type |
| `machine ping` | Does NOT exist [V: no `ping` in `cli.ts` usage]. Needs defining (section 4) |
| Connection config | None. No per-peer file on the caller |
| Autostart | The daemon starts at LOGIN (orch `startup` job, decision 3), not at boot: a machine woken from power-off without auto-login never listens |

Consequence: a sleeping target today fails after 3 s per address with a generic message and nothing happens.

## 2. Principle for any connection strategy

A strategy decides only HOW BYTES REACH an address. It never decides who is trusted: the TLS key is pinned to the admin-signed registration and the pair secret is proven on the channel (T-35, [V `channel.ts:382-391`]), whatever the path. So a strategy cannot widen trust, and it lives in UNSIGNED LOCAL config on the CALLER (`<configDir>/connections.json`, public data, atomic write + lock like `peer-records.json`). Hard rule 4 (admin signature) applies only to what widens rights: a capability that makes ANOTHER machine act (the waker, section 3.6) does.

Why a relay-published hint is refused (T-33): the relay is hostile (A-1). A hint it can set could (a) point the caller at an attacker endpoint (the ClientHello and client certificate leak who calls, T-33 limit 2), (b) name a command to run on the caller (code execution on the caller), (c) name a MAC or proxy to aim packets or traffic at a third party. A hint inside the target's own signed address record is cryptographically the target's word, which the relay cannot forge (it can still replay an old one, same rollback limits as T-33). That is acceptable ONLY for inert data (a MAC, section 3.4), never for an executable or a proxy.

## 3. Catalogue

| # | Strategy | What | Config (where) | Security impact | Effort | Verdict |
|---|---|---|---|---|---|---|
| S1 | Direct | Today: signed record, addresses in order | none | none | done | keep as default |
| S2 | Direct, pinned address | Persist what `--address` does, per peer, optionally several; a DNS name allowed (dyndns, overlay IP) | `connections.json` on the caller, key = peer uuid | Same as `--address` today. No relay needed. Pinned beats the relay record only if the user says so (see Q2) | S: reuse `parseAddress`, `connectFirst` | DO NOW (phase A) |
| S2b | External tunnel (SSH `-L`, WireGuard, Tailscale) | The user runs the tunnel; machine connects to `127.0.0.1:<local port>` or the overlay IP via S2 | S2 | None added: no process spawned by machine, TLS pinned end to end | zero code, doc only | DO NOW (document in getting-started) |
| S3 | ProxyCommand-like wrapper | machine spawns a configured command and speaks TLS over its stdio (needs `tls.connect({socket})`, [V] current code takes only host/port, `channel.ts:352`) | would be a caller-local `argv[]` | Runs a configured program as the user on every `run`. Same-user processes (agents, A-2) can edit the file, but they already run anything as the user (A-3), so no NEW right, yet a prompt-injected agent gets a persistent hook that fires at the user's next `run`. Rules if ever built: argv array, no shell, never from the relay or any signed doc, printed at each use, file mode checked, env scrubbed (rule 9 spirit), timeout | M | LATER, only if S2b is not enough. Refuse any variant where the command comes from the network |
| S4 | SOCKS5 / HTTP CONNECT proxy | Dial the target through a proxy | caller-local `proxy: host:port` (+ credentials in `_secrets_/`, never in `connections.json`) | Proxy sees destination and ciphertext, cannot read or alter (pinned TLS); can drop and observe metadata. Credentials are a new secret. HTTP CONNECT is about 40 lines on `node:http`; SOCKS5 more; a library = new dependency (ask first). Hostile-proxy case = DoS only | M | LATER. Useful if the work laptop sits behind a corporate proxy (fact unknown, decision 34 open fact) |
| S5 | Relay-assisted rendezvous | Relay only exchanges candidate addresses (hole punching), then peers talk directly | relay API + candidates signed by each machine with a short life | Relay carries metadata only: compatible with decisions 33-34 ("can be added later without changing the protocol"). Candidates must be signed like address records (T-33). TCP simultaneous open is unreliable (GK); UDP needs a new transport, not TLS-over-TCP | L | LATER, needs the relay owner and a transport spike |
| S6 | Relay forwards the encrypted channel (TCP relay) | Relay copies opaque bytes of the end-to-end TLS channel | relay | CONFLICTS in letter with decision 33 ("never carries commands"), decision 34 ("no relay fallback"), TB-2, and invalidates AR-4's rationale ("the relay never sees message sizes"): it would see sizes, timing and volume, and carry bandwidth on a shared Node process (T-08). Content stays unreadable and unmodifiable (pinned TLS 1.3 + pair proof), so confidentiality and integrity hold; availability and metadata do not | L + relay | REFUSE unless the user explicitly reverses decisions 33-34. Honest wording if reversed: "the relay never SEES or can ALTER commands or output; for peers that cannot connect directly it may CARRY their opaque encrypted bytes, and then sees sizes, timing and the peer pair". Opt-in per peer, never silent |
| S7 | Wake then direct | Try direct; if unreachable, wake the target (section 3), retry | `connections.json` (caller), later a signed capability on a waker | Section 3 | S (A) / M (B) | DO NOW (A), then B |

Verdict summary: S1, S2, S2b, S7 now; S4, S5, S3 later in that order; S6 refused until a decision reverses 33-34.

## 4. Wake-on-LAN in depth

### 4.1 Facts about the protocol [GK, offline-checkable by unit test for the bytes]

- Magic packet payload = 6 bytes `FF` + 16 repetitions of the target's 6-byte MAC = 102 bytes. An optional trailing SecureOn password (4 or 6 bytes) exists on few NICs: not supported here.
- Carried in a UDP datagram (conventionally to port 9 "discard", sometimes 7), to a broadcast address, or as a raw Ethernet frame (EtherType 0x0842, not reachable from Node). The NIC matches the payload on the wire, so the IP and port do not matter to the NIC; they matter to routers and firewalls.
- Needs the target MAC. Needs `setBroadcast(true)` on the Node `dgram` socket. Limited broadcast (255.255.255.255) does not cross a router; a subnet-directed broadcast is dropped by default by most routers. Hence: sender and target on the same L2 segment, or an agent on that segment.
- Fire and forget: no acknowledgement exists. Success is only observed by the target answering afterwards. The CLI can never say "the packet was received".
- Wi-Fi: standard magic-packet wake works on wired NICs; on Wi-Fi it depends on WoWLAN support in the chip, driver and firmware, and is unreliable in general (GK). Do not promise it.
- Node: `os.networkInterfaces()` gives per-interface `address`, `netmask`, `mac`, `internal` [V `addressDiscovery.ts` already uses it], enough to compute each subnet's directed broadcast and to read the local MAC for `wake-info`.

### 4.2 Target prerequisites (what `machine wake-info` must print, not check)

| OS | Required | Status |
|---|---|---|
| Linux (Intel i7 box, decision 39) | BIOS/UEFI: enable "Wake on LAN" / "PCIe wake" / disable ErP-EuP deep power saving; `ethtool <if>` must show `Supports Wake-on: ... g` and `Wake-on: g`; set `ethtool -s <if> wol g` (not persistent), or NetworkManager `nmcli c modify <conn> 802-3-ethernet.wake-on-lan magic`, or systemd-networkd `WakeOnLan=magic` in the `.link` file. Suspend-to-RAM (S3) is the most reliable; wake from full power-off (S5) is BIOS and driver dependent. Some drivers reset WoL at shutdown (GK) | [GK] UNVERIFIED on this box |
| Apple Silicon Mac (M2 Pro) | System Settings energy option "Wake for network access" (the label differs by macOS version and by Mac type); likely requires power adapter and wired Ethernet for the magic packet; on Wi-Fi the Mac wakes through Bonjour Sleep Proxy for service requests, which is a different mechanism that a raw magic packet does not use; a laptop on battery or lid closed may not wake | UNVERIFIED (nothing available offline). Also unknown: is the "M2 Pro Mac" a Mac mini (Ethernet port) or a laptop (Q4) |
| Windows | NIC driver "Wake on Magic Packet" on, "Allow this device to wake the computer" on, Fast Startup off for wake from "shutdown" (hybrid S4/S5); only sleep/hibernate are reliable | [GK] UNVERIFIED; not needed for the stated machines |

Always-on caveat [V decision 3]: waking from power-off boots to the login screen; the daemon starts only at login. Recommend suspend, not shutdown, or auto-login. `machine wake-info` says so.

### 4.3 Wait loop ("ping-if-not-reachable-magic-packet")

1. Resolve addresses (pinned or relay record) and `connectFirst` as today (3 s each). Success = no wake, no extra output.
2. On failure, wake only if every failure is of the kind `unreachable` or `timeout` (type to add to `connectToPeer`). Pin mismatch, pair proof, closed during authentication, revoked: never wake, report as today (waking cannot fix them).
3. Check the target is on a local LAN: some local IPv4 interface subnet must contain a known address of the target (pinned, or the last verified record in `peer-records.json`, [V] kept there). If not: stop with "this machine is not on the LAN of <peer>; a waker is needed (phase B) or run from the same network". No blind broadcast.
4. Send the packet at t=0, 5, 15, 30 s (4 packets max per invocation, backoff in the config), to the directed broadcast of each qualifying local interface plus 255.255.255.255 bound to that interface's address (bind keeps it off VPN and virtual adapters, reusing the `VIRTUAL_NAME` heuristic; which interface the OS picks for a limited broadcast is OS dependent and UNVERIFIED). After each packet, retry the connect with the 3 s limit until the next one.
5. Re-read the relay record between rounds (the address may change after resume: DHCP). The relay `online` flipping to true is a hint to retry at once, never proof.
6. Total wait default 90 s (`waitSeconds`, bounded 10..300). Past it: exit 255 with the cause list and the fixes (section 4.2 checklist for the OS, `machine wake-info` on the target, the wait value).

What the user sees (stderr, same style as the existing `[warn]` lines):

```
[info] "linux-box" is unreachable (192.168.1.40:47921: no answer within 3000 ms)
[info] sending a magic packet to aa:bb:cc:dd:ee:ff on 192.168.1.255 (1/4), waiting up to 90 s
[info] still unreachable after 15 s, packet 2/4 sent
[ok] "linux-box" answered after 21 s (woken); running the command
```

Failure ends with: "no answer after 90 s and 4 packets. Wake-on-LAN gives no acknowledgement: check the target (BIOS, `ethtool <if>` shows `Wake-on: g`, sleeping rather than powered off, its daemon running at login), then `machine wake linux-box --wait 180`".

### 4.4 Where the MAC comes from

| Source | Trust | Verdict |
|---|---|---|
| Typed by the user on the caller (`--mac`), shown by `machine wake-info` on the target | The user's word, local | Phase A |
| Inside the target's signed address record (new optional field) | Signed by the target's identity key, so the relay cannot forge it, only replay; but a compromised target could name any MAC. Needs a record format change: `assertKeys` is strict and refuses unknown fields [V `addressRecord.ts:132-135`], so a new field needs `v: 2` and breaks old readers | LATER, optional convenience |
| Inside the admin-signed registration or policy | Strongest: the admin vouches for it | Phase B (waker policy) |
| The relay record / any relay field | Hostile | NEVER |

### 4.5 Waker role (phase B): caller not on the target's LAN

A caller outside the LAN (the work laptop, a phone-tethered laptop) cannot send the packet. An always-on enrolled machine W on the target's LAN does it on request.

- Request: a new request type on the existing peer channel (no new listener, hard rule 1; no local-token path, rule 2). It carries ONLY the target uuid. No MAC, no address, no port on the wire: nothing a caller can aim (rule 3 spirit: no free parameter on the wire).
- Authorisation: a new section of W's admin-signed policy (decision 27 compare-and-set, rule 4): `wake: [{ target: <uuid>, mac, broadcast, callers?: [uuid], limits }]`. A caller not allowed (default list or per-peer list, decision 14 semantics) gets `refused: not-listed` and the exact `machine admin allow-wake ...` line to run on the admin machine, like `allow` today [V `cliNetwork.ts:507-511`]. This is a distinct capability, NOT a command allowlist entry: wake is not a shell command and must not be modelled as one (rule 3 says "executed only if it matches an allowlist entry": the model needs an explicit amendment naming the wake capability).
- W refuses: unlisted target, a target whose registration is revoked (checked against the signed revocation set), a caller that is revoked, a rate-limit breach.
- Audit: hash-chained entry on W (caller uuid, target uuid, MAC, number of packets, result of the send, request id) and on the caller. A packet sent is recorded as "sent", never "woke".
- Interaction with revocation and policy: revoking a machine removes the right to ask (session refused) and to be woken. A policy without `wake` grants nothing (deny by default, P-1). Lockdown (decision 25) must also stop wake sending.
- Threat model delta needed before shipping (rule 10): a new row "wake capability abuse" (waker as a confused deputy, storms), a hard-rule 3 amendment, `Open` threats not allowed in the feature.

### 4.6 Abuse cases and limits

| Case | Limit |
|---|---|
| Wake storm from a loop around `machine run` | Caller: at most 4 packets per invocation, minimum 5 s apart; a per-peer cooldown of 60 s kept in a local state file (a same-user reset is accepted, AR-5). Waker: signed `limits`, default 1 wake per target per 60 s and 20 per hour, counted per caller and per target (decision 44 counters) |
| Spoofed or hostile MAC wakes another device | The MAC is read only from the caller's own config (A) or W's signed policy (B), never from the wire or the relay. A hostile relay cannot choose it. A mistyped MAC wakes some other device on the LAN: harmless, and the packet goes to the LAN broadcast only |
| Using machine as a UDP sender to the Internet | Destination restricted to the directed broadcast of a local IPv4 subnet or 255.255.255.255; an override must equal one of those, else refused. Fixed ports 9 and 7 only |
| Amplification | One request = at most 4 packets of 102 bytes, on the LAN, no reply traffic |
| Waking a stolen or lost machine | Revocation does not stop WoL by itself (the NIC listens to anything); only the waker refuses. The target is still protected by TLS pinning, the pair secret and the allowlist. A woken thief learns nothing |
| Packet observed on the LAN | The magic packet is cleartext and carries only the MAC: it discloses that wake happened, nothing more (accepted) |

## 5. Recommended minimal design

### 5.1 Config (caller, unsigned, `<configDir>/connections.json`)

```json
{
  "v": 1,
  "peers": {
    "<uuid of linux-box>": {
      "type": "ping-if-not-reachable-magic-packet",
      "addresses": [{ "host": "192.168.1.40", "port": 47921 }],
      "wake": { "mac": "aa:bb:cc:dd:ee:ff", "broadcast": "192.168.1.255", "waitSeconds": 90 }
    },
    "<uuid of mac>": { "type": "direct", "addresses": [{ "host": "mac.example.net", "port": 47921 }] }
  }
}
```

`type` is one of `direct` (default, S1/S2), `ping-if-not-reachable-magic-packet`. An unknown `type`, an unknown field or a bad MAC fails loudly naming the file and the field (P-2). `addresses` empty = use the relay record. No secret in this file.

### 5.2 Command surface

| Command | Does |
|---|---|
| `machine peer connect <peer> [--address h:p]... [--wake-mac <mac>] [--wake-broadcast <ip>] [--wait <s>]` | Writes the entry for that peer (y/N when it replaces one); `--show`, `--rm` |
| `machine wake-info` (on the target) | Prints the MAC and the IPv4 of each non-virtual interface, the OS checklist of 4.2, and the suspend-versus-shutdown warning. Runs no external program |
| `machine wake <peer> [--wait <s>]` | Sends the packets and waits for the peer to answer an authenticated connect (like `ping`); exits 0 reached / 255 not |
| `machine ping <peer> [--wake \| --no-wake]` | New. Authenticated session open + revocation catch-up + close, reports address, latency, source (relay/pinned). Does not run a command |
| `machine run <peer> [--wake \| --no-wake] ...` | `--wake` forces the loop even without config (needs `--wake-mac` or an entry); `--no-wake` forbids it. Config `type` makes it automatic |

The wake step is a `machine-core` pure function (packet bytes, directed broadcast computation, the step schedule as data); the daemon and CLI inject the socket and the clock (P-7).

### 5.3 Phasing

| Phase | Content | Needs |
|---|---|---|
| A | S2 pinned addresses, typed connect failures, `connections.json`, `peer connect`, `wake-info`, `wake`, `ping`, `run --wake`, caller-side limits and audit entry, same-LAN direct WoL | A decision (61) and a spec line in `_index.md`; no relay change, no protocol change |
| B | Waker: signed `wake` policy section, request type, `admin allow-wake`, waker limits, audit, threat model rows, hard rule 3 amendment | Admin signature path, protocol version bump (decision 7), user's always-on machine |
| C (optional) | MAC in the signed address record (`v: 2`), S4 proxy, S5 rendezvous | Relay owner for S5 |

### 5.4 Tests

Offline, TDD: packet bytes (102 bytes, header, 16 MACs, MAC parsing with `:` `-` and refusal of anything else); directed broadcast from address and netmask; destination validation; the step schedule with the fake clock already in `testing.ts` [V line 127]; failure typing so authentication failures never wake; config parsing errors; rate limit and cooldown; a fake `dgram` socket recording sends; a loopback UDP socket receiving the real bytes; the wait loop with a fake peer that starts listening after N seconds of fake time; audit entry content.
Cannot be tested offline: that a real NIC wakes (BIOS, driver, switch, Wi-Fi), the interface chosen by the OS for a limited broadcast on Windows/macOS/Linux, Apple wake behaviour, the time a real resume takes, DHCP changes after resume, whether the work network passes UDP broadcast. These need a manual checklist on the real boxes.

## 6. Questions for the user (recommendation after each)

1. Record the strategy as decision 61 with S1, S2, S2b, S7 in scope and S6 refused? Yes.
2. Pinned address versus relay record: which wins when both exist? Recommend pinned first, then the relay record (the user pinned it for a reason); `--address` still beats both.
3. Phase A first (same LAN only), waker later? Yes: it delivers the two machines on the home LAN with no protocol change.
4. Is the "M2 Pro Mac" a Mac mini (Ethernet) or a laptop? Decides whether WoL is plausible at all; if a laptop on Wi-Fi, expect to need a waker or to keep it awake.
5. Which machine is always on and on the same LAN as both targets (candidate waker)? Unknown to me; none of the stated machines is a candidate if all sleep.
6. Sleep (S3) versus shutdown for the targets? Recommend sleep, since the daemon starts at login only.
7. May the MAC go in the signed address record later (needs `v: 2`)? Recommend not now: the typed MAC is enough for two machines.
8. Wake audit on the caller in the existing hash-chained log? Recommend yes, one entry kind; the log format must accept it (unchecked).
9. Reverse decisions 33-34 for a relay TCP fallback (S6)? Recommend no.

## 7. Not verified

- Every Apple and Windows claim, and every Linux command in 4.2 (taken from general knowledge; nothing run).
- That Node `dgram` broadcast bound to an interface address leaves by that interface on Windows 10/11, macOS and Linux.
- That the Linux box and the Mac wake from sleep on a magic packet at all (hardware, BIOS, switch, router).
- Whether the audit log format and the protocol hello can take new kinds without a version bump (code not read for this).
- Whether `tls.connect({socket})` fits the current `connectToPeer` pinning flow (S3, S4): only the host/port form was read.
- The existence of any relay limit relevant to S5/S6 (relay code not read).
- Hard rule 3 and decision 14 wording for a non-command capability: proposed amendment, not discussed with the user.
