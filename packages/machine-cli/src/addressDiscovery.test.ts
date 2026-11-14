import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { discoverAddresses, parseAdvertise, resolveAdvertised } from './addressDiscovery.js';

const v4 = (address: string, internal = false): NetworkInterfaceInfo => ({ address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: `${address}/24` });
const v6 = (address: string, internal = false): NetworkInterfaceInfo => ({ address, netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '00:00:00:00:00:00', internal, cidr: `${address}/64`, scopeid: 0 });
const provider = (table: Record<string, NetworkInterfaceInfo[]>) => () => table;

describe('discoverAddresses', () => {
  it('lists the non-internal addresses with the peer port, IPv4 first', () => {
    const found = discoverAddresses(47921, provider({ eth0: [v6('2001:db8::5'), v4('192.168.1.20')], wlan0: [v4('10.0.0.7')] }));
    expect(found).toEqual([
      { host: '192.168.1.20', port: 47921 },
      { host: '10.0.0.7', port: 47921 },
      { host: '2001:db8::5', port: 47921 },
    ]);
  });

  it('skips loopback and internal addresses, link-local IPv6 (fe80::/10) and IPv4 (169.254/16), and the unspecified address', () => {
    const found = discoverAddresses(
      1,
      provider({
        lo: [v4('127.0.0.1', true), v6('::1', true)],
        eth0: [v4('169.254.10.2'), v6('fe80::1'), v6('febf::2'), v6('::'), v4('192.168.1.2')],
      }),
    );
    expect(found).toEqual([{ host: '192.168.1.2', port: 1 }]);
  });

  it('does not filter virtual or docker interfaces (they are listed, within the cap)', () => {
    const found = discoverAddresses(1, provider({ docker0: [v4('172.17.0.1')], eth0: [v4('192.168.1.2')] }));
    expect(found.map((a) => a.host)).toEqual(['172.17.0.1', '192.168.1.2']);
  });

  it('caps the list at 8 addresses, keeping IPv4 before IPv6', () => {
    const many = Array.from({ length: 6 }, (_, i) => v6(`2001:db8::${i + 1}`));
    const four = Array.from({ length: 4 }, (_, i) => v4(`10.0.0.${i + 1}`));
    const found = discoverAddresses(1, provider({ eth0: [...many, ...four] }));
    expect(found).toHaveLength(8);
    expect(found.slice(0, 4).map((a) => a.host)).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4']);
  });

  it('lists an address once even when two interfaces carry it', () => {
    const found = discoverAddresses(1, provider({ a: [v4('10.0.0.1')], b: [v4('10.0.0.1')] }));
    expect(found).toHaveLength(1);
  });

  it('returns an empty list when nothing qualifies (the caller must say so)', () => {
    expect(discoverAddresses(1, provider({ lo: [v4('127.0.0.1', true)] }))).toEqual([]);
  });

  it('copes with an interface that has no address list', () => {
    expect(discoverAddresses(1, () => ({ eth0: undefined, eth1: [v4('10.0.0.1')] }))).toEqual([{ host: '10.0.0.1', port: 1 }]);
  });
});

describe('parseAdvertise', () => {
  it('accepts a host alone, host:port, a bracketed IPv6 address and a bare IPv6 address', () => {
    expect(parseAdvertise(['desktop.example.com', '203.0.113.9:50000', '[2001:db8::1]:50001', '[2001:db8::2]', '2001:db8::3'])).toEqual([
      { host: 'desktop.example.com' },
      { host: '203.0.113.9', port: 50000 },
      { host: '2001:db8::1', port: 50001 },
      { host: '2001:db8::2' },
      { host: '2001:db8::3' },
    ]);
  });

  it.each([
    ['http://host:80', /--advertise/],
    ['user@host', /--advertise/],
    ['host:0', /port/],
    ['host:70000', /port/],
    ['host:abc', /--advertise/],
    ['', /--advertise/],
    ['a b', /--advertise/],
    ['fe80::1%eth0', /zone/],
  ])('refuses %j and names the option', (text, pattern) => {
    expect(() => parseAdvertise([text])).toThrow(pattern);
  });

  it('refuses the same address twice instead of dropping one silently', () => {
    expect(() => parseAdvertise(['a.example:1', 'a.example:1'])).toThrow(/twice/);
  });

  it('refuses more than 8 addresses', () => {
    expect(() => parseAdvertise(Array.from({ length: 9 }, (_, i) => `h${i}.example`))).toThrow(/at most 8/);
  });
});

describe('resolveAdvertised', () => {
  const table = provider({ eth0: [v4('192.168.1.20')] });

  it('--advertise REPLACES the discovered list, and gives its own port or the peer port', () => {
    const r = resolveAdvertised({ advertise: [{ host: 'nat.example.com', port: 50000 }, { host: '203.0.113.9' }], port: 47921, provider: table });
    expect(r).toEqual({ source: 'advertise', addresses: [{ host: 'nat.example.com', port: 50000 }, { host: '203.0.113.9', port: 47921 }] });
  });

  it('discovers the addresses when nothing is advertised and the listener is on every interface', () => {
    expect(resolveAdvertised({ advertise: [], port: 47921, provider: table, peerHost: '0.0.0.0' })).toEqual({ source: 'discovered', addresses: [{ host: '192.168.1.20', port: 47921 }] });
    expect(resolveAdvertised({ advertise: [], port: 47921, provider: table })).toMatchObject({ source: 'discovered' });
    expect(resolveAdvertised({ advertise: [], port: 47921, provider: table, peerHost: '::' })).toMatchObject({ source: 'discovered' });
  });

  it('publishes only the bound host when the listener is bound to one address', () => {
    expect(resolveAdvertised({ advertise: [], port: 47921, provider: table, peerHost: '192.168.1.20' })).toEqual({ source: 'bound-host', addresses: [{ host: '192.168.1.20', port: 47921 }] });
  });

  it.each(['127.0.0.1', '::1', 'localhost'])('says why nothing is published when the listener is bound to loopback (%s)', (peerHost) => {
    const r = resolveAdvertised({ advertise: [], port: 47921, provider: table, peerHost });
    expect(r.addresses).toEqual([]);
    expect(r.problem).toMatch(/loopback/);
    expect(r.problem).toMatch(/--advertise/);
  });

  it('says why nothing is published when no address was found (never silent)', () => {
    const r = resolveAdvertised({ advertise: [], port: 47921, provider: provider({ lo: [v4('127.0.0.1', true)] }) });
    expect(r.addresses).toEqual([]);
    expect(r.problem).toMatch(/no network address/);
    expect(r.problem).toMatch(/--advertise <host\[:port\]>/);
  });

  it('--advertise wins even when the listener is on loopback (an SSH tunnel or a VPN host)', () => {
    const r = resolveAdvertised({ advertise: [{ host: 'vpn.example' }], port: 1, provider: table, peerHost: '127.0.0.1' });
    expect(r).toEqual({ source: 'advertise', addresses: [{ host: 'vpn.example', port: 1 }] });
  });
});
