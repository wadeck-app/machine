// Whether the admin machine can reach a peer DIRECTLY now (decision 86). Only the words live here, so the CLI, the daemon answer and the pages say the same
// thing. The facts come from a probe of the daemon (an authenticated handshake with the peer); this module reads nothing and opens nothing.

export type Reachable =
  | { state: 'direct'; /** Duration of the authenticated handshake. */ ms: number; /** Epoch seconds of the check. */ checkedAt: number }
  | { state: 'not-direct'; checkedAt: number; /** Epoch seconds of the last direct contact (probe or handshake), when there was one. */ lastSeenAt?: number; /** Why the last probe failed (bounded printable text). */ cause?: string }
  | { state: 'unknown' };

function age(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s <= 120) {
    return `${s} s`;
  }
  if (s < 2 * 3600) {
    return `${Math.round(s / 60)} min`;
  }
  if (s < 48 * 3600) {
    return `${Math.round(s / 3600)} h`;
  }
  return `${Math.round(s / 86_400)} days`;
}

/** `direct now (12 ms, checked 8 s ago)`, `not reachable directly (last seen 2 h ago; relay inbox only)`, `unknown`. */
export function reachableText(r: Reachable, now: number): string {
  if (r.state === 'direct') {
    return `direct now (${r.ms} ms, checked ${age(now - r.checkedAt)} ago)`;
  }
  if (r.state === 'not-direct') {
    const seen = r.lastSeenAt === undefined ? 'never seen directly' : `last seen ${age(now - r.lastSeenAt)} ago`;
    return `not reachable directly (${seen}; relay inbox only)`;
  }
  return 'unknown';
}
