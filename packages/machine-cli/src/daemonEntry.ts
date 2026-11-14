import { createDaemon, type DaemonHandle } from '@wadeck-app/singleton-daemon-kit';
import { makeCommands } from './commands.js';
import { NotInitializedError } from './errors.js';
import { readMachine } from './identity.js';

/** Default loopback port of the local API (orch 47900, queue 47910-47911); the kit walks up when it is taken. */
export const DEFAULT_DAEMON_PORT = 47920;

export interface DaemonStart {
  port?: number;
  version: string;
}

/**
 * Start the daemon in the current process (orch supervises it as a foreground job). Fails loudly when the machine has
 * no identity: a daemon that starts anyway would restart-loop under orch with nothing to say.
 */
export async function startMachineDaemon(configDir: string, options: DaemonStart): Promise<{ port: number; stop: () => Promise<void>; stopped: Promise<void> }> {
  try {
    readMachine(configDir);
  } catch (e) {
    if (e instanceof NotInitializedError) throw new Error(`cannot start the daemon: ${e.message}`);
    throw e;
  }
  let markStopped: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => (markStopped = resolve));
  const handle: DaemonHandle = await createDaemon({
    hooks: { onShutdown: () => markStopped() },
    configDir,
    commands: makeCommands(configDir, options.version),
    port: options.port ?? DEFAULT_DAEMON_PORT,
    // A machine daemon runs until it is told to stop: peers must be able to reach it at any time.
    idleTimeout: null,
    appVersion: options.version,
  });
  return { port: handle.port, stop: () => Promise.resolve(handle.stop('command')), stopped };
}
