import { createDaemonClient } from '@wadeck-app/singleton-daemon-kit';
import { parseAddress, parsePingCount, resolveMachineRef } from '@wadeck-app/machine-core';
import { appVersion } from './version.js';
import { makeCommands } from './commands.js';
import { EXIT, type CommandContext } from './cliTypes.js';
import { readMachine } from './identity.js';
import { installRevocation, loadNetwork, recordRevocationSeen, revocationState, trustedRegistrations } from './network.js';
import { connectionOf, makeWakeEnv, pinnedOf, stderrSinks, wakeSettingsFor } from './cliWake.js';
import { connectToTarget, resolvePeerTarget } from './peerConnect.js';
import { connectWithWake, type WakeSummary } from './wakeConnect.js';
import { checkLine, pingPeer, pingRelay } from './ping.js';
import { createRelayClient } from './relayClient.js';
import { readRelayConfig } from './relayStore.js';
import { catchUpRevocations } from './revocationSync.js';
import { readAliases } from './state.js';

// `machine ping [<machine>] [--count <n>] [--address <host:port>] [--json]` (decision 61). Reads and connects only: no command is sent, no
// policy entry is needed, no right is widened, nothing is written to the audit log (see ping.ts).

/** A finished line goes where its marker says: failures and warnings on stderr, the rest on stdout (like every other command). */
const route = (ctx: CommandContext, text: string): void => {
  if (text.startsWith('[fail]') || text.startsWith('[warn]')) ctx.io.stderr(`${text}\n`);
  else ctx.io.stdout(`${text}\n`);
};

export async function runPingCommand(ctx: CommandContext): Promise<number> {
  const { args, rest, io, configDir, fail, emit } = ctx;
  const ref = rest[0];
  if (rest.length > 1) return fail(`unexpected argument "${rest[1]}" for \`machine ping\`: usage: machine ping [<machine>] [--count <n>] [--address <host:port>] [--json]`, EXIT.usage);
  const epochSeconds = (): number => Math.floor((io.now?.() ?? new Date()).getTime() / 1000);

  // ---- machine ping: the path to the relay ----
  if (ref === undefined) {
    if (args.count !== undefined) return fail('--count only applies to `machine ping <machine>` (the relay form is one round of checks)', EXIT.usage);
    if (args.address !== undefined) return fail('--address only applies to `machine ping <machine>` (it replaces the address the relay gives for that machine)', EXIT.usage);
    if (args.wake || args.noWake) return fail(`${args.wake ? '--wake' : '--no-wake'} applies to \`machine ping <machine>\` (the form without a machine only checks the path to the relay)`, EXIT.usage);
    const report = await pingRelay({
      now: epochSeconds,
      clock: () => performance.now(),
      readRelay: () => readRelayConfig(configDir),
      client: (config) => createRelayClient({ baseUrl: config.relayUrl, token: config.token }),
      self: () => {
        const m = readMachine(configDir);
        return { uuid: m.uuid, name: m.name, publicKey: m.identity.publicKey };
      },
      // The same check as the daemon client of every other command, but only the question: the daemon is never started by a ping.
      daemonRunning: () => createDaemonClient({ configDir, commands: makeCommands(configDir, appVersion) }).isRunning(),
    });
    if (args.json) emit({ ok: report.ok, checks: report.checks }, '');
    else for (const c of report.checks) route(ctx, checkLine(c));
    if (!report.ok) {
      const failed = report.checks.filter((c) => c.status === 'fail').length;
      io.stderr(`[fail] ping: ${failed} of ${report.checks.filter((c) => c.status !== 'info').length} checks failed: fix the first [fail] line, then run \`machine ping\` again\n`);
      return EXIT.failure;
    }
    return EXIT.ok;
  }

  // ---- machine ping <machine>: the real channel to a peer ----
  const counted = parsePingCount(args.count);
  if (!counted.ok) return fail(counted.message, EXIT.usage);
  if (args.address !== undefined && !parseAddress(args.address)) {
    return fail(`invalid --address "${args.address}": expected <host>:<port>, for example 192.168.1.20:47921 or [::1]:47921`, EXIT.usage);
  }
  const self = readMachine(configDir);
  const network = loadNetwork(configDir, epochSeconds());
  const machines = [{ uuid: self.uuid, name: self.name }, ...network.directory.machines()];
  const resolved = resolveMachineRef(ref, machines, readAliases(configDir));
  if (!resolved.ok) return fail(resolved.message, EXIT.reference);
  if (resolved.uuid === self.uuid) return fail('that is this machine: ping a peer, or run `machine ping` alone to check this machine\'s path to the relay', EXIT.failure);
  const peer = network.directory.find(resolved.uuid);
  if (!peer) return fail(`"${ref}" is not a trusted peer: see \`machine status\` for what was left out and why`, EXIT.failure);
  const registered = trustedRegistrations(configDir, epochSeconds()).find((r) => r.body.uuid === peer.peerId);
  // How this machine reaches the peer (decision 62): pinned addresses, and whether a peer that cannot be reached is woken (the type, --wake, --no-wake).
  const read = connectionOf(ctx, peer);
  if (!read.ok) return read.exit;
  const wakeSettings = wakeSettingsFor(ctx, peer, read.connection);
  if (!wakeSettings.ok) return fail(wakeSettings.message, EXIT.usage);
  // One wake per ping: the rounds after a wake (answered or not) connect directly, so a count of 10 never means ten wakes.
  let wakeAllowed = wakeSettings.settings !== undefined;
  let wakeSummary: WakeSummary | undefined;
  const sinks = stderrSinks(ctx, true);

  const sleep = io.timing?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const report = await pingPeer({
    name: peer.name,
    uuid: peer.peerId,
    ...(registered ? { registration: { serial: registered.body.serial, adminKeyId: registered.body.adminKeyId, validTo: registered.body.validTo } } : {}),
    count: counted.count,
    now: epochSeconds,
    clock: () => performance.now(),
    sleep: (ms) => sleep(ms),
    // The relay is asked, or --address used, by the very code `machine run` uses. The warnings of the resolution are printed by pingPeer.
    resolveTarget: () => resolvePeerTarget(configDir, peer, { ...(args.address ? { address: args.address } : {}), pinned: pinnedOf(read.connection), now: epochSeconds(), allowLocal: io.allowLoopbackPeers === true, warn: () => undefined }),
    connect: async (target, onAttempt) => {
      if (!wakeAllowed) return await connectToTarget(self.identity, peer, target, onAttempt, undefined, io.wake?.simulateFailure);
      const env = makeWakeEnv(ctx, { self, peer }, { requestedBy: 'ping', sinks: { ...sinks, info: args.json ? (line) => io.stderr(`[info] ${line}\n`) : sinks.info }, pinned: pinnedOf(read.connection), onAttempt });
      try {
        const result = await connectWithWake(env, target, wakeSettings.settings);
        if (result.wake) {
          wakeAllowed = false;
          wakeSummary = result.wake;
        }
        return result.connected;
      } catch (e) {
        // A wake that was tried (or refused) is not tried again by the next round.
        wakeAllowed = false;
        throw e;
      }
    },
    // The same revocation hello as before a `run`: the one authenticated request of the protocol that carries no command.
    catchUp: (session) =>
      catchUpRevocations(session, {
        state: () => revocationState(configDir),
        install: (signed) => installRevocation(configDir, signed, { now: epochSeconds() }),
        seen: (peerUuid, announced) => recordRevocationSeen(configDir, peerUuid, announced, epochSeconds(), (warning) => io.stderr(`[warn] ${warning}\n`)),
        peerId: peer.peerId,
        peerLabel: peer.name,
        peerTrusted: () => loadNetwork(configDir, epochSeconds()).directory.find(peer.peerId) !== undefined,
      }),
    say: (text) => {
      if (!args.json) route(ctx, text);
    },
    warn: (text) => {
      if (!args.json) io.stderr(`[warn] ${text}\n`);
    },
  });
  if (wakeSummary) report.wake = wakeSummary;
  if (args.json) {
    emit(report, '');
    if (!report.ok) io.stderr(`[fail] ping: "${peer.name}" did not answer every round: see "rounds" and "error" in the JSON document\n`);
  }
  return report.ok ? EXIT.ok : EXIT.failure;
}
