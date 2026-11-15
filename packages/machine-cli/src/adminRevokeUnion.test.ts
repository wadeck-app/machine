import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keyId, signRevocation } from '@wadeck-app/machine-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unlockAdminKey } from './admin.js';
import { readMachine } from './identity.js';
import { installRevocation, loadNetwork, revocationState } from './network.js';
import { cli, ok } from './testing.js';

let root: string;
let a: string;
let b: string;
let passphrase: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-revoke-union-'));
  a = join(root, 'a');
  b = join(root, 'b');
  await ok(a, ['init', '--name', 'desktop']);
  await ok(b, ['init', '--name', 'laptop']);
  const init = await ok(a, ['admin', 'init', '--generate']);
  passphrase = /passphrase[^\n]*\n\s*([A-Z0-9 -]{20,})/i.exec(init.err)?.[1]?.trim() ?? '';
  await ok(b, ['peer', 'info', '--out', join(root, 'b-info.json')]);
  await ok(a, ['admin', 'register', join(root, 'b-info.json'), '--out', join(root, 'for-a.json')], async () => passphrase);
  await ok(a, ['peer', 'import', join(root, 'for-a.json')]);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('machine admin revoke signs what is installed at signing time', () => {
  it('keeps a revocation that was installed while the passphrase prompt was open (no stale snapshot)', async () => {
    const z = randomUUID();
    let prompts = 0;
    const prompt = async () => {
      prompts += 1;
      if (prompts === 1) {
        // Another process (the daemon inbox, a catch-up) installs a list while the admin types the passphrase.
        const pair = await unlockAdminKey(a, async () => passphrase);
        installRevocation(a, signRevocation({ v: 1, adminKeyId: keyId(pair.publicKey), issuedAt: Math.floor(Date.now() / 1000) - 5, entries: [{ uuid: z, serial: 1 }] }, pair.privateKeyPkcs8));
      }
      return passphrase;
    };
    const r = await cli(a, ['admin', 'revoke', 'laptop'], prompt, { ask: async () => 'y' });
    expect(r.code, r.err).toBe(0);
    const laptop = readMachine(b).uuid;
    const lists = revocationState(a).lists;
    expect(lists).toHaveLength(1);
    expect((lists[0]?.body.entries ?? []).map((e) => e.uuid).sort()).toEqual([laptop, z].sort());
    expect(loadNetwork(a, Math.floor(Date.now() / 1000)).revocations.map((e) => e.uuid).sort()).toEqual([laptop, z].sort());
  });
});
