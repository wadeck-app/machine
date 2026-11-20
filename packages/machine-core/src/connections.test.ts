import { describe, expect, it } from 'vitest';
import { parseConnections, resolveRunShell, serializeConnections, type Connections } from './connections.js';

const UUID = '3f2a9c10-1b2c-4d3e-8f40-0123456789ab';

const valid = (): unknown => ({
  v: 1,
  peers: {
    [UUID]: {
      type: 'ping-if-not-reachable-magic-packet',
      addresses: [{ host: '192.168.1.40', port: 47921 }],
      wake: { mac: 'AA-BB-CC-DD-EE-01', broadcast: '192.168.1.255', waitSeconds: 120 },
    },
  },
});

describe('default shell of a peer', () => {
  it('reads and serializes a valid shell', () => {
    const c = parseConnections({ v: 1, peers: { [UUID]: { type: 'direct', shell: 'sh' } } });
    expect(c.peers[UUID]).toEqual({ type: 'direct', shell: 'sh' });
    expect(parseConnections(JSON.parse(serializeConnections(c)) as unknown)).toEqual(c);
  });

  it.each(['zsh', 'SH', '', 7, null])('refuses the shell %j, naming the allowed ones', (shell) => {
    expect(() => parseConnections({ v: 1, peers: { [UUID]: { type: 'direct', shell } } })).toThrow(/shell.*cmd, ps, bash, sh/);
  });
});

describe('resolveRunShell (precedence: --shell, the default of the peer, the platform of the caller)', () => {
  it('an explicit --shell wins over the default of the peer', () => {
    expect(resolveRunShell({ explicit: 'ps', peerDefault: 'sh', platform: 'win32' })).toEqual({ shell: 'ps', source: 'explicit' });
  });
  it('the default of the peer wins over the platform', () => {
    expect(resolveRunShell({ peerDefault: 'sh', platform: 'win32' })).toEqual({ shell: 'sh', source: 'peer-default' });
  });
  it('the platform of the caller is the last resort', () => {
    expect(resolveRunShell({ platform: 'win32' })).toEqual({ shell: 'cmd', source: 'platform' });
    expect(resolveRunShell({ platform: 'linux' })).toEqual({ shell: 'sh', source: 'platform' });
    expect(resolveRunShell({ platform: 'darwin' })).toEqual({ shell: 'sh', source: 'platform' });
  });
  it('refuses an unknown explicit shell instead of falling back', () => {
    expect(() => resolveRunShell({ explicit: 'zsh', peerDefault: 'sh', platform: 'linux' })).toThrow(/unknown shell "zsh": expected one of cmd, ps, bash, sh/);
  });
});

describe('parseConnections', () => {
  it('reads a valid file and normalises the MAC', () => {
    const c = parseConnections(valid());
    expect(c.peers[UUID]).toEqual({
      type: 'ping-if-not-reachable-magic-packet',
      addresses: [{ host: '192.168.1.40', port: 47921 }],
      wake: { mac: 'aa:bb:cc:dd:ee:01', broadcast: '192.168.1.255', waitSeconds: 120 },
    });
  });

  it('accepts a direct entry with only a type, a pinned DNS name, and no peers at all', () => {
    expect(parseConnections({ v: 1, peers: {} }).peers).toEqual({});
    const c = parseConnections({ v: 1, peers: { [UUID]: { type: 'direct', addresses: [{ host: 'mac.example.net', port: 47921 }] } } });
    expect(c.peers[UUID]?.addresses).toEqual([{ host: 'mac.example.net', port: 47921 }]);
    expect(parseConnections({ v: 1, peers: { [UUID]: { type: 'direct' } } }).peers[UUID]).toEqual({ type: 'direct' });
  });

  it('accepts every timing at its bounds and keeps the others absent (the defaults apply at use)', () => {
    const lo = parseConnections({ v: 1, peers: { [UUID]: { type: 'direct', wake: { mac: 'aa:bb:cc:dd:ee:01', probeSeconds: 1, waitSeconds: 10, maxUnicast: 0, maxBroadcast: 8, connectTimeoutMs: 200, settleSeconds: 0 } } } });
    expect(lo.peers[UUID]?.wake).toEqual({ mac: 'aa:bb:cc:dd:ee:01', probeSeconds: 1, waitSeconds: 10, maxUnicast: 0, maxBroadcast: 8, connectTimeoutMs: 200, settleSeconds: 0 });
    const hi = parseConnections({ v: 1, peers: { [UUID]: { type: 'direct', wake: { mac: 'aa:bb:cc:dd:ee:01', probeSeconds: 60, waitSeconds: 600, maxUnicast: 8, maxBroadcast: 0, connectTimeoutMs: 10000, settleSeconds: 120 } } } });
    expect(hi.peers[UUID]?.wake?.maxBroadcast).toBe(0);
    expect(parseConnections({ v: 1, peers: { [UUID]: { type: 'direct', wake: { mac: 'aa:bb:cc:dd:ee:01' } } } }).peers[UUID]?.wake).toEqual({ mac: 'aa:bb:cc:dd:ee:01' });
  });

  it('round-trips through serializeConnections', () => {
    const c = parseConnections(valid());
    expect(parseConnections(JSON.parse(serializeConnections(c)))).toEqual(c);
  });

  const mutate = (fn: (o: { peers: Record<string, Record<string, unknown>> } & Record<string, unknown>) => void): unknown => {
    const o = valid() as { peers: Record<string, Record<string, unknown>> } & Record<string, unknown>;
    fn(o);
    return o;
  };

  it.each([
    ['not an object', [], /top level/],
    ['wrong version', { v: 2, peers: {} }, /"v"/],
    ['unknown top-level field', { v: 1, peers: {}, extra: 1 }, /unknown field "extra"/],
    ['missing peers', { v: 1 }, /"peers"/],
    ['peer key not a uuid', { v: 1, peers: { box: { type: 'direct' } } }, /"box" is not a machine uuid/],
    ['unknown type', mutate((o) => ((o.peers[UUID] as Record<string, unknown>).type = 'ssh-proxy')), /type.*"ssh-proxy".*direct, ping-if-not-reachable-magic-packet/],
    ['missing type', { v: 1, peers: { [UUID]: {} } }, /missing field "type"/],
    ['unknown peer field', mutate((o) => ((o.peers[UUID] as Record<string, unknown>).proxy = 'x')), /unknown field "proxy"/],
    ['unknown wake field', mutate((o) => ((o.peers[UUID] as { wake: Record<string, unknown> }).wake.port = 7)), /wake: unknown field "port"/],
    ['unknown address field', mutate((o) => ((o.peers[UUID] as { addresses: Array<Record<string, unknown>> }).addresses[0]!.command = 'x')), /unknown field "command"/],
    ['bad MAC', mutate((o) => ((o.peers[UUID] as { wake: Record<string, unknown> }).wake.mac = 'nope')), /wake\.mac.*invalid MAC/],
    ['bad broadcast', mutate((o) => ((o.peers[UUID] as { wake: Record<string, unknown> }).wake.broadcast = '255.255.255')), /wake\.broadcast/],
    ['bad wait', mutate((o) => ((o.peers[UUID] as { wake: Record<string, unknown> }).wake.waitSeconds = 5)), /wake\.waitSeconds.*from 10 to 600/],
    ['wait too long', mutate((o) => ((o.peers[UUID] as { wake: Record<string, unknown> }).wake.waitSeconds = 601)), /wake\.waitSeconds.*from 10 to 600/],
    ['probe 0', mutate((o) => ((o.peers[UUID] as { wake: Record<string, unknown> }).wake.probeSeconds = 0)), /wake\.probeSeconds.*from 1 to 60/],
    ['probe 61', mutate((o) => ((o.peers[UUID] as { wake: Record<string, unknown> }).wake.probeSeconds = 61)), /wake\.probeSeconds.*from 1 to 60/],
    ['maxUnicast 9 (a typo cannot create a storm)', mutate((o) => ((o.peers[UUID] as { wake: Record<string, unknown> }).wake.maxUnicast = 9)), /wake\.maxUnicast.*from 0 to 8/],
    ['maxBroadcast 9', mutate((o) => ((o.peers[UUID] as { wake: Record<string, unknown> }).wake.maxBroadcast = 9)), /wake\.maxBroadcast.*from 0 to 8/],
    ['maxBroadcast fractional', mutate((o) => ((o.peers[UUID] as { wake: Record<string, unknown> }).wake.maxBroadcast = 2.5)), /wake\.maxBroadcast/],
    ['connect timeout 50 ms', mutate((o) => ((o.peers[UUID] as { wake: Record<string, unknown> }).wake.connectTimeoutMs = 50)), /wake\.connectTimeoutMs.*from 200 to 10000/],
    ['settle negative', mutate((o) => ((o.peers[UUID] as { wake: Record<string, unknown> }).wake.settleSeconds = -1)), /wake\.settleSeconds.*from 0 to 120/],
    ['both maxima 0', mutate((o) => Object.assign((o.peers[UUID] as { wake: Record<string, unknown> }).wake, { maxUnicast: 0, maxBroadcast: 0 })), /no packet would ever be sent/],
    ['wait not a number', mutate((o) => ((o.peers[UUID] as { wake: Record<string, unknown> }).wake.waitSeconds = '90')), /wake\.waitSeconds/],
    ['bad port', mutate((o) => ((o.peers[UUID] as { addresses: Array<Record<string, unknown>> }).addresses[0]!.port = 70000)), /addresses\[0\]\.port/],
    ['bad host', mutate((o) => ((o.peers[UUID] as { addresses: Array<Record<string, unknown>> }).addresses[0]!.host = 'http://x')), /addresses\[0\]\.host/],
    ['too many addresses', mutate((o) => ((o.peers[UUID] as Record<string, unknown>).addresses = Array.from({ length: 9 }, (_, i) => ({ host: `10.0.0.${i + 1}`, port: 1 })))), /at most 8/],
    ['magic packet without a MAC', { v: 1, peers: { [UUID]: { type: 'ping-if-not-reachable-magic-packet' } } }, /needs "wake"/],
  ])('refuses %s, naming the field', (_what, input, message) => {
    expect(() => parseConnections(input)).toThrow(message);
  });

  it('names the peer uuid in the error of a peer field', () => {
    expect(() => parseConnections(mutate((o) => ((o.peers[UUID] as Record<string, unknown>).type = 'x')))).toThrow(UUID);
  });
});

describe('serializeConnections', () => {
  it('writes the version, sorted peers and a trailing newline, nothing else', () => {
    const a = '00000000-0000-4000-8000-000000000001';
    const b = '00000000-0000-4000-8000-000000000002';
    const c: Connections = { v: 1, peers: { [b]: { type: 'direct' }, [a]: { type: 'direct' } } };
    const text = serializeConnections(c);
    expect(text.endsWith('\n')).toBe(true);
    expect(Object.keys(JSON.parse(text).peers)).toEqual([a, b]);
  });
});
