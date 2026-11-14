# app-module-machine

app-core module `machine` (title "Machine"): admin pages of the machine network. Design: `.claude/specs/2026-11-13_machine-network/admin-ui.md`.

## Slice 1 (read-only)

| Route | Source | Answer |
|---|---|---|
| `GET /api/modules/machine/status` | local daemon `status` | status, or `{ status, kind, error }` |
| `GET /api/modules/machine/machines` | local daemon `list` | rows for the Machines page (no presence or addresses yet) |
| `GET /api/modules/machine/candidacies` | relay, admin token | candidacies with the recomputed code, `count` for the tab indicator |

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
npm run test:integration    # real-server integration test (needs an app-core-cli)
```

The default `npm test` (and so the root `npm test`) does NOT run the integration test: it needs an app-core-cli, and `@wadeck-app/app-core-cli` is not installed in this repository. The test is excluded by `vitest.config.ts` and runs from `vitest.integration.config.ts`, so a missing tool never turns the default suite red nor is skipped silently.

The integration test packages the module and starts `app-core-cli dev` on a free port. `npm run test:integration` needs the `@wadeck-app/app-core-cli` devDependency, or `MACHINE_TEST_APP_CORE_CLI_ENTRY=<path of dist/cli.bundle.js>` (for example the global install: `npm root -g`, then `@wadeck-app/app-core-cli/dist/cli.bundle.js`). Without either it FAILS with that instruction. Run it before publishing the module.

## Not in this slice

Timeline component, passphrase and signing component, approve and reject, Policy, Audit and Unlock pages, publication (see the work breakdown in admin-ui.md).
