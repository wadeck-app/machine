import { join } from 'node:path';
import { createDaemon, type DaemonHandle } from '@wadeck-app/singleton-daemon-kit';
import { makeCommands } from './commands.js';
import { NotInitializedError } from './errors.js';
import { readMachine } from './identity.js';
import { loadNetwork, type Network } from './network.js';
import { startPeerListener } from './peerService.js';
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
}

export interface RunningDaemon {
  port: number;
  peerPort: number;
  stop: () => Promise<void>;
  stopped: Promise<void>;
}

/**
 * Start the daemon in the current process (orch supervises it as a foreground job). Fails loudly when the machine has
 * no identity: a daemon that starts anyway would restart-loop under orch with nothing to say.
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

  const listener = await startPeerListener(
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

  let markStopped: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => (markStopped = resolve));
  let handle: DaemonHandle;
  try {
    handle = await createDaemon({
      hooks: {
        onShutdown: () => {
          listener.close();
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
  } catch (e) {
    listener.close();
    throw e;
  }
  return { port: handle.port, peerPort: listener.port, stop: () => Promise.resolve(handle.stop('command')), stopped };
}
