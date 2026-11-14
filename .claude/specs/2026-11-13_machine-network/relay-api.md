# Relay API for machine (resource `machines`)

**Version:** v0.1 (2026-11-14). Contract between the `machine` CLI/app-module and poc-node (relay). Decisions 28-37 and 41.

The relay is untrusted (threat model A-1): it stores and serves opaque signed documents, never decides trust, never sees a passphrase or a private key, never carries commands.

## Auth and scopes

| Caller | Token | May do |
|---|---|---|
| A machine (daemon, CLI) | `machine` scope, Bearer | calls marked **M** |
| The admin console (local app-module) | full access | calls marked **A** |

JSON bodies, `Content-Type: application/json`. Errors: `{ "error": "<code>", "message": "<what happened and the fix>" }`. Unknown JSON fields: 400.

## Candidacy (enrollment, decisions 35, 35a, 37)

| Call | Scope | Body | Answer |
|---|---|---|---|
| `POST /machines/candidacies` | M | `{ name, hostname, identityPublicKey, random }` | `201 { id, createdAt, expiresAt }` |
| `GET /machines/candidacies/{id}` | M (the creating token only) | - | `200 { status: "pending" }` or `{ status: "approved", approval }` or `{ status: "rejected" }`; `404` once expired |
| `GET /machines/candidacies` | A (read-only view in the relay web UI too, decision 41) | - | `200 { candidacies: [ { id, name, hostname, identityPublicKey, random, observedIp, createdAt, expiresAt } ] }` |
| `PUT /machines/candidacies/{id}/decision` | A | `{ decision: "approve", approval }` or `{ decision: "reject" }` | `204`; `409` when not pending |

Field rules: `name` matches `^[a-z0-9][a-z0-9-]{0,31}$`; `hostname` printable ASCII, 1-64 characters (self-declared, informative); `identityPublicKey` unpadded base64url of 32 bytes; `random` unpadded base64url of 16 bytes; `id` is 128 random bits (base64url), chosen by the relay; `observedIp` is the peer address seen by the relay (server side, never client supplied).

`approval` is an opaque JSON object, at most 16 KiB. The relay does not read it (it holds the signed registration and sealed pair secrets).

Limits: a candidate re-posting the same `identityPublicKey` while pending replaces its entry (same `id`, expiry restarted). At most 4 pending per token and 32 in total; beyond that `429`.

Lifetime: a candidacy lives 15 minutes from creation (`expiresAt`), in memory only (a relay restart drops them; the candidate posts again). An approved or rejected entry is kept 5 minutes so the candidate can read it, then dropped.

The verification code (decision 35a) is computed by the CLI and by the admin page from `identityPublicKey` and `random`; the relay never computes it. The relay UI may show the fields above, informative only.

## Machines resource: address and presence (decision 34)

| Call | Scope | Body | Answer |
|---|---|---|---|
| `PUT /machines/{uuid}` | M | signed address record (below) | `200 { etag }` |
| `POST /machines/{uuid}/heartbeat` | M | empty | `204` |
| `GET /machines` | M, A | - | `200 { machines: [ { uuid, record, lastSeen, online } ] }` |
| `GET /machines/{uuid}` | M, A | - | `200 { uuid, record, lastSeen, online }` or `404` |

Signed address record, at most 2 KiB, stored as is:

```json
{ "body": { "v": 1, "uuid": "<uuid>", "addresses": [ { "host": "192.168.1.20", "port": 47921 } ], "seq": 12, "issuedAt": 1800000000 },
  "signature": "<base64url Ed25519 over the canonical body, signed by the machine identity key>" }
```

The relay cannot verify the signature (it does not know which key is registered); peers do, against the admin-signed registration, and ignore a record that does not verify or whose `seq` is lower than the highest they saw (T-33). The relay only checks the JSON shape, the size and that `body.uuid` equals the path `{uuid}`.

Writes are compare-and-set: `If-Match: <etag>` is honoured when present (as the other file-based resources). The first token to `PUT` a `uuid` owns it: later writes to that `uuid` need the same token or full access (limits a rogue machine token to its own record).

Presence: `lastSeen` is the time of the last `PUT` or `heartbeat` for that `uuid`, in memory. `online` is `true` when `lastSeen` is less than 120 s old. Machines send a heartbeat every 60 s. The address records themselves persist in the file-based resource.

## Not in this version

Distribution of registrations, revocation lists and policies through the relay is a separate contract (it follows once the local flow is validated). Until then `machine admin register`, `machine peer import` and `machine policy install` move those documents by file (decision 48).
