# Hold a refused request for approval (`machine run --wait`)

**Status:** v0.3, 2026-11-21, decisions 80 and 81 (the wait is the default of `machine run`, see "Default and setting"; the web Deny is PIN-protected). Implemented: core (`hold.ts`, waiting list in `requests.ts`), peer service, daemon `deny`, CLI, app-module backend and Requests page (see Deviations). User request: a `run` that the target does not allow yet can wait N minutes so the owner validates in the UI while the agent keeps working, or be explicitly refused.
**Not a new right:** hold changes WHEN a refusal is answered, never WHAT is allowed. Hard rule 3 and 4 hold: the held command runs only if, after the wait, an entry signed under rule 4 matches it.

## Behaviour

| Caller | Target |
|---|---|
| `machine run <peer> -- <cmd>` (default since decision 81: waits 10 min), `--wait 10m` for another duration, `--no-wait` for the old fail-fast | no match: instead of `not-listed` at once, the request is HELD up to the wait and listed as "waiting" in `machine requests` and on the Requests page |
| nothing else to send; the connection stays open | an Allow (signed entry, any lifetime incl. `--times 1`) that matches the held command runs it at once and the caller gets the normal `result` |
| | an explicit Deny by the owner answers `refused: denied` at once, with the optional reason |
| | the deadline passes: `refused: not-listed` plus `waited 10m, nobody answered` |
| | caller disconnects: the hold is dropped and audited |

- The caller sees a progress line on stderr every 30 s: `waiting for <machine> to allow it (7 min left)`. `--json` keeps stdout clean.
- Exit codes: unchanged for result; refusal by Deny and by deadline are distinct, named causes in the message.

## Default and setting (decision 81)

Waiting is the default of `machine run`. Scripts that relied on the immediate refusal now wait up to 10 min: they pass `--no-wait` (documented in README.md and getting-started.md).

| Layer (highest first) | Where | Values |
|---|---|---|
| Flags of the command | `--no-wait` (= `--on-refusal fail`), `--wait <10s..60m>` (implies `--on-refusal wait`), `--on-refusal wait|fail` | `--no-wait` with `--wait` or with `--on-refusal wait`, and `--on-refusal fail` with `--wait`, are refused before anything is sent |
| Machine setting | `<configDir>/run-defaults.json` `{"v":1,"onRefusal":"wait"|"fail","waitSeconds":10..3600}`, edited by `machine run-defaults [--on-refusal ..] [--wait ..] [--reset]` | a damaged file stops `run` (even with `--no-wait`) and `run-defaults` with the path and `machine run-defaults --reset`; `machine status` shows a `[warn]` instead |
| Built-in | machine-core `DEFAULT_ON_REFUSAL`, `DEFAULT_WAIT_SECONDS` | wait 600 s |

- The two fields resolve independently: `--on-refusal wait` uses the duration of the setting, `--wait` alone wins over a setting that says `fail`.
- Pure resolver `resolveRunWait` (machine-core `runDefaults.ts`), table-tested.
- When the wait comes from the default or the setting (not typed), the caller prints once on stderr when the target has not answered after 2 s: `waiting up to 10m for <machine> to allow it (default; --no-wait to fail at once)` (`setting run-defaults` instead of `default` when the setting decided). A quick answer (an allowed command, an immediate refusal) prints nothing, so scripts keep a clean stderr; the wire has no "held" frame (an older caller would not understand one), so a slow allowed command also prints it.
- Older target (ignores the hold): it refuses at once; the caller keeps the warning `<peer> did not hold the request ...`, now naming whether the wait was typed, a default or the setting, and how to stop asking (`--no-wait`, `machine run-defaults --on-refusal fail`).
- Hold limits (`hold-limit-peer`, `hold-limit-machine`) now meet default runs: the caller's message adds to wait for the owner to answer the pending ones, or to use `--no-wait`.
- App-module: CLI-only for now (no settings page exists in the module; the machine and Requests pages are not a fit).

## Limits (the wait is chosen by the caller, so the target bounds it)

| Input | Limit |
|---|---|
| `--wait` | 10 s to 60 min on the CLI; the target caps it at its own maximum (default 30 min) and says so in the answer when it capped |
| held requests per peer / per machine | 2 / 4 (separate from the 4 concurrent runs; a held request is not running) |
| a held request counts as a refusal for the session cap of 20 only once, when it is finally refused |
| per-peer request rate limit | unchanged: a hold is one request |
| listed text | the command is shown as sent (2048 characters max, already bounded) |

## Decisions (reversible)

- Hold lives on the target, in memory, per session. A daemon restart ends every hold with `refused: not-listed (daemon restarted)`; nothing persists.
- The re-check after an Allow uses the same `authorize` as a fresh request: a changed policy version, an expired entry or a revoked peer is refused as usual.
- The Allow button and `machine admin allow` already sign the exact refused string; no change to what they sign. Deny is a restricting action: no signature and no passphrase (hard rule 4, "only restricting actions need no signature"), logged. The web route `POST /deny` is still `sensitive` (app-core PIN, like Allow): without it any local process that reaches the app-core port could answer the owner's held requests `denied`. The CLI `machine requests --deny` needs no PIN (local user at the terminal).
- The answer timeout of the caller becomes wait + run timeout + 30 s.
- Deny with a reason is shown to the agent: it must not contain anything secret (the owner types it; the audit log carries it).

## Front-ends

- CLI: `--wait <duration>` on `run`; `machine requests` shows state (waiting / allowed / denied / expired) and the time left; `machine requests --deny <id> [--reason <text>]` (no PIN, no passphrase).
- Web: the Requests page lists waiting requests first with a countdown, the hint prominent, buttons Allow and Deny; same data as the CLI. Deny asks the app-core PIN first (401 `elevation-required` / 403 `pin-not-set` answers carry the fix).

## Test plan (TDD)

1. Core/peerService: hold, Allow arrives, runs once; Deny; deadline; disconnect; revoke during hold; policy changes to a non-matching version; cap on holds per peer and per machine; wait above the cap is capped and said so.
2. No new right: a held command that no signed entry matches never runs, whatever the wait; a typed entry still validates values.
3. The caller answer timeout (wait + run + 30 s) and the progress lines; `--json` stdout stays one document.
4. Daemon restart ends holds with a named cause.
5. CLI and web read the same state; Deny needs no passphrase (the web Deny needs the PIN, the CLI Deny nothing); Allow needs both.

## Deviations from v0.1 (as built)

- Wire: `waitSeconds` is a field of the `run` frame next to the signed request, not part of the signed body (the channel is authenticated; an older target ignores it and refuses at once, the caller then warns that the target did not hold). No new frame: the answer carries `held: {waitSeconds, requestedSeconds, capped}` on a refusal of a held request.
- A daemon restart cannot answer `refused: not-listed (daemon restarted)`: the connection drops. The caller reports `the connection ended while the request was waiting for approval`; the daemon writes `daemon-started` to the audit log before its first hold, so `machine requests` stops listing earlier holds (a restart followed by no new hold leaves the old row until its deadline, 30 min at most).
- State is audit-based: `held` and `hold-ended` (outcome allowed, denied, deadline, refused, revoked, disconnected) events; `machine requests` lists a hold with no end, a deadline ahead and no later `daemon-started`. The final refusal (`denied`, or `not-listed` at the deadline) is the one `refused` entry.
- The target polls every 1 s (policy, Deny, registration, deadline): an Allow runs the command within about 1 s. Reasons held: `not-listed`, `no-policy`; not held when the command is allowed under another shell. Any other result of `authorize` after the wait (`expired`, `exhausted`) is refused as for a fresh request.
- Held limits answer `hold-limit-peer` / `hold-limit-machine` at once. Stray message while held: `unexpected-message`, hold goes on. Bad `waitSeconds`: `bad-wait`.
- Deny: daemon command `deny` (id or unique prefix of at least 6 characters, reason printable ASCII up to 200); needs the daemon running (`no-daemon` otherwise).
- Not built: the remote `requests-list` (admin asks a peer) does not carry waiting requests; no end-to-end test of the 10 s deadline through the CLI (covered in the peer service tests with a fake clock).
