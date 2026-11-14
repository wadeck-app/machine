# Distribution of signed documents through the relay

**Version:** v0.3 (2026-11-14), client implemented, relay deployed (sections at the end). Closes todos #15, #14c, #14e. The relay stays a dumb store: opaque documents, no trust decision.

## Problem

After `machine admin approve`, only the admin and the new machine know each other. Machine C must also learn about machine D (registration and pair secret), each machine must receive its own policy, and a revocation must reach every peer, including peers that were offline.

## Documents

Every document is a JSON object signed by the admin key (domain-separated like registrations), addressed to one machine:

```json
{ "body": { "v": 1, "kind": "peer" | "policy" | "revocation", "to": "<uuid>", "id": "<22 chars base64url>", "issuedAt": 1800000000, "expiresAt": 1802600000, "payload": { } },
  "signature": "<base64url Ed25519 over the canonical body, admin key>" }
```

| kind | payload | Secret content |
|---|---|---|
| `peer` | the peer's signed registration and `sealedPairSecret` (sealed to the recipient identity key, context binds both uuids) | pair secret, only sealed |
| `policy` | the signed policy for `to` (existing format) | none |
| `revocation` | the signed revocation list (existing format) | none |

The recipient verifies the admin signature against its pinned admin key, `to` equals its own uuid, `expiresAt` not passed, then installs through the existing validators (`importPeer`, `installPolicy`, `installRevocation`). A document that fails is dropped and reported in the audit log, never partly applied and never silent.

## Relay resource (agreed with poc-owner)

| Call | Scope | Answer |
|---|---|---|
| `PUT /api/machines/{uuid}/inbox/{id}` | A (full access) only | `204`; same bytes again `204`; same `id` with other bytes `409 id_conflict`; `body.to` must equal `{uuid}` and `body.id` must equal `{id}` (`400` otherwise); id is 22 characters base64url; request at most 32 KiB, document at most 16 KiB |
| `GET /api/machines/{uuid}/inbox` | M of the token that owns `uuid`, or A | `200 { documents: [ { id, document, storedAt } ], more, next }`; oldest first, at most 32 per call, the client loops with `next`; another token gets `403` (no oracle on unknown uuids) |
| `DELETE /api/machines/{uuid}/inbox/{id}` | M owner, or A | `204`, also for an unknown id (idempotent) |
| `DELETE /api/machines/{uuid}` | A only | removes the address record, the owner binding and the inbox; used by `admin revoke` and by token rotation |
| `POST /api/machines/{uuid}/heartbeat` | M | `200 { inbox: { count } }` (changed from `204`): the daemon reads the inbox only when `count > 0` |

Limits: 256 documents and 16 KiB each per inbox, a global cap of 64 MiB for all inboxes; `429 too_many_documents` (one inbox full, the message names the uuid not draining) and `429 relay_inbox_full` (global); retention 30 days from `storedAt`, swept hourly and at read. Writes are audited as `machine_inbox_put` (uuid, id, size, never the document). One file per document on the relay, so address writes stay small.

Ownership: the owner of `uuid` is the first token that wrote its address record. The admin may PUT documents for a uuid that has no record yet (normal case: approval precedes the first record); that inbox is ownerless, subject to the same limits and retention, and the machine owns it when it first PUTs its record. After a token rotation the admin calls `DELETE /api/machines/{uuid}`, the machine writes its record again and owns it again.

## Flow

1. `admin approve` PUTs, for each existing peer P of the admin: a `peer` document to P about the new machine and a `peer` document to the new machine about P (sealed secrets), plus fresh `policy` documents when the admin signs one. Documents addressed to a peer number one per peer: a network of 60+ machines does not overflow an inbox.
2. `admin revoke` PUTs a `revocation` document to every other machine, then calls `DELETE /api/machines/{uuid}` for the revoked machine (peers learn through the revocation document, not through the relay).
3. Each daemon sends its heartbeat every 60 s, reads the inbox when `inbox.count > 0` (and once at start), installs valid documents, DELETEs each handled document, and records rejected ones in the audit log.
4. An offline machine reads its inbox when it returns. Freshness stays on the client side (the relay cannot judge it): `expiresAt` and the monotonic version and serial rules of decision 44 apply, so a stale policy cannot be installed after expiry or over a newer one.

## Threats considered

| Threat | Handling |
|---|---|
| Relay reads documents | `peer` documents hold only sealed secrets; policies and revocations are not secret |
| Relay drops, delays or replays documents | detected or bounded client side: signatures, `expiresAt`, monotonic versions; dropping delays convergence only (an offline machine keeps its last policy and revocation list) |
| Stolen machine token floods or reads | machine tokens cannot PUT; reads and deletes only on the owned uuid |
| Squatting an ownerless inbox | needs the uuid (122-bit random, known to the admin and the machine); the admin can purge with `DELETE /api/machines/{uuid}` |
| Disk fill | per-inbox and global caps, audited writes |
| uuid enumeration | `GET /api/machines` already lists uuids to every machine token (existing contract); inbox answers do not add an oracle |


## Document format details (implemented, machine-core `document.ts`)

- Domain `machine/document/v1`. Strict shape: unknown fields refused at every level, document at most 16 KiB (checked before the signature), `id` is 22 characters of canonical base64url.
- Verify order: shape, size, pinned key, signature, addressee (`to`), time window (skew 30 s), payload. A failure before the end of the signature check is reported as `signed: false` (junk or forgery); after it, the failure is a verdict on a document of the admin. `expiresAt - issuedAt` is at most 30 days. A registration or a policy dated slightly ahead of the receiver clock is deferred (kept in the inbox), not rejected; `importPeer` has the same 30 s tolerance as the documents.
- `peer` payload is `{ registration, sealedPairSecret, adminUuid }`. `adminUuid` (the admin machine, or null) is an addition to the draft: the receiver does not store it otherwise, and the document signature authenticates it.
- Seal context of the pair secret: `pair-secret:<adminUuid|none>:<to>:<peerUuid>` (sender, addressee, subject). The document id is not in the context: the admin signature covers `id` and the sealed value together.
- The pair secret of a pair (D, P) is derived from the admin key: HMAC-SHA256, keyed by an HKDF-SHA256 subkey of the admin seed (info `machine/pair-secret/v1`, never the raw signing key), over both uuids and serials sorted by uuid. Both documents carry the same secret, a retry (or another admin machine holding the key) seals the same value, and it is not the secret the admin shares with either machine. Consequence (threat-model T-36, AR-7): whoever holds the unlocked admin key can recompute every pair secret from the public registrations; pair secrets add no protection against theft of the admin key, and still protect against a stolen identity key alone and against the relay.
- A `policy` payload target must equal `to`; a `revocation` carries the whole local revocation list of the admin.

## Ids, dates and retry (implemented, `distribute.ts`)

| Kind | id = first 16 bytes of SHA-256 of | issuedAt / expiresAt |
|---|---|---|
| `peer` | `peer:<to>:<to serial>:<about>:<about serial>` | later `validFrom` of both registrations / min(+30 days, both `validTo`) |
| `policy` | `policy:<target>:<version>:<signature>` | policy `issuedAt` / min(+30 days, `notAfter`) |
| `revocation` | `revocation:<to>:<signature>` | signing time / +30 days |

- Ed25519 is deterministic, but sealing is random: a re-PUT of a `peer` document has other bytes, so the relay answers `id_conflict`. The admin treats that as "already delivered" and reports it. `policy` documents are byte-identical on retry. A re-signed revocation has a new signature, hence a new id.
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
- A machine owns its inbox once it publishes its signed address record (relay-api.md, "Client behaviour of address records"); the daemon does it at the start of each round, before the heartbeat. After a token rotation `not_owner` is said once with the fix `machine admin forget-relay-record <machine>`. Fake relay only; never run against the real relay.

## Deployed behaviour (poc-owner, commit 4ff0469)

- Errors `{ success: false, error, message }`: `invalid_body`, `invalid_id`, `invalid_uuid`, `invalid_cursor` (400); `full_access_required`, `not_owner`, `scope_denied` (403; `not_owner` is the same answer for unknown, unowned and foreign uuids, so no inference about existence); `id_conflict` (409); `body_too_large` (413 above 32 KiB); `too_many_documents`, `relay_inbox_full` (429); `store_unavailable` (503).
- `scope_denied`: a machine token calling `PUT` inbox or `DELETE` machine. Machine tokens may only `GET` the inbox and `DELETE` documents of their own uuid.
- Listing: oldest first (arrival order), 32 per call, next page with `?after=<next>` (the client sends exactly that).
- `DELETE` of an unknown document id or an unknown machine is 204. Heartbeat answers `200 { success, inbox: { count } }`.
- An inbox written before the machine wrote its record is claimed by the first machine token that writes that uuid record; `DELETE /api/machines/{uuid}` resets.
- The relay keeps no tombstone of acknowledged ids: a replayed PUT of an acknowledged id is stored again. The daemon therefore keeps its own persistent set of handled ids (above), on top of the version and serial rules.


## Revocation reach (open)

- A revocation reaches a peer only through its inbox (30 days of retention) and is merged grow-only; each revocation document carries the whole list of the admin, so a later one repairs an earlier loss. A peer offline longer than that, or one whose document the relay dropped, stays unaware until a later list reaches it.
- Not built: catch-up between peers at the handshake with `revocationDigest`, and an admin view of which machine holds which revocation (todo #21, threat-model T-06).
