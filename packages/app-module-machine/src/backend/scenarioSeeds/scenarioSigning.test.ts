import { decryptAdminKey, type AdminKeyEnvelope } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { adminKeyHint } from '@wadeck-app/machine-webcrypto';
import { readAdminKeyHint } from '../../../../dsl-lib-machine/src/lib/allowFlow.js';
import { checkApprovable, loadApproveContext, signAndApprove, type ApproveRow } from '../../../../dsl-lib-machine/src/lib/approveFlow.js';
import { loadRevokeContext, signAndRevoke } from '../../../../dsl-lib-machine/src/lib/revokeFlow.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { candidaciesRoutes } from '../../commons/candidaciesMock.js';
import type { CandidaciesState } from '../../commons/candidaciesState.js';
import { machinesRoutes } from '../../commons/machinesMock.js';
import { machinesSeed, type MachinesSeedName } from '../../commons/machinesSeeds.js';
import type { MachinesAnswer } from '../../commons/machinesState.js';
import { MODULE_PREFIX, type MockRoutes } from '../../commons/mockRoutes.js';
import type { CandidaciesAnswer } from '../../commons/routeContracts.js';
import { SCENARIO_PASSPHRASE, SCENARIOS } from '../../commons/scenarioList.js';
import { KEYS, NOW } from './seedBuilders.testUtil.js';

// The scenarios where something can be signed run the REAL code of the page (unlock, assertPinnedKey, buildApproval / buildDistribution / buildRevocation, the
// delivery summary) against the mock routes, with the PUBLISHED passphrase of the throwaway scenario key: the result views can be reached in a browser. The mock
// POST routes verify nothing beyond the shape, so what is proved here is that the page's own signing path accepts the seeds end to end.

const PASSPHRASE = 'scenario-passphrase-2026';
const SEEDS_DIR = fileURLToPath(new URL('../../commons/scenarioSeeds/', import.meta.url));
const seed = (name: string): CandidaciesState => JSON.parse(readFileSync(`${SEEDS_DIR}${name}.json`, 'utf8')) as CandidaciesState;

interface Recorded { method: string; path: string }

// The AllowApi of the page, answered by the mock routes (a status of 400 or more rejects with the message, as the shell's fetcher does).
function apiOver(routes: MockRoutes): { api: { elevate(): Promise<void>; get(p: string): Promise<unknown>; post(p: string, b: unknown): Promise<unknown> }; sent: Recorded[] } {
  const sent: Recorded[] = [];
  const call = (method: string, path: string, body?: unknown): unknown => {
    sent.push({ method, path });
    for (const [key, handler] of Object.entries(routes)) {
      const [m, pattern] = [key.slice(0, key.indexOf(' ')), key.slice(key.indexOf(' ') + 1 + MODULE_PREFIX.length)];
      const names: string[] = [];
      const regex = new RegExp(`^${pattern.replace(/:(\w+)/g, (_x, n: string) => { names.push(n); return '([^/]+)'; })}$`);
      const found = regex.exec(path);
      if (m !== method || found === null) continue;
      const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(found[i + 1] as string)]));
      const out = handler({ params, body });
      if ((out.status ?? 200) >= 400) throw new Error((out.body as { error: string }).error);
      return out.body;
    }
    throw new Error(`the scenario answers no route ${method} ${path}`);
  };
  return { api: { async elevate() {}, async get(p) { return call('GET', p); }, async post(p, b) { return call('POST', p, b); } }, sent };
}

describe('the throwaway admin key of the scenarios', () => {
  it('is published: the constant of the scenario list is the passphrase the hints give', () => {
    expect(SCENARIO_PASSPHRASE).toBe(PASSPHRASE);
  });

  it('the file served by the scenarios unlocks with it and is the admin key every seed registration is signed by; its hint says what it is', async () => {
    for (const file of [seed('one-pending').adminKeyFile, machinesSeed('two-trusted-peers').adminKeyFile]) {
      const envelope = JSON.parse(file) as AdminKeyEnvelope;
      expect(envelope.publicKey).toBe(KEYS.admin.publicKey);
      expect(Buffer.from(decryptAdminKey(envelope, PASSPHRASE).privateKeyPkcs8).equals(Buffer.from(KEYS.admin.privateKeyPkcs8))).toBe(true);
      expect(adminKeyHint(file)).toContain('scenario key');
      expect(adminKeyHint(file)).toContain('trusted by nothing');
    }
  });

  it('every scenario where something can be signed publishes the passphrase in its hint, and none still says placeholder', () => {
    const signable = SCENARIOS.filter((s) => !['empty', 'relay-error-503', 'relay-unreachable-502', 'internal-error-500', 'pending-with-problems', 'candidate-expired', 'approval-codes-recallable', 'only-this-machine'].includes(s.id));
    expect(signable.length).toBe(12);
    for (const s of signable) expect(s.hint, s.id).toContain(`passphrase ${PASSPHRASE}`);
    for (const s of SCENARIOS) expect(s.hint, s.id).not.toMatch(/placeholder/i);
  });
});

describe('Approve, by the real code of the page, with the published passphrase', () => {
  const NOW_S = NOW;
  const open = async (name: string) => {
    const routes = candidaciesRoutes(seed(name), () => NOW_S);
    const rig = apiOver(routes);
    const list = (await rig.api.get('/candidacies')) as CandidaciesAnswer;
    const row = list.candidacies.find((r) => r.canApprove) as unknown as ApproveRow;
    const context = await loadApproveContext(rig.api as never, row);
    return { routes, rig, row, context };
  };

  it.each([
    ['one-pending', 'delivered', 'none'],
    ['approve-result-delivered', 'delivered', 'delivered'],
    ['approve-result-partial', 'delivered', 'partial'],
    ['approve-result-failed', 'partial', 'failed'],
  ] as const)('%s: reaches the result with the security code and one line per machine', async (name, status, plan) => {
    const { rig, row, context } = await open(name);
    const checked = await checkApprovable(row, context);
    const result = await signAndApprove(rig.api as never, context, row, PASSPHRASE, NOW_S, {});
    expect(result.finalCode).toBe(checked.finalCode);
    expect(result.finalCode).toMatch(/^\d{5}( \d{5}){4}$/);
    expect(rig.sent.map((s) => `${s.method} ${s.path}`).slice(-3)).toEqual(['GET /admin-key', `POST /candidacies/${row.id}/approve`, 'POST /approve-distribute']);
    if (plan === 'none') {
      // The mock plans a delivery to the candidate itself even when nobody else is trusted.
      expect(result.distribution.machines.length).toBeGreaterThan(0);
    } else {
      expect(result.distribution.machines.map((m) => m.state)).toEqual(plan === 'delivered' ? ['delivered', 'delivered'] : plan === 'partial' ? ['inbox', 'delivered'] : ['failed', 'failed']);
    }
    expect(result.distribution.status).toBe(status);
  });

  it('the approval changes the next list: the row is approved', async () => {
    const { rig, row, context, routes } = await open('approve-result-delivered');
    await signAndApprove(rig.api as never, context, row, PASSPHRASE, NOW_S, {});
    const after = (await apiOver(routes).api.get('/candidacies')) as CandidaciesAnswer;
    expect(after.candidacies[0]).toMatchObject({ relayStatus: 'approved', canApprove: false });
  });

  it('a wrong passphrase is the normal refusal of the page, and nothing is posted', async () => {
    const { rig, row, context } = await open('one-pending');
    await expect(signAndApprove(rig.api as never, context, row, 'another passphrase of twelve', NOW_S, {})).rejects.toThrow('admin key file: wrong passphrase or damaged key file');
    expect(rig.sent.filter((s) => s.method === 'POST')).toEqual([]);
  });

  it('the page reads the hint of the key from the route', async () => {
    const { rig } = await open('one-pending');
    expect(await readAdminKeyHint(rig.api as never)).toContain('scenario key');
  });
});

describe('Revoke, by the real code of the page, with the published passphrase', () => {
  const open = async (name: MachinesSeedName) => {
    const routes = machinesRoutes(machinesSeed(name));
    const rig = apiOver(routes);
    const list = (await rig.api.get('/machines')) as MachinesAnswer;
    const row = list.machines.find((m) => m.name === 'mac-m2') ?? list.machines.find((m) => !m.self);
    if (row === undefined) throw new Error(`${name}: no peer to revoke`);
    const context = await loadRevokeContext(rig.api as never, row as never);
    return { routes, rig, row, context };
  };

  it.each([
    ['revoke-delivered', 'delivered', ['delivered']],
    ['revoke-partial', 'delivered', ['inbox']],
    ['revoke-failed', 'partial', ['failed']],
    ['relay-unreachable', 'partial', ['failed', 'failed']],
  ] as const)('%s: reaches the result with the per-machine lines', async (name, status, states) => {
    const { rig, row, context } = await open(name);
    const result = await signAndRevoke(rig.api as never, context, PASSPHRASE, NOW, {});
    expect(rig.sent.map((s) => `${s.method} ${s.path}`).slice(-2)).toEqual(['GET /admin-key', 'POST /revoke']);
    expect(result.name).toBe(row.name);
    expect(result.distribution.machines.map((m) => m.state)).toEqual(states);
    expect(result.distribution.status).toBe(status);
  });

  it('the revocation changes the next list: the peer is gone', async () => {
    const { rig, context, routes } = await open('revoke-delivered');
    await signAndRevoke(rig.api as never, context, PASSPHRASE, NOW, {});
    const after = (await apiOver(routes).api.get('/machines')) as MachinesAnswer;
    expect(after.machines.map((m) => m.name)).not.toContain('mac-m2');
  });

  it('a wrong passphrase is the normal refusal of the page, and nothing is posted', async () => {
    const { rig, context } = await open('two-trusted-peers');
    await expect(signAndRevoke(rig.api as never, context, 'another passphrase of twelve', NOW, {})).rejects.toThrow('admin key file: wrong passphrase or damaged key file');
    expect(rig.sent.filter((s) => s.method === 'POST')).toEqual([]);
  });
});
