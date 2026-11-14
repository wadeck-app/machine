import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDaemon } from '@wadeck-app/singleton-daemon-kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeCommands } from './commands.js';
import { initMachine } from './identity.js';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'machine-daemon-data-'));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the daemon answers the CLI commands over loopback HTTP', () => {
  it('serves status, list and resolve for an initialized machine', async () => {
    const machine = initMachine(dataDir, 'desktop');
    await using daemon = await createTestDaemon({ commands: makeCommands(dataDir, '0.0.0-test') });
    const status = (await daemon.client.send('status')) as { uuid: string; name: string; enrolled: boolean; version: string };
    expect(status).toMatchObject({ uuid: machine.uuid, name: 'desktop', enrolled: false, version: '0.0.0-test' });
    const list = (await daemon.client.send('list')) as { self: { name: string } };
    expect(list.self.name).toBe('desktop');
    const resolved = (await daemon.client.send('resolve', { ref: 'desktop' })) as { ok: boolean; uuid: string };
    expect(resolved).toMatchObject({ ok: true, uuid: machine.uuid });
  });

  it('reports an uninitialized machine as a normal answer, not a crash', async () => {
    await using daemon = await createTestDaemon({ commands: makeCommands(dataDir, '0.0.0-test') });
    const status = (await daemon.client.send('status')) as { initialized: boolean; message: string };
    expect(status.initialized).toBe(false);
    expect(status.message).toMatch(/machine init --name/);
  });

  it('never returns the private key in any answer', async () => {
    const machine = initMachine(dataDir, 'desktop');
    await using daemon = await createTestDaemon({ commands: makeCommands(dataDir, '0.0.0-test') });
    const secret = Buffer.from(machine.identity.privateKeyPkcs8).toString('base64url');
    for (const command of ['status', 'list', 'aliasList'] as const) {
      expect(JSON.stringify(await daemon.client.send(command))).not.toContain(secret);
    }
  });
});
