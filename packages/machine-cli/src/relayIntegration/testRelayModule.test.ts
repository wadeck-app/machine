import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCreateTestRelay, RELAY_MODULE_ENV } from './testRelayModule.js';

// The integration tests against the real relay import `createTestRelay` from the poc-node repo. This loader never skips silently.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'machine-relaymodule-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadCreateTestRelay', () => {
  it('fails loudly when the variable is not set, with the exact fix', async () => {
    await expect(loadCreateTestRelay({})).rejects.toThrow(new RegExp(`${RELAY_MODULE_ENV} is not set.*tests/helpers/test-relay\.mjs.*npm run test:relay`, 's'));
  });

  it('fails loudly when the variable is empty', async () => {
    await expect(loadCreateTestRelay({ [RELAY_MODULE_ENV]: '  ' })).rejects.toThrow(/is not set/);
  });

  it('fails loudly when the file does not exist, naming the path', async () => {
    const missing = join(dir, 'nope', 'test-relay.mjs');
    await expect(loadCreateTestRelay({ [RELAY_MODULE_ENV]: missing })).rejects.toThrow('does not exist');
    await expect(loadCreateTestRelay({ [RELAY_MODULE_ENV]: missing })).rejects.toThrow(resolve(missing));
  });

  it('fails loudly when the module has no createTestRelay export', async () => {
    mkdirSync(join(dir, 'x'));
    const file = join(dir, 'x', 'other.mjs');
    writeFileSync(file, 'export const nothing = 1;\n');
    await expect(loadCreateTestRelay({ [RELAY_MODULE_ENV]: file })).rejects.toThrow(/does not export createTestRelay/);
  });

  it('returns the function of a valid module', async () => {
    const file = join(dir, 'ok.mjs');
    writeFileSync(file, 'export async function createTestRelay() { return { url: "http://127.0.0.1:1" }; }\n');
    const create = await loadCreateTestRelay({ [RELAY_MODULE_ENV]: file });
    expect(await create()).toMatchObject({ url: 'http://127.0.0.1:1' });
  });
});
