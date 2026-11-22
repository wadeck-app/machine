import { networkInterfaces } from 'node:os';
import { isIPv4 } from 'node:net';
import {
  CONNECTION_TYPES,
  MAX_ADDRESSES,
  WAKE_TUNING_DEFAULTS,
  WAKE_TUNING_FIELDS,
  WAKE_TUNING_LIMITS,
  checkTuning,
  parseAddress,
  parseMac,
  resolveMachineRef,
  resolveRunShell,
  resolveTuning,
  SHELLS,
  type Shell,
  type AddressEntry,
  type ConnectionType,
  type LocalInterface,
  type PeerConnection,
  type WakeConfig,
  type WakeTuningField,
} from '@wadeck-app/machine-core';
import { EXIT, type CommandContext } from './cliTypes.js';
import { connectionsFile, readConnections, removeConnection, updateConnection, ConnectionsError } from './connectionsStore.js';
import { readMachine, type MachineIdentity } from './identity.js';
import { loadNetwork } from './network.js';
import { describeAddress, PeerAddressError, readPeerRecords } from './peerAddresses.js';
import { wakeInfoText } from './wakeInfo.js';
import { connectToTarget, resolvePeerTarget, type PeerTarget, type PeerToReach } from './peerConnect.js';
import { readAliases } from './state.js';
import { NotInitializedError } from './errors.js';
import { WakeStateError } from './wakeState.js';
import { WakeAuditError } from './wakeAudit.js';
import { connectWithWake, settingsFromConfig, WakeError, wakeEnabled, type WakeEnv, type WakeSettings } from './wakeConnect.js';
import { createWakeSender } from './wakeSender.js';

// `machine peer connect` (how this machine reaches a peer), `machine wake`, and the wake plumbing of `machine run` and `machine ping`
// (decision 62). The pure parts are in machine-core (wake.ts, wakeSequence.ts, connections.ts) and wakeConnect.ts.

/** The IPv4 interfaces of this machine. */
export function realInterfaces(): LocalInterface[] {
  const out: LocalInterface[] = [];
  for (const [name, infos] of Object.entries(networkInterfaces())) {
    for (const info of infos ?? []) if (info.family === 'IPv4') out.push({ name, address: info.address, netmask: info.netmask, internal: info.internal });
  }
  return out;
}

const epochSecondsOf = (ctx: CommandContext): number => Math.floor((ctx.io.now?.() ?? new Date()).getTime() / 1000);

export interface TrustedPeer {
  self: MachineIdentity;
  peer: PeerToReach;
}

/** The machine reference of a command as `run` and `ping` resolve it. A failure is returned as the exit code already reported. */
export function resolveTrustedPeer(ctx: CommandContext, ref: string, codes: { reference: number; failure: number }): TrustedPeer | { exit: number } {
  const { configDir, fail } = ctx;
  const self = readMachine(configDir);
  const network = loadNetwork(configDir, epochSecondsOf(ctx));
  const machines = [{ uuid: self.uuid, name: self.name }, ...network.directory.machines()];
  const resolved = resolveMachineRef(ref, machines, readAliases(configDir));
  if (!resolved.ok) return { exit: fail(resolved.message, codes.reference) };
  if (resolved.uuid === self.uuid) return { exit: fail('that is this machine: its connection settings describe how to reach a PEER', codes.failure) };
  const peer = network.directory.find(resolved.uuid);
  if (!peer) return { exit: fail(`"${ref}" is not a trusted peer: see \`machine status\` for what was left out and why`, codes.failure) };
  return { self, peer };
}

export interface WakeSinks {
  info: (line: string) => void;
  ok: (line: string) => void;
  warn: (line: string) => void;
}

/** Wake lines on stderr (stdout belongs to the command output): `[info]`, `[ok]`, `[warn]`. `okOnStdout`: `[ok]` lines go to stdout (ping, wake). */
export function stderrSinks(ctx: CommandContext, okOnStdout = false): WakeSinks {
  const { io, args } = ctx;
  return {
    info: (line) => io.stderr(`[info] ${line}\n`),
    ok: (line) => (okOnStdout && !args.json ? io.stdout(`[ok] ${line}\n`) : io.stderr(`[ok] ${line}\n`)),
    warn: (line) => io.stderr(`[warn] ${line}\n`),
  };
}

export interface WakeEnvOptions {
  requestedBy: WakeEnv['requestedBy'];
  sinks: WakeSinks;
  /** `--address`, the pinned addresses: what `resolveTarget` uses again. */
  pinned: AddressEntry[] | undefined;
  /** Told each address just before it is tried (the timing of `machine ping`). */
  onAttempt?: ((address: AddressEntry) => void) | undefined;
}

/** A timer that a signal cancels: the timer is cleared and the promise resolves (no handle left on the event loop). */
function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** What `connectWithWake` needs from this process: the real clock, interfaces and UDP sender, or the test ones. */
export function makeWakeEnv(ctx: CommandContext, trusted: TrustedPeer, options: WakeEnvOptions): WakeEnv {
  const { io, args, configDir } = ctx;
  const { self, peer } = trusted;
  return {
    configDir,
    self: { uuid: self.uuid, name: self.name },
    peer,
    requestedBy: options.requestedBy,
    // An explicit `machine wake` is the user asking now: the cooldown of the automatic wakes does not apply (the packet limits still do).
    bypassCooldown: options.requestedBy === 'wake',
    epochSeconds: () => epochSecondsOf(ctx),
    nowMs: io.wake?.nowMs ?? (() => performance.now()),
    sleep: io.wake?.sleep ?? realSleep,
    interfaces: io.wake?.interfaces ?? realInterfaces,
    sender: io.wake?.sender ?? createWakeSender(),
    ...options.sinks,
    resolveTarget: () => resolvePeerTarget(configDir, peer, { ...(args.address ? { address: args.address } : {}), pinned: options.pinned, now: epochSecondsOf(ctx), allowLocal: io.allowLoopbackPeers === true, warn: options.sinks.warn }),
    connect: (target, { timeoutMs }) => connectToTarget(self.identity, peer, target, options.onAttempt, timeoutMs, io.wake?.simulateFailure),
  };
}

/** The wake settings of a peer for `run` and `ping`: undefined when the connection does not wake (the type and the flags decide). Failures are returned as a message. */
export function wakeSettingsFor(ctx: CommandContext, peer: PeerToReach, connection: PeerConnection | undefined): { ok: true; settings: WakeSettings | undefined } | { ok: false; message: string } {
  const decision = wakeEnabled({ connection, wake: ctx.args.wake, noWake: ctx.args.noWake, peerName: peer.name });
  if (!decision.ok) return decision;
  if (!decision.enabled || connection?.wake === undefined) return { ok: true, settings: undefined };
  const settings = settingsFromConfig(peer.name, connection.wake);
  return settings.ok ? { ok: true, settings: settings.settings } : { ok: false, message: settings.message };
}

/** `connections.json` for `peer`, or a failure already reported. */
export function connectionOf(ctx: CommandContext, peer: PeerToReach): { ok: true; connection: PeerConnection | undefined } | { ok: false; exit: number } {
  try {
    return { ok: true, connection: readConnections(ctx.configDir).peers[peer.peerId] };
  } catch (e) {
    if (e instanceof ConnectionsError) return { ok: false, exit: ctx.fail(e.message) };
    throw e;
  }
}

const pinnedOf = (connection: PeerConnection | undefined): AddressEntry[] | undefined => (connection?.addresses !== undefined && connection.addresses.length > 0 ? connection.addresses : undefined);

/** Resolves the target of `run`: `--address`, else the pinned addresses, else the relay record. */
export const targetFor = async (ctx: CommandContext, peer: PeerToReach, connection: PeerConnection | undefined, warn: (line: string) => void): Promise<PeerTarget> =>
  await resolvePeerTarget(ctx.configDir, peer, { ...(ctx.args.address ? { address: ctx.args.address } : {}), pinned: pinnedOf(connection), now: epochSecondsOf(ctx), allowLocal: ctx.io.allowLoopbackPeers === true, warn });

export { pinnedOf };

// ---------------------------------------------------------------------------------------------------------------------
// machine peer connect

const TYPE_NOTE = 'ping-if-not-reachable-magic-packet';

const LABELS: Record<WakeTuningField, { label: string; flag: string; unit: string }> = {
  probeSeconds: { label: 'probe window', flag: '--wake-probe', unit: ' s' },
  waitSeconds: { label: 'total wait', flag: '--wake-wait', unit: ' s' },
  maxUnicast: { label: 'max unicast', flag: '--wake-max-unicast', unit: '' },
  maxBroadcast: { label: 'max broadcast', flag: '--wake-max-broadcast', unit: '' },
  connectTimeoutMs: { label: 'connect timeout', flag: '--wake-connect-timeout', unit: ' ms' },
  settleSeconds: { label: 'settle', flag: '--wake-settle', unit: ' s' },
  hedgeMs: { label: 'hedge', flag: '--wake-hedge', unit: ' ms' },
};

const valueText = (field: WakeTuningField, value: number | undefined): string => (value === undefined ? 'default' : `${value}${LABELS[field].unit}`);

const platformShell = (): Shell => resolveRunShell({ platform: process.platform }).shell;

/** The default shell of `machine run <name>`: set by `--shell`, or the platform of this machine. */
const shellLine = (name: string, shell: Shell | undefined): string =>
  `  ${'shell'.padEnd(16)}  ${shell === undefined ? `(default) ${platformShell()}, the platform of this machine: machine peer connect ${name} --shell <cmd|ps|bash|sh>` : `${shell} (machine run ${name} uses it unless --shell is given)`}`;

function showLines(name: string, uuid: string, file: string, connection: PeerConnection): string[] {
  const lines = [`${name} (${uuid})  ${file}`, `  ${'type'.padEnd(16)}  ${connection.type}`];
  const addresses = connection.addresses ?? [];
  lines.push(`  ${'addresses'.padEnd(16)}  ${addresses.length === 0 ? '(none pinned) the relay record is used' : `${addresses.map(describeAddress).join(', ')} (pinned: the relay record is not used)`}`);
  lines.push(shellLine(name, connection.shell));
  const wake = connection.wake;
  if (wake === undefined) {
    lines.push(`  ${'wake'.padEnd(16)}  not configured: machine peer connect ${name} --wake-mac <aa:bb:cc:dd:ee:ff>`);
    return lines;
  }
  lines.push(`  ${'wake mac'.padEnd(16)}  ${wake.mac}`);
  lines.push(`  ${'wake broadcast'.padEnd(16)}  ${wake.broadcast ?? '(default) the directed broadcast of the local network shared with the peer'}`);
  for (const field of WAKE_TUNING_FIELDS) {
    const set = wake[field];
    const effective = set ?? WAKE_TUNING_DEFAULTS[field];
    lines.push(`  ${LABELS[field].label.padEnd(16)}  ${effective}${LABELS[field].unit}${set === undefined ? ' (default)' : ''}  ${LABELS[field].flag}: ${WAKE_TUNING_LIMITS[field].meaning}`);
  }
  return lines;
}

function showDocument(name: string, uuid: string, connection: PeerConnection | undefined): Record<string, unknown> {
  const wake = connection?.wake;
  const effective = { ...WAKE_TUNING_DEFAULTS };
  const defaulted: WakeTuningField[] = [];
  for (const field of WAKE_TUNING_FIELDS) {
    const v = wake?.[field];
    if (v === undefined) defaulted.push(field);
    else effective[field] = v;
  }
  const shell = resolveRunShell({ peerDefault: connection?.shell, platform: process.platform });
  return { uuid, name, entry: connection ?? null, shell: { effective: shell.shell, source: shell.source }, effective, defaulted };
}

export async function runPeerConnect(ctx: CommandContext): Promise<number> {
  const { args, rest, io, configDir, fail, emit } = ctx;
  const ref = rest[1];
  const usage = 'usage: machine peer connect <machine> [--shell cmd|ps|bash|sh | --no-shell] [--type direct|ping-if-not-reachable-magic-packet] [--address <host:port>]... [--wake-mac <mac>] [--wake-broadcast <ipv4>] [--wake-probe <s>] [--wake-wait <s>] [--wake-max-unicast <n>] [--wake-max-broadcast <n>] [--wake-connect-timeout <ms>] [--wake-settle <s>] [--wake-hedge <ms>] | machine peer connect <machine> --show | --remove';
  if (ref === undefined || rest.length > 2) return fail(usage, EXIT.usage);

  const wakeFlags: Array<[WakeTuningField, string | undefined]> = [
    ['probeSeconds', args.wakeProbe],
    ['waitSeconds', args.wakeWait],
    ['maxUnicast', args.wakeMaxUnicast],
    ['maxBroadcast', args.wakeMaxBroadcast],
    ['connectTimeoutMs', args.wakeConnectTimeout],
    ['settleSeconds', args.wakeSettle],
    ['hedgeMs', args.wakeHedge],
  ];
  const settingFlags = [args.type, args.wakeMac, args.wakeBroadcast, args.shell, ...(args.noShell ? ['x'] : []), ...wakeFlags.map(([, v]) => v), ...(args.addressList.length > 0 ? ['x'] : [])].filter((v) => v !== undefined);
  if (args.shell !== undefined && args.noShell) return fail('--shell and --no-shell cannot be combined: --shell sets the default shell of that peer, --no-shell forgets it', EXIT.usage);
  if (args.show && args.remove) return fail('--show and --remove cannot be combined: --show only reads, --remove deletes the settings of the peer', EXIT.usage);
  if ((args.show || args.remove) && settingFlags.length > 0) return fail(`${args.show ? '--show' : '--remove'} takes no setting: give the settings in one command, then \`machine peer connect ${ref} --show\``, EXIT.usage);
  if (!args.show && !args.remove && settingFlags.length === 0) {
    return fail(`nothing to set: give --shell, --address, --type, --wake-mac or a timing flag (--wake-probe, --wake-wait, --wake-max-unicast, --wake-max-broadcast, --wake-connect-timeout, --wake-settle, --wake-hedge), or --show / --remove. ${usage}`, EXIT.usage);
  }

  // The flags are validated before anything is read or written: a typo costs nothing.
  const given: { type?: ConnectionType; addresses?: AddressEntry[]; mac?: string; broadcast?: string; shell?: Shell; tuning: Partial<Record<WakeTuningField, number>> } = { tuning: {} };
  if (args.shell !== undefined) {
    if (!(SHELLS as readonly string[]).includes(args.shell)) return fail(`unknown shell "${args.shell}": expected one of ${SHELLS.join(', ')}`, EXIT.usage);
    given.shell = args.shell as Shell;
  }
  if (args.type !== undefined) {
    if (!(CONNECTION_TYPES as readonly string[]).includes(args.type)) return fail(`--type must be one of ${CONNECTION_TYPES.join(', ')}, got "${args.type}"`, EXIT.usage);
    given.type = args.type as ConnectionType;
  }
  if (args.addressList.length > 0) {
    if (args.addressList.length > MAX_ADDRESSES) return fail(`at most ${MAX_ADDRESSES} --address can be pinned, got ${args.addressList.length}`, EXIT.usage);
    const parsed: AddressEntry[] = [];
    for (const text of args.addressList) {
      const entry = parseAddress(text);
      if (!entry) return fail(`invalid --address "${text}": expected <host>:<port>, for example 192.168.1.20:47921, laptop.example.net:47921 or [::1]:47921`, EXIT.usage);
      if (!parsed.some((p) => p.host === entry.host && p.port === entry.port)) parsed.push(entry);
    }
    given.addresses = parsed;
  }
  if (args.wakeMac !== undefined) {
    const mac = parseMac(args.wakeMac);
    if (!mac.ok) return fail(`--wake-mac: ${mac.message}`, EXIT.usage);
    given.mac = mac.mac;
  }
  if (args.wakeBroadcast !== undefined) {
    if (!isIPv4(args.wakeBroadcast)) return fail(`--wake-broadcast must be an IPv4 address such as 192.168.1.255 (the broadcast address of the LAN of the peer), got "${args.wakeBroadcast}"`, EXIT.usage);
    given.broadcast = args.wakeBroadcast;
  }
  for (const [field, text] of wakeFlags) {
    if (text === undefined) continue;
    const checked = checkTuning(field, text);
    if (!checked.ok) return fail(`${LABELS[field].flag}: ${checked.message}`, EXIT.usage);
    given.tuning[field] = checked.value;
  }

  const trusted = resolveTrustedPeer(ctx, ref, { reference: EXIT.reference, failure: EXIT.failure });
  if ('exit' in trusted) return trusted.exit;
  const { peer } = trusted;
  const file = connectionsFile(configDir);

  try {
    const current = readConnections(configDir).peers[peer.peerId];
    if (args.show) {
      if (args.json) emit(showDocument(peer.name, peer.peerId, current), '');
      else if (current === undefined) {
        io.stdout(`${peer.name} (${peer.peerId}): no connection settings: direct, the address comes from the relay record. Pin an address or set up Wake-on-LAN with: machine peer connect ${peer.name} --address <host:port> --wake-mac <aa:bb:cc:dd:ee:ff>\n`);
      } else io.stdout(`${showLines(peer.name, peer.peerId, file, current).join('\n')}\n`);
      return EXIT.ok;
    }
    if (args.remove) {
      const removed = removeConnection(configDir, peer.peerId);
      if (args.json) emit({ removed, uuid: peer.peerId, name: peer.name }, '');
      else io.stdout(removed ? `[ok] "${peer.name}": connection settings removed (addresses come from the relay record again, no Wake-on-LAN)\n` : `[info] "${peer.name}" has no connection settings: nothing to remove\n`);
      return EXIT.ok;
    }

    // ---- set ----
    if (args.noShell && current?.shell === undefined) {
      if (args.json) emit({ saved: false, ...showDocument(peer.name, peer.peerId, current) }, '');
      else io.stdout(`[info] "${peer.name}" has no default shell: nothing to remove (\`machine run\` uses the platform of this machine, ${platformShell()}, or --shell)\n`);
      return EXIT.ok;
    }
    const wakeKeys = Object.keys(given.tuning);
    const mac = given.mac ?? current?.wake?.mac;
    if (mac === undefined && (wakeKeys.length > 0 || given.broadcast !== undefined)) {
      const flag = given.broadcast !== undefined ? '--wake-broadcast' : LABELS[wakeKeys[0] as WakeTuningField].flag;
      return fail(`${flag} needs the MAC address of "${peer.name}", and none is configured: give --wake-mac aa:bb:cc:dd:ee:ff in the same command (the MAC is typed by you, never learned from the relay)`, EXIT.usage);
    }
    let type = given.type ?? current?.type;
    let autoType = false;
    if (type === undefined || (current?.wake === undefined && given.mac !== undefined && given.type === undefined)) {
      type = given.mac !== undefined ? TYPE_NOTE : 'direct';
      autoType = given.mac !== undefined;
    }
    if (type === TYPE_NOTE && mac === undefined) return fail(`--type ${TYPE_NOTE} needs the MAC address of "${peer.name}": add --wake-mac aa:bb:cc:dd:ee:ff (the MAC is typed by you, never learned from the relay)`, EXIT.usage);

    const next: PeerConnection = { type: type as ConnectionType };
    const shell = args.noShell ? undefined : (given.shell ?? current?.shell);
    if (shell !== undefined) next.shell = shell;
    const addresses = given.addresses ?? current?.addresses;
    if (addresses !== undefined && addresses.length > 0) next.addresses = addresses;
    if (mac !== undefined) {
      const wake: WakeConfig = { mac };
      const broadcast = given.broadcast ?? current?.wake?.broadcast;
      if (broadcast !== undefined) wake.broadcast = broadcast;
      for (const field of WAKE_TUNING_FIELDS) {
        const v = given.tuning[field] ?? current?.wake?.[field];
        if (v !== undefined) wake[field] = v;
      }
      next.wake = wake;
      try {
        resolveTuning(Object.fromEntries(WAKE_TUNING_FIELDS.filter((f) => wake[f] !== undefined).map((f) => [f, wake[f]])));
      } catch (e) {
        return fail((e as Error).message, EXIT.usage);
      }
    }

    const saved = updateConnection(configDir, peer.peerId, () => next);
    if (autoType) io.stderr(`[info] type set to ${TYPE_NOTE} because a MAC address was given: \`machine run\` and \`machine ping\` wake "${peer.name}" when it cannot be reached. Keep it explicit with --type direct (then --wake wakes on demand)\n`);
    if (current !== undefined) {
      const was = (value: string | undefined): string => value ?? 'none';
      const change = (label: string, before: string | undefined, after: string | undefined): void => {
        if (before !== after) io.stderr(`[info] ${label}: ${was(before)} -> ${was(after)}\n`);
      };
      change('type', current.type, saved.type);
      change('shell', current.shell, saved.shell);
      change('addresses', current.addresses?.map(describeAddress).join(', '), saved.addresses?.map(describeAddress).join(', '));
      change('wake mac', current.wake?.mac, saved.wake?.mac);
      change('wake broadcast', current.wake?.broadcast, saved.wake?.broadcast);
      for (const field of WAKE_TUNING_FIELDS) change(LABELS[field].label, current.wake === undefined ? undefined : valueText(field, current.wake[field]), saved.wake === undefined ? undefined : valueText(field, saved.wake[field]));
    }
    if (args.json) emit({ saved: true, ...showDocument(peer.name, peer.peerId, saved) }, '');
    else io.stdout(`[ok] "${peer.name}": connection settings saved\n${showLines(peer.name, peer.peerId, file, saved).join('\n')}\n`);
    return EXIT.ok;
  } catch (e) {
    if (e instanceof ConnectionsError || e instanceof NotInitializedError) return fail(e.message);
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// machine wake

/** Sends the wake now and waits for the peer to answer: 0 it answers, 1 it does not (or cannot be woken from here). */
export async function runWake(ctx: CommandContext): Promise<number> {
  const { rest, fail, emit } = ctx;
  const ref = rest[0];
  if (ref === undefined || rest.length > 1) return fail('usage: machine wake <machine> [--address <host:port>] [--json]', EXIT.usage);
  const trusted = resolveTrustedPeer(ctx, ref, { reference: EXIT.reference, failure: EXIT.failure });
  if ('exit' in trusted) return trusted.exit;
  const { peer } = trusted;
  const read = connectionOf(ctx, peer);
  if (!read.ok) return read.exit;
  const { connection } = read;
  if (connection?.wake === undefined) {
    return fail(`no MAC address is configured for "${peer.name}": run \`machine peer connect ${peer.name} --wake-mac aa:bb:cc:dd:ee:ff\` once (the MAC is typed by you, never learned from the relay; \`ip link\` or \`ipconfig /all\` on that machine shows it)`);
  }
  const settings = settingsFromConfig(peer.name, connection.wake);
  if (!settings.ok) return fail(settings.message);
  const sinks = stderrSinks(ctx, true);
  try {
    const target = await targetFor(ctx, peer, connection, sinks.warn);
    const env = makeWakeEnv(ctx, trusted, { requestedBy: 'wake', sinks, pinned: pinnedOf(connection) });
    const result = await connectWithWake(env, target, settings.settings);
    result.connected.session.close();
    if (result.wake === undefined) sinks.ok(`"${peer.name}" already answers on ${describeAddress(result.connected.address)}: no packet was sent`);
    emit({ name: peer.name, uuid: peer.peerId, awake: true, address: describeAddress(result.connected.address), wake: result.wake ?? null }, '');
    return EXIT.ok;
  } catch (e) {
    if (e instanceof WakeError || e instanceof PeerAddressError || e instanceof WakeStateError || e instanceof WakeAuditError || e instanceof ConnectionsError) return fail(e.message);
    // A connection failure that waking cannot cure (not registered there, another key...): the original message says which.
    return fail((e as Error).message);
  }
}


// ---------------------------------------------------------------------------------------------------------------------
// machine wake-info

/** The checklist that prepares the target of a wake. Local files only: no connection, no packet, nothing written. */
export function runWakeInfo(ctx: CommandContext): number {
  const { args, rest, io, fail } = ctx;
  const ref = rest[0];
  if (args.json) return fail('--json does not apply to `machine wake-info` (a checklist for a person: plain text)', EXIT.usage);
  if (ref === undefined || rest.length > 1) return fail('usage: machine wake-info <machine>', EXIT.usage);
  const trusted = resolveTrustedPeer(ctx, ref, { reference: EXIT.reference, failure: EXIT.failure });
  if ('exit' in trusted) return trusted.exit;
  const { peer } = trusted;
  const read = connectionOf(ctx, peer);
  if (!read.ok) return read.exit;
  try {
    const remembered = readPeerRecords(ctx.configDir)[peer.peerId]?.addresses ?? [];
    io.stdout(
      wakeInfoText({
        name: peer.name,
        uuid: peer.peerId,
        pinned: (read.connection?.addresses ?? []).map(describeAddress),
        remembered: remembered.map(describeAddress),
        mac: read.connection?.wake?.mac,
        ...(read.connection?.wake !== undefined ? { hedgeMs: read.connection.wake.hedgeMs ?? WAKE_TUNING_DEFAULTS.hedgeMs, hedgeIsDefault: read.connection.wake.hedgeMs === undefined } : {}),
      }),
    );
    return EXIT.ok;
  } catch (e) {
    if (e instanceof PeerAddressError) return fail(e.message);
    throw e;
  }
}
