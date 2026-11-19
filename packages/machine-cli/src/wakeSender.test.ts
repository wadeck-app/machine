import dgram from 'node:dgram';
import { buildMagicPacket, parseMac, type WakeRoute } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { createWakeSender, type WakeSocket } from './wakeSender.js';

const mac = parseMac('aa:bb:cc:dd:ee:01');
if (!mac.ok) throw new Error('setup');
const packet = buildMagicPacket(mac.bytes);

const route = (over: Partial<WakeRoute> = {}): WakeRoute => ({ interfaceName: 'eth0', localAddress: '192.168.1.10', broadcast: '192.168.1.255', unicast: ['192.168.1.40'], ...over });

function fakeSockets(failOn: (to: string) => string | undefined = () => undefined) {
  const log = { created: 0, closed: 0, bound: [] as string[], broadcast: [] as boolean[], sent: [] as Array<{ to: string; port: number; bytes: number; from: string }> };
  const factory = (): WakeSocket => {
    log.created++;
    let from = '';
    return {
      bind: async (_port, address) => {
        from = address;
        log.bound.push(address);
      },
      setBroadcast: (on) => log.broadcast.push(on),
      send: async (p, port, to) => {
        const failure = failOn(to);
        if (failure !== undefined) throw new Error(failure);
        log.sent.push({ to, port, bytes: p.length, from });
      },
      close: () => {
        log.closed++;
      },
    };
  };
  return { factory, log };
}

describe('createWakeSender', () => {
  it('unicast: the 102-byte packet goes to the known address of the target on port 9, from the interface of the shared subnet', async () => {
    const s = fakeSockets();
    const report = await createWakeSender({ socket: s.factory }).send('unicast', packet, [route()]);
    expect(s.log.sent).toEqual([{ to: '192.168.1.40', port: 9, bytes: 102, from: '192.168.1.10' }]);
    expect(s.log.broadcast).toEqual([]);
    expect(report.destinations).toEqual([{ method: 'unicast', to: '192.168.1.40', from: '192.168.1.10', ok: true }]);
  });

  it('broadcast: SO_BROADCAST is set and the packet goes to the directed broadcast of the subnet on port 9', async () => {
    const s = fakeSockets();
    const report = await createWakeSender({ socket: s.factory }).send('broadcast', packet, [route()]);
    expect(s.log.broadcast).toEqual([true]);
    expect(s.log.sent).toEqual([{ to: '192.168.1.255', port: 9, bytes: 102, from: '192.168.1.10' }]);
    expect(report.destinations[0]).toMatchObject({ method: 'broadcast', to: '192.168.1.255', ok: true });
  });

  it('every route gets its own packet (two interfaces on the subnet), and every socket is closed', async () => {
    const s = fakeSockets();
    await createWakeSender({ socket: s.factory }).send('broadcast', packet, [route(), route({ interfaceName: 'wlan0', localAddress: '192.168.1.11' })]);
    expect(s.log.sent.map((x) => x.from)).toEqual(['192.168.1.10', '192.168.1.11']);
    expect(s.log.closed).toBe(s.log.created);
  });

  it('a unicast with no address to unicast to sends nothing and says so (the caller plans broadcast only then)', async () => {
    const s = fakeSockets();
    await expect(createWakeSender({ socket: s.factory }).send('unicast', packet, [route({ unicast: [] })])).rejects.toThrow(/no address to unicast to/);
    expect(s.log.created).toBe(0);
  });

  it('a destination that fails is reported; the others still go; it throws only when nothing was sent', async () => {
    const s = fakeSockets((to) => (to === '10.0.0.255' ? 'EACCES: permission denied' : undefined));
    const mixed = await createWakeSender({ socket: s.factory }).send('broadcast', packet, [route(), route({ localAddress: '10.0.0.2', broadcast: '10.0.0.255', interfaceName: 'tun0' })]);
    expect(mixed.destinations.map((d) => [d.to, d.ok])).toEqual([
      ['192.168.1.255', true],
      ['10.0.0.255', false],
    ]);
    expect(mixed.destinations[1]?.error).toMatch(/EACCES/);
    const allBad = fakeSockets(() => 'ENETUNREACH: network is unreachable');
    await expect(createWakeSender({ socket: allBad.factory }).send('broadcast', packet, [route()])).rejects.toThrow(/could not send.*192\.168\.1\.255.*ENETUNREACH.*firewall/s);
    expect(allBad.log.closed).toBe(allBad.log.created);
  });

  it('closes the socket even when binding fails', async () => {
    const log = { closed: 0 };
    const factory = (): WakeSocket => ({
      bind: async () => {
        throw new Error('EADDRNOTAVAIL');
      },
      setBroadcast: () => undefined,
      send: async () => undefined,
      close: () => void log.closed++,
    });
    await expect(createWakeSender({ socket: factory }).send('broadcast', packet, [route()])).rejects.toThrow(/EADDRNOTAVAIL/);
    expect(log.closed).toBe(1);
  });

  it('the one real UDP test: the exact bytes arrive over a loopback unicast socket (never a broadcast, never a LAN address)', async () => {
    const receiver = dgram.createSocket('udp4');
    const received = new Promise<Buffer>((resolve, reject) => {
      receiver.once('message', (m) => resolve(m));
      receiver.once('error', reject);
    });
    await new Promise<void>((resolve) => receiver.bind(0, '127.0.0.1', resolve));
    const port = receiver.address().port;
    try {
      // `port` overrides the discard port for this test only: nothing in the product can change it.
      await createWakeSender({ port }).send('unicast', packet, [route({ localAddress: '127.0.0.1', unicast: ['127.0.0.1'], broadcast: '127.0.0.255' })]);
      const bytes = await Promise.race([received, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no datagram within 3 s')), 3000))]);
      expect(Buffer.compare(bytes, packet)).toBe(0);
      expect(bytes.length).toBe(102);
    } finally {
      receiver.close();
    }
  });
});
