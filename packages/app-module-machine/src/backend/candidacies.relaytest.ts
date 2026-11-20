import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateSigningKeyPair, newCandidacyRandom } from '@wadeck-app/machine-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listCandidacies } from './candidacies.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

// The module backend against the REAL relay of the poc-node repository (`npm run test:relay` in this package, never part of `npm test`).
// A machine token posts a candidacy, the admin token lists it through listCandidacies: the dates are what the real relay really sends.
// Nothing is skipped silently: a missing MACHINE_TEST_RELAY_MODULE fails the file with the fix.

const ENV = 'MACHINE_TEST_RELAY_MODULE';
const FIX = `set ${ENV} to the file tests/helpers/test-relay.mjs of the poc-node repository (run \`npm ci\` once there), for example: ${ENV}=<path to poc-node>/tests/helpers/test-relay.mjs npm run test:relay`;
const UUID = '0b8a7a52-7f0d-4f0e-8a56-2f0d3a1c9e11';

interface TestRelay {
  url: string;
  adminToken: string;
  machinePairingCode: () => Promise<string>;
  close: () => Promise<void>;
}

async function loadRelay(): Promise<TestRelay> {
  const given = process.env[ENV]?.trim();
  if (given === undefined || given === '') throw new Error(`${ENV} is not set: ${FIX}`);
  const file = resolve(given);
  if (!existsSync(file)) throw new Error(`${ENV} points to a file that does not exist (${file}): ${FIX}`);
  const loaded = (await import(pathToFileURL(file).href)) as { createTestRelay?: () => Promise<TestRelay> };
  if (typeof loaded.createTestRelay !== 'function') throw new Error(`${file} does not export createTestRelay: ${FIX}`);
  return loaded.createTestRelay();
}

let relay: TestRelay;
let configDir: string;

beforeAll(async () => {
  relay = await loadRelay();
  configDir = makeTempDir('app-module-machine-realrelay-');
  mkdirSync(join(configDir, '_secrets_'), { recursive: true });
  writeFileSync(join(configDir, '_secrets_', 'relay-admin.json'), JSON.stringify({ relayUrl: relay.url, token: relay.adminToken, label: 'test admin', claimedAt: '2026-11-20T00:00:00.000Z' }));
});

afterAll(async () => {
  if (configDir !== undefined) removeTempDir(configDir);
  if (relay !== undefined) await relay.close();
});

describe('listCandidacies against the real relay', () => {
  it('lists a candidacy posted by a machine token as approvable, with a sensible age', async () => {
    const claim = await fetch(`${relay.url}/api/pairings/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: await relay.machinePairingCode() }) });
    const machineToken = ((await claim.json()) as { token: string }).token;
    const { publicKey } = generateSigningKeyPair();
    const posted = await fetch(`${relay.url}/api/machines/candidacies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${machineToken}` },
      body: JSON.stringify({ name: 'thinkcentre', hostname: 'thinkcentre', identityPublicKey: publicKey, random: newCandidacyRandom(), uuid: UUID }),
    });
    expect(posted.status).toBe(201);

    // The raw list answer: the dates are ISO 8601 strings (this is the shape that broke the page).
    const raw = (await (await fetch(`${relay.url}/api/machines/candidacies`, { headers: { authorization: `Bearer ${relay.adminToken}` } })).json()) as { candidacies: Array<Record<string, unknown>> };
    expect(typeof raw.candidacies[0]?.['createdAt']).toBe('string');

    const nowSeconds = Math.floor(Date.now() / 1000);
    const views = await listCandidacies(configDir, nowSeconds);
    expect(views).toHaveLength(1);
    const view = views[0];
    expect(view?.problems).toEqual([]);
    expect(view?.name).toBe('thinkcentre');
    expect(view?.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(view?.ageSeconds).toBeLessThan(60);
    expect(view?.expiresAt).toBeGreaterThan(nowSeconds);
  });
});
