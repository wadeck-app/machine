import { encryptAdminKey } from '@wadeck-app/machine-core';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { b64u, newPair, pkcs8FromSeed, webKeyFrom } from '../test-support/kit.js';
import { unlockAdminKey } from './adminKey.js';
import { buildDocument, signRegistration } from './documents.js';
import { sealTo } from './seal.js';
import { derivePairSecretFromSignature } from './pairSecret.js';

const here = dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(here).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'));

describe('browser safety of the sources', () => {
  it('finds the sources (the scan below is not vacuous)', () => {
    expect(sources).toEqual(expect.arrayContaining(['index.ts', 'adminKey.ts', 'seal.ts', 'canonical.ts', 'signed.ts', 'documents.ts', 'sas.ts', 'pairSecret.ts', 'base64url.ts', 'keys.ts']));
  });

  it.each(sources)('%s has no node: import, no Buffer, no process, no require, no runtime import of another package', file => {
    const text = readFileSync(join(here, file), 'utf8');
    expect(text).not.toMatch(/['"]node:/);
    expect(text).not.toMatch(/\bBuffer\b/);
    expect(text).not.toMatch(/\bprocess\./);
    expect(text).not.toMatch(/\brequire\(/);
    expect(text).not.toMatch(/\bconsole\./);
    for (const line of text.split('\n')) {
      const m = /^\s*(?:import|export)\b.*\bfrom\s+['"]([^'"]+)['"]/.exec(line);
      if (!m) continue;
      const spec = m[1] as string;
      if (spec.startsWith('./')) continue;
      expect(line, `only type imports of machine-core are allowed in ${file}`).toMatch(/^\s*(?:import|export) type\b/);
      expect(spec).toBe('@wadeck-app/machine-core');
    }
  });

  it('package.json declares no runtime dependency', () => {
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(pkg.dependencies).toBeUndefined();
  });
});

describe('no log and no error message carries the passphrase or key bytes', () => {
  it('failures of every operation stay clean and nothing is written to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m => vi.spyOn(console, m));
    const pair = newPair();
    const passphrase = STRONG_MARKER;
    const file = JSON.stringify(encryptAdminKey(pair, passphrase));
    const secrets = [passphrase, b64u(pair.privateKeyPkcs8), Buffer.from(pair.privateKeyPkcs8).toString('hex'), b64u(pair.privateKeyPkcs8.subarray(16)), Buffer.from(pair.privateKeyPkcs8.subarray(16)).toString('hex')];
    const messages: string[] = [];
    const collect = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        messages.push('NO ERROR');
      } catch (e) {
        messages.push((e as Error).message);
      }
    };

    await collect(() => unlockAdminKey(file, `${passphrase} wrong`, { extractable: false }));
    await collect(() => unlockAdminKey(file.replace('"v": 1', '"v": 9').replace('"v":1', '"v":9'), passphrase, { extractable: false }));
    await collect(() => unlockAdminKey(file.slice(0, 40), passphrase, { extractable: false }));
    const unlocked = await unlockAdminKey(file, passphrase, { extractable: false });
    await collect(() => crypto.subtle.exportKey('pkcs8', unlocked.privateKey));
    unlocked.lock();
    await collect(() => signRegistration({} as never, unlocked.privateKey));
    await collect(() => buildDocument({} as never, unlocked.privateKey));
    await collect(() => sealTo(`${pair.publicKey}=`, pkcs8FromSeed(new Uint8Array(32)), 'ctx'));
    await collect(async () => derivePairSecretFromSignature(await webKeyFrom(pair), { uuid: 'x', serial: 1 }, { uuid: 'y', serial: 1 }));

    expect(messages).not.toContain('NO ERROR');
    for (const message of messages) {
      for (const secret of secrets) expect(message, message).not.toContain(secret);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

const STRONG_MARKER = 'Zq9-marker-passphrase-for-leak-test-4417';
