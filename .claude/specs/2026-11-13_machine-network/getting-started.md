# Getting started

**Version:** v0.1 (2026-11-15). Implements decisions 51 to 54. The flows were run against the real relay by `npm run test:relay` (see ux-audit-2026-11-15.md).

## Commands per case

| Case | Commands | Human steps |
|---|---|---|
| First machine (also the admin) | `machine setup <relay>` | choose the admin passphrase (twice); type the full-access pairing code of the relay console; approve the device login in the relay console |
| Another machine | `machine join <relay>` there, `machine admin approve` on the admin machine | approve the device login in the relay console; on the admin machine: y/N and the passphrase; on the new machine: compare the final code |
| Allow a command | `machine admin allow <machine> -- <command>` on the admin machine | y/N and the passphrase |
| Start at login (each machine) | `machine startup enable` | none; never automatic unless `--auto-startup` |

The relay is named once (`<relay>` is a host or URL), then stored. A machine that holds the admin key and runs `machine join <relay>` approves itself (needs `machine admin login <code>` first, or use `setup`).

## Rules a user meets

- Name: the computer name, lowercase (`Midgard2.local` becomes `midgard2`); `--name` overrides it at creation. It is the signed reference. A friendlier label: `machine alias set <label> <name>`, accepted wherever a machine is named.
- Passphrase: 12 characters minimum, a warning below 20; `--generate` or an empty answer gives a random one, shown once. It cannot be recovered.
- `machine run <machine> -- <command>` needs no local daemon. The daemon of the TARGET machine must run (`machine startup enable` there) to receive the policy and the command.
- `machine admin allow` assumes the target has no policy when none was signed on this machine; a target holding a policy signed elsewhere refuses it ("policy changed, reload").
- `join --no-wait`, `join --resume`, `admin login`, `admin approve <id>`, `init`, `admin init` stay for scripts and interrupted runs.
