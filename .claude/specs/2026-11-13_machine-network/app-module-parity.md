# App-module parity with the CLI

**Status:** audit + plan, 2026-11-20. Requirement (user): everything the CLI does must be doable in the app-module, and the module is kept up to date with each new CLI feature. Facts read from code (cli.ts, cliHelp.ts, commands.ts, packages/app-module-machine, dsl-lib-machine, machine-webcrypto, app-core-sdk `module-authoring.md` "Sensitive routes", app-core-cli `pin.md`); nothing run. "Not verified" marks what was not read or run.

## 1. Facts that bound the design

- Module today: 4 backend routes, all GET: `/health`, `/status` (daemon `status`), `/machines` (daemon `list`), `/candidacies` (relay, admin token). 2 pages: Machines, Candidacies (read-only, no buttons). `/status` has no page.
- The daemon local API has only 6 commands: `status`, `list`, `resolve`, `aliasList`, `aliasSet`, `aliasRemove` (+ `quit`). Policy, connections, audit, startup, update state are not behind it: the CLI reads files or runs code from `machine-cli` that is not exported (candidacies.ts already copies logic "keep in step").
- Browser reaches only `/api/modules/machine/...` (CSP `connect-src 'self'`, admin-ui.md). Relay, daemon, files, orch: backend only.
- Signing pieces exist but are wired to nothing: `PassphraseSigner` (unlock + sign a registration), `machine-webcrypto` (`unlockAdminKey`, `signRegistration`, `signPolicy`, `signRevocation`, `buildDocument`, `derivePairSecretFromSignature`, `sealTo`, `candidacyCode`, `finalCode`). No backend route serves the encrypted admin key file (`keyFileUrl` has no server): grep of `src/backend` finds none.
- machine-webcrypto has no `LOCAL_POLICY_DOMAIN` (machine-core `policy.ts`) signing: policy mode local cannot be signed in the browser yet.
- Sensitive routes (app-core 209): `registerRoute(m, p, h, { effect: 'sensitive' })`; 403 `pin-not-set`, 401 `elevation-required`; component side `elevate()` / `appFetcher` from `@wadeck-app/app-core-sdk/shell`. Access token 10 min in localStorage, PIN asked about once per 7 idle days, `write` effect not gated, `/api/modules/register` not gated (pin.md).
- `requests`: `machine-core/src/requests.test.ts` exists, `requests.ts` and any CLI wiring were not present when read (another agent is writing them). Not verified.
- No `machine audit` CLI command found; `verifyAuditChain` exists in machine-core.

## 2. Parity matrix

Module today: Full / Partial / None. "Browser" = feasible at all; "B" means via the backend only, "S" means the browser signs. "Sens." = needs a `sensitive` route.

| # | CLI | What it does | Module today | Browser | Sens. | WP | Size / deps |
|---|---|---|---|---|---|---|---|
| 1 | `setup` | first machine: identity, admin key, relay login, self-approve, enroll | None | No (creates secrets, interactive, bootstraps the module itself) | - | CLI only | - |
| 2 | `join` | candidate side of enrollment | None | No (machine not enrolled yet) | - | CLI only | - |
| 3 | `init` | identity + identity key | None | No | - | CLI only | - |
| 4 | `status` | identity, enrollment, policy version + mode, revocations, peersBehind, problems, daemon state | Partial: `GET /status`, no page; no startup/daemon-state block | B | no | P1.1 | S |
| 5 | `list`, `peer` bare | self + peers, aliases, relay presence + addresses, revocation version seen | Partial: Machines page shows name/role/aliases/uuid; page says presence/addresses missing | B | no | P1.2 | M; needs `addRelayView` exported or moved to core |
| 6 | `resolve` | reference to uuid | None | B | no | none (the page already shows aliases) | - |
| 7 | `alias list` | aliases | Full (Aliases column) | B | no | - | - |
| 8 | `alias set` / `rm` | local labels; a label decides where `run <alias>` goes | None; daemon commands exist | B | yes (retargets `run`) | P2.8 | S |
| 9 | `ping` (no machine) | relay path, token level, daemon, address record | Partial: `/health` has the same family of checks, different list, no page | B | no | P1.9 | S |
| 10 | `ping <machine>` | real channel to a peer | None | B (needs identity key + peer channel; code not exported: not verified) | no | P3.4 | M |
| 11 | `run` | run an allowed command on a peer | None | B | yes, and fresh confirm | P3.5 | L; decision 5 |
| 12 | `wake-info` | checklist to prepare a target | None | B | no | P1.6 | S |
| 13 | `stop` | quit the daemon | None | B (`quit` exists) but kills the backend's own peer | yes | P3.6 | S; probably not offered |
| 14 | `daemon` | run the daemon | None | No (the page needs it running) | - | CLI / startup only | - |
| 15 | `admin`, `admin approve` (list) | pending candidacies | Full (Candidacies page, binding warning, problems, no code by decision 55) | B | no | - | - |
| 16 | `admin approve <id>` | review, y/N, passphrase, sign, post decision, distribute, security code | None | S + B: `PassphraseSigner` + `finalCode` + `buildDocument` exist; missing key-file route, decision post, document put, wiring | yes + passphrase | P2.1 | L; dep P2.0 |
| 17 | `admin approve --reject` | refuse a candidacy (no passphrase) | None | B (admin token) | yes | P2.1 | S after P2.0 |
| 18 | `admin revoke` | sign revocation, distribute | None | S + B (`signRevocation`) | yes + passphrase | P2.3 | M; dep P2.0 |
| 19 | `admin allow` add / `--remove` | sign a policy with one command more or less | None | S + B (`signPolicy`, `commandTextProblem`); needs current record `policies/<uuid>.json` for the base version | yes + passphrase | P2.2 | L; dep P1.3, P2.0 |
| 20 | `admin allow --list` | what is allowed on a machine | None | B | no | P1.3 | M |
| 21 | `admin distribute` | resend approval / revocation / policy documents | None | S + B (pair secret needs an admin signature: key unlocked) | yes + passphrase | P2.4 | M; dep P2.0 |
| 22 | `admin forget-relay-record` | delete a machine record on the relay (admin token, no passphrase) | None | B | yes | P3.1 | S |
| 23 | `admin init` | create the admin key | None | No in practice: webcrypto only unlocks, no key creation; bootstrap | - | CLI only | - |
| 24 | `admin login` | device login to get the relay admin token (writes `relay-admin.json`) | None | B (relay console confirmation is out of band) | yes | P3.2 | M |
| 25 | `admin pin` / `register` / `sign-policy`, `peer info` / `import`, `policy install` | file mode (no relay) | None | Not meaningful (files on disk, no relay) | - | CLI only | - |
| 26 | `peer connect` (set / `--show` / `--remove`) | pinned addresses, Wake-on-LAN settings (`connections.json`) | None | B | yes (pinned address redirects commands) | P1.6 (show), P2.5 (set) | M; no daemon command exists |
| 27 | `wake` | send magic packets, wait for the peer | None | B (UDP from the backend process, same host as the CLI) | yes | P2.5 | M; dep `wakeSender` export |
| 28 | `peer forget-record` | reset the highest address record of a peer | None | B | yes (anti-rollback state) | P2.8 | S |
| 29 | `startup status` | orch job state | None | B (spawns/reads orch: not verified how) | no | P1.7 | M |
| 30 | `startup enable` / `disable` | create/remove the login job; disable ends the daemon | None | B | yes (disable kills the backend's daemon) | P2.6 | M |
| 31 | `cli version` | installed vs latest | Partial: `/status` carries the daemon version only | B | no | P1.8 | M |
| 32 | `cli update` / `rollback` | install a published version (T-23 channel) | None | B | yes + fresh confirm | P3.3 | M |
| 33 | `cli logs` | updater + daemon log of today | None | B (read) | no | P1.8 | S |
| 34 | `cli self-check` | install checks, exit 1 on failure | Partial: `/health` is another list, no page | B | no | P1.8 | S |
| 35 | `cli register`, `cli post-update` | register the module; updater hook | None | n/a (the module is already registered if it is seen; hook is internal) | - | CLI only | - |
| 36 | `policy` bare / `policy allow --list` / `status` mode | mode and local allow list | Partial: mode is in `/status`, no page, list not exposed | B | no | P1.3 | M |
| 37 | `policy local enable` / `delegate` / `policy allow` (mode local) | machine signs its own list with a local key + local passphrase | None | S + B but webcrypto lacks the local domain and no key-file route | yes + local passphrase | P2.7 | L; dep webcrypto extension |
| 38 | `requests` (being built) | pending refused requests, history, derived from the audit log | None (other agent) | B | no (one-click "allow" later uses #19) | P1.4 | agent in progress |
| 39 | audit history (spec admin-ui "Audit", no CLI command) | list + verify hash chain | None | B | no | P1.5 | M |
| 40 | `--json`, `--config-dir`, prompts | output and prompt plumbing | n/a | n/a | - | - | - |

Counts over 39 functional rows (excluding #40): Full 2 (#7, #15), Partial 6 (#4, #5, #9, #31, #34, #36), None 31. Of the 31 None: 9 are CLI-only by nature (#1, #2, #3, #14, #23, #25, #35 and #6 by redundancy, #13 by recommendation), leaving 22 to build.

## 3. Security design for the write side

**Where the key lives.** Encrypted admin key file stays in `_secrets_/` (PBKDF2-HMAC-SHA256 >= 600k + AES-256-GCM). A new read route serves that encrypted file (the file is readable by any same-user process anyway, AR-7). Unlock happens in the page: `unlockAdminKey` returns a NON-EXTRACTABLE `CryptoKey` held in a closure; the passphrase is read from the input at submit and cleared. The backend never sees the key or passphrase, only signed documents. Backend rule per write route: validate shape, verify the signature against the pinned admin public key (machine-core), check base version and target, then spend the relay token. The daemon still checks everything itself (hard rule 4), so a bad backend cannot widen rights; it can only spend the relay token.

**Remember the passphrase (module only).**
- Recommendation: do not keep the passphrase string (JavaScript cannot wipe it). "Remember" means keep the unlocked non-extractable `CryptoKey`, which already is the `unlockSeconds` design, but make it survive page navigation (today `PassphraseSigner` locks on unmount): a module-scope store in dsl-lib-machine.
- Memory only: never `localStorage`, `sessionStorage`, IndexedDB, URL, `$setVar`, `$publishOutput`. A reload or tab close locks.
- Idle timeout (default 10 min, reset by each signature, absolute cap 60 min) and a "Lock now" button visible on every module page. The CLI keeps asking every time (T-38 "nothing cached"); no cache on that side.
- Signing only from a user click handler, never on load, poll or `$actions` side effect.

**What T-13 / T-14 say.** T-13: other modules share the origin and can read the DOM; accepted (AR-2), CSP stops exfiltration to other sites; the page shows a blocking notice when `APP_CORE_CSP=off`. T-14: a local process can register a fake module through unauthenticated `/api/modules/register` and capture the passphrase; the daemon still needs a valid signature, but passphrase + readable key file suffice. Consequence of "remember": the exposure window grows from one click to the idle timeout. Inference, not tested: a same-origin script that wraps `crypto.subtle.sign` before unlock could sign with the unlocked key during that window; that is why the window is bounded and why sections below require a fresh confirmation for the dangerous actions. The PIN does not help against T-14 (a trojan module is already behind the user's PIN session).

**Two gates, two jobs.**
1. Sensitive route (PIN elevation): stops a local process or script that calls the backend directly (app-core checks only Host/Origin otherwise). Frequency is low (token 10 min, refresh 7 days sliding), so it is not a per-action confirmation.
2. Passphrase signature: stops anyone without the key from producing a document the daemons accept.
Order in the page: `elevate()` first (before showing the unlock form), then unlock, then sign, then POST the signed document to the sensitive route. Actions without a signature (reject, alias, forget-record, startup, connect, update) are gated by the PIN only: they are all `sensitive`. The GET routes stay plain (the DSL `$sources` cannot send headers). Add the existing `x-machine-module` header on write routes via `appFetcher` extra headers (not authentication, only a stray-request filter).

**Fresh confirmation each time (never covered by a remembered unlock or the PIN session).** A modal that names the exact effect, with Cancel as default focus:
- Approve a machine: name, hostname, uuid, observed IP, rebind warning; plus a fresh passphrase entry (root of trust, T-05, T-36).
- Widen a policy (add an allowed command): machine, shell, exact command text, resulting version.
- Revoke: machine name + uuid, "tell the other machines".
- Also confirm each time (no signature): `cli update`/`rollback` (T-23), `run`, `startup disable`, `stop`.
Remembered unlock may cover without the modal: remove an allow entry, retry a distribution, alias changes.

## 4. Phased plan

Each package: tests through the real app-core harness (`backend.realServer.integration.test.ts` pattern: packaged with `app-core-cli package`, served by app-core's own server, daemon and relay faked; a PIN must be set in the harness config dir for sensitive routes, how the harness sets it is not verified) plus an agent-browser check on the real page (the user's rule: variants wired into the normal page, verified with agent-browser on `/`, not a demo route; the A/B switcher applies if a package offers two layouts).

**Prerequisite P0 (S).** Decision 2 (daemon commands vs backend file copies). Parity guard test: assert that every subcommand of `cliHelp.ts` `GROUPS` and the top-level commands appears in a parity map (module route/page or `CLI only` with a reason); a new CLI command without an entry fails the build. This enforces "keep the module up to date". No UI.

### Phase 1: read parity (no write route, no PIN)
| WP | Content | Size | Acceptance |
|---|---|---|---|
| P1.1 Status page | status incl. daemon state, policy mode + version, revocations, peersBehind, problems | S | real server: `/status` answers; agent-browser: page shows each block and a 503 explains "daemon not running" with the fix |
| P1.2 Machines | presence, addresses, revocation version seen, policy mode of self | M | fake relay presence online/offline; agent-browser: columns match `machine list` for the same config dir |
| P1.3 Policy per machine | allow list, version, mode (self from the daemon, peers from `policies/<uuid>.json` on the admin machine) | M | route with a signed record and with a tampered one (shows the problem); page lists entries |
| P1.4 Requests | the other agent's work | - | follows its own acceptance |
| P1.5 Audit | history + hash-chain verification result, paging | M | broken chain shows a loud failure with the line; large log paged |
| P1.6 Wake / connect view + wake-info | `peer connect --show`, wake-info checklist | S | page equals CLI `--show` output |
| P1.7 Startup status | job exists, command, up to date | M | stopped/absent/up-to-date cases |
| P1.8 Updates | installed vs latest, last update result, logs tail, self-check | M | fake update state files |
| P1.9 Ping view | relay path steps of `ping` | S | reuse the `/health` checks, align wording with the CLI |

### Phase 2: write parity (sensitive routes, signing in the page)
| WP | Content | Size | Acceptance |
|---|---|---|---|
| P2.0 Foundation | key-file GET route, module-scope unlock store (remember, idle, lock button), confirmation modal component, `elevate()` wiring, backend signature verification, relay document put | L | no PIN -> 403 `pin-not-set`; no token -> 401; valid signature passes, forged or stale base version refused; passphrase and key absent from every request body and log (grep test); lock button and idle expiry wipe the key (jsdom fake timers) |
| P2.1 Approve / reject | wire PassphraseSigner, final code display, timeline statuses, distribution | L | cross-check: document signed by the page verifies in machine-core and is accepted by a real daemon test peer; reject needs no passphrase; agent-browser full flow on `/candidacies` |
| P2.2 Allow / remove entry | add/remove with base version, "allow" shortcut from Requests rows | L | version compare-and-set conflict surfaced; `commandTextProblem` errors shown. **Status 2026-11-21 (decision 76): Allow built** on the Requests rows, verified in a real browser on an isolated app-core. Remove: signing code, daemon and route support it, no UI (no Policy page, P1.3). Mode local: not built, the row points to `machine policy allow`. Not built: Reject, Revoke, Approve candidacy, Distribute |
| P2.0 (part built) | Foundation | | Built for Allow only: key file route (sensitive, encrypted file only), `sensitive` routes with the module header, `ConfirmSignModal`, daemon commands `adminKeyFile`, `allowContext`, `submitPolicy`, `nextPolicyBody` copy in machine-webcrypto. NOT built: remembered unlock store, lock button, idle timeout (the passphrase is used for one signature and the key is locked right after) |
| P2.3 Revoke | sign, distribute | M | revoked machine disappears; distribution failure shown with retry |
| P2.4 Distribute | retry | M | idempotent resend |
| P2.5 Wake now + peer connect | set/remove pinned addresses and MAC, wake with steps | M | `connections.json` equals the CLI result byte for byte |
| P2.6 Startup enable/disable | via orch | M | disable ends the daemon and the page says so |
| P2.7 Policy mode local | enable / allow / delegate; needs `LOCAL_POLICY_DOMAIN` in machine-webcrypto with cross-vectors, local key-file route, a second passphrase prompt with its hint | L | webcrypto vs machine-core vectors; daemon refuses an admin-signed doc in mode local |
| P2.8 Alias set/rm, forget-record | | S | CLI and page agree |

### Phase 3: admin extras
P3.1 forget-relay-record (S), P3.2 admin login device flow (M), P3.3 `cli update` / `rollback` (M, fresh confirm), P3.4 ping a machine (M), P3.5 `run` (L, decision 5), P3.6 `stop` (S, likely not offered). CLI only, by recommendation: setup, join, init, daemon, admin init, file-mode commands, cli register/post-update.

**Proposed order:** P0, P1.1, P1.2, P1.3, P1.5 (with P1.4 when landed), P1.6-P1.9, then P2.0, P2.1 (approve is the user's first write need), P2.3, P2.2, P2.4-P2.8, then phase 3.

## 5. Decisions for the user

1. Remember the unlock: keep the non-extractable key (not the passphrase string) for 10 min idle, 60 min cap, lock button. Recommendation: yes, with the exceptions of section 3.
2. Where the shared logic lives for new read/write routes: new daemon commands over machine-core (single source, but pages need the daemon up) or copies in the module like `candidacies.ts`. Recommendation: daemon commands, no more copies.
3. Should phase 1 ship before any write? Recommendation: yes, it is safe (no PIN, no signing) and gives the audit/requests visibility first.
4. Policy mode local in the browser (second key, second passphrase, webcrypto extension): Recommendation: keep it last of phase 2, behind P2.7 only if you use mode local on the machine running the page.
5. Should the page offer `run` and `cli update`/`rollback` (remote execution and the T-23 channel)? Recommendation: update/rollback yes with a fresh confirm; `run` no (CLI only) until a real need appears.
