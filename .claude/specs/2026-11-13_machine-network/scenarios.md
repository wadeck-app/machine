# Scenarios (dev-only mocks of the Candidacies and Machines pages)

Browser-only mock backends of app-core "Scenarios" (SDK `module-authoring.md`, section "Scenarios: a page on mock data"). The shell loads them only on the Vite dev server or with `--scenarios`.

## Run

1. Start the app-core dev server (port 5173) with this module installed from a bundle that includes `dsl-lib/scenarios.mjs`.
2. Pick a scenario in the A/B dock ("Scenario" row, badge with Reset), or force it in the URL: `?ab.scenario.machine.<page-slug>=<id>`.

| Page | URL | `<page-slug>` |
|---|---|---|
| Candidacies | `/modules/machine/candidacies` | `candidacies` |
| Machines | `/modules/machine` | `home` |

Example: `/modules/machine/candidacies?ab.scenario.machine.candidacies=one-pending`.

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
| `empty` | no candidacy, timeline all to do |
| `one-pending` | first enrollment of mac-m2, 4 min old |
| `several-pending` | mac-m2 (oldest, followed) and thinkcentre (uuid bound to a revoked token) |
| `pending-revoked-earlier` | mac-m2 revoked at serial 3: "REVOKED earlier", no code to compare |
| `pending-with-problems` | no uuid: cannot be approved, can be rejected |
| `relay-error-503` | no admin token: every relay route answers 503 with the fix |
| `relay-unreachable-502` | relay down: 502 |
| `approve-result-delivered` / `-partial` / `-failed` | planned delivery after an approval: both direct / one in the relay inbox / both failed with the retry command |
| `approval-codes-recallable` | mac-m2 approved 4 min ago, its code shown again; a 2 days old reminder |
| `candidate-expired` | posted 20 min ago, expired for 5: cannot be decided |

| Action | Effect on the state |
|---|---|
| Approve | pending -> approved, candidate trusted, its revocation forgotten; 404 / 409 as the relay |
| Reject | row removed; 404 unknown or expired, 409 not pending |
| `POST /approval-codes` | code kept, shown on the last step and in the reminders |
| `POST /approve-distribute` | the planned delivery; 409 `not-imported` before the approval |

## Machines scenarios (`/`)

Routes: `GET /machines`, `GET /revoke-context/:uuid`, `GET /admin-key`, `POST /revoke`.

| Id | Shows |
|---|---|
| `only-this-machine` | one row, no Revoke |
| `two-trusted-peers` | thinkcentre reachable directly, mac-m2 not; notice columns |
| `peer-revoked-earlier` | mac-m2 revoked (serial 3) and absent; revoking thinkcentre has nobody to tell |
| `revoke-delivered` / `-partial` / `-failed` | planned delivery after revoking mac-m2: direct / relay inbox (offline) / relay refuses, retry command |
| `relay-unreachable` | relay down: thinkcentre not told AND mac-m2 not removed from the relay |

Revoke removes the peer from the next `GET /machines` and adds it to the held list; revoking it again is a 409.

## Limits

- The admin key file is a placeholder envelope (hint `FAKE PLACEHOLDER`): no passphrase unlocks it. The dialogs run up to the passphrase and then show "admin key file: wrong passphrase or damaged key file". **The result views (delivered / partial / failed) cannot be reached in the browser**: the `approve-result-*`, `revoke-*` and `relay-unreachable` plans are only proved by tests. Every hint says so. Getting there needs a throwaway key with a documented passphrase pinned in the seeds (or a hook of the contract that skips the signature): not done, see decision to take.
- Registrations are signed with a fake admin key; the one added by an approval is `MOCK-UNSIGNED-NOT-A-SIGNATURE`.
- `GET /approval-codes` does not exist in the backend: kept codes ride `GET /candidacies`.
- Delivery report counts and the Machines texts (`out`/`err`, reasons) are hand-written; the Candidacies delivery texts come from the real CLI functions.
- Machines seeds are TypeScript built from the Candidacies JSON seeds (admin, two registrations); they are not compared with the real routes (the Candidacies ones are). The page's own code (`loadRevokeContext`, `readAdminKeyHint`, `describeDelivery`) is run on the answers.
- Seeds hold no data of a real network (privacy scan in `scenarios.test.ts` and `seeds.test.ts`).
