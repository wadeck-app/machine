# Hold a refused request for approval (`machine run --wait`)

**Status:** v0.2, 2026-11-21, decision 80. Implemented: core (`hold.ts`, waiting list in `requests.ts`), peer service, daemon `deny`, CLI, app-module backend and Requests page (see Deviations). User request: a `run` that the target does not allow yet can wait N minutes so the owner validates in the UI while the agent keeps working, or be explicitly refused.
**Not a new right:** hold changes WHEN a refusal is answered, never WHAT is allowed. Hard rule 3 and 4 hold: the held command runs only if, after the wait, an entry signed under rule 4 matches it.

## Behaviour

| Caller | Target |
|---|---|
| `machine run <peer> --wait 10m -- <cmd>` (default: no wait, today's behaviour) | no match: instead of `not-listed` at once, the request is HELD up to the wait and listed as "waiting" in `machine requests` and on the Requests page |
| nothing else to send; the connection stays open | an Allow (signed entry, any lifetime incl. `--times 1`) that matches the held command runs it at once and the caller gets the normal `result` |
| | an explicit Deny by the owner answers `refused: denied` at once, with the optional reason |
| | the deadline passes: `refused: not-listed` plus `waited 10m, nobody answered` |
| | caller disconnects: the hold is dropped and audited |

- The caller sees a progress line on stderr every 30 s: `waiting for <machine> to allow it (7 min left)`. `--json` keeps stdout clean.
- Exit codes: unchanged for result; refusal by Deny and by deadline are distinct, named causes in the message.

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
- The Allow button and `machine admin allow` already sign the exact refused string; no change to what they sign. Deny is a restricting action: no signature (hard rule 4, "only restricting actions need no signature"), logged.
- The answer timeout of the caller becomes wait + run timeout + 30 s.
- Deny with a reason is shown to the agent: it must not contain anything secret (the owner types it; the audit log carries it).

## Front-ends

- CLI: `--wait <duration>` on `run`; `machine requests` shows state (waiting / allowed / denied / expired) and the time left; `machine requests --deny <id> [--reason <text>]`.
- Web: the Requests page lists waiting requests first with a countdown, the hint prominent, buttons Allow and Deny; same data as the CLI.

## Test plan (TDD)

1. Core/peerService: hold, Allow arrives, runs once; Deny; deadline; disconnect; revoke during hold; policy changes to a non-matching version; cap on holds per peer and per machine; wait above the cap is capped and said so.
2. No new right: a held command that no signed entry matches never runs, whatever the wait; a typed entry still validates values.
3. The caller answer timeout (wait + run + 30 s) and the progress lines; `--json` stdout stays one document.
4. Daemon restart ends holds with a named cause.
5. CLI and web read the same state; Deny needs no passphrase; Allow still does.

## Deviations from v0.1 (as built)

- Wire: `waitSeconds` is a field of the `run` frame next to the signed request, not part of the signed body (the channel is authenticated; an older target ignores it and refuses at once, the caller then warns that the target did not hold). No new frame: the answer carries `held: {waitSeconds, requestedSeconds, capped}` on a refusal of a held request.
- A daemon restart cannot answer `refused: not-listed (daemon restarted)`: the connection drops. The caller reports `the connection ended while the request was waiting for approval`; the daemon writes `daemon-started` to the audit log before its first hold, so `machine requests` stops listing earlier holds (a restart followed by no new hold leaves the old row until its deadline, 30 min at most).
- State is audit-based: `held` and `hold-ended` (outcome allowed, denied, deadline, refused, revoked, disconnected) events; `machine requests` lists a hold with no end, a deadline ahead and no later `daemon-started`. The final refusal (`denied`, or `not-listed` at the deadline) is the one `refused` entry.
- The target polls every 1 s (policy, Deny, registration, deadline): an Allow runs the command within about 1 s. Reasons held: `not-listed`, `no-policy`; not held when the command is allowed under another shell. Any other result of `authorize` after the wait (`expired`, `exhausted`) is refused as for a fresh request.
- Held limits answer `hold-limit-peer` / `hold-limit-machine` at once. Stray message while held: `unexpected-message`, hold goes on. Bad `waitSeconds`: `bad-wait`.
- Deny: daemon command `deny` (id or unique prefix of at least 6 characters, reason printable ASCII up to 200); needs the daemon running (`no-daemon` otherwise).
- Not built: the remote `requests-list` (admin asks a peer) does not carry waiting requests; no end-to-end test of the 10 s deadline through the CLI (covered in the peer service tests with a fake clock).
