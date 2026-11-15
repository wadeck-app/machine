# machine

Private network between the user's machines: a CLI and daemon (`machine`) that run commands on a peer under an admin-signed strict allowlist. The relay (poc-node on Infomaniak) only authenticates and introduces machines; it never carries commands.

## Agent reference docs

| File | Contents |
|---|---|
| `.claude/specs/2026-11-13_machine-network/_index.md` | Decision log, open questions, phasing |
| `.claude/specs/2026-11-13_machine-network/threat-model.md` | Threat model v3.0, hard rules (read before touching crypto, network or policy code) |
| `.claude/specs/2026-11-13_machine-network/guiding-principles.md` | P-1 to P-7 |
| `.claude/specs/2026-11-13_machine-network/out-of-scope.md` | Exclusions |
| `.claude/plans/2026-11-14_machine-network-phase1.md` | Work packages and owners |

`.claude/product-vision.md` does not exist: the spec's `_index.md` summary plays that role.

## Rules

- TDD: write the test first, see it fail, then implement (P-7). Every capability is a function of `packages/machine-core` (no I/O); daemon, CLI and app-module are thin front-ends.
- Fail loudly (P-2): no silent fallback; every error names the cause and the fix.
- Secrets live only in `<configDir>/_secrets_/` (never in the repo, logs, errors or the audit log). No passphrase on a command line or in an environment variable.
- A change that widens rights is valid only with an admin signature (hard rule 4).
- Dependencies: every `@wadeck-app/*` package outside the workspace is `latest`, workspace packages are `*`; commit `package.json` and `package-lock.json` together and check `npm ci --dry-run`.
- English and ASCII punctuation in files; the spec is updated in the same step as the code or decision.

## Commands

```
npm test            # all workspaces
npm run typecheck
MACHINE_TEST_RELAY_MODULE=<poc-node>/tests/helpers/test-relay.mjs npm run test:relay   # init, onboarding, offboarding against the REAL relay (needs the poc-node checkout, `npm ci` done there; not part of `npm test`)
```

`test:relay` fails loudly when the variable is unset or the file is missing. `MACHINE_RELAY_TRANSCRIPT=<dir>` also writes what every command printed (JSON per suite), the input of the UX audit.
