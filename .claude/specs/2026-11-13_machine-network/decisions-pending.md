# Pending decisions -- Machine Network

Single place for every question waiting on the user. Each entry is self-contained: no need to read the chat.
Updated: 2026-11-13. Answered entries move to `_index.md > Decision Log`.

## D-A. Remote wrapper strategy for the CLIs (task, flow, queue, orch, project)

**SUPERSEDED (2026-11-13) by D-A2 at the end of this file.** The facts below came from a superficial reading of the plugin systems. Kept for history only.

**Facts (verified in code):**
- No single integration seam exists:
  - orch: `createDaemonClient` (singleton-daemon-kit `client.ts`), `POST /<command>` with bearer token on loopback; when no daemon runs, it silently executes the LOCAL handler (`client.ts:110-113`).
  - queue: its own client in `queue-sdk/src/daemon.ts`; it reads `config.port` + `health_token` and verifies pid and config dir through `GET /version` before sending the token. `queue wait` reads local history files, not the daemon.
  - task: no daemon; built-in `remote` strategy (`plain-http`) already exists and works through a loopback port forward (task-owner, no task change needed).
  - project: no daemon; files only; a remote `resolve` must be answered by the peer's own registry.
  - flow (repo `agent-fleet`, package `packages/flow-cli`): singleton daemon with a WebSocket protocol (not HTTP) on loopback (`worker.bindAddress` defaults to `127.0.0.1`), config dir `~/.config/flow`. `flow run` executes `script:` shell bodies from flow YAML and model CLIs (arbitrary code), `run --wait` and log tailing are streaming. flow already has "remote workers dial IN to a local daemon" (`built-in:inbound`, single-use token valid 120 s; `--command "ssh host flow worker"` with an unresolved token-on-command-line caveat; "no relay process ships yet", `WORKERS.md`). No `--machine` option.
- Faking a "virtual config dir" so CLIs talk to a local proxy is NOT viable: queue-sdk's pid/config-dir check would be defeated or fail, and orch's client would silently fall back to local execution if the proxy is down.

**Options:**
- **A. Typed wrapper per CLI.** `machine-sdk` package; each CLI gets `--machine <peer>` that swaps its client transport (task: the existing remote strategy). The peer's machine daemon calls its local daemon only for allowlisted `<cli>:<command>` pairs (e.g. `orch:list`, `queue:push`). Pros: fine-grained authorization, typed errors, no shell. Cons: one integration per CLI, each owner must agree; slowest to deliver.
- **B. Remote argv execution.** `machine run <peer> -- <cli> <args>`: the peer's daemon spawns the local CLI with an argv allowlist (cli + subcommand) and streams output (`--json`). Pros: works for every CLI immediately, no change in the CLIs. Cons: coarse authorization (argv, not typed API), process spawn per call, PATH/env issues on the peer, larger attack surface (CLI argument parsing on untrusted input).
- **C. Hybrid.** B first as the generic engine behind the allowlist, then typed wrappers (A) per CLI, starting with task (zero change) and orch (kit client). Pros: value now, tightening later. Cons: two paths to maintain during the transition.

**Security:** A and C narrow EoP best (command-level capabilities, S5, S15). B must never accept a free shell string; argv array and per-peer allowlist only.
**Recommendation:** C, with task first.
**Unblocks:** open question #6 (per-CLI integration), #3 (execution model).

## D-B. Key model (identity key vs per-pair keys)

**Context:** decision 4 (one Ed25519 key per machine) was a derived default, reopened by the user. 4 machines = 6 pairs, 5 machines = 10 pairs (P-4: small scale makes per-pair management affordable).
**Technical wrinkle:** Noise handshakes use X25519 static keys (DH); signing commands (S4) needs Ed25519. So each machine holds either two keys or one seed deriving both.

**Options:**
- **A. One identity key per machine** + ephemeral session keys (Noise XX/IK). Simple, one fingerprint per machine. Revocation is all-or-nothing; the relay sees a stable identity and can correlate.
- **B. One key pair per machine pair.** Revocation/rotation per pair, no global identity visible to the relay. 6 enrollment ceremonies for 4 machines, more keys to store; a compromised machine still exposes all its pairs.
- **C. Identity key per machine + a pre-shared secret per pair** mixed into the handshake (Noise IKpsk2 or XXpsk3). Per-pair revocation by changing the PSK; leak of the identity key alone is not enough to connect (defense in depth); one identity enrollment per machine plus one PSK per pair.

**Security:** all three give mutual authentication and forward secrecy (S1, S2). C and B limit blast radius of a leaked key better (T-01, T-06).
**Recommendation:** C.
**Unblocks:** enrollment (S8), revocation (S9), threat entries T-01/T-05/T-06.

## D-C. Transport topology (DECIDED 2026-11-14, decision 33: direct machine to machine; the relay-forwarded and hybrid options below are not retained)

**Facts (verified):**
- `wss://<relay-host>/relay-ws` works through the Infomaniak proxy (queue relay client, connections of 6+ hours).
- poc-node restarts on every push to main (all sockets dropped, clients must reconnect); no per-socket bandwidth cap; above 1 MiB buffered the relay SKIPS events (silent data loss for opaque frames: needs its own close-or-queue policy); no peer routing exists, it is new code in any option.
- `node-datachannel` has prebuilds for macOS arm64/x64, Windows x64/arm64, Linux x64/arm64 (WebRTC-style NAT traversal available in Node).
- The work laptop has no host firewall (user); network-level restrictions unknown; the NAT situation of the other machines is unknown.

**Options:**
- **A. Relay carries everything** (E2E encrypted frames switched by poc-node). Works anywhere outbound 443 works; no inbound port; simplest. All traffic on shared hosting, reconnect on each deploy, poor for big transfers.
- **B. Direct P2P**, relay only for signalling (WebRTC data channels via node-datachannel). Best latency/throughput. NAT traversal can fail, so a relay fallback is still needed (two transports).
- **C. Relay first (A), direct later (B)** behind a transport-independent protocol. Value now, direct is an optimization; direct not delivered in v1.

**Security:** A has no inbound surface (T-08 limited); B adds inbound sockets and needs the same mutual-auth handshake on each direct link.
**Recommendation:** C.
**Fact needed from the user (optional, sharpens B):** do the machines sit behind the same home router, and where does the laptop normally connect from?
**Unblocks:** relay design in poc-node (D-D).

## D-D. Relay/registry architecture in poc-node (DECIDED 2026-11-14, decision 33: authentication + REST resource `machines`, registry only; approaches A, B and D below that forward traffic are not retained)

**Context:** the relay is the only component the internet can reach, and it carries every machine's traffic. A new route `/machine-ws` was first proposed as if decided; it is only one of five approaches. Interacts with D-C (topology): if direct P2P is chosen, the relay shrinks to signalling.

**Facts (poc-node, verified or from poc-owner; update 2026-11-13: a separate budget per route is feasible because the counters and limits are local to `createRelayWs()` [V]; a second process or port on this hosting is UNKNOWN, never tried; process memory, CPU and event loop stay shared):** one PM2 process on shared hosting; WebSocket works on the live host; every push to main restarts the process and drops all sockets; 500 total connections shared with webhook listeners (20 per IP, 200 unauthenticated); 64 KiB frame cap; no bandwidth cap; backpressure above 1 MiB SKIPS events; token model has "no roles" (any token reads every key of the key-value store and every event); event history persisted 180 days / 50 MB; no peer-to-peer routing exists; KV writes limited to 300/min/token. Whether a second PM2 process or port is possible on this hosting: unknown, to ask poc-owner.

**Options:**
- **A. New switchboard WebSocket route (`/machine-ws`) in poc-node.** Each daemon keeps one outbound wss, authenticates by a signed challenge against its registered public key, and the relay forwards opaque encrypted frames to the target peer; presence in memory. Pros: real time both ways, streaming (logs, waits), presence for free, WebSocket proven on this host, smallest client. Cons: shares one process and the connection budget with the webhook relay (a flood or bug here hurts webhooks, and the reverse); every deploy drops all machine sockets (reconnect/resume protocol mandatory); needs its own backpressure policy (close or queue, never skip); a new pre-authentication surface next to webhook signing secrets and the key-value store. Security: relay sees metadata only (E2E); blast radius is the shared process (T-02, T-08); mitigated by strict pre-auth limits and by keeping the module separable.
- **B. Reuse the existing event relay (`/relay-ws`), machine messages as events.** Pros: no new route; reuses auth, limiters, audit. Cons: every token holder receives every event (ciphertext plus metadata); events are persisted 180 days on disk; fan-out is not point-to-point; the `replay` feature would re-deliver old sealed commands (replay hazard, T-04); silent skip on backpressure. Security: worst fit for Spoofing and Elevation of Privilege.
- **C. HTTP mailbox (store-and-forward, long-poll).** Machines POST sealed messages to a recipient inbox and long-poll their own. Pros: survives restarts, offline peers still get messages, plain HTTP, easy rate limiting, no live sockets to hold. Cons: latency, streaming is awkward (logs, `wait`), persistence needed (file or MariaDB, 300 writes/min/token), queued commands for offline machines are a staleness risk (mandatory short expiry and nonce). Security: replay and stale-command hazard (T-04), mailbox metadata at rest.
- **D. Signalling and registry only; data goes direct (WebRTC data channels).** The relay only introduces peers (small messages). Pros: minimal relay load and exposure, relay compromise = metadata and DoS only, best throughput. Cons: NAT traversal can fail, so a data-carrying fallback (A or C) is needed anyway; native module (`node-datachannel`, prebuilds exist for the 4 OS); peers learn each other's public IPs; most complex. Security: smallest relay surface, but direct links need the same mutual-auth handshake.
- **E. Do not build the network: adopt an existing WireGuard-based mesh VPN (Tailscale, Headscale, Nebula, ZeroTier) and run `machine` over private addresses.** Not evaluated in this repo; claims are general knowledge, unverified here. Pros: NAT traversal, device identity, ACLs and key rotation by mature software; `machine` shrinks to the application layer. Cons: contradicts the poc-node plan; a third-party coordination server (or self-hosted one); software installed on 4 machines including the work laptop (corporate policy unknown); a new dependency. Security: mature crypto, but another trust anchor.

**Recommendation:** A for v1, as an isolated module (own limits, opaque frames, resume protocol), with D added later as an optimization (D-C option C). If the goal is only secure connectivity and not owning the stack, E is the cheapest and should be consciously rejected or accepted; ask poc-owner first whether a separate process for the module is possible.
**Unblocks:** open question #2, the T-02/T-08 mitigations.

## D-A2. How `machine` gives each CLI a remote wrapper (rewritten from the deep plugin analysis)

**Facts (details and sources in `evidence.md`):**
- No CLI lets an external package add commands or flags; all five command tables are closed. None has `--host` or `--machine`.
- What each CLI accepts from outside today:

| CLI | Backend access | External code allowed | Native remote notion |
|---|---|---|---|
| task | no daemon, files + HTTP server | none (R11: built-in plugins only, a new `transport` plugin must be added inside task) | `remote` strategy + `task serve` (one project, one writer) |
| queue | daemon, own SDK client | `RelayPlugin` by import path; `ActionPlugin` built-in only | none (out of scope) |
| flow | daemon, kit client (commands), WebSocket (workers) | worker-type plugins from an absolute plugins dir (production precedent: flow-sandbox) | relay worker type: daemon side shipped, "no relay process ships" |
| orch | daemon, kit client | none for the backend (app-core UI module, `hooks.json`) | none (out of scope: no remote/tunneling) |
| project | files only | none (app-core UI slots, config sections) | none |

- The shared daemon client (`singleton-daemon-kit`) is hard-wired to `127.0.0.1` with no transport injection; queue-sdk has its own client. Pointing a CLI at a fake local config dir is not viable (silent fallback to local execution, pid and config-dir checks).

**Options:**
- **A. External wrapper by argv, no change in any CLI.** `machine run <peer> -- <cli> <args>` (sugar like `machine task list --on laptop`). The peer's daemon spawns its local CLI under a per-peer allowlist (cli + subcommand) and streams output (`--json`). Pros: works for all five CLIs on day one; no owner has to change anything. Cons: explicit, not "indifferent local/remote"; coarse authorization (argv, not typed calls); spawn per call; PATH/env differences on the peer; CLI parsing of untrusted argv is attack surface. Security: allowlist and argv array only, never a shell string (T-03).
- **B. Native `--machine <peer>` in every CLI.** Needs one shared change in `singleton-daemon-kit` (transport/host injection, no local fallback when a target is set), plus per-CLI work: queue-sdk adopts it or gets its own seam; task adds a built-in `machine` transport (allowed by R11, a release of task); flow uses the same kit client; project and orch resolve through the kit. Achieves the stated goal (talk to local or remote indifferently, typed calls, per-command capabilities). Cons: changes in 5 repos by 5 owners, `machine-sdk` becomes a dependency of every CLI, orch's out-of-scope ("no tunneling") needs the orch owner's review, slowest.
- **C. Use each CLI's existing seam where one is designed, argv wrapper elsewhere.** task: loopback port forward into its existing `remote` strategy (no change). flow: a `machine` worker-type plugin in an absolute plugins dir, i.e. the declared-but-unshipped relay (remote machine runs steps; remote control of the flow daemon still goes through A). queue: a `RelayPlugin`-style Source / local pushes under `machine.<peer>.` for remote events. orch and project: A. Pros: uses designed seams, no repo change required to start. Cons: four heterogeneous integrations to maintain; none of them is the "indifferent" experience for orch and project; plugin dirs add trusted code in daemons (flow T-02).

**Security across options:** capabilities named `<cli>:<command>` per peer, deny by default; remote-originated calls never inherit local `health_token` rights (S15); orch `/api/exec`, secrets, import and job create/update are never forwarded (orch-owner).
**Recommendation:** A first (immediate, universal), then C for task, flow and queue where a typed seam exists; B only as the long-term goal if you want native `--machine` flags, because it needs cross-repo decisions that should not block v1.
**Unblocks:** open questions #3 (execution model) and #6.
**Status:** PARKED (phase 2, decision 12).

## D-A3. Remote task in a project on another machine: where does the remote part live (PARKED, phase 2)

**Question:** to update a task of a project that lives on another machine, does only `project` need the remote part?

**Facts (task `CLAUDE.md`, "Shared project registry"):**
- task resolves its project through the shared registry of the `project` CLI: `-p <ref>` (id, unique prefix of 4+ chars, name or alias, never a path), then `TASK_PROJECT`, then the cwd. An unresolved reference is an error, never a fallback. The flag is read by the project SDK, not by task-cli.
- task data and config live under `<registry>/projects/<id>/task/`. The registry is per machine, ids are independent per machine, a project has no machine field (project-owner).
- task already has the `remote` strategy (`task serve` on the machine that owns the data) with a `transport` plugin slot.
- project has no daemon and no task verbs.

**Analysis (hypothesis, not verified for queue and flow):** neither CLI alone is enough. project answers WHERE (which machine owns the project; a machine-qualified reference such as `laptop:shop` or a machine field on registry entries), task answers HOW (the `remote` strategy with a built-in `machine` transport), `machine` is the channel. Since task, and probably queue and flow, resolve projects through the project SDK, the SDK is the one place where a machine-qualified reference could be understood by all of them. To be confirmed with project-owner and task-owner when phase 2 starts.

## D-E. Execution model for remote commands (phase 1)

**Context:** the heart of phase 1. A peer asks another machine to run something. A compromised or mistaken peer must not get a shell on every machine.
**Facts:** orch-owner: `/api/exec` is an accepted risk only because any local process can already run commands; a remote peer breaks that premise. flow `run` executes arbitrary `script:` bodies. Deny by default and per-peer capabilities are decisions 6 and S5.

**Options:**
- **A. Named actions.** Actions are declared on the executing machine (`machine action add deploy -- <argv>`), and peers can only invoke them by name with typed parameters. Pro: smallest attack surface. Con: every command must be declared first.
- **B. Argv allowlist per peer.** Patterns on CLI and sub-command (`task *`, `queue push *`), argv array, never a shell string. Pro: flexible, fits the sibling CLIs. Con: pattern matching on arguments is error-prone (option injection such as `--config`).
- **C. Arbitrary command as a time-limited grant.** `exec` is off by default; a peer gets it for a bounded time (`machine grant laptop exec --for 1h`) after local approval. Pro: "run anything" when needed. Con: while granted, a compromised peer has a shell as the user.

**Security:** A narrows Elevation of Privilege best; C is the widest and needs approval, expiry and audit (S6, S7, S11).
**Recommendation:** B as the default, C only as a time-limited grant, A as sugar for repeated commands later.
**Unblocks:** open questions #3 and #5.

**User proposal (2026-11-13), awaiting confirmation of the conditions:** a default shell configured per machine, overridable by the caller: `machine run desktop --shell ps -- ls`. Claude's assessment: simplest UX and same trust level as SSH; it removes the program allowlist (a shell string cannot be filtered), so protection moves to per-peer authorization. Conditions proposed: (1) shells are NAMED entries declared on the target machine (`ps`, `cmd`, `bash`), the caller picks a name, never a path; (2) the shell capability is a per-peer grant, deny by default, documented as full control of the target; (3) audit log on the target (peer, shell, command, exit code) and local approval for the first use by a peer; (4) non-interactive only, with timeout and output cap. A restricted direct-execution tier (program allowlist) stays possible later for peers that should not get a shell.
See D-F for the protections around the shell right.
User detail (2026-11-13): the default shell on Windows is `cmd`. Consequence: `ls` in `cmd` only works if Git for Windows' `ls.exe` is on the daemon's PATH; otherwise the caller uses `--shell ps`. Proposed (Derived, to confirm): on macOS and Linux the default is the user's login shell (`$SHELL`), and the daemon refuses to start with an explicit error if the configured default shell does not exist.

## D-F. Protections around the shell right (phase 1)

**Context:** a shell string cannot be reliably filtered, so the right to run it is equivalent to full control of the target as the user. Protection must come from layers around the right, not from a command list. The layers stack; the question is which ones phase 1 includes.
**Threats (STRIDE):** stolen or copied private key (Spoofing); compromised enrolled peer (Elevation of Privilege); silent abuse (Repudiation); replay or redirection of a signed request (Tampering).

**Baseline (Derived, no choice needed):** every request signed by the caller, bound to the target UUID, with nonce and expiry; private key in a 0600 file (OS key store as a later upgrade); environment scrubbed (no inherited secrets), timeout and output cap, non-interactive; hash-chained audit log on the target; `machine lockdown` and `machine revoke`.

**Layers:**
- **L1. Rights by tier, per peer.** `run-direct` (program allowlist, no shell) and `run-shell` (full shell), deny by default. Gain: a peer that only needs `ipconfig` never gets a shell. Cost: low. Rejected alternative: "refuse operators and filter the string" (cmd.exe and PowerShell quoting rules are quirky; Windows `.bat`/`.cmd` spawning had known injection bugs, general knowledge to verify).
- **L2. Time-boxed shell grants.** `machine grant laptop shell --for 8h`; the right expires on its own and renewal needs approval on the target or on another enrolled machine. Gain: a stolen key is useless after expiry. Cost: re-approval friction.
- **L3. Approval channel.** First use by a peer, or every request, confirmed on the target or on a third enrolled machine. Gain: stops silent abuse. Cost: high friction if per request.
- **L4. Restricted execution context.** Commands run under a limited account or sandbox (dedicated user, restricted token, bwrap or similar), with a `full` profile for the user's own account. Gain: bounds the damage. Cost: per-OS engineering; conflicts with "ls anywhere". A sandbox for flow steps already exists in the workspace (`flow-sandbox`), reusability not checked.
- **L5. Detection and reaction.** Alerts on first use, off-hours use, failure bursts (as `machine.security.*` events pushed to queue), automatic lockdown on anomalies. Gain: shortens the abuse window. Cost: low.

**Residual risk:** with a valid grant active, a stolen key means full control until expiry or lockdown.
**Recommendation:** baseline + L1 + L2 + L5 + L3 at first use only in phase 1; L4 deferred to phase 2.
**Open parameter:** default duration of a shell grant (suggested 8h).
**Unblocks:** open questions #3 and #5, threats T-03, T-06, T-07.

## D-G. Guaranteeing that only the human administers the policy

**Context:** decision 16 (user): allow/block of commands, grants and limits are done by the human only, never by agents or attackers. The policy is edited on the machine itself or through the web UI of the `machine` app-module.
**Facts:** [V] daemon tokens (`~/.config/{queue,orchestrator,flow}/health_token`) are readable by an agent session running as the same user. [V] app-core is "bound to 127.0.0.1, for trusted local users only" (README), no authentication. So neither the local CLI nor the app-core web UI proves that a human is acting.
**Principle:** do not trust a channel, trust a signature. The policy is a signed document; the daemon applies a change only if it carries a valid signature from the admin credential. The channel (CLI, web UI, another machine) then does not matter. Unknown commands are denied with an actionable error and recorded as pending requests (rate-limited) that the human can allow once, for N calls, for a duration, or always, per peer or for all.

**Options (how the admin credential is protected):**
- **A. Passphrase-protected admin key.** Encrypted key file (scrypt or argon2), the human types the passphrase to sign. Pro: no hardware, same on all machines. Con: the encrypted file is readable by agents (offline guessing of a weak passphrase); the passphrase can be captured if typed in an observed terminal.
- **B. Hardware or platform authenticator (WebAuthn/FIDO2).** Windows Hello, Touch ID or a USB security key; signing needs a touch or biometric; the key is not exportable. Pro: strongest, an agent cannot sign; works in the app-module UI (localhost is a secure context, to verify). Con: the Linux box has no platform authenticator (needs a USB key); server-side verification library and one registration per machine.
- **C. OS elevation.** Policy file owned by an administrator, writable only through UAC, sudo or the macOS auth dialog; the daemon trusts file ownership. Pro: no crypto to build; same-user agents cannot answer the prompt. Con: three OS mechanisms; cannot sign from another machine; the web UI needs an elevation helper; weaker if the account auto-elevates.

**Security:** A leaves offline guessing (T-11); B closes T-11 best; C depends on OS configuration. Residual (T-12): counters and expiries bind remote peers, not a local same-user process, which already has the user's rights.
**Recommendation:** B, with A as fallback on machines without an authenticator (the Linux box).
**Interpretation of the user's "master agent" idea (to correct if wrong):** the human signs grants with limits (calls, duration); an agent may consume them but never create or widen them. Delegation (an agent minting sub-grants inside a human-signed envelope) would be a separate feature, parked.
**Unblocks:** open question #8, threat T-11, decision 16.
**DECIDED 2026-11-13: option A (decision 18).**

## D-H. Which web origin hosts the admin page

**Context:** decision 18: the passphrase is typed in a web page, which unlocks the admin key for a bounded time. All app-core modules (queue, task, orch, flow, project dashboards) run in ONE browser origin with full DOM access ([V] `module-authoring.md:642`; app-core threat T-04), so any of them could read the passphrase or the unlocked key if the page lives there (T-13). The unlocked key stays in the page's memory only; the daemon only verifies signatures.

**Options:**
- **A. Separate origin served by the machine daemon.** Its own loopback port, therefore its own origin. The app-module in app-core shows pending requests and status read-only and links to the admin page. Pro: other modules cannot read it. Con: a second web surface to secure (CSRF, strict CSP), not integrated in the dashboard.
- **B. Inside the app-module (app-core origin).** Pro: one integrated UI. Con: admin security depends on every installed module being trusted.
- **C. Terminal prompt only** (`machine admin unlock`), no web page. Pro: no origin issue, simplest. Con: loses the web UX the user wants; a terminal can be observed by agents sharing the session.

- **D. (added 2026-11-14 at the user's suggestion) Hosted by the relay's own web interface (poc-node on Infomaniak), the app-module being a bonus.** Pro: reachable from any browser, even with no machine at hand; fits "no master machine". Con: the page code is served by the party the spec treats as hostile (A-1); a compromised relay, host operator or poisoned deploy serves a page that captures the passphrase and signs anything, which makes the relay part of the root of trust (AR-7) and voids decision 5 for the admin path. No web mechanism protects a page against its own server (SRI and CSP are delivered by that same server).

**Security:** B leaves T-13 open; A closes it and adds one surface; C trades UX for simplicity; D turns the relay into a trusted party for the admin key.
**Recommendation:** A.
**Unblocks:** open question #9, threat T-13.
**DECIDED 2026-11-13: option B, risk accepted by the user (decision 19).**
**AMENDED 2026-11-14 (decision 41): option D rejected. Signing stays on a local machine (app-module or CLI); the relay web interface only displays candidacies and presence, read-only.**

## D-I. Admin key lifecycle and registration (requested by project-owner, follows decision 21)

**Context:** decision 21 (reported, to confirm): only registered machines are trusted and every registration is signed with the admin key. Project does not hold or check any key; everything below is machine's to specify.
**Open points (nothing assumed):**
1. **Where the admin private key lives.** One encrypted file copied to every machine (sign from any machine's browser, more copies to protect) or held on one or two designated admin machines (fewer copies, signing only there). Decision 18 only fixed that it is passphrase-protected and unlocked in the browser.
2. **Creation and rotation.** How the first admin key is created; how it is rotated (versioned admin keys, re-signing registrations); what happens if the admin key is compromised or its passphrase is lost (T-24).
3. **Verification at registration.** Proposed record: machine UUID, name, identity public key, serial, validity, signed by the admin key; each machine pins the admin public key when the human installs it; the relay only carries records, which peers verify end to end.
4. **Revoked machine.** Admin-signed, versioned revocation list; peers drop its sessions; offline peers catch up on reconnect; a revoked machine cannot reconnect; registrations may also expire.
5. **First machine.** How the first machine learns the admin public key (a human act on that machine).
6. **Origin of a forwarded action (phase 2).** Must name the remote machine (UUID and name); project's `Origin` record has no machine field [V], so this needs a decision in project.
**Interplay:** with admin-signed registrations the identity key is certified by the admin key, which removes the per-pair enrollment ceremonies of D-B and changes its recommendation.
**Unblocks:** open questions #4 and #10, threats T-05, T-06, T-24.

## D-B (addendum 2026-11-13). Comparison B vs C, and the remaining choice

With decision 21 (registrations signed by the admin key) the per-machine identity certified by the admin key is the base (option A). C is a layer on top of A (a per-pair secret mixed into the handshake); B is per-pair key pairs. Comparison:
- Whole-machine theft: all variants equal (the thief holds every secret of that machine); the exact allowlists bound the damage; revoke the machine.
- Leak of the identity key alone: A fails; A+C holds (needs the pair secret); B has no global identity.
- Leak of one pair secret: B limits to that pair; A+C holds (needs the identity key); B+C needs both.
- Admin key compromise (the root of trust; AR-7: encrypted key file readable by same-user processes, weak passphrase guessable offline): every variant fails if the pair secrets are distributed by the admin console; it holds only if the pair secret is established by a human ceremony between the two machines.
- Revocation: A all-or-nothing; B and C per pair. Relay correlation: same in all variants (each machine keeps one outbound connection; inference). Cost for 4 machines: A 4 signatures; B 6 pair signatures; +C 6 secrets.
- General knowledge, unverified here: a Noise pre-shared key also hedges against future quantum recording attacks while it stays secret.
**Remaining choice:** how the per-pair secret is established: (1) distributed by the admin console, (2) human ceremony between the two machines, (3) B+C. Recommendation: (2).

## D-B (detail 2026-11-14). The per-pair secret: what it is, three ways to establish it

**Three secrets, three jobs.** (1) Admin key: signs registrations, revocations and policy; passphrase-protected (decision 18). (2) Machine identity: a key pair per machine plus its admin-signed registration {UUID, name, identity public key, serial, validity}; proves "I am a registered machine". (3) Pair secret (PSK): 32 random bytes known only to the two machines of a pair, mixed into the handshake; proves "this pair was set up on purpose".
**To connect, all of this must hold (proposal):** a Noise handshake with a psk modifier (for example XXpsk3 or IKpsk2, as in the Noise specification and WireGuard; general knowledge, not verified in this repo); each side sends its registration in the handshake payload; the receiver checks the admin signature, that the static key of the handshake equals the key in the registration, that the serial is not revoked, and that the PSK matches (otherwise the handshake does not decrypt). Noise static keys are X25519 while signatures are Ed25519: two keys per machine, or one seed deriving both.
**How the PSK is established:**
1. **Admin console.** The unlocked admin page generates a PSK per pair, seals it to each machine's identity key, signs the pair record, and sends it through the relay (which sees ciphertext). Zero human step beyond the admin signature. With the admin key, an attacker can register a rogue machine and hand it PSKs that peers accept: no protection against admin-key compromise.
2. **Human ceremony (pairing code).** On machine A: `machine pair start` shows a one-time code (valid about 2 minutes). On machine B: `machine pair join <A> --code ...`. Both run a PAKE (for example SPAKE2 or CPace) over the relay with the code as the weak secret and verify each other's registrations; the result is a 32-byte PSK stored in `_secrets_`. A mismatch kills the session (one online guess per session); the relay cannot brute-force the code offline from the transcript. Pairing grants NO command rights; those stay in the signed policy. Requires someone at B (a terminal over SSH is enough on a headless box). A PAKE must come from a vetted library: availability in Node is unverified (spike needed); fallback: the code used as the PSK of a one-shot Noise handshake with strict online-guess limits.
3. **Per-pair key pairs (B) plus a secret.** Each pair gets its own key pair signed by the admin, plus a PSK. 6 pair signatures for 4 machines; roughly double the key management of option 2 for no added protection on the admin-compromise scenario.
**Scenario outcomes (option 1 / option 2 / option 3):**
- Admin key stolen, attacker registers a rogue machine R: R joins everyone / R cannot pair without a human at the target / same as option 1 if the admin distributes the PSKs.
- Identity key of X leaked alone: not enough, PSK missing (all three).
- One PSK leaked alone: not enough, identity missing (1, 2); option 3 needs both pair secrets.
- Whole machine X stolen: the thief holds X's identity and PSKs in all options; revoke X.
- Hostile relay: sees metadata only; cannot join or read (all); in option 2 it can block a pairing (denial only).
**Operations (option 2):** add a machine: 1 admin signature + N-1 ceremonies (4 machines: 6 once; a fifth machine: 4); revoke a machine: signed revocation list; revoke ONE pair: delete the PSK on either side, no admin needed (proposal: restricting actions need no admin signature, widening ones always do); rotate a pair: repeat the ceremony.
**Phase 1 acceptance (two Windows machines):** one ceremony.
**Recommendation:** option 2, ceremony by typed code with a PAKE.

**DECIDED 2026-11-14 (decision 22): D-B option 1 (pair secrets distributed by the admin console), chosen by the user for simplicity. Consequence recorded as AR-7; the ceremony (option 2) remains a compatible later upgrade.**

## D-J. Relay access: token scopes (decisions 28-29, user requirement)

**Context:** the user wants machine to reach the relay the way queue does (poc-node Consumer tokens: first visit creates the first token; later tokens via an 8-digit pairing code, 5 minutes, single use), plus a scope on each token: `machine` and/or `queue`.
**Facts [V]:** a token is `{id, label, tokenHash, createdAt, createdBy, lastUsedAt}`, no scope or role field (`consumers.js:57`); all token holders are equal, any token can add, rename or revoke any token and read every key-value entry (`docs/THREAT_MODEL.md:21,57,65,68`); pairing TTL 5 minutes (`pairings.js:5`); queue has no pairing command, its token is placed by hand in its configuration (agent report).
**Proposal (to settle with poc-owner and poc-node's user):**
- Scopes: `queue` (may use `/relay-ws` webhook events), `machine` (may use the machine route), `admin` (control plane: tokens, pairings, webhook configs, key-value). Existing tokens are treated as full-access until rotated.
- Chosen at "Add token": the operator picks label and scopes; the claimed token carries them.
- Enforcement at the WebSocket authentication step and on each control-plane endpoint; a refusal says which scope is missing and counts toward the attempt limiter.
- A machine obtains its relay token with the pairing code: `machine relay claim <code>`; the token goes to `_secrets_/` (queue precedent: `QUEUE_RELAY_TOKEN` in `_secrets_/.env.local`).
- Trust stays the admin-signed registration; the relay token never authorizes anything between machines.
**Effect on D-I (new-machine registration):** a not-yet-registered machine can reach the machine route with a `machine`-scoped token obtained through the existing, rate-limited pairing flow, so the code-based registration (option B) needs no new unauthenticated relay endpoint, at the price of a second code (relay token) before the enrollment check.
**Cost:** reverses poc-node's "no roles by design" (R-1 accepted risk); needs a decision of poc-node's user, new code, a migration and a threat-model revision there.

**D-J update 2026-11-14 -- poc-owner feasibility answers [V where marked].**
- Enforcement points: global gate `onRequest` ([V] `server.js:284`) authenticates then lets everything through; no per-route check exists; `AUTH_BYPASS_PATHS` ([V] `server.js:281`) are outside the gate; `/relay-ws` authenticates in its first message ([V] `relay-ws.js:283`); the login session carries `{username, tokenId}` only ([V] `routes.js:164`). Every route behind the gate (tokens, pairings, webhook-configs, key-value, activity, history, replay) must still be listed before any claim of completeness.
- Migration: tokens have no scope field and the loader does not validate token fields, so "absent = full access" needs no migration; it must be written explicitly. A downgrade silently gives every token full access (not tested).
- Pairing: `pairings.create({label, createdBy, principalTokenId})` stores no scope; a scope field can be added and copied at claim; the "Add token" UI has no scope selector; pairings are in memory, so a restart drops them.
- Decision needed from poc-node's user (poc-owner will not decide it): (a) lift R-1 "no roles by design", (b) the list of scopes (machine, queue, admin?), (c) whether scopes also limit key-value and webhook-configs, (d) the rule for existing tokens. Claude's derived proposals are in decisions 29 and 30; the only part stated by the user here is the request for a `machine` and/or `queue` scope (decision 28).

**D-J update 2026-11-14 (user, decision 31):** no `admin` scope for now; a token with a scope has read, write and admin on that scope. Resolution (decision 32, Claude's proposal): "absent scope = full access" already provides the control-plane role, so no admin scope is needed; the first user's token and the console session stay full-access; webhook configs, event history and listeners are assigned to `queue`; presence and connections of the machine route to `machine`; key-value, tokens and pairings stay full-access only. Accepted consequence: AR-8 (a stolen scoped token has full rights inside its scope, never access to encrypted content).

**D-J update 2026-11-14 -- poc-owner's route inventory (behind the global gate; reading only, nothing run).**
- Tokens: `GET /api/consumers`, `GET /api/tokens`, `PATCH` and `DELETE /api/tokens/:id`, `GET /api/whoami`, `GET /api/audit-log`.
- Pairings: `POST` and `GET /api/pairings`, `DELETE /api/pairings/:id` (`POST /api/pairings/claim` is outside the gate).
- Webhooks: `/api/webhook-configs` (create, patch, list, delete, rotate-secret, secret) and `/api/webhook-history`.
- Listeners: `GET /api/listeners`, `PUT /api/listeners/:id/subscriptions`, `DELETE /api/listeners/:id`.
- Key-value: `GET /api/key-value` and `GET`, `PUT`, `DELETE /api/key-value/*` (own per-token limiter, 300 writes per minute).
- Pages: `/`, `/manage`, `/claim`.
- POC routes (`/poc`, `/chat`, `/api/file-write`, `/api/file-read`, `/api/upload`, `/api/env`, `/api/system-commands`): registered only when `ENABLE_POC_ROUTES=true` [V `server.js:362,389-392`], off by default; the production value is not verified. When on, they sit behind the same gate, so any token could write files and run commands there: they must stay off in production. poc-owner was asked to check the deploy path in the repo.
- Single anchor point: the principal built by the gate carries `{username, tokenId, label, via}` [V `http.js:9`]; a `scopes` field on it would be readable by every guard (`mutationGuard`, `principalGuard`, `requirePrincipal`, a `requireScope(...)` guard). The exact construction of the principal in the gate beyond line 314 of `server.js` is unread.
- Mapping proposed by decision 32: tokens, pairings, audit-log, key-value: unscoped (full-access) tokens and the console only; webhooks and listeners: `queue`; `whoami`: any authenticated token; machine-route presence and connections: `machine`.
- poc-owner, second answer: `ENABLE_POC_ROUTES` appears in 6 places of the repo only (`server.js:362,389,392`, `README.md:23`, `QUICKSTART.md:31`, `docs/THREAT_MODEL.md:51`), never in the workflow, deploy scripts, `docs/SSH_HOST.md` or `.env.example`: nothing in the repo enables it. A server-side variable (for example set in the Infomaniak panel) is invisible from the repo; the production value is UNKNOWN. A way to learn it: `GET /poc` with a token (a 404 means disabled); not done, it needs the user's agreement.
- poc-owner, technical point to settle with poc-node's user: "a scoped token has all rights in its scope" lets a `queue` token rewrite webhook signing secrets (`/api/webhook-configs/:id/secret`), the risk already recorded at `THREAT_MODEL.md:65`; it stays open for `queue`. The key-value store is used by other applications with their own tokens: they keep working as unscoped (full-access) tokens, and a later rotation to scoped tokens would need a scope for them.
