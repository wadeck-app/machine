import { describe, expect, it } from 'vitest';
import { planWakeSteps, type ConnectFailureKind } from './wake.js';
import { runWakeSequence, type SentStep, type WakeEvent, type WakeSequenceDeps, type WakeSequenceOptions } from './wakeSequence.js';

/** A clock that only moves when the code sleeps or a fake connection says it took time. */
function harness(options: { upAtMs?: number; connectCostMs?: number; failure?: ConnectFailureKind[]; afterUp?: ConnectFailureKind[]; daemonAtMs?: number } = {}) {
  let t = 0;
  const log = { sends: [] as Array<{ n: number; method: string; at: number }>, connects: [] as number[], refreshes: [] as number[], events: [] as WakeEvent[], sleeps: [] as number[] };
  const failure = options.failure ?? ['unreachable'];
  const deps: WakeSequenceDeps<string> = {
    nowMs: () => t,
    sleep: async (ms) => {
      log.sleeps.push(ms);
      t += ms;
    },
    connect: async () => {
      log.connects.push(t);
      t += options.connectCostMs ?? 0;
      if (options.upAtMs !== undefined && t >= options.upAtMs) {
        if (options.afterUp && !(options.daemonAtMs !== undefined && t >= options.daemonAtMs)) throw Object.assign(new Error('after up'), { kinds: options.afterUp });
        return 'connected';
      }
      throw Object.assign(new Error('down'), { kinds: failure });
    },
    kindsOf: (e) => (e as { kinds: ConnectFailureKind[] }).kinds,
    send: async (step: SentStep) => {
      log.sends.push({ n: step.n, method: step.method, at: t });
    },
    refresh: async () => {
      log.refreshes.push(t);
    },
    say: (e) => log.events.push(e),
  };
  return { deps, log, now: () => t };
}

const plan = (over: Partial<Parameters<typeof planWakeSteps>[0]> = {}) => planWakeSteps({ canUnicast: true, maxUnicast: 4, maxBroadcast: 4, probeMs: 5000, waitMs: 90_000, ...over });
const options = (over: Partial<WakeSequenceOptions> = {}): WakeSequenceOptions => ({ waitMs: 90_000, steps: plan(), attemptIntervalMs: 1000, refreshEveryMs: 10_000, ...over });

describe('runWakeSequence', () => {
  it('sends broadcast first, probes the connection, then unicast, probes again, alternating', async () => {
    const h = harness({ connectCostMs: 1000 });
    await runWakeSequence(h.deps, options());
    expect(h.log.sends.map((s) => `${s.method}@${s.at}`)).toEqual(['broadcast@0', 'unicast@5000', 'broadcast@10000', 'unicast@15000', 'broadcast@20000', 'unicast@25000', 'broadcast@30000', 'unicast@35000']);
  });

  it('probes the connection between two packets: several attempts, about one per second', async () => {
    const h = harness({ connectCostMs: 1000 });
    await runWakeSequence(h.deps, options());
    const betweenFirstTwo = h.log.connects.filter((at) => at < 5000);
    expect(betweenFirstTwo).toEqual([0, 1000, 2000, 3000, 4000]);
  });

  it('answers as soon as the peer is up, stops sending, and says which packet it followed', async () => {
    const h = harness({ upAtMs: 12_000, connectCostMs: 1000 });
    const r = await runWakeSequence(h.deps, options());
    expect(r.outcome).toBe('answered');
    if (r.outcome === 'answered') {
      expect(r.value).toBe('connected');
      expect(r.packets).toBe(3);
      expect(r.lastStep).toEqual({ n: 3, method: 'broadcast', atMs: 10_000 });
      expect(r.elapsedMs).toBe(12_000);
    }
    expect(h.log.sends.length).toBe(3);
  });

  it('success right after the first (broadcast) packet stops at once: no unicast is ever sent', async () => {
    const h = harness({ upAtMs: 1000, connectCostMs: 1000 });
    const r = await runWakeSequence(h.deps, options());
    expect(r.outcome).toBe('answered');
    expect(h.log.sends.map((s) => s.method)).toEqual(['broadcast']);
  });

  it('never sends more than 4 unicast and 4 broadcast packets, then keeps probing until the budget is used', async () => {
    const h = harness({ connectCostMs: 1000 });
    const r = await runWakeSequence(h.deps, options());
    expect(r.outcome).toBe('no-answer');
    if (r.outcome === 'no-answer') {
      expect(r.packets).toBe(8);
      expect(r.elapsedMs).toBeGreaterThanOrEqual(90_000);
      expect(r.elapsedMs).toBeLessThan(92_000);
      expect(r.lastError).toBeInstanceOf(Error);
    }
    expect(h.log.sends.length).toBe(8);
    expect(h.log.sends.filter((s) => s.method === 'unicast').length).toBe(4);
    expect(h.log.sends.filter((s) => s.method === 'broadcast').length).toBe(4);
    // Probing went on after the last packet.
    expect(h.log.connects.some((at) => at > 60_000)).toBe(true);
  });

  it('emits one event per packet for the person to read', async () => {
    const h = harness({ upAtMs: 12_000, connectCostMs: 1000 });
    await runWakeSequence(h.deps, options());
    expect(h.log.events).toEqual([
      { type: 'packet', n: 1, total: 8, method: 'broadcast', elapsedMs: 0 },
      { type: 'packet', n: 2, total: 8, method: 'unicast', elapsedMs: 5000 },
      { type: 'packet', n: 3, total: 8, method: 'broadcast', elapsedMs: 10_000 },
    ]);
  });

  it('broadcast only when there is no address to unicast to', async () => {
    const h = harness({ connectCostMs: 1000 });
    await runWakeSequence(h.deps, options({ steps: plan({ canUnicast: false }) }));
    expect(h.log.sends.map((s) => s.method)).toEqual(['broadcast', 'broadcast', 'broadcast', 'broadcast']);
  });

  it('stops at once, sending nothing more, when a retry fails for another reason than unreachable (authentication, pin, protocol)', async () => {
    const h = harness({ upAtMs: 6000, connectCostMs: 1000, afterUp: ['auth-closed'] });
    const r = await runWakeSequence(h.deps, options());
    expect(r.outcome).toBe('aborted');
    if (r.outcome === 'aborted') {
      expect(r.kinds).toEqual(['auth-closed']);
      expect(r.packets).toBe(2);
    }
    expect(h.log.sends.length).toBe(2);
  });

  it('a refusal while waiting (the host resumed, no daemon yet): no packet after it, but the probes go on until the budget is used, then it ends as refused', async () => {
    const h = harness({ upAtMs: 6000, connectCostMs: 1000, afterUp: ['refused'] });
    const r = await runWakeSequence(h.deps, options());
    expect(r.outcome).toBe('refused');
    if (r.outcome === 'refused') {
      expect(r.packets).toBe(2);
      expect(r.elapsedMs).toBeGreaterThanOrEqual(90_000);
      expect(r.awakeAtMs).toBe(6000);
    }
    expect(h.log.sends.length).toBe(2);
    expect(h.log.connects.filter((at) => at > 10_000).length).toBeGreaterThan(50);
  });

  it('a daemon that starts a few seconds after the refusal is a success, and the answer says when the host was first seen awake', async () => {
    const h = harness({ upAtMs: 6000, connectCostMs: 1000, afterUp: ['refused'], daemonAtMs: 20_000 });
    const r = await runWakeSequence(h.deps, options());
    expect(r.outcome).toBe('answered');
    if (r.outcome === 'answered') {
      expect(r.awakeAtMs).toBe(6000);
      expect(r.packets).toBe(2);
      expect(r.elapsedMs).toBeLessThan(25_000);
    }
    expect(h.log.sends.length).toBe(2);
  });

  it('an answer without any refusal has no awake time', async () => {
    const h = harness({ upAtMs: 6000, connectCostMs: 1000 });
    const r = await runWakeSequence(h.deps, options());
    expect(r.outcome === 'answered' && r.awakeAtMs).toBeUndefined();
  });

  it('sends no packet during a cooldown (no steps) and still probes until the deadline', async () => {
    const h = harness({ connectCostMs: 1000 });
    const r = await runWakeSequence(h.deps, options({ steps: [] }));
    expect(r.outcome).toBe('no-answer');
    if (r.outcome === 'no-answer') expect(r.packets).toBe(0);
    expect(h.log.sends).toEqual([]);
    expect(h.log.connects.length).toBeGreaterThan(50);
  });

  it('answers without a packet when the peer comes up during a cooldown', async () => {
    const h = harness({ upAtMs: 10_000, connectCostMs: 1000 });
    const r = await runWakeSequence(h.deps, options({ steps: [] }));
    expect(r.outcome).toBe('answered');
    if (r.outcome === 'answered') expect(r.lastStep).toBeUndefined();
    expect(h.log.sends).toEqual([]);
  });

  it('a failing send ends the sequence loudly: nothing was sent, so waiting would mislead', async () => {
    const h = harness();
    h.deps.send = async () => {
      throw new Error('EACCES: permission denied');
    };
    const r = await runWakeSequence(h.deps, options());
    expect(r.outcome).toBe('send-failed');
    if (r.outcome === 'send-failed') {
      expect(r.error.message).toMatch(/EACCES/);
      expect(r.packets).toBe(0);
    }
  });

  it('honours a short budget and a per-peer window: 12 s with a 10 s window sends two packets', async () => {
    const h = harness({ connectCostMs: 1000 });
    const r = await runWakeSequence(h.deps, options({ waitMs: 12_000, steps: plan({ probeMs: 10_000, waitMs: 12_000 }) }));
    expect(r.outcome).toBe('no-answer');
    expect(h.log.sends.map((s) => `${s.method}@${s.at}`)).toEqual(['broadcast@0', 'unicast@10000']);
  });

  it('does not spin: a connection that fails instantly is retried at most once per interval', async () => {
    const h = harness({ connectCostMs: 0 });
    await runWakeSequence(h.deps, options());
    expect(h.log.connects.length).toBeLessThanOrEqual(100);
    expect(h.log.sleeps.every((ms) => ms > 0 && ms <= 1000)).toBe(true);
  });

  it('uses the attempt interval of the peer', async () => {
    const h = harness({ connectCostMs: 0 });
    await runWakeSequence(h.deps, options({ attemptIntervalMs: 2500, waitMs: 20_000, steps: plan({ waitMs: 20_000 }) }));
    expect(h.log.connects.filter((at) => at < 5000)).toEqual([0, 2500]);
  });

  it('asks for a fresh address about every 10 s (the address can change after a resume)', async () => {
    const h = harness({ connectCostMs: 1000 });
    await runWakeSequence(h.deps, options());
    expect(h.log.refreshes.length).toBeGreaterThanOrEqual(8);
    expect(h.log.refreshes.length).toBeLessThanOrEqual(10);
    for (let i = 1; i < h.log.refreshes.length; i++) expect((h.log.refreshes[i] as number) - (h.log.refreshes[i - 1] as number)).toBeGreaterThanOrEqual(10_000);
  });

  it('works without a refresh function', async () => {
    const h = harness({ upAtMs: 4000 });
    delete h.deps.refresh;
    const r = await runWakeSequence(h.deps, options());
    expect(r.outcome).toBe('answered');
  });

  it('a timeout is as wakeable as unreachable while waiting: the sequence keeps going', async () => {
    const h = harness({ failure: ['timeout', 'unreachable'], connectCostMs: 1000 });
    const r = await runWakeSequence(h.deps, options());
    expect(r.outcome).toBe('no-answer');
  });


  it('packet 1 already sent by the caller (hedge): it is counted, not sent again, and the probe window of packet 2 counts from the moment packet 1 left', async () => {
    const h = harness({ upAtMs: 9000, connectCostMs: 500 });
    // The caller sent packet 1 at fake time 0 and its first attempt failed at 500 ms: the sequence starts at 500 ms, packet 1 left at 0.
    await h.deps.sleep(500);
    const r = await runWakeSequence(h.deps, options({ firstSent: { atMs: 0 } }));
    // Packet 2 is due 5000 ms after packet 1 (t = 5000), not 5000 ms after the call.
    expect(h.log.sends.map((s) => `${s.n}:${s.method}@${s.at}`)).toEqual(['2:unicast@5000']);
    expect(h.log.events.map((e) => e.n)).toEqual([2]);
    expect(r.outcome).toBe('answered');
    if (r.outcome === 'answered') {
      expect(r.packets).toBe(2);
      expect(r.lastStep).toMatchObject({ n: 2, method: 'unicast' });
    }
  });

  it('packet 1 already sent: the limits still apply (never more packets than planned)', async () => {
    const h = harness({ connectCostMs: 1000 });
    const r = await runWakeSequence(h.deps, options({ firstSent: { atMs: 0 }, steps: plan({ maxUnicast: 0, maxBroadcast: 2 }) }));
    expect(h.log.sends.length).toBe(1);
    expect(r.packets).toBe(2);
  });
});
