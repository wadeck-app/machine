# Candidacies scenarios (draft)

Drafts for the dev-only mock of the Candidacies page. The contract with app-core is not final; the data is plain JSON and the logic is pure TypeScript, so the wrapper (`src/dsl-scenarios`, not written yet) can change without touching them.

| Piece | Role |
|---|---|
| `packages/app-module-machine/src/commons/scenarioSeeds/<name>.json` | Initial state of the mock (a `CandidaciesState`), fake data only |
| `src/commons/candidaciesState.ts` | Pure state machine: state + action -> new state + route answer. Browser-safe |
| `src/commons/routeContracts.ts` | Wire types of the 7 routes. Browser-safe, re-declared from the Node-only backend types |
| `src/backend/scenarioSeeds/seeds.test.ts` | Builds the seeds, compares every answer with the REAL routes, scans for real data |
| `src/backend/scenarioSeeds/routeContracts.test.ts` | Compile-time drift guard against the real types (`npm run typecheck`) |

Rewrite the seeds: `WRITE_SEEDS=1 npm test --workspace=packages/app-module-machine -- scenarioSeeds/seeds`. Load one with `rebase(seed, Date.now() / 1000)` so ages stay as written.

## Module-check constraint

`app-core-cli package` accepts only `src/backend`, `src/dsl-views`, `src/dsl-components`, `src/commons` (no `src/dsl-scenarios` until app-core ships it). `src/commons` is browser-shared: no `node:*` import, so JSON seeds live there and every test or helper using Node lives in `src/backend`. `src/backend/candidaciesState.test.ts` scans `src/commons` for Node imports. Local bundle: `BUNDLE_VERSION=0.0.0-local npm run bundle --workspace=packages/app-module-machine`.

## Seeds

| Seed | Shows | Planned delivery |
|---|---|---|
| `empty` | no candidacy, timeline all to do | none |
| `one-pending` | first enrollment of mac-m2, 4 min old | delivered |
| `several-pending` | mac-m2 (oldest, followed) and thinkcentre (uuid bound to a revoked token) | delivered |
| `pending-revoked-earlier` | mac-m2 revoked at serial 3: "REVOKED earlier", no code to compare | delivered |
| `pending-with-problems` | no uuid: cannot be approved, can be rejected | none |
| `relay-error-503` | no admin token: every relay route answers 503 with the fix | none |
| `relay-unreachable-502` | relay down: 502 (the backend answers 502 here, not 503) | none |
| `approve-result-delivered` | thinkcentre trusted, both machines take the documents directly | delivered |
| `approve-result-partial` | mac-m2 delivered, thinkcentre waits in the relay inbox | partial |
| `approve-result-failed` | relay refuses the documents: both failed, retry command shown | failed |
| `approval-codes-recallable` | mac-m2 approved 4 min ago, its code shown again; a 2 days old reminder | none |
| `candidate-expired` | posted 20 min ago, expired for 5: cannot be decided | none |

## Transitions

| Action (route) | Effect on the state | Answer |
|---|---|---|
| `GET /candidacies`, refresh | none | rows, timeline, kept codes; the relay error if set |
| `GET /approve-context/:uuid` | none | admin machine, trusted peers (`others`), `revokedSerial` for a revoked machine |
| `POST /candidacies/:id/approve` | pending -> approved, candidate trusted, its revocation forgotten | 200 `imported`; 404 unknown, 409 not pending / problems / expired / random or import mismatch |
| `POST /approve-distribute` | none | the planned delivery of the scenario; 409 `not-imported` before the approval |
| `POST /approval-codes` | code kept (replaces the same machine), shown on the last step and in the reminders | `{ ok: true }`; 400 on a bad body |
| `POST /candidacies/:id/reject` | row removed | 200; 404 unknown or expired; 409 not pending |
| `advanceClock(s)` | ages grow, a candidacy expires, a code older than 7 days is dropped | none |
| reset | reload the seed | none |

## Not real

- The admin key file is a placeholder envelope (`FAKE PLACEHOLDER` hint): no passphrase unlocks it, so the browser cannot really sign; the mock must stand in for that step.
- Registrations of trusted machines are signed with a fake admin key; the one added by an approval is `MOCK-UNSIGNED-NOT-A-SIGNATURE`.
- `GET /approval-codes` does not exist in the backend: the kept codes ride `GET /candidacies` (`approvals`).
- The delivery report counts are hand-built; the text and per-machine states come from the real CLI functions.
