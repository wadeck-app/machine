import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSigningKeyPair, signBytes, verifyBytes } from '@wadeck-app/machine-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initMachine, readMachine } from './identity.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'machine-identity-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('initMachine', () => {
  it('creates a UUID v4, a working Ed25519 identity and stores the secret under _secrets_ only', () => {
    const m = initMachine(dir, 'desktop');
    expect(m.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(m.name).toBe('desktop');
    const sig = signBytes(m.identity.privateKeyPkcs8, new TextEncoder().encode('x'));
    expect(verifyBytes(m.identity.publicKey, new TextEncoder().encode('x'), sig)).toBe(true);
    expect(existsSync(join(dir, '_secrets_', 'identity.json'))).toBe(true);
    // Nothing outside _secrets_ may hold the private key.
    expect(existsSync(join(dir, 'identity.json'))).toBe(false);
  });

  it('is read back identically', () => {
    const created = initMachine(dir, 'desktop');
    const read = readMachine(dir);
    expect(read.uuid).toBe(created.uuid);
    expect(read.identity.publicKey).toBe(created.identity.publicKey);
    expect(Buffer.from(read.identity.privateKeyPkcs8).equals(Buffer.from(created.identity.privateKeyPkcs8))).toBe(true);
  });

  it('refuses to overwrite an existing identity and names it', () => {
    const first = initMachine(dir, 'desktop');
    expect(() => initMachine(dir, 'other')).toThrow(new RegExp(`already initialized.*${first.uuid}`));
    expect(readMachine(dir).name).toBe('desktop');
  });

  it('refuses an invalid name with the reason', () => {
    expect(() => initMachine(dir, 'My PC')).toThrow(/name/);
    expect(existsSync(join(dir, '_secrets_'))).toBe(false);
  });
});

describe('readMachine', () => {
  it('tells how to initialize when there is no identity', () => {
    expect(() => readMachine(dir)).toThrow(/machine init --name/);
  });

  it('names the file when it is corrupt, without printing its content', () => {
    initMachine(dir, 'desktop');
    const file = join(dir, '_secrets_', 'identity.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"uuid"', '"uuidx"'));
    expect(() => readMachine(dir)).toThrow(/identity\.json.*(corrupt|invalid)/);
    expect(() => readMachine(dir)).not.toThrow(/privateKey/);
  });

  it('refuses a public key that does not match the private key', () => {
    const a = initMachine(dir, 'desktop');
    const b = generateSigningKeyPair();
    const file = join(dir, '_secrets_', 'identity.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace(a.identity.publicKey, b.publicKey));
    expect(() => readMachine(dir)).toThrow(/does not match/);
  });
});
