# Plan: machine network, phase 1

**Spec:** .claude/specs/2026-11-13_machine-network/ (v0.4, decisions 1-40, threat model v3.0)

Goal (acceptance): `machine` runs on the Win10 desktop and the Win11 work laptop; from either, `machine run <peer> -- ls` and `-- ipconfig` execute on the other and return the output, under an admin-signed strict allowlist.

Rules for every work package: TDD (principle P-7), no silent fallback (P-2), an `Open` threat must not ship inside a feature that depends on it (threat model rule 10), the spec is updated in the same step as the code or decision it concerns.

## 1. Architecture in one table

| Piece | Role | Decisions |
|---|---|---|
| `machine-core` (library) | Keys, registration records, signatures, revocation, policy compare-and-set, verification codes, allowlist matching, Noise handshake, request signing. No I/O | 22-27, 35a, 36 |
| `machine-cli` + daemon | CLI, loopback API (singleton-daemon-kit), peer listener (separate server and port), relay client, exec, audit log | 2, 33, 34, T-34 |
| `app-module-machine` + `dsl-lib-machine` | Admin pages (DSL views) and the passphrase and signing component | 19, 36, 40 |
| Relay (poc-node) | Authentication, scoped tokens, REST resource `machines`, candidacy route. Never carries commands | 28-33, 37 |
| orch | Starts `machine start` at login (`startup` job) and relaunches it after an update | 3, 38, 38b |

## 2. Work packages

Order is the build order. Each package ends with its tests green and the spec updated.

| WP | Content | Tests first (examples) | Depends on |
|---|---|---|---|
| WP0 | Monorepo scaffold: `machine-core`, `machine-cli`, `app-module-machine`, `dsl-lib-machine`; lint, vitest, ASCII rule; empty publish workflow copied from task or project; dependency rule (user, via orch-owner, verified in orchestrator `352dfb6`): every `@wadeck-app/*` dependency outside the workspace is `latest` (platform optionalDependencies too; the publish step rewrites them to exact pins), workspace packages are `*`, `package.json` and `package-lock.json` committed together, `npm ci --dry-run` checked | build and test pass on 3 OS | none |
| WP1 | `machine-core` crypto: identity keys, admin key (passphrase KDF), registration record sign and verify, serial and validity, revocation set (union), policy record with base version (compare-and-set), SAS codes (35a) | Known-answer vectors; tampered record rejected; stale base refused; swapped key changes the code | WP0 |
| WP2 | Strict allowlist: exact (shell, command line) match, per-peer replaces default, limits (calls, expiry); `cmd`, `ps`, `bash` launch conformance | Byte-for-byte match; no normalization; non-ASCII refused; T-15 conformance on real Windows `cmd` and PowerShell | WP1 |
| WP3 | Daemon and local CLI: kit daemon, config dir, UUID, name, aliases, reference resolution (decision 11), `init`, `status`, `list`, `--json`, exit codes | Reference ambiguity errors list candidates; no secret in output | WP1 |
| WP4 | Admin sign path in CLI (decision 36): prompt-only passphrase (never flag, argument or env), signs one policy change, exits; same core as the browser | Library test with generated key; CLI refuses a passphrase from argv or env | WP1, WP2 |
| WP5 | Peer channel: listener with pre-authentication limits (T-34), Noise handshake with pair secret, signed requests (nonce, expiry, target UUID), exec with scrubbed env, timeout, output cap, hash-chained audit log | Replay refused (T-04, T-29); unauthenticated peer gets no reply; flood test bounded in memory (no load test without the user's approval); audit chain detects edit | WP1, WP2, WP3 |
| WP6 | Relay client: pairing claim, token storage, `machines` client, signed address records (T-33), candidacy post and poll, cached registrations | Against a fake relay; relay lies about an address, connection fails with an explicit error | WP1, WP3, relay WP-R1 to WP-R3 |
| WP7 | Enrollment end to end: `machine join` (code shown in CLI), candidacy list and approval, signed registration returned, final code compared before pinning the admin key | Swapped key or swapped admin key detected | WP4, WP6 | Acceptance: no key, nonce or file copied by hand; only the 8-digit code typed and two short codes compared; works headless over SSH. |
| WP8 | `app-module-machine`: DSL views for the 5 pages (decision 40), `dsl-lib-machine` passphrase and signing component, backend routes calling the daemon, distinct errors for "daemon down" and "token refused" | Component tests (RTL), route tests, real-server integration test; CSP: no inline code | WP4, WP7, `dsl-owner` and `app-core-owner` answers |
| WP9 | Distribution and update: exe-in-npm for `win32-x64`, `darwin-arm64`, `linux-x64`, staged executable outside `node_modules` (38c), `machine cli update`/`rollback`/`register`, daemon exits after update so orch relaunches it (38b), `publish.yml` with `verify-install` and `verify-update` | Packed smoke on the 3 OS; update while running on Windows (EBUSY check) | WP3 |
| WP10 | (startup enable, disable, status, daemon port file, `npm run bundle` implemented; real-orch check and acceptance pending) Orch startup job and acceptance on the two Windows machines; threat-model review by a fresh agent (`subprocess` skill) before release | Scenario `ls` and `ipconfig` both directions | all |

## 3. Work for other CLIs and their owners

Contact the owner sessions with `SendMessage` (facts and requests only, they decide and implement in their own repo; never ask a peer to do what the user declined). Phase 1 needs no change in task, queue, flow, project code.

| Owner | What is needed | Blocks |
|---|---|---|
| poc-owner (relay) | WP-R1 scopes on tokens (`machine`, `queue`; absent = full access, written explicitly; no escalation; scope in the gate, on `/relay-ws`, re-read per request) and pairing carrying scopes (decisions 28-32, T-31, T-32). WP-R2 REST resource `machines`: signed registration records, signed address records, presence (decision 33). WP-R3 candidacy route behind the `machine` token, pending list, approval result, caps and rate limits (decisions 35, 37), plus a read-only display of pending candidacies and presence in the relay's web interface (decision 41; no key, no signing, no approval there). WP-R4 revise the relay threat model (lifts "no roles by design" R-1), remove or guard leftover POC routes. Open: decisions in D-J (scope list, key-value, existing tokens) are for the relay's user | WP6, WP7 |
| orch-owner | No code change expected. Commit the corrected `CLAUDE.md` (their bypass expired). Confirm the job recipe `orch add startup machine --command "machine start" --timeout 0 --restart-on-exit` and the exit-then-relaunch update flow (38b); after our first build, check a job started from the staged executable | WP9, WP10 |
| app-core-owner | Confirm `crypto.subtle` works on the shell origin with the module loader, whether `$actions` payloads are logged anywhere beyond `server.ts`, and that a module can stay unregistered when the machine daemon is down | WP8 |
| dsl-owner | Confirm a password-type field in the DSL, or that a custom component with its own `<input type=password>` is the supported path; component lifecycle for secrets in memory | WP8 |
| singleton-daemon-kit and shared-updater owners (find the session; not in the current list) | Confirm the kit allows a second, non-loopback listener beside the loopback API without sharing its auth, and the updater accepts a daemon that exits itself after install | WP5, WP9 |
| project-owner, queue-owner, task-owner, flow-owner | Phase 2 only (wrappers D-A2, D-A3). Nothing now | none |

## 4. Gates and open items

| Item | Needed before | Owner of the decision |
|---|---|---|
| Name of the relay service (current names are legacy: `poc-node`, `infomaniak-test`; options asked, no answer yet) | Renaming only; spec prose keeps "the relay" | User |
| Relay scope decisions (D-J) | WP-R1 | User of the relay |
| Open threats T-04 (replay design), T-08, T-15 (conformance), T-34 (listener limits), T-24 (lockout recovery) | Release of WP5 and WP7 | This plan |
| Decision 21 (registered machines trusted) and 20 (layers) still marked provisional or reported | WP1 | User |
| Parameters: default unlock duration (suggested 8 h for shell grants), code length of verification codes, `autoUpdate` for the work laptop (AR-9) | WP4, WP7, WP9 | User |
| Reachability: can the work laptop open a TCP connection to the desktop (same network, VPN or opened port)? Decision 34 has no relay fallback | WP10 | User (fact) |
| T-23 / AR-9 mitigation (npm provenance or signature) | Enrolling the work laptop | User |

## 5. Verification

| Step | How |
|---|---|
| Each WP | Tests written first, then code; `npm test` green with `--bail` |
| Security | After WP5 and WP7: fresh-eyes threat-model review (`subprocess` skill) against `threat-model.md` v3.0 |
| Acceptance | WP10 scenario on the two real Windows machines, both directions |
| Spec | Each decision change updates `_index.md`, `threat-model.md`, `evidence.md` and the changelog in the same step |

## 6. Progress (2026-11-14)

| WP | State | Where |
|---|---|---|
| WP1 | Done | `packages/machine-core` (keys, registration, revocation, policy, codes, admin key file, machine references) |
| WP2 | Done on Windows; Unix block written, not run | `packages/machine-exec` (cmd, PowerShell; scrubbed env, timeout, output cap) |
| WP3 | Done, including real processes (bundle via esbuild, `src/process.test.ts`) | `packages/machine-cli` (identity under `_secrets_`, aliases, `init`, `status`, `list`, `resolve`, `alias`, `daemon`, exit codes 0/1/2/3, daemon port 47920); the bundled binary is verified in WP9 (esbuild is not a dependency yet) |
| WP5 | Done except wiring | `packages/machine-transport` + `machine-cli/src/peerService.ts` (signed requests, replay cache, policy, concurrency, audit chain, real-shell end to end on loopback); missing: loading the directory, policy and counters into the daemon (WP6/WP7), `machine run` client command |
| WP6 | Partially done (first slice) | `machine-cli/src/relayClient.ts` (claim, candidacy post/get, records, heartbeat, machines, admin calls), `relayStore.ts` (`_secrets_/relay.json`), `join.ts` + `machine join [<code>] [--relay] [--force]`, `fakeRelay.ts` (tests over a real local HTTP server). Missing: polling of the candidacy approval, publication of signed address records (T-33), heartbeat in the daemon, cached registrations; the candidacy is not re-posted without a new code (token already saved) | Update 2026-11-14: candidacy post carries the uuid (CandidacyState keeps it; `--resume` reposts when the saved one has none); `deviceLoginStart` and `deviceLoginPoll` (public routes, no Authorization header, scopes exactly ["machine"]). Fake relay only |
| WP7 | CLI done on both sides, blocked on the relay for real use | Candidate: `join.ts`, `approval.ts`, `relayStore.ts`, tests `enroll.test.ts`. Admin (decision 50, one human comparison, the FINAL code after signing): `adminApprove.ts` (`machine admin login`; `machine admin approve [<id>] [--days] [--reject]`: candidacy code shown as information and checked against any relay-sent code, plain "approve this machine?" on a TTY, passphrase, PUT, final code printed with the revoke advice), `adminRevoke.ts` (`machine admin revoke <machine>`: resolveMachineRef, y/N, passphrase, signed revocation installed LOCALLY only), tests `adminApprove.test.ts`. Blocking real use: the relay candidacy has no `uuid` yet (poc-owner). Missing: distribution of revocations and of the new machine to the OTHER peers (separate contract), admin page (WP8), device-login flow, candidate-side wording of the candidacy code, T-05 fresh-eyes review | Update 2026-11-14: `machine join [<relay-host-or-url> | <code>]` by device login (no default relay (named the first time, then stored), digits = pairing code, else relay), tests `deviceLogin.test.ts`; `admin approve` refusal of a candidacy without uuid now points to `join --resume`; `--auto-startup` reserved (refused). NOT tried on the real relay (device login and candidacy uuid not deployed) |
| WP6c | Address records (todo #15b), fake relay only | `machine-core/src/addressRecord.ts`; `machine-cli/src/{addressDiscovery,addressPublisher,peerAddresses,listPresence,adminForget}.ts`; daemon publishes through the inbox-loop timer (`--advertise`), `machine run` without `--address`, `machine list` shows relay addresses and presence, `admin forget-relay-record`. Open: never run against the real relay; a registered peer may publish loopback or metadata addresses (audit S-14, not filtered) |
| WP6b | Distribution (distribution.md), fake relay only | `machine-core/src/document.ts`, `machine-cli/src/{distribute,adminDistribute,inboxLoop}.ts`, inbox calls in `relayClient.ts`; `admin approve|revoke|sign-policy` PUT documents, `admin distribute`, daemon inbox loop. Missing: address record publication (T-33), so a real machine cannot own its inbox; not tried on the real relay |
| WP8 | Slice 1 done (read-only routes, Machines and Candidacies views), see admin-ui.md "Status of the work breakdown"; timeline, signing, other pages not started | `packages/app-module-machine` |
| WP4, WP9, WP10 | Not started | |

### Pair secrets sealed in the approval (T-36)

Done: `machine-core/src/seal.ts` (`sealTo`, `openSealed`), tests `seal.test.ts`; `approval.ts` (`sealBundle`, `pairSecretContext`, opening in `checkApproval`), `adminApprove.ts` seals, `join.ts` opens, field `sealedPairSecret` and `adminUuid`; test helpers `approvalDraft.ts`, `buildApproval` seals when the fake relay stores the approval. Spec: relay-api.md Approval, threat-model T-36. Not done: the relay-side web page does not display approvals; the manual file flow keeps the clear secret.

### Human-wait time limits (security, replay)

Done: every prompt limited (default 120 s, `--prompt-timeout` 1..3600), stored approval max age 15 min, approval bound to the candidacy by `random` (unsigned), device-code and candidacy waits capped, candidacy expiry rechecked by `admin approve`. Tests: `packages/machine-cli/src/humanTimeouts.test.ts`. Spec: relay-api.md, section Approval.
