// Pure parts of `machine ping` (no I/O): the number of rounds and the statistics of the timings.

/** One round opens one connection to the peer (a handshake and a hello), one second apart: ten is plenty to see a trend and cannot flood a peer. */
export const MAX_PING_COUNT = 10;

export type PingCount = { ok: true; count: number } | { ok: false; message: string };

/** `--count`: a whole number from 1 to MAX_PING_COUNT, 1 when absent. Anything else is refused with the range, never clamped. */
export function parsePingCount(text: string | undefined): PingCount {
  if (text === undefined) return { ok: true, count: 1 };
  if (!/^\d+$/.test(text)) return { ok: false, message: `--count must be a whole number from 1 to ${MAX_PING_COUNT}, got "${text}"` };
  const count = Number(text);
  if (count < 1 || count > MAX_PING_COUNT) return { ok: false, message: `--count must be a whole number from 1 to ${MAX_PING_COUNT}, got "${text}"` };
  return { ok: true, count };
}

export interface SampleSummary {
  count: number;
  min: number;
  avg: number;
  max: number;
}

const tenth = (x: number): number => Math.round(x * 10) / 10;

/** Minimum, average and maximum of timings in milliseconds, to a tenth. An empty list or a bad sample is an error: no invented zero. */
export function summarizeSamples(samples: readonly number[]): SampleSummary {
  if (samples.length === 0) throw new Error('summarizeSamples: no sample to summarize');
  for (const s of samples) {
    if (!Number.isFinite(s) || s < 0) throw new Error(`summarizeSamples: a sample must be a finite number of milliseconds >= 0, got ${String(s)}`);
  }
  const sum = samples.reduce((a, b) => a + b, 0);
  return { count: samples.length, min: tenth(Math.min(...samples)), avg: tenth(sum / samples.length), max: tenth(Math.max(...samples)) };
}
