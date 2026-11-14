# Distribution of signed documents through the relay

**Version:** v0.2 (2026-11-14), reviewed and amended by poc-owner. Closes todos #15, #14c, #14e. The relay stays a dumb store: opaque documents, no trust decision.

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

## Client work (machine side, after poc-owner ships)

`inbox` client calls in `relayClient.ts`; document builders and verifiers in machine-core (no I/O); admin side (`approve`, `revoke`) PUTs; daemon loop (heartbeat, inbox, install, acknowledge, audit); fake relay with the same routes; tests first.
