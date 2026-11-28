# Input channel for `machine run` (decision 114, ACCEPTED, first slice built)

Status: accepted by the owner 2026-11-28. Built: core, executor, daemon, CLI (`--stdin` on `run`, `--stdin/--stdin-max/--stdin-chars` on `admin allow` and `policy allow`), `run --json` outcome documents. NOT built (out of scope of the first release): the Allow dialog, the badges of the Permissions page, the `machine-webcrypto` policy builders (the browser copy only READS version 3 bodies), xml, a per-entry output cap. Requested by task-owner. Points marked "decided 2026-11-28" were ambiguous in the proposal and chosen by the simplest consistent reading.

## Need

A command that reads a JSON request on stdin. Before: a command is one printable-ASCII string of at most 2048 characters and runs with stdin closed (`machine-exec/src/run.ts`, T-19).

## Rules

| # | Rule |
|---|---|
| R1 | Data is never command: the payload never reaches the command line, the environment, the shell or a log. It is written to the stdin pipe of the spawned process and nothing else. |
| R2 | The allow entry DECLARES the input. No declaration = no input accepted. |
| R3 | The signed request carries the size and the SHA-256 of the payload; the target refuses a payload whose size or hash differs. |
| R4 | The audit log keeps size and hash, never content. |
| R5 | The command line stays ASCII. The payload is UTF-8. |

## Declaration

Entry field `input: { format: 'text' | 'json', maxBytes, chars }`, in a new body version (decided 2026-11-28: **version 3**; the detached-job `detach` of `detached-jobs.md` also named version 3, it is not built, it will have to share or move to 4). An older reader refuses version 3 by name (`unsupported version 3 ... machine cli update`); a version 1 or 2 body holding `input` is refused too. `machine admin allow` and `machine policy allow` build version 3 only when an entry declares an input, and the version goes back down when the last such entry is removed.

- Admin side: `machine admin allow <machine> --stdin json --stdin-max 64k --stdin-chars letters+digits+space -- "task remote-call"`. `--stdin` takes `text` or `json`; `--stdin-max` takes `<n>k` (KiB) or bytes, default 64k, at most 512k; `--stdin-chars` is mandatory (no implicit set).
- Caller side: `machine run <machine> --stdin <file|-> -- <command>` (`-` reads the local stdin; a terminal is refused with the fix). Works with `--json --no-wait --no-wake --shell`. Listed in the `run <machine>` entry of `machine --help` (feature detection reads it).
- Allowing the same command again with another declaration REPLACES the entry (the declaration is what it authorizes; shown as `limits updated`), the same declaration is "already allowed".
- Shown wherever an entry is shown (`machine allowed`, `--list`, the signing summary of `sign-policy`): `[stdin: json, letters+digits+space+json, up to 64 KiB]`. Before the passphrase `admin allow` prints what the payload may be and the warnings below.

## Characters: a whitelist union

Families, canonical order (a signed declaration must list them in this order): `letters` (Unicode letters and combining marks), `digits` (0-9), `space` (space and line feed), `punct` (`. , : ! ? - _ ( )`), the explicit characters `slash backslash dquote squote backquote semicolon ampersand pipe dollar lt gt at hash percent star plus equal tilde caret brace-open brace-close bracket-open bracket-close`, `json` (`{ } [ ] " : , \ /`), `utf8-text`.

- `utf8-text` (decided 2026-11-28; `text` was not used because `--stdin text` is a format): every character except the always-refused ones, i.e. accents, punctuation, spaces and line feeds in strings. It stands alone, or with `json` (a union that reads narrower than it is, such as `utf8-text+digits`, is refused). It is named in `machine admin allow --help` and in the refusal of a character. `admin allow` warns that it is safe only because the payload goes to stdin and nowhere else.
- `json` belongs to `--stdin json`: it is added when not typed (said with an `[info]`, the signed entry always lists it) and `--stdin text` with `json` is refused (decided 2026-11-28).
- Always refused whatever the union: NUL and every other control character except the line feed (**tab and carriage return are refused too**: pretty-printed JSON must use spaces and LF), bidirectional controls, bytes that are not UTF-8 (unpaired surrogates included). A BOM is a character like another.
- `xml` is not built; `--stdin-chars xml` says so.

## Validation by format

- `text`: UTF-8 and the union.
- `json` (decided 2026-11-28: well-formed only, no business validation): strict `JSON.parse` of the UTF-8 text, passed on byte for byte, nesting at most 32, a duplicate key refused, and a key `__proto__`, `constructor` or `prototype` at any depth refused, escapes included (D7/D8). Depth, duplicates and keys are found by a scan that never builds the value, before `JSON.parse`.

## Target checks, in this order

1. The signed body and the frame agree: a signed input needs a payload and the reverse, the payload is canonical base64, its size and SHA-256 equal the signed ones (otherwise `input-format`: swapped or altered). Done before the policy, so a held payload is the signed one.
2. The command matches an entry (as before; otherwise `not-listed`, held when the caller waits). If that entry declares no input: `input-not-allowed`.
3. Size at most the entry's `maxBytes` (`input-too-large`, the message names the maximum), UTF-8, the union (`input-chars`: code point and position, never the character), then the format (`input-format`).
4. Audit `accepted` with `input: {bytes, sha256}`, then spawn with a stdin pipe only when the entry declares an input; write the payload and end the stream. A command that does not read is not an error (EPIPE, and EOF on Windows, are ignored). A request with no payload on an entry that declares an input runs with an empty stdin. A refusal does not count a call.

## Wire

Decided 2026-11-28: the payload travels in the SAME `run` frame as a base64 string (`input`), not in a following `run-input` frame (no target state between two frames, nothing to chunk). The signed body gets `input: {bytes, sha256}`. Checked, not assumed: 512 KiB is 683 KiB in base64 and crosses the real mutual TLS channel in one frame under the 1 MiB cap (`inputFrame.test.ts`), so the ceiling stays 512 KiB. A target without the feature refuses the 10 or 11 keys body as `malformed` (fail closed): the caller says `target-too-old`.

## Held requests (D1, D2)

A held request keeps the payload in the memory of the daemon only (the hold table, gone with the hold, with a Deny, at the deadline and at a restart). The audit line `held` carries size and hash. `machine requests` on the machine that holds it asks the daemon for the payload and shows it escaped (control characters and bidi marks as `\uXXXX`, first 4 KiB, then a cut marker), with size, first 16 hex of the hash, and the smallest declaration that covers it as flags to add to the allow command (`--stdin json --stdin-chars letters+digits+space`: a proposal, the owner edits and signs). Without the daemon the row says the payload is kept in the daemon memory. The Allow dialog and the Permissions badges (D2, `parsed` / `pattern`) are the deferred browser part. An Allow that lists the command without a declaration refuses the held payload (`input-not-allowed`) and drops it.

## `machine run --json`: one document for every outcome (D5)

Exit codes are unchanged (the remote code, 255 for a failure of machine, 2 for a command line that does not parse). Every outcome prints exactly one JSON document on stdout, the human text stays on stderr. Full table and pinned shape: `run-log.md`, "`machine run --json` shape". Codes, stable and never renamed: `ok`, `refused:not-allowed`, `refused:input-not-allowed`, `refused:input-too-large`, `refused:input-chars`, `refused:input-format`, `refused:other`, `unreachable`, `timeout`, `denied`, `target-too-old`, `unknown-machine`, `usage`, `failed`. `refused:other` and `failed` were added (decided 2026-11-28) so that no outcome is left without a code.

## Unchanged

Output cap 1 MiB and 60 s per command (D4). Revocation catch-up limit 30 per minute. Frame limits.

## Not verified

On a real network and on real targets other than the test host: PowerShell and macOS targets, a command that reads a large stdin slowly, the machine-webcrypto reading of version 3 in a real browser. The 512 KiB frame was crossed on loopback only.

## Test plan (done, in this order)

Entry parse and sign with and without `input` (`policyInput.test.ts`); declaration and payload matrix (`inputDeclaration.test.ts`, `stdinInput.test.ts`); executor stdin, byte-exact, never reads (`runStdin.test.ts` of machine-exec); target checks, audit without content, hash swap, held payload (`peerServiceInput.test.ts`, `holdInput.test.ts`, `holdInputE2e.test.ts`); old target (`target-too-old`, `runOutcome.test.ts`); frame cap (`inputFrame.test.ts`); `run --json` full shape and every code (`runStdinCli.test.ts`, `runJsonShape.test.ts`).
