import {
  WAKE_PORT,
  WAKE_COOLDOWN_SECONDS,
  buildMagicPacket,
  cooldownRemainingSeconds,
  describeAnswer,
  isWakeableFailure,
  parseMac,
  planWakeSteps,
  resolveTuning,
  runWakeSequence,
  selectWakeRoutes,
  type EffectiveTuning,
  type LocalInterface,
  type PeerConnection,
  type WakeConfig,
  type WakeMethod,
  type WakeRoute,
} from '@wadeck-app/machine-core';
import { ConnectError } from '@wadeck-app/machine-transport';
import { AllAddressesFailedError, describeAddress, kindsOfConnectFailure } from './peerAddresses.js';
import type { Connected, PeerTarget, PeerToReach } from './peerConnect.js';
import { readWakeState, recordWake } from './wakeState.js';
import { writeWakeAudit } from './wakeAudit.js';
import type { WakeSender } from './wakeSender.js';

// The connection of `machine run`, `machine ping` and `machine wake` to a peer that may be asleep (decision 62): try, and when every failure
// says "unreachable" or "timeout" (a TYPE, see ConnectFailureKind), send magic packets (broadcast then unicast, alternating, a probe window after each) and keep
// trying. Everything that touches the world (clock, sockets, interfaces, connection, files of the config dir) is in `WakeEnv`.

/** Attempts of a wake start at least this far apart (or `connectTimeoutMs` when that is shorter): bounded, no flood. */
const WAKE_RETRY_INTERVAL_MS = 500;

/** The wake cannot be tried or did not work: the message says why and what to do. */
export class WakeError extends Error {}

export interface WakeSettings {
  mac: string;
  macBytes: Uint8Array;
  broadcast?: string;
  tuning: EffectiveTuning;
}

/** The wake block of a peer, validated again (a file edited by hand, a flag). Never throws: the message is meant for the person. */
export function settingsFromConfig(peerName: string, wake: WakeConfig): { ok: true; settings: WakeSettings } | { ok: false; message: string } {
  const mac = parseMac(wake.mac);
  if (!mac.ok) return { ok: false, message: `${mac.message}. Fix it with \`machine peer connect ${peerName} --wake-mac <aa:bb:cc:dd:ee:ff>\`` };
  let tuning: EffectiveTuning;
  try {
    tuning = resolveTuning({
      ...(wake.probeSeconds !== undefined ? { probeSeconds: wake.probeSeconds } : {}),
      ...(wake.waitSeconds !== undefined ? { waitSeconds: wake.waitSeconds } : {}),
      ...(wake.maxUnicast !== undefined ? { maxUnicast: wake.maxUnicast } : {}),
      ...(wake.maxBroadcast !== undefined ? { maxBroadcast: wake.maxBroadcast } : {}),
      ...(wake.connectTimeoutMs !== undefined ? { connectTimeoutMs: wake.connectTimeoutMs } : {}),
      ...(wake.settleSeconds !== undefined ? { settleSeconds: wake.settleSeconds } : {}),
    });
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  return { ok: true, settings: { mac: mac.mac, macBytes: mac.bytes, ...(wake.broadcast !== undefined ? { broadcast: wake.broadcast } : {}), tuning } };
}

/** `--wake` / `--no-wake` over the configured type. `--wake` needs a MAC (an entry with a wake block). */
export function wakeEnabled(options: { connection: PeerConnection | undefined; wake: boolean; noWake: boolean; peerName: string }): { ok: true; enabled: boolean } | { ok: false; message: string } {
  const { connection, wake, noWake, peerName } = options;
  if (wake && noWake) return { ok: false, message: '--wake and --no-wake cannot be combined: --wake forces the wake of a peer that cannot be reached, --no-wake forbids it' };
  if (noWake) return { ok: true, enabled: false };
  if (wake) {
    if (connection?.wake === undefined) return { ok: false, message: `--wake needs the MAC address of "${peerName}", and none is configured: run \`machine peer connect ${peerName} --wake-mac aa:bb:cc:dd:ee:ff\` once (the MAC is typed by you, never learned from the relay)` };
    return { ok: true, enabled: true };
  }
  return { ok: true, enabled: connection?.type === 'ping-if-not-reachable-magic-packet' };
}

export interface WakeEnv {
  configDir: string;
  /** The caller: who woke what. */
  self: { uuid: string; name: string };
  peer: PeerToReach;
  /** Which command asked for the wake (audit). */
  requestedBy: 'run' | 'ping' | 'wake';
  /** An explicit `machine wake`: the 60 s cooldown (made for the automatic wakes of `run` and `ping`) does not apply. The packet limits do. */
  bypassCooldown?: boolean;
  epochSeconds: () => number;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The IPv4 interfaces of this machine. */
  interfaces: () => LocalInterface[];
  sender: WakeSender;
  /** One finished line each, without the marker. */
  info: (line: string) => void;
  ok: (line: string) => void;
  warn: (line: string) => void;
  /** The address of the peer again (relay record). Only used when the target came from the relay. */
  resolveTarget: () => Promise<PeerTarget>;
  /** One authenticated connection attempt. `timeoutMs`: the per-address limit of a probe (absent: the normal one). */
  connect: (target: PeerTarget, options: { timeoutMs?: number }) => Promise<Connected>;
}

export interface WakeSummary {
  outcome: 'answered';
  packets: number;
  unicast: number;
  broadcast: number;
  elapsedSeconds: number;
  /** The method of the last packet before the answer: what followed, not proof of cause (a packet gives no acknowledgement). */
  followedBy?: WakeMethod;
  /** Probe window of that packet (1-based), 0 when no packet was sent. */
  window: number;
  intoWindowSeconds: number;
  /** The answer came after more than 80% of its window: raise probeSeconds. */
  tight: boolean;
  cooldownSeconds?: number;
  /** A probe was refused before the answer (the host was awake, no daemon listened yet): seconds from the first failure to that refusal. */
  awakeAfterSeconds?: number;
  /** Same case: seconds the daemon took to listen after the host was seen awake. */
  daemonTookSeconds?: number;
}

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

const reasonOf = (reason: string): string => reason.split(': check that')[0] as string;

function describeFailure(error: unknown): string {
  if (error instanceof AllAddressesFailedError) return error.attempts.map((a) => `${describeAddress(a.address)}: ${reasonOf(a.reason)}`).join('; ');
  return reasonOf((error as Error).message);
}

/** The addresses that refused the connection, as `host:port`. */
function refusedAddresses(error: unknown, target: PeerTarget): string {
  const refused = error instanceof AllAddressesFailedError ? error.attempts.filter((a) => a.kind === 'refused').map((a) => a.address) : target.addresses.slice(0, 1);
  return [...new Set(refused.map(describeAddress))].join(', ');
}

/** The host answered (connection refused) and no daemon listens: what to do. Said at once when the first attempt is refused, and after the wait when the probes of the wake were. */
const nothingListens = (name: string, where: string): string =>
  `"${name}" is reachable but nothing listens on ${where}: it is awake, so a magic packet would not help. Start the daemon there (\`machine startup enable\` on that machine), then run the command again`;

const hostsOf =(target: PeerTarget): string[] => target.addresses.map((a) => a.host);

function destinationsOf(method: WakeMethod, routes: readonly WakeRoute[]): string[] {
  return [...new Set(routes.flatMap((r) => (method === 'unicast' ? r.unicast : [r.broadcast])))];
}

/**
 * Connects to the peer; when `settings` is given and every failure is `unreachable` or `timeout`, wakes it and connects when it answers.
 * Throws the original error when waking does not apply, a `WakeError` when it was tried or refused.
 */
export async function connectWithWake(env: WakeEnv, target: PeerTarget, settings: WakeSettings | undefined): Promise<{ connected: Connected; wake?: WakeSummary }> {
  let first: unknown;
  try {
    return { connected: await env.connect(target, {}) };
  } catch (e) {
    first = e;
  }
  if (settings === undefined) throw first;
  const name = env.peer.name;
  const kinds = kindsOfConnectFailure(first);
  if (kinds.includes('refused')) {
    // The host answered at TCP level: it is awake and no daemon listens. Said before anything else, with where and what to do; no packet.
    env.info(nothingListens(name, refusedAddresses(first, target)));
    throw first;
  }
  if (!isWakeableFailure(kinds)) {
    // Said for a connection failure only: a missing address record or a relay error is not about the peer being up or down.
    if (first instanceof AllAddressesFailedError || first instanceof ConnectError) env.info(`not waking "${name}": ${describeFailure(first)}. A magic packet cannot fix that (only "unreachable" and "timeout" can mean a sleeping machine)`);
    throw first;
  }

  const { values: tuning } = settings.tuning;
  const routes = selectWakeRoutes(env.interfaces(), hostsOf(target), settings.broadcast, name);
  if (!routes.ok) throw new WakeError(`"${name}" is unreachable (${describeFailure(first)}) and Wake-on-LAN cannot be tried: ${routes.message}`);
  const canUnicast = routes.routes.some((r) => r.unicast.length > 0);

  // The cooldown file is read before anything is sent: a corrupt one stops here, naming the file.
  const lastWakeAt = readWakeState(env.configDir).peers[env.peer.peerId]?.lastWakeAt;
  const cooldown = env.bypassCooldown === true ? 0 : cooldownRemainingSeconds(lastWakeAt, env.epochSeconds());
  const steps = cooldown > 0 ? [] : planWakeSteps({ canUnicast, maxUnicast: tuning.maxUnicast, maxBroadcast: tuning.maxBroadcast, probeMs: tuning.probeSeconds * 1000, waitMs: tuning.waitSeconds * 1000 });
  const packet = buildMagicPacket(settings.macBytes);

  env.info(`"${name}" is unreachable (${describeFailure(first)})`);
  if (cooldown > 0) {
    env.info(`"${name}" was woken ${fmt((lastWakeAt === undefined ? 0 : env.epochSeconds() - lastWakeAt))} s ago from this machine: no new packet for another ${cooldown} s (cooldown ${WAKE_COOLDOWN_SECONDS} s), waiting for it to answer`);
  } else {
    if (!canUnicast) env.info(`no known IPv4 address of "${name}" on this network: broadcast only`);
    const where = [`broadcast to ${destinationsOf('broadcast', routes.routes).join(', ')}`, canUnicast ? `unicast to ${destinationsOf('unicast', routes.routes).join(', ')}` : undefined].filter((x) => x !== undefined).join(' and ');
    env.info(
      `sending magic packets for ${settings.mac}: ${where} (UDP port ${WAKE_PORT}), alternating, with a probe window of ${tuning.probeSeconds} s after each; at most ${canUnicast ? tuning.maxUnicast : 0} unicast and ${tuning.maxBroadcast} broadcast; waiting up to ${tuning.waitSeconds} s`,
    );
  }

  let current = target;
  let refreshWarned = false;
  let lastDestinations: string[] = [];
  const sendErrors: string[] = [];
  const sentBy: Record<WakeMethod, number> = { unicast: 0, broadcast: 0 };
  const base = () => ({
    requestedBy: env.requestedBy,
    sourceUuid: env.self.uuid,
    sourceName: env.self.name,
    peerUuid: env.peer.peerId,
    peerName: name,
    mac: settings.mac,
  });
  const ts = (): string => new Date(env.epochSeconds() * 1000).toISOString();

  const outcome = await runWakeSequence<Connected>(
    {
      nowMs: env.nowMs,
      sleep: env.sleep,
      connect: () => env.connect(current, { timeoutMs: tuning.connectTimeoutMs }),
      kindsOf: kindsOfConnectFailure,
      send: async (step, total) => {
        // Recomputed at each packet: the address can have changed (relay record) and the interfaces with it.
        const selected = selectWakeRoutes(env.interfaces(), hostsOf(current), settings.broadcast, name);
        if (!selected.ok) throw new Error(selected.message);
        const to = destinationsOf(step.method, selected.routes);
        // No audit, no packet: the entry is written before the send (it says what is about to be sent, and where).
        writeWakeAudit(env.configDir, { event: 'wake.packet', ts: ts(), ...base(), method: step.method, n: step.n, total, to, port: WAKE_PORT });
        if (step.n === 1) recordWake(env.configDir, env.peer.peerId, env.epochSeconds());
        const report = await env.sender.send(step.method, packet, selected.routes);
        lastDestinations = report.destinations.filter((d) => d.ok).map((d) => d.to);
        for (const d of report.destinations.filter((x) => !x.ok)) {
          sendErrors.push(`${d.to}: ${d.error ?? 'failed'}`);
          env.warn(`could not send the ${step.method} packet to ${d.to} (from ${d.from}): ${d.error ?? 'failed'}`);
        }
        sentBy[step.method]++;
      },
      ...(target.source === 'relay'
        ? {
            refresh: async () => {
              try {
                current = await env.resolveTarget();
              } catch (e) {
                if (!refreshWarned) env.warn(`could not read the address of "${name}" again from the relay (${(e as Error).message}): keeping the last one`);
                refreshWarned = true;
              }
            },
          }
        : {}),
      say: (event) => {
        const what = `[${event.n}/${event.total}] ${event.method} to ${lastDestinations.join(', ')}`;
        env.info(event.n === 1 ? what : `still unreachable after ${fmt(Math.round(event.elapsedMs / 100) / 10)} s: ${what}`);
      },
    },
    // An attempt that fails fast is retried after 500 ms at most (never faster); one that uses its whole limit is followed at once by the next.
    { waitMs: tuning.waitSeconds * 1000, steps, attemptIntervalMs: Math.min(tuning.connectTimeoutMs, WAKE_RETRY_INTERVAL_MS), refreshEveryMs: 10_000 },
  );

  const result = (extra: Record<string, string | number | string[]>): void => {
    try {
      writeWakeAudit(env.configDir, { event: 'wake.result', ts: ts(), ...base(), packets: outcome.packets, unicast: sentBy.unicast, broadcast: sentBy.broadcast, elapsedMs: Math.round(outcome.elapsedMs), ...(sendErrors.length > 0 ? { sendErrors } : {}), ...extra });
    } catch (e) {
      env.warn((e as Error).message);
    }
  };

  if (outcome.outcome === 'answered') {
    const answer = describeAnswer({ elapsedMs: outcome.elapsedMs, lastStep: outcome.lastStep, probeMs: tuning.probeSeconds * 1000 });
    result({ outcome: 'answered', ...(answer.followedBy ? { followedBy: answer.followedBy } : {}), window: answer.window });
    const awakeAfter = outcome.awakeAtMs === undefined ? undefined : Math.round(outcome.awakeAtMs / 100) / 10;
    const daemonTook = outcome.awakeAtMs === undefined ? undefined : Math.round((outcome.elapsedMs - outcome.awakeAtMs) / 100) / 10;
    const how =
      daemonTook !== undefined
        ? `after ${fmt(answer.elapsedSeconds)} s (the host was awake, the daemon took ${fmt(daemonTook)} s to listen)`
        : answer.followedBy === undefined
        ? `after ${fmt(answer.elapsedSeconds)} s with no packet sent by this run`
        : `after ${fmt(answer.elapsedSeconds)} s, woken by ${answer.followedBy} (probe window ${answer.window}, ${fmt(answer.intoWindowSeconds)} s into its ${tuning.probeSeconds} s)`;
    env.ok(`"${name}" answered ${how}. Wake-on-LAN gives no acknowledgement: this names the last packet sent before the answer, it does not prove which one worked`);
    // An answer that came after a refusal says nothing about the probe window: the host was already awake.
    if (answer.tight && daemonTook === undefined) {
      env.info(
        `it answered ${fmt(answer.intoWindowSeconds)} s into a ${tuning.probeSeconds} s probe window: a slower resume would be missed. Raise the window for this peer: machine peer connect ${name} --wake-probe ${Math.min(60, tuning.probeSeconds * 2)}`,
      );
    }
    if (tuning.settleSeconds > 0) {
      env.info(`waiting ${tuning.settleSeconds} s before the command (settleSeconds: the network of "${name}" may answer before its daemon is ready)`);
      await env.sleep(tuning.settleSeconds * 1000);
    }
    const summary: WakeSummary = {
      outcome: 'answered',
      packets: outcome.packets,
      unicast: sentBy.unicast,
      broadcast: sentBy.broadcast,
      elapsedSeconds: answer.elapsedSeconds,
      ...(answer.followedBy ? { followedBy: answer.followedBy } : {}),
      window: answer.window,
      intoWindowSeconds: answer.intoWindowSeconds,
      tight: answer.tight,
      ...(cooldown > 0 ? { cooldownSeconds: cooldown } : {}),
      ...(awakeAfter !== undefined && daemonTook !== undefined ? { awakeAfterSeconds: awakeAfter, daemonTookSeconds: daemonTook } : {}),
    };
    return { connected: outcome.value, wake: summary };
  }

  if (outcome.outcome === 'refused') {
    result({ outcome: 'refused', awakeAfterMs: Math.round(outcome.awakeAtMs) });
    throw new WakeError(
      `${nothingListens(name, refusedAddresses(outcome.lastError, current))}. It was still refused after ${tuning.waitSeconds} s of probing (first refused ${fmt(Math.round(outcome.awakeAtMs / 100) / 10)} s after the first failure; ${outcome.packets} packet(s) sent before that, none after)`,
    );
  }

  if (outcome.outcome === 'aborted') {
    result({ outcome: 'aborted', kinds: outcome.kinds });
    throw new WakeError(
      `"${name}" answers, but the connection fails for another reason, so waking is not the problem (after ${outcome.packets} packet(s), ${fmt(Math.round(outcome.elapsedMs / 100) / 10)} s): ${(outcome.error as Error).message}${outcome.kinds.includes('refused') ? `. The host is awake but nothing listens: start the daemon there (\`machine startup enable\` on that machine), then run the command again` : ''}`,
    );
  }

  if (outcome.outcome === 'send-failed') {
    result({ outcome: 'send-failed', error: outcome.error.message });
    const step = outcome.packets + 1;
    throw new WakeError(
      `the magic packet ${step}/${steps.length} could not be sent: ${outcome.error.message}. ${outcome.packets === 0 ? 'No packet was sent' : `${outcome.packets} earlier packet(s) were sent`}: fix the cause above, then run the command again`,
    );
  }

  // no-answer
  result({ outcome: 'no-answer' });
  const slower = Math.min(600, tuning.waitSeconds * 2);
  const sent = `${outcome.packets} packet${outcome.packets === 1 ? '' : 's'}${outcome.packets > 0 ? ` (${sentBy.unicast} unicast, ${sentBy.broadcast} broadcast)` : ''}`;
  throw new WakeError(
    `no answer from "${name}" after ${tuning.waitSeconds} s and ${sent}${cooldown > 0 ? `; this run sent no packet because the last wake was less than ${WAKE_COOLDOWN_SECONDS} s ago (cooldown)` : ''}. Wake-on-LAN gives no acknowledgement, so this cannot say which step failed. Check the target: Wake-on-LAN enabled in its BIOS/UEFI and driver (on Linux \`ethtool <interface>\` shows "Wake-on: g"), suspended (sleeping) rather than powered off, and its daemon started at login (\`machine startup enable\` there). If it resumes slowly: \`machine peer connect ${name} --wake-wait ${slower}\` (total wait) and \`--wake-probe ${Math.min(60, tuning.probeSeconds * 2)}\` (window after each packet)`,
  );
}
