# Audit Report -- architecture -- Machine Network

**Date:** 2026-11-14
**Spec version:** v0.4
**Auditor:** independent reviewer (spec mode); the reviewer could not write files and returned a finding list, which machine-owner saved. Details beyond the one-line findings were not returned. A-01 and the "not verified" library statement were not re-checked.

## Scope

`.claude/specs/2026-11-13_machine-network/` (all files) and `.claude/plans/2026-11-14_machine-network-phase1.md`.

## Executive summary

The hand-built Noise-with-PSK channel on a network port of a daemon that runs commands is the main risk. Several designed mechanisms (per-pair secret, per-request signatures, candidacy with two codes, compare-and-set policy, relay scoping) are heavy for one person with 2 to 4 machines, and the plan puts the admin web page and the relay work on the acceptance path although a CLI signing path exists. Reachability between the real machines is first tested at WP10, with no fallback.

## Findings

| ID | Severity | Finding | Recommendation |
|---|---|---|---|
| A-01 | CRITICAL | The channel is a hand-built Noise+PSK protocol on a network port of a daemon that runs commands. No vetted Noise library found in the workspace; only `@noble/*` primitives are declared (in `wdrive/mobile/package.json`). Library: not verified. | Spike mutual TLS 1.3 with keys pinned from the admin-signed registration, or a mesh VPN or SSH, before WP1. |
| A-02 | HIGH | Option E (mesh VPN) of D-D was never accepted or rejected in a decision. | Close adopt versus build with the user. |
| A-03 | HIGH | Reachability between the work laptop and the desktop is first tested at WP10, with no fallback. | Make a two-way reachability spike between the real machines a gate before WP1. |
| A-04 | HIGH | The per-pair secret distributed by the admin console adds little: admin-key compromise already defeats it (AR-7) and whole-machine theft is unchanged. | Drop it from phase 1. |
| A-05 | HIGH | Per-request signatures on top of an authenticated, ephemeral-key session are redundant in phase 1; they matter for stored or forwarded requests in phase 2. | Defer. |
| A-06 | HIGH | The relay token-scoping work blocks WP6 and WP7 but acceptance does not need it. | Decouple it from phase 1. |
| A-07 | MEDIUM | The relay registry could be optional at 2 to 4 machines; static addresses would let WP1 to WP5 and acceptance run without it. | Allow static addresses first. |
| A-08 | HIGH | Candidacy enrollment with two verification codes is heavy for one person who controls both machines. | Phase 1 can use an out-of-band fingerprint comparison with a file or paste transport. |
| A-09 | HIGH | The admin web UI (WP8) sits on the acceptance path though the CLI signing path (WP4) exists. | Move it after acceptance; require `machine-core` to run in a browser. |
| A-10 | MEDIUM | Compare-and-set policy is overkill for one human editing rarely. | A monotonic version is enough for now. |
| A-11 | MEDIUM | An admin key copy on the work laptop makes it a target. | Offer a "member" role that holds only the admin public key. |
| A-12 | MEDIUM | Update and restart under orch has gaps: no drain before the self-exit, no compatibility window while machines update at different times, staging undefined, updater owner not confirmed. | Specify drain and a version window. |
| A-13 | MEDIUM | The plan lacks `Transport`, `Registry` and `Executor` interfaces; five packages plus launcher and platform packages is heavy for P-4. | Define the interfaces; reduce the package count. |
| A-14 | MEDIUM | The peer listener shares a process with the loopback API, the exec engine and the signature verifier. | Enforce separation by module structure; keep the listener off by default. |
| A-15 | MEDIUM | No early end-to-end slice and no per-package sizing. | Add a walking skeleton after WP3. |
| A-16 | MEDIUM | Cuttable features are not marked (audit-head copy to peers, auto-expiry of unseen peers). | Add an MVP column to the plan. |
| A-17 | MEDIUM | Two key types per machine add complexity. | Choose the transport first, then fix the registration schema. |
| A-18 | INFO | poc-node hygiene items (`ENABLE_POC_ROUTES` value, in-memory pairings) belong on poc-node's own track. | Leave to poc-owner. |
| A-19 | INFO | Sibling reuse is good for packaging, but deviations from sibling patterns are not listed together. | List them. |
| A-20 | INFO | Decisions 20 and 21 are still provisional and WP1 is gated on them. | Confirm them. |

## New open questions raised

1. Adopt or build the transport, and which options are acceptable on the work laptop?
2. Can each machine reach the other from its real network, and what is the fallback if not?
3. Is the per-pair secret needed in phase 1?
4. Are per-request signatures needed in phase 1?
5. Can poc-node scoping be decoupled from phase 1?
6. Should a "member" role that holds only the admin public key exist?
7. Must `machine-core` run in the browser, and are Ed25519 and a suitable key derivation function available on the shell origin?
8. Should a running command be drained before the post-update exit, and what version window is needed?
9. Who owns `singleton-daemon-kit` and `shared-updater`?
10. What is the MVP package set for acceptance, and how big is each package?
