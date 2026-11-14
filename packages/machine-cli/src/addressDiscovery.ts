import { isIPv4, isIPv6 } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { MAX_ADDRESSES, advertisedProblem, hostClass, hostProblem, type AddressEntry } from '@wadeck-app/machine-core';

// Which addresses the daemon publishes in its signed address record (relay-api.md, "Machines resource"). Discovery is a convenience for a
// plain LAN; `--advertise` replaces it for NAT, a hostname or a VPN. Nothing here is silent: an empty list comes with its reason.

export type InterfaceProvider = () => NodeJS.Dict<NetworkInterfaceInfo[]>;

/** `--advertise <host[:port]>` before the peer port is known: without a port, the port the peer listener ended up on is used. */
export interface AdvertiseSpec {
  host: string;
  port?: number;
}

const isIpv4LinkLocal = (address: string): boolean => address.startsWith('169.254.');
// fe80::/10 is fe80 to febf.
const isIpv6LinkLocal = (address: string): boolean => /^fe[89ab][0-9a-f]:/i.test(address);
const isUnspecified = (address: string): boolean => address === '::' || address === '0.0.0.0';

// Ordering heuristic, honestly: it looks at the NAME of the interface and at the RANGE of the address, nothing else (no route table is read, no
// adapter is identified). An interface whose name looks virtual (docker, veth, bridges, VM and VPN adapters) goes after the others; inside each
// group the private ranges (10/8, 172.16/12, 192.168/16, fc00::/7) go first, then the rest, each in the order the system lists them.
const VIRTUAL_NAME = /^(docker|veth|br-|virbr|vmnet|vboxnet|vethernet|lxc|lxd|cni|flannel|cali|kube|podman|tun|tap|utun|wg|zt|tailscale|ham|hyper-v)/i;
const isPrivateV4 = (a: string): boolean => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
const isPrivateV6 = (a: string): boolean => /^f[cd][0-9a-f]{2}:/i.test(a);

interface Candidate {
  host: string;
  virtual: boolean;
  priv: boolean;
  order: number;
}

export interface DiscoveryDetail {
  /** What is published: at most 8. */
  addresses: AddressEntry[];
  /** What was found and left out by the cap of 8, in the same order. */
  dropped: string[];
}

/** See `discoverAddresses`; also says what the cap of 8 dropped. */
export function discoverDetailed(port: number, provider: InterfaceProvider = networkInterfaces): DiscoveryDetail {
  const v4: Candidate[] = [];
  const v6: Candidate[] = [];
  let order = 0;
  for (const [name, infos] of Object.entries(provider())) {
    const virtual = VIRTUAL_NAME.test(name);
    for (const info of infos ?? []) {
      if (info.internal || isUnspecified(info.address)) continue;
      if (info.family === 'IPv4' && !isIpv4LinkLocal(info.address) && isIPv4(info.address)) v4.push({ host: info.address, virtual, priv: isPrivateV4(info.address), order: order++ });
      else if (info.family === 'IPv6' && !isIpv6LinkLocal(info.address) && isIPv6(info.address)) v6.push({ host: info.address, virtual, priv: isPrivateV6(info.address), order: order++ });
    }
  }
  const rank = (list: Candidate[]): string[] => [...list].sort((x, y) => Number(x.virtual) - Number(y.virtual) || Number(!x.priv) - Number(!y.priv) || x.order - y.order).map((c) => c.host);
  const unique = [...new Set([...rank(v4), ...rank(v6)])];
  return { addresses: unique.slice(0, MAX_ADDRESSES).map((host) => ({ host, port })), dropped: unique.slice(MAX_ADDRESSES) };
}

/**
 * The non-internal IPv4 then IPv6 addresses of this machine with `port`, at most 8 (see `discoverDetailed` for what the cap dropped).
 * Loopback, link-local (169.254/16, fe80::/10) and the unspecified address are left out; docker and virtual interfaces are NOT
 * filtered, they only come last (heuristic above). Use `--advertise` to choose.
 */
export function discoverAddresses(port: number, provider: InterfaceProvider = networkInterfaces): AddressEntry[] {
  return discoverDetailed(port, provider).addresses;
}

/** Validates the values of `--advertise` (repeatable). Throws an Error naming the option and the offending value. */
export function parseAdvertise(values: string[]): AdvertiseSpec[] {
  const out: AdvertiseSpec[] = [];
  const seen = new Set<string>();
  for (const text of values) {
    const refuse = (why: string): never => {
      throw new Error(`--advertise ${JSON.stringify(text)}: ${why}. Expected <host[:port]>, for example 203.0.113.9:50000, desktop.example.com or [2001:db8::1]:50000 (the peer port is used when no port is given)`);
    };
    let host: string;
    let portText: string | undefined;
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
    if (bracketed) {
      host = bracketed[1] as string;
      portText = bracketed[2];
      if (!isIPv6(host)) refuse('a bracketed host must be an IPv6 address');
    } else if (isIPv6(text)) {
      host = text;
    } else {
      const plain = /^([^:]+)(?::(\d+))?$/.exec(text);
      if (!plain) return refuse('not a host, host:port or IPv6 address');
      host = plain[1] as string;
      portText = plain[2];
    }
    const problem = hostProblem(host) ?? advertisedProblem(host);
    if (problem !== undefined) refuse(problem);
    let port: number | undefined;
    if (portText !== undefined) {
      port = Number(portText);
      if (!Number.isInteger(port) || port < 1 || port > 65535) refuse('the port must be a whole number from 1 to 65535');
    }
    const key = `${host.toLowerCase()}:${port ?? ''}`;
    if (seen.has(key)) refuse('the same address is given twice');
    seen.add(key);
    out.push({ host, ...(port !== undefined ? { port } : {}) });
  }
  if (out.length > MAX_ADDRESSES) throw new Error(`--advertise is given ${out.length} times: at most ${MAX_ADDRESSES} addresses fit in an address record`);
  return out;
}

export interface ResolveAdvertisedOptions {
  advertise: AdvertiseSpec[];
  /** The port the peer listener is actually on. */
  port: number;
  /** The address the peer listener is bound to (`--peer-host`); absent or a wildcard means every interface. */
  peerHost?: string;
  provider?: InterfaceProvider;
}

export interface AdvertisedAddresses {
  source: 'advertise' | 'bound-host' | 'discovered';
  addresses: AddressEntry[];
  /** Set when `addresses` is empty: what to tell the person. */
  problem?: string;
  /** Set when something was left out (the cap of 8): what to tell the person. */
  warning?: string;
}

// Classified on the normalized address (case, expanded IPv6, IPv4-mapped), never on the spelling.
const unbracket = (host: string): string => (host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host);
const isWildcard = (host: string): boolean => hostClass(unbracket(host)) === 'unspecified';
const isLoopbackHost = (host: string): boolean => hostClass(unbracket(host)) === 'loopback';

/** What to publish: `--advertise` replaces everything; else the single address the listener is bound to; else what the interfaces show. */
export function resolveAdvertised(o: ResolveAdvertisedOptions): AdvertisedAddresses {
  if (o.advertise.length > 0) {
    return { source: 'advertise', addresses: o.advertise.map((a) => ({ host: a.host, port: a.port ?? o.port })) };
  }
  if (o.peerHost !== undefined && !isWildcard(o.peerHost)) {
    if (isLoopbackHost(o.peerHost)) {
      return {
        source: 'bound-host',
        addresses: [],
        problem: `the peer listener is bound to loopback (--peer-host ${o.peerHost}): no other machine can connect to it, so no address record is published. Bind it to a reachable address (--peer-host <address>), or say where it can be reached with --advertise <host[:port]> (an SSH tunnel, a port redirect)`,
      };
    }
    return { source: 'bound-host', addresses: [{ host: o.peerHost, port: o.port }] };
  }
  const detail = discoverDetailed(o.port, o.provider);
  const found = detail.addresses;
  if (found.length === 0) {
    return {
      source: 'discovered',
      addresses: [],
      problem: 'no network address was found on this machine (only loopback or link-local interfaces): no address record is published and peers cannot find this machine. Say where it can be reached with --advertise <host[:port]> (repeatable)',
    };
  }
  const warning =
    detail.dropped.length === 0
      ? undefined
      : `${found.length + detail.dropped.length} network addresses were found on this machine, only ${found.length} fit in an address record: NOT published: ${detail.dropped.join(', ')}. Names and ranges are only a heuristic (private ranges and real-looking interfaces first); choose what peers must use with --advertise <host[:port]>`;
  return { source: 'discovered', addresses: found, ...(warning !== undefined ? { warning } : {}) };
}
