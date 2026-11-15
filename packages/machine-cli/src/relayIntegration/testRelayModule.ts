import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The integration tests against the REAL relay import `createTestRelay` from the poc-node repository (a sibling project, not a dependency).
// Its location is machine specific, so it is given by an environment variable only; nothing is guessed and nothing is skipped silently.

export const RELAY_MODULE_ENV = 'MACHINE_TEST_RELAY_MODULE';

export interface TestRelay {
  url: string;
  adminToken: string;
  dir: string;
  adminPairingCode: () => Promise<string>;
  machinePairingCode: () => Promise<string>;
  approveDeviceCode: (userCode: string, options?: { label?: string }) => Promise<{ approved: boolean; label: string; id: string; access?: string }>;
  close: () => Promise<void>;
}

/** `maxMachinesPerToken`: the per-token machine limit written in the relay's `machines-config.json` (1..1000); absent: the relay's own default (10). */
export type CreateTestRelay = (options?: { port?: number; maxMachinesPerToken?: number }) => Promise<TestRelay>;

const FIX = `set ${RELAY_MODULE_ENV} to the file tests/helpers/test-relay.mjs of the poc-node repository (run \`npm ci\` once in that repository), for example: ${RELAY_MODULE_ENV}=<path to poc-node>/tests/helpers/test-relay.mjs npm run test:relay`;

export async function loadCreateTestRelay(env: Record<string, string | undefined> = process.env): Promise<CreateTestRelay> {
  const given = env[RELAY_MODULE_ENV]?.trim();
  if (given === undefined || given === '') throw new Error(`${RELAY_MODULE_ENV} is not set: ${FIX}`);
  const file = resolve(given);
  if (!existsSync(file)) throw new Error(`${RELAY_MODULE_ENV} points to a file that does not exist (${file}): ${FIX}`);
  let loaded: { createTestRelay?: unknown };
  try {
    loaded = (await import(pathToFileURL(file).href)) as { createTestRelay?: unknown };
  } catch (e) {
    throw new Error(`cannot load ${file} (${(e as Error).message}): is \`npm ci\` done in the poc-node repository? ${FIX}`);
  }
  if (typeof loaded.createTestRelay !== 'function') throw new Error(`${file} does not export createTestRelay: ${FIX}`);
  return loaded.createTestRelay as CreateTestRelay;
}
