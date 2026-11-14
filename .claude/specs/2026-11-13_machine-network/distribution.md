# Distribution of signed documents through the relay

**Version:** v0.1 draft (2026-11-14), to be reviewed by poc-owner. Closes todo #15, #14c, #14e. The relay stays a dumb store: it holds opaque documents, never decides trust.

## Problem

After `machine admin approve`, only the admin and the new machine know each other. Machine C must also learn about machine D (registration and pair secret), each machine must receive its own policy, and a revocation must reach every peer, including peers that were offline.

## Documents

Every document is a JSON object signed by the admin key (same signing rules as registrations, domain-separated), addressed to one machine:

```json
{ "body": { "v": 1, "kind": "peer" | "policy" | "revocation", "to": "<uuid>", "id": "<base64url 16 bytes>", "issuedAt": 1800000000, "expiresAt": 1802600000, "payload": { } },
  "signature": "<base64url Ed25519 over the canonical body, admin key>" }
```

| kind | payload | Secret content |
|---|---|---|
| `peer` | the peer's signed registration and `sealedPairSecret` (sealed to the recipient identity key, context binds both uuids) | pair secret, only sealed |
| `policy` | the signed policy for `to` (existing format) | none |
| `revocation` | the signed revocation list (existing format) | none |

The recipient verifies the admin signature against its pinned admin key, `to` equals its own uuid, `expiresAt` not passed, then installs through the existing validators (`importPeer`, `installPolicy`, `installRevocation`). A document that fails is dropped and reported, never partly applied.

## Relay resource (proposal for poc-owner)

| Call | Scope | Answer |
|---|---|---|
| `PUT /api/machines/{uuid}/inbox/{id}` | A (full access) | `204`; body is the document (at most 16 KiB); idempotent on the same `id` and the same bytes, `409` if the `id` exists with other bytes |
| `GET /api/machines/{uuid}/inbox` | M of the token that owns `uuid` (the first token that wrote its address record), or A | `200 { documents: [ { id, document, storedAt } ] }` |
| `DELETE /api/machines/{uuid}/inbox/{id}` | M owner, or A | `204` (a machine acknowledges after installing) |

Limits proposed: 64 documents per inbox, 30 days retention from `storedAt`, `too_many_documents` 429 when full (the admin is told which machine is not draining). The relay checks the JSON shape and size only; it cannot verify signatures.

## Flow

1. `admin approve` also PUTs, for each existing peer P of the admin: a `peer` document to P about the new machine, and a `peer` document to the new machine about P (sealed secrets), plus fresh `policy` documents when the admin signs one.
2. `admin revoke` PUTs a `revocation` document to every other machine.
3. Each daemon reads its inbox at start and every 60 s (the heartbeat period), installs valid documents, DELETEs them, and logs rejected ones (audit log, never silent).
4. A machine that was offline reads the inbox when it returns; documents older than their `expiresAt` are ignored, so a stale policy cannot be replayed after expiry; versions and serials in the documents keep the monotonic rules (decision 44).

## Open points

- Which token reads an inbox: only the owner token of `uuid` (proposal) or any machine token.
- A removed machine's inbox: purge on revoke, or keep until retention.
- The admin machine's own view: it applies the same documents locally at once; others converge within one polling period (offline machines later).
