# `machine install`

Decision 87 (user request 2026-11-22). Sets up an item on THIS machine, with the facts of this machine. First item: `suspend`, Linux only.

## Scope

- LOCAL command, run by the owner in a terminal on the box. No daemon command, peer frame, app-module route or API exists for it (hard rule 7: the daemon is never elevated). A test fails if a daemon-side source imports the executor.
- Root actions are `sudo` child processes sharing the owner's terminal: the owner types HIS password to sudo itself. machine never reads, stores, logs or passes it (hard rule 8).
- Refuses without a terminal (stdin and stderr), `--yes` included. `--dry-run` and `--check` need none.

## Commands

| Command | Effect |
|---|---|
| `machine install` | Lists every installable with its platforms and whether this machine supports it. `--json` supported. |
| `machine install <id>` | Shows state, every file (exact content, owner, mode, sha256) and every command, asks y/N (`--yes` skips), runs, then checks with `sudo -n -l`. |
| `--dry-run` | Prints the plan. Runs nothing, not even sudo (the root-only rule is reported as not read). |
| `--check` | `installed` / `not installed` / `outdated` / `partial` / `foreign`. Exit 0 only for `installed`. Never asks a password. |
| `--remove` | Shows then removes exactly the managed files (rule first, script second). Refuses everything if one file is foreign. |

Unsupported platform: `not supported on <platform> yet (supported: linux)`, exit 1, nothing run. Unknown id: exit 2.

## Shape (to add an item)

`packages/machine-core/src/install.ts` is pure (no I/O). An `Installable` is `{id, description, platforms, consequence, plan(facts), next(plan, name), afterRemove(plan, name)}`; add it to `INSTALLABLES` and to the group help in `cliHelp.ts` (a test fails on drift).

- Facts: platform, user name, absolute tool paths, measured by the executor.
- `plan(facts)` returns data and throws `InstallError` on an unsupported platform or an unsafe fact: `files` (path, mode, owner, content, sha256, `rootOnly`), `steps` (`stage` a temporary file, `run` a command: validate, install), `removeSteps`, `probe` (a never-prompting command that exits 0 when installed).
- A file carries `# managed by machine install <id>, version <n>`. Present without it: foreign, never touched. Same marker, other sha256: outdated.
- Executor (`installFlow.ts`) takes an injected fs and exec (`installEnv.ts`); tests use `installTesting.ts`.

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
