import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMachineDaemon } from './daemonEntry.js';
import { initMachine } from './identity.js';

let dir: string;
const stoppers: Array<() => Promise<void>> = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'machine-restart-'));
});
afterEach(async () => {
  while (stoppers.length > 0) await stoppers.pop()?.();
  rmSync(dir, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

describe('replacing a running daemon (restart, update)', () => {
  it('the new daemon takes over the config directory AND the peer port of the old one', async () => {
    initMachine(dir, 'desktop');
    const peerPort = await freePort();
    const first = await startMachineDaemon(dir, { port: 0, version: 'one', peerPort, peerHost: '127.0.0.1' });
    stoppers.push(first.stop);
    const second = await startMachineDaemon(dir, { port: 0, version: 'two', peerPort, peerHost: '127.0.0.1' });
    stoppers.push(second.stop);
    expect(second.peerPort).toBe(peerPort);
    await first.stopped;
  });
});
