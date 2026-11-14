# WP9.5 / 9.6 / 9.7 implementation plan (read-only study, nothing run)

**Spec:** .claude/specs/2026-11-13_machine-network/

`[U]` = unknown. Paths relative to `C:/Workspace_Tooling/`. `orch/` = `orchestrator/packages/orchestrator-cli/src/`, `queue/` = `queue/packages/queue-cli/src/`.

## Findings that change the plan

1. Config dir is not carried to the updater: `cliUpdateCommand` (`shared-cli/.../CliMetaCommands.ts:78-98`) and `UpdateManager.scheduleBackgroundUpdate` (`UpdateManager.ts:35-52`) only copy `process.env`. A daemon started with `--config-dir X` would run an updater that resolves the default dir. Fix: the updater resolves its dir with `resolveConfigDir(undefined, process.env)` (`paths.ts:6-14`); CLI and daemon set `process.env.MACHINE_CONFIG_DIR = configDir` before spawning it. Test it.
2. `UPDATER_FORCE` already overrides `autoUpdate: false` in shared-updater (`without-daemon.ts:34-44`). orch's `config.yml` patching (`orch/updater/entry.ts:41-67`, restore `:218-220`) is an old workaround: do not copy.
3. An unset `UPDATER_SELF_CHECK_CMD` passes silently (`without-daemon.ts:219-220`). Copy orch's abort-on-failure arming (`orch/updater/entry.ts:69-97`).
4. `restartDaemon` is unusable: it always writes `config.restart` before `POST /quit` (`without-daemon.ts:177-184`); with the launcher in the chain the launcher would relaunch node and orch would see no exit. Machine does not set it; `cli post-update` sends `POST /quit` itself (packaging.md 3.5).
5. `runUpdater` returns void: success for this run = `readState(stateFilePath(configDir))` with `status==='success' && targetVersion!==currentVersion && timestamp >= startedAt`.

## WP9.5 Updater entry and `cli` subcommands

Copy from:
- `queue/cli/queue-updater-entry.ts:1-28` (header, dev-build refusal, exit 1 when `UPDATER_FORCE=1`, appendLog, stderr lines).
- `orch/updater/entry.ts:30-39`, `:69-97`, `:159-220`.
- `orch/updater/self-check-target.ts:21-88` whole (`bin.orch` -> `bin.machine`, rename the failing marker).
- `orch/updater/entry.ts:104-120` `checkEngineCompatibility` (needs `semver`, version [U]); optional since `engines.node` is `>=22`.
- `orch/update-notice.ts` (85 lines).
- `orch/cli.ts:1838-1888` (`self-check`, `version`, `logs`, `update`; dev-build refusal `:1864-1869`) and `:2559-2569` (print pending notice on stderr, `--json` stdout stays pure).
- `cliRollbackCommand` exported by `shared-cli` (`CliMetaCommands.ts:101-118`).

Create in `packages/machine-cli/src/`:
- `updater/entry.ts`: imports only shared-updater, `shared-cli/ConfigDir`, `shared-cli/ReleaseVersion`, `paths.ts`, the self-check target; version from `define`, not `version.ts`. `skipThrottle: true` when the daemon spawns it (env marker `MACHINE_UPDATER_FROM_DAEMON=1`, [U] if acceptable). `onUpdateAvailable`: `apply-now` when `UPDATER_FORCE`, otherwise busy check via daemon (question for the user). No `restartDaemon`. After success for this run, spawn `node <npmRoot>/@wadeck-app/machine-cli/bin/machine.js cli post-update` with `MACHINE_CONFIG_DIR`.
- `updater/selfCheckTarget.ts`, `updateNotice.ts`, `cliMeta.ts` (`version|update|rollback|self-check|logs|post-update|register`), `selfCheck.ts` (packaging.md 3.4: CalVer version, platform package same family, staged launcher creatable, config dir writable, node >= 22; no identity access), `postUpdate.ts` (injectable: `startup status`; job exists -> `startup enable`; restart daemon via `POST /quit` when version differs; else nothing).

Change: `scripts/bundle.mjs` and `src/bundle.ts` add entry `machine-updater.cjs` (500 KB cap, no runtime import; model `queue/ci/scripts/bundle.ts:115-121`); `src/cli.ts` add the `cli` command and help; `package.json` add `@wadeck-app/shared-updater` `latest`.

Tests first (T8, T9, T11): selfCheckTarget and updateNotice (port orch tests, [U]); updater entry with injectable armSelfCheck (`npm root -g` failure aborts with fix; dev version exits 1 under `UPDATER_FORCE`, 0 otherwise); post-update (job absent -> nothing, present -> `startup enable`, daemon older -> one `POST /quit`, already new -> nothing); `bundleScript.test.ts` (size cap, no runtime import, version inlined, `BUNDLE_VERSION` wins); T8 fake registry loopback modelled on `task/packages/task-cli/src/fakeNpmRegistry.ts`.

shared-updater gaps: none blocking. Optional: `requireSelfCheck` (one line at `without-daemon.ts:219-220`), config dir env/arg. README config table is stale (real keys `autoUpdate: false`, `checkInterval`, `config.ts:15-16`).

## WP9.6 Daemon scheduler, update loop guard, prune

Copy from: `orch/update-scheduling.ts:1-80` whole ('machine', `machine-updater.cjs`); `orch/update-guard.ts:1-116` whole (needs `atomicWriteJson`, `getErrorMessage` from `orch/fsUtil.ts` [U]; check `fsutil.ts` has an atomic JSON write); `orch/index.ts:140-165` (scheduler), `:440-451` (prune after startup refresh), `:458-481` (guard, `updates.request('startup', {oncePerRun:true})`, 30-minute `setInterval(...).unref()`), `:489-` (canary tick, optional).

Change `src/daemonEntry.ts` after `writeDaemonPortFile`, before the relay block (~`:132`): `UpdateManager` from `shared-cli`, scheduler, state read, guard, request. `DaemonStart` gets optional injected `updates` and `version`. Set `process.env.MACHINE_CONFIG_DIR` before the first request. Health may expose busy count (`orch/index.ts:340`); `PeerService.inFlight` is private (`peerService.ts:81`) and needs exposing; whether kit `HealthStatus` allows extra fields is [U] (`singleton-daemon-kit/src/types.ts:13`). Prune: `pruneStaged(configDir, stamp)` (`platformBinary.ts:134`) only after the startup refresh succeeded; failures ignored.

New: `src/updateScheduling.ts`, `src/updateGuard.ts` with ports of orch tests ([U] names).

Tests first (T10, T13): dev version skips and explains once; suspended skips once; `force` sets/restores `UPDATER_FORCE`; `oncePerRun`; guard loop limit 3 in 30 min, stale update vs running version, unreadable/unwritable records reported; `POST /quit` exits 0, removes `daemon.port.json`, closes the peer listener (hook at `daemonEntry.ts:76-83`); daemon sets `MACHINE_CONFIG_DIR` before spawning.

shared-updater gaps: `scheduleBackgroundUpdate` sets `LAUNCHER_BUNDLE_OVERRIDE=bundlePath` for the updater (effect with staged launcher [U], updater only); no post-success hook under the lock (accepted by the spec); busy signal implemented by machine via `/health` as orch (`orch/updater/entry.ts:126-157`, `:195-213`).

## WP9.7 App-module copy and daemon registration

Copy from: `orch/app-core-registration.ts:1-201` whole (`APP_CORE_MODULE_ID = 'machine'`, sibling candidate `../app-module-machine/dist-module/manifest.json`, log wording own; no `config.yml` key for machine [U]); `orch/index.ts:352-363` (onStart call site, `moduleStamp: version`); bundle copy `queue/ci/scripts/bundle.ts:96-113` (module `npm run bundle` with `BUNDLE_VERSION`, copy `dist-module` to `<out>/app-module`, fail when `manifest.json` is missing). `queue/cli/registerAfterUpdate.ts` not needed: the restarted daemon re-registers (packaging.md 3.5.c).

Create/change: `src/appCoreRegistration.ts` (`registerOnStart`), called not awaited from `daemonEntry.ts` after the port file; `packageRoot` = `dirname(bundle)` via `fileURLToPath(import.meta.url)` (`bundle.ts:19`); `cli register` in `cliMeta.ts` uses the same function; `scripts/bundle.mjs` and `src/bundle.ts` add the app-module step (does `app-core-cli package .` read `BUNDLE_VERSION`: [U], app-core-owner question 2); `package.json` add `@wadeck-app/app-core-sdk` `latest` (subpath `./register`, `app-core/packages/app-core-sdk/package.json:13`; published CalVer [U]); commit `package.json` and lock together, `npm ci --dry-run`.

Tests first (T12): port orch registration tests ([U]): skipped when app-core dir missing; staged once per stamp; `.partial` rename; prune only after `registered` or `deferred`; refusal keeps old copy; never rejects; bad stamp refused. Bundle test: `manifest.json` in `app-module/`. Strict `generate-platform-packages` fails without `app-module/` and `machine-updater.cjs` (`packagesWriter.ts:55-63`): a green strict build confirms the wiring.

## Unknowns

1. Is shared-updater HEAD (newer than `2026.10.25-020`, last commit `b822b8c`) published.
2. Should the daemon defer an update while a remote execution runs (packaging.md 3.5.3); needs `PeerService.inFlight` exposed.
3. Exact JSON `app-core-cli package .` expects and produces.
4. Env marker vs spawn argument for `skipThrottle`.
5. Content of `orch/fsUtil.ts` and the orch test files to port.
