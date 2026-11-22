# Typed parameters in allow-list entries

**Status:** v0.3, 2026-11-21. PHASE 1 IMPLEMENTED (types `enum` `int` `duration` `name` `port` `hexid` `uuid`, grammar, policy v2, matching, lifetimes, front-ends of the CLI); phase 2 (`path` `host` `ref`) and the Allow modal lifetime choice are NOT built. Deviations and gaps of phase 1: "Implementation notes" at the end. v0.1 was attacked by two independent adversarial reviews; their findings are merged below (F1..F12, U1..U9 = review ids).
**User decisions (2026-11-21):** predefined types only (no free regex); special characters banned by default; ASCII only; heavy TDD; adversarial security analysis; entries permanent, N times, or time-limited.
**Evidence:** survey of the CLIs in Workspace_Tooling (read from source, nothing executed); code facts checked in `policy.ts`, `policyEdit.ts`, `peerService.ts`, `launch.ts`, `run.ts`. System-command facts come from general knowledge and are NOT verified on a target.

## Phasing

| Phase | Content | Why |
|---|---|---|
| 1 | Policy format v2, entry grammar, types `enum`, `int`, `duration`, `name`, `port`, `hexid`, `uuid`, lifetimes (`--times`, `--for`, `--until`), matching and counter fixes, audit and view changes | Pure functions, no I/O, fully testable |
| 2 | Types `path`, `host`, `ref` | Need filesystem, DNS or git semantics; verified on real targets first |

## Entry grammar

An entry is a shell plus a command text of space-separated tokens. A token is exactly one of:

| Token | Example | Rule |
|---|---|---|
| fixed word | `orch`, `--tail`, `-n` | written by the admin, charset `[A-Za-z0-9._/:@+-]`; never `%`; no `@` on a `ps` entry |
| placeholder | `<n:int(1,500)>` | the whole token |
| flag prefix + placeholder | `--tail=<n:int(1,500)>` | prefix is a fixed word ending in `=`, then one placeholder |

Parsing:
- Placeholders are parsed before splitting. Any entry that contains `<` or `>` must parse completely, otherwise it is refused at signing, at load and at match (F3). No malformed placeholder ever becomes an exact entry.
- Double, leading or trailing spaces make an empty token and are refused. Token counts must be equal (F8).
- The first token (program) and every flag are fixed words. A placeholder never stands for them. Enum members and any `root=` value pass the fixed-word charset and the value rules (F8).
- At most 8 placeholders and 2048 characters per entry text and per final command line.

Example entries:

```
orch logs <job:name> --tail <n:int(1,500)>
journalctl -u <u:enum(ssh.service|machine.service)> --lines=<n:int(1,500)> --no-pager
task show <id:hexid(8)> --json
```

## Value rules (every typed value)

| # | Rule |
|---|---|
| V1 | Printable ASCII 0x21 to 0x7E, length-bounded, one token. |
| V2 | WHITELIST ONLY (user decision 2026-11-21): each type below defines the exact set of characters it accepts, and any other character is refused. The code holds no list of forbidden characters; the dangerous characters (quotes, `$`, backtick, `\`, `;`, `\|`, `&`, `<`, `>`, brackets, `*`, `?`, `~`, `!`, `#`, `%`, `^`, `,`, `=`, whitespace, controls, NUL, non-ASCII) only appear in the hostile test corpus, to prove they are refused. |
| V3 | Never starts with `-`. Never starts with `/` or `\` on a Windows target, whatever the shell (F9). |
| V4 | Validation runs on the target in `machine-core`, on the exact string handed to the shell. No normalization, decoding or case-folding. |
| V5 | A reserved device name (`CON PRN AUX NUL COM1-9 LPT1-9`) is refused for `name` on a Windows target (F10). |

## Types

Each row is the whitelist: the value must match it entirely, otherwise it is refused.

| Type | Whitelist | Notes |
|---|---|---|
| `name(max=64)` | `[A-Za-z0-9_][A-Za-z0-9_-]*` | `name(dot)` also allows inner `.` (no leading, trailing or `..`). No `@` type. |
| `int(min,max)` | `0` or `[1-9][0-9]{0,9}` (characters `0-9` only) | `0 <= min <= max <= 2147483647`, bounds mandatory; no sign, leading zero, `0x`, exponent, non-ASCII digit (F11) |
| `enum(a\|b\|c)` | exactly one listed word; each member matches `[A-Za-z0-9._:@+-]+` and V3 | members checked at signing (F8) |
| `duration(min,max)` | `[1-9][0-9]{0,9}` + one of `s m h d` (characters `0-9 s m h d` only) | bounds in seconds, `min >= 1` (a `0s` can mean forever) |
| `port` | `int(1,65535)` | |
| `hexid(n)`, `uuid` | `[0-9a-f]{n}`, canonical lower-case uuid (characters `0-9 a-f -` only) | |

Phase 2 types, decisions already taken:

| Type | Decisions |
|---|---|
| `path(root=DIR, file\|dir)` | `root` mandatory and canonical. Values must be ABSOLUTE and inside `root` compared segment by segment, never as a string prefix (F4). Relative values are refused because the daemon runs commands in the user's home folder, not in `root` (F1, `run.ts:60`). Segments `[A-Za-z0-9._-]+`, no `.` or `..` or dot-only segment, no empty segment, no space, at most 260 chars. At run time: `realpath`, must stay inside the canonical `root`, regular file for `file` (no FIFO, socket, device, `/proc`) (F6), directory for `dir`, never inside the machine configuration folder (by identity). `root` must not be writable by another user (checked at signing, loud warning otherwise). Windows: per-segment rules, only one ASCII drive letter may carry `:`, no UNC, `\\?\`, `\\.\`, `~`, reserved names, trailing dot or space, dot-only segment (F10). |
| `host(in=...)` | Hostname labels `[a-z0-9-]` (an all-digit or `0x` label is refused) or canonical four-octet IPv4. Loopback and private refusal works on literals only; for names the `in=` list is the control, SSRF is otherwise NOT covered (F5). |
| `ref` | git ref charset and `check-ref-format` rules; only valid before a literal `--` (F12). |

Not in any version: free text, `url`, regex, `@`.

## Limits

Every input has a realistic maximum (user request 2026-11-21). A refusal names the limit and its value. Phase 1 tests each one at the boundary: maximum accepted, maximum + 1 refused, empty refused.

| Input | Limit | Where |
|---|---|---|
| command text (exact entry, request) | 2048 characters | `policy.ts` `MAX_COMMAND` (existing) |
| entries per list / peer lists / body | 200 / 64 / 512 KiB of JSON (524288 characters) | `policy.ts` |
| template (entry text) | 2048 characters, at most 8 placeholders, label 1 to 32 characters | `template.ts` |
| final command line built from a template | 2048 characters (computed from the maximum length of each type at signing) | `template.ts` |
| `name` | 64 characters; `max=` raises it to 128 at most | `typedParams.ts` |
| `int` | at most 10 digits, bounds inside 0..2147483647 | `typedParams.ts` |
| `duration` | at most 10 digits plus the unit, result at most 365 days (31536000 s) | `typedParams.ts` |
| `hexid(n)` / `uuid` | n at most 64 / exactly 36 characters | `typedParams.ts` |
| `enum` | at most 64 members of at most 64 characters | `typedParams.ts` |
| `--times` | 1 to 10000 | `lifetime.ts` |
| `--for`, `--until` | at most 365 days from the signing | `lifetime.ts` |
| frame / request lifetime / run timeout / output / concurrent runs | 1 MiB / 60 s / 60 s / 1 MiB / 4 | existing, unchanged |
| phase 2, document only | `path` 260 characters and 32 segments; `host` 253 with labels of 63; `ref` 100 | not built |

Not bounded by a check of this change: see "Implementation notes".

## Policy format

- Typed entries need body `v: 2` (field `template` instead of `command`). `nextPolicyBody` writes `v: 2` only when a typed entry exists, so exact-only policies stay `v: 1` and keep working on older targets (F2).
- An old target refuses a `v: 2` body loudly (`policy.ts:128` already throws "unsupported version"); the message adds `machine cli update`. A `v: 2` reader reads both.
- Duplicate detection compares the canonical form (type and bounds, not the label) (U8).

## Matching

- All entries of the list are tried; the first one that allows wins. An exhausted or expired entry no longer shadows a later one (change of `policy.ts:275`) (review 2, C).
- No match: the refusal keeps the same wording as today for the caller (generic `not-listed` plus the `otherShells` hint only for the exact command sent). It never carries a template, bound or label. The local audit log and `machine requests` carry the detail: the closest shape and which rule failed (character class and token index, never the whole value) (U6).
- Record the use BEFORE launching the command, so two concurrent requests cannot both pass at `maxCalls - 1`.
- The audit entry records which entry matched (its canonical template).

## Lifetimes

| Choice | CLI and Allow modal | Stored |
|---|---|---|
| permanent (default) | none | no limits |
| N calls | `--times N` | `maxCalls` |
| duration | `--for 2h` | `expiresAt` = signing time + duration |
| until a date | `--until 2026-12-01T18:00Z` | `expiresAt` |

Facts and decisions:
- Core already validates and enforces `limits`; no front-end sets them today (checked by grep).
- The counter file `usage.json` is persisted at each call and survives restarts; a corrupt file stops the daemon; deleting it resets every counter.
- The counter key is the entry text and limits, scope `default` or the peer uuid. The `default` scope is shared by ALL peers; a typed entry counts per entry, not per value.
- Seeding a per-peer list from the defaults (`policyEdit.ts:51`) copies ONLY the permanent entries (no `limits`). Entries with `maxCalls` or `expiresAt` are not copied, and the command says which ones were left out and that the peer loses them (user decision 2026-11-21). No counter is ever carried to another scope.
- Renewal: signing an entry that already exists with other limits replaces its limits and says "limits updated"; with the same limits it is `already-allowed`, unless `--renew` (or the Allow of a held renewal, hold-for-approval.md "Renewal") replaces it and bumps `limits.renewals`, which is part of the counter key, so the counter starts again. `--remove` takes the index or key shown by `machine allowed`; when several entries share a text it refuses and lists them.
- `expiresAt` uses the admin clock at signing and the target clock at check (`now > expiresAt`, no skew allowance); a running command is not stopped at expiry; a policy applied late still counts from signing.

## Front-ends

- `machine allowed` and the Requests page show the template exactly as signed, a tag "typed", and the lifetime (`3 of 5 calls left`, `until ...`).
- The Allow button on a refused request signs the EXACT refused string only. It never suggests a generalisation (a peer can send any printable text). A pattern is written by the owner in a separate explicit action with the summary below.
- Before the passphrase prompt, signing a typed entry prints: the template, the lifetime, two accepted and two refused examples produced by the same validator. These examples are a sanity check, not a safeguard.
- `admin allow` warns loudly (does not refuse) for programs and options a type cannot make safe (table below).

## What a type cannot make safe

Exact entries only, or not allow-listed.

| Case | Why |
|---|---|
| `npm run\|test\|install`, `git pull`, `docker compose -f`, `git -C` on a repo others can write | the clean value runs a script, hook, YAML or repo config |
| `git -c`, `--upload-pack`, `find -exec`, `tar --to-command`, `zip -TT`, `curl -o`, `wget -e`, `ssh -o`, `ethtool -f`, `ip netns exec`, `docker run\|exec`, `sudo <cmd>`, `node -e`, `npx` | an option or program that executes or writes |
| `orch add\|edit\|exec`, `queue sub add --command`, `flow worker source add --command`, `agent-browser eval` | a daemon stores and later runs a shell command |
| `machine run`, `machine admin allow`, `machine policy allow`, `machine join --yes-final-code` | relays, widens rights, pre-answers a security prompt |
| `--token`, `--invite`, `credentials <user> <pass>` | secrets on a command line end in the audit log |
| `task delete --all`, `queue dlq clear`, `orch stop --kill-jobs` | the damage is the missing parameter |
| `orch exec`, `agent-browser` (rewrite their own arguments) | the tool changes the validated value: fixed templates only |

## Test plan (TDD, adversarial)

1. One implementation per type in `packages/machine-core`; table tests per type: accepted, refused, boundaries, every character class of V2 and V3.
2. Parser tests: malformed placeholders (`<x`, `x>`, `<:int>`, `<a:b:c>`, `<a:int(1,2>`, `<n:int(5,1)>`), unknown type, double or trailing space, placeholder as program or flag, enum member `--x` or `a;b`, entry above 2048 characters, final command above 2048 (F3, F8).
3. Format tests: a `v: 1` reader refuses `v: 2` loudly; exact-only policy stays `v: 1`; a `v: 1` body containing `<...:...>` is refused by a `v: 2` reader (F2).
4. Hostile corpus from the desk study and the surveyed CLIs, run against every type (git `--upload-pack=`, `ext::`, ssh `-oProxyCommand=`, SSRF IP encodings, UNC and `\\?\`, ADS, reserved names, `../`, `"` and `$(...)`, `@file`, `-`, NUL, overlong UTF-8, fullwidth and bidi characters, huge, negative, `0x10`, Arabic-Indic digits).
5. Matching tests: first-allowed-wins, shadowing, label-only duplicates, counter shared across values and across peers, seeding reset, restart persistence, corrupt `usage.json`, limits change, renewal, `--remove` ambiguity, `expiresAt` boundary, concurrent requests at `maxCalls - 1` (record before launch).
6. Disclosure tests: caller-visible text is identical for "wrong type" and "no entry"; local audit detail names the rule; the audit entry names the matching template.
7. UI tests: Allow stays exact-only; the pattern action needs the passphrase and shows the summary; `machine allowed` shows templates and limits.
8. Property tests with a fixed seed and a small bounded count; the oracle is a deliberately simple independent reference matcher.
9. Phase 2: real temp folders with symlinks, FIFO (POSIX) and junctions (Windows); `/var/logs/x` and `/var/log-evil` against `root=/var/log`; same file name in home and `root`; `127.1`, `0x7f.1`, `2130706433`; `C:/logs/aux/x`, `C:/logs/x./y`, `Env:/PATH`; hard link (accepted gap or `nlink` check, decide).
10. End to end per shell (`cmd`, `ps`, `bash`, `sh`): sign an entry, run an accepted value, run a refused value, read the audit log.
11. Real-target check of the flag forms used in the 12 sample entries (`git -C`, `orch logs`, `journalctl --lines=`) before they appear in the docs.

## Implementation notes (phase 1, 2026-11-21)

Built: `packages/machine-core` `typedParams.ts` (types, whitelists), `template.ts` (grammar, match, canonical form, examples), `lifetime.ts` (`--times`, `--for`, `--until`), `policy.ts` (v2, `authorize`), `policyEdit.ts`; `machine-webcrypto` holds byte-identical copies of the three pure files (`typedCopies.test.ts` keeps them identical) and a ported `policyEdit.ts` and policy validator (equivalence tests extended to v2, limits, renewal, seeding, numbered removal); `machine-cli` `allowText.ts`, `allowSafety.ts`, `adminAllow.ts`, `policyLocal.ts`, `allowedView.ts`, `peerService.ts`.

Decisions taken while building (flag them to the user):
- A v2 body holds exact entries (`command`) and typed entries (`template`) side by side; an entry has exactly one of the two fields. A v1 body cannot hold `template`.
- A new exact entry whose text holds `<` or `>` is refused at signing (it must parse as a typed entry). A body already signed keeps loading when an exact command has plain angle brackets (a legacy redirection); it is refused only when the command has the `<...:...>` shape of a placeholder. Strict refusal of every legacy `<` or `>` at load was not done: it would turn an installed policy into a refused one.
- `--remove` of a text held under several shells no longer removes them all: it refuses and lists them with their number (`--index <n>` removes one, `--shell` narrows). This changes the behaviour of v1 policies too.
- A caller sees the same `not-listed` wording for a wrong value as for no entry; `expired` and `exhausted` keep naming the request and the limit of the entry that matched (a caller who sent a value that matches learns that a rule exists for it).
- The platform used for reserved device names is the one of the machine that runs the command (`deps.platform`, default the process platform); without it `authorize` answers strictly (`windows`). The examples printed before signing assume `windows` for `cmd`/`ps` and `posix` for `sh`/`bash`.
- A policy body is also bound by the 16 KiB document limit of the relay inbox (`MAX_DOCUMENT_BYTES`, existing): a body that passes the 512 KiB check but not 16 KiB cannot be distributed through the relay (`--out` and `policy install` have no such limit).

Test-plan items not done: 8 (property tests with an independent reference matcher; the policy edit has a seeded random equivalence test between core and webcrypto only), 9 (phase 2), 10 (end to end per shell with a typed entry: `peerService.test.ts` runs typed entries with a fake runner and the real shell only for an exact entry), 11 (real-target check of the flag forms: nothing was run on a target). UI test 7: the Allow button was not changed (still exact-only); the modal has no lifetime choice and no pattern action.

Not bounded by a check of this change (an attacker-controlled request can still reach them): the audit line carries the command (2048 characters) plus `detail`/`template` (a template is at most 2048 characters, a detail repeats it once); the `not-listed` refusal echoes the command (2048); the per-session refusal cap and the 4 concurrent runs bound the volume, not a single line.

Old builds: a target built before this change refuses a v2 policy with `unsupported version 2 (this build reads version 1)`, without the `machine cli update` hint (an installed build cannot be changed). The admin side prints an `[info]` line naming the update before the question when it signs a v2 policy; a build of this change names the update for a version it does not know.

## Lifetime choice in the Allow dialog (built 2026-11-21)

- The dialog of the Requests page (held requests, other machines, the refused list) offers `Once (1 call)`, `15 minutes`, `1 hour`, `1 day`, `Permanent`, `Custom` (a number of calls 1..10000, or a duration `<digits>s|m|h|d` up to 365 days). Default: Once for a held request, Permanent for the refused list.
- The choice is a `LifetimeInput` (`--times` / `--for` flags) parsed at signing time by the byte-identical copy of `lifetime.ts` in machine-webcrypto: the signed entry equals what `machine admin allow --times/--for` writes (`allowFlow.test.ts` compares with machine-core). A duration counts from the signature.
- The summary shown before the passphrase has a `Lifetime` row: `allowed once`, `allowed N times`, `until 22:45 (in 15 min)`, `permanent, until you remove it`. An invalid custom value shows a message and signs nothing; the typed passphrase stays.
- NOT built: showing the lifetime of existing entries in the page.
