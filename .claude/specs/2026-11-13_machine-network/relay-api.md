# Relay API for machine (resource `machines`)

**Version:** v0.2 (2026-11-14, paths and errors aligned with the implemented relay). Contract between the `machine` CLI/app-module and poc-node (relay). Decisions 28-37 and 41.

The relay is untrusted (threat model A-1): it stores and serves opaque signed documents, never decides trust, never sees a passphrase or a private key, never carries commands.

## Auth and scopes

| Caller | Token | May do |
|---|---|---|
| A machine (daemon, CLI) | `machine` scope, Bearer | calls marked **M** |
| The admin console (local app-module) | full access | calls marked **A** |

The `machine` scope opens only: `POST` candidacy, `GET` own candidacy, `GET /api/machines`, `GET|PUT /api/machines/{uuid}`, `POST /api/machines/{uuid}/heartbeat`. Listing candidacies and deciding one need a full-access token (`full_access_required`, 403 otherwise).

JSON bodies, `Content-Type: application/json`. Every route lives under `/api` (token gate, scope check and audit apply there). Unknown JSON fields: 400.

Errors: `{ "success": false, "error": "<code>", "message": "<what happened and the fix>", "serverTime": <epoch seconds> }`. Codes: `invalid_body`, `invalid_json`, `invalid_uuid`, `invalid_if_match`, `identity_key_in_use` (409: a pending key re-posted by ANOTHER token; the same token replaces its entry), `too_many_candidacies` (429), `not_found` (404), `not_pending` (409), `not_owner` (403), `precondition_failed` (412, with `currentEtag`), `full_access_required` (403), `too_many_machines` (429, 1000 max), `store_unavailable` (503). A record `PUT` answers `{ "success": true, "etag" }` plus an `ETag` header; `GET /api/machines/{uuid}` adds `etag`.

## Candidacy (enrollment, decisions 35, 35a, 37)

| Call | Scope | Body | Answer |
|---|---|---|---|
| `POST /api/machines/candidacies` | M | `{ name, hostname, identityPublicKey, random }` | `201 { id, createdAt, expiresAt }` |
| `GET /api/machines/candidacies/{id}` | M (the creating token only) | - | `200 { status: "pending" }` or `{ status: "approved", approval }` or `{ status: "rejected" }`; `404` once expired |
| `GET /api/machines/candidacies` | A (read-only view in the relay web UI too, decision 41) | - | `200 { candidacies: [ { id, name, hostname, identityPublicKey, random, observedIp, createdAt, expiresAt } ] }` |
| `PUT /api/machines/candidacies/{id}/decision` | A | `{ decision: "approve", approval }` or `{ decision: "reject" }` | `204`; `409` when not pending |

Field rules: `name` matches `^[a-z0-9][a-z0-9-]{0,31}$`; `hostname` printable ASCII, 1-64 characters (self-declared, informative); `identityPublicKey` unpadded base64url of 32 bytes; `random` unpadded base64url of 16 bytes; `id` is 128 random bits (base64url), chosen by the relay; `observedIp` is the peer address seen by the relay (server side, never client supplied).

`approval` is an opaque JSON object, at most 16 KiB. The relay does not read it (it holds the signed registration and sealed pair secrets).

Limits: a candidate re-posting the same `identityPublicKey` while pending replaces its entry (same `id`, expiry restarted). At most 4 pending per token and 32 in total; beyond that `429`.

Lifetime: a candidacy lives 15 minutes from creation (`expiresAt`), in memory only (a relay restart drops them; the candidate posts again). An approved or rejected entry is kept 5 minutes so the candidate can read it, then dropped.

The verification code (decision 35a) is computed by the CLI and by the admin page from `identityPublicKey` and `random`; the relay never computes it. The relay UI may show the fields above, informative only.

## Machines resource: address and presence (decision 34)

| Call | Scope | Body | Answer |
|---|---|---|---|
| `PUT /api/machines/{uuid}` | M | signed address record (below) | `200 { etag }` |
| `POST /api/machines/{uuid}/heartbeat` | M | empty | `204` |
| `GET /api/machines` | M, A | - | `200 { machines: [ { uuid, record, lastSeen, online } ] }` |
| `GET /api/machines/{uuid}` | M, A | - | `200 { uuid, record, lastSeen, online }` or `404` |

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

## Deployed limits (relay 2026.11.14-140, reported by poc-owner)

- At most 50 machine records per token (`429 too_many_machines`); the global cap stays 1000.
- Re-`PUT` of an identical record only refreshes presence.
- A record stays bound to the token that first wrote it. After a token rotation, a full-access token must write it once; there is no delete or reassign endpoint yet.
- Malformed ids or uuids (upper-case, trailing slash) are refused by the scope gate with `403`, not `400`: the client must send canonical lower-case uuids and no trailing slash.
- A `machine` token is created in the relay console: Tokens, Add token, "Limited to scopes", machine. Not yet tested authenticated against the live relay.

## Pairing claim (token for `machine join`, decision 28)

`POST /api/pairings/claim` is PUBLIC (no Authorization, no cookie), JSON body `{ "code": "12345678" }` (spaces and hyphens accepted, 32 characters max). `200 { success: true, serverTime, token, label, scopes }`: `token` is shown once, `scopes` is `["machine"]` for a pairing opened with scope machine (`null` means full access: the client must refuse it). The pairing is opened in the console (Tokens, Add token, "Limited to scopes", machine). The claimed token can call `POST /api/machines/candidacies` at once.

Errors (`{ success: false, error: "<human text>", serverTime }`; here `error` is text, not a code): 400 and 401 `Invalid or expired code.` (wrong, malformed, used or expired: same answer on purpose), 429 with `Retry-After` and `retryAfterSeconds`, 409 or 5xx `The code was valid but is now used up ...` (ask the admin for a new code). A code is valid 5 minutes and works once; 5 failed attempts per 10 minutes per IP lock that IP, and 5 wrong codes cancel the open code.
