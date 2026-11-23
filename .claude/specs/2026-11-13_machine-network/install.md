# `machine install`

Decision 87 (user request 2026-11-22). Sets up an item on THIS machine, with the facts of this machine. Items, both Linux only: `suspend` (below) and `idle-suspend` (decision 101, `idle-suspend.md`).

## Scope

- LOCAL command, run by the owner in a terminal on the box. No daemon command, peer frame, app-module route or API exists for it (hard rule 7: the daemon is never elevated). A test fails if a daemon-side source imports the executor.
- Root actions are `sudo` child processes sharing the owner's terminal: the owner types HIS password to sudo itself. machine never reads, stores, logs or passes it (hard rule 8).
- Refuses without a terminal (stdin and stderr), `--yes` included. `--dry-run` and `--check` need none.

## Commands

| Command | Effect |
|---|---|
| `machine install`, `machine install status` | Same read-only list, one compact block per item (see below). `--json` supported, unchanged. |
| `machine install <id>` | Shows state, every file (exact content, owner, mode, sha256) and every command, asks y/N (`--yes` skips), runs, then checks with `sudo -n -l`. |
| `--dry-run` | Prints the plan. Runs nothing, not even sudo (the root-only rule is reported as not read). |
| `--check` | State of one item. Exit 0 only for `installed`, 1 for every other state, 2 for a usage error. Never asks a password. |
| `--refresh` | Force: the whole plan again (both files, visudo, verification) even when `installed`; same plan display, y/N, terminal and foreign-file refusal as install. |
| `--remove` | Shows then removes exactly the managed files (rule first, script second). Refuses everything if one file is foreign. Post-check: the files are read again; anything left fails with path, owner and the sudo command to remove it. |

### The list

State first, no generic text repeated, lines cut to the terminal width (the `machine log -f` logic; 80 when it is not a terminal). The long description is in `<id> --dry-run` and `--help`.

```
suspend  installed, up to date
  lets `machine run` suspend this box (one sudoers rule); wake: `machine wake`
idle-suspend  installed, up to date  (suspends after 5 min idle (RDP: 20 min))
  suspends this box by itself when really idle (root timer, every 2 min)
  note: xprintidle missing, input idleness is not checked, and an RDP connection counts as activity:
    sudo apt install xprintidle
  last: 18:13:56 not idle: rdp connected (input 3 min ago, needs 20) (3 min ago)
```

- `last:` and `last decision:` are wrapped on indented lines, never cut (the cause is at the end of the line; a word longer than the width is broken).
- `note:` lines are what this machine lacks for the item to work fully (idle-suspend: xprintidle, decisions 102 to 105); read-only probe (`command -v`), never installed by `machine install`. Also in `--dry-run`, `--check` and `--json` (`details`).

- `last:` is the journal line without host, tag and pid, in local time with its age; a line that does not parse is shown whole; an unreadable journal says so and names the `sudo` command. `--check` and `machine status` use the same parsed text.
- `not installed`, `partial`, `outdated`, `foreign` add `next:` (and `missing:`). A platform that cannot run it is one line: `<id>  not supported here (platforms: linux)`; a supported platform whose plan cannot be built (missing tool) adds the cause and the fix, wrapped.
- The one-line summary is `Installable.summaryLine` (machine-core, at most 80 characters, tested).

`--minutes <n>` and `--rdp-minutes <n>` (decision 103, default 20) (`idle-suspend` only; usage error 2 elsewhere, with `--check`, `--remove`, `status`, or outside 1..1440) goes with install, `--refresh` and `--dry-run`. `--check` cannot be combined with another flag; `--refresh` and `--remove` exclude each other; `--dry-run` goes with install, `--refresh` and `--remove`. `status` takes only `--json`.

Unsupported platform: `not supported on <platform> yet (supported: linux)`, exit 1, nothing run. Unknown id: exit 2.

## Shape (to add an item)

`packages/machine-core/src/install.ts` is pure (no I/O). An `Installable` is `{id, description, platforms, consequence, plan(facts), next(plan, name), afterRemove(plan, name)}`; add it to `INSTALLABLES` and to the group help in `cliHelp.ts` (a test fails on drift).

- Facts: platform, user name, absolute tool paths, measured by the executor.
- `plan(facts)` returns data and throws `InstallError` on an unsupported platform or an unsafe fact: `files` (path, mode, owner, content, sha256, `rootOnly`), `steps` (`stage` a temporary file, `run` a command: validate, install), `removeSteps`, `probe` (a never-prompting command that exits 0 when installed).
- A file carries `# managed by machine install <id>, version <n>`. Present without it: foreign, never touched. Same marker, other sha256: outdated.
- Executor (`installFlow.ts`) takes an injected fs and exec (`installEnv.ts`); tests use `installTesting.ts`. `env.context` carries what the command line gives the plans (config folder, `--minutes`); optional tools (`date`, `ss`, `systemd-inhibit`, `logger`, `journalctl`) are measured on Linux and a plan that needs one refuses by name when it is absent.
- A plan whose item runs as a systemd unit sets `service` (the probe is then `systemctl is-active --quiet <unit>`, no sudo): a status `installed` is confirmed by it, else it reads `partial` (`<unit> is not running`, next step `--refresh`), and an install of current files starts the unit again. It may also set `summary` and `lastDecisionArgv` (read-only lines of the status; a failure of that command is never an error). A file may have several removal steps (`disable --now` before its `rm`).

## Lifecycle

Contract for every installable (`INSTALLABLES`); the tests in `install.test.ts` (plan shape) and `cliInstall.test.ts` (status, install, refresh, remove, status through the command) fail for an item that breaks it.

| Operation | Provided by the plan | Rule |
|---|---|---|
| status | `files`, `probe` | Read-only, no password: user-readable files are classified, a root-only file is only asked through the `probe` (`sudo -n`). |
| install | `steps` | Stage, validate, install; skips files already current. |
| refresh | `steps` | Same steps for every file, whatever the status. |
| remove | `removeSteps` | At least one step per file, each with its `fix`; then the post-check. |

- Every file carries the marker; the id is not `status` and not an option.
- States (stable names, also in `--json`): `not installed`, `installed`, `outdated`, `partial`, `foreign`, `unsupported here` (platform, missing tool, unsafe user name; `reason` says which). `foreign` wins over `outdated` over `partial`.
- JSON fields: `id`, `state`, `files[{id, path, state, sha256?, shippedSha256}]`, `supportedHere`, `missing`, `nextSteps`; plus `action`, `applied` on a change. File states: `absent`, `current`, `outdated`, `foreign`, `listed by sudo`, `not listed by sudo`, `not read`.
- Exit codes: 0 for `--check` only when `installed`; every flow exits 1 on a refusal or a failed step, 2 on a usage error.
- The status of a root-only file is the probe: it cannot see a rule edited by hand, nor tell machine's rule from another rule that allows the same command. `--refresh` rewrites it whatever it holds.
- `machine status` prints `installed: <id> (up to date)` or `[warn] installed: <id> is outdated: run machine install <id> --refresh`, from the user-readable files only (no sudo at all); nothing when no item is installed. `--json` adds `installedItems`.

## `suspend` (Linux)

| File | Mode | Content |
|---|---|---|
| `/usr/local/bin/machine-suspend` | 0755 root | `( sleep 3; exec <sudo> -n <systemctl> suspend ) >/dev/null 2>&1 &` plus the marker |
| `/etc/sudoers.d/machine-suspend` | 0440 root | `<user> ALL=(root) NOPASSWD: <systemctl> suspend` plus the marker |

- User name: whitelist `^[a-z_][a-z0-9_-]{0,31}$`, else refused. systemctl and sudo: `command -v`, absolute, characters `A-Za-z0-9._+-/` only (a scrubbed environment has no PATH, hard rule 9). The script names sudo by absolute path too (the hand-written one did not).
- Order: stage both files in a private temp folder, `sudo visudo -c -f <tmp>`, `sudo install -m 0755 ... ` the script, `sudo install -m 0440 ...` the rule. A failed validation installs nothing and prints visudo's message. A failed step reports the command, its exit code and stderr, and which file is already in place.
- Reading the rule needs root (`/etc/sudoers.d` is root-only on common distributions): `install` and `--remove` read it with `sudo sh -c 'test -e "$1" || exit 3; cat -- "$1"'` after saying so; `--check` only asks `sudo -n -l`, so it cannot detect an outdated rule (only an outdated script).
- Afterwards: paths, `sudo -n -l <systemctl> suspend` (tests without suspending), `machine admin allow <name> --shell sh -- /usr/local/bin/machine-suspend`, `machine run <name> -- ...`, `machine wake <name>`.
- Consequence, stated in help and output: once the entry is in the DEFAULT list, every trusted peer can suspend this machine; a per-peer list (`machine policy allow --peer`, mode local) restricts it.

## Unverified on a real Linux box

- Whether `sudo visudo -c -f <tmp>` accepts a temporary file owned by the user (ownership/mode checks of visudo in check mode).
- That `sudo -n -l <systemctl> suspend` exits 0 right after the install on every sudo version and when another rule matches later.
- The `exec /usr/bin/sudo -n` from the daemon's scrubbed environment (sudo `requiretty`, `use_pty`, a policy requiring a terminal).
- That `systemctl suspend` as root from a background process of the daemon's session actually suspends.
