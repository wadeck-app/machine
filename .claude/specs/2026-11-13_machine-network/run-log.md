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
| `durationMs` | whole run, connection and wait included |
| `execMs` | `ran` only: run time of the command on the target, the `durationMs` of its result frame. Absent in lines written before it existed |

## Rotation and writing

- Appending is one `write` of one line (`O_APPEND`, at most 4096 bytes): two `machine run` processes never interleave inside a line.
- Size-based: a line that would pass 5 MiB starts a new file; the full one is renamed (never truncated); the newest 5 files (current included) are kept, older ones deleted.
- A rotation another process already did (rename finds no file) is not an error.
- A log that cannot be written never blocks the run: one `[warn] this run is NOT recorded in the run log <dir>: <cause>` names the folder and the fix.
- The reader skips a damaged line (crash cut, edit, newer format) and counts it; `machine log` prints one `[warn]` with the count.
- The audit log of the target does not rotate (a hash chain cannot); it is read from its end, a page at a time (see Reading).

## Privacy

The command line is stored as typed. Commands must never carry a secret, the same rule as the allow list (an exact entry is already in clear in the signed policy and the audit log). Never stored: environment, passphrase, stdout, stderr.

## Reading

- machine-core `buildActivity` (pure) takes both logs as lazy line iterables, NEWEST FIRST, and builds events `{ts, direction: sent|received, from, to, shell, command, outcome, exitCode, timedOut, durationMs, execMs, execDerived, waitedSeconds, ...}`, filtered by direction, machine (name or uuid prefix of the other side), outcome, time range, text, then cut by `limit`/`offset`. Received outcomes: `ran`, `error`, `unfinished` (accepted, no completion), `refused`, `denied`. Every text is reduced to printable ASCII.
- **Run time and wait**: `execMs` is the target's own measure. For an old line without it, the reader derives `durationMs - waitedSeconds * 1000` (`execDerived: true`, shown as `~0.3 s` with a legend: it includes the connection) and shows nothing when the result would be negative. Received rows take the exit code and the run time from the audit `completed` entry; the audit stores no wait, so WAITED is a dash there.
- **Order**: the run log is appended when a run ends, with the time it was sent. The reader merges both logs with a small buffer and releases an event once no unread line can be newer (a run that waited an hour is written after later runs).
- **Total**: with no filter on the content (direction aside) it is the sum of per-file row counts kept in a cache keyed by size and modification time (exact, no pass). A file that only grew is counted from the old end (checked with the last 64 bytes before it); a file changed any other way is recounted from the start and reported (`runLog.recounted`, `[warn]`). With a machine, outcome, period or text filter, one counting pass reads the logs (stops at the start of the period) within a budget of 400,000 lines; past it `totalExact` is false and `total` is a lower bound. The cache lives as long as the process (the daemon keeps it; `machine log` pays one count per run).
- **Cost of a page**: lines are read from the end of the newest file in 64 KiB chunks and reading stops one entry past the page; memory is bounded (a line over 1 MiB is dropped as damaged). Page 1 of a 50,000-line run log plus a 2,000-line audit log reads 128 KiB; a deeper page reads proportionally more, the last page reads the whole logs once.
- **Audit chain**: not verified per request (the daemon does it at start). The audit lines read for the page are checked against each other (own hash, link to the older neighbour); a break inside that window is reported (`chain.scope: "window"`) and the entries from it on are flagged UNVERIFIED. A completion whose acceptance is not in the log (head cut by hand) shows no row.
- A page past the last one is refused (`bad-query`) with the last page in the message.
- `machine log [--sent | --received] [--machine <name>] [--since <30m|2h|3d|date>] [--outcome <x>] [--text <word>] [--limit <n>] [--offset <n>] [--json]` (`machine requests --history` stays the history of the refusals of this machine). Table of at most 100 ASCII characters: TIME, route, SHELL, COMMAND, RESULT, EXIT (code, `timed out`, `killed`, `-`), RAN, WAITED. `--json` carries `durationMs`, `execMs`, `execDerived`, `waitedSeconds`, `total`, `totalExact`, `page`, `pageSize`, `pageCount`.
- Module: page Activity (`GET /api/modules/machine/activity`, daemon command `activity`), read-only. Query: the filters plus `page` (1-based) and `pageSize` (25, 50 or 100; 25 by default; anything else is refused). Answer: `{rows, total, totalExact, page, pageSize, pageCount, pageSizes, ...}`. Columns: Result badge, Exit (green 0, red any other code, timeout or kill, muted dash when nothing ran), Ran for, Waited. Filters, page and size are kept in the page address.

## Not covered

- Received entries after a break of the audit chain are flagged `UNVERIFIED`; a completion merged into an earlier verified acceptance keeps the verified flag (existing behaviour of `summarizeRequests`).
- Whole-chain verification of the audit log is not part of reading the Activity: use the daemon start check.
- The machine filter of the page offers the network machines and those on the page read, not every machine ever seen.
- No peer-to-peer view: a machine shows its own sent and received entries only.
