# Requests: what peers asked a machine to run

**Version:** v1.0 (2026-11-20). Decisions 73 (local view) and 74 (remote view). Threat model: T-07, T-21, T-39.

A request is a `run` frame that a target refused because the command is not allowed. The target already audits it (`refused`, with the source peer, reason, shell and exact command). Nothing read that log; this adds the readers.

## Local view (decision 73)

| Surface | What |
|---|---|
| Core | `summarizeRequests(lines, { isAllowed, nameOf, pendingLimit, history })` in `machine-core/src/requests.ts`: pure, verifies the chain first |
| CLI | `machine requests` (pending), `machine requests --history [--peer] [--since] [--event] [--limit]`, `--json`; reads `audit.log`, no daemon, read-only |
| Module | Requests page and `GET /api/modules/machine/requests` (daemon command `requests`, same reader) |

- **Pending** = `refused` entries with reason `not-listed` or `no-policy`, grouped by (source peer, shell, command): count, first and last seen. A command that the policy in force lists now (any entry for that peer, even expired or exhausted: renewing is not a new request) is not pending. Newest first, capped (default and maximum 100, `--limit`): T-21.
- **History** = `run` (accepted merged with its `completed` or `failed` by request id: exit code, duration), `refused` (reason), `session` (session-closed, revocation catch-up, ...), `document`. Chronological, last 50 by default (1000 max); filters peer, since, kind.
- **Broken chain**: the verified prefix is trusted; later lines are returned with `verified: false`, never counted as pending, with the first bad line and a count of unreadable lines. The CLI warns on stderr and still lists. An entry without a usable time is counted (`skipped`), not hidden.
- **Logging change**: the `no-policy` refusal now records `shell` and `command` (like `not-listed`, `expired`, `exhausted` already did). Both passed `verifyRequest` (known shell, 1 to 2048 printable ASCII). Output is never logged.
- Everything displayed is printable ASCII and bounded (`printable`): an old or edited log cannot send a control sequence to a terminal or a page.

## Remote view: options (decision 74)

| Option | How | Verdict |
|---|---|---|
| (a) pull over the peer channel | admin machine sends one admin-signed read-only frame, the peer answers from its own log | **Built** |
| (b) push through the relay inbox | each target writes to the admin inbox | Not allowed: machine tokens cannot write another inbox (relay-api.md); it would also make the relay carry command text it never carried (T-25, T-36) |
| (c) local only | run `machine requests` on each machine | What remains for the history, and for the page |

(a) adds one frame pair and no new capability: nothing runs, nothing is written, no right widens (hard rules 3 and 4 untouched). Hard rule 2 holds: the frame is authorized by the admin signature, never by a local token.

### Frames

Request (client to peer), on the authenticated channel, any time after the handshake (no hello needed):

```
{ "type": "requests-list", "request": { "body": B, "signature": "<base64url Ed25519>" } }
B = { v: 1, id: <uuid>, nonce: <16 bytes base64url>, source: <uuid>, target: <uuid>, limit: 1..100, issuedAt, expiresAt }   (exactly these 8 fields)
```

Signed with the ADMIN key, domain `machine/requests-list/v1`. The peer checks, in this order: pinned admin key exists (`no-admin`), well-formed (`malformed`), signature (`bad-signature`), `target` is itself (`wrong-target`), `source` is the machine authenticated on the connection (`source-mismatch`), lifetime at most 60 s (`lifetime-too-long`, default 30 s), clock window with 30 s skew (`not-yet-valid`, `expired`), issued after the daemon started (`predates-start`), nonce unseen (`replay`, the replay cache of `run`), at most 6 per minute per peer (`rate-limited`), audit written (`audit-unavailable`). Each failure is a normal `{ "type": "refused", "id", "reason", "message" }` and an audit entry `refused`.

Answer (peer to client):

```
{ "type": "requests-list", id, machine: { uuid, name }, policyMode: "admin"|"local", now, chain: { ok: true } | { ok: false, line },
  pendingTotal, allowedNow, truncated, pending: [ { peer, peerName?, shell, command, count, firstSeen, lastSeen, reason } ] }
```

| Limit | Value |
|---|---|
| Groups | at most `limit` (1 to 100); newest first |
| Frame | the JSON is at most the frame cap minus 1 KiB (1 MiB cap by default); groups are dropped from the oldest end and `truncated` is set (`pendingTotal` stays true) |
| Command text | at most 2048 printable ASCII characters (already enforced by the policy gate) |
| Rate | 6 per minute per peer; the first refusal of a minute is audited (`requests-list-rate-limited`) |
| Lifetime | 30 s (max 60 s) plus 30 s skew; single use |
| Audit on the peer | `requests-list` `{ source, id, limit }`, written BEFORE the log is read (no audit, no disclosure); the commands are not copied into it |
| Old peer | answers `refused` `unknown-message`: the client says "update it with `machine cli update`" (`peer-too-old`) |

The client treats the answer as untrusted: strict shape check, caps, every text reduced to bounded printable ASCII, the chain message never sent (only the line).

### What a peer learns

Only the admin (holder of the admin key) can ask, so the exposure is limited to what the admin already controls: which commands other peers tried on this machine, when, how often. A registered peer without the admin key gets `bad-signature` and nothing else. The peer learns that the admin asked (audited). In policy mode `local`, the admin can still read the list; the answer carries `policyMode` so the next command shown is the owner's (`machine policy allow` on that machine).

### CLI

`machine requests <machine>` and `machine requests --all` (admin machine only: it needs the admin key file, asks the passphrase once, signs one request per peer, 30 s lifetime each). Pending list only: the history is the audit log of each machine, read on that machine. A peer that cannot be reached or refuses is reported (`[fail] <name>: <reason>: <message>`), the others are still shown, exit 1.

### Module page

The page lists the local machine (pending and history). For the remote section the backend route exists (`POST /api/modules/machine/requests/remote`, `sensitive`: the app-core PIN; header `x-machine-module`; body `{ machine, request }` where `request` is the document signed in the browser): the daemon forwards it as is and returns the peer rows. **Not built: the page component that unlocks the admin key and signs a `requests-list` document** (`PassphraseSigner` signs registrations only, and the key file route it reads is not built). Until then the page says so and points to `machine requests <machine>`. The daemon never holds the admin key; the module backend never sees it.

### Allow button (decision 76)

Each pending row of the page has an Allow button on the admin machine in policy mode admin: it is `machine admin allow <this machine> --shell <s> -- <command>` with the signature made in the browser. Design, routes and limits: `app-module-parity.md` P2.2 and threat-model.md "Allow button". Elsewhere the row shows the CLI command and a note.

## Not verified

- Chain behaviour on a log written by an older build (entries without `shell` and `command` on `no-policy` are simply not pending).
- The page rendering in a browser with the real app-core (not registered from this work: checked by the packaged real-server test only).
- Remote view across NAT or through the relay record; tests run on loopback with pinned addresses.
