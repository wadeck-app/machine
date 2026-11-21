# Request notices (decisions 83 and 84)

**Status:** v0.1, 2026-11-21. Problem: a request HELD or refused on a target is visible on the admin machine only after "Load the other machines" (PIN + admin passphrase). The owner wants an inbox of all machines on the Requests page, without a passphrase, while agents keep working.
**Not a right:** a notice is information. It grants nothing, changes no policy, runs nothing. Allow still signs the policy of the right machine (hard rules 3, 4).

## Two phases

| Phase | What | Needs |
|---|---|---|
| 1 | `notice-recipients`: an admin-signed list of machine uuids that want notices, distributed like a policy | sealed inbox (distribution.md) |
| 2 | `request-notice` / `request-notice-end` frames from a target to each recipient, over the direct mutual-TLS channel, stored on the recipient and shown by `machine requests` and the Requests page | phase 1 |

Why not the relay inbox for notices: a machine token cannot PUT inbox documents (stolen-token property, AR-8). Why a document for the recipients: a target cannot otherwise know the admin machine with certainty (it stores only the admin KEY; several machines may hold it, decision 23).

## Phase 1: `notice-recipients` document

- Signed body `{ v:1, adminKeyId, serial, issuedAt, recipients: [uuid, ...] }`, domain `machine/notice-recipients/v1`, at most 8 recipients, sorted, unique. Carried in document kind `notice-recipients`, same sealed envelope v2 as every document, same pinned-admin verification as a revocation.
- `serial` = `max(now, previous + 1)` (like the revocation version): the newest list replaces an older one, an older or equal serial is acknowledged as `already-installed`. Several admin machines: the last list distributed wins; to keep several recipients run `machine admin notify-to a b` once.
- Receiver: file `<configDir>/notice-recipients.json` (`{ v:1, signed }`, atomic write, re-verified on every read against the pinned admin key). A damaged file stops the reader with its path and the fix (delete it, then `machine admin distribute <machine>` from the admin machine). No file = no recipients.
- Sender: the admin machine keeps the list it signed in the same file. Every distribution it already does (`admin allow`, `admin distribute`, `admin approve`, `admin sign-policy` followed by distribution, `admin revoke`) adds the document for each machine it sends to. A stored list (own, or received from another admin machine) is reused as it is, so a second admin machine never overrides the first; only `notify-to`, or the absence of any list, signs a new one (`[this machine]`), in the SAME passphrase unlock as the other documents: no new command, no extra passphrase. The document is not counted in the `[ok] N document(s)` line of the output (it rides every distribution).
- `machine admin notify-to <machine>...` signs and distributes a new list to every trusted peer. `machine admin notify-to --list` prints the stored list (no passphrase); on a non-admin machine it prints what that machine received.
- Not a widening (hard rule 4): the list only decides who receives information. Disclosure: the listed machines learn the commands that other peers tried on a target; they hold the admin key or are named by it, and `requests-list` already gives that.
- Browser (Allow button): the page signs the list in the same unlock as the policy, for another machine (see "Allow button" below).

## Phase 2: notices over the direct channel

Wire (after the normal handshake, so the sender is the authenticated, pinned, pair-proven peer; no extra signature):

| Frame | Fields |
|---|---|
| `request-notice` | `id` (request id), `peer` (uuid of the caller as the target knows it), `peerName`, `shell`, `command` (at most 2048), `commandTruncated`, `state` (`held`, `refused`), `deadline` (epoch s or null), `ts` |
| `request-notice-end` | `id`, `outcome` (`allowed`, `denied`, `deadline`, `disconnected`, `refused`, `revoked`), `ts` |
| answer | `{ type:"notice-ack", id }`, or a normal `refused` (older build: `unknown-message`) |

- Sender (target): on a hold, on a refusal that is not held, and when a hold ends, for each recipient of the document other than itself. Best effort: connect 3 s, answer 3 s, at most 3 attempts 30 s apart while the hold lasts, then one audit line `notice-undelivered` naming the cause. A notification never blocks, delays or changes a request. No recipient known: ONE audit line `notice-no-recipient` (run `machine admin distribute`, or update). Older recipient (`unknown-message`): back off one hour per recipient, ONE audit line `notice-recipient-outdated` saying to run `machine cli update` there.
- Receiver (admin machine): accepts only on a session of a trusted, non-revoked peer, strict fixed fields, 4 KiB frame, printable ASCII command (already bounded by `verifyRequest` on the target; re-checked, not trusted), at most 30 frames per minute per sender (excess dropped and counted in the audit log, once per minute). Never executes, never authorises. Stored in `<configDir>/notices.json`: 200 newest, entries older than 7 days dropped, atomic write, damaged file refused loudly with the fix. An end frame drops the notice.
- Display: `machine requests` and the Requests page list notices in WAITING NOW / REFUSED labelled with the machine, with `reported by <machine> at <time>; not verified live: use Load the other machines to confirm`. The command is escaped text. Allow signs the exact command text for the machine of the row, as today, with its usual confirmation.
- Hard rule 1 holds (still exactly two listeners). New behaviour: a target opens an OUTBOUND peer connection to a recipient. Hard rule 11 holds (nothing through the relay); the relay learns only the address lookup it already serves.
- Notices may be lost while the admin machine is offline: accepted, the live path stays.

## Rollout

1. `machine cli update` on every machine (an older admin machine answers `unknown-message` and audits one `refused` line per frame; the target backs off after the first).
2. Any `machine admin allow|distribute|approve` from the admin machine delivers the recipients list (or `machine admin notify-to <this machine>`).
3. Until then targets write `notice-no-recipient` once and notify nobody.

## Threat model rows (see threat-model.md T-40 to T-43)

Notice spam by a compromised peer; notice spoofing (revoked or unknown peer, another machine's name inside the notice); display injection through the command text; admin-side parse surface; timing and metadata (the recipient learns when a peer is asked; the relay sees nothing new).

## As built

**Phase 1 (built, 2026-11-21):** machine-core `noticeRecipients.ts` (body, sign, verify, replace-newer), kind `notice-recipients` in `document.ts` and in the mirror of machine-webcrypto `documents.ts`; CLI store `notice-recipients.json` (`noticeRecipientsStore.ts`), installation in `inboxLoop.ts`, sending in `distribute.ts` (approve, renewal, revoke, policy sign and `distribute --policy`; `admin allow` through the same policy path), `machine admin notify-to <machine>... | --list` (`adminNotifyTo.ts`). Tests: machine-core `noticeRecipients.test.ts`, machine-cli `noticeRecipientsStore.test.ts`, `noticeRecipientsDistribute.test.ts`, `inboxLoop.test.ts`, `distribute.test.ts`, webcrypto `documents.test.ts`.
**Allow button (built 2026-11-21, was not in phase 1):** see "Allow button" below.
Rollout note: an older target deletes a `notice-recipients` document as `malformed` (unknown kind) and counts it in `documents-unverified`: harmless, update first.

**Phase 2, Requests page (built, 2026-11-21; module side only, needs the daemon `notices` field):** backend `requests.ts` turns `notices` / `noticesError` of the daemon `requests` answer into `NoticeRow[]` (countdown = deadline - ts - time since receipt, no cross-clock) and warns when the daemon is older; pure merge `dsl-lib-machine/src/lib/noticeRows.ts` (live machine wins, self dropped, filter, dedupe by machine+id); rendered by `RequestsOverview`, `HeldRequests`, `AllowRequestsTable` (test ids `notice-row`, `notice-note`).
Refresh: the page's existing 10 s poll of `requests`. Allow reuses the remote-row path for the notice `machine`; no Deny button (hint to run `--deny <id>` ON the target).
A truncated command gets no Allow button (it would sign a different command); the row says to use Load the other machines.

**Phase 2, machine-cli (built, 2026-11-21):** receiver in `peerService.ts` (`deps.notices`; absent = `unknown-message`), sender `requestNotifier.ts` (`deps.notifier`, hooks in `hold()`/`handle()`), wiring `noticeWiring.ts` + `daemonEntry.ts`, display `requestsLayout.ts` (machine-core) / `requestsView.ts` / `cliRequests.ts`. Tests: `requestNotifier`, `peerServiceNotice`, `requestsView`, `cliRequests`, `requestsViaDaemon`, `noticesE2e` (two daemons), machine-core `requestsLayout`.
Daemon `requests` answer carries `notices: StoredNotice[]` (visible, newest first) and, when `notices.json` is damaged, `notices: []` plus `noticesError`; `machine requests --json` has the same fields, text mode prints a `[warn]` with the fix.
Deviations:
- The notifier is always wired (no relay/addresses gate): an unreachable recipient is a named `notice-undelivered`, no recipient list is one `notice-no-recipient`.
- Connect: 3 s per address (transport), plus a 10 s safety net around address lookup; answer 3 s; at most 3 attempts 30 s apart (a refused-without-hold notice retries too); an abandoned start (hold ended) is silent, its end notice still gets 3 attempts.
- Attempts to one recipient are serialized: after the first `unknown-message`, the others queued for the hour are dropped without a frame. At most 16 pending per recipient, oldest dropped with a `notice-undelivered` (`too-many-pending`). A recipient that is not a trusted peer: one `notice-undelivered` per recipient per process.
- Rate limit: dropped frames get `refused rate-limited` without a `refused` audit line each; `request-notice-rate-limited` is written at the first drop, and once more with the total when the sender is heard again (two lines per limited minute at most).
- Store failure: one `request-notice-store-failed` and one problem line until a store succeeds again; the sender gets `notice-store-unavailable`.
- Not held and not noticed: wrong-shell refusals (an Allow of that shell is not expected), hold admission refusals.
- Display: notice rows form a block `reported by the other machines` inside WAITING NOW / REFUSED (own table with MACHINE and REPORTED columns), the note is two lines (`reported by <machines> at the time shown, not verified live:` / `use Load the other machines on the page, or `machine requests <machine>`, to confirm`). Left = deadline - this clock. Exact allow lines are `machine admin allow <machine> ...` (policy mode of the other machine is unknown, admin assumed); none for a truncated command. Remote views (`<machine>`, `--all`) show no notices.

**Verified on the real page (2026-11-21, isolated app-core, fake relay, two daemons):** a held request on the target appears on the admin Requests page within the 10 s poll without any PIN or passphrase, labelled with the reporting machine and the not-verified note; the hostile command renders as one text node; Deny and the deadline remove the row; with the admin daemon down the target writes exactly ONE `notice-undelivered` (3 attempts) and the hold is unaffected, no storm after the restart. Not verified: the Allow confirmation modal (the app-core PIN gate came first), the old-admin back-off on a real older build (unit tests only), the relay address lookup (addresses were pinned), `test:relay` against the real relay (the notice travels the peer channel, not the relay).

## Delivery at join, and who holds the list (built 2026-11-21)

- **At join:** `machine admin approve` already sends the list to the NEW machine in the same passphrase unlock (the distribution after the decision includes the subject; tested in `noticeRecipientsDistribute.test.ts`). The new machine reads its inbox once it runs the daemon and installs the list with the admin key it pinned at the final code. The list is NOT carried inside the sealed approval: the approval format refuses unknown fields, so an older candidate build could no longer join, and the inbox path already gives the same signature check. The very first machine is its own recipient and needs nothing.
- **An older build deletes the list unread** (unknown kind `notice-recipients`, counted in `documents-unverified`): a machine enrolled before this feature needs `machine cli update` first, then any send (`machine admin notify-to ...`, `admin allow`, `admin distribute`).
- **`admin distribute <machine>`** stores the list for `<machine>` too, even when "no other peer" needs informing: the output now says `request notices list stored by the relay for <machine>` (before, only `no other peer to inform` was printed and the list went unmentioned).
- **`machine status`** prints `request notices: sent to <machines>` or `[warn] request notices: no recipient list yet ... run machine admin distribute <this machine> on the admin machine` (local files only; absent when the machine has no pinned admin key).
- **Record on the admin machine** `<configDir>/notice-recipients-sent.json` (display only, 256 machines at most): per machine the last send (serial, time, stored by the relay or not) and the last confirmation. Written by every distribution of the list, and by every admin-signed `requests-list` answer (`machine requests <machine>`, the Requests page).
- **Confirmation:** the `requests-list` answer carries `noticeRecipientsSerial` (number, `null` = holds none or cannot read it, absent = older build). Absent records nothing: the machine stays `unknown`.
- **`machine admin notify-to --list`** (admin machine): the recipients, then one line per trusted machine: `has the current list (serial N)`, `has a newer list`, `sent <date>, not confirmed`, `the last send FAILED`, `has an older list (serial M)`, `has no list`, `unknown (older build or never asked)`, and the command to run for the missing ones (`machine admin notify-to <recipients>`; it signs a new list with the same recipients and sends it to every trusted machine). A confirmation more recent than the last send wins; a send newer than the last answer reads as `sent, not confirmed`.

## Allow button (built 2026-11-21)

- Context of `GET /allow/<machine>` (another machine only) adds `noticeRecipients: { selfUuid, current }` (`current`: the list stored on this admin machine, verified, or null). A damaged stored list stops the context with its path and fix (`notice-recipients-invalid`), before any passphrase.
- The page (`allowFlow.ts`) reuses `current` as it is, or signs `[selfUuid]` (serial `max(now, previous + 1)`) when none; it refuses a `current` the pinned admin key did not sign. It seals the list to the target in the same unlock and posts `{ policy, document, noticeRecipients: { signed, document } }`. A backend without the context field: the Allow goes through and the page says the list was NOT sent, with the fix.
- `POST /allow` accepts `noticeRecipients` with exactly `signed` and `document`; any other field is refused (400, never echoed). The daemon (`submitPolicy`) verifies the list against the pinned admin key, the document envelope (addressee, kind, id `v2:notice-recipients:<to>:<serial>:<signature>`, 30 days) and the replace-newer rule against the stored list, all BEFORE the policy is recorded (`bad-notice-recipients`, `stale-notice-recipients`). After the policy is stored it keeps the list (`installNoticeRecipients`), puts the document and records the send; a failure of the list alone leaves the policy in place and answers `noticeRecipients: 'failed'` with the command that sends it again. A list with a policy for THIS machine is refused.
- Browser code: `machine-webcrypto/src/noticeRecipients.ts` (domain, body check, `nextNoticeRecipientsBody`, `sealedNoticeRecipientsDocument`), proven equal to machine-core in `noticeRecipients.test.ts` (same signature bytes, same id, same document).
- **NOT built:** choosing the recipients in the UI. The Machines page is read-only (it shows who receives notices and which machine holds the list, from the daemon command `noticeHolders`); the list changes only with `machine admin notify-to`. A panel with checkboxes needs a new signed route (list for every trusted machine) and its component.
