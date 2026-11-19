import dgram from 'node:dgram';
import { WAKE_PORT, type WakeMethod, type WakeRoute } from '@wadeck-app/machine-core';

// The only code of the product that opens a UDP socket (decision 62). It sends a magic packet to destinations that `selectWakeRoutes` already
// checked (a known address of the peer inside a local subnet, or that subnet's directed broadcast) on UDP port 9. The socket is injected so the
// tests send nothing to a network.

/** The few socket calls the sender needs. */
export interface WakeSocket {
  bind(port: number, address: string): Promise<void>;
  setBroadcast(on: boolean): void;
  send(packet: Buffer, port: number, address: string): Promise<void>;
  close(): void;
}

export type WakeSocketFactory = () => WakeSocket;

export interface SentDestination {
  method: WakeMethod;
  to: string;
  from: string;
  ok: boolean;
  error?: string;
}

export interface SendReport {
  destinations: SentDestination[];
}

export interface WakeSender {
  /** Sends one packet to every destination of `method` of the routes. Throws when nothing could be sent. */
  send(method: WakeMethod, packet: Buffer, routes: readonly WakeRoute[]): Promise<SendReport>;
}

/** UDP over `dgram`, bound to the local address of the route so that the packet leaves by the interface of the shared subnet (UNVERIFIED on every OS). */
function realSocket(): WakeSocket {
  const socket = dgram.createSocket('udp4');
  // An error with no listener would crash the process: it is reported by the call that was waiting.
  socket.on('error', () => undefined);
  return {
    bind: (port, address) =>
      new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(port, address, () => {
          socket.off('error', reject);
          resolve();
        });
      }),
    setBroadcast: (on) => socket.setBroadcast(on),
    send: (packet, port, address) =>
      new Promise((resolve, reject) => {
        socket.send(packet, port, address, (e) => (e ? reject(e) : resolve()));
      }),
    close: () => {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    },
  };
}

/** `port`: tests only (a loopback receiver); the product always uses UDP port 9. */
export function createWakeSender(options: { socket?: WakeSocketFactory; port?: number } = {}): WakeSender {
  const makeSocket = options.socket ?? realSocket;
  const port = options.port ?? WAKE_PORT;
  return {
    async send(method, packet, routes) {
      const plan = routes.flatMap((r) => (method === 'unicast' ? r.unicast : [r.broadcast]).map((to) => ({ route: r, to })));
      if (plan.length === 0) throw new Error(`no address to unicast to: the routes hold no known IPv4 address of the peer, so nothing was sent by ${method}`);
      const destinations: SentDestination[] = [];
      for (const { route, to } of plan) {
        const socket = makeSocket();
        try {
          await socket.bind(0, route.localAddress);
          if (method === 'broadcast') socket.setBroadcast(true);
          await socket.send(packet, port, to);
          destinations.push({ method, to, from: route.localAddress, ok: true });
        } catch (e) {
          destinations.push({ method, to, from: route.localAddress, ok: false, error: (e as Error).message });
        } finally {
          socket.close();
        }
      }
      if (!destinations.some((d) => d.ok)) {
        throw new Error(`could not send the ${method} packet: ${destinations.map((d) => `${d.to} (from ${d.from}): ${d.error ?? 'failed'}`).join('; ')}. Check that a firewall does not block outgoing UDP port ${port} and that the network interface is up`);
      }
      return { destinations };
    },
  };
}
