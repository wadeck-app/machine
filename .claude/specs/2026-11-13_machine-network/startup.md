# Startup registration with orch

**Version:** v0.2 (2026-11-14). Contract frozen with orch-owner; `orch ensure` and `orch remove --if-exists` are released. Implements decision 3 (orch `startup` job) without a manual `orch add`.

## Contract (orch side, released)

- `orch ensure startup <id> --command "<shell string>" [any add flag] [--restart-if-changed] [--json]`: missing -> add; identical -> no-op; different -> edit. stdout `added|updated|unchanged <id>` (JSON with `--json`). Exit 0 for the three, 1 error, 2 daemon cannot start, 4 usage. Only the flags passed are compared; fields edited by hand and not passed are left alone.
- `orch remove <id> --if-exists`: exit 0 whether it existed; stdout `removed|absent <id>`.
- `--command` is a shell string (cmd.exe on Windows, sh elsewhere): the executable path must be quoted by the caller (`"C:\path with space\machine.exe" daemon`, `'/path with space/machine' daemon`). The stored string is compared exactly, so a moved path counts as `updated`.
- Liveness flags are those of `add`: `--liveness-strategy portFile --liveness-port-file <path>`. The file is JSON with a numeric `pid`; a live pid skips the start (audited). Whether a restart-on-exit restart goes through the same check is not yet verified by orch-owner.
- `orch install` is idempotent (start of the orch daemon at login, user level, no admin). A CLI must not call it by itself: it changes login behaviour for all of orch.

## Machine side (implemented, todo #18)

- Commands: `machine startup enable | disable | status` (status shows whether the orch job exists, its command and whether it is up to date; exit 0 either way, never silent).

- `machine startup enable`: checks that `orch` exists (spawn error -> "orch is not installed: npm i -g @wadeck-app/orchestrator-cli"), then `orch ensure startup machine --command "<quoted exe> daemon" --restart-on-exit --timeout 0 --restart-if-changed --liveness-strategy portFile --liveness-port-file <configDir>/daemon.port.json --json`. If orch's own login entry is missing it prints `run: orch install` and does not run it.
- `machine startup disable`: `orch remove machine --if-exists`.
- `machine join` never enables the startup job by itself: at its end it prints the suggestion `machine startup enable`; with `--auto-startup` it runs `startup enable` as its last step (user decision 2026-11-14). The updater calls `startup enable` after each update only when the job already exists (WP9); the updater calls it after each update (WP9). Exit codes of orch are mapped to actionable messages, never silent.
- The daemon writes the port file (JSON with its `pid`) only while it runs and removes it at exit; a stale file would make orch skip the start.
- Implementation: `startup.ts` (library, orch injectable for tests only; no `--orch` option), `cliStartup.ts`. The command is `"<node>" "<bundle>" daemon` (native binary: `"<exe>" daemon`) and gets `--config-dir <dir>` when the configuration folder is not the default (orch's environment is not the user's). Started from sources (not a .cjs/.js bundle) it refuses and says `npm run bundle`.
- On Windows `orch.cmd` runs through cmd.exe; a path or argument containing `& | < > ^ %` is refused loudly.
- Not in the frozen contract, accepted tolerantly: the JSON shape of `ensure`/`remove` (any string field equal to the outcome word) and of `show` (`command` at top level or under `job`). Not verified against the real orch.
- `machine join --auto-startup`: runs enable after a successful join; a failure is reported and join exits 1 (the join is kept).
- Port file: `<configDir>/daemon.port.json` = `{pid, port, peerPort}`, mode 0600, written last (listeners up), removed on stop, signals and process exit only if it still names this pid.
- Bundle: `npm run bundle` writes `dist/machine.cjs` (git-ignored).

## Verified against the real orch (2026-11-14, orch 2026.11.14-592)

A throwaway job (library-only options `id` and `restartOnExit`, default `machine` and true) was ensured with a command holding three quoted segments with spaces and, in a second run, parentheses: stored byte for byte, then `unchanged`, `updated`, `removed`; the job list was identical afterwards. The real `machine` job has not been registered on this machine yet.
