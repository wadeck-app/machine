# Packaging, publication and update of `machine` (WP9)

**Version:** v0.1 (2026-11-14). Design only, nothing implemented. Applies decisions 38, 38a, 38b, 38c, 39 (`_index.md`) and `startup.md`; reopens none. Paths are relative to `C:/Workspace_Tooling/` unless prefixed `machine/`.

Legend: **[V]** = read by me, file:line given. **[U]** = unverified (agent or owner report, or not read). The `flow` repo is not on disk: nothing about flow is verified here.

## 1. Facts about the siblings

### 1.1 What the "native executable" is

| Fact | Ref |
|---|---|
| The exe in every platform package is the **Go launcher** of `singleton-daemon-kit`, not a Node SEA, not pkg, not bun. It spawns `node <bundle>` and needs Node on PATH (`exec.LookPath("node")`). | `singleton-daemon-kit/go-launcher/launcher.go:307` [V]; `singleton-daemon-kit/CLAUDE.md` (first lines) [V] |
| The exe is built `CGO_ENABLED=0`, Windows with `-H windowsgui` (no console, so its stdout is swallowed); five targets from one `build.sh` run on ubuntu. | `go-launcher/build.sh:233-253` [V] |
| Launcher does: Job Object (node dies with it), signal forwarding (Unix only), logs to `<configDir>/logs`, restart sentinel `<configDir>/config.restart`, optional bounded crash restart (Go-only, opt-in). | `go-launcher/README.md` (SDK scope, Crash restart) [V]; `launcher.go:245-288` [V] |
| Bundle lookup order: `LAUNCHER_BUNDLE_OVERRIDE`, spec as file, next to the exe, `<dirname(node)>/node_modules/<spec>`, then walking up `node_modules` **from the launcher's own directory**. | `go-launcher/nodescript.go:49-105` [V] |
| Config dir of the launcher: `--config <dir>` (or a leading absolute path argument) else XDG default; `ResolveConfigDir` strips `--config`. Queue ships its own `main.go.tmpl` to also honour `QUEUE_CONFIG_DIR`. | `go-launcher/launcher.go:422-479` [V]; `queue/packages/queue-cli/ci/launcher-main.go.tmpl:10-50` [V] |
| Launcher config per CLI: `{appName, displayName, nodeScript, defaultConfigDir, cliFlags}` (orch adds `updateCmd`, `silentFlags`). | `queue/.../ci/launcher-queue.config.json` [V]; `orchestrator/packages/orchestrator-cli/ci/launcher.config.json` [V] |

### 1.2 Package layout and shim

| Fact | Ref |
|---|---|
| Family A (queue, task, flow, project): private unscoped workspace package `queue-cli`; CI generates `@wadeck-app/queue-cli` (wrapper) in `packages/queue-cli-dist` plus `queue-cli-<platform>`. Family B (orch): the workspace package itself is published. | `shared-cli/docs/cli-best-practices.md:33-50` [V]; `queue/.../package.json` (`private: true`, name `queue-cli`) [V] |
| Why A keeps the source name unscoped: two workspace packages with one name inside `packages/*` break `npm install`. | `cli-best-practices.md:48` [V] |
| Platform package: `{name, version 0.0.0, os, cpu, files:[exe], publishConfig}`; wrapper: `bin`, `files` (shim, bundles, `app-module/`), `optionalDependencies` set to `latest`. No `repository`, no `engines` in the generated wrapper. | `queue/.../ci/scripts/generate-platform-packages.sh:12-72` [V] |
| Publish rewrites the pins to the exact version being published (`>=0.0.0-0` never matches a CalVer prerelease). | `queue/.../ci/scripts/pin-platform-versions.mjs:1-18` [V]; `.github/workflows/publish-queue-cli.yml:264-267` [V] |
| Orch variant: platform version is `<build>-bin.<hash of all native binaries>`; republished only when the hash changes; main package pins the resolved version. | `orchestrator/.../ci/scripts/publish-platform-packages.sh:1-80` [V] |
| Shared shim template (`ci-templates`): every command runs `node <bundle>` directly with stdio `inherit` by default; only `start` goes through the launcher (lazy `npm install -g` of the platform package if missing). Queue's older generated shim discards output when stdin is not a TTY. | `ci-templates/templates/bin-launcher.js.tmpl:10-12,57-65,86-96` [V]; `queue/.../ci/templates/bin-launcher.js.tmpl:27-35` [V] |
| Orch's shim: all commands run `node dist/orchestrator-cli.cjs`; the CLI itself spawns the launcher (`startDaemon`). | `orchestrator/.../bin/orch.js:1-12,43-47` [V]; `src/cli.ts:2426-2480` [V] |
| Supported platform per CLI = `os-arch` key; anything else exits 1 first thing. Queue/task/flow/project: win32-x64, darwin-arm64, linux-x64. | `ci-templates/templates/bin-launcher.js.tmpl:43-47` [V]; `queue/.../ci/scripts/generate-platform-packages.sh:69-71` [V]; flow [U] |
| `ci-templates` scripts are copied per repo (no drift detection). | `ci-templates/.claude/threat-model.md:17-19` [V] |
| Generator in `ci-templates` allows `win32-x64,darwin-arm64,darwin-x64,linux-x64` and fails on an unknown key. | `ci-templates/README.md` (Supported platforms) [V] |

### 1.3 Bundling and version inlining (esbuild only)

| Fact | Ref |
|---|---|
| esbuild bundle (`cjs`, `node22`, `external: []`) of each entry: CLI, updater, daemon (queue has 4 entries, orch 3). Version via `define` (`__QUEUE_CLI_VERSION__`), value from `BUNDLE_VERSION` else a local CalVer. | `queue/.../ci/scripts/bundle.ts:30-35,42-94` [V] |
| Updater bundle must not import the CLI runtime; size cap 500 KB. | `queue/.../ci/scripts/bundle.ts:115-121` [V]; `queue/.../src/cli/queue-updater-entry.ts:1-3` [V] |
| App-module: built by its own package (`npm run bundle` with `BUNDLE_VERSION`), then `dist-module/` copied to `<bundle>/app-module`. | `queue/.../ci/scripts/bundle.ts:96-113` [V] |
| Orch: the version must be set in `package.json` BEFORE the bundle (esbuild inlines `package.json`). | `orchestrator/.github/workflows/publish-orchestrator.yml` (steps "Set version" then "Bundle orchestrator CJS") [V] |
| machine today: one entry `bin.ts`, one file `dist/machine.cjs`, define `__MACHINE_VERSION__`, version read from `packages/machine-cli/package.json` (0.1.0), no `BUNDLE_VERSION`, no updater entry, no app-module copy. | `machine/packages/machine-cli/src/bundle.ts:8-21`; `scripts/bundle.mjs:26`; `src/version.ts:5-12` [V] |
| A bundle whose version is not CalVer `YYYY.M.D-NNN-<8 hex>` is a dev build: the updater refuses to run (exit 1 when forced). | `shared-cli/packages/shared-cli/src/ReleaseVersion.ts:40-44` [V]; `queue-updater-entry.ts:23-28` [V] |

### 1.4 Publication (CI, tokens, signing)

| Fact | Ref |
|---|---|
| One workflow per repo, `publish` job on ubuntu only, only on `main` (push or dispatch), after test jobs on 3 OS. Only `compute-version@main` of `ci-templates` is shared (unpinned: no tag exists). | `queue/.github/workflows/publish-queue-cli.yml:190-229` [V]; grep `uses: wadeck-app/ci-templates` in 6 workflows [V] |
| Registry GitHub Packages, scope `@wadeck-app`. Token in CI: `secrets.GITHUB_TOKEN` with `permissions: packages: write`. No npm token secret in the workflows I read. | `publish-queue-cli.yml:18-20,214,275,281`; `publish-orchestrator.yml:285,389,394`; `task/.github/workflows/publish.yml:43,158,164` [V] |
| Consumers read with a PAT (`read:packages`) in `~/.npmrc`, never in the repo. | `singleton-daemon-kit/CLAUDE.md` (Registry setup) [V] |
| **No signature, checksum, provenance or attestation** in any workflow I read (grep for `provenance`, `id-token`, `attest`, `sign`, `cosign`, `checksum`, `sha256`: only an orch `sha256sum` that names a binary hash for versioning). Accepted for machine by decision 38a. | grep over orch, queue, task, shared-updater workflows [V]; `orchestrator/.../publish-platform-packages.sh:31-40` [V] |
| Lazy `npm install -g <platform-pkg>` by the shim has no integrity check (listed as an active risk). | `ci-templates/.claude/threat-model.md:7` [V] |
| CalVer `YYYY.MM.DD-NNN-<sha8>`, dist-tag `latest` on every push to main; `npm version` blocked outside CI. | `orchestrator/.../ci/scripts/compute-version.sh:32-52` [V]; `singleton-daemon-kit/package.json` (`preversion`) [V] |
| Exec bit: artifact transfer drops it. Queue checks the packed tarballs; `ci-templates` ships `restore-exec-bits.sh` and `smoke-packed.sh`; task wires them in a `packed-smoke` job (macOS + ubuntu) before `publish`. | `publish-queue-cli.yml:242-256` [V]; `task/.github/workflows/publish.yml:100-135` [V]; `ci-templates/README.md` [V] |
| `project` runs `verify-install` and `verify-update` after publish on 3 OS in an isolated env (npm prefix, XDG, HOME, app-core dir redirected); verify-update installs the previous published version, updates, rolls back, updates again. | `project/.github/workflows/publish.yml:166-215` [V]; `project/packages/project-cli/ci/scripts/verify-lib.sh:105-136`, `verify-update.sh:1-50` [V] |
| Registry detail for Go: patch-pinned Go in orch (a new patch changes every binary hash). Queue uses `1.26`. Local machine has Go 1.26.5 and the kit ships `go-launcher/` in its npm package. | `publish-orchestrator.yml` (setup-go comment) [V]; `queue/...yml:207-209` [V]; `go version`, `machine/node_modules/@wadeck-app/singleton-daemon-kit/go-launcher` [V] |

### 1.5 Update

| Fact | Ref |
|---|---|
| `<cli> cli update` spawns `node <cli>-updater.cjs` (a separate process) with `UPDATER_FORCE=1`, stdio inherited. `cli rollback` reads `previousVersion` from `update-state.json` and runs `npm install -g pkg@prev`. | `shared-cli/.../CliMetaCommands.ts:75-98,100-118` [V]; wired in queue at `QueueIndex.ts:1500-1505` [V] (queue's usage line lists `version\|self-check\|update\|logs`, `QueueIndex.ts:1509`: rollback wiring there is [U]) |
| Background update: `UpdateManager.scheduleBackgroundUpdate` spawns the updater detached; refuses unless `isReleaseVersion`. Queue calls it from CLI invocations; orch's daemon calls it at start and every 30 min (`createUpdateScheduler`). | `UpdateManager.ts:35-52` [V]; `queue/.../QueueIndex.ts:1541` [V]; `orchestrator/.../update-scheduling.ts:1-80`, `index.ts:154,477` [V] |
| shared-updater without-daemon sequence: lock, repair of an interrupted `applying` state, `autoUpdate: false` check (bypassed by `UPDATER_FORCE`), throttle, `npm view <pkg> dist-tags.<channel>`, `semverLte`, `onUpdateAvailable` (apply or defer), state `applying`, `npm install -g pkg@ver`, `verifyInstalled` from the filesystem, self-check, state `success`; on any failure `ensureVersion(previous)` and state `failed`/`rolled-back`. | `shared-updater/src/strategies/without-daemon.ts:14-169` [V] |
| `autoUpdate` defaults ON; `<configDir>/config.yml` keys `autoUpdate`, `channel`, `checkInterval` (default 30 min). | `shared-updater/src/shared/config.ts:6,11-19` [V] |
| Self-check is `UPDATER_SELF_CHECK_CMD`; **when unset the check silently passes** (no rollback). Queue sets it to `node <npm root -g>/<pkg>/queue.cjs cli self-check` and only warns when `npm root -g` fails; orch aborts the update in that case. | `without-daemon.ts:215-228` [V]; `queue/.../updaterSelfCheck.ts:19-35` [V]; `orchestrator/.../src/updater/entry.ts:69-97` [V] |
| Queue self-check includes a check that the platform package version equals the bundle version. | `queue/.../src/cli/launcherPackage.ts:1-40`, `QueueIndex.ts:1417-1430` [V] |
| Post-update work is done by the updater of the version being REPLACED (it runs from the old bundle). `project` documents this and gates its verify on a capability marker in the old updater. | `project/.../ci/scripts/verify-update.sh:44-50` [V] |
| Queue re-registers the app-module after the update from the updater (`registerAfterUpdate`, only when the manifest version changed); queue does not restart its daemon. | `queue/.../queue-updater-entry.ts:40-66`, `registerAfterUpdate.ts:1-60` [V] |
| Orch restarts its daemon after a successful update: `restartDaemon` option writes `<configDir>/config.restart` then `POST /quit` with the `health_token` read from `config.port` + `health_token`. The launcher consumes the sentinel and relaunches node. | `without-daemon.ts:162-213` [V]; `shared-updater/src/types.ts:63-77` [V]; `orchestrator/.../updater/entry.ts:157-162` [V] |
| Orch guards against restart loops (3 update restarts in 30 min suspend automatic updates) and against an updater and a daemon looking at different npm prefixes (`nvm use`). | `orchestrator/.../update-guard.ts:1-40` [V]; `launcher-bundle.ts:1-32` [V] |
| Dev builds never touch the global install (incident 2026-10-24). | `queue-updater-entry.ts:19-22`; `ReleaseVersion.ts:46-57` [V] |
| `LAUNCHER_BUNDLE_OVERRIDE` leaks to child CLIs; `resolveOwnBundlePath` ignores an override naming another bundle. | `shared-cli/.../resolveOwnBundlePath.ts:1-32` [V] |

### 1.6 Windows locking and staging

| Fact | Ref |
|---|---|
| No pre-install stop of the daemon anywhere in shared-updater. | `without-daemon.ts:107-169` [V] |
| Orch never runs a native binary from `node_modules`: copied to `<configDir>/bin/<stamp>/<name>` (stamp = version of the platform package), via `<name>.partial` then rename, size compare, throw instead of a fallback; stale stamps pruned at daemon start, failures ignored (a running image cannot be deleted on Windows). | `orchestrator/.../src/platform-binary.ts:119-206,254-322` [V]; prune call `src/index.ts:450` [V] |
| Reason given in code: npm moves the package aside; on EPERM it copies file by file and copying a running exe is EBUSY. The old intermittent EBUSY was never explained. | `platform-binary.ts:119-127` [V]; `evidence.md` (orch-owner answer) [U] |
| Orch stages the app-module out of `node_modules` too (app-core stores a PATH and reloads from it): `<orchConfigDir>/app-module/<stamp>/`, pruned only after app-core accepted the new path. Queue registers straight from the installed package folder (no staging found). | `orchestrator/.../app-core-registration.ts:61-130` [V]; `queue/.../daemon/AppCoreRegistration.ts` grep `stage` found nothing [V] |
| The launcher must find the bundle when run from the staged folder: orch passes `LAUNCHER_BUNDLE_OVERRIDE` unless the bundle is under `<dirname(node)>/node_modules` (true on Windows, not on Unix prefixes with `lib/`); orch strips the variable from its jobs' environment. | `orchestrator/.../launcher-bundle.ts:1-32` [V]; `src/job-env.ts:21` [V]; `src/startup.ts:117,214` [V] |
| Test helpers for update without a registry: task has a loopback fake npm registry (`npm view`, `npm install -g`, hanging tarball) and an isolated-env helper using `npm_config_@wadeck-app:registry`; shared-updater's `MockRegistry` cannot start from the published package. | `task/packages/task-cli/src/fakeNpmRegistry.ts:1-30`, `isolatedCliEnv.test.ts:59` [V] |

## 2. Gaps between machine today and the facts

| # | Gap | Ref |
|---|---|---|
| G1 | `startup.ts` treats "native" as a **Node SEA** (`node:sea` `isSea()`), so with the sibling pattern it never takes the native branch and registers `"<node>" "<bundle>" daemon` (node.exe in Task Manager, bundle path inside `node_modules`). It must register the **staged launcher** instead. | `machine/packages/machine-cli/src/startup.ts:50,64-77` [V] |
| G2 | The staged launcher is outside `node_modules`, so launcher step 5 (walk up from its own folder) cannot find the bundle; on Unix step 4 fails too. The job command needs `LAUNCHER_BUNDLE_OVERRIDE` on Unix (and possibly Windows when node is not in the npm prefix). | `nodescript.go:49-105` [V]; `launcher-bundle.ts:10-13` [V] |
| G3 | The launcher resolves its config dir from `--config` or XDG, not from `--config-dir` / `MACHINE_CONFIG_DIR`: a custom `main.go.tmpl` is needed (as queue did). A leading absolute-path argument is consumed as config dir: `daemon` is safe, `--config-dir <path>` is passed through to node. | `launcher.go:449-479` [V]; `machine/packages/machine-cli/src/paths.ts:6-14`, `cli.ts:121` [V] |
| G4 | Workspace package is `@wadeck-app/machine-cli` (private): same name as the wrapper to publish; two such packages in `packages/*` break `npm install`. No source imports the name, only root `package.json` (`bundle` script) and the lock. | `machine/package.json`, `packages/machine-cli/package.json`; grep of the repo [V] |
| G5 | No updater entry, no `cli update|rollback|version|self-check|logs`, no scheduled background update, no `shared-updater` dependency (only `shared-cli`, `singleton-daemon-kit`). | `packages/machine-cli/package.json` [V]; grep `updater` in `src` [V] |
| G6 | No app-core registration code in machine-cli; `app-module-machine` has `bundle` = `app-core-cli package .`, `files: [dist-module]`. | grep `app-core`; `packages/app-module-machine/package.json` [V] |
| G7 | The daemon already uses `createDaemon` from the kit with `configDir`, so `config.port` + `health_token` + `POST /quit` exist for shared-updater's `restartDaemon`; machine also writes its own `daemon.port.json` (pid, ports) for orch liveness. | `daemonEntry.ts:78-94`, `daemonPortFile.ts:1-30` [V]; kit `src/health-server.ts:93-105`, `port-file.ts:4` [V] |
| G8 | No `.github/` in the repo. | `ls machine/.github` [V] |
| G9 | Decision 38 says "native binary"; the siblings' exe needs Node >= 22 installed. State it in the README and in `machine startup enable` errors. | `launcher.go:307` [V]; `engines.node >=22` in all package.json [V] |

## 3. Design

### 3.1 Packages

| Package | Published | Contents |
|---|---|---|
| `@wadeck-app/machine-cli` | yes, generated, `type: commonjs`, `bin: machine -> bin/machine.js` | `bin/machine.js` (shim), `machine.cjs`, `machine-updater.cjs`, `app-module/` (the `dist-module` of `app-module-machine`), `package.json`; `engines.node >=22` (orch's updater reads it with `npm view`: `updater/entry.ts:104-119` [V]); `optionalDependencies` pinned to exact platform versions; `publishConfig` registry + `access: public` |
| `@wadeck-app/machine-cli-win32-x64` | yes | `machine.exe` (launcher), `os: win32`, `cpu: x64` |
| `@wadeck-app/machine-cli-darwin-arm64` | yes | `machine` (launcher, exec bit) |
| `@wadeck-app/machine-cli-linux-x64` | yes | `machine` (launcher, exec bit) |
| workspace `machine-cli` (renamed, unscoped, `private: true`) | no | sources (family A rule, `cli-best-practices.md:48`) |

Decision proposed: rename the workspace package (G4) and generate the publishable folders in CI (family A, as queue, task, flow, project). Alternative: generate into a folder outside `packages/*` and keep the name; rejected because it is the only repo that would differ.

Platform table (single source, as `PLATFORM_TARGETS` in orch): `win32-x64`, `darwin-arm64`, `linux-x64`; any arch other than arm64 counts as x64; unsupported host = exit 1 first thing naming the supported list.

### 3.2 Version and platform package versions

- Wrapper version = `compute-version@main` output (CalVer, dist-tag `latest`).
- Platform package versions: **recommended = orch's hash-reuse** (`<build>-bin.<hash>`, republished only when the launcher bytes change; exact pin in the wrapper). The launcher has no machine-version content, so every update would otherwise re-stage the exe, rewrite the orch job command and restart. Simpler alternative (queue/task): all packages get the build version; every update changes the stamp, so `startup enable` always reports `updated`. Pin Go to a patch version (changes the hash).
- Exact pins make `npm install -g machine-cli@X` move the platform package in the same transaction and make a rollback restore the matching pair (`publish-platform-packages.sh:10-15` [V]).

### 3.3 Build steps and what to add in the repo

| Step | What | Reuse |
|---|---|---|
| Version | `BUNDLE_VERSION` env wins, else `package.json` (keeps dev builds non-CalVer so the updater refuses) | `bundle.ts:30` of queue |
| `npm run bundle` | keep `dist/machine.cjs`; add entry `machine-updater.cjs` (imports only `shared-updater`, `shared-cli/ConfigDir`, `shared-cli/ReleaseVersion`; 500 KB cap); run `app-module-machine` `npm run bundle` with `BUNDLE_VERSION` and copy `dist-module` to `<out>/app-module`; fail loudly when `manifest.json` is missing | queue `bundle.ts:96-121` |
| Launcher | `packages/machine-cli/ci/launcher.config.json` (`appName machine`, `nodeScript @wadeck-app/machine-cli/machine.cjs`, `defaultConfigDir machine`, `cliFlags []`), custom `launcher-main.go.tmpl` honouring `--config-dir` and `MACHINE_CONFIG_DIR` (G3), `ci/scripts/build-launcher.mjs` (copy of queue's, including its host-only mode and the "build.sh changed shape" guard) | queue `ci/` |
| Packages | `generate-platform-packages.sh` from `ci-templates` with `PLATFORMS=win32-x64,darwin-arm64,linux-x64`, `PKG_VERSION` set, shim from the shared template; copy-binaries; publish script with hash-reuse | `ci-templates/scripts`, orch `publish-platform-packages.sh` |
| Shim | `ci-templates` template: every command is `node machine.cjs`, stdio inherit (passphrase prompts and `--json` pipes work). Machine has no `start` command (daemon is `machine daemon`, started by orch), so the launcher branch of the template is not used by the shim: the shim only checks the platform and the bundle; the launcher is run by orch alone | `bin-launcher.js.tmpl` |
| Workflow | `.github/workflows/publish.yml`, see 3.8 | queue + task + project |

Rule from CLAUDE.md applies: new `@wadeck-app/*` dependencies (`shared-updater`, `app-core-sdk`) as `latest`; commit `package.json` and `package-lock.json` together; check `npm ci --dry-run`.

### 3.4 Runtime layout

```
<npm root -g>/@wadeck-app/machine-cli/            bin/machine.js, machine.cjs, machine-updater.cjs, app-module/
<npm root -g>/@wadeck-app/machine-cli-<plat>/     machine[.exe]   (never executed from here)
<configDir>/bin/<platform-pkg-version>/machine[.exe]   staged launcher, run by orch
<configDir>/app-module/<stamp>/                         staged app-module, registered with app-core
<configDir>/update-state.json, update-cache.json, .update.lock, logs/
```

- Staging code (new `platformBinary.ts` in machine-cli, port of orch `platform-binary.ts:119-322`): table, `findLauncher()` via `require.resolve('<pkg>/machine[.exe]')`, `stageBinary` (partial + rename, throw on failure), `pruneStaged`, `unsupportedPlatformMessage`. No fallback to the `node_modules` path.
- `machine startup enable` (fix of G1): command = `"<staged exe>" daemon [--config-dir <dir>]`, plus on Unix a `LAUNCHER_BUNDLE_OVERRIDE='<bundle>'` prefix when the bundle is not under `<dirname(node)>/node_modules` (rule of `launcher-bundle.ts`, G2). Started from sources it still refuses (existing text). The Node-only form `"<node>" "<bundle>" daemon` stays as the explicit non-launcher form (see question to orch-owner and user, section 7).
- Daemon start: prune staged folders of other stamps (failures ignored) and stage the module (see 3.7).
- `machine cli self-check` (run by node, never the launcher): version is CalVer, platform package present and same family as the wrapper, staged launcher creatable, config dir writable, daemon version when running, node >= 22. No identity access, no passphrase.

### 3.5 `machine cli update`, step by step

1. `machine cli update` (shim, node): `cliUpdateCommand(<dirname(bundle)>/machine-updater.cjs, '@wadeck-app/machine-cli')` spawns the updater with `UPDATER_FORCE=1` and inherited stdio (`CliMetaCommands.ts:75-98`).
2. Updater start: refuse a dev version (exit 1 when forced); compute `UPDATER_SELF_CHECK_CMD` from `npm root -g`; **abort the update when `npm root -g` fails** (orch behaviour, because an unset command means "check passed", `without-daemon.ts:220`).
3. `runUpdater({strategy: 'without-daemon', skipThrottle: true when started by the daemon, onUpdateAvailable})`: lock, repair, autoUpdate gate, `npm view`, compare, `onUpdateAvailable` (machine: apply now; defer while a local `machine run`/remote execution is in flight if the daemon can tell, see question), `applying` state, `npm install -g @wadeck-app/machine-cli@<v>` (platform package follows by exact pin), verify from the filesystem, self-check of the NEW bundle, state `success`; on failure restore the previous version (`failAndRestore`).
4. Post-update (only when state is `success` for this run), executed by spawning the **new** bundle so that fixes to this logic apply at the first update that installs them (`verify-update.sh:44-50` problem): `node <new machine.cjs> cli post-update`:
   a. `machine startup status`: if the orch job exists, run `startup enable` (stages the new launcher if the stamp changed, `orch ensure ... --restart-if-changed`). If the job does not exist, do nothing (decision: only when it exists).
   b. Restart the daemon (38b): if a daemon runs and reports a version different from the new one, `POST /quit` with the `health_token` (the daemon runs its `onShutdown` and exits 0); the orch job `--restart-on-exit` relaunches the command string. Not through shared-updater's `restartDaemon`, which also writes `config.restart` (that makes the launcher relaunch node itself and orch never sees an exit); see question to shared-updater owner. If step (a) already restarted it (`--restart-if-changed`), step (b) sees the new version and does nothing.
   c. No app-core call from the updater: the restarted daemon registers the module at start (3.7).
5. `machine cli rollback`: `CliMetaCommands.ts:100-118` then the same `cli post-update` (it only reinstalls; startup and restart must follow).
6. Output: `[ok]`/`[fail]` lines naming version, state file and the manual command (`npm install -g @wadeck-app/machine-cli@<prev>`); the next CLI invocation shows the result of a background update (`readAndClearState`, `QueueIndex.ts:933-940` pattern).
7. Background: the daemon (long-running, like orch) requests the updater at start and every 30 min through a `createUpdateScheduler` port, with the loop guard (`update-guard.ts`) and the `autoUpdate: false` gate in `<configDir>/config.yml`. Default ON as in the siblings; the work laptop sets it off (AR-9, user parameter).

### 3.6 The Windows case: `machine.exe` is running

Process chain: orch -> `cmd.exe` -> staged `<configDir>/bin/<stamp>/machine.exe` (launcher, GUI subsystem) -> `node.exe machine.cjs daemon` (bundle from `node_modules`).

| File touched by npm | Locked? | Why |
|---|---|---|
| `node_modules/@wadeck-app/machine-cli-win32-x64/machine.exe` | no | never executed: only the staged copy runs (`platform-binary.ts:119-127` pattern) |
| `node_modules/@wadeck-app/machine-cli/machine.cjs` | not expected | node reads the script and keeps no handle; orch's daemon is updated the same way with no pre-install stop. The updater itself runs from this folder, as queue's and orch's do. **[U] not tested for machine on Windows.** |
| `<configDir>/bin/<old stamp>/machine.exe` | yes while it runs | pruning ignores the failure and retries at next daemon start |

Rules: the daemon's working directory must not be inside `node_modules` (launcher sets no `cmd.Dir`, `launcher.go:296-345` [V]: the cwd is what orch gives); a hash-reuse stamp avoids re-staging; `startup enable` never deletes a running staged exe; `orch stop` kills the tree hard (taskkill /T /F, orch-owner [U]), so the daemon must tolerate it (it does: port file only trusted with a live pid, `startup.md`).

### 3.7 App-module

- Ships inside the wrapper as `app-module/` (queue `bundle.ts:96-113`, orch `copy-app-module.sh`).
- The daemon registers it at start (port of orch `registerOnStart`, `app-core-registration.ts:150-210`): skip when app-core's config dir does not exist; stage the module to `<configDir>/app-module/<stamp>/` because app-core stores a path and npm deletes the package folder on update (`app-core-registration.ts:61-78`); prune older stamps only after app-core accepted the new path; never throws (a log line). Uses `@wadeck-app/app-core-sdk/register` `registerModule` (`latest`).
- `machine cli register` (decision 38a) = same function, run by hand.
- The module backend must read the same config dir as the daemon (already `app-module-machine/src/backend/configDir.ts`).

### 3.8 Workflow (`.github/workflows/publish.yml`)

Jobs, modelled on queue + task + project:

1. `build-and-test`: matrix ubuntu/windows/macos (Windows is the developer platform: queue and orch also run it there), `npm ci`, `npm run typecheck`, `npm test`, Go setup (pinned patch) for the launcher test, `npm run bundle`.
2. `packed-smoke`: build packages as an artifact, restore exec bits, `smoke-packed.sh` on macos-latest (arm64) and ubuntu.
3. `publish` (needs 1 and 2, `main` only, ubuntu): version, set version, bundle (with `BUNDLE_VERSION`), build launchers, generate, copy, exec-bit check, hash-reuse publish of platform packages with pin, publish wrapper. `permissions: contents: read, packages: write`, `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`. `concurrency` as queue (no cancel on main).
4. `verify-install` and `verify-update` on 3 OS after publish (copy `project` scripts: isolated prefix/HOME/XDG, `autoUpdate: false`, update from the previous version, rollback, update again). Add a Windows step: start a daemon from the staged launcher, run the update, confirm no EBUSY and the new version answers (this is the check `_index.md` asks for before the first release).
5. No signing or provenance step (decision 38a). Recorded risk: the updater runs code from the registry with the user's rights on a machine holding an identity key (see threat model hard rules before touching it); mitigations available in the siblings' stack: none.

## 4. Tests that can be written without publishing (TDD, P-7)

| # | Test | Where |
|---|---|---|
| T1 | Platform table: keys, package names, file names, `optionalDependencies`, workflow matrix, generate script and `PLATFORMS` all agree (orch has such a test: comment at `platform-binary.ts:12-14`) | vitest, repo files read |
| T2 | `stageBinary`/`pruneStaged`: copy once per stamp, short copy replaced, partial then rename, throws when source unreadable, no fallback, prune skips locked/running (simulate) | tmp dirs |
| T3 | `daemonCommand` for the staged launcher: quoting on win32/unix, `--config-dir`, `LAUNCHER_BUNDLE_OVERRIDE` rule (port of `launcher-bundle.ts` cases), refusal from sources; update existing `startup.test` that assumes `isSea` | unit |
| T4 | Shim `run(deps)`: unsupported platform, missing bundle, stdio default inherit, `--cli-background`, exit code pass-through, error text with fix (template has injectable deps; task has `binShim.unit.test.ts`) | unit |
| T5 | Generated packages: run the generate and pin scripts into a tmp dir; assert `os`, `cpu`, `files`, no `>=0.0.0-0`, exact pins, `engines`, `bin`, no `private` | script test |
| T6 | `npm pack` of the generated folders (no registry): tarball file list and sizes; on Linux/macOS also exec bits (Windows modes are meaningless: run in CI only) | script test + CI |
| T7 | Go launcher: `go build` host-only into a tmp dir with the custom template; run `machine daemon --config-dir <tmp>` against a fake bundle via `LAUNCHER_BUNDLE_OVERRIDE`; check logs go to the given dir, `--config-dir` reaches node, exit code forwarded, restart sentinel honoured. Go 1.26.5 is installed here; queue has the same style of test (`launcherConfigDir.integration.test.ts`, [U] not read) | integration |
| T8 | Updater against a loopback fake registry (copy the shape of task's `fakeNpmRegistry.ts`) with an isolated npm prefix and `npm_config_@wadeck-app:registry`: update, dev-build refusal, self-check failure then rollback, interrupted `applying` repair, `npm root -g` failure aborts, `autoUpdate: false`, `UPDATER_FORCE` | integration, loopback only |
| T9 | `cli post-update`: job absent -> nothing; job present -> `startup enable` called with the staged path; daemon older -> `POST /quit` sent once; daemon already new -> nothing; fake orch (injectable, as `startup.ts` already is) | unit |
| T10 | Daemon self-exit: a started daemon exits 0 on `POST /quit`, removes `daemon.port.json`, closes the peer listener | existing `daemon.test.ts` style |
| T11 | Bundle: `machine-updater.cjs` size cap, imports nothing from the runtime (grep the bundle), version inlined, `BUNDLE_VERSION` wins, `dist-module` copied and manifest present (extend `bundleScript.test.ts`) | script test |
| T12 | App-module registration: skipped without app-core dir, staged copy per stamp, prune after accepted, never throws, registration failure is a log line | unit with fake SDK |
| T13 | Update-loop guard and 30-min scheduler (port of orch tests) | unit |
| T14 | Real-process: install both local tarballs into an isolated prefix (`npm install -g <wrapper.tgz>`), run `machine --version`, `cli self-check`, `startup enable --dry` against the fake orch. Whether npm resolves the exact-pinned optional dependency from a local tarball without a registry is [U]: use the fake registry (T8) to serve both tarballs if not | integration |

All of these run on the user's desktop with temp folders and loopback only; none loops or stresses the machine.

## 5. What cannot be verified without a real publish

| Item | Why |
|---|---|
| `npm publish` with `GITHUB_TOKEN` of the `machine` repo for the 4 new package names: package creation, repo linking, visibility, `access: public`, read access for the other machines (PAT scope) | GitHub org settings, never exercised for these names; the generated queue wrapper has no `repository` field (generator lines 35-62) and still publishes, reason [U] |
| `os`/`cpu` filtering of optional dependencies by GitHub Packages (the GitLab registry did not expose them, `cli-best-practices.md:30`) and install of the exact-pinned platform package | registry behaviour [U] |
| Exec bits in the real published tarballs; Mac behaviour of the launcher | needs the CI macOS runner and an Apple silicon machine (none locally) |
| Update while the daemon runs on Windows (no EBUSY on `machine.cjs`, staged exe), including antivirus and SmartScreen on an unsigned Go exe | the old orch EBUSY was intermittent and never explained |
| Restart chain end to end: daemon `POST /quit` -> launcher exit 0 -> orch `--restart-on-exit` -> new bundle; `orch ensure --restart-if-changed` on a running job; restart counted in `maxRestarts` | orch-owner's recommendation is untested (38b) |
| Launcher finding the bundle from the staged folder under orch's environment (PATH, no override) on Windows, macOS, Linux | G2; needs a real orch job |
| `npm install -g` on nvm/Node switches, corporate proxy, `~/.npmrc` of the daemon's user | environment |
| Linux i7 box: orch not yet run there (user) | the launcher and job chain are untested on that host |
| Provenance/signature | none exists; a `release_signing_key*` pair sits at the workspace root, not referenced by any workflow I read; its purpose is [U] (not opened) |

## 6. Work breakdown (WP9 split, ordered)

| Id | Work | Depends on | Owners involved |
|---|---|---|---|
| 9.0 | Answers to section 7 (job form, stamp policy, restart mechanism, rename) | - | orch-owner, shared-updater owner, user |
| 9.1 | Rename workspace to `machine-cli`; `BUNDLE_VERSION`; add `shared-updater` and `app-core-sdk` deps; lock check. **Status 2026-11-14: partly done.** Done: rename (unscoped, private, as queue-cli), root `bundle` script, lockfile regenerated offline, `BUNDLE_VERSION` in `scripts/bundle.mjs` (empty value fails loudly), `npm ci --dry-run` passes. Not done: `shared-updater` and `app-core-sdk` dependencies (belong with 9.5 and 9.7, need the network and the owner) | 9.0 | - |
| 9.2 | `platformBinary.ts` + T1, T2; fix `startup.ts` (G1, G2) + T3. **Status 2026-11-14: partly done.** Done: `platformBinary.ts` (table, find, stage, prune), `startup.ts` registers the staged launcher when the platform package is installed (Unix `LAUNCHER_BUNDLE_OVERRIDE='<bundle>' '<exe>' daemon` by the `launcher-bundle.ts` rule; quote in a path refused), prune only after `orch ensure` returned 0, development form `node <bundle> daemon` kept and labelled when no launcher package exists, `status` reports registered and expected form. Not done: T1 cross-file check (workflow, generate script) since those files do not exist yet; **Windows when the bundle is not under `<node dir>/node_modules` (the usual global prefix in %APPDATA%) is refused**, because orch.cmd cannot carry `LAUNCHER_BUNDLE_OVERRIDE` (`&` is refused by `buildShellLine`): open question for orch-owner; nothing run against the real launcher or a real package | 9.0 | orch-owner (job command and env) |
| 9.2a | Windows job when the launcher cannot find the bundle (bundle not under `<dirname(node)>/node_modules`). **Status 2026-11-14: implemented, not run under orch.** Form `launcher-wrapper`: `"%SystemRoot%\System32\wscript.exe" //B //Nologo "<configDir>\bin\<stamp>\machine-daemon.vbs"`. The script (fixed template, CRLF, ASCII, three validated paths; quote, `%`, control and non-ASCII characters refused with the fix) sets `LAUNCHER_BUNDLE_OVERRIDE` in the process environment of the script only, runs the staged launcher `daemon [--config-dir <dir>]` hidden (style 0) and waits, then `WScript.Quit` with its exit code (so `--restart-on-exit` works). It lives in the stamp folder: pruned and `ensure`-ordered like the exe. `status` compares the command AND the script on disk (`wrapper script: current / missing / different`). Not verified: a real launcher run under orch on Windows (orch-owner offered it); a moved bundle changes the script, not the command, so `--restart-if-changed` does not restart a running daemon by itself. | 9.2 | orch-owner (suggested the form) |
| 9.3 | Launcher: config, custom template, build script, T7. **Status 2026-11-14: done for the host (Windows), partial overall.** Done: `packages/machine-cli/ci/launcher.config.json` (`nodeScript` `@wadeck-app/machine-cli/machine.cjs` as in 3.1/3.3, not `.../dist/machine.cjs`; `silentFlags` `--help`, `-h`), `ci/launcher-main.go.tmpl` (`--config-dir` before the first `--`, last wins as in `cli.ts`; then `MACHINE_CONFIG_DIR`; then `$XDG_CONFIG_HOME/machine` or `~/.config/machine`, no legacy migration; arguments handed to node untouched, `--config`/leading path of the SDK not used; `node` missing from PATH = exit 1 with cause, "Node.js 22 or newer" and the fix, on stderr and in `<configDir>/logs/<day>-launcher.log`), `ci/scripts/build-launcher.sh` (runs a patched copy of the kit's `build.sh`, only the wanted targets, fails when `build.sh` changes shape, `--out`, `--platforms`; output `dist-launcher/<platform>/machine[.exe]`, ignored by git), `ci/launcher-main_test.go` (run by `src/launcherGo.test.ts` on the rendered template) and `src/launcherGo.test.ts` (13 tests: go test; the Windows exe built once, run against a fresh bundle and a stub bundle: `--help`, `status --config-dir`, exit codes 1/7/255, flag > env > XDG default, argument fidelity of `run x -- a "b c"` and awkward arguments, stdin, node missing). All three targets build here with CGO off and `GOPROXY=off` (no download). Facts: the kit builds ONE Windows variant (`-H windowsgui`, node started with CREATE_NO_WINDOW), no console variant; output reaches the caller only when stdout is a pipe or file, so terminal commands must use the shim (`node machine.cjs`), the exe is for orch and the daemon. The kit checks node presence only: no version check (a version check would need one more process); Node >= 22 is stated in the message and enforced by `engines`. Not verified: darwin-arm64 and linux-x64 binaries were built but never executed; the Unix files built on NTFS have no exec bit (CI must set/check it, 9.4); Windows launched by orch from a staged folder (G2) untested; `goversioninfo` was present locally (PE metadata embedded), CI must set `LAUNCHER_REQUIRE_PE_METADATA=1`; Go is not patch-pinned here (CI must pin it, 3.2). Kit questions 1-2 (7) still unanswered: the template route is the one queue uses | 9.1 | singleton-daemon-kit owner (template contract) |
| 9.4 | Generate/pin/publish scripts, shim, T4, T5, T6 | 9.1, 9.3 | queue-owner (which shim/exec-bit scripts are canonical) |
| 9.5 | Updater entry, `cli update|rollback|version|self-check|logs|post-update`, T8, T9, T11 | 9.1, 9.2 | shared-updater owner |
| 9.6 | Daemon: scheduler, update loop guard, self-exit on `POST /quit` check, prune at start, T10, T13 | 9.2, 9.5 | shared-updater owner |
| 9.7 | App-module: copy into bundle, daemon registration with staging, `cli register`, T12 | 9.1 | app-core-owner |
| 9.8 | `publish.yml` (build, packed-smoke, publish) | 9.3-9.7 | - |
| 9.9 | `verify-install`, `verify-update`, Windows running-daemon update check | 9.8 first publish | orch-owner (job from staged exe) |
| 9.10 | First real publish and manual checks of section 5 on Windows x2, Mac, Linux i7; update `_index.md` (38c "to confirm", evidence) | 9.8, 9.9 | user |

9.2, 9.3, 9.7 can run in parallel after 9.1; nothing here needs a publish until 9.8.

## 7. Questions for the owners

**orch-owner**
1. `orch ensure startup machine --command ... --restart-if-changed`: when only the command string changed and the job is running, does orch restart it immediately? Does the restart count in `maxRestarts`?
2. Unix job commands: can the shell string carry `LAUNCHER_BUNDLE_OVERRIDE='<bundle>' '<exe>' daemon`? Is the job's PATH the login-shell PATH (so the launcher finds `node`, `launcher.go:307`)? How do your own login entries do it on Windows without an override (`startup.ts:117,214` set it on mac/Linux only)?
3. Does a clean exit 0 of the launcher always trigger `restartOnExit`, and does the restart re-run the stored command string with the stored (old) staged path? What happens when that old staged folder was pruned meanwhile?
4. Is `publish-platform-packages.sh` (hash-reuse) meant to be reused by other repos, and should it move to `ci-templates`? Same for `update-guard.ts` and `update-scheduling.ts`: copy or extract?
5. After our first build, can you check a job started from the staged launcher on your Windows and Ubuntu hosts (already planned in the phase 1 plan)?

**shared-updater owner**
1. `restartDaemon` always writes `config.restart` before `POST /quit`: with a launcher in the chain the launcher relaunches node itself and orch sees no exit. Is the sentinel acceptable for machine (then 38b is satisfied by the launcher), or can you add an option to POST `/quit` without the sentinel? Until then machine does the POST itself after `runUpdater`.
2. An unset `UPDATER_SELF_CHECK_CMD` passes silently (`without-daemon.ts:220`): can there be an option "self-check required" (orch works around it in `entry.ts:69-97`)?
3. Is there a hook that runs after `success` while the lock is still held? Today post-update work runs after `runUpdater` returns, outside the lock.
4. `MockRegistry` cannot start from the published package (task's note in `fakeNpmRegistry.ts`): will it be fixed, or should repos keep private fake registries?
5. Can `onUpdateAvailable` be given a "daemon says busy" signal without importing the runtime (machine: defer while a remote execution is running)?

**queue-owner**
1. Which shim is canonical for a new CLI: `ci-templates/templates/bin-launcher.js.tmpl` (stdio inherit by default) or the generated queue one that discards output when stdin is not a TTY (`bin-launcher.js.tmpl:31-35`)? Machine needs `machine list --json` in pipes and passphrase prompts.
2. Which exec-bit protection is canonical: your inline tarball check (`publish-queue-cli.yml:242-256`) or `restore-exec-bits.sh` plus `smoke-packed.sh`?
3. Queue registers the app-module from the installed folder (no staging found): is app-core fine with that path disappearing at update, and is that why `registerAfterUpdate` exists?
4. Why no daemon restart after update besides "short-lived daemon" (answer already in `evidence.md`): any objection to machine restarting its daemon?

**app-core-owner**
1. Contract of `registerModule` when the manifest lives in `<configDir>/app-module/<stamp>/` and app-core is not running (pickup file): is a re-registration at every daemon start idempotent and cheap?
2. Does `app-core-cli package .` read `BUNDLE_VERSION` and produce a self-contained `dist-module` (no `node_modules` reference) for the machine module, whose backend imports `machine-core`?
3. Any reserved or conflicting module id for `machine`?

**singleton-daemon-kit owner** (not in the current list)
1. Is the custom `main.go.tmpl` route (queue's) the supported way to honour a `--config-dir` flag and `MACHINE_CONFIG_DIR`? Any plan to add `CrashRestart` for daemons run by orch?
2. Does `ResolveNodeScript` step 5 (walk up from the exe) have a supported variant for a staged exe, or must every consumer pass `LAUNCHER_BUNDLE_OVERRIDE`?

**User**
1. Job form: staged launcher (decision 38c, this design) or the existing `"<node>" "<bundle>" daemon` form that needs no staging and no Go build (G1, G2)? The design implements 38c as decided; the cost is Go in CI, three binaries, and the override rule on Unix.
2. Platform package versions: hash-reuse (recommended, more CI script) or the simple queue way (more restarts)?
3. Rename the workspace package to `machine-cli` (G4)?
4. GitHub side: are Actions enabled on `wadeck-app/machine`, may its `GITHUB_TOKEN` create new packages in the org, and what visibility must they have for the other machines' PAT?
5. `autoUpdate` for the work laptop (AR-9) and the default 30-minute interval.
6. Accept that the exe needs Node >= 22 installed (G9)?

## 8. Answers received (2026-11-14, read from code by the owners, not run)

**Decisions taken by machine-owner (reversible, D28-D30):** staged launcher job form (38c as decided); hash-reuse for platform packages; rename the workspace package to unscoped private `machine-cli` (to confirm in 9.1); Node >= 22 required. Not decided: `autoUpdate` default for the work laptop (AR-9), GitHub Actions and package permissions for this repo (no workflow exists yet; the repo is public).

**orch-owner**
- `orch ensure --restart-if-changed` sends `restart-job` after the edit: tree kill (wait up to 15 s), then immediate start as a manual firing; it does NOT count in `maxRestarts`. A start refused by liveness or concurrency makes `ensure` exit 1 "updated but not restarted" (the edit stays written). Without the flag a running instance keeps the old command until its next start.
- Unix: `LAUNCHER_BUNDLE_OVERRIDE='<bundle>' '<exe>' daemon` works as one string given to `sh` (a quote inside a path is not supported). Jobs do NOT inherit the daemon's launcher variables, so the override must be in the string. A job inherits the daemon's PATH (macOS: login-shell PATH captured in the plist; Linux: systemd unit `pathEntries`, not verified by orch-owner; Windows: user PATH of the session that started the daemon, not verified on a fresh login).
- Exit 0 always restarts (restartOnExit), never after a manual stop; the restart re-reads the STORED command string. If the old staged folder was pruned the start fails (exit 127 or 1) and backs off until `maxRestarts` (10 in 300 s), then `job.restart_abandoned`. RULE: after every update call `ensure ... --restart-if-changed` BEFORE pruning the old staged folder, and prune only after `ensure` returned 0.
- `publish-platform-packages.sh` is generic in idea (hash suffix, reuse a published version with the same hash, exact pin); orch-owner suggests extracting it to `ci-templates` (owner: project-owner). `update-guard.ts` and `update-scheduling.ts`: copy unless the same long-lived-launcher restart loop exists.
- orch-owner will check a job started from the staged launcher on Windows once a build exists (give them the exe path and version); no Ubuntu host in their session: the user validated orch on Ubuntu.

**queue-owner**
- No owner session exists for `shared-updater` and `singleton-daemon-kit` (repos wadeck-app/shared-updater and wadeck-app/singleton-daemon-kit): the questions shared-updater 1-5 and kit 1-2 of section 7 are unanswered; the facts can be read in those repos, and any change goes through the user.
- The shim is queue's own template (`queue-cli/ci/templates/bin-launcher.js.tmpl`): with no flag and a non-TTY stdin it ignores stdio (a GUI-parent workaround for flow.exe); since a7a02ee every command except `start` runs the bundle with node directly. For machine: do NOT copy the auto-ignore branch (pipes and passphrase prompts need inherited stdio).
- Exec-bit protection in queue: an inline tarball check in `publish-queue-cli.yml:242-256` plus a permission step in `copy-binaries.sh`; no `restore-exec-bits.sh` found.
- Queue registers the app module from the installed global folder (no staging); `registerAfterUpdate` re-registers when the manifest version changed, because the daemon is short-lived and the update does not restart it. No objection to machine restarting its daemon.
- The `config.restart` sentinel is written in `restartDaemon` only when `cfg.restartDaemon` is set; queue does not set it. `UPDATER_SELF_CHECK_CMD` is read from the environment (queue sets it itself); no after-success hook or busy signal was found in the exports seen.
