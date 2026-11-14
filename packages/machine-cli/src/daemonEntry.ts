import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createDaemon, type DaemonHandle } from '@wadeck-app/singleton-daemon-kit';
import type { PeerListener } from '@wadeck-app/machine-transport';
import { adminPinFile } from './admin.js';
import { resolveAdvertised, type AdvertiseSpec, type InterfaceProvider } from './addressDiscovery.js';
import { createAddressPublisher } from './addressPublisher.js';
import { makeCommands } from './commands.js';
import { NotInitializedError } from './errors.js';
import { readMachine } from './identity.js';
import { loadNetwork, type Network } from './network.js';
import { startInboxLoop, type InboxLoop, type InboxTimer } from './inboxLoop.js';
import { startPeerListener } from './peerService.js';
import { createRelayClient, type RelayClient } from './relayClient.js';
import { readRelayConfig } from './relayStore.js';
import { removeDaemonPortFile, writeDaemonPortFile } from './daemonPortFile.js';
import { FileAuditLog, FileUsageStore } from './stores.js';

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

  let listener: PeerListener | undefined;
  let inbox: InboxLoop | undefined;
  let markStopped: () => void = () => undefined;
  const onProcessExit = () => removeDaemonPortFile(configDir, process.pid);
  const stopped = new Promise<void>((resolve) => (markStopped = resolve));
  const handle: DaemonHandle = await createDaemon({
    hooks: {
      onShutdown: () => {
        inbox?.stop();
        listener?.close();
        removeDaemonPortFile(configDir, process.pid);
        process.removeListener('exit', onProcessExit);
        markStopped();
      },
    },
    configDir,
    commands: makeCommands(configDir, options.version),
    port: options.port ?? DEFAULT_DAEMON_PORT,
    // A machine daemon runs until it is told to stop: peers must be able to reach it at any time.
    idleTimeout: null,
    appVersion: options.version,
  });

  try {
    // The audit log refuses to open when it was tampered with: the daemon does not start on a broken log.
    const audit = new FileAuditLog(join(configDir, 'audit.log'));
    const usage = new FileUsageStore(join(configDir, 'usage.json'));

    let cached: { at: number; network: Network } | undefined;
    const network = (): Network => {
      if (!cached || now() - cached.at >= NETWORK_CACHE_SECONDS) {
        const loaded = loadNetwork(configDir, now());
        for (const problem of loaded.problems) if (!cached || !cached.network.problems.includes(problem)) log(`network: ${problem}`);
        cached = { at: now(), network: loaded };
      }
      return cached.network;
    };
    // Load once now so that a corrupt file stops the start instead of the first connection.
    network();

    listener = await startPeerListener(
      {
        self,
        directory: { lookup: (key) => network().directory.lookup(key) },
        policy: () => network().policy,
        usage,
        audit,
        now,
        onConnectionRejected: (reason) => log(`connection refused: ${reason}`),
        onProblem: log,
      },
      { host: options.peerHost ?? DEFAULT_PEER_HOST, port: options.peerPort ?? DEFAULT_PEER_PORT },
    );
    // Last step: the file means "everything is up". A failure here stops the daemon (below) instead of leaving it half alive.
    writeDaemonPortFile(configDir, { pid: process.pid, port: handle.port, peerPort: listener.port });
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
        log: (line) => log(line),
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
