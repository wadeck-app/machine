# Scenarios (dev-only mocks of the Candidacies and Machines pages)

Browser-only mock backends of app-core "Scenarios" (SDK `module-authoring.md`, section "Scenarios: a page on mock data"). The shell loads them only on the Vite dev server or with `--scenarios`.

## Run

1. Start the app-core dev server (port 5173) with this module installed from a bundle that includes `dsl-lib/scenarios.mjs`.
2. Pick a scenario in the A/B dock ("Scenario" row, badge with Reset), or force it in the URL: `?scenario=<id>` (`?scenario=real` = the real backend).

| Page | URL |
|---|---|
| Candidacies | `/modules/machine/candidacies` |
| Machines | `/modules/machine` |

Example: `/modules/machine/candidacies?scenario=one-pending`.

## Pieces

| Piece | Role |
|---|---|
| `src/dsl-scenarios/index.ts` | `export default defineScenarios(SCENARIOS)` (SDK) |
| `src/commons/scenarioList.ts` | The scenarios (id, label, hint, page, `create`); in commons because the module check forbids `src/backend` (the tests) to import `src/dsl-scenarios` |
| `src/commons/candidaciesState.ts`, `machinesState.ts` | Pure state machines: state + request -> new state + answer |
| `src/commons/candidaciesMock.ts`, `machinesMock.ts` | Routes over a state kept in the closure of `create()`; Candidacies follows the browser clock (ages grow, a candidacy expires) |
| `src/commons/scenarioSeeds/*.json`, `machinesSeeds.ts` | Fake initial states |
| `src/commons/routeContracts.ts`, `mockRoutes.ts` | Wire types; mock route types and `MODULE_PREFIX` |
| `src/backend/scenarioSeeds/*.test.ts` | Seeds and Candidacies state machine against the REAL routes; routes, scenario list, privacy scan |

Rewrite the Candidacies seeds: `WRITE_SEEDS=1 npm test --workspace=packages/app-module-machine -- scenarioSeeds/seeds`. Local bundle: `BUNDLE_VERSION=0.0.0-local npm run bundle --workspace=packages/app-module-machine`.

## Candidacies scenarios (`/candidacies`)

Routes: `GET /candidacies`, `GET /approve-context/:uuid`, `GET /admin-key`, `POST /candidacies/:id/approve`, `POST /candidacies/:id/reject`, `POST /approve-distribute`, `POST /approval-codes`.

| Id | Shows |
|---|---|
| `empty` | no candidacy: the empty text names the next step, no timeline |
| `one-pending` | first enrollment of mac-m2, 4 min old |
| `several-pending` | mac-m2 (oldest, followed) and thinkcentre (uuid bound to a revoked token) |
| `pending-revoked-earlier` | mac-m2 revoked at serial 3: "REVOKED earlier", no code to compare |
| `pending-with-problems` | no uuid: cannot be approved, can be rejected |
| `relay-error-503` | no admin token: every relay route answers 503 with the fix; the page shows one alert (cause and `machine admin login`) and no empty text |
| `relay-unreachable-502` | relay down: 502 |
| `approve-result-delivered` / `-partial` / `-failed` | planned delivery after an approval: both direct / one in the relay inbox / both failed with the retry command |
| `approval-codes-recallable` | mac-m2 approved 4 min ago, its code shown again; a 2 days old reminder; the last two steps read "Not recorded by this page" |
| `candidate-expired` | posted 20 min ago, expired for 5: cannot be decided |

| Action | Effect on the state |
|---|---|
| Approve | pending -> approved, candidate trusted, its revocation forgotten; 404 / 409 as the relay |
| Reject | row removed; 404 unknown or expired, 409 not pending |
| `POST /approval-codes` | code kept, shown on the last step and in the reminders |
| `POST /approve-distribute` | the planned delivery; 409 `not-imported` before the approval |

## Machines scenarios (`/`)

Routes: `GET /machines`, `GET /revoke-context/:uuid`, `GET /rename-context/:uuid`, `GET /aliases-context`, `GET /admin-key`, `POST /revoke`, `POST /rename`, `POST /aliases`, `POST /delivery-retry`, plus the tab counts of the manifest (`GET /requests`, `GET /candidacies`: a fake `{ count: 0 }`; the Candidacies scenarios answer `GET /requests` the same way), so the shell logs no 404 for "indicator of menu:machine/..." (only the error scenarios fail their own count, on purpose). The Aliases column lists local and network aliases (`tc (local), work (network)`; a label a local alias shadows is the local one), and shows an alias as soon as it is added.

| Id | Shows |
|---|---|
| `only-this-machine` | one row, no Revoke |
| `two-trusted-peers` | thinkcentre reachable directly, mac-m2 not; notice columns |
| `peer-revoked-earlier` | mac-m2 revoked (serial 3) and absent; revoking thinkcentre has nobody to tell |
| `revoke-delivered` / `-partial` / `-failed` | planned delivery after revoking mac-m2: direct / relay inbox (offline) / relay refuses, retry command |
| `relay-unreachable` | relay down: thinkcentre not told AND mac-m2 not removed from the relay |
| `rename-delivered` | Rename mac-m2: thinkcentre and the renamed machine take the documents directly; refused names to try: `thinkcentre` (taken), `think-centre` (lookalike), `tc` (local alias) |
| `rename-partial` | thinkcentre delivered, the renamed machine failed: headline, one line per machine, Retry delivery (then the relay inbox) |
| `rename-failed` | the relay refuses everything: both failed, command folded, Retry delivery |
| `alias-set` | network list `tc` -> mac-m2 and `work` -> thinkcentre, while the local alias `tc` -> thinkcentre wins here (warning); add an alias |
| `alias-remove` | list `box`, `work`: Remove each (own passphrase, own result) |
| `alias-conflict` | no network alias, local `tc`: `thinkcentre` and `think-centre` refused before the passphrase, `tc` for mac-m2 accepted with the local-wins warning |
| `alias-partial` | thinkcentre delivered, mac-m2 failed; Retry delivery goes through the reserved uuid of the aliases |

Revoke removes the peer from the next `GET /machines` and adds it to the held list; revoking it again is a 409.

Rename replaces the registration of the peer (name, serial + 1) in the next `GET /machines`; a stale serial or a taken name is a 422. Aliases keep the list the page signed (exactly one alias added or removed, a higher serial, else 422 / 409). The seeded lists are `scenarioSeeds/machines-aliases.json`, signed by the scenario key (`WRITE_SEEDS=1 npm test --workspace=packages/app-module-machine -- machinesActionsMock`): the page verifies the held list before it signs the next. The retry of the aliases is kept under the reserved uuid `00000000-0000-4000-8000-0000000a11a5` (machine-core `NETWORK_ALIASES_SUBJECT_UUID`, allowed by the privacy scan).

## Limits

- The signature IS real. The admin key served by the scenarios is a throwaway key (32 bytes of 0xa1, trusted by no machine) encrypted with the published passphrase `scenario-passphrase-2026` (hint of every signable scenario; the key's own hint says "scenario key, trusted by nothing": machine-core refuses a hint that contains the passphrase). The real page code (unlock, pinned key, builders, delivery summary) runs end to end and reaches the result views; another passphrase shows the normal "wrong passphrase" message. Proved by `scenarioSigning.test.ts`.
- The envelope is a literal in `seedBuilders.testUtil.ts` (a fresh encryption draws a new salt and iv, which would make `WRITE_SEEDS=1` non-deterministic); its ciphertext is the single allow-listed key-like string of the privacy scan.
- Seed registrations are signed by that key and valid from 30 days before 2026-11-28 for 10 years: the page's signing step fails when the browser clock is outside that window. The POST mock routes check the shape only, and the registration an approval adds is `MOCK-UNSIGNED-NOT-A-SIGNATURE`.
- `GET /approval-codes` does not exist in the backend: kept codes ride `GET /candidacies`.
- Delivery report counts and the Machines texts (`out`/`err`, reasons) are hand-written; the Candidacies delivery texts come from the real CLI functions.
- Machines seeds are TypeScript built from the Candidacies JSON seeds (admin, two registrations); they are not compared with the real routes (the Candidacies ones are). The page's own code (`loadRevokeContext`, `readAdminKeyHint`, `describeDelivery`) is run on the answers.
- Seeds hold no data of a real network (privacy scan in `scenarios.test.ts` and `seeds.test.ts`).
