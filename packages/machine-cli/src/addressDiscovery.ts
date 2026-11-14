import { isIPv4, isIPv6 } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { MAX_ADDRESSES, hostProblem, type AddressEntry } from '@wadeck-app/machine-core';

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

/**
 * The non-internal IPv4 then IPv6 addresses of this machine with `port`. Loopback, link-local (169.254/16, fe80::/10) and the
 * unspecified address are left out; docker and virtual interfaces are NOT filtered (use `--advertise` to choose). At most 8.
 */
export function discoverAddresses(port: number, provider: InterfaceProvider = networkInterfaces): AddressEntry[] {
  const v4: string[] = [];
  const v6: string[] = [];
  for (const infos of Object.values(provider())) {
    for (const info of infos ?? []) {
      if (info.internal || isUnspecified(info.address)) continue;
      if (info.family === 'IPv4' && !isIpv4LinkLocal(info.address) && isIPv4(info.address)) v4.push(info.address);
      else if (info.family === 'IPv6' && !isIpv6LinkLocal(info.address) && isIPv6(info.address)) v6.push(info.address);
    }
  }
  const unique = [...new Set([...v4, ...v6])];
  return unique.slice(0, MAX_ADDRESSES).map((host) => ({ host, port }));
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
    const problem = hostProblem(host);
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
}

const WILDCARDS = new Set(['0.0.0.0', '::', '[::]']);
const isLoopbackHost = (host: string): boolean => host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.');

/** What to publish: `--advertise` replaces everything; else the single address the listener is bound to; else what the interfaces show. */
export function resolveAdvertised(o: ResolveAdvertisedOptions): AdvertisedAddresses {
  if (o.advertise.length > 0) {
    return { source: 'advertise', addresses: o.advertise.map((a) => ({ host: a.host, port: a.port ?? o.port })) };
  }
  if (o.peerHost !== undefined && !WILDCARDS.has(o.peerHost)) {
    if (isLoopbackHost(o.peerHost)) {
      return {
        source: 'bound-host',
        addresses: [],
        problem: `the peer listener is bound to loopback (--peer-host ${o.peerHost}): no other machine can connect to it, so no address record is published. Bind it to a reachable address (--peer-host <address>), or say where it can be reached with --advertise <host[:port]> (an SSH tunnel, a port redirect)`,
      };
    }
    return { source: 'bound-host', addresses: [{ host: o.peerHost, port: o.port }] };
  }
  const found = discoverAddresses(o.port, o.provider);
  if (found.length === 0) {
    return {
      source: 'discovered',
      addresses: [],
      problem: 'no network address was found on this machine (only loopback or link-local interfaces): no address record is published and peers cannot find this machine. Say where it can be reached with --advertise <host[:port]> (repeatable)',
    };
  }
  return { source: 'discovered', addresses: found };
}
