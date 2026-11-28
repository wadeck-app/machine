# Admin UI (WP8): app-module-machine and dsl-lib-machine

**Version:** v0.1 draft (2026-11-14). Facts from app-core-owner and dsl-owner (read from their repos, partly unverified as marked). Implements decisions 18, 19, 36, 40, 50.

The page only UNLOCKS the admin key: it applies no length rule to the passphrase (the rule of decision 51, 12 characters minimum, is enforced where the key is created, `machine admin init` and `machine setup`).

## Facts that shape the design

| Topic | Fact | Source |
|---|---|---|
| Module layout | `packages/app-module-machine`: `manifest.json`, `src/backend/index.ts` (routes under `/api/modules/machine/...`, `ctx.dataDir`), `src/dsl-views/*.yaml`, `src/dsl-components/` (dsl-lib, loaded into the shell, same origin), `src/commons` (shared with the browser, no `node:` imports, enforced by `app-core-cli check`) | app-core `module-authoring.md` |
| Commands | `app-core-cli init ./app-module-machine --id machine --title "Machine"`, `check .`, `dev . --watch`, `BUNDLE_VERSION=<v> app-core-cli package .`, `npm publish` (ships `dist-module` only) | app-core-owner |
| Siblings to copy | `queue/packages/app-module-queue`, `orchestrator/packages/app-module-orchestrator` (+ `dsl-lib-orch`), reference `app-core/packages/test-app-modules/app-module-example` | app-core-owner |
| Browser to relay | impossible: CSP `connect-src 'self'`; the relay admin token stays server side, in the module backend (reads `_secrets_/relay-admin.json`), the page calls only `/api/modules/machine/...` | app-core-owner |
| Browser to daemon | impossible for the same reason; the backend calls the machine daemon on 127.0.0.1 (port from `daemon.port.json`, read at each request); auth of that call is ours | app-core-owner |
| app-core API auth | none: only Host and Origin checks; any local process can call a module route as the user, so a route that spends the token or signs is a risk (keep routes read-only or add our own check) | app-core-owner |
| WebCrypto | Ed25519, X25519, P-256 work in Chrome 156 on localhost (secure context); PBKDF2, HKDF, AES-GCM everywhere; other browsers not verified; no WASM (CSP has no `wasm-unsafe-eval`) | app-core-owner |
| Components | no timeline in dsl-view (Stepper is a horizontal wizard); `Tooltip` wraps one element with string content; domain components stay in `dsl-lib-machine`; a generic vertical timeline is built first in `dsl-lib-machine` tagged `@dsl-view-candidate status: incubating` | dsl-owner |
| Secrets in components | only in component `useState`/`useRef`; never `$setVar`, `$publishOutput`, `@registryBind formData`, a URL parameter or an Error message | dsl-owner |

## Decisions (reversible, logged D25 and D26)

- **D25 Signing happens in the browser**, key held as a non-extractable `CryptoKey` after unlock, bounded by the unlock timer, wiped on lock or tab close. Reason: a server-side key would sit in the process shared with every other module backend and any local process could request signatures through our route. Residual risk for the threat model: other modules' components share the origin and could patch `crypto.subtle` or read the DOM (decision 19 accepts it).
- **D26 One interface, two implementations**: the browser needs a WebCrypto implementation of the machine-core operations it uses (admin key file unlock, canonical JSON, Ed25519 signing of registrations, documents, policies, revocations, HKDF, X25519 sealing with the Ed25519-to-X25519 public key conversion). It lives in its own package `machine-webcrypto` (no `node:` imports), tested against the Node implementation with fixed vectors and with cross-verification both ways.

## Open design point: pair secret derivation and non-extractable keys

`derivePairSecret` keys HKDF with the admin seed, which needs the raw seed in page memory. A non-extractable key cannot do that. Option: derive the pair secret from a deterministic Ed25519 signature over a domain-separated string with both uuids and serials (Ed25519 is deterministic and unforgeable without the key, so it is a keyed PRF), then HKDF of that. Same property (any admin machine recomputes the same secret, retries are idempotent), no raw seed in the page. Changing it is free until the first real enrollment. To decide with the browser implementation.

## Pages (decision 40) and what each needs

| Page | Source of data | Actions |
|---|---|---|
| Machines | backend route to the daemon (`list`, presence, addresses, aliases) | alias set and remove |
| Candidacies | backend route to the relay (admin token): list with `uuidBound` warning | reject (built: row action, PIN, no signature); approve (built, lots 1-6: dialog, passphrase at each approval, signature in the page, decision and documents through the backend), see "Approve from the page" |
| Requests (decisions 73, 74) | daemon command `requests` (audit log of this machine, same reader as `machine requests`) | read-only: pending (exact command to allow), history, chain state. The remote section needs a browser-signed `requests-list` document posted to `POST /requests/remote` (route built, sensitive); the signing component is not built |
| Allowed (decision 104) | daemon command `allowed`: the policy installed here with its call counters, the policies signed here for the others (the readers of `machine allowed`) | read-only: per machine version, mode, when signed, entries by shell with lifetime, text and machine filters, `N entries on M machines`; edit and remove are part 2 (needs a signature design) |
| Policy | local policy files through the daemon | edit allowlists and limits, sign in the page, install and distribute |
| Audit | daemon audit log | view and verify the hash chain |
| Unlock | none (page memory only) | passphrase, unlock duration, lock now |

The Candidacies page (Approve and Reject built: see "Approve from the page") shows a vertical timeline on the left (candidacy received, details checked, passphrase and signature, documents distributed, security code compared: the real chronology, no step is done while an earlier one is not) with an "i" tooltip per step naming the threat it answers. The route computes the steps (`candidacyTimeline.ts`) for the oldest pending candidacy and a step is done only when the relay data proves it: none -> all to do; pending -> received done, checked current; approved (relay status) -> received, checked, signed done; rejected, expired or unknown status -> received only. The relay data never proves the security code or the distribution, so the route leaves them to do; while an approval runs, the page lays what it proves over the steps (`approvalTimeline.ts`: passphrase used -> signed current; relay accepted -> signed done, delivery current, code to do; daemon report `delivered`/`none` -> distributed done (machines waiting in the relay inbox count, the step says how many), code current; `partial`/`failed` keeps distributed current with the retry command and the code cannot be done; code done only when the admin presses "Codes match", "Codes differ" keeps it current with `machine admin revoke <name>`); a note names the followed candidacy. The table and the timeline are one component (`machine:CandidaciesTable`) so both share that state. The tab shows a badge with the number of pending candidacies (module indicator).

## Work breakdown

1. `machine-webcrypto` package with vectors against machine-core (this document, D26).
2. Backend routes: read-only status, list candidacies, post decision (the signature arrives from the page), distribution; every route that spends the token validates the shape and refuses without a page-produced signature.
3. dsl-lib components: timeline (generic, incubating), passphrase and signing, final code display.
4. DSL views for the five pages; scaffold with `app-core-cli init`, copy the sibling test layout (including a real-server backend integration test).
5. Publish with the same process as `app-module-queue`.

## Facts from orch-owner (siblings, read in their repo, nothing run)

- The registered component type is `<module id>:<Name>`; for orch it is `orchestrator:<Name>`, so ours is `machine:<Name>` as planned.
- Entries are generated from `src/components/*.tsx` JSDoc tags (`@registryCategory`, `@registryTags`) by a script into a committed `src/generated/entries.tsx`; `app-core-cli package` bundles to `dist-module/dsl-lib/entries.mjs`. Components may call `fetch` themselves on an API base; the module backend (`ctx.registerRoute`) talks to the daemon with a bearer token file (`<configDir>/health_token` for orch).
- Tests: two vitest projects, `ui` (jsdom, testing-library, tests next to sources) and `lib` (node, one global setup that packages the module once).
- Publishing: neither `dsl-lib-orch` nor `app-module-orchestrator` is published on its own (`private: true`). CI runs check and package, then a script copies `dist-module` into the CLI package as `app-module/`; the daemon registers that folder with app-core at start. For machine this means the module ships INSIDE `@wadeck-app/machine-cli` (WP9), and the daemon registers it with app-core at start (to design with app-core-owner: how the daemon finds app-core).
- Daemon auth from the module backend: a token file next to the config (to define for machine: a `health_token`-like file under `_secrets_`, read by the backend, required by the local daemon API for every route that is not read-only status).

## D27 Pair secret derivation: signature-based (decided 2026-11-14)

`derivePairSecretV2` (machine-core) and its WebCrypto twin (machine-webcrypto): the admin key signs `machine/pair-secret/v2 NUL uuidA:serialA NUL uuidB:serialB` (ordered by uuid), then HKDF-SHA256 over the 64 signature bytes. Deterministic (Ed25519), unforgeable without the admin key, no raw seed needed, so the browser keeps a non-extractable key. Identical outputs in Node and WebCrypto on fixed vectors and 100 random cases. The only production call site is `machine-cli/src/distribute.ts` (switched in a follow-up commit once the bootstrap work in machine-cli is done). The V1 seed-based function stays exported, deprecated. Consequence unchanged (T-36): whoever can sign with the unlocked admin key can recompute every pair secret.

## Health route (decision 65)

`GET /health` is the update test of app-core-cli (app-core `module-authoring.md`, "Update test of app-core-cli"). Always 200 with `{ ok, checks: [{ name, ok, detail }] }`, GET only, no write (tests compare the config folder listing before and after), at most about 2 s (relay and daemon asked in parallel, 2 s each). The staged server uses the REAL config folder and a temp app-core data dir; the module writes nothing at load time (it only registers routes).

| Check | ok:false when | Otherwise (ok:true) |
|---|---|---|
| `config-dir` | folder missing, not a directory or unreadable (advice: `machine setup`; the module still loads) | readable |
| `identity` | `_secrets_/identity.json` missing, corrupt or without name | the machine name only, never the keys |
| `config-files` | a present file of `_secrets_/{peers,address-state}.json`, `{policy,connections,peer-records}.json` is not valid JSON (path and fix named) | valid or absent |
| `relay` | `relay.json` corrupt or invalid (path, fix) | absent: "not joined"; `GET /api/whoami` with the machine token: reachable; down, timeout, refused token or odd status: the cause in `detail` |
| `admin-token` | `relay-admin.json` corrupt or invalid (path, fix) | absent: informational; present: scopes from `/api/whoami` (`full access` for null), or why unknown |
| `daemon` | never | answers (name) or why not (stopped, token refused) |

Rule: ok:false only for what the update could cause or what makes the module unusable. A relay outage is ok:true ("relay unreachable: <cause>") because updating the module cannot fix the relay. No token or key text is ever in an answer.

## Status of the work breakdown (2026-11-14)

| Item | Status |
|---|---|
| 1 `machine-webcrypto` | Done (separate work) |
| 2 Backend routes | Slice 1 done, read-only: `GET /status`, `/machines`, `/candidacies`, `/health` (`packages/app-module-machine`, 53 tests incl. a real app-core server test, local app-core-cli devDependency). Post decision, distribution and the signature check are not started |
| 3 dsl-lib components | `packages/dsl-lib-machine` (jsdom tests, generated entries, CSS): `VerticalTimeline` (generic, incubating), `PassphraseSigner` (unlock and sign a registration in the page, key in a ref), `FinalCodeDisplay`. Not done: the key file route, wiring the signed result to a backend post, the two components are on no page yet |
| 4 Views and scaffold | Scaffold, `machines.yaml`, `candidacies.yaml` (timeline of the five steps driven by the relay data, no buttons) and a tab count on Candidacies done. Policy, Audit, Unlock pages not started |
| 5 Publish | Not started |

Facts found in slice 1:

- The daemon local API is `POST /<command>` on 127.0.0.1 with `Bearer <configDir>/health_token`, answer `{ result }`. The port comes from `daemon.port.json` as planned.
- The daemon `list` carries only uuid, name and aliases. Presence and addresses are added by machine-cli (`addRelayView`, not exported): the Machines page does not show them yet and says so (`presenceNote`).
- The `x-machine-module` header cannot be required on read routes: DSL `$sources` and the manifest tab count send no custom header. `guard.ts` exists and is tested for the signing and spending routes (later slices). Any local process can call every route of the module; read routes only return what that process could read from the user's files, apart from the relay query made with the admin token.
- `machine-cli` exports neither the relay client, `reviewCandidacy`, nor the config dir resolution: their minimal pure logic is copied in the module (`candidacies.ts`, `configDir.ts`), to keep in step.

## Approve from the page (request #146; status 2026-11-27, lots 1-6 built)

Visible on the page: **Approve** and **Reject** on each pending row (`machine:CandidaciesTable`; Approve only where `canApprove`: pending, unexpired, uuid, key, random and code present, no problem). Reject keeps its `$actions.reject` (confirm, reload), called by name from the component; threat notes: threat-model.md, "Reject button" and "Approve from the page". `machine admin approve` stays (rebind, admin machine renewing itself while it has peers, terminal use).

Flow of Approve (`ApproveCandidacyDialog`, `lib/approveFlow.ts`): PIN, `GET /approve-context/:uuid`, checks without passphrase (candidacy code recomputed from key and random as received by `proveCandidacy`, refused loudly on mismatch; list problems; uuid trusted with another key; admin machine renewing itself with peers), dialog (name, hostname, uuid, seen from, who is told, warnings: revoked earlier, relay rebind), passphrase typed at each approval (`ConfirmSignModal askEveryTime`: no unlock window, no holder, field emptied by `take()`), ONE non-extractable unlock signs the approval, the import and the peer documents, key locked, then `POST /candidacies/:id/approve`, then `POST /approve-distribute`, then the 25-digit security code computed in the page with "The codes differ" / "Codes match" and `machine admin revoke <name>`.

| Lot | Status | Content | Where |
|---|---|---|---|
| 1 | built | List answer carries `identityPublicKey` and `random`; `proveCandidacy` recomputes both codes | module backend `candidacies.ts`, dsl-lib `lib/candidacyProof.ts` |
| 2 | built | `buildApproval` (pure): registrations, pair secret V2, sealed bundles, sealed approval v2, import for the admin machine, final code | `machine-webcrypto/approvalBuilder.ts` |
| 3 | built | Daemon `approveContext` and `importCandidate` (registration verified against the pinned key, pair secret opened with the identity key of this machine; `key-changed` stays in the CLI) | `machine-cli/candidateImport.ts` |
| 4 | built | `POST /candidacies/:id/approve` (body exactly `{ approval, adminImport }`), `GET /approve-context/:uuid` | module backend `candidacyApprove.ts` |
| 5 | built | `approveContext` also carries `others` (registrations of the other trusted peers) and the stored `noticeRecipients`; `buildDistribution` (page: peer documents both ways, list of notice recipients per machine reached, others verified against the admin key); daemon `approveDistribute` verifies every document (admin signature, addressee, window, id derived from its own registrations) and delivers through `put` of `distribute.ts` (shared with the CLI, direct then inbox), same report (`formatDistribution`); `POST /approve-distribute` (sensitive + header, body exactly `{ candidateUuid, documents, noticeRecipients }`) | `machine-webcrypto/distributionBuilder.ts`, `machine-cli/approveDistribute.ts`, `distribute.ts` |
| 6 | built | Dialog, table with timeline, `ConfirmSignModal askEveryTime` | dsl-lib-machine |

Behaviour to know:

- A document the page did not send (could not be built) is a named failure with `machine admin distribute <uuid>`; a failed delivery never undoes the approval and is shown loudly with the code still displayed.
- The admin machine approving ITSELF is allowed only when it has no other peer (nothing to tell); with peers the page refuses before the passphrase and names the CLI command (`distributeAdminRenewal` has no page twin).
- Validity is 365 days (the CLI default); not editable in the dialog.
- Not verifiable without a real browser and relay: the PIN dialog flow, the real fetcher and header, the final layout; see the report of the work.

### Result and progress UX

- The timeline is shown inside the dialog (side column, every phase), not only on the page behind the backdrop.
- Result order: one-line headline (`Notice`), security code (large, monospace) with "must read exactly the same on <name>", `Codes match` / `Codes differ`, one line per machine (state, one reason, one next action), raw CLI report in a collapsed `Details` (open on `partial`/`failed`; duplicate lines removed).
- Per-machine data comes from the daemon: `approveDistribute` answers `machines[]` (`state` delivered / inbox / failed, `code`, `reason`, `next`) built from the same report as `text` (`deliveryMachines.ts`); `formatDistribution` output is unchanged. A page without `machines` in the answer reports the delivery as not confirmed and says to update the module.
- A machine revoked here earlier was enrolled before: its admin key is already pinned, it prints no code and enrolls by itself. The page then says "No code to compare: this machine already trusts your admin key", shows no code or buttons, keeps nothing, and the step "Security code compared" is "Not needed" (`skipped`: neither Done nor Current; it never blocks nor precedes a done step).
- Before the passphrase the dialog is one line ("Enrolls <name>: ..."), warnings, a folded "Details" (name, hostname, uuid, seen from, validity, who is told, the candidacy-code check) and the passphrase field; the key hint is the field description. The table keeps Name, Age, Status and the actions (hostname and address are in the row expansion) so no word is cut.
- "Codes match" only records the comparison on this page; the decisive confirmation (pinning the admin key) is made on the candidate (`machine join` shows its own code and asks to confirm). The sentence sits next to the code, in the dialog and when read again.
- The relay purges the candidacy random once approved, so the code cannot be recomputed later. The page posts it right after the approval (`POST /approval-codes`, write route, public value) to `<configDir>/approval-codes.json` (module state, no daemon or relay change): kept 7 days, newest 20, one per machine. It is listed under the table ("Show security code: <name> (approved <age> ago)") and written on the step "Security code compared" of the followed approved candidacy. A refusal to keep it is shown in the dialog (the code stays on screen); a damaged file is reported on the page with the fix, never hides the list.
