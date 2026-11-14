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
| `POST /api/machines/candidacies` | M | `{ name, hostname, identityPublicKey, random, uuid? }` | `201 { id, createdAt, expiresAt }` |
| `GET /api/machines/candidacies/{id}` | M (the creating token only) | - | `200 { status: "pending" }` or `{ status: "approved", approval }` or `{ status: "rejected" }`; `404` once expired |
| `GET /api/machines/candidacies` | A (read-only view in the relay web UI too, decision 41) | - | `200 { candidacies: [ { id, name, hostname, identityPublicKey, random, observedIp, createdAt, expiresAt } ] }` |
| `PUT /api/machines/candidacies/{id}/decision` | A | `{ decision: "approve", approval }` or `{ decision: "reject" }` | `204`; `409` when not pending |

Field rules: `name` matches `^[a-z0-9][a-z0-9-]{0,31}$`; `hostname` printable ASCII, 1-64 characters (self-declared, informative); `identityPublicKey` unpadded base64url of 32 bytes; `random` unpadded base64url of 16 bytes; `id` is 128 random bits (base64url), chosen by the relay; `observedIp` is the peer address seen by the relay (server side, never client supplied).

`approval` is an opaque JSON object for the relay, at most 16 KiB; its format is in the Approval section. Its pair secrets are sealed to the candidate identity key, so the relay cannot read them (T-36).

Limits: a candidate re-posting the same `identityPublicKey` while pending replaces its entry (same `id`, expiry restarted). At most 4 pending per token and 32 in total; beyond that `429`.

Lifetime: a candidacy lives 15 minutes from creation (`expiresAt`), in memory only (a relay restart drops them; the candidate posts again). An approved or rejected entry is kept 5 minutes so the candidate can read it, then dropped.

The verification code (decision 35a) is computed by the CLI and by the admin page from `identityPublicKey` and `random`; the relay never computes it. The relay UI may show the fields above, informative only.

## Approval (decisions 35, 35a, 48)

`approval` is the JSON object the admin console puts in `PUT .../decision` and the candidate reads back. The relay stores it as is. Documents reuse the formats of the manual flow (decision 48), so one code path verifies both.

```json
{ "v": 1,
  "self":  { "registration": { "body": { }, "signature": "..." }, "sealedPairSecret": "<base64url, sealTo(candidate identity key)>" },
  "admin": { "v": 1, "adminPublicKey": "<base64url>", "adminKeyId": "<32 hex>" },
  "adminUuid": "<uuid of the admin machine, or null when it has no identity>",
  "peers": [ { "registration": { }, "sealedPairSecret": "..." } ],
  "random": "<random of the candidacy this approval answers>" }
```

| Field | Content | Candidate check |
|---|---|---|
| `self` | registration of THIS machine plus its sealed pair secret (opened, it is the `PeerBundle` of network.ts) | signed by `admin`, in its validity window; uuid, name and identity key equal to this machine. Not stored (nothing consumes it yet) |
| `admin` | the admin's `admin.json` | pinned with the `machine admin pin` logic (`pinAdminDocument`), only after the final code is confirmed; a different key already pinned is refused |
| `adminUuid` | uuid of the machine that holds the pair secrets; part of the seal context | lower-case UUID or `null`; a relay that changes it only makes opening fail |
| `peers` | sealed bundles the admin chose to include (may be empty) | each verified against `admin`, then `importPeer` |
| `random` | the `random` of the candidacy, written by `machine admin approve` | checked FIRST, before anything else: missing or different from the candidate's own random = refused as a replay or mix-up of candidacies (the candidacy file is dropped, nothing pinned). UNSIGNED (the relay can set it): it only catches an old or mixed-up approval, it is not a security check; the final code stays the one |

**Sealing (decision 22, T-36):** each `sealedPairSecret` is `sealTo(candidate identity public key, pair secret, context)` from machine-core `seal.ts` (Ed25519 key converted to X25519, ephemeral X25519, HKDF-SHA256, AES-256-GCM; wire format and checks in the source). Context: `pair-secret:<adminUuid or none>:<candidate uuid>:<candidacy random>:<slot>`, slot `self` or `peer:<uuid of the peer>`, so a sealed value cannot be reused for another admin, candidate, candidacy or entry. The candidate opens with its identity private key AFTER every registration is verified, then checks 32 bytes and imports through the existing validators. An entry with a clear `pairSecret` (older admin) is refused loudly: the candidacy is dropped and the message tells the admin to update machine. The local `PeerBundle` file of the manual flow (decision 48) is unchanged and still carries the secret in clear (it never goes through the relay).

**Time limits (every wait for a human is bounded, so a stale prompt, approval or replayed document cannot be completed later):** every question to a person (y/N, passphrase, final code, pairing code) is cancelled after 120 s by default (`--prompt-timeout <s>`, 1 to 3600; never an implicit answer; nothing signed, pinned or revoked; a late value is dropped). The wait for the admin is `--timeout` (default 900 s) and never outlasts the candidacy (`expiresAt` + 5 s, the relay answers 404). A device code is waited for at most `min(expiresIn, 900 s)` + 5 s. An approval received but not confirmed is kept 15 minutes in `relay-candidacy.json` (`approvalReceivedAt`): older, or without a date, it is discarded with `ask the admin to approve again: run machine join --resume`, the candidacy is dropped (the next one has a new random) and nothing is pinned; the age is checked again at the moment of the pin. `machine admin approve` refuses to sign for a candidacy that expired while it was asking.

Unknown fields are refused. Everything is verified before anything is pinned or stored; one failure refuses the whole approval.

Verification proves consistency, NOT that `admin` is the real admin: a relay can replace the whole approval with one signed by its own key (T-05). Only the final code (decision 35a) catches this: `finalCode(candidate key, admin.adminPublicKey, random)`, shown by the candidate and by the admin console, compared by a human before the pin. The candidate prints it alone on a line, then asks y/N (terminal) or compares it with `--yes-final-code` (headless). It never pins silently.

Candidate behaviour (`machine join [<relay-host-or-url> | <code>]`, `machine join --resume`): polls `GET /api/machines/candidacies/{id}` every 3 s, honours `Retry-After` on 429, retries network errors and 5xx with a warning, ends on approved, rejected, 404 (expired), `--timeout` (default 900 s) or Ctrl-C. Token and pending candidacy (`_secrets_/relay-candidacy.json`, mode 0600, holds the approval once received) are kept on timeout and Ctrl-C; `--resume` continues, and posts a fresh candidacy (new random, same name and key) when the old one is gone. `--no-wait` posts and returns.

**Candidacy uuid:** the CLI always sends `uuid` (canonical lower-case, from the identity), because the admin signs the registration for it. The relay side is committed by poc-owner (76b2b5c) but not deployed: the currently deployed relay refuses the unknown field (400), so `join` fails there until the deployment. `--resume` posts a new candidacy when the saved one has no uuid.

**Admin side (CLI, `machine admin login` / `machine admin approve`):** the admin token comes from a pairing opened WITHOUT "Limited to scopes" (`scopes: null`); the client refuses a scoped one. The CLI recomputes the candidacy code from `identityPublicKey` and `random`, and refuses to approve when a code field sent by the relay differs. `approve` refuses a candidacy without `uuid`. `approval.peers` holds the admin machine itself (same pair secret as `self`, which the admin imports); the admin's pair secrets with its other peers are never handed to a third machine.

## Machines resource: address and presence (decision 34)

| Call | Scope | Body | Answer |
|---|---|---|---|
| `PUT /api/machines/{uuid}` | M | signed address record (below) | `200 { etag }` |
| `POST /api/machines/{uuid}/heartbeat` | M | empty | `200 { inbox: { count } }` (was `204`, see distribution.md) |
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

## Client behaviour of address records (implemented, fake relay only)

- Body signed with the identity key, domain `machine/address-record/v1`; 1 to 8 addresses (IPv4/IPv6 literal or DNS name, no URL, user or zone), seq at least 1, record at most 2 KiB. Readers refuse: wrong uuid or signature, lower seq (rollback), same seq with other bytes, `issuedAt` more than 30 s ahead or over 30 days old.
- Publisher (daemon, enrolled machine with relay.json): ticked by the inbox-loop timer, right after each heartbeat. Publishes at start, when the address set changes, and every 7 days. Seq in `_secrets_/address-state.json`, written before signing; a failed PUT is retried with the same record. The first GET adopts the relay's seq only when that record verifies with this machine's own key; `If-Match` from the last etag, one retry after 412.
- Seq: above max(state file, seq of the relay's record if signed by this machine, the clock) so a lost state starts above anything published before.
- Addresses: `--advertise <host[:port]>` (repeatable; 0.0.0.0 and :: refused) replaces everything; else the single bound `--peer-host`; else non-internal interface addresses (no 169.254/16, no fe80::/10), IPv4 first, 8 at most (private ranges and interfaces not named like a virtual adapter first: a name and range heuristic, no route table; a truncation is a loud warning). Nothing to publish = loud warning, no publication. Loopback bind without `--advertise` = same.
- Errors: `not_owner` once, no backoff, recovers by itself after `machine admin forget-relay-record <machine|uuid>` (DELETE with the admin token, y/N, also deletes the inbox). 429 (Retry-After) and 5xx back off 60 s doubling to 600 s; one warning per distinct message.
- Readers (`machine run` without `--address`, `machine list`): record verified against the local registration, highest seq kept per peer in `peer-records.json`; addresses tried in order, 3 s each, every failure reported. `list` uses one `GET /api/machines`; relay trouble is a warning line, last known addresses stay shown. Offline per the relay is a warning, the addresses are still tried.
- Reader destination rules (audit S-14): per address of a peer record, loopback, unspecified and link-local (169.254/16 incl. the metadata service, fe80::/10), also as IPv4-mapped IPv6, are refused with a visible reason; all refused = an error. Hosts ending in a number (`0x7f.1`, `1.2.3.0x4`) are refused in records.
- Every relay answer is read with a cap (64 KiB by default, 4 KiB one record, 3 MiB the machine list, 1 MiB an inbox page); a larger one is a loud error naming the limit.
- The heartbeat goes out first in a round; the record is published right after it. `peer-records.json` is written under a lock file with the data flushed (`peer forget-record <peer>` is the only way to lower it, per peer).

## Not in this version

Distribution of registrations, revocation lists and policies through the relay (inbox routes, documents): see distribution.md. `machine admin register`, `machine peer import` and `machine policy install` still move those documents by file (decision 48).

## Deployed limits (relay 2026.11.14-140, reported by poc-owner)

- At most 50 machine records per token (`429 too_many_machines`); the global cap stays 1000.
- Re-`PUT` of an identical record only refreshes presence.
- A record stays bound to the token that first wrote it. After a token rotation, a full-access token must write it once; there is no delete or reassign endpoint yet.
- Malformed ids or uuids (upper-case, trailing slash) are refused by the scope gate with `403`, not `400`: the client must send canonical lower-case uuids and no trailing slash.
- A `machine` token is created in the relay console: Tokens, Add token, "Limited to scopes", machine. Not yet tested authenticated against the live relay.

## Pairing claim (token for `machine join`, decision 28)

`POST /api/pairings/claim` is PUBLIC (no Authorization, no cookie), JSON body `{ "code": "12345678" }` (spaces and hyphens accepted, 32 characters max). `200 { success: true, serverTime, token, label, scopes }`: `token` is shown once, `scopes` is `["machine"]` for a pairing opened with scope machine (`null` means full access: the client must refuse it). The pairing is opened in the console (Tokens, Add token, "Limited to scopes", machine). The claimed token can call `POST /api/machines/candidacies` at once.

Errors (`{ success: false, error: "<human text>", serverTime }`; here `error` is text, not a code): 400 and 401 `Invalid or expired code.` (wrong, malformed, used or expired: same answer on purpose), 429 with `Retry-After` and `retryAfterSeconds`, 409 or 5xx `The code was valid but is now used up ...` (ask the admin for a new code). A code is valid 5 minutes and works once; 5 failed attempts per 10 minutes per IP lock that IP, and 5 wrong codes cancel the open code.

## Device login (relay token without a pairing code, decision D18)

Public routes, answers `{ success, ... }`, errors `{ success: false, error: "<code>", message, serverTime }`, 429 with `Retry-After` and `retryAfterSeconds`. Status: designed and tested by poc-owner, deployment pending. Client wired in `machine join`, tested against the fake relay only (never the real relay).

- `POST /api/device-login/start` body `{ "label": "laptop-1" }` (1-64 characters: letters, digits, space, `_ . -`) -> `201 { deviceCode (43 characters, secret, kept in the CLI), userCode "BCDF-GH23", expiresIn: 300, pollIntervalSeconds: 3, verificationUrl }`. Limits: 5 starts per 10 minutes per address, 3 pending per address, 20 in total (`too_many_requests`).
- `POST /api/device-login/poll` body `{ "deviceCode" }` -> `{ status: "pending" | "denied" | "expired" }` or `{ status: "approved", token, label, scopes: ["machine"] }` delivered once (the next poll says `expired`). Not faster than every 3 s (the relay answers `slow_down` below 2.5 s) (`slow_down`); 30 polls with an unknown code per 10 minutes per address (`too_many_attempts`). Use the returned `label` (it may carry a "-2" suffix (for example "laptop-2")).
- Console (full access only): the Tokens page lists waiting requests (user code, label, observed address, age). The approver TYPES the user code shown by the CLI; 5 wrong codes deny the request. The token is scope `machine` only. An approved token not collected within 5 minutes is revoked.
- The pairing claim stays as the fallback.

## Enrollment screens (UX requirement, user 2026-11-14)

Every screen that guides enrollment shows a vertical timeline on the left (current step highlighted) and, beside each step, an "i" tooltip saying what the step is for and which threat it addresses. Two places: the relay console approval of the device login (relay access only: request received, origin check on address and label, typed code, token delivered; owner poc-owner) and the admin signing page of `app-module-machine` (candidacy review, passphrase and signature, final code comparison, distribution; WP8). The relay stays a dumb registry: it never shows trust decisions.

## Updates from poc-owner (commit 76b2b5c, deployment pending)

- Candidacy `uuid`: `POST /api/machines/candidacies` accepts an optional lower-case canonical `uuid` (any other format: 400 `invalid_body` naming the format); it is stored and returned by `GET /api/machines/candidacies` when present, omitted otherwise. Re-posting the same identity key replaces it. The client always sends it; `machine admin approve` refuses a candidacy that has none.
- Device login: the console list does NOT show the user code (the approver reads it on the machine's screen); polls faster than 2.5 s get `429 slow_down`; a label conflict gets the suffix "-2" (for example "laptop-2"); PATCH on token scopes also exists on the relay (console).

## Client behaviour of the device login (`machine join`, fake relay only)

- Argument: only digits (spaces, hyphens allowed) = pairing code (claim route); anything else = relay, URL or bare host (`https://` added). There is no default relay: it is named the first time (argument or `--relay`; a pairing code needs `--relay`), then reused from `relay.json`; none known = usage error (exit 2). `--relay` is the same as the argument (both: usage error). `admin login` likewise needs `--relay` or a stored admin relay.
- Label asked = machine name restricted to letters, digits, space, `_ . -`, 1-64; the label stored is the one the poll returns.
- Poll: first after one interval, never faster than 3 s. `slow_down` is read as a 429 with `error: slow_down` or as a status; the wait is `retryAfterSeconds` and stays. Any other 429 waits `Retry-After` (30 s if absent). Network errors and 5xx are warned and retried.
- `denied`, `expired`, unknown code: exit 1, nothing stored, a spent `deviceCode` is never polled again. The client also stops 5 s after `expiresIn`.
- `approved` is accepted only with `scopes` exactly `["machine"]`; otherwise nothing is stored and the message says to revoke the token in the console.
- `deviceCode` and token are never printed; the `deviceCode` is never written to disk. An interrupted join stores nothing and starts over.
- 404/405 on `start`: reported as "no device login, use a pairing code".
- `join` never enables a startup job; it suggests `machine startup enable` (not implemented). `--auto-startup` is refused (exit 2) until it exists.
