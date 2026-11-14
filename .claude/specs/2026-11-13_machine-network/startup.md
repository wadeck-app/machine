# Startup registration with orch

**Version:** v0.1 (2026-11-14). Contract frozen with orch-owner. Implements decision 3 (orch `startup` job) without a manual `orch add`.

## Contract (orch side, built by orch-owner, ships in an orch release)

- `orch ensure startup <id> --command "<shell string>" [any add flag] [--restart-if-changed] [--json]`: missing -> add; identical -> no-op; different -> edit. stdout `added|updated|unchanged <id>` (JSON with `--json`). Exit 0 for the three, 1 error, 2 daemon cannot start, 4 usage. Only the flags passed are compared; fields edited by hand and not passed are left alone.
- `orch remove <id> --if-exists`: exit 0 whether it existed; stdout `removed|absent <id>`.
- `--command` is a shell string (cmd.exe on Windows, sh elsewhere): the executable path must be quoted by the caller (`"C:\path with space\machine.exe" daemon`, `'/path with space/machine' daemon`). The stored string is compared exactly, so a moved path counts as `updated`.
- Liveness flags are those of `add`: `--liveness-strategy portFile --liveness-port-file <path>`. The file is JSON with a numeric `pid`; a live pid skips the start (audited). Whether a restart-on-exit restart goes through the same check is not yet verified by orch-owner.
- `orch install` is idempotent (start of the orch daemon at login, user level, no admin). A CLI must not call it by itself: it changes login behaviour for all of orch.

## Machine side (todo #18)

- `machine install`: checks that `orch` exists (spawn error -> "orch is not installed: npm i -g @wadeck-app/orchestrator-cli"), then `orch ensure startup machine --command "<quoted exe> daemon" --restart-on-exit --timeout 0 --restart-if-changed --liveness-strategy portFile --liveness-port-file <configDir>/daemon.port.json --json`. If orch's own login entry is missing it prints `run: orch install` and does not run it.
- `machine uninstall`: `orch remove machine --if-exists`.
- `machine join` calls `install` at its end; the updater calls it after each update (WP9). Exit codes of orch are mapped to actionable messages, never silent.
- The daemon writes the port file (JSON with its `pid`) only while it runs and removes it at exit; a stale file would make orch skip the start.
- Until `orch ensure` ships: emulate with `orch show <id> --json` (exit 3 = absent), then `add` or `edit`, behind one function.
