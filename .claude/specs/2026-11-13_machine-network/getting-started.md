# Getting started

**Version:** v0.2 (2026-11-15). Implements decisions 51 to 56. The flows were run against the real relay by `npm run test:relay` (see ux-audit-2026-11-15.md).

## Commands per case

| Case | Commands | Human steps |
|---|---|---|
| First machine (also the admin) | `machine setup <relay>` | choose the admin passphrase (twice); type the pairing code of the relay console (step 1); type the relay login code on the relay page (step 2) |
| Another machine | `machine join <relay>` there, `machine admin approve` on the admin machine | type the relay login code on the relay page; on the admin machine: y/N and the passphrase; on both machines: compare the security code |
| Allow a command | `machine admin allow <machine> -- <command>` on the admin machine | y/N and the passphrase |
| Start at login (each machine) | `machine startup enable` | none; never automatic unless `--auto-startup` |

The relay is named once (`<relay>` is a host or URL), then stored. A machine that holds the admin key and runs `machine join <relay>` approves itself (needs `machine admin login <code>` first, or use `setup`).

## The codes (decision 55)

| Code | Looks like | Where it comes from | What you do with it |
|---|---|---|---|
| Pairing code | 8 digits | relay console, Tokens, Add token, WITHOUT "Limited to scopes" | type it in `machine setup` (admin access to the relay) |
| Relay login code | `X35M-M87M` | printed by `join` and `setup` | type it on the relay page: it only gives this machine access to the relay |
| Security code | `31447 56532 70010 53274 49389` | printed on the admin machine after it signs, and on the new machine | compare the two: it must read exactly the same on both. If not, `machine admin revoke <name>` |

The candidacy code (base32, `XXXX-XXXX-XXXX-XXXX`) is internal: the admin machine recomputes and checks it, nothing to compare. `--verbose` (join, setup, admin approve) and `--json` show it.

Security code: 25 digits, 83 bits. `--yes-final-code` takes it quoted or as five words.

## What the new machine and the admin see

New machine (`machine join <relay>`):

```
Relay login code for "laptop" on <relay>. Type it on the relay page: it only gives this machine access to the relay (it is not the security code compared later):

  TH9B-3MHH

Relay page: <relay page>
...
Candidacy LLADk3BpEqJkNFQuHZT_cA posted: it expires in 15 min (16:07).
On the admin machine run: machine admin approve   (it shows this machine by name, hostname and address)
When the admin approves, a security code appears on the admin machine and here: compare them, they must read exactly the same.
The admin approved this machine. Security code of "laptop" (this machine) with admin key ab5e... It must read exactly the same on "desktop":

  31447 56532 70010 53274 49389
```

Admin machine (`machine admin approve`):

```
Candidacy LLADk3BpEqJkNFQuHZT_cA
  name       laptop
  ...
  created    now (15:52), expires in 15 min (16:07)

After you sign, a security code is shown here and on "laptop": it must read exactly the same on both.
...
Security code of "laptop" (admin key ab5e...):

  31447 56532 70010 53274 49389

It must read exactly the same on "laptop". If it differs, run: machine admin revoke laptop
```

## Rules a user meets

- Name: the computer name, lowercase (`Midgard2.local` becomes `midgard2`); `--name` overrides it at creation. It is the signed reference. A friendlier label: `machine alias set <label> <name>`, accepted wherever a machine is named.
- Passphrase: 12 characters minimum, a warning below 20; `--generate` or an empty answer gives a random one, shown once. It cannot be recovered.
- Times are local with a relative hint (`expires in 15 min (16:07)`); `--json` keeps ISO strings and epoch seconds.
- `machine run <machine> -- <command>` needs no local daemon. The daemon of the TARGET machine must run (`machine startup enable` there) to receive the policy and the command. `machine list` says so per peer: `On "laptop" run machine startup enable ... then run machine list again here`.
- `machine admin allow` assumes the target has no policy when none was signed on this machine; a target holding a policy signed elsewhere refuses it ("policy changed, reload").
- After `machine admin revoke`, `machine status` lists the revoked machines apart (`laptop  uuid 5c8179d2  revocation installed here 3 min ago (15:52)`); `machine admin forget-relay-record laptop` and `machine admin distribute laptop` take the name, the uuid or a uuid prefix.
- `join --no-wait`, `join --resume`, `admin login`, `admin approve <id>`, `init`, `admin init` stay for scripts and interrupted runs.
