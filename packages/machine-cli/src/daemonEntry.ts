import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createDaemon, type DaemonHandle } from '@wadeck-app/singleton-daemon-kit';
import { adminPinFile } from './admin.js';
import { resolveAdvertised, type AdvertiseSpec, type InterfaceProvider } from './addressDiscovery.js';
import { createAddressPublisher } from './addressPublisher.js';
import { makeCommands } from './commands.js';
import { NotInitializedError } from './errors.js';
import { readMachine } from './identity.js';
import { installRevocation, loadNetwork, recordRevocationSeen, revocationState, type Network } from './network.js';
import { startInboxLoop, type InboxLoop, type InboxTimer } from './inboxLoop.js';
import { HoldTable } from '@wadeck-app/machine-core';
import { startPeerListener, type ServicedPeerListener } from './peerService.js';
import { createRelayClient, type RelayClient } from './relayClient.js';
import { readRelayConfig } from './relayStore.js';
import { removeDaemonPortFile, writeDaemonPortFile } from './daemonPortFile.js';
import { startUpdates, type DaemonUpdates } from './daemonUpdates.js';
import { registerOnStart, type RegisterOnStartOptions } from './appCoreRegistration.js';
import { isReleaseVersion } from '@wadeck-app/shared-cli/ReleaseVersion';
import { fileURLToPath } from 'node:url';
import { FileAuditLog, FileUsageStore } from './stores.js';
import { policyFingerprint } from './policyMode.js';
import { makeRequestsListDeps } from './requestsView.js';
import { createRequestNotifier, type RequestNotifier } from './requestNotifier.js';
import { makeNoticeConnect, makeNoticeRecipients, makeNoticeStoreDeps } from './noticeWiring.js';

/** Default loopback port of the local API (orch 47900, queue 47910-47911); the kit walks up when it is taken. */
export const DEFAULT_DAEMON_PORT = 47920;
/** Default port of the peer listener, the only non-loopback listener of the daemon (hard rule 1). */
export const DEFAULT_PEER_PORT = 47921;
export const DEFAULT_PEER_HOST = '0.0.0.0';

/** How long the loaded network (registrations, revocations, policy) is reused: bounds how late a revocation takes effect. */
const NETWORK_CACHE_SECONDS = 5;

export interface DaemonStart {
  /** Loopback port of the local API. */
  port?: number;
  version: string;
  peerPort?: number;
  peerHost?: string;
  /** Receives everything the daemon wants an admin to see (rejected connections, bookkeeping failures). */
  log?: (line: string) => void;
  /**
   * `--advertise`: where peers can reach this machine, REPLACING the interface discovery (NAT, a hostname, a VPN). Without a port the
   * port of the peer listener is used. Only meaningful with a relay: without relay.json the daemon says it has no effect.
   */
  advertise?: AdvertiseSpec[];
  /** Tests only: the network interfaces (default: os.networkInterfaces). */
  interfaces?: InterfaceProvider;
  /** Tests only: the timer and the client of the inbox loop, which runs only when this machine joined a relay (relay.json). */
  inbox?: { timer?: InboxTimer; client?: RelayClient; heartbeatMs?: number };
  /** Tests only: let the notice sender reach a recipient on loopback (a record of the relay may not point there). */
  notices?: { allowLocal?: boolean };
  /** Tests only: the update manager, the bundle path and the periodic timer of the update check. */
  updates?: DaemonUpdates;
  /** Tests only: replaces the registration of the module with app-core (the default one writes into the real app-core folder). */
  register?: (options: RegisterOnStartOptions) => Promise<void>;
}

export interface RunningDaemon {
  port: number;
  peerPort: number;
  stop: () => Promise<void>;
  stopped: Promise<void>;
  /** The loop that reads the documents the admin sends through the relay; absent when this machine has no relay.json. */
  inbox: InboxLoop | undefined;
}

/**
 * Start the daemon in the current process (orch supervises it as a foreground job). Fails loudly when the machine has
 * no identity: a daemon that starts anyway would restart-loop under orch with nothing to say.
 *
 * Order matters: the kit daemon starts FIRST because it evicts a previous daemon of the same config directory; only
 * then are the audit log opened and the peer port bound, so a restart or an update finds both free.
 */
export async function startMachineDaemon(configDir: string, options: DaemonStart): Promise<RunningDaemon> {
  let self;
  try {
    self = readMachine(configDir);
  } catch (e) {
    if (e instanceof NotInitializedError) throw new Error(`cannot start the daemon: ${e.message}`);
    throw e;
  }
  const log = options.log ?? ((line: string) => process.stderr.write(`[machine] ${line}\n`));
  const now = () => Math.floor(Date.now() / 1000);

  // The requests held for approval (`run --wait`): in memory, shared by the peer service and the `deny` command of the local API.
  const holds = new HoldTable();
  let listener: ServicedPeerListener | undefined;
  let inbox: InboxLoop | undefined;
  let updateCheck: { stop: () => void } | undefined;
  let notifier: RequestNotifier | undefined;
  let markStopped: () => void = () => undefined;
  const onProcessExit = () => removeDaemonPortFile(configDir, process.pid);
  const stopped = new Promise<void>((resolve) => (markStopped = resolve));
  const handle: DaemonHandle = await createDaemon({
    hooks: {
      onShutdown: () => {
        updateCheck?.stop();
        notifier?.close();
        inbox?.stop();
        listener?.close();
        removeDaemonPortFile(configDir, process.pid);
        process.removeListener('exit', onProcessExit);
        markStopped();
      },
    },
    configDir,
    commands: makeCommands(configDir, options.version, undefined, holds),
    port: options.port ?? DEFAULT_DAEMON_PORT,
    // A machine daemon runs until it is told to stop: peers must be able to reach it at any time.
    idleTimeout: null,
    appVersion: options.version,
  });

  try {
    // The audit log refuses to open when it was tampered with: the daemon does not start on a broken log.
    const audit = new FileAuditLog(join(configDir, 'audit.log'));
    const usage = new FileUsageStore(join(configDir, 'usage.json'));

    let cached: { at: number; network: Network; policyKey: string } | undefined;
    const network = (): Network => {
      // A change of the policy files (`machine policy allow`, `delegate`, `admin allow` on this machine) applies at once, not after the cache delay.
      const policyKey = policyFingerprint(configDir);
      if (!cached || cached.policyKey !== policyKey || now() - cached.at >= NETWORK_CACHE_SECONDS) {
        const loaded = loadNetwork(configDir, now());
        for (const problem of loaded.problems) if (!cached || !cached.network.problems.includes(problem)) log(`network: ${problem}`);
        cached = { at: now(), network: loaded, policyKey };
      }
      return cached.network;
    };
    // Load once now so that a corrupt file stops the start instead of the first connection.
    network();

    // Request notices (request-notices.md): told to the recipients of the signed list, best effort, over the same connection path as `machine run`.
    notifier = createRequestNotifier({
      self: { uuid: self.uuid, name: self.name },
      recipients: makeNoticeRecipients(configDir),
      peerOf: (uuid) => network().directory.find(uuid),
      connect: makeNoticeConnect(configDir, self, now, options.notices?.allowLocal === true),
      audit: (entry) => audit.write({ ts: new Date(now() * 1000).toISOString(), ...entry }),
      problem: log,
      now,
    });

    listener = await startPeerListener(
      {
        self,
        directory: { lookup: (key) => network().directory.lookup(key) },
        policy: () => network().policy,
        policyMode: () => network().policyMode,
        usage,
        audit,
        now,
        revocation: {
          state: () => revocationState(configDir),
          // A list that was installed must take effect now, not after the cache delay: D must not connect right after C learned of it.
          install: (signed) => {
            const result = installRevocation(configDir, signed, { now: now() });
            cached = undefined;
            return result;
          },
          seen: (peerUuid, announced) => recordRevocationSeen(configDir, peerUuid, announced, now(), (warning) => log(`revocation: ${warning}`)),
        },
        // The read-only `requests-list` exchange (decision 74): signed by the admin, answered from this machine's audit.log.
        requests: makeRequestsListDeps(configDir, now, log),
        holds: { table: holds, onChange: () => inbox?.holdChanged() },
        notices: makeNoticeStoreDeps(configDir),
        notifier,
        // A machine of the notice-recipients list may refuse a held request (decision 85).
        remoteDeny: { recipients: makeNoticeRecipients(configDir) },
        onConnectionRejected: (reason) => log(`connection refused: ${reason}`),
        onProblem: log,
      },
      { host: options.peerHost ?? DEFAULT_PEER_HOST, port: options.peerPort ?? DEFAULT_PEER_PORT },
    );
    // Last step: the file means "everything is up". A failure here stops the daemon (below) instead of leaving it half alive.
    writeDaemonPortFile(configDir, { pid: process.pid, port: handle.port, peerPort: listener.port });
    // Updates: the state a previous updater left, the loop guard, a check now and every 30 minutes. A problem there is a log line, never a stop.
    updateCheck = startUpdates(configDir, options.version, options.updates, log);
    // The admin page module is offered to app-core after the daemon is up. Never awaited, never a stop: a failure is a log line.
    // A development build does not register (it would stage a repo build into the real app-core): it says so instead of staying silent.
    if (options.register !== undefined || isReleaseVersion(options.version)) {
      void (options.register ?? registerOnStart)({
        packageRoot: dirname(fileURLToPath(import.meta.url)),
        machineConfigDir: configDir,
        moduleStamp: options.version,
        log,
      }).catch((e: unknown) => log(`app-core registration failed: ${(e as Error).message}`));
    } else {
      log(`app-core registration skipped: ${options.version} is a development build, not an installed release`);
    }
    // A machine that joined a relay sends its heartbeat and reads the documents of the admin; one that did not, never calls any relay.
    // A corrupt relay.json stops the start here, like every other corrupt file.
    const relayConfig = readRelayConfig(configDir);
    if (relayConfig === undefined && (options.advertise?.length ?? 0) > 0) {
      log('--advertise has no effect: this machine has not joined a relay (no relay.json), so no address record is published. Run `machine join <relay>`, or use `machine run <machine> --address <host:port>` between machines');
    }
    if (relayConfig !== undefined) {
      const client = options.inbox?.client ?? createRelayClient({ baseUrl: relayConfig.relayUrl, token: relayConfig.token });
      const peerPort = listener.port;
      // One timer: the inbox loop calls the publisher at the start of every heartbeat round.
      const publisher = createAddressPublisher({
        configDir,
        self,
        client,
        now,
        log: (line) => log(line),
        addresses: () =>
          resolveAdvertised({
            advertise: options.advertise ?? [],
            port: peerPort,
            ...(options.peerHost !== undefined ? { peerHost: options.peerHost } : {}),
            ...(options.interfaces ? { provider: options.interfaces } : {}),
          }),
        isEnrolled: () => existsSync(adminPinFile(configDir)),
      });
      inbox = startInboxLoop({
        configDir,
        self,
        client,
        audit,
        now,
        publisher,
        // A revocation installed from the inbox takes effect now: no cache delay, and the open sessions of the revoked peer are closed.
        onRevocationInstalled: () => {
          cached = undefined;
          listener?.revalidate();
        },
        // A new peer or a new policy applies at once too: `machine run` right after `machine admin allow` must not be refused by a cache.
        onInstalled: () => {
          cached = undefined;
        },
        log: (line) => log(line),
        // Decision 70: no policy yet (mode admin: it comes through this very inbox) -> the inbox is read every 10 s for the first 5 minutes.
        needsPolicy: () => {
          const network = loadNetwork(configDir, now());
          return network.enrolled && network.policyMode === 'admin' && network.policy === undefined;
        },
        // Hold-for-approval: while a request is held the inbox is read every 5 s, so an Allow from the admin applies quickly.
        holdActive: () => holds.list().length > 0,
        ...(options.inbox?.timer ? { timer: options.inbox.timer } : {}),
        ...(options.inbox?.heartbeatMs !== undefined ? { heartbeatMs: options.inbox.heartbeatMs } : {}),
      });
    }
  } catch (e) {
    await handle.stop('error');
    throw e;
  }
  // Last resort for a process that ends without going through stop (uncaught error): never leave a file that names a dead pid.
  process.once('exit', onProcessExit);
  return { port: handle.port, peerPort: listener.port, stop: () => Promise.resolve(handle.stop('command')), stopped, inbox };
}
