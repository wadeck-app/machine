# Detached jobs, `machine update`, `machine sleep`

**Status:** v0.1, 2026-11-22, SPEC ONLY, nothing built. Decision 89 (user decisions of 2026-11-22 recorded below), threat model T-53 to T-62 (all Planned). Phase 0 (spikes on real boxes) must pass before phase 2: several facts the design rests on are unverified (see "Open questions").
**Problem:** a command that restarts the daemon (`machine cli update`) or freezes the box (suspend) kills the answer channel of `machine run`; the caller gets a connection error whatever the outcome.
**Reads:** `threat-model.md` (hard rules 3, 4, 7, 8, 9), `typed-parameters.md` (policy v2 precedent), `hold-for-approval.md`, `install.md`, `run-log.md`.

## Decisions (user, 2026-11-22)

| # | Decision |
|---|---|
| D1 | Remote actions are TOP-LEVEL verbs with the machine as argument, like `run`, `ping`, `wake`: `machine update <machine>`, `machine sleep <machine>`. `machine cli ...` stays THIS installation only; no `peer`/`admin` group for them |
| D2 | Mechanism: DETACHED JOBS. `machine run <machine> --detach [--timeout <dur>] -- <cmd>` starts the command on the target detached from the daemon, answers at once `started: job <id>`, persists the job under the config dir |
| D3 | `machine job <machine> [<id>] [--wait] [--json]` lists or reads the jobs of THIS caller on that machine; `--wait` reconnects through daemon restarts and suspend and exits with the job's exit code |
| D4 | A detached run needs an entry of the SIGNED allow list carrying `detach` (hard rules 3, 4). No attribute, no detach |
| D5 | `update` and `sleep` are SUGAR over D2 to D4, with end-to-end verification |

Decided here (Claude, to confirm; each is cheap to reverse):

| # | Decision |
|---|---|
| C1 | `--cancel` is IN: `machine job <machine> <id> --cancel`. Small (the kill path of `runCommand` exists), restricting only (no signature, hard rule 4), own jobs only, audited |
| C2 | Quotas live in the signed policy body (`jobLimits`), duration lives on the entry (`detach.maxSeconds`) |
| C3 | The `detach` request field is inside the SIGNED request body (not beside it like `waitSeconds`): a detached start is a right, so it is bound to the caller signature, target and nonce |
| C4 | Job frames (`job-list`, `job-read`, `job-wait`, `job-cancel`) are NOT signed: authorization is "the machine authenticated on the channel is the job owner" (pattern of `request-notice`, T-41). They write nothing but a kill of the caller's own job |
| C5 | A revoked peer's running jobs are cancelled by the target (restricting). Removing an entry from the policy does NOT kill running jobs (the right was valid at start and is bounded by the deadline) |
| C6 | Local view on the target: `machine job --here [<id>] [--kill <id> | --purge]` (reads the job folder directly, all callers, no daemon needed). The local user already owns everything (A-3) |

## Behaviour

| Command | Effect |
|---|---|
| `machine run <m> --detach [--timeout <dur>] [--shell s] [--wait <dur>] -- <cmd>` | Same gates as `run` plus the detach right. Prints `started: job <id> (timeout 15m, on <m>)` and the next command `machine job <m> <id> --wait`. Exit 0 = started, 255 = refused or unreachable (as `run`). `--timeout` without `--detach` is refused. `--wait` keeps its meaning (wait for the owner to Allow), it is not the job wait |
| `machine job <m>` | Table of the caller's jobs on `<m>`: id, state, start, end, exit, command (cut to 60 chars). `--json` one document. Newest first, 50 |
| `machine job <m> <id>` | State, times, exit code, cause, last 448 KiB of each stream, `truncated` flags. Unique prefix of 6+ chars accepted among the caller's own jobs |
| `machine job <m> <id> --wait` | Waits for `ended`, `killed` or `interrupted`. Survives drops, restarts and suspend of the target: reconnect with backoff 1 s doubling to 10 s, bounded by the job deadline + 120 s. Exit: `ended` = the job's exit code; `killed` = 124; `interrupted` = 125; gave up or refused = 255 (cause on stderr) |
| `machine job <m> <id> --cancel` | Kills the job tree. State `killed`, cause `cancelled` |
| `machine job --here ...` | C6 |

- Job states: `running`, `ended` (the command exited by itself, any code), `killed` (cause `timeout` or `cancelled` or `revoked`), `interrupted` (the runner is gone with no exit record; cause `runner-gone` or `machine-rebooted`).
- Output is a TAIL: the job is never killed for output volume (a 5 minute `npm ci` must finish). Each stream keeps its last 1 MiB (existing cap, `DEFAULT_MAX_OUTPUT_BYTES`), the file is rewritten at 2x and `truncatedHead` is set. One read frame is bounded by the frame cap (`DEFAULT_MAX_FRAME_BYTES` 1 MiB), so a read returns the last 448 KiB of each stream; paging is Q8.
- Everything else of the run path is unchanged: scrubbed environment, cwd home, no stdin, shell launch spec of `launchSpec` (T-15), never elevated. Only the TIMEOUT differs (signed, up to 1 h, instead of 60 s) and the output is stored.

## Target side: how a job survives

| Piece | Rule |
|---|---|
| Job folder | `<configDir>/jobs/<id>/`, mode 0700, files 0600 (Windows: profile ACL, A-6) |
| Id | `j-` + 26 base32 characters from 16 random bytes (128 bits) |
| `spec.json` | Written by the daemon AFTER the audit line `accepted` and BEFORE the spawn, atomically (tmp + rename), never rewritten: id, request id, owner peer uuid and name, shell, command (as signed), template if typed, `timeoutSeconds`, `startedAt`, `outputBytes`, `bootId`, daemon version |
| Runner | A small internal process (hidden entry of the machine bundle, no public command, no frame reaches it). Reads ONLY `spec.json` of the folder given as argument (never a command on argv), refuses when the folder is not under `<configDir>/jobs`, not owned by the user, or already has a `state.json`. Starts the command with the existing launch spec and scrubbed env in its own process group (Unix `detached`; Windows detached process, hidden window), enforces the deadline, appends the tails, writes `state.json` (pid, token) and every 5 s a heartbeat, and at the end `exit.json` (exit code or signal, cause, `endedAt`) atomically |
| Detachment | The daemon starts the runner through a short-lived intermediate that exits at once, so the runner is not a descendant of the daemon (orch kills the TREE of the job on `restart-job` and `ensure --restart-if-changed`; Q2 is the proof to obtain). stdio ignored |
| Single writer per file | Daemon: `spec.json`, `interrupted.json`. Runner: `state.json`, `exit.json`, tails. Reader view: `exit.json` > `interrupted.json` > `state.json` = running |
| Daemon start | Scan `jobs/`: a folder with no `exit.json` and a live runner (pid alive and heartbeat fresh, one 30 s grace after a wall-clock jump, Q3) is re-attached (counted in quotas, its end audited); otherwise the daemon writes `interrupted.json` with the cause (`machine-rebooted` when `/proc/sys/kernel/random/boot_id` differs, else `runner-gone`). A folder without a valid `spec.json` older than 10 min is deleted; names that are not an id are ignored and `machine status` warns |
| Revocation | At each scan (10 s) the running jobs of a revoked peer are cancelled (C5), audited `job-cancelled revoked` |
| Quota counting | From the folder (survives restarts), never from memory |

## Rights (hard rules 3 and 4)

Policy format follows the v2 precedent (`typed-parameters.md`): version is written only when needed, an older reader refuses loudly.

| Piece | Rule |
|---|---|
| Entry | Optional `detach: { maxSeconds }`, `1 <= maxSeconds <= 3600`. Any other key is refused. Present only in a body `v: 3` |
| Body | Optional `jobLimits: { perPeer, perMachine, retentionDays, retentionJobs, outputBytes, totalBytes }`. Built-in defaults when absent: 2, 4, 7, 200, 1 MiB, 256 MiB. Code ceilings (refused at signing and at load above): 8, 16, 30, 1000, 1 MiB, 1 GiB |
| Version | `nextPolicyBody` writes `v: 3` only when an entry has `detach` or `jobLimits` exists; v1 and v2 policies stay as they are and keep working on older targets. `POLICY_MAX_VERSION` becomes 3 |
| Old target | `policy: unsupported version 3 (this build reads versions 1 to 2): run machine cli update on this machine` (existing text). The admin side prints an `[info]` naming the update BEFORE the passphrase, as for v2 |
| Old target, request | The request body gains `detach: { timeoutSeconds }` only when detaching (10 keys instead of 9; 11 together with an `ask`, decision 96: both are optional keys of the signed body). `verifyRequest` of an older target refuses the shape as malformed: nothing runs. The caller says `<m> is too old for detached jobs: run machine cli update ON that machine once (machine update cannot do it: it needs this feature)` |
| Authorization | A detached request is allowed only by the FIRST entry that matches the command (exact or typed, as today) AND carries `detach`. A plain run is still allowed by any matching entry, with or without `detach`. `timeoutSeconds` above `maxSeconds`: refused `detach-timeout-too-long`, naming the maximum (never silently capped). `--timeout` omitted: the maximum of the entry, said in the answer |
| Refusal | Matching entry without `detach`: `detach-not-allowed` with the exact line to sign (only when the same command would be allowed plain: reveals nothing new, T-03). No entry: the normal `not-listed` (held by default, the owner's Allow dialog preselects detach, below) |
| Limits | `maxCalls`, `--for`, `--until` count a start like a run |
| Quotas | `job-limit-peer`, `job-limit-machine`, `jobs-disk-full` (nothing running is ever evicted; ended jobs older than the retention or beyond `retentionJobs` are purged oldest first before a start); also at most 10 starts per minute per peer. Detached jobs do not use the 4 concurrent-run slots |

Front-ends:

| Where | Expression |
|---|---|
| `machine admin allow <m> [--shell s] --detach <dur> [--times n | --for d | --until t] -- <cmd>` | `<dur>` 1 s to 1 h (`30m`). Signing summary, read BEFORE the passphrase: `DETACHED: starts as a background job of up to 30 m, survives a restart of the daemon, its output is kept 7 days on <m>; every trusted peer of the default list can start it`. `--remove` and the other flags as for typed entries |
| `machine admin job-limits <m> [--per-peer n] [--per-machine n] [--retention d] [--keep n] [--output size] [--disk size] | --reset` | Signs a new body with `jobLimits`; shows the difference; ceilings enforced; `machine policy job-limits` in mode `local` |
| `machine policy allow --detach <dur> ...` | Mode `local`, same rules |
| `machine allowed <m>` | Shows `detach 30m` per entry and the limits |
| Allow dialog (Requests page) | New row "Run": `Attached (default)` or `Detached job`, with a max duration `5 min`, `15 min`, `30 min`, `1 h` (default 30 min). For a HELD request that asked for detach, `Detached` is preselected and the duration is the smallest preset that is not below the requested timeout. The confirmation repeats the summary above. The held-request listing carries optional `detach: { seconds }` (older admin machine: Q10) |

## Frames (direct peer channel, parsed only after the full handshake)

| Frame | Fields | Answer |
|---|---|---|
| `run` (existing) + `detach` in the signed body | as today | `started`: `{id, job, timeoutSeconds, deadline, daemon: {version, startedAt}}`, or `refused` with the reasons above, plus `cannot-start-job` (cause and fix) |
| `job-list` | `limit` (1 to 50) | the caller's jobs, bounded |
| `job-read` | `job`, `tail` (bytes, at most 448 KiB) | state, times, exit, cause, tails, `daemon` |
| `job-wait` | `job`, `since` (state seen), `waitSeconds` (at most 25) | answers when the state changes or the time ends (long poll); at most 2 waits per peer |
| `job-cancel` | `job` | `killed`, `already-ended` or `no-such-job` |

- Unknown id and another peer's id answer the same `no-such-job` (no oracle, T-57). Lists are filtered by owner BEFORE serialization.
- Every answer carries `daemon: {version, startedAt}` (the target's own report, used only to word messages and to verify an update; never to decide a right).
- 30 job frames per minute per peer, 1 KiB per frame, strict fields; refusals count toward the 20-refusal session cap. An older target answers `unknown-message`: `<m> is too old: machine cli update`.

## Audit, `machine log`, Activity

| Where | What |
|---|---|
| Target audit log | `accepted` gets `detached: true, job, timeoutSeconds` (before anything starts, no audit no start). New events: `job-ended` (job, state, exitCode, cause, durationMs, `at` = runner time; written by the daemon at the first moment it observes the end, so a job that ended while the daemon was down is audited at the next start), `job-cancelled` (who, why), `job-interrupted`, `job-purged` (count), `job-refused` (reason). Never the output, never the command text twice |
| Caller run log | The `run --detach` line gets `kind: "detached"`, the job id, outcome `started`. `job --wait` and `job <id>` append no second line in v1 (the run log is one write per line; the final state is read from the target, Q12) |
| `machine log` and Activity page | A `kind` field (`run`, `detached`). Detached rows show `started` or the final outcome (`ended 0`, `killed`, ...) and a link: `machine job <m> <id>` in the CLI, a read-only job drawer in the page (the daemon of this machine opens the channel as this machine, no passphrase). The received side matches `accepted` with `job-ended` by request id, like `completed` today |
| Requests page | Held and refused rows show `detached, up to 30 m`; Allow preset above |
| Not logged | Output, environment, passphrase (hard rule 8) |

## `machine update <machine>`

| Step | Behaviour |
|---|---|
| 0 | No machine, or the machine is THIS one: refused, exit 2: `machine update needs another machine: use machine cli update for this machine` |
| 1 | `machine run <m> -- machine cli version` (plain, allowed entry `machine cli version`): remote installed and latest as the target sees them. The `machine` binary is found through the daemon's PATH: `scrubEnv` KEEPS `PATH` (allow-list), so the measured success on the Linux box is explained; the PATH is the one the startup job gave the daemon. Exit 127 from the target: `machine is not on the PATH of the daemon on <m>` + fix. Output is parsed for CalVer; unparsable output is printed raw and the command fails loudly (Q5) |
| `--check` | Stops after step 1: `<m>: 2026.11.22-123, latest 2026.11.22-124 (update available)` or `up to date`. Exit 0 either way, 1 when the target cannot be read, `--json` supported |
| 2 | Already latest and no `--force`: `up to date (123)`, nothing started. Otherwise `machine run <m> --detach --timeout 15m -- machine cli update` (`--force` adds nothing to the command: it is a different entry, so `--force` is NOT supported in v1) |
| 3 | `job --wait` logic; the first drop of the channel is expected and said once (`daemon restarting`). Back-off reconnect bounded by `--back-timeout` (default 180 s) |
| 4 | Verify: `machine cli version` again AND `daemon.version` of a `job-read`: both must equal the new version. Success line: `[ok] <m>: 2026.11.22-123 -> 2026.11.22-124, daemon back after 9 s` (seconds from the first lost connection to the first good handshake, caller clock) |

Errors (each names cause and fix):

| Case | Message points |
|---|---|
| Entry missing | The refusal prints both lines: `machine admin allow <m> --shell sh --detach 15m -- machine cli update` and `machine admin allow <m> --shell sh -- machine cli version`. By default the request is held and the owner sees the preset |
| Job ended non-zero | Last 20 lines of its stderr, `machine job <m> <id>` for the rest, on the box `machine cli logs` |
| Daemon not back within N s | The job state, then: `machine ping <m>` (is the machine up), on the box `machine status`, `orch status`, `orch logs --job machine`, `machine daemon` in a terminal; `machine cli rollback` if the new version is the cause |
| Version unchanged | The job ended 0: print the updater's own last lines (from the job output) and `machine cli logs` on the target. The exact updater wording when nothing was installed is unverified (Q5) |
| Disk version new, daemon version old | `the daemon was not restarted: it does not run under the startup job on <m>; restart it by hand (machine stop, then machine daemon)`: `postUpdate` leaves a hand-started daemon alone |
| Target too old | Request refused as malformed: update ON the box once (see Rights) |

## `machine sleep <machine>`

| Step | Behaviour |
|---|---|
| 0 | No machine or THIS machine: refused, exit 2: `machine sleep needs another machine: this one suspends with systemctl suspend` |
| 1 | `machine run <m> --detach --timeout 1m -- /usr/local/bin/machine-suspend` (shell `sh`; the script is installed by `machine install suspend` ON the box, `install.md`; it detaches its own `systemctl suspend` after 3 s) |
| 2 | Verify by probe (reachability handshake, 4 s limit, nothing sent, no wake) every 2 s up to `--verify-timeout` (default 30 s): unreachable twice in a row = `[ok] <m> stopped answering after 6 s (suspended, or the network is down). Wake it with: machine wake <m>`. Unreachable is not proof of suspend and the line says so |
| Still reachable | `[warn] <m> still answers after 30 s: the suspend did not happen`; job output; on the box `sudo -n -l`, `machine install suspend --check` |
| Job exit 127 or script missing | `/usr/local/bin/machine-suspend is not installed on <m>: run machine install suspend ON that machine` |
| Entry missing | Refusal prints `machine admin allow <m> --shell sh --detach 1m -- /usr/local/bin/machine-suspend` (held by default) |
| After wake | `machine job <m>` shows the job `ended 0`: the record the plain `run` never had |

`install.md` fix to make with the code: its line "a scrubbed environment has no PATH" is wrong (`scrubEnv` keeps `PATH`); absolute paths are still right (the daemon's PATH is whatever the startup job gave it).

## Threat model and hard rules

Rows T-53 to T-62 are in `threat-model.md` (Planned). What the hard rules imply:

| Rule | Implication |
|---|---|
| 3 | A detach start is executed only for a signed entry carrying `detach`, same exact or typed match. No wildcard, no free command on the wire. The runner reads the spec the daemon wrote after `authorize`, never a command from a peer |
| 4 | `detach`, `maxSeconds` and `jobLimits` are signed policy fields; widening any of them needs the signature of the mode. Cancel and revocation kills only restrict. `v: 3` follows the v2 precedent |
| 7 | The runner and every job run as the user, never elevated, no new listener. The daemon exposes no quit or restart. Reading to confirm (Q1): `machine update` makes a trusted peer able to cause a daemon restart by running an ADMIN-ALLOWED COMMAND, as a plain `run machine cli update` already can today; no frame restarts the daemon |
| 8 | Output now exists on disk (T-56). The audit log and the run log still carry none. No secret in spec, state or errors |
| 9 | Scrubbed env, no stdin, output bound and the process group kill are kept; the timeout ceiling rises from 60 s to the signed maximum (at most 1 h) for detached runs only |
| 1 | No new listener; job frames use the existing peer channel after the handshake |

Not in the threat model before: `T-28` said "nothing stored". It is no longer true for detached jobs: see T-56.

## `factory-test-owner` use case

A 5 minute `npm ci` plus tests on the build box.

| Step | Command |
|---|---|
| Sign once (owner, on the box or admin) | `machine admin allow factory-box --shell sh --detach 15m -- cd ~/repo && npm ci && npm test` |
| Start (agent) | `machine run factory-box --detach --timeout 12m -- cd ~/repo && npm ci && npm test` prints `started: job j-7k2...` |
| Wait (agent) | `machine job factory-box j-7k2 --wait --json`, exit code = the test run's; or poll `machine job factory-box j-7k2` and read the tail |
| Daemon restarted meanwhile | Nothing lost: the runner outlives it, the wait reconnects |

The cwd of a run is the home directory, hence the `cd` inside the one signed string (T-15: the exact string is the right).

## Out of scope

- Streaming output (`--follow`): the read is a tail; Q8 covers paging only.
- Stdin, interactive jobs, scheduling, retries, chaining, notifications on job end (Activity shows them).
- Jobs longer than 1 h, elevated jobs, `bash`/`sh` on Windows (unchanged).
- Reading or cancelling ANOTHER peer's job from a remote machine (the admin uses `--here` on the target).
- Resuming a job after a reboot (it is `interrupted`).
- `machine update --force`, updating to a chosen version, updating or suspending several machines in one command.
- Windows targets for `machine sleep`.

## Phases (TDD, P-7: each test is written first and seen failing)

| Phase | Scope | Tests (adversarial ones in bold) |
|---|---|---|
| 0 Spikes (needs the user's go; no load, no repeated runs) | On the Linux box and a Windows machine: does a double-started process survive `orch restart-job`, `orch ensure --restart-if-changed` and `POST /quit`; PATH and `machine cli version` output; DETACHED_PROCESS and job objects on Windows; heartbeat across a suspend. Results go into this file | Notes only, no code shipped |
| 1 Core (`machine-core`, pure) | `jobs.ts`: id, spec and state validation, reducer (exit > interrupted > running), quota and retention planner, tail ring; policy v3 (entry `detach`, `jobLimits`, ceilings), `authorize` with `detach`, request body with `detach`, signing summary | Table tests; v2 reader refuses v3; exact-only policy stays v1; **plain entry + detach refused; second entry with detach wins only for detach; timeout above max refused; `detach` in a v1 or v2 body refused; unknown key refused; ceilings at boundary +1; hostile spec (huge sizes, traversal ids, non-ASCII) refused** |
| 2 Exec | `machine-exec`: runner, intermediate, injected fs and clock; kill tree, deadline, heartbeat, atomic files | Real child processes on Windows and Linux (short): survives the parent's exit, exit code written, kill by deadline and by cancel, **runner refuses a folder outside `jobs/`, a second start, a foreign owner; stdout flood does not kill the job and the file stays within 2x the cap** |
| 3 Daemon | `peerService` detach start, four frames, audit, scan at start, quotas, revocation kill, retention and purge | Fake runner: gates in order (no audit no start); quotas; **another peer's id equals unknown id; list never contains foreign jobs; frame flood and the refusal cap; job-wait limits; replay of a detach request; revoked peer mid-job; spec corrupted on disk; folder with a symlink or junction inside; crash between audit and spawn**; E2E with two real in-process daemons and a real runner: restart the daemon service, the job survives and `--wait` reconnects |
| 4 CLI | `run --detach`, `job`, `--here`, `admin allow --detach`, `admin job-limits`, help, run log, `machine log` | Output contract tests (exit codes, `--json` one document, stderr/stdout), refusal texts name cause and fix, help drift test |
| 5 Module | Activity kind and drawer, Requests preset, `GET /jobs` routes (daemon command, no key) | Component tests, route tests (foreign job, bad id, 404), the preset signs `detach` only when chosen |
| 6 Verbs | `update`, `sleep`, `--check`, messages | Fake peer scripted for every error row above; version-unchanged and daemon-old cases; **`update` without machine or on this machine refused with the exact text** |
| 7 Real boxes (user's go) | `test:relay` additions and a manual run on the Linux box: `machine update`, `machine sleep`, `machine wake`; the factory case | Transcripts into this file; threat-model rows move to Implemented only with evidence |

## Open questions (not settled by the code)

| # | Question | Recommendation |
|---|---|---|
| Q1 | Does hard rule 7 ("never exposes quit or restart over the network") forbid a remote-triggered restart through an allowed command (`machine update`)? | No: no frame restarts the daemon, and a plain `run machine cli update` can already. Write the reading in rule 7. Per-peer list for the entry on sensitive machines |
| Q2 | Does orch (Linux tree kill, Windows `taskkill /T`, job objects) or a service cgroup kill a process started through an exiting intermediate when the daemon is restarted? Not readable from this repo | Phase 0 spike on the real boxes before any code. If it dies, Unix `setsid` plus `systemd-run --user --scope` when available, and say so loudly on the box where it is not |
| Q3 | Runner liveness across a suspend: heartbeat stops while the box sleeps, so a daemon could mark a live job `interrupted` | Pid alive plus fresh heartbeat; after a wall-clock jump larger than 30 s allow one grace period; never mark `interrupted` while the pid is alive and the heartbeat is younger than 3 beats after resume. Verify in phase 0 |
| Q4 | How to start the runner: `process.execPath` plus the bundle of the daemon, or the staged launcher (decision 38c)? An update replaces the bundle while the update job still runs from it; the staged-copy prune must not delete a copy a live runner uses | Run the runner from the SAME staged versioned folder as the daemon; prune skips a folder referenced by a running job; verify on Windows (locked exe) in phase 0 |
| Q5 | Exact output of `machine cli version` (installed and latest) and of the updater when nothing is newer, and whether `--json` exists there | Read the shared-cli code in phase 0; parse CalVer with a strict regex and fail loudly with the raw output rather than guess |
| Q6 | Signed `detach` in the request body (10 keys, older targets refuse as malformed) versus a field beside it (older targets would silently run it ATTACHED: unsafe for update) | Keep C3, the signed body: fail closed on old targets |
| Q7 | Should an entry be able to say `detach: only` (never attached, so a 5 minute job cannot be run with the 60 s cap)? | Not in v1; a plain run of it simply times out at 60 s |
| Q8 | Paging for output above 448 KiB per read | Not in v1: `--tail <bytes>` only; `--here` reads the files |
| Q9 | Quotas in the body versus per entry | Body (C2): one list of ceilings per machine, small signing surface |
| Q10 | Does an older admin machine refuse a `requests-list` answer or notice with the extra `detach` field? (strict shape on the client) | Check `requestsList` parsing in phase 5; if strict, gate the field behind a protocol hint, never drop it silently |
| Q11 | Exit codes of `job --wait`: 124 and 125 collide with remote codes of `timeout(1)` and shells | Accept (documented); `--json` carries the state, which is unambiguous |
| Q12 | Should the caller's run log get a second line when the end is observed? | No in v1 (one write per line, append-only); Activity reads the state live from the target when it can, else shows `started` |
| Q13 | Default job timeout when `--timeout` is omitted | The signed maximum of the entry (no hidden constant); said in the `started` line |
| Q14 | `machine job --here --purge` needs no daemon: may it delete jobs of running state? | Only ended ones; running ones need `--kill` first |
