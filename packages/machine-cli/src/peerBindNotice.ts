import { hostClass } from '@wadeck-app/machine-core';

export interface PeerBindNotice {
  /** The host the peer listener is bound to, as printed in the startup line. */
  host: string;
  /** One `[warn]` line, present only when the listener is reachable beyond this machine by default (no explicit --peer-host). */
  warning?: string;
}

const unbracket = (host: string): string => (host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host);

/**
 * What the daemon says at startup about where its peer listener is bound. The default bind (every interface) is kept, but never silent:
 * without an explicit `--peer-host` and off loopback, a warning names the exposure, the protection and the exact fix.
 */
export function peerBindNotice(o: { host: string; explicit: boolean }): PeerBindNotice {
  if (o.explicit || hostClass(unbracket(o.host)) === 'loopback') {
    return { host: o.host };
  }
  return {
    host: o.host,
    warning:
      `[warn] the peer listener is bound to ${o.host} (the default): it is reachable on every interface of this machine. ` +
      'Only registered machines get a session (TLS 1.3, mutual, each side pinned to the other key), but to expose one interface only, ' +
      'restart the daemon with `--peer-host <address>` (the address of that interface).',
  };
}
