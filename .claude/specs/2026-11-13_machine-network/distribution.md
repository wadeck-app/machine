# Distribution of signed documents through the relay

**Version:** v0.4 (2026-11-21), client implemented, relay deployed (sections at the end). Closes todos #15, #14c, #14e. The relay stays a dumb store: opaque documents, no trust decision. v0.4 (decision 78): the payload of EVERY document is sealed to its addressee; see "Sealed payloads" and "Rollout".

## Problem

After `machine admin approve`, only the admin and the new machine know each other. Machine C must also learn about machine D (registration and pair secret), each machine must receive its own policy, and a revocation must reach every peer, including peers that were offline.

## Documents

Every document is a JSON object signed by the admin key (domain-separated like registrations), addressed to one machine:

```json
{ "body": { "v": 2, "kind": "peer" | "policy" | "revocation" | "notice-recipients", "to": "<uuid>", "id": "<22 chars base64url>", "issuedAt": 1800000000, "expiresAt": 1802600000, "payload": { "sealed": "<base64url>" } },
  "signature": "<base64url Ed25519 over the canonical body, admin key, domain machine/document/v2>" }
```

| kind | clear payload (inside `sealed`) |
|---|---|
| `peer` | the peer's signed registration, `sealedPairSecret` (sealed again to the recipient, context binds admin, recipient, peer) and `adminUuid` |
| `policy` | the signed policy for `to` (existing format, body opaque here) |
| `revocation` | the signed revocation list (existing format) |

The recipient verifies the admin signature against its pinned admin key, `to` equals its own uuid, `expiresAt` not passed, opens `sealed` with its identity key, then installs through the existing validators (`importPeer`, `installPolicy`, `installRevocation`). A document that fails is dropped and reported in the audit log, never partly applied and never silent.

## Sealed payloads (decision 78)

- Rule: no message between machines is readable by the relay. The signature is the authenticity, the sealing is the confidentiality: `payload.sealed = sealTo(identity key of the addressee, canonical JSON of the real payload, "document-payload:v2:<kind>:<to>:<id>")`. The context makes a sealed payload open only as that type, for that addressee, under that id. The key comes from the registration the admin signed for the addressee.
- No plaintext mode: `buildDocument` throws without the key of the addressee; `putInboxDocument` refuses any document that is not envelope version 2 with `payload = { sealed }` before any request; the receiver refuses envelope version 1 (below). A policy for a machine the admin holds no registration for is refused, nothing is sent.
- What the relay still reads of a document: addressee uuid, type tag (`kind`), id, `issuedAt`, `expiresAt`, size, arrival time (`storedAt`). The relay validates only `body.to`, `body.id` and the 16 KiB cap (poc-node `routes.js`); it does not look at `kind` or `payload`, so no change is needed there (tested against the real relay, `relay.test.ts`).
- Size: the sealed form is a third bigger than the clear one (base64url) plus 61 bytes. The 16 KiB cap now holds about 11 KiB of clear payload; `buildDocument` refuses a bigger one and names the limit. The approval (16 KiB cap in the relay) holds fewer peers for the same reason.
- Receiver refusals, all audited once (`document-rejected`) and the document deleted so that the admin can send it again: `plaintext` (envelope version 1 signed by the admin key: the message names the update of the admin machine), `cannot-open` (not sealed to this machine key, altered, or sealed for another type, addressee or id). A version 1 document that the admin key did not sign is junk, counted in the `documents-unverified` summary like any forgery.
- Approval: the approval stored for a candidacy is `{ v: 2, random, sealed }` (`random` is the one the relay already holds); `sealed` holds the whole former approval (registrations, admin key, sealed secrets), context `approval:v2:<candidate uuid>:<random>`. A candidate refuses a clear approval (envelope version 1) with the update of the admin machine as the fix.
- Not sealed, by need: address records and candidacies (see threat-model.md T-25).

## Relay resource (agreed with poc-owner)

| Call | Scope | Answer |
|---|---|---|
| `PUT /api/machines/{uuid}/inbox/{id}` | A (full access) only | `204`; same bytes again `204`; same `id` with other bytes `409 id_conflict`; `body.to` must equal `{uuid}` and `body.id` must equal `{id}` (`400` otherwise); id is 22 characters base64url; request at most 32 KiB, document at most 16 KiB |
| `GET /api/machines/{uuid}/inbox` | M of the token that owns `uuid`, or A | `200 { documents: [ { id, document, storedAt } ], more, next }`; oldest first, at most 32 per call, the client loops with `next`; another token gets `403` (no oracle on unknown uuids) |
| `DELETE /api/machines/{uuid}/inbox/{id}` | M owner, or A | `204`, also for an unknown id (idempotent) |
| `DELETE /api/machines/{uuid}` | A only | removes the address record, the owner binding and the inbox; used by `admin revoke` and by token rotation |
| `POST /api/machines/{uuid}/heartbeat` | M | `200 { inbox: { count } }` (changed from `204`): the daemon reads the inbox only when `count > 0` |

Limits: 256 documents and 16 KiB each per inbox, a global cap of 64 MiB for all inboxes; `429 too_many_documents` (one inbox full, the message names the uuid not draining) and `429 relay_inbox_full` (global); retention 30 days from `storedAt`, swept hourly and at read. Writes are audited as `machine_inbox_put` (uuid, id, size, never the document). One file per document on the relay, so address writes stay small.

Ownership: the owner of `uuid` is the token bound to it at approval (relay-api.md, "Ownership bound at approval"). The admin may PUT documents for a uuid before its record exists (approval precedes the first record). After a token rotation a new candidacy plus approval rebinds; `DELETE /api/machines/{uuid}` also forgets the binding.

## Flow

1. `admin approve` PUTs, for each existing peer P of the admin: a `peer` document to P about the new machine and a `peer` document to the new machine about P (sealed secrets), plus fresh `policy` documents when the admin signs one. Documents addressed to a peer number one per peer: a network of 60+ machines does not overflow an inbox.
2. `admin revoke` PUTs a `revocation` document to every other machine, then calls `DELETE /api/machines/{uuid}` for the revoked machine (peers learn through the revocation document, not through the relay).
3. Each daemon sends its heartbeat every 60 s, reads the inbox when `inbox.count > 0` (and once at start), installs valid documents, DELETEs each handled document, and records rejected ones in the audit log.
4. An offline machine reads its inbox when it returns. Freshness stays on the client side (the relay cannot judge it): `expiresAt` and the monotonic version and serial rules of decision 44 apply, so a stale policy cannot be installed after expiry or over a newer one.

## Threats considered

| Threat | Handling |
|---|---|
| Relay reads documents | every payload is sealed to the addressee (decision 78): the relay reads the type, the addressee, the id, the dates and the size, never a policy, a revocation, a registration or a pair secret. Documents stored in clear by a build before decision 78 stay readable until their addressee deletes them or 30 days pass |
| Relay drops, delays or replays documents | detected or bounded client side: signatures, `expiresAt`, monotonic versions; dropping delays convergence only (an offline machine keeps its last policy and revocation list) |
| Stolen machine token floods or reads | machine tokens cannot PUT; reads and deletes only on the owned uuid |
| Squatting an ownerless inbox | needs the uuid (122-bit random, known to the admin and the machine); the admin can purge with `DELETE /api/machines/{uuid}` |
| Disk fill | per-inbox and global caps, audited writes |
| uuid enumeration | `GET /api/machines` already lists uuids to every machine token (existing contract); inbox answers do not add an oracle |


## Document format details (implemented, machine-core `document.ts`)

- Domain `machine/document/v2` (version 1, `machine/document/v1`, is only recognised to be refused). Strict shape: unknown fields refused at every level, document at most 16 KiB (checked before the signature), `id` is 22 characters of canonical base64url, `payload` is exactly `{ sealed }`.
- Verify order: shape, size, pinned key, signature, addressee (`to`), time window (skew 30 s), payload. A failure before the end of the signature check is reported as `signed: false` (junk or forgery); after it, the failure is a verdict on a document of the admin. `expiresAt - issuedAt` is at most 30 days. A registration or a policy dated slightly ahead of the receiver clock is deferred (kept in the inbox), not rejected; `importPeer` has the same 30 s tolerance as the documents.
- `peer` payload is `{ registration, sealedPairSecret, adminUuid }`. `adminUuid` (the admin machine, or null) is an addition to the draft: the receiver does not store it otherwise, and the document signature authenticates it.
- Seal context of the pair secret: `pair-secret:<adminUuid|none>:<to>:<peerUuid>` (sender, addressee, subject). The document id is not in the context: the admin signature covers `id` and the sealed value together.
- The pair secret of a pair (D, P) is derived from the admin key: HMAC-SHA256, keyed by an HKDF-SHA256 subkey of the admin seed (info `machine/pair-secret/v1`, never the raw signing key), over both uuids and serials sorted by uuid. Both documents carry the same secret, a retry (or another admin machine holding the key) seals the same value, and it is not the secret the admin shares with either machine. Consequence (threat-model T-36, AR-7): whoever holds the unlocked admin key can recompute every pair secret from the public registrations; pair secrets add no protection against theft of the admin key, and still protect against a stolen identity key alone and against the relay.
- A `policy` payload target must equal `to`; a `revocation` carries the whole local revocation list of the admin.

## Ids, dates and retry (implemented, `distribute.ts`)

| Kind | id = first 16 bytes of SHA-256 of | issuedAt / expiresAt |
|---|---|---|
| `peer` | `v2:peer:<to>:<to serial>:<about>:<about serial>` | later `validFrom` of both registrations / min(+30 days, both `validTo`) |
| `policy` | `v2:policy:<target>:<version>:<signature>` | policy `issuedAt` / min(+30 days, `notAfter`) |
| `revocation` | `v2:revocation:<to>:<signature>` | signing time / +30 days |

- The `v2:` prefix keeps the id of a sealed document apart from the id an older build gave the same content in clear: a clear document still waiting in an inbox must not make the relay answer `id_conflict` for the sealed one.
- Ed25519 is deterministic, but sealing is random (fresh ephemeral key): a re-PUT of ANY document has other bytes, so the relay answers `id_conflict`. The admin treats that as "already delivered" and reports it. A re-signed revocation has a new signature, hence a new id. Consequence: a sealed document that the target could not open is deleted by the target (not remembered), so the admin's resend is stored again.
- Order: the decision first (approval PUT, local revocation install, policy file), then the documents. A distribution failure never undoes the decision: it is listed per machine and error on stderr, with the exact retry command, and the command exits 1.
- `machine admin distribute <machine|uuid>` re-sends the peer documents of a trusted machine (both directions, to every other peer), or the revocation of a machine revoked here (by uuid) followed by `DELETE /api/machines/{uuid}`. `machine admin distribute --policy <signed.json>` sends a policy signed earlier. All need the admin relay token and the admin passphrase (same prompt and `--prompt-timeout` as the other admin commands).
- A 401 or an unreachable relay stops the run at the first document (the error is said once). Without a relay admin token, `admin revoke` and `admin sign-policy` do their local work and print one line saying the others were not told and how to do it.
- A document older than 30 days (or with an expired registration) is refused by `distribute`: approve again. A machine offline for more than 30 days finds only expired documents: they are refused, and it converges through the documents of any later `admin distribute` (nothing about an expired document is remembered). The admin output says "stored by the relay", never "delivered": the relay only holds the document until the machine reads it.

## Receiving (implemented, `inboxLoop.ts`, started by the daemon when `relay.json` exists)

- Heartbeat every 60 s; the inbox is read at start and when `inbox.count > 0` (at most 256 documents examined per round, pages of at most 1 MiB, a lying count costs one page request). A relay that returns no count is said once and the inbox is then read every round. Errors back off (120 s doubling to 10 min) and are said once per distinct message (bounded memory of 64), then "working again".
- The set `<configDir>/inbox-state.json` holds ONLY the ids of documents that were verified and installed (2048 ids, oldest dropped, written once per round). An id of an unverified document is never remembered, so a forgery under a real id cannot block the real document. An entry whose id is not 22 characters of canonical base64url is never used as a key or in a request. When an id was evicted, a replay is harmless: a peer is imported again identically (or refused when revoked), a policy is refused by its version rule, a revocation list only grows.
- Each document, in order: skip and acknowledge if its id is installed (logged once); verify against the pinned admin key and the loaded network (revocation-aware).
  - Unverified (bad signature, malformed, wrong id): deleted, counted, ONE summary audit line per round (`documents-unverified`, count and reasons), repeated only after an hour when identical. Never audited one by one, never remembered.
  - Verified and wrong for good (wrong addressee, about this machine itself, bad registration, revoked, expired beyond the skew, a policy that is not newer): audited (`document-rejected`, kind, id, reason, never a secret), deleted, NOT remembered, so that the admin can send it again once the cause is gone (retry after a rejection works; a clock that was ahead does not lose the document).
  - Possibly passing causes (not valid yet, a policy whose predecessor is not installed yet, a sealed secret that cannot be opened, local read or write trouble): kept in the inbox, said once, examined again at every round until it expires; after something was installed, waiting policies get one more look in the same round, so version 3 before version 2 converges.
  - Valid: installed through `importPeer`, `installPolicy`, `installRevocation`; audited (`document-accepted`, kind, id); remembered; DELETEd. The same policy already in force is accepted as `already-installed`.
- Not owner of the inbox: said once (no backoff), the inbox is tried again every round and recovers by itself.
- A machine owns its inbox once the admin approved its candidacy (binding at approval). `not_registered` (not approved) and `not_owner` (another token bound) are said once, no backoff; the fix of `not_owner` is `machine join` again and an admin approval (rebind).

## Rollout of sealed documents (decision 78)

What an OLD target (before decision 78, reads envelope version 1 only) does with a sealed document, from `document.ts` and `inboxLoop.ts` of HEAD 7e3cec5:

- The envelope check fails (`document: unsupported version 2`), which is a failure before the signature check: reason `malformed`, `signed: false`.
- The document is deleted from the inbox, counted, and ONE summary line per round is written (log `inbox: N document(s) failed verification and were deleted (malformed: N)` and the audit event `documents-unverified`). Nothing names the document, its kind or the cause: the owner of that machine sees only the count.
- The document is lost: the admin must send it again after that machine runs the new build. The admin cannot tell: the relay stores the document (`204`) whatever the target reads, and it reports no version of the target.

Symmetric case, a NEW target and an OLD admin: the admin's clear (version 1) document is refused with the message `... arrived in PLAINTEXT ... run machine cli update there, then machine admin distribute`, audited once with its id, deleted, never installed. A new candidate with an old admin refuses the clear approval the same way (`machine join --resume` after the admin updated).

What the user does, in this order:

1. Run `machine cli update` on EVERY machine (the target first or at the same time as the admin; an old target loses what it reads before it is updated).
2. On the admin machine, send again what was lost: `machine admin distribute <machine>` for each machine that was approved or renewed meanwhile, `machine admin distribute --policy <signed.json>` for a policy (the record of the last signed policy is `policies/<uuid>.json`), `machine admin distribute <uuid>` for a revocation. A candidate whose approval was refused runs `machine join --resume` and the admin approves again.
3. A document stored in clear before the update stays readable by the relay until its addressee deletes it (an updated target refuses it and deletes it at its next read) or 30 days pass. Nothing sealed replaces it automatically: step 2 sends the sealed one under another id.

What `machine admin distribute` (and `approve`, `revoke`, `sign-policy`, `allow`) prints when it stored documents: one `[info]` line saying the documents are sealed, that a machine on an older build deletes them unread and counts them as failed verification, `machine cli update` as the fix there, and that this command is run again afterwards. It is printed whenever at least one document was stored, because the admin cannot know the version of the targets. Nothing is printed when nothing was stored.

## Deployed behaviour (poc-owner, commit 4ff0469)

- Errors `{ success: false, error, message }`: `invalid_body`, `invalid_id`, `invalid_uuid`, `invalid_cursor` (400); `full_access_required`, `not_owner`, `scope_denied` (403; `not_owner` is the same answer for unknown, unowned and foreign uuids, so no inference about existence); `id_conflict` (409); `body_too_large` (413 above 32 KiB); `too_many_documents`, `relay_inbox_full` (429); `store_unavailable` (503).
- `scope_denied`: a machine token calling `PUT` inbox or `DELETE` machine. Machine tokens may only `GET` the inbox and `DELETE` documents of their own uuid.
- Listing: oldest first (arrival order), 32 per call, next page with `?after=<next>` (the client sends exactly that).
- `DELETE` of an unknown document id or an unknown machine is 204. Heartbeat answers `200 { success, inbox: { count } }`.
- An inbox written before the machine wrote its record is claimed by the first machine token that writes that uuid record; `DELETE /api/machines/{uuid}` resets.
- The relay keeps no tombstone of acknowledged ids: a replayed PUT of an acknowledged id is stored again. The daemon therefore keeps its own persistent set of handled ids (above), on top of the version and serial rules.

## Direct delivery first (decision 86)

- Before a document goes to the inbox, the admin machine tries `deliver-document` (`{type, document}`, machine-core `documentDelivery.ts`) over the mutual-TLS channel: connect 3 s per address, 4 s overall, ONE attempt, no wake. The document is the one that would be put in the inbox (sealed to the addressee, signed, same id).
- The addressee runs `createDocumentApplier` (`documentApply.ts`), the function the inbox loop also calls, and answers `deliver-ack` with `installed` or `already-installed`. Only these count as delivered: the document is then NOT put in the inbox. A `refused` answer carries a reason and a cause. Both carry the target clock `peerNow` (optional, decision 88): the admin words the skew from it, and a policy is accepted up to 120 s before its `notBefore`.
- Any failure (unreachable, no answer, refusal, an older build answering `unknown-message`: `machine cli update`) falls back to the inbox unchanged and is reported. An older build is remembered for the rest of the command, as is an unreachable one.
- After an installed delivery the target looks at its held requests at once (released within about a second).
- Wording: `Delivered directly to <m> (installed, 0.4 s)` or `<m> is not reachable directly: stored in the relay inbox, it installs it when it comes back (next poll within 60 s, or 5 s while it holds a request). Cause: ...` in the CLI and the page.
- Progress after Allow (Requests page): steps Signed, Delivered directly or Stored on the relay, `<m>` installs the policy, held command released. The page asks `GET /hold-progress/<machine|self>/<id>` every 2 s (daemon command `holdProgress`, fed by `request-notice-end` outcomes in `notice-ends.json` or the local hold). Only an end with outcome `allowed` is a success; after 3 minutes without an end the page says `no confirmation from <m>: ...`. The card stays (snapshot) until dismissed, and a held card of another machine carries the reachability badge.
- Reachability: the admin daemon probes the trusted machines (handshake, no hello) and `machine list` and the Machines page print `direct now (12 ms, checked 8 s ago)`, `not reachable directly (last seen 2 h ago; relay inbox only)` or `unknown`. Relay presence is not used (the daemon does not expose it; `machine list` still prints it).


## Revocation reach (HIGH-2 mitigated between peers that talk to each other, todo #21)

- Through the relay: a revocation reaches a peer through its inbox (30 days of retention) and is merged grow-only; each revocation document carries the whole list of the admin, so a later one repairs an earlier loss.
- Catch-up between peers (no relay involved): after the mutual TLS and the pair proof, the CLIENT of a `machine run` sends `hello` as the first application frame (`revocationDigest` of the merged entries, `revocationVersion` = highest `issuedAt` among its signed lists, 0 when none; the version is informational). The server answers with its own `hello` and, when the digests differ and it holds signed lists, ONE `revocations` frame carrying ALL of them (`{lists: [{body, signature}, ...]}`, at most 32), or `{unavailable}` with a fixed reason when they do not fit the frame cap. The client then sends its own lists the same way, once, from what it held before the exchange. The version never decides who sends: two admin machines may each hold a list the other lacks, and both sides send once, so they converge in one handshake with no progress loop. A `revocations` frame has no answer; one `hello` and one `revocations` frame per session.
- What is kept: `revocation-lists.json` holds a bounded set (32 lists, 2 MiB) of verified admin-signed lists, rebuilt canonical (`{body, signature}` only, at most 4096 entries each), deduplicated by signature and pruned only when every uuid and serial of a list is covered by the union of the others; when the bound is hit the oldest list goes (the merged entries in `revocations.json` are never reduced). `admin revoke` signs the union of what is installed at signing time, read inside the lock after the passphrase prompt, with a version above the held ones; `admin distribute` re-sends the list that already covers exactly the revocations, otherwise signs and installs a new union.
- Writers: every write of `revocations.json` and `revocation-lists.json` (daemon, inbox, CLI) runs under one cross-process lock (`revocations.json.lock`) and re-reads inside it; `revocation-seen.json` has its own lock. The read state is cached by file mtime, size and inode, so a handshake costs no verification unless a file changed; a list whose signature is already stored is not verified again.
- Rules for a received list: verified against the pinned admin key (wrong key or altered body refused), ALWAYS merged grow-only whatever its `issuedAt` (an older list still adds its revocations), refused when dated more than a day ahead of this clock (audited `revocation-catchup-refused`, reason `future`). One audit summary line per frame (`revocation-catchup`: lists, accepted, refused, changed). A bad list is dropped and the session continues unless the merged lists revoke the peer itself.
- Open sessions: the daemon keeps a registry of open sessions. After a catch-up install, an inbox install (`onRevocationInstalled`) or any reload, every session whose peer is no longer in the directory is closed (audited `session-closed`, reason `peer-revoked`), and every request re-checks the peer (refused `peer-revoked`, then closed), so a revocation made by `machine admin revoke` in another process takes effect at the next request (within the 5 s network cache). On the client side `machine run` fails naming a peer that turns out revoked.
- Limits: at most 6 catch-up exchanges per peer per minute (later ones get a `rate-limited` refusal, audited once per peer per minute); nothing local (paths, system errors) is ever sent to a peer, only fixed messages; the details stay in the local log and audit.
- Pre-authentication limits are untouched: the hello travels after the proof; the 16-connection cap and the 1 KiB pre-auth buffer apply as before (transport test).
- Older builds: a server that does not know `hello` answers `refused unknown-message` (the client says the peer cannot catch up and goes on); a client that sends no hello is served as before and the absence is audited once per peer per process (`revocation-hello-missing`).
- Admin view: each handshake records what the peer announced (`<configDir>/revocation-seen.json`: version, digest, time; a corrupt file counts as empty with a warning). `machine list --json` shows `revocationVersionSeen` and `revocationSeenAt`; `machine status` shows `revocationVersion` and `peersBehind`, the peers whose announced DIGEST differs from ours (the version is informational). It is what the peer held BEFORE the exchange of that handshake, not an acknowledgement that a list we sent was accepted.
- Residual: a machine converges only when it meets a peer holding the lists (one of them, after the exchange, holds both). An offline pair, or a peer that never connects to anyone holding the lists, still waits for the relay document. A `revocations.json` held before this change has no signed list: it hands nothing on until the next admin list (or `machine admin distribute <machine>`) reaches it, but it still receives. A revocation covers the registration serials up to the one the admin holds: the admin must hold the latest registration it issued for each machine it revokes. A revocation made by `admin revoke` in another process closes open sessions only at the peer's next request (or at the next install seen by the daemon).

## Re-approval of a known uuid and the admin machine itself (2026-11-14)

- First machine = admin machine: its candidacy is approved by itself; no peer entry for itself, no document to itself, no final code to compare (nothing differs between the two sides), `join` says "no other machine yet".
- Renewal (same uuid, same identity key): `admin approve` distributes the new registration (higher serial) to the existing peers like a new machine; for the admin machine itself each peer receives a `peer` document carrying the pair secret it already shares with the admin (unchanged, otherwise both sides would disagree).
- Different identity key for a known uuid: refused before any question or signature unless the relay reports `uuidBound` (explicit rebind, confirmed by a y/N text naming the key change); the old key is replaced locally, peers learn the higher serial, nothing is revoked automatically; `machine admin revoke` revokes the whole uuid, not only the old key.
- `machine admin distribute <admin machine>` is a deliberate no-op (exit 0, says so).
