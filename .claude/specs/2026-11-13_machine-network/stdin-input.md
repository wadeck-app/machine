# Input channel for `machine run` (decision 114, PROPOSED)

Status: proposal 2026-11-27, nothing built. Requested by the user through task-owner (a task project whose tasks live on another machine). Points marked D1-D5 wait for the owner.

## Need

A command that reads a JSON request on stdin (up to 64 KiB first, about 1 MiB wanted). Today a command is one printable-ASCII string of at most 2048 characters and the target runs it with stdin closed (`machine-exec/src/run.ts`, T-19).

## Rules

| # | Rule |
|---|---|
| R1 | Data is never command: the payload never reaches the command line, the environment, the shell or a log. It is written to the stdin pipe of the spawned process and nothing else. |
| R2 | The allow entry DECLARES the input. No declaration = no input accepted (today's behavior is the default). |
| R3 | The signed request carries the size and the SHA-256 of the payload. The target refuses a payload whose size or hash differs. A replay is already refused by the request id and times. |
| R4 | The audit log keeps size and hash, never content. |
| R5 | The command line stays ASCII. The payload is UTF-8 (accents in comments). |

## Declaration (proposed)

Policy entry gets an optional field `input`: `{ format: 'text' | 'json', maxBytes }`.

- CLI admin side: `machine admin allow <machine> --stdin json --stdin-max 64k -- "task remote-call <op:enum(get|add|comment)>"`. `--stdin` takes `text` or `json`; `--stdin-max` takes a size up to the protocol ceiling.
- CLI caller side: `machine run <machine> --stdin <file|-> -- <command>` (`-` reads the local stdin).
- Validation by format: `text` = valid UTF-8, no NUL; `json` = valid UTF-8, parses, nesting depth at most 32, no duplicate-key tricks beyond what `JSON.parse` does. A schema language is NOT proposed: the command validates its own fields (D3).

## Target checks, in this order

1. The entry matches the command (as today) and declares input; otherwise a payload is refused `input-not-allowed`.
2. Size at most the entry's `maxBytes` and at most the protocol ceiling; hash equals the signed one.
3. Format validation above.
4. Spawn with stdin as a pipe only when the entry declares input (else `ignore` as today); write the payload, end the stream; a command that does not read is not an error (EPIPE ignored).

## Wire

- The signed request body gets `input: { bytes, sha256 }`; the payload travels in a following `run-input` frame, so the signature stays small and the 1 MiB frame cap bounds the ceiling (proposed ceiling 512 KiB per call, first release entry max 64 KiB).
- A target without this feature refuses the request (unknown field) and a policy with `input` is refused by an older target (fail closed, never ignored). To verify in the parser before building.

## Held requests (D1, D2)

A held request keeps its payload in memory only (lost with the daemon, like the hold itself). Memory is bounded by the hold limits (5 per peer, 10 per machine) times the entry max.

- D1 (decided by the owner 2026-11-27): the approver SEES the payload; approving blind would be less safe. The payload of the held request is the example the declaration is built from: the Allow dialog and `machine requests` show it (escaped display, T-42: control characters and bidi marks made visible; first 4 KiB, then size and hash), the proposed character families are the smallest set that covers it, and the owner edits and signs.
- D2: the Allow dialog and `machine allowed` show the declaration (`stdin: json, letters+digits+space+json, up to 64 KiB`) next to the command.

## Allowed characters (owner request 2026-11-27)

The entry declares which characters the payload may contain, as a WHITELIST (never a list of forbidden characters) written as a union of families, so the owner reads at once what is validated. Same rule as the typed parameters: a character outside the union refuses the call (`input-chars`).

| Family | Characters |
|---|---|
| `letters` | Unicode letters and combining marks (accents included) |
| `digits` | 0-9 |
| `space` | space and line feed |
| `punct` | `. , : ! ? - _ ( )` only: nothing that quotes, escapes, separates commands or opens a path |
| Explicit characters (owner rule 2026-11-27: slashes and quotes are the usual trouble, each is named) | `slash` `/`, `backslash` `\`, `dquote` `"`, `squote` `'`, `backquote` `` ` ``, `semicolon` `;`, `ampersand` `&`, `pipe` `\|`, `dollar` `$`, `lt` `<`, `gt` `>`, `at` `@`, `hash` `#`, `percent` `%`, `star` `*`, `plus` `+`, `equal` `=`, `tilde` `~`, `caret` `^`, `brace-open` `{`, `brace-close` `}`, `bracket-open` `[`, `bracket-close` `]` |
| Meta families (exempt from naming each character) | `json`: implies the structure characters the format needs (`{ } [ ] " : , \ /`) AND the payload must parse as strict JSON; `xml` (not in the first release, D7): same idea with a hardened parser |

Syntax: `--stdin-chars letters+digits+space+punct+slash+dquote` or `--stdin-chars json+letters+digits+space`. Default when `--stdin` is given without `--stdin-chars`: refused (the owner must choose; no implicit set). The Allow dialog proposes the smallest union that covers the example payload and writes each explicit character by its name.

## No interpretation behind a meta family

A meta family adds a parse check, and the parse must never interpret or execute anything:

- `json`: strict `JSON.parse` of the UTF-8 text (no code evaluation by construction), nesting depth at most 32, duplicate keys refused (ambiguity between parsers), the payload is passed on byte for byte (never re-serialized). The key names `__proto__`, `constructor` and `prototype` are a hazard for a receiving JavaScript command: D8.
- `xml` (D7, not built in the first release): XXE and its relatives are refused by construction, with a hardened parser that has no DTD support: a `<!DOCTYPE`, an `<!ENTITY`, an external reference (SYSTEM / PUBLIC), an XInclude or a processing instruction refuses the payload; only elements, attributes, text and the five predefined entities are accepted (a whitelist of the XML subset, not a list of bad constructs). Needs its own parser or dependency review and its adversarial tests (billion laughs, external entity, parameter entity, XInclude, DOCTYPE with internal subset). Always refused whatever the union: NUL and the other control characters except line feed, unpaired surrogates, bidi controls. Shape only: whether the content is CORRECT stays the job of the receiving command (task-owner, 2026-11-27).

- D6 (open): the family list above (names and members), and whether `letters` covers all Unicode letters or a smaller set.

## Other requests of the same ask

| Item | Proposal |
|---|---|
| Revocation catch-up limit | Raise 6 to 30 per minute per peer (`MAX_CATCHUPS_PER_MINUTE`), shared with ping, keep the limit (flood guard, T-34). Reversible constant. |
| `run --json` shape | Pinned by a full-shape test (type, id, exitCode, stdout, stderr, timedOut, truncated, outputNotUtf8, decodedFrom, durationMs). |
| Output cap (1 MiB, 60 s) | D4: unchanged for now; task-owner paginates. A per-entry declared `maxOutput` and `timeout` is the later option. |
| Machine-readable "unreachable" | D5: a stable code in `--json` and a distinct exit code for refused vs unreachable; not requested yet, offered. |

## Threat deltas (to add to threat-model.md as T-69 when approved)

| Threat | Mitigation |
|---|---|
| Payload used as command injection | R1: pipe only, never interpolated; test that a payload with shell metacharacters and newlines reaches stdin byte for byte and never the argv/env |
| Memory or CPU exhaustion (large payloads, JSON bombs, held copies) | Size caps before parsing, depth cap, bounded hold memory, 30 frames per minute |
| Payload swapped between approval and run | Hash in the signed body, checked at run time |
| Content leak through logs or audit | Size and hash only; hash of a small low-entropy payload can be guessed by someone who reads the local audit (accepted, local file) |
| Old target ignoring the declaration | Refused (fail closed) |

## Test plan (TDD)

Entry parse and sign with and without `input`; refusal matrix (undeclared, too large, bad hash, invalid UTF-8, NUL, bad JSON, too deep); metacharacter payload byte-exact on stdin; command that never reads; held request keeps and releases the payload; audit has no content; old-target refusal; frame cap; `run --json` full shape.
