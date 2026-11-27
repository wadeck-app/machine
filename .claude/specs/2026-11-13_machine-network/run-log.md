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

## Live follow: `machine log --follow` (decision 90)

`machine log [--sent | --received] --follow | -f [--since <30m|2h|3d|date> [--limit <n>]] [--all] [--width <40-300>] [--json]`: like `tail -f` on this machine's own logs, to watch what a target does. Read-only, no daemon, exit 0 on Ctrl+C. Nothing is printed that `machine log` does not already show: no environment, output, passphrase or free message.

- **Sources**: the audit log (`--received`), the current run log file `run-log/runs.ndjson` (`--sent`), both by default. Starts from now; `--since` first prints the matching history (oldest first, the rows of `machine log`, `--limit` default 50, an `[info]` says how many older ones are left), then follows from where the history was read. `--machine`, `--outcome`, `--text`, `--offset` are refused with the fix (pipe to `grep`); `--limit` needs `--since`.
- **Rows**: one line per entry, NEVER longer than the terminal (followRows.ts; the cells are those of `machine log`, `activityCells` helpers). The width is `--width <n>` (40 to 300, else refused), else the terminal's columns, else 100 when the output is not a terminal; it is read again at each row, so a resize applies to the next row; the line is one column shorter than the terminal. What does not fit goes in this order until the command has 24 characters: the wait, the SHELL column, part of the RESULT width, the run time, the rest of RESULT; TIME, COMMAND (at least 12 characters, ends with `...` when cut), RESULT and EXIT always stay. Below 60 columns: no arrow, no seconds. The year is not in TIME. The same widths apply to every row of a width (columns line up).
  - Columns: `MM-DD HH:MM:SS`, `<=` received / `=>` sent, SHELL, COMMAND, RESULT, EXIT and RAN merged (`0  14 ms`). The other machine is named in the first words of COMMAND (`laptop: ls -l`) on the first row and when it differs from the row above; when the network has exactly one other machine, the header names it (`Following midgard2 <-> thinkcentre (received), 100 columns, Ctrl+C stops`) and rows never do. The wait is a tail `waited 1 min 47 s` after RAN, only on rows that have one and only when the width keeps 24 characters for the command (about 140 columns and more).
  - Rows: an audit `accepted` shows at once as `running`; its `completed` / `failed` line shows the finished row (exit code, run time) at the time of the completion. A refusal shows `refused (<reason>)` or `denied`. `held` and `hold-ended (allowed)` are rows of their own, always shown. Event rows with no command are short words in COMMAND and the first of `reason`, `outcome`, `state`, `cause`, `error`, `kind` in RESULT: `doc accepted`, `doc delivered`, `doc already there`, `session closed  peer-revoked`, `notice undelivered  unreachable`. They are HIDDEN by default (documents, sessions, notices, daemon start; the header says so) and shown with `--all`. History from `--since` has the rows of `machine log` only. `--all` and `--width` are refused with the fix on any other command.
- **Polling** (machine-core `activityFollow.ts`, pure; machine-cli `cliFollow.ts` does stat, read, print): every 500 ms a file is statted; size and modification time unchanged = nothing opened. Otherwise the first 64 bytes (the head) and the new bytes are read, at most 256 KiB per round (a bigger append is read in several rounds). Lines are cut on newline in bytes; a last line without newline waits for it; a line over 1 MiB is dropped and reported damaged.
- **Rotation and truncation**: a file smaller than what was read was cut; a file whose head is not the head it had was replaced (the run log is rotated by rename). Both print `[info] the <log> was cut | was replaced (rotation): following it from its start` and read the new file from its first byte. A file that disappears is said and followed again when it comes back; one that does not exist at the start is followed from its first line.
- **Chain**: only the lines read are checked (own hash, link to the previous line read; the first line is checked against the last line before the start of the follow). The first break is ONE `[warn]`; from there the entries carry `[UNVERIFIED]`. The daemon checks the whole log at start.
- **Damaged lines** (not JSON, wrong shape, oversized) are a `[warn]` naming the file, never a crash; the next lines are shown. `[warn]` and `[info]` go to stderr, rows to stdout. A file that cannot be read is said once and looked at again at each poll.
- `--json`: one JSON event per line (the fields of `machine log --json` items), no header, every event (`--all` and the width do not apply).
- Known gaps: lines appended to the run log between the last poll and its rotation stay in the rotated file and are not shown; an entry written between the history read and the start of the follow can show twice.

## `machine run --json` shape

`machine run --json` prints the peer's answer as is (one document on stdout; the process exit code is the command's, 255 for a failure of machine). A refusal is not this document: it is an error on stderr, exit 255. Pinned by `runJsonShape.test.ts` (exact key set and types): adding, removing or retyping a field fails it, and changes this table.

| Key | Type | Meaning |
|---|---|---|
| `type` | string | always `"result"` |
| `id` | string | request id (uuid), the one of the audit and the run log |
| `exitCode` | number or null | exit code of the command; `null` when it was killed (timeout, output cap) |
| `stdout` | string | output, possibly cut (see `truncated`) |
| `stderr` | string | error output, possibly cut |
| `timedOut` | boolean | the command exceeded the time limit of the peer (60 s) and was stopped |
| `truncated` | boolean | the output exceeded the limit of the peer (1 MiB) and was cut |
| `outputNotUtf8` | boolean | the output was not valid UTF-8 and was decoded lossily |
| `decodedFrom` | string, optional | code page the output was converted from (`cp850`); absent otherwise and from a peer older than decision 70 |
| `durationMs` | number | run time of the command measured by the peer |

## Not covered

- Received entries after a break of the audit chain are flagged `UNVERIFIED`; a completion merged into an earlier verified acceptance keeps the verified flag (existing behaviour of `summarizeRequests`).
- Whole-chain verification of the audit log is not part of reading the Activity: use the daemon start check.
- The machine filter of the page offers the network machines and those on the page read, not every machine ever seen.
- No peer-to-peer view: a machine shows its own sent and received entries only.
