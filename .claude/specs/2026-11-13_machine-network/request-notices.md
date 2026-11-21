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
- Browser (Allow button): the page signs only the policy envelope. Phase 1 sends the list through the CLI paths above; the page does not add it (see "As built").

## Phase 2: notices over the direct channel

Wire (after the normal handshake, so the sender is the authenticated, pinned, pair-proven peer; no extra signature):

| Frame | Fields |
|---|---|
| `request-notice` | `id` (request id), `shell`, `command` (at most 2048), `commandTruncated`, `state` (`held`, `refused`), `deadline` (epoch s or null), `ts` |
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
**NOT built in phase 1:** the Allow button of the page (browser signing) does not send the list. The page distributes only its policy envelope; the list reaches the target through any CLI distribution (`approve`, `admin allow`, `distribute`, `notify-to`). Mirroring it needs the backend route (`policyWeb.ts`, contract "exactly { policy, document? }") and the allow flow of the page to carry a second document: the webcrypto builder already accepts the kind.
Rollout note: an older target deletes a `notice-recipients` document as `malformed` (unknown kind) and counts it in `documents-unverified`: harmless, update first.

