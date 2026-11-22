// Clock skew between two machines (decision 88). Pure: no clock is read here, the callers pass their own `now`.

/**
 * How long BEFORE its start a signed document may already be applied (epoch seconds). Two machines never agree on the second: the admin machine
 * dates a policy with its own clock (`notBefore` = the signing time) and the target compares it with its own, which can be a few seconds (or after a
 * suspend/resume, longer) behind. Without a leeway the first direct delivery after every signing was refused as `not-yet-valid`.
 * Only the not-yet-valid side: the expiry side is unchanged. The price is bounded and grants nothing: a document, already signed by the admin, can be
 * applied up to this long before the date it carries (threat-model.md, T-52).
 */
export const NOT_YET_VALID_LEEWAY_SECONDS = 120;

/** Above this skew the person is told (a `[warn]` line, a banner): below, two clocks that disagree by a few seconds are normal. */
export const CLOCK_SKEW_WARN_SECONDS = 30;

/** Seconds the peer's clock is ahead of the own one: negative means the peer is BEHIND. */
export function measuredSkew(peerNow: number, ownNow: number): number {
  return peerNow - ownNow;
}

/** `45 s`, `3 min 16 s`, `1 min`, `3 h 2 min`: at most two units. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) {
    return `${s} s`;
  }
  const m = Math.floor(s / 60);
  if (s < 3600) {
    return s % 60 === 0 ? `${m} min` : `${m} min ${s % 60} s`;
  }
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
}

const clock = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString().slice(11, 19);

/** How to fix a clock, for both families of machines (the admin cannot know which one the peer is). */
export const TIME_SYNC_FIX = 'Linux: `timedatectl status`, Windows: `w32tm /query /status`';

/** The sentence for a measured skew: which clock is behind, by how much, both times, the fix. */
export function describeClockSkew(peerName: string, peerNow: number, ownNow: number): string {
  const skew = measuredSkew(peerNow, ownNow);
  const side = skew < 0 ? `${formatDuration(-skew)} behind this machine` : `${formatDuration(skew)} ahead of this machine`;
  return `${peerName}'s clock is ${side} (its time ${clock(peerNow)}, this machine ${clock(ownNow)}): fix its time sync (${TIME_SYNC_FIX})`;
}

/** The sentence when `|skew|` is above the warning threshold, else undefined. A time that is absent (an older build) or not a whole number of seconds says nothing. */
export function clockSkewProblem(peerName: string, peerNow: unknown, ownNow: number): string | undefined {
  if (typeof peerNow !== 'number' || !Number.isSafeInteger(peerNow) || peerNow < 0) {
    return undefined;
  }
  return Math.abs(measuredSkew(peerNow, ownNow)) > CLOCK_SKEW_WARN_SECONDS ? describeClockSkew(peerName, peerNow, ownNow) : undefined;
}
