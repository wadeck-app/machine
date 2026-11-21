import { describe, expect, it } from 'vitest';
import { createReachabilityProbe, type ProbePeer } from './reachabilityProbe.js';

// The background probe of the admin daemon (decision 86): is each trusted machine reachable DIRECTLY now? Cheap, bounded, cached in memory,
// and running only while the page or the CLI asked recently.

const peer = (n: number, lastSeenAt?: number): ProbePeer => ({ peer: { peerId: `uuid-${n}`, name: `m${n}`, identityPublicKey: 'k', pairSecret: Buffer.alloc(32) }, ...(lastSeenAt === undefined ? {} : { lastSeenAt }) });

function world(over: { peers?: ProbePeer[]; connect?: (name: string) => Promise<void>; probeTimeoutMs?: number } = {}) {
  const clock = { ms: 0, seconds: 1_800_000_000 };
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 0;
  const closed: string[] = [];
  const state = { peers: over.peers ?? [peer(1), peer(2)], inFlight: 0, maxInFlight: 0, connects: [] as string[] };
  const probe = createReachabilityProbe({
    peers: () => state.peers,
    connect: async (p) => {
      state.connects.push(p.name);
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        clock.ms += 12;
        await (over.connect?.(p.name) ?? Promise.resolve());
        return { close: () => void closed.push(p.name) };
      } finally {
        state.inFlight--;
      }
    },
    now: () => clock.seconds,
    clock: () => clock.ms,
    timer: {
      set: (fn, ms) => {
        timers.set(++next, { fn, ms });
        return next;
      },
      clear: (h) => void timers.delete(h as number),
    },
    ...(over.probeTimeoutMs !== undefined ? { probeTimeoutMs: over.probeTimeoutMs } : {}),
  });
  return { probe, clock, timers, state, closed, fire: () => [...timers.values()].forEach((t) => (timers.clear(), t.fn())) };
}

describe('reachability probe', () => {
  it('starts as unknown for every trusted machine, then says direct with the time of the handshake', async () => {
    const w = world();
    const first = w.probe.ask();
    expect(first.machines.map((m) => [m.name, m.state])).toEqual([['m1', 'unknown'], ['m2', 'unknown']]);
    await w.probe.settled();
    const second = w.probe.ask();
    expect(second.machines[0]).toMatchObject({ uuid: 'uuid-1', name: 'm1', state: 'direct', ms: expect.any(Number), checkedAt: w.clock.seconds });
    expect((second.machines[0] as { ms: number }).ms).toBeGreaterThanOrEqual(12);
    // The probe only opens and closes the authenticated channel: nothing is sent.
    expect(w.closed.sort()).toEqual(['m1', 'm2']);
  });

  it('a failure is not-direct with the cause, and keeps the last time it was seen', async () => {
    let up = true;
    const w = world({
      connect: async () => {
        if (!up) {
          throw new Error('cannot reach 10.0.0.5:47921: connect timed out');
        }
      },
    });
    w.probe.ask();
    await w.probe.settled();
    const seenAt = w.clock.seconds;
    up = false;
    w.clock.seconds += 40;
    w.fire();
    await w.probe.settled();
    expect(w.probe.ask().machines[0]).toMatchObject({ state: 'not-direct', cause: expect.stringMatching(/connect timed out/), lastSeenAt: seenAt, checkedAt: w.clock.seconds });
  });

  it('a machine never reached by this probe uses the last handshake the daemon recorded as last seen', async () => {
    const w = world({ peers: [peer(1, 1_799_990_000)], connect: async () => Promise.reject(new Error('down')) });
    w.probe.ask();
    await w.probe.settled();
    expect(w.probe.ask().machines[0]).toMatchObject({ state: 'not-direct', lastSeenAt: 1_799_990_000 });
  });

  it('never runs more than 4 probes at once', async () => {
    const peers = Array.from({ length: 10 }, (_, i) => peer(i));
    const w = world({ peers, connect: () => new Promise((resolve) => setTimeout(resolve, 5)) });
    w.probe.ask();
    await w.probe.settled();
    expect(w.state.connects).toHaveLength(10);
    expect(w.state.maxInFlight).toBeLessThanOrEqual(4);
    expect(w.state.maxInFlight).toBeGreaterThan(1);
  });

  it('probes again every 30 s while it is being asked, and stops when nobody asked for 5 minutes', async () => {
    const w = world();
    w.probe.ask();
    await w.probe.settled();
    expect([...w.timers.values()].map((t) => t.ms)).toEqual([30_000]);
    // Asked again 20 s later: the page is still open.
    w.clock.ms += 20_000;
    w.probe.ask();
    w.fire();
    await w.probe.settled();
    expect(w.state.connects).toHaveLength(4);
    expect(w.timers.size).toBe(1);
    // Nobody asks for more than 5 minutes: the next tick probes nothing and schedules nothing.
    w.clock.ms += 6 * 60_000;
    w.fire();
    await w.probe.settled();
    expect(w.state.connects).toHaveLength(4);
    expect(w.timers.size).toBe(0);
    // Asked again: it starts again at once.
    w.probe.ask();
    await w.probe.settled();
    expect(w.state.connects).toHaveLength(6);
  });

  it('a machine that no longer is trusted leaves the answer and the memory', async () => {
    const w = world();
    w.probe.ask();
    await w.probe.settled();
    w.state.peers = [peer(1)];
    expect(w.probe.ask().machines.map((m) => m.name)).toEqual(['m1']);
  });

  it('a probe that never answers is not-direct after its timeout, and does not hold the others', async () => {
    const w = world({ probeTimeoutMs: 20, connect: (name) => (name === 'm1' ? new Promise(() => undefined) : Promise.resolve()) });
    w.probe.ask();
    await w.probe.settled();
    const answer = w.probe.ask();
    expect(answer.machines.find((m) => m.name === 'm1')).toMatchObject({ state: 'not-direct', cause: expect.stringMatching(/no handshake within 20 ms/) });
    expect(answer.machines.find((m) => m.name === 'm2')).toMatchObject({ state: 'direct' });
  });

  it('stop cancels the timer', async () => {
    const w = world();
    w.probe.ask();
    await w.probe.settled();
    w.probe.stop();
    expect(w.timers.size).toBe(0);
  });
});
