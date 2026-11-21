import type { Reachable } from '@wadeck-app/machine-core';
import { printable } from '@wadeck-app/machine-core';
import type { PeerToReach } from './peerConnect.js';

// The reachability probe of the admin daemon (decision 86): "can this machine reach each trusted peer DIRECTLY right now?" so that the pages and
// `machine list` can tell a machine that takes a document at once from one that only has the relay inbox. A probe is an authenticated handshake (TLS 1.3,
// key pinned, pair secret proven: what `machine ping --no-wake` opens) that is closed at once: nothing is sent, nothing is audited, nothing is woken.
// It runs only while somebody asked recently, every 30 s, at most 4 at a time, and keeps its results in memory for the trusted machines only.

export const PROBE_INTERVAL_MS = 30_000;
export const PROBE_MAX_CONCURRENT = 4;
/** The probe stops this long after the last question of a page or the CLI. */
export const PROBE_KEEP_ALIVE_MS = 5 * 60_000;
/** Lookup of the address and handshake, as a whole. */
export const PROBE_TIMEOUT_MS = 4000;
/** The trusted machines whose result is kept (a network of more than this is out of scope). */
export const PROBE_MAX_PEERS = 64;

export interface ProbePeer {
  peer: PeerToReach;
  /** Epoch seconds of the last handshake of that peer with this machine, as the daemon recorded it (revocation-seen.json), when known. */
  lastSeenAt?: number;
}

export interface ProbeTimer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface ReachabilityProbeDeps {
  /** The trusted peers now (the network is reloaded by the caller as it does for everything else). */
  peers: () => ProbePeer[];
  /** Opens the authenticated channel (the path of `machine run`, no wake). Rejects with a message that names the cause. */
  connect: (peer: PeerToReach) => Promise<{ close(): void }>;
  /** Epoch seconds. */
  now: () => number;
  /** Monotonic milliseconds. */
  clock: () => number;
  timer?: ProbeTimer;
  probeTimeoutMs?: number;
  intervalMs?: number;
  maxConcurrent?: number;
  keepAliveMs?: number;
}

export interface MachineReachability {
  uuid: string;
  name: string;
}

export type ReachabilityEntry = MachineReachability & Reachable;

export interface ReachabilitySnapshot {
  machines: ReachabilityEntry[];
  /** Seconds between two probes of a machine while somebody asks. */
  intervalSeconds: number;
}

export interface ReachabilityProbe {
  /** Marks that somebody wants the answer (starts the probing when it was idle) and returns what is known now; never waits for the network. */
  ask(): ReachabilitySnapshot;
  /** Resolves when the probing in progress (and its scheduling) is over. Tests, and the one-shot form of the CLI. */
  settled(): Promise<void>;
  stop(): void;
}

interface Cached {
  state: 'direct' | 'not-direct';
  ms?: number;
  checkedAt: number;
  lastOkAt?: number;
  cause?: string;
}

export function createReachabilityProbe(deps: ReachabilityProbeDeps): ReachabilityProbe {
  const timer: ProbeTimer = deps.timer ?? {
    set: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref();
      return handle;
    },
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const intervalMs = deps.intervalMs ?? PROBE_INTERVAL_MS;
  const maxConcurrent = deps.maxConcurrent ?? PROBE_MAX_CONCURRENT;
  const keepAliveMs = deps.keepAliveMs ?? PROBE_KEEP_ALIVE_MS;
  const probeTimeoutMs = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS;

  const cache = new Map<string, Cached>();
  let lastAskedMs: number | undefined;
  let handle: unknown;
  let running: Promise<void> | undefined;
  let stopped = false;

  const probeOne = async (entry: ProbePeer): Promise<void> => {
    const { peer } = entry;
    const started = deps.clock();
    let timeout: NodeJS.Timeout | undefined;
    let late = false;
    const limit = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        late = true;
        reject(new Error(`no handshake within ${probeTimeoutMs} ms`));
      }, probeTimeoutMs);
    });
    const connecting = deps.connect(peer);
    // A handshake that finishes after the limit is closed, never kept.
    connecting.then(
      (s) => {
        if (late) {
          s.close();
        }
      },
      () => undefined,
    );
    const before = cache.get(peer.peerId);
    try {
      const session = await Promise.race([connecting, limit]);
      session.close();
      cache.set(peer.peerId, { state: 'direct', ms: Math.max(0, Math.round(deps.clock() - started)), checkedAt: deps.now(), lastOkAt: deps.now() });
    } catch (e) {
      cache.set(peer.peerId, {
        state: 'not-direct',
        checkedAt: deps.now(),
        ...(before?.lastOkAt !== undefined ? { lastOkAt: before.lastOkAt } : {}),
        cause: printable((e as Error).message, 300),
      });
    } finally {
      clearTimeout(timeout);
    }
  };

  const round = async (): Promise<void> => {
    const peers = deps.peers().slice(0, PROBE_MAX_PEERS);
    const queue = [...peers];
    const worker = async (): Promise<void> => {
      for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
        await probeOne(entry);
      }
    };
    await Promise.all(Array.from({ length: Math.min(maxConcurrent, queue.length) }, worker));
  };

  const askedRecently = (): boolean => lastAskedMs !== undefined && deps.clock() - lastAskedMs < keepAliveMs;

  const start = (): void => {
    if (running !== undefined || stopped) {
      return;
    }
    running = (async () => {
      try {
        await round();
      } finally {
        running = undefined;
        // The next probe only while somebody still asks.
        if (!stopped && askedRecently()) {
          handle = timer.set(() => {
            handle = undefined;
            if (askedRecently()) {
              start();
            }
          }, intervalMs);
        }
      }
    })();
  };

  return {
    ask() {
      lastAskedMs = deps.clock();
      const peers = deps.peers().slice(0, PROBE_MAX_PEERS);
      // What is no longer trusted leaves the memory.
      const trusted = new Set(peers.map((p) => p.peer.peerId));
      for (const uuid of [...cache.keys()]) if (!trusted.has(uuid)) cache.delete(uuid);
      if (running === undefined && handle === undefined) {
        start();
      }
      return {
        intervalSeconds: Math.round(intervalMs / 1000),
        machines: peers.map(({ peer, lastSeenAt }): ReachabilityEntry => {
          const base = { uuid: peer.peerId, name: peer.name };
          const known = cache.get(peer.peerId);
          if (known === undefined) {
            return { ...base, state: 'unknown' };
          }
          if (known.state === 'direct') {
            return { ...base, state: 'direct', ms: known.ms ?? 0, checkedAt: known.checkedAt };
          }
          const seen = Math.max(known.lastOkAt ?? 0, lastSeenAt ?? 0);
          return { ...base, state: 'not-direct', checkedAt: known.checkedAt, ...(seen > 0 ? { lastSeenAt: seen } : {}), ...(known.cause !== undefined ? { cause: known.cause } : {}) };
        }),
      };
    },
    async settled() {
      // A round may schedule the next one: wait for the one in progress only.
      while (running !== undefined) await running;
    },
    stop() {
      stopped = true;
      if (handle !== undefined) {
        timer.clear(handle);
      }
      handle = undefined;
    },
  };
}
