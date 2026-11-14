import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRelayConfig, relayFile, writeRelayConfig } from './relayStore.js';

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'machine-relay-store-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const config = { relayUrl: 'https://r.example', token: 'TOP-SECRET', label: 'l', claimedAt: '2026-11-14T00:00:00.000Z' };

describe('relay store', () => {
  it('returns undefined when absent', () => {
    expect(readRelayConfig(dir)).toBeUndefined();
  });

  it('round-trips under _secrets_', () => {
    writeRelayConfig(dir, config, false);
    expect(relayFile(dir)).toContain('_secrets_');
    expect(readRelayConfig(dir)).toEqual(config);
    if (process.platform !== 'win32') expect(statSync(relayFile(dir)).mode & 0o777).toBe(0o600);
  });

  it('refuses to overwrite without replace, and replaces with it', () => {
    writeRelayConfig(dir, config, false);
    expect(() => writeRelayConfig(dir, { ...config, token: 'OTHER' }, false)).toThrow(/--force/);
    expect(readRelayConfig(dir)?.token).toBe('TOP-SECRET');
    writeRelayConfig(dir, { ...config, token: 'OTHER' }, true);
    expect(readRelayConfig(dir)?.token).toBe('OTHER');
  });

  it.each(['not json with SECRETWORD', '[]', '{"relayUrl":"x","token":"SECRETWORD"}', '{"relayUrl":"","token":"","label":"","claimedAt":""}'])(
    'a malformed file (%j) names the file and the fix, never the content',
    (text) => {
      mkdirSync(join(dir, '_secrets_'), { recursive: true });
      writeFileSync(relayFile(dir), text);
      let message = '';
      try {
        readRelayConfig(dir);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain(relayFile(dir));
      expect(message).toMatch(/machine join/);
      expect(message).not.toContain('SECRETWORD');
    },
  );
});
