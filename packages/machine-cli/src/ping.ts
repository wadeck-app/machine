import { destinationProblem, summarizeSamples, verifyAddressRecord, type AddressEntry, type SampleSummary } from '@wadeck-app/machine-core';
import type { PeerSession } from '@wadeck-app/machine-transport';
import { clockText, whenText } from './humanTime.js';
import { AllAddressesFailedError, describeAddress, PeerAddressError } from './peerAddresses.js';
import type { Connected, PeerTarget } from './peerConnect.js';
import { RelayError, type RelayClient } from './relayClient.js';
import type { RelayConfig } from './relayStore.js';
import type { CatchUpReport } from './revocationSync.js';

// `machine ping` (decision 61). Two forms, both read-only:
//  - `machine ping`: the path from this machine to the relay, one check per step ([ok] / [warn] / [fail], each with cause and fix).
//  - `machine ping <machine>`: the real authenticated channel to a peer (the code path of `machine run`, peerConnect.ts), without a command.
// Every collaborator is injected, so each branch is tested without a network. Nothing here writes to the audit log or needs a policy entry:
// no command is ever sent.

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';

export interface Check {
  id: string;
  status: CheckStatus;
  message: string;
}

const line = (c: Check): string => `[${c.status}] ${c.message}`;
/** The human form of a check: one line. */
export const checkLine = line;

const tenth = (x: number): number => Math.round(x * 10) / 10;

const ms = (x: number): string => {
  const rounded = Math.round(x * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
};

function durationText(seconds: number): string {
  if (seconds < 120) return `${Math.round(seconds)} s`;
  if (seconds < 2 * 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 48 * 3600) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86_400)} days`;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------------------------------------------------------------
// Relay form

export interface RelayPingDeps {
  /** Epoch seconds. */
  now: () => number;
  /** Monotonic milliseconds. */
  clock: () => number;
  /** relay.json, or undefined when there is none. Throws (with the file and the fix) when it is corrupt. */
  readRelay: () => RelayConfig | undefined;
  client: (config: RelayConfig) => RelayClient;
  /** This machine's identity. Throws the "run machine setup / join" error when there is none. */
  self: () => { uuid: string; name: string; publicKey: string };
  daemonRunning: () => Promise<boolean>;
}

export interface RelayPingReport {
  ok: boolean;
  checks: Check[];
}

/** The record is republished every 7 days by the daemon (relay-api.md); one more day is slack before it is called stale. */
const STALE_RECORD_SECONDS = 8 * 86_400;

const ACCESS_FIX = 'run `machine join --force` to replace it with a limited machine token';

function accessCheck(scopes: string[] | null, took: string): Check {
  if (scopes === null) {
    return { id: 'token', status: 'warn', message: `token accepted${took}, access level FULL ACCESS: this token can also manage tokens, which a machine never needs; ${ACCESS_FIX} (\`machine admin login\` gives the admin token)` };
  }
  if (scopes.includes('machine-admin')) return { id: 'token', status: 'ok', message: `token accepted${took}, access level machine-admin (can approve machines, cannot manage tokens)` };
  if (scopes.includes('machine')) return { id: 'token', status: 'ok', message: `token accepted${took}, access level machine (this machine's own calls; it cannot approve machines)` };
  return { id: 'token', status: 'fail', message: `the relay knows the token${took} but its scopes are ${JSON.stringify(scopes)}, with no "machine" scope: the relay refuses every machine call (403). ${ACCESS_FIX[0]?.toUpperCase()}${ACCESS_FIX.slice(1)}, or ask the relay owner for a token limited to the machine scope` };
}

export async function pingRelay(deps: RelayPingDeps): Promise<RelayPingReport> {
  const checks: Check[] = [];
  const add = (c: Check): void => void checks.push(c);
  /** What the failed step needs and which steps were therefore not run. */
  let blocked: { needs: string; skipped: string } | undefined;

  // 1. relay.json
  let config: RelayConfig | undefined;
  try {
    config = deps.readRelay();
  } catch (e) {
    add({ id: 'relay-config', status: 'fail', message: messageOf(e) });
    blocked = { needs: 'a readable relay.json', skipped: 'relay, token and address record' };
  }
  if (blocked === undefined) {
    if (config === undefined) {
      add({ id: 'relay-config', status: 'fail', message: 'no relay.json: this machine has not joined a relay. Run `machine join <relay>` (`machine setup <relay>` on the first machine of a network)' });
      blocked = { needs: 'a relay', skipped: 'relay, token and address record' };
    } else {
      add({ id: 'relay-config', status: 'ok', message: `relay.json: ${config.relayUrl} (token labelled "${config.label}")` });
    }
  }

  let client: RelayClient | undefined;
  if (config !== undefined && blocked === undefined) {
    client = deps.client(config);

    // 2. The relay answers (the public version route: no token involved yet).
    const started = deps.clock();
    try {
      const version = await client.getVersion();
      const took = deps.clock() - started;
      if (version === undefined) {
        add({ id: 'relay', status: 'warn', message: `${config.relayUrl} answered in ${ms(took)} ms but has no /api/version: it is an older relay or not a relay at all. Check the URL in relay.json (\`machine join <relay> --force\` stores another one)` });
      } else {
        add({ id: 'relay', status: 'ok', message: `relay reachable in ${ms(took)} ms (first request: includes DNS and TLS setup), version ${version.version}${version.uptimeSeconds === undefined ? '' : `, up ${durationText(version.uptimeSeconds)}`}` });
      }
    } catch (e) {
      add({ id: 'relay', status: 'fail', message: messageOf(e) });
      blocked = { needs: 'a relay that answers', skipped: 'token and address record' };
    }

    // 3. The token, and what it may do.
    if (blocked === undefined) {
      const t0 = deps.clock();
      try {
        const who = await client.whoami();
        const took = ` in ${ms(deps.clock() - t0)} ms`;
        if (who === undefined) {
          // An older relay: the token is still checked, with the cheapest call every machine token may make.
          await client.getMachines();
          add({ id: 'token', status: 'warn', message: `token accepted${took} (GET /api/machines), but this relay has no /api/whoami, so its access level cannot be shown: update the relay` });
        } else {
          add(accessCheck(who.scopes, took));
        }
      } catch (e) {
        add({ id: 'token', status: 'fail', message: messageOf(e) });
        blocked = { needs: 'a token the relay accepts', skipped: 'address record' };
      }
    }
  }
  if (blocked !== undefined) {
    add({ id: 'skipped', status: 'info', message: `not run: ${blocked.skipped} (they need ${blocked.needs}): fix the [fail] line above first` });
  }

  // 4. The local daemon (independent of the relay).
  try {
    add((await deps.daemonRunning())
      ? { id: 'daemon', status: 'ok', message: 'local daemon is running' }
      : { id: 'daemon', status: 'fail', message: "local daemon is not running: it publishes this machine's address and receives commands (`machine run` from here does not need it). Run `machine startup enable` (starts it at login) or leave `machine daemon` running in a terminal" });
  } catch (e) {
    add({ id: 'daemon', status: 'fail', message: `cannot tell whether the local daemon runs: ${messageOf(e)}` });
  }

  // 5. The address record this machine published.
  if (client !== undefined && blocked === undefined) add(await recordCheck(deps, client));

  return { ok: !checks.some((c) => c.status === 'fail'), checks };
}

async function recordCheck(deps: RelayPingDeps, client: RelayClient): Promise<Check> {
  const id = 'address-record';
  let self: { uuid: string; name: string; publicKey: string };
  try {
    self = deps.self();
  } catch (e) {
    return { id, status: 'fail', message: messageOf(e) };
  }
  let entry;
  try {
    entry = await client.getMachine(self.uuid);
  } catch (e) {
    return { id, status: 'fail', message: e instanceof RelayError ? e.message : `cannot read the address record of this machine: ${messageOf(e)}` };
  }
  if (entry === undefined) {
    return { id, status: 'fail', message: `the relay has no address record for this machine (${self.uuid}): it is the daemon that publishes it, within a minute of starting. Run \`machine startup enable\` or \`machine daemon\`, then ping again` };
  }
  const now = deps.now();
  const checked = verifyAddressRecord(entry.record, { uuid: self.uuid, identityPublicKey: self.publicKey }, now);
  if (!checked.ok) {
    return { id, status: 'fail', message: `the address record on the relay does not verify: ${checked.message}. The daemon publishes a new one when it starts (\`machine daemon\`); if it keeps failing the relay serves altered data` };
  }
  const { addresses, seq, issuedAt } = checked.body;
  const heard = typeof entry.lastSeen === 'number' ? `the relay last heard this machine ${whenText(entry.lastSeen, now)}` : 'the relay has not heard this machine yet';
  const list = addresses.map(describeAddress).join(', ');
  const head = `address record published: ${list} (seq ${seq}, ${whenText(issuedAt, now)}); ${heard}`;
  const refused = addresses.map((a) => ({ a, problem: destinationProblem(a.host) })).filter((x) => x.problem !== undefined);
  if (refused.length === addresses.length) {
    return { id, status: 'warn', message: `${head}. Peers refuse every one of these addresses (${refused.map((x) => `${describeAddress(x.a)}: ${x.problem}`).join('; ')}): publish a reachable one with \`machine daemon --advertise <host[:port]>\`` };
  }
  if (now - issuedAt > STALE_RECORD_SECONDS) {
    return { id, status: 'warn', message: `${head}. It is older than 7 days: the daemon republishes it every 7 days, so it is probably not running or cannot reach the relay` };
  }
  if (entry.online === false) {
    return { id, status: 'warn', message: `${head}. The relay says this machine is offline (no heartbeat for 2 minutes): check that the daemon runs and can reach the relay (\`machine cli logs\`)` };
  }
  return { id, status: 'ok', message: head };
}

// ---------------------------------------------------------------------------------------------------------------------
// Peer form

/** The peer allows 6 revocation exchanges per machine per minute (revocationSync.ts MAX_CATCHUPS_PER_MINUTE): four leave room for a `run` right after. */
export const PING_HELLO_ROUNDS = 4;
export const PING_INTERVAL_MS = 1000;

/** The failure of one connection, in the words of what the person can do about it. The original reason always comes first. */
export function explainConnectFailure(reason: string, _address: AddressEntry, name: string): string {
  const fix = (text: string): string => `${reason}. ${text}`;
  const peerLog = `the log of "${name}" says why: run \`machine cli logs\` there`;
  if (/ECONNREFUSED/.test(reason)) return fix(`Nothing listens on that port: the daemon of "${name}" is not running or listens on another port. On "${name}" run \`machine startup enable\` or \`machine daemon\`; \`machine status\` there shows the peer port`);
  if (/ENOTFOUND|EAI_AGAIN/.test(reason)) return fix('The host name does not resolve: check the name in the address record (or --address) and the DNS of this machine');
  if (/EHOSTUNREACH|ENETUNREACH/.test(reason)) return fix(`There is no route to that host: is this machine on the same network or VPN as "${name}"?`);
  if (/ETIMEDOUT/.test(reason)) return fix(`The connection timed out: "${name}" is off or asleep, the address is wrong, or a firewall drops the packets`);
  if (/ECONNRESET/.test(reason)) return fix(`The connection was reset on the way: a firewall or "${name}" dropped it; ${peerLog}`);
  if (/no answer from .* within/.test(reason)) return fix(`The address may be wrong, "${name}" off or asleep, or a firewall drops the packets silently (open the peer port on "${name}"; \`machine status\` there shows it)`);
  if (/presented key/.test(reason)) return fix(`Another machine (or a reinstalled one) answers at this address: its key is not the one registered for "${name}". Check the address (--address), or ask the admin to enroll it again`);
  if (/closed the connection during authentication/.test(reason)) return fix(`The peer refused the proof: this machine may not be registered there, may have been revoked there, or its registration may be outside its validity dates (check the clock of both machines), or the pair secret differs; ${peerLog}`);
  if (/failed the pair secret proof/.test(reason)) return fix(`Ask the admin to send the pair secret again: \`machine admin distribute ${name}\``);
  if (/incompatible version|not valid JSON|empty frame|machine framing/.test(reason)) return fix(`The peer runs an incompatible version of machine, or another service listens there: update machine on both machines (\`machine cli update\`)`);
  if (/wrong version number|ssl|tls|alert|EPROTO/i.test(reason)) return fix('The port does not speak the machine channel (mutual TLS 1.3): another service listens there, or the peer runs an incompatible version');
  return fix(`${peerLog[0]?.toUpperCase()}${peerLog.slice(1)}`);
}

export interface PeerPingDeps {
  /** The peer's name in the registration, and its uuid. */
  name: string;
  uuid: string;
  /** What the local admin-signed registration of the peer says (the peer proves it owns that key; it sends no admin key id of its own). */
  registration?: { serial: number; adminKeyId: string; validTo: number };
  count: number;
  /** Epoch seconds. */
  now: () => number;
  /** Monotonic milliseconds. */
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
  /** `--address`, or the verified record of the relay (peerConnect.ts `resolvePeerTarget`). Throws a `PeerAddressError` / `RelayError` with the cause and the fix. */
  resolveTarget: () => Promise<PeerTarget>;
  /** Opens one authenticated channel (peerConnect.ts `connectToTarget`); `onAttempt` is told each address just before it is tried. */
  connect: (target: PeerTarget, onAttempt: (address: AddressEntry) => void) => Promise<Connected>;
  /** The revocation hello: the one authenticated request of the protocol that carries no command (revocationSync.ts). */
  catchUp: (session: PeerSession) => Promise<CatchUpReport>;
  /** One finished line with its marker, in order. The caller sends `[fail]` lines to stderr. */
  say: (line: string) => void;
  /** A warning (without its marker). */
  warn: (line: string) => void;
}

export interface PingRound {
  n: number;
  ok: boolean;
  address?: string;
  handshakeMs?: number;
  helloMs?: number;
  /** Addresses that failed in this round, each with its explained cause. */
  attempts?: Array<{ address: string; reason: string }>;
  error?: string;
  revocation?: { peerSupportsCatchUp: boolean; inSync?: boolean; installed: boolean; sent: boolean; peerVersion?: number };
}

export interface PeerPingReport {
  ok: boolean;
  /** Always false: no command goes over a ping. */
  executed: false;
  peer: { name: string; uuid: string; registrationSerial?: number; adminKeyId?: string; registrationValidTo?: number };
  target?: { source: 'override' | 'relay'; addresses: string[]; refused: string[]; online?: boolean; lastSeen?: number | null; seq?: number; issuedAt?: number };
  rounds: PingRound[];
  summary: { sent: number; ok: number; failed: number; handshake?: SampleSummary; hello?: SampleSummary };
  warnings: string[];
  error?: string;
}

const addressText = (a: AddressEntry): string => describeAddress(a);

export async function pingPeer(deps: PeerPingDeps): Promise<PeerPingReport> {
  const warnings: string[] = [];
  const warn = (text: string): void => {
    warnings.push(text);
    deps.warn(text);
  };
  const report: PeerPingReport = { ok: false, executed: false, peer: { name: deps.name, uuid: deps.uuid }, rounds: [], summary: { sent: 0, ok: 0, failed: 0 }, warnings };
  const reg = deps.registration;
  if (reg) {
    report.peer = { ...report.peer, registrationSerial: reg.serial, adminKeyId: reg.adminKeyId, registrationValidTo: reg.validTo };
    deps.say(`[ok] machine: "${deps.name}" (${deps.uuid}), registration serial ${reg.serial} signed by admin key ${reg.adminKeyId.slice(0, 8)}..., valid until ${clockText(reg.validTo, deps.now())}`);
  } else {
    deps.say(`[ok] machine: "${deps.name}" (${deps.uuid})`);
  }

  // The address: --address or the signed record of the relay, exactly as `machine run` resolves it.
  let target: PeerTarget;
  try {
    target = await deps.resolveTarget();
  } catch (e) {
    const message = e instanceof PeerAddressError || e instanceof RelayError ? e.message : `cannot find an address for "${deps.name}": ${messageOf(e)}`;
    report.error = message;
    deps.say(`[fail] address: ${message}`);
    return report;
  }
  const now = deps.now();
  report.target = {
    source: target.source,
    addresses: target.addresses.map(addressText),
    refused: target.refused,
    ...(target.online !== undefined ? { online: target.online } : {}),
    ...(target.lastSeen !== undefined ? { lastSeen: target.lastSeen } : {}),
    ...(target.seq !== undefined ? { seq: target.seq } : {}),
    ...(target.issuedAt !== undefined ? { issuedAt: target.issuedAt } : {}),
  };
  for (const refused of target.refused) warn(refused);
  if (target.online === false) {
    warn(`the relay says "${deps.name}" is offline${typeof target.lastSeen === 'number' ? ` (last seen ${whenText(target.lastSeen, now)})` : ''}: trying its published addresses anyway`);
  }
  const list = target.addresses.map(addressText).join(', ');
  if (target.source === 'override') {
    deps.say(`[ok] address: --address ${list} (the relay was not asked)`);
  } else {
    const published = target.issuedAt === undefined ? '' : `, published ${whenText(target.issuedAt, now)}`;
    const presence = target.online === undefined ? '' : `; the relay says ${target.online ? 'online' : 'offline'}${typeof target.lastSeen === 'number' ? `, last seen ${whenText(target.lastSeen, now)}` : ''}`;
    deps.say(`[ok] address: ${target.addresses.length} address(es) from the relay record of "${deps.name}" (seq ${target.seq ?? '?'}${published}${presence}): ${list}`);
  }
  if (deps.count > PING_HELLO_ROUNDS) {
    deps.say(`[info] the hello is sent in the first ${PING_HELLO_ROUNDS} rounds only (a peer allows 6 revocation exchanges per minute per machine); the other rounds measure the handshake`);
  }

  const handshakes: number[] = [];
  const hellos: number[] = [];
  let announced = false;
  for (let n = 1; n <= deps.count; n++) {
    const label = `ping ${n}/${deps.count}`;
    const round: PingRound = { n, ok: false };
    report.rounds.push(round);
    let lastAttempt = deps.clock();
    let connected: Connected | undefined;
    try {
      connected = await deps.connect(target, () => {
        lastAttempt = deps.clock();
      });
      round.handshakeMs = tenth(deps.clock() - lastAttempt);
      round.address = addressText(connected.address);
      for (const failure of connected.failures) warn(`${failure}; connected through ${round.address}`);
      let hello = '';
      if (n <= PING_HELLO_ROUNDS) {
        const caught = await deps.catchUp(connected.session);
        round.helloMs = tenth(caught.helloRoundTripMs);
        hellos.push(caught.helloRoundTripMs);
        round.revocation = { peerSupportsCatchUp: caught.peerSupportsCatchUp, ...(caught.inSync !== undefined ? { inSync: caught.inSync } : {}), installed: caught.installed, sent: caught.sent, ...(caught.peerVersion !== undefined ? { peerVersion: caught.peerVersion } : {}) };
        for (const w of caught.warnings) warn(w);
        hello = `, hello ${ms(caught.helloRoundTripMs)} ms`;
        if (!announced) {
          announced = true;
          deps.say(`[ok] peer: "${deps.name}" proved the identity key pinned by its registration and the pair secret (mutual TLS 1.3)`);
          deps.say(`[${caught.peerSupportsCatchUp && caught.inSync !== false ? 'ok' : 'info'}] revocation lists: ${revocationText(caught, deps.name)}`);
        }
      } else if (!announced) {
        announced = true;
        deps.say(`[ok] peer: "${deps.name}" proved the identity key pinned by its registration and the pair secret (mutual TLS 1.3)`);
      }
      handshakes.push(round.handshakeMs);
      round.ok = true;
      deps.say(`[ok] ${label}: ${round.address} handshake ${ms(round.handshakeMs)} ms${hello}`);
    } catch (e) {
      round.error = messageOf(e);
      if (e instanceof AllAddressesFailedError) {
        round.attempts = e.attempts.map((a) => ({ address: addressText(a.address), reason: explainConnectFailure(a.reason, a.address, deps.name) }));
        deps.say(`[fail] ${label}: no address of "${deps.name}" answered (${e.attempts.length} tried):`);
        for (const a of round.attempts) deps.say(`[fail]   ${a.address}: ${a.reason}`);
      } else {
        const where = target.addresses[0] as AddressEntry;
        round.error = explainConnectFailure(messageOf(e), where, deps.name);
        deps.say(`[fail] ${label}: ${round.error}`);
      }
    } finally {
      connected?.session.close();
    }
    if (n < deps.count) await deps.sleep(PING_INTERVAL_MS);
  }

  const answered = report.rounds.filter((r) => r.ok).length;
  report.summary = {
    sent: deps.count,
    ok: answered,
    failed: deps.count - answered,
    ...(handshakes.length > 0 ? { handshake: summarizeSamples(handshakes) } : {}),
    ...(hellos.length > 0 ? { hello: summarizeSamples(hellos) } : {}),
  };
  if (deps.count > 1) {
    deps.say(`--- "${deps.name}" ping statistics ---`);
    deps.say(`${deps.count} attempts, ${answered} answered, ${deps.count - answered} failed`);
    const stat = (name: string, s: SampleSummary | undefined): void => {
      if (s) deps.say(`${name.padEnd(10)} min/avg/max = ${ms(s.min)}/${ms(s.avg)}/${ms(s.max)} ms`);
    };
    stat('handshake', report.summary.handshake);
    stat('hello', report.summary.hello);
  }
  report.ok = answered === deps.count;
  deps.say(report.ok ? `[ok] ping: "${deps.name}" answered ${answered}/${deps.count}; nothing was executed on it (no command was sent)` : `[fail] ping: "${deps.name}" answered ${answered}/${deps.count}; nothing was executed on it`);
  return report;
}

function revocationText(r: CatchUpReport, name: string): string {
  if (!r.peerSupportsCatchUp) return `not supported by "${name}" (an older machine build): update it so that revocations reach it`;
  if (r.inSync) return `same on both machines (version ${r.peerVersion ?? '?'})`;
  const did = [r.installed ? 'the lists of the peer were installed here' : undefined, r.sent ? `this machine's lists were sent to "${name}"` : undefined].filter((x) => x !== undefined);
  return `differed${did.length > 0 ? `: ${did.join(', ')}` : ' (nothing could be exchanged, see the warnings)'}`;
}
