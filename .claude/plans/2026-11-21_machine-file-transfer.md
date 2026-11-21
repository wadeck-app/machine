# File transfer through machine (plan)

**Status:** plan only, nothing built. Requested by the user 2026-11-21: transfer authorised or not by the allow-list, filters by extension and size.
**Not in out-of-scope.md.** Hard rule 3 (a peer request runs only if an entry matches) needs an amendment for a second entry kind: the user must confirm it (see Decisions).

## Shape

- Data never uses the relay (cap 16 KiB per document, untrusted). It rides the existing peer channel: TLS 1.3 mutual plus the pair-secret proof, so rule 11 and "every message encrypted" hold with no new crypto.
- The machine whose disk is touched decides: its policy for the calling peer holds the transfer entries. Push writes on the target, pull reads on the target.
- A transfer entry is a new kind next to command entries (policy body v3, refused loudly by older readers like v2 today; an old build says `machine cli update`).
- One file per request in phase 1. No directory, no glob, no listing, no archive extraction by machine.

## Transfer entry (signed, same signature rules as any entry: hard rule 4)

| Field | Rule |
|---|---|
| `direction` | `push` (peer writes here) or `pull` (peer reads from here), one per entry |
| `root` | canonical absolute folder, mandatory; same `path` rules as typed-parameters phase 2 (segment-wise containment, realpath, never the machine config folder, root not writable by another user or loud signing warning) |
| `ext` | whitelist of 1 to 16 extensions, each `[a-z0-9]{1,10}`, compared lower-case; empty list not allowed (no "any") |
| `maxBytes` | 1 to 4 GiB; default proposed at signing: 10 MiB |
| `name` | `[A-Za-z0-9_][A-Za-z0-9._-]*`, at most 128 characters, flat inside `root` (no sub-folder in phase 1); reserved device names, trailing dot or space, `:` refused on Windows |
| `overwrite` | `never` (default) or `replace`; `replace` is shown as a warning at signing |
| lifetime | reuse `--times N`, `--for`, `--until`; `--times 1` is "authorise this one transfer" |
| optional quotas | `maxFilesPerDay`, `maxBytesPerDay` (persisted like `usage.json`) |

Authorisation modes, all from existing mechanisms:

| Wanted | How |
|---|---|
| Always allowed | permanent entry |
| Allowed once, after a human looked | no entry: the request is refused and listed in `machine requests` / Requests page; Allow signs an entry with `--times 1` for that exact direction, name and size |
| Time limited | `--for` / `--until` |
| Forbidden | no entry (default) |

## Receiving side (push) and sending side (pull) rules

1. Check the entry BEFORE any byte is accepted: direction, name, extension, declared size within `maxBytes`, quota, free disk space (twice the size margin refused with a message naming the free space).
2. Write to `<root>/.<name>.<random>.part`, created exclusively, never following a link (`O_NOFOLLOW` / junction check), mode 0600, no executable bit.
3. Count bytes while streaming: abort and delete the part file when received bytes exceed the declared size or `maxBytes`, or when no chunk arrives for 30 s.
4. SHA-256 declared in the offer and verified at the end; mismatch deletes the part file.
5. Rename to the final name (atomic in the same folder); `overwrite: never` and an existing file is a refusal that names the file.
6. Pull: `realpath` the requested name, must stay inside the canonical `root`, regular file only (no FIFO, socket, device, `/proc`), open then `fstat` (size and type checked on the opened handle, not on the path), same extension and size filters.
7. The extension is a label, not content proof: stated in the signing summary. Optional magic-byte check for a short list of types is phase 2.
8. Audit line: peer, direction, final path, size, SHA-256, matching entry. Never content, never a secret.

## Limits (realistic, tested at the boundary: max accepted, max + 1 refused)

| Input | Limit |
|---|---|
| file name | 128 characters |
| root path | 260 characters, 32 segments |
| extensions per entry | 16, each 10 characters |
| entries per list | existing 200 (shared with command entries) |
| chunk | 256 KiB (frame cap stays 1 MiB) |
| file size | entry `maxBytes`, hard ceiling 4 GiB |
| concurrent transfers | 2 per peer, 4 per machine (counted with the existing 4 concurrent runs) |
| idle time | 30 s without a chunk |
| total time | size at a floor of 100 KiB/s, plus 30 s |
| refusals | existing 20 per session |

## Protocol (new frame types on the existing channel)

`transfer-offer {id, direction, name, size, sha256}` then `transfer-accept` or `refused {reason}` then `chunk {id, seq, data}` ... then `transfer-end {id}` then `transfer-result {id, ok, sha256, bytes}`.
Not verified: that the transport and `peerService` allow several frames per request (a run answers with ONE result frame today); this is the first thing to read and test in phase 3. Resume (`offset` in the offer) is phase 2.

## Front-ends (thin, all logic in `machine-core`)

- `machine send <peer> <file> [--as <name>]` and `machine get <peer> <name> [--out <folder>]`; progress on stderr, `--json` result; a refusal prints the cause and the exact line to ask the owner (`machine admin allow-file ...`).
- `machine admin allow-file <peer> --dir push|pull --root <dir> --ext log,txt --max-size 50MB [--overwrite replace] [--times|--for|--until]`; the signing summary prints direction, root, ext, size, overwrite, lifetime and two accepted and two refused examples BEFORE the passphrase.
- `machine allowed` shows transfer entries with their lifetime; `machine requests` and the Requests page list refused transfers with the Allow button (exact name and size only, `--times 1` by default, never a generalisation).
- `--wake` behaviour identical to `run`.

## Threats to add to the threat model (T-new)

| Threat | Control |
|---|---|
| Overwrite of a sensitive file | `root` containment by identity, config folder excluded, `overwrite: never` default |
| Symlink / junction swap between check and open | open then `fstat`, no-follow, realpath of the opened handle |
| Disk fill / decompression bomb | declared size, running byte count, free-space check, per-day quota; machine never decompresses |
| Executable or autostart drop | extension whitelist, no exec bit, signing warning when `root` is a startup, cron or PATH folder or an extension runs code (`sh ps1 bat cmd exe js py ...`) |
| Name tricks (ADS, reserved names, `..`, unicode) | name whitelist of characters, ASCII only, Windows rules of phase 2 `path` |
| Exfiltration by pull | pull entries exist only by admin signature, root-bound, never the config folder, audit of every read |
| Partial file taken as complete | part file hidden name, rename only after SHA-256 |
| Slow or stalled sender | idle timeout, concurrency cap |

## Phases (TDD: test first, see it fail)

| # | Content | Done when |
|---|---|---|
| 0 | spec file `file-transfer.md` in the spec folder, threat-model rows, hard rule 3 amendment, decision number | user confirmed rule 3 wording |
| 1 | `machine-core` pure: entry type, validator (name, ext, size, direction), policy v3 body, matching, lifetimes, quotas; shares the `path` type of typed-parameters phase 2 | table tests incl. hostile corpus, boundaries |
| 2 | `machine-core` engine with injected fs: part file, counting, hash, atomic rename, abort cleanup, pull open+fstat | real temp folders, symlink and FIFO cases (POSIX), junctions (Windows) |
| 3 | frames and `peerService` wiring, concurrency, audit, refusal texts | fake channel then real TLS test |
| 4 | CLI `send`, `get`, `admin allow-file`, `allowed`, `requests` | end-to-end on one machine with a fake relay; `npm run test:relay` |
| 5 | app-module: Requests Allow for transfers (browser signing), view of entries | checked with agent-browser on the real page |
| 6 | real targets: midgard2 to thinkcentre and back, big file, cut cable, wake first, Windows names | user-run outputs recorded |
| 7 | optional: resume, magic-byte check, sub-folders, sha-verified directory sync | separate decision |

## Decisions taken (reversible, recommended)

- Transfer entries are a separate kind, not a typed command (a typed command cannot stream or bound bytes).
- Flat folder, one file, no overwrite by default.
- Per-transfer human approval reuses `--times 1` plus the Allow button instead of a new prompt.
- No relay path for data, ever (direct channel only; a peer that is only reachable through the relay cannot transfer).

## To confirm by the user (security posture)

1. Hard rule 3 amended: "a peer request is a command entry OR a signed transfer entry".
2. Whether `pull` is wanted at all in phase 1 (reads from a machine are the exfiltration direction); recommendation: yes, root-bound and admin-signed only.
