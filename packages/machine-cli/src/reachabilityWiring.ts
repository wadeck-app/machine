import { reachableText } from '@wadeck-app/machine-core';
import { readMachine } from './identity.js';
import { loadNetwork, readRevocationSeen } from './network.js';
import { makeNoticeConnect } from './noticeWiring.js';
import { createReachabilityProbe, type ReachabilityProbe, type ReachabilityEntry, type ReachabilitySnapshot } from './reachabilityProbe.js';

// What the daemon and the CLI plug into the reachability probe (decision 86): the trusted peers of this machine with the date of their last handshake, and the
// connection of `machine run` (pinned addresses, else the signed address record of the relay; never a wake).

export type ReachabilityAnswer = {
  initialized: true;
  intervalSeconds: number;
  /** Each entry says how it reads for a person (`text`), with the same words everywhere. */
  machines: Array<ReachabilityEntry & { text: string }>;
};

export function makeReachabilityProbe(configDir: string, now: () => number, options: { allowLocal?: boolean } = {}): ReachabilityProbe {
  const self = readMachine(configDir);
  return createReachabilityProbe({
    peers: () => {
      const network = loadNetwork(configDir, now());
      // A damaged file of last handshakes only costs the "last seen" of the answer.
      const seen = readRevocationSeen(configDir, () => undefined);
      return network.directory.machines().flatMap((m) => {
        const peer = network.directory.find(m.uuid);
        return peer === undefined ? [] : [{ peer, ...(seen[m.uuid] !== undefined ? { lastSeenAt: seen[m.uuid]?.at as number } : {}) }];
      });
    },
    connect: makeNoticeConnect(configDir, self, now, options.allowLocal === true),
    now,
    clock: () => performance.now(),
  });
}

export function answerOf(snapshot: ReachabilitySnapshot, now: number): ReachabilityAnswer {
  return { initialized: true, intervalSeconds: snapshot.intervalSeconds, machines: snapshot.machines.map((m) => ({ ...m, text: reachableText(m, now) })) };
}

/** The one-shot form (no daemon runs): probes every trusted machine once, waits for the answers (a few seconds at most) and forgets them. */
export async function reachabilityOnce(configDir: string, now: () => number, options: { allowLocal?: boolean } = {}): Promise<ReachabilityAnswer> {
  const probe = makeReachabilityProbe(configDir, now, options);
  try {
    probe.ask();
    await probe.settled();
    return answerOf(probe.ask(), now());
  } finally {
    probe.stop();
  }
}
