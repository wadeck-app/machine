# app-module-machine

app-core module `machine` (title "Machine"): admin pages of the machine network. Design: `.claude/specs/2026-11-13_machine-network/admin-ui.md`.

## Slice 1 (read-only)

| Route | Source | Answer |
|---|---|---|
| `GET /api/modules/machine/status` | local daemon `status` | status, or `{ status, kind, error }` |
| `GET /api/modules/machine/machines` | local daemon `list` | rows for the Machines page (no presence or addresses yet) |
| `GET /api/modules/machine/candidacies` | relay, admin token | candidacies with the recomputed code, `count` for the tab indicator |
| `GET /api/modules/machine/requests` | local daemon `requests` (the audit log, same reader as `machine requests`) | Requests page: pending rows (ages, next command), history rows, chain state, `count` for the tab indicator (decision 73) |
| `POST /api/modules/machine/requests/remote` | local daemon `remoteRequests` | sensitive (app-core PIN) and `x-machine-module`; body `{ machine, request }`, `request` = the `requests-list` document SIGNED IN THE BROWSER with the admin key; answers the peer rows. The Requests page signs it (RequestsOverview, decision 74) |
| `GET /api/modules/machine/admin-key` | daemon `adminKeyFile` | sensitive + `x-machine-module`; `{ file }`: the ENCRYPTED admin key file as on disk (refused when it is not an encrypted envelope). The page unlocks it in the browser (decision 76) |
| `GET /api/modules/machine/allow/:machine` | daemon `allowContext` | sensitive + header; target, pinned admin key, the signed policy to edit from, delivery (`install` here, `inbox` for a peer); refuses before any passphrase (no admin key, mode local, no admin token) |
| `POST /api/modules/machine/allow` | daemon `submitPolicy` | sensitive + header; body exactly `{ policy, document? }` (signed in the browser; any other field is a 400); the daemon verifies the signature, target and base version, then installs it here or puts the document in the peer's relay inbox |
| `GET /api/modules/machine/health` | config folder, relay (`/api/whoami`), daemon | update test of app-core-cli (decision 65): `{ ok, checks[] }` |

- Config dir: `MACHINE_CONFIG_DIR`, else `~/.config/machine` (same as machine-cli).
- Daemon: port from `<configDir>/daemon.port.json`, bearer token from `<configDir>/health_token`, both read at each request.
- Relay: token from `<configDir>/_secrets_/relay-admin.json`, read at each request. The token is in no response, log or error.
- The verification code is recomputed with machine-core `candidacyCode`; a code sent by the relay is only compared and reported as a problem.
- Errors are `{ kind, error }` with an actionable text: `daemon_unreachable` (503), `daemon_token_refused` (502), `daemon_error` (502), `not_initialized` (409), `relay_not_configured` (503), `relay_error` (502).

## Local API limit

app-core checks only Host and Origin: any local process can call any route of this module as the user. The slice-1 routes only return what such a process could already read from the user's files, except that they use the admin token to query the relay.

`src/backend/guard.ts` (`x-machine-module: 1`) is NOT applied to these routes: DSL `$sources` and the tab count of the shell cannot send custom headers. It is meant for the routes of later slices that sign or spend the token. It is not authentication: any local process can send the header.

Signing never happens in this backend (decision D25).

## Tests

```
npm test                    # backend unit tests ONLY (prints a notice line saying so)
npm run test:integration    # real-server integration test (starts a local app-core server on a free port)
```

The default `npm test` (and so the root `npm test`) does NOT run the integration test: it packages the module and starts a server, so it runs on request from `vitest.integration.config.ts`.

The integration test packages the module and starts `app-core-cli dev` on a free port. It uses the `@wadeck-app/app-core-cli` devDependency; `MACHINE_TEST_APP_CORE_CLI_ENTRY=<path of dist/cli.bundle.js>` overrides it. Packaging needs `src/dsl-components/style.css`, which is generated: run `npm run css --workspace=@wadeck-app/dsl-lib-machine` first on a fresh clone (`npm run bundle` does it).

## Not in this slice

Only the Allow button of the Requests page signs (decision 76; the Allowed page also signs a deletion or a new lifetime of an entry (decision 112); there is no Policy page). The unlocked key is kept in the page for a chosen idle time (decision 92). Not built: Reject, Revoke, Approve candidacy, Distribute. Approve and reject buttons (the components `machine:PassphraseSigner` and `machine:FinalCodeDisplay` exist in `packages/dsl-lib-machine` but are not on a page; the Candidacies timeline statuses are static), the post-decision and distribution routes, Policy, Audit and Unlock pages, publication (see the work breakdown in admin-ui.md).
