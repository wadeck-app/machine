# Audit Report -- consistency -- Machine Network

**Date:** 2026-11-14
**Spec version:** v0.4
**Auditor:** independent reviewer (spec mode); the reviewer could not write files, the text was saved by machine-owner. Every finding was verified against the files, see `../2026-11-14_12-28_verification.md`; line numbers are the reviewer's and were not trusted.

## Scope

Files examined, all read in full, under `.claude/`: `specs/2026-11-13_machine-network/` (`_index.md`, `guiding-principles.md`, `out-of-scope.md`, `threat-model.md`, `evidence.md`, `decisions-pending.md`) and `plans/2026-11-14_machine-network-phase1.md`. ASCII check: no non-ASCII character in the 7 files, so no finding on that rule.

## Executive summary

The v0.4 spec is mostly coherent on the big pivots (direct transport, registry-only relay, admin key, scopes), but several older statements survived later decisions. The pair secret is "optional" in one threat row and mandatory elsewhere, the status line and open-question table disagree with the decision log, pending-decision entries and threat rows still describe superseded designs, and the plan has no work package for several things the decisions require. No CRITICAL contradiction of a principle was found; 8 HIGH findings block a correct implementation as written.

## Findings

| ID | Severity | Finding | File / Section | Recommendation |
|---|---|---|---|---|
| C-01 | HIGH | PSK is "optional" in T-01 but mandatory elsewhere (decision 22, T-30, T-35). An implementer following T-01 could ship without PSK. | TM T-01 vs IDX dec. 22, T-30, T-35 | Remove "optional" in T-01; the PSK is mandatory (decision 22). |
| C-02 | HIGH | No work package or relay API for the pair secret: decision 22 has the admin console generate, seal, sign and distribute it; WP1, WP6, WP7 and WP-R2 do not mention it; nothing says how it reaches the N-1 existing machines (offline ones included) when a machine is added. | IDX dec. 22 vs PLAN WP1, WP6, WP7, WP-R2 | Add a sealed, signed pair-secret record to machine-core, the `machines` resource, WP6 and WP7; define offline catch-up. |
| C-03 | HIGH | How a new machine obtains the encrypted admin key copy (decision 23) is unspecified; decision 35 covers only the signed registration and the pinned admin public key. The first-machine bootstrap (creating the admin key) has no decision and no WP. | IDX dec. 23, 35; TM T-05; DP D-I; PLAN WP3, WP7 | Decide the transfer path of the encrypted key and first-machine init; map to a WP. |
| C-04 | HIGH | Hard rule 4 ("higher version number", admin signature for every change) contradicts decision 25 (restrict-only actions need no admin signature) and decision 27 (compare-and-set on the base version). | TM section 8 rule 4, T-16 vs IDX dec. 25, 27 | Reword rule 4: widening changes need the admin signature and a matching base version; list the unsigned restrict-only actions. |
| C-05 | HIGH | Decisions with no work package: `machine lockdown` and `machine revoke`, L5 `machine.security.*` alerts, admin approval of pending requests (L3), the caller command `machine run`, chain-head copy to peers (T-27), lockout recovery (T-24). The decision 40 pages have no pending-requests page. | IDX dec. 20, 25, 26, 40 vs PLAN section 2 | Add WPs or defer explicitly in a decision; add a pending-requests page or state it lives in Policy. |
| C-06 | HIGH | Status line and open-question table disagree with the decision log (#14 and the page list counted as open though decided; #4 and #5 "Mostly"). | IDX status line vs Open Questions, dec. 40 | Rewrite the status line from the table. |
| C-07 | HIGH | AR-9 and AR-7 triggers are already met by the acceptance scenario (it enrolls the work laptop); PLAN gates the T-23 mitigation but no WP implements it; T-23 is "Accepted" while decision 38a says it stays open. | TM AR-7, AR-9, T-23; IDX dec. 38a; PLAN section 4 | Decide before WP10: a mitigation WP (provenance, `autoUpdate: false` on the laptop) or an explicit user acceptance; align the wording. |
| C-08 | HIGH | The relay API contract is undocumented while WPs depend on it (routes, required scope, data shapes for `machines`, candidacy, scoped pairing). | IDX Open Question 2 note; TM TB-2; PLAN WP-R2, WP-R3 | Add a relay API section or a pending decision to produce it. |
| C-09 | MEDIUM | Decision 4 is stale ("REOPENED ... see Open Question #7 ... under review"); #7 is resolved by decision 22. | IDX dec. 4 | Mark decision 4 amended by 10 and 22. |
| C-10 | MEDIUM | Q#4 points to resolved #10; T-24 is Open and cites Q#4 although decision 26 settles lost-passphrase handling; T-05 cites Q#13, already resolved. | IDX Open Questions; TM T-05, T-24 | Close Q#4; retarget T-24 to decision 26; fix Q references in T-01, T-04, T-05, T-06. |
| C-11 | MEDIUM | "Allowlist" names two things (peer allowlist in decision 6, command allowlist in decisions 13-15) and the connection gate is unclear; A-4 says enrollment is a human act on both sides while decision 22 says no pairing ceremony. | IDX dec. 6, 13, 21, 24; TM A-4, TB-3, T-01 | Rename (peer registry vs command allowlist); restate decision 6 in terms of registrations; fix A-4. |
| C-12 | MEDIUM | Stale relay-forwarded vocabulary after decision 33 (AR-8 "drop other machines' connections", decision 32 "connections of the machine route", asset row "who, when, sizes", T-05 "through the relay during pairing", the wss dependency, "secure channel through the relay"). | IDX dec. 32, summary, dependencies; TM:6, assets, T-05, AR-8; GP P-6 | Replace with registry wording; fix the asset row; mark the wss dependency as queue-only. |
| C-13 | MEDIUM | T-13 says the daemon refuses to start the admin page if CSP mode is `off`; the page lives in app-core as an app-module (decision 19), the daemon does not serve it. | TM T-13 vs IDX dec. 19 | Reword (for example `machine status` warns or refuses) or drop; add to WP8 if kept. |
| C-14 | MEDIUM | Pending-decision entries not marked superseded: D-E and D-F still recommend superseded designs, D-I has no DECIDED line, header date stale. | DP D-E, D-F, D-I, header | Add SUPERSEDED or DECIDED banners with decision numbers; update the date. |
| C-15 | MEDIUM | Plan parameters have no Open Questions entry (service name, unlock duration, verification code length, laptop `autoUpdate`, reachability, D-J); "8 h for shell grants" mixes the admin unlock window with the removed shell-grant concept. | PLAN section 4 vs IDX Open Questions | Add an Open Question per parameter; correct the 8 h reference. |
| C-16 | MEDIUM | out-of-scope.md is nearly empty versus the decisions (regex/wildcard/allow-all, NAT traversal and relay fallback, sandbox L4, interactive sessions, linux-arm64, darwin-x64, pairing ceremony, hardware authenticator, phase 2). | OOS vs IDX dec. 12, 13, 20, 34, 39 | Fill out-of-scope.md from these decisions. |
| C-17 | MEDIUM | T-31 and T-32 are Open and block WP-R1, WP6, WP7 but are absent from the plan gates. | PLAN section 4 vs TM T-31, T-32 | Add them to the gate (before WP6). |
| C-18 | MEDIUM | Decision status vocabulary is inconsistent; decisions 19 and 21 stay "to confirm" though others build on them and PLAN gates WP1 on 21. | IDX decision log | Use a fixed status set plus a confirmation column; resolve the confirmations for 19 and 21. |
| C-19 | MEDIUM | Terminology collision on "register", "registration", "pairing", "pair secret" vs "PSK", `machine join` vs "enroll" and "candidacy". | IDX dec. 22, 28, 38a; TM; PLAN | Add a glossary; rename the `register` command. |
| C-20 | MEDIUM | Decisions 38 and 38a contain text superseded by decision 39 (platform list "not stated", `linux-arm64` or `darwin-x64` "if needed"); Q#14 still "to confirm". | IDX dec. 38, 38a vs 39 | Strike the stale clauses; close Q#14 or state what remains. |
| C-21 | MEDIUM | The plan treats unconfirmed 38b as fixed (WP9); the updater owner session is "not in the current list". | PLAN WP9 vs IDX dec. 38b | Mark WP9 as dependent on the confirmation; add an Open Question. |
| C-22 | MEDIUM | STRIDE summary inconsistent with the register (T-03 listed under Spoofing though class E; leftover "(T-03 as a row of E class below)"; T-30 to T-32 uncited). | TM section 5 | Fix the lists. |
| C-23 | INFO | AR table order (AR-8 before AR-7); AR-3 accepts a risk phase 1 cannot have (no allow-all). | TM section 7 | Reorder; mark AR-3 conditional. |
| C-24 | INFO | evidence.md contradicts itself on Linux packages and on a count (16 vs 14 entries). | EV | Mark the older entries superseded with dates. |
| C-25 | INFO | evidence.md and D-D still describe the old switchboard route as design input. | EV, DP D-D | Add a one-line "historical, superseded by decision 33" note. |
| C-26 | INFO | Stale text: decision 16 "Mechanism open (D-G)"; decision 3 omits `--timeout 0`; Q#11 and D-J still list an `admin` scope. | IDX dec. 3, 16; DP D-J | Cross-reference or strike. |
| C-27 | INFO | The actors table omits the admin key copy held by a stolen machine; T-22 covers only the identity key. | TM section 4, T-22 | Add the admin key copy to both. |
| C-28 | INFO | Duplicated facts that can drift (orch startup recipe, platform matrix, update interval, threat count). | several | Keep one source (the decision log) and link to it. |
| C-29 | INFO | Plan items without a decision (WP-R4 derived only from D-J, WP10 fresh-agent review); GP lists P-7 before P-6. | PLAN WP-R4, WP10; GP | Record as decisions or label as plan-only hygiene; reorder P-6 and P-7. |

## New open questions raised

1. How does the pair secret (decision 22) reach every existing machine when a machine is added, including offline machines, and which relay resource carries the sealed record (C-02)?
2. How does a new machine receive the encrypted admin key copy of decision 23, and how is the very first machine initialized (C-03)?
3. Which unsigned, restrict-only actions exist (decision 25), and how does hard rule 4 express them (C-04)?
4. Where are pending command requests (L3) approved: on the Policy page or a new page (C-05)?
5. Who implements `lockdown`, `revoke`, L5 alerts and chain-head copy, and in which WP (C-05)?
6. Are AR-9 and AR-7 acceptable for the acceptance scenario that enrolls the work laptop, or is the update-channel mitigation required first (C-07)?
7. What is the written relay API for `machines`, candidacy and scoped pairing (C-08)?
8. Does decision 6 still mean a local peer allowlist, or is every admin-registered machine connectable (C-11)?
9. What are the defaults for admin unlock duration, verification code length and laptop `autoUpdate` (C-15)?
