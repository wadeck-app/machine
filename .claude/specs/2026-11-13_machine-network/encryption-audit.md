# Encryption audit (2026-11-21)

Question: are ALL messages between machines encrypted? Facts come from the code at HEAD 2254f6e (plus uncommitted startup files, not read). Tags: [code] read in source, [test] a named test proves it, [spec] claimed by the spec only, [unknown] not established. Paths are under `packages/`.

## Verdict

- Machine to machine: every byte after the TCP handshake is TLS 1.3, mutual, key-pinned. One code path opens a peer socket [code]. No clear mode, flag, fallback or loopback exception exists [code, grep of all non-test sources].
- Machine to relay: HTTPS enforced in code (http only for `127.0.0.1` and `localhost`). Transport encryption is not end to end: the relay reads policies, revocations, registrations, addresses, names (G1).
- Plain by design: loopback API, module to daemon, UDP wake packet.

## Table

| Channel | Transport | Encryption | Authentication | Readable by relay / network observer | Evidence | Gap |
|---|---|---|---|---|---|---|
| Peer: run, hello, revocations, requests-list, results | TCP, TLS 1.3 only, mutual, no `ciphers` override (Node default TLS 1.3 suites) | TLS 1.3 AEAD | Ed25519 identity key pinned by the client against the signed registration, looked up by the server; HMAC pair-secret proof bound to the TLS exporter; requests signed (60 s, single use) | Observer: IPs, ports, sizes, timing, ClientHello (SNI = hostname when the address is a name, Node default [unknown]). Relay: never on the path | `machine-transport/src/channel.ts:274-278` (server), `:396-399` (client), `:427-429` (pin), `:239-245` + `:65-68` (proof), `:336-337` (lookup); sole callers `machine-cli/src/peerConnect.ts:104`, `peerService.ts:463`; frames `peerService.ts:496` | G2, G3 |
| Peer: first bytes | Client sends a TLS ClientHello; server speaks only after the handshake | n/a | n/a | Observer sees a TLS handshake | [test] `noPlaintext.test.ts` (client bytes start 0x16 0x03 ... 0x01, no `"type"`, no secret; server sends nothing to a silent client) | none |
| Peer listener bind | TCP port 47921 on `0.0.0.0` by default | n/a | n/a | Reachable from every interface | `machine-cli/src/daemonEntry.ts:28`, `:151` | G4 |
| Relay REST (all calls) | HTTPS, Node `fetch`, default certificate validation | TLS (version and ciphers: Node defaults) | Bearer token; `publicRoute` calls send none | Relay reads every body | `machine-cli/src/relayClient.ts:144-158` (https or loopback http), `:268` (every client normalizes), `:310-315` (call); no `rejectUnauthorized` outside `channel.ts` and tests | G1, G5 |
| Relay REST from the admin page backend | HTTPS (same rule, own copy), `redirect: 'error'` | TLS | Bearer token | same | `app-module-machine/src/backend/candidacies.ts:100-108`, `:245-253`; `health.ts:116-121`, `:143-148` | none |
| Relay WebSocket | not used: no WebSocket in any source | n/a | n/a | n/a | grep `WebSocket`, `ws:`, `relay-ws` in `packages/*/src`: none | none |
| CLI / module -> daemon API | HTTP, 127.0.0.1 only, port 47920 (walks up) | none (loopback) | Bearer `health_token`, `timingSafeEqual`, file mode 0600 | Local same-user processes only | kit `health-server.js:55` (bind), `:83`, `:108`; `app-module-machine/src/backend/daemonClient.ts:78` | G6 |
| Module <-> app-core | HTTP loopback, owned by app-core | none | app-core PIN on `sensitive` routes | local | `app-core-sdk` `register.bundle.js:78` (`http://127.0.0.1`); app-core bind and CSP not in this repo [unknown] | none here |
| Port file `daemon.port.json` | file | none | file mode 0600 | local; holds pid and ports only | `machine-cli/src/daemonPortFile.ts` | none |
| Wake-on-LAN | UDP 9, `dgram`, send only | none | none | LAN sees "wake this MAC, from this address, at this time"; 102 bytes, no SecureOn password | `machine-cli/src/wakeSender.ts:1`, `:37`; `machine-core/src/wake.ts:146-150` | none, plain by nature |
| Updates | `npm` child process (registry transport is npm's) | npm default | no signature or provenance (AR-9) | not audited here | `machine-cli/src/updater/entry.ts:41` | outside scope, see AR-9 |

## What the relay can read (relay is untrusted)

| Document | On the wire to the relay | Relay can read | Protection |
|---|---|---|---|
| Pairing claim, device login | HTTPS JSON | code, label, deviceCode (it issues them) | single use, 5 min |
| Candidacy | HTTPS JSON | name, hostname, identity public key, random, uuid, source IP | public data; human compares the security code |
| Approval (decision) | HTTPS JSON | registrations (name, uuid, key, validity), admin public key | signed by admin |
| Pair secret in approval and in `peer` inbox documents | sealed (X25519 ephemeral, HKDF, AES-256-GCM) | no | `machine-core/src/seal.ts`; `approval.ts:55`, `distribute.ts:118`; a clear `pairSecret` in an approval is refused `approval.ts:61-67` |
| `policy` inbox document | the signed policy as is | YES: target, version, every allowed shell + command line per peer | signature only (`distribute.ts:232`; spec `distribution.md:51` "not secret") |
| `revocation` inbox document | the signed list as is | YES: revoked uuids | signature only (`distribute.ts:200-205`) |
| Address record | signed, plain | host:port of the machine | signature (T-33) |
| Heartbeat, machine list, whoami, version | HTTPS | presence, uuids | token scope |

Peer traffic (commands, stdout, stderr, results) never touches the relay [code].

## Gaps, ranked

| # | Gap | Evidence | Fix | Protocol change |
|---|---|---|---|---|
| G1 | The relay reads the allowlists (shell + exact command lines per peer) and the revocation list; threat model T-25 lists only addresses and presence as metadata, so the spec understates it | `distribute.ts:232`, `:200-205`; `distribution.md:51` | Seal `policy` and `revocation` payloads to the recipient identity key (reuse `sealTo`) inside the signed document, or accept and document it in T-25 | Yes (document payload format, receivers, `verifyInboxDocument`) |
| G2 | The client sends its TLS ClientHello and client certificate (its public key) to an address BEFORE checking the server key; an attacker address learns who calls. Already accepted in T-33 (2) | `channel.ts:391-400` then `:427` | Not fixable without knowing the server key before the handshake (TLS 1.3 certificates are encrypted but sent to whoever answers) | Yes if pursued; keep accepted |
| G3 | Server results are protected only by the TLS session, not signed per message; fine against a network attacker, not against a peer that was already authenticated | `peerService.ts:452` | none needed | no |
| G4 | The peer listener binds `0.0.0.0` by default and the startup line prints only the port; T-34 says "never opened by default on a public interface without an explicit setting" and lists bind choice as remaining | `daemonEntry.ts:28`, `:151`; `cli.ts:594` | Print the bound host and an exposure `[warn]` when it is not loopback, or default to an explicit choice | No |
| G5 | `relayClient.call` does not set `redirect: 'error'` (the two app-module copies do): a relay or on-path attacker answering a redirect makes the client follow it; whether an https to http hop re-sends a 307/308 body (candidacy, address record, inbox document, pairing code) is [unknown], not tested. The Authorization header is dropped on cross-origin redirects by the fetch spec [spec], not verified here | `relayClient.ts:310-315`; no redirect test in `relayClient.test.ts` | Add `redirect: 'error'` plus a test | No |
| G6 | `localhost` is accepted as loopback for http by name; the resolver decides where it points. `[::1]` is refused (over strict, harmless) | `relayClient.ts:151`, `candidacies.ts:105`, `health.ts:120` | Accept only `127.0.0.1` for http | No |
| G7 | The file flow `machine admin register --out` writes a bundle holding the pair secret in clear (mode 0600, Windows ACL not enforced) for the human to carry; the relay flow does not | `cliNetwork.ts:301`; `cli.ts:226-227` | Keep (decision 48), or seal to the candidate key like the relay flow | Optional |
| G8 | `peers.json` stores pair secrets in clear at rest (mode 0600), not under `_secrets_/` as CLAUDE.md requires | `network.ts:101-102` | Move or document the exception | No (file layout) |
| G9 | Process-wide `NODE_TLS_REJECT_UNAUTHORIZED=0` in the environment would disable relay certificate validation; the code does not set or check it | no hit for `NODE_TLS` in `packages/*/src` | Refuse to start the relay client when it is set | No |

## Proven by a test that exists

- Plain TCP client with a well-formed `run` frame: no session, no machine reply, handshake failure reported. TLS 1.2 client refused. TLS 1.3 client with no certificate, or with a registered key and no proof: no session. Client sends a ClientHello first, never a frame or a secret. Client refuses a TLS 1.2-only server. All in `machine-transport/src/noPlaintext.test.ts` (new, 8 tests, passing).
- Older: pin mismatch, unregistered key, wrong pair secret, pre-auth flood, plain server answering the client with `protocol` kind: `channel.test.ts`, `connectError.test.ts`.
- https enforcement: `relayClient.test.ts:29`, `join.test.ts:197`, `candidacies.test.ts:232`, `health.test.ts:243`.

## Not established

- TLS cipher suite actually negotiated (code sets none; Node default).
- SNI contents for a hostname address.
- Behavior of the real relay and app-core transport settings (other repos).
- Redirect handling (G5), as above.

## Logs and audit [code]

- Command log keeps the command line with everything after `--` and the values of `--hint`, `--passphrase`, `--secret-from` replaced, and pairing, security and login codes redacted; only `[ok]/[warn]/[fail]/[info]` output lines are kept (`cliLog.ts:10-12`, `:28`, `:72`).
- Relay errors and the client never carry the token (tests in `relayClient.test.ts`, `health.test.ts`, `candidacies.test.ts`).
- The daemon audit log holds the exact command by design (T-07), never the output. The wake audit holds MAC and addresses, not secrets.
