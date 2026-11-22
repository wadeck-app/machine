# Hold a refused request for approval (`machine run --wait`)

**Status:** v0.6, 2026-11-22 (an exhausted or expired entry is held and renewed, see "Renewal"), v0.5 (remote view, layout), decisions 80 and 81 (the wait is the default of `machine run`, see "Default and setting"; the web Deny is PIN-protected). Implemented: core (`hold.ts`, waiting list in `requests.ts`), peer service, daemon `deny`, CLI, app-module backend and Requests page (see Deviations). User request: a `run` that the target does not allow yet can wait N minutes so the owner validates in the UI while the agent keeps working, or be explicitly refused.
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
- Hold limits (`hold-limit-peer`, `hold-limit-machine`, 5 and 10 by default) now meet default runs: the caller's message adds to wait for the owner to answer the pending ones, or to use `--no-wait`.
- App-module: CLI-only for now (no settings page exists in the module; the machine and Requests pages are not a fit).

## Renewal (an entry that is used up or expired)

An entry whose `--times` calls are used, or whose `--for`/`--until` date passed, behaves like a command that is not allowed: with a wait (the default) the request is HELD, and the Allow of the owner RENEWS the entry. Same hold table and limits, notices, audit events (`held`, `hold-ended`), `machine requests` listing, remote Deny, progress and Requests page card. Only `--no-wait` / `--on-refusal fail` refuse at once, still as `exhausted` / `expired` with the fix.

| Piece | Behaviour |
|---|---|
| Decision | `authorize` adds `renewal` to the `expired` / `exhausted` refusal: the entry text as signed (the template of a typed entry), `typed`, `own` (own list of the peer, else default), `maxCalls`, `expiresAt`, `used`. LOCAL only: never sent to the caller (T-03, T-65) |
| Words | `renew: entry used 1 of 1 call(s)` or `renew: expired at <ISO instant>` (`renewalNote`), then the shell and the entry text; on `machine requests`, the exact command is `machine admin allow <m> --renew --shell sh --times 1 -- "<entry>"` (an expired entry says `--for <duration>`: its duration is not stored) |
| Carriers | `held` audit line (`renewal` object), `Hold.renewal`, the optional `renewal` field of the `request-notice` frame and of a `waiting` row of `requests-list` (strict parse; a malformed one is refused by name, never dropped; an older receiver rejects only the notice that carries it) |
| Allow | `nextPolicyBody(..., {kind:'allow', renew:true})` replaces the entry of the same shell and text (in the own list when `own`) in ONE admin-signed policy, even with the same limits; never a second entry; no right beyond what the admin signs (hard rule 4). `machine admin allow` / `machine policy allow` take `--renew`; without it, the same limits are `already-allowed` and other limits replace the old ones as before |
| Page | The card shows `Renewal: <note>`, the dialog and the inline form default to the previous limits (once for 1 call, N calls for N, 1 hour for an expired entry), the summary says `renews <cmd>: <old limits> -> <new limits>` |
| Counter | The key of the counter is entry + limits (+ `limits.renewals`). A renewal writes `limits.renewals` = previous + 1 (only when the entry keeps limits), so the replaced entry starts at 0 even with identical limits, and a list edit that leaves an entry alone keeps its count. A body with `renewals` is version 2: an older target refuses it with `unsupported version 2` and the update hint |
| Release | The 1 s poll (or the delivery wake-up) runs the same `authorize`: the held run proceeds as for any Allow; at the deadline the refusal keeps the cause (`exhausted`, `expired`) plus `waited 10m, nobody answered` |

## Limits (the wait is chosen by the caller, so the target bounds it)

| Input | Limit |
|---|---|
| `--wait` | 10 s to 60 min on the CLI; the target caps it at its own maximum (default 30 min) and says so in the answer when it capped |
| held requests per peer / per machine | 5 / 10 by default (decision 93), set by the owner of the target with `machine hold-limits` (1 to 20 / 1 to 50, per machine at least per peer; file `<configDir>/hold-limits.json`, local only, never from a peer or a signed policy, T-64); separate from the 4 concurrent runs; a held request is not running |
| a held request counts as a refusal for the session cap of 20 only once, when it is finally refused |
| per-peer request rate limit | unchanged: a hold is one request |
| listed text | the command is shown as sent (2048 characters max, already bounded) |

## Decisions (reversible)

- Hold lives on the target, in memory, per session. A daemon restart ends every hold with `refused: not-listed (daemon restarted)`; nothing persists.
- The re-check after an Allow uses the same `authorize` as a fresh request: a changed policy version, an expired entry or a revoked peer is refused as usual.
- The Allow button and `machine admin allow` already sign the exact refused string; no change to what they sign. Deny is a restricting action: no signature and no passphrase (hard rule 4, "only restricting actions need no signature"), logged. The web route `POST /deny` is still `sensitive` (app-core PIN, like Allow): without it any local process that reaches the app-core port could answer the owner's held requests `denied`. The CLI `machine requests --deny` needs no PIN (local user at the terminal).
- The answer timeout of the caller becomes wait + run timeout + 30 s.
- Deny with a reason is shown to the agent: it must not contain anything secret (the owner types it; the audit log carries it). Printable ASCII, 200 characters at most, one whitelist (`checkDenyReason`) for the CLI, the daemon, the route and the page. The caller prints `refused by <machine>: denied: <reason>`, or `refused by <machine>: denied by the owner, no reason given`; the same for a Deny from the CLI, the page or another machine. The text is also the `note` of the `refused` and `hold-ended` audit lines and the cause of the `denied` rows of `machine log` (control characters of an edited log are shown as `?`).

## Front-ends

- CLI: `--wait <duration>` on `run`; `machine requests` shows state (waiting / allowed / denied / expired) and the time left; `machine requests --deny <id> [--reason <text>]` (no PIN, no passphrase).
- Web: the Requests page lists waiting requests first with a countdown, the hint prominent, buttons Allow and Deny; same data as the CLI. Deny asks the app-core PIN first (401 `elevation-required` / 403 `pin-not-set` answers carry the fix).

## Remote view (the owner is on another machine)

The held request lives on the target; the admin machine reads it with the existing `requests-list` frame, nothing else is new on the wire.

| Piece | Behaviour |
|---|---|
| Answer | `waiting` (id, peer, peerName, shell, command, since, deadline) next to `pending`; at most 16, always sent whole (groups are dropped for size first); an answer without it (older peer) reads as none |
| Authorization | unchanged: signed with the ADMIN key, own target and source, 60 s, replay cache, 6 per minute per peer, audited before the read; same data a peer already gives `machine requests` locally, no new right |
| CLI | `machine requests <machine>` and `--all` print the same layout as the local view (WAITING NOW with time left on the clock of this machine, exact allow command) |
| Allow | from the admin machine: `machine admin allow <machine> ...` signs, the relay inbox delivers, the target daemon installs it (within about 5 s while it holds a request, because its relay inbox poll runs every 5 s instead of 60 s; a failing relay still backs off), the 1 s hold poll then runs the command (test: holdRemoteAllowE2e.test.ts) |
| Page | Requests page: machine filter, held and refused requests of every trusted machine; the admin machine loads the peers on demand (PIN, then admin passphrase each time, request signed in the browser, one per peer); Allow signs for the machine of the row |
| Deny | NOT built from another machine. Rule when it is: admin signature only (same gate as `requests-list`), never the registered requester (it already cancels by disconnecting) or any other peer. It needs a new frame, so the CLI and the page say to run `machine requests --deny <id>` ON the target |

## Layout of `machine requests`

Header with counts, WAITING NOW, REFUSED, one aligned row per request, at most one action line per section (exact allow command for one row, template for several, `--full` gives every exact command and wraps the command), a `Notes:` footer of at most 3 lines. No line over 100 columns, ASCII only, `--json` unchanged. Note when a row uses `cmd` and the target is not known to be Windows: the caller needs `--shell sh` (`machine peer connect <m> --shell sh`). Pure code: machine-core `requestsLayout.ts`.

## Test plan (TDD)

1. Core/peerService: hold, Allow arrives, runs once; Deny; deadline; disconnect; revoke during hold; policy changes to a non-matching version; cap on holds per peer and per machine; wait above the cap is capped and said so.
2. No new right: a held command that no signed entry matches never runs, whatever the wait; a typed entry still validates values.
3. The caller answer timeout (wait + run + 30 s) and the progress lines; `--json` stdout stays one document.
4. Daemon restart ends holds with a named cause.
5. CLI and web read the same state; Deny needs no passphrase (the web Deny needs the PIN, the CLI Deny nothing); Allow needs both.

## Deviations from v0.1 (as built)

- Wire: `waitSeconds` is a field of the `run` frame next to the signed request, not part of the signed body (the channel is authenticated; an older target ignores it and refuses at once, the caller then warns that the target did not hold). No new frame: the answer carries `held: {waitSeconds, requestedSeconds, capped}` on a refusal of a held request.
- A daemon restart cannot answer `refused: not-listed (daemon restarted)`: the connection drops. The caller reports `the connection ended while the request was waiting for approval`; the daemon writes `daemon-started` to the audit log before its first hold, so `machine requests` stops listing earlier holds (a restart followed by no new hold leaves the old row until its deadline, 30 min at most).
- State is audit-based: `held` and `hold-ended` (outcome allowed, denied, deadline, refused, revoked, disconnected) events (a caller that disconnects frees its slot at once: the hold watches the connection and ends with `hold-ended` `disconnected`; a silent network drop with no FIN or RST is only seen at the deadline); `machine requests` lists a hold with no end, a deadline ahead and no later `daemon-started`. The final refusal (`denied`, or `not-listed` at the deadline) is the one `refused` entry.
- The target polls every 1 s (policy, Deny, registration, deadline): an Allow runs the command within about 1 s. Reasons held: `not-listed`, `no-policy`, `expired`, `exhausted` (see "Renewal"); not held when the command is allowed under another shell. `invalid-request` after the wait is refused as for a fresh request.
- Held limits answer `hold-limit-peer` / `hold-limit-machine` at once. `hold-limit-peer` names the limit, says the owner can change it (`machine hold-limits --per-peer <n>`) and lists the caller's own holds (short id, command cut at 60 characters) with `machine requests --deny <id>`. The daemon reads the file at start and at each admission (stat cache): a bad value is a `[warn]` in the daemon log and the built-in default applies for that value only; a per-machine value below per-peer is raised to it, with a `[warn]`. Stray message while held: `unexpected-message`, hold goes on. Bad `waitSeconds`: `bad-wait`.
- Deny: daemon command `deny` (id or unique prefix of at least 6 characters, reason printable ASCII up to 200); needs the daemon running (`no-daemon` otherwise).
- Not built: a Deny of a request held on ANOTHER machine (see "Remote view"); no end-to-end test of the 10 s deadline through the CLI (covered in the peer service tests with a fake clock).
- Fix (2026-11-21): a policy installed DURING a hold that lists the command under another shell now answers at once `refused: not-listed` with `allowedShells` and the `--shell` hint (hold-ended outcome `refused`). Before, only the first check did this, so a caller using the wrong shell (`cmd` against a Linux target, entry signed under `sh`) waited until the deadline.
- Fix (2026-11-22): an Allow whose command cannot start on the target (`cannot-run`, for example an entry with shell `sh` on a Windows target) was announced as `hold-ended allowed`, so the page showed "Released" before the refusal, or nothing it could end on. Now:
  - The audit still writes `hold-ended` `allowed` at once (the Allow did release the hold), then `accepted` and `failed` as before.
  - The notice (`request-notice-end`) and the daemon's own record (`notice-ends.json`) are sent when the shell process exists (`onStarted` of machine-exec), or when the run ends if the executor never reports a start.
  - If the command cannot start (or `busy`, `audit-unavailable` after the Allow), the announced outcome is `refused`, never `allowed`.
  - For a hold of THIS machine `notice-ends.json` and `holdProgress` also carry `reason` and `message` (printable ASCII, 300 characters max); the card ends at once with "the target allowed it but could not run it, cannot-run: <fix>".
  - Wire unchanged: the frame carries the outcome alone (older receivers reject extra fields). The page of ANOTHER machine therefore shows the generic "the target refused it after all: nothing ran"; the cause is in `machine run` of the caller and `machine log` on the target.
  - `machine run` already printed `refused by <machine>: cannot-run: <message with the fix>` (test: holdE2e.test.ts).
