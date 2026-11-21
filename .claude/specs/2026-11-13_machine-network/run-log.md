# Run log and Activity (decision 82)

What THIS machine sent with `machine run` and what it received, in one list. The received side is the existing audit log (hash-chained, see threat-model.md T-07); the sent side is new.

## Outgoing run log

- One JSON line per `machine run` whose peer was resolved (a run refused before anything was sent, such as a bad flag or an unknown machine, is not recorded).
- Written by the process that sends: the CLI (`cliNetwork.ts` through `runLogRecord.ts`). The daemon and the app module send no run, so they write nothing.
- Folder `<configDir>/run-log/` (0700), current file `runs.ndjson` (0600), rotated files `runs.<ms>-<pid>.ndjson`.

| Field | Meaning |
|---|---|
| `v`, `ts`, `runId` | format 1, ISO UTC time the request was sent, id of the request (the target's audit log uses the same id) |
| `from`, `to` | `{name, uuid}` of this machine and of the peer |
| `shell`, `command`, `truncated` | as sent; at most 2048 characters, `truncated` when cut (also cut when the JSON line would pass 4096 bytes) |
| `waitMode`, `onRefusal`, `waitSeconds`, `waitedSeconds` | where the wait came from (`default`, `flag`, `setting`), its mode and length, and the seconds before the answer minus the command's own run time (0 without wait) |
| `outcome` | `ran` (+ `exitCode`, `timedOut`), `refused` (+ `reason`), `denied`, `deadline` (a held request nobody allowed in time), `timeout` (no answer), `connection-lost`, `error` (+ `cause`, at most 300 printable ASCII characters) |
| `durationMs` | whole run, connection included |

## Rotation and writing

- Appending is one `write` of one line (`O_APPEND`, at most 4096 bytes): two `machine run` processes never interleave inside a line.
- Size-based: a line that would pass 5 MiB starts a new file; the full one is renamed (never truncated); the newest 5 files (current included) are kept, older ones deleted.
- A rotation another process already did (rename finds no file) is not an error.
- A log that cannot be written never blocks the run: one `[warn] this run is NOT recorded in the run log <dir>: <cause>` names the folder and the fix.
- The reader skips a damaged line (crash cut, edit, newer format) and counts it; `machine log` prints one `[warn]` with the count.
- The audit log of the target does not rotate (a hash chain cannot); it is read whole.

## Privacy

The command line is stored as typed. Commands must never carry a secret, the same rule as the allow list (an exact entry is already in clear in the signed policy and the audit log). Never stored: environment, passphrase, stdout, stderr.

## Reading

- machine-core `buildActivity` (pure) merges both logs into events `{ts, direction: sent|received, from, to, shell, command, outcome, ...}`, newest first, filtered by direction, machine (name or uuid prefix of the other side), outcome, time range, text, with `limit` (default 50, max 500) and `offset`. Received outcomes: `ran`, `error`, `unfinished` (accepted, no completion), `refused`, `denied`. Every text is reduced to printable ASCII.
- `machine log [--sent | --received] [--machine <name>] [--since <30m|2h|3d|date>] [--outcome <x>] [--text <word>] [--limit <n>] [--offset <n>] [--json]` (new command; `machine requests --history` stays the history of the refusals of this machine). Lines of at most 100 ASCII characters.
- Module: page Activity (`GET /api/modules/machine/activity`, daemon command `activity`), read-only, same filters, period choice, pages.

## Not covered

- Received entries after a break of the audit chain are flagged `UNVERIFIED`; a completion merged into an earlier verified acceptance keeps the verified flag (existing behaviour of `summarizeRequests`).
- The whole audit log is read and verified at each request (no cap): a very large log makes the page and `machine log` slower.
- No peer-to-peer view: a machine shows its own sent and received entries only.
