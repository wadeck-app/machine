import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileRoutes, defineScenarios, matchScenarioRoute, type ScenarioDefinition } from '@wadeck-app/app-core-sdk/scenarios';
import { unlockAdminKey } from '@wadeck-app/machine-webcrypto';
import { describe, expect, it } from 'vitest';
import { MACHINES_SEED_NAMES } from '../../commons/machinesSeeds.js';
import { SCENARIOS as scenarios, SCENARIO_PASSPHRASE } from '../../commons/scenarioList.js';
import { expectNoRealData } from './privacyScan.testUtil.js';
import { KEYS } from './seedBuilders.testUtil.js';

// The scenarios of the module (src/dsl-scenarios, dev-only mocks of two pages). The routes themselves are proved in candidaciesMock.test.ts and machinesMock.test.ts;
// here: the list, what the shell needs of each entry, that every route the views call is answered by the SDK's own matcher, that the throwaway admin key unlocks with the published passphrase and fails the way
// the page reports, and that nothing Node or real ships in the scenario code.

const CANDIDACY_SEEDS = [
  'empty',
  'one-pending',
  'several-pending',
  'pending-revoked-earlier',
  'pending-with-problems',
  'relay-error-503',
  'relay-unreachable-502',
  'internal-error-500',
  'approve-result-delivered',
  'approve-result-partial',
  'approve-result-failed',
  'approval-codes-recallable',
  'candidate-expired',
];

const CANDIDACY_ROUTES = [
  'GET /api/modules/machine/candidacies',
  'GET /api/modules/machine/admin-key',
  'GET /api/modules/machine/approve-context/00000000-0000-4000-8000-000000000003',
  'POST /api/modules/machine/candidacies/cand-mac-m2-01/approve',
  'POST /api/modules/machine/candidacies/cand-mac-m2-01/reject',
  'POST /api/modules/machine/approve-distribute',
  'POST /api/modules/machine/delivery-retry',
  'POST /api/modules/machine/approval-codes',
  'GET /api/modules/machine/admin-login',
  'POST /api/modules/machine/admin-login',
  'POST /api/modules/machine/admin-login/cancel',
];
const MACHINES_ROUTES = [
  'GET /api/modules/machine/machines',
  'GET /api/modules/machine/admin-key',
  'GET /api/modules/machine/revoke-context/00000000-0000-4000-8000-000000000003',
  'POST /api/modules/machine/revoke',
  'POST /api/modules/machine/delivery-retry',
];

const list: readonly ScenarioDefinition[] = scenarios;
const onPage = (page: string): ScenarioDefinition[] => list.filter((s) => s.pages?.includes(page));

describe('the list of scenarios', () => {
  it('has a scenario per seed of the Candidacies page and per seed of the Machines page, nothing else', () => {
    expect(onPage('/candidacies').map((s) => s.id)).toEqual(CANDIDACY_SEEDS);
    expect(onPage('/').map((s) => s.id)).toEqual([...MACHINES_SEED_NAMES]);
    expect(list).toHaveLength(CANDIDACY_SEEDS.length + MACHINES_SEED_NAMES.length);
  });

  it('every scenario names its page (none is offered on a page it does not fit), has unique ids, a label and a one-line hint', () => {
    const ids = list.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of list) {
      expect(s.pages, s.id).toHaveLength(1);
      expect(s.label.trim(), s.id).not.toBe('');
      expect(s.label, s.id).not.toContain('\n');
      expect(s.hint?.trim() ?? '', s.id).not.toBe('');
      expect(s.hint, s.id).not.toContain('\n');
    }
  });

  it('create() answers every route of its page through the matcher of the SDK, and starts again at each call (Reset)', () => {
    for (const [page, routes] of [['/candidacies', CANDIDACY_ROUTES], ['/', MACHINES_ROUTES]] as const) {
      for (const s of onPage(page)) {
        const compiled = compileRoutes(s.create().routes);
        for (const route of routes) {
          const [method, path] = route.split(' ') as [string, string];
          expect(matchScenarioRoute(compiled, method, path), `${s.id}: ${route}`).toBeDefined();
        }
        expect(s.create().routes, s.id).not.toBe(s.create().routes);
      }
    }
  });

  it('every route a view calls is one a scenario of its page answers', () => {
    const dir = fileURLToPath(new URL('../../dsl-views/', import.meta.url));
    const compiled = (page: string) => compileRoutes((onPage(page)[0] as ScenarioDefinition).create().routes);
    for (const [file, page] of [['candidacies.yaml', '/candidacies'], ['machines.yaml', '/']] as const) {
      const text = readFileSync(`${dir}${file}`, 'utf8');
      const urls = [...text.matchAll(/\b(GET|POST|PUT|DELETE)\s+(\/api\/modules\/machine\/[^\s"'`?]*)/g)];
      expect(urls.length, `${file} calls the backend`).toBeGreaterThan(0);
      for (const [, method, path] of urls) expect(matchScenarioRoute(compiled(page), method as string, path as string), `${file}: ${method} ${path}`).toBeDefined();
    }
  });

  it('is accepted by defineScenarios of the SDK, and src/dsl-scenarios/index.ts default-exports exactly that call (src/backend cannot import it: the module check forbids it)', () => {
    expect(defineScenarios(list)).toHaveLength(list.length);
    const wrapper = readFileSync(fileURLToPath(new URL('../../dsl-scenarios/index.ts', import.meta.url)), 'utf8');
    expect(wrapper).toMatch(/import \{ defineScenarios \} from '@wadeck-app\/app-core-sdk\/scenarios';/);
    expect(wrapper).toMatch(/export default defineScenarios\(SCENARIOS\);/);
  });

  it('a route no scenario defines is not answered (the shell then fails it with a 404 naming it, never sends it to the real backend)', () => {
    const compiled = compileRoutes((onPage('/candidacies')[0] as ScenarioDefinition).create().routes);
    expect(matchScenarioRoute(compiled, 'GET', '/api/modules/machine/requests')).toBeUndefined();
  });
});

describe('the throwaway admin key, as the page meets it', () => {
  it('is served by the scenarios: the published passphrase unlocks it (the key of the seeds), another one fails with the sentence of a wrong passphrase (the dialog shows it and stays open)', async () => {
    for (const [page, id] of [['/candidacies', 'one-pending'], ['/', 'two-trusted-peers']] as const) {
      const scenario = onPage(page).find((s) => s.id === id) as ScenarioDefinition;
      const handler = scenario.create().routes['GET /api/modules/machine/admin-key'];
      const answer = (handler as NonNullable<typeof handler>)({ method: 'GET', path: '/api/modules/machine/admin-key', params: {}, query: new URLSearchParams(), body: undefined });
      const file = (answer as { body: { file: string } }).body.file;
      const unlocked = await unlockAdminKey(file, SCENARIO_PASSPHRASE, { extractable: false });
      expect(unlocked.publicKey).toBe(KEYS.admin.publicKey);
      unlocked.lock();
      await expect(unlockAdminKey(file, 'a passphrase of at least twelve characters', { extractable: false })).rejects.toThrow('admin key file: wrong passphrase or damaged key file');
    }
  });
});

describe('what the scenario code ships', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const shipped = [
    'dsl-scenarios/index.ts',
    'commons/scenarioList.ts',
    ...readdirSync(`${root}commons`).filter((f) => /^(machines|candidacies|mock)[A-Za-z]*\.ts$/.test(f)).map((f) => `commons/${f}`),
  ];

  it('lists the files of the scenario code', () => {
    expect(shipped).toEqual(expect.arrayContaining(['dsl-scenarios/index.ts', 'commons/scenarioList.ts', 'commons/machinesMock.ts', 'commons/machinesSeeds.ts', 'commons/candidaciesMock.ts', 'commons/mockRoutes.ts']));
  });

  it.each(shipped)('%s imports no Node module and touches no Node global', (file) => {
    const text = readFileSync(`${root}${file}`, 'utf8');
    expect(text).not.toMatch(/from 'node:|require\(|\bimport\(/);
    expect(text).not.toMatch(/\b(process|Buffer|__dirname)\b\s*[.(\[]/);
    expect(text).not.toMatch(/from '(fs|path|os|child_process|crypto|http|net)'/);
  });

  it.each(shipped)('%s holds no real data of a network (made-up uuids, documentation addresses, no key-like string)', (file) => {
    // The names of the packages (`@wadeck-app/...`, in imports and comments) are not data.
    const text = readFileSync(`${root}${file}`, 'utf8').replace(/@wadeck-app\/[\w-]+(?:\/[\w-]+)*/g, '');
    expectNoRealData(text);
    expect(text.match(/[A-Za-z0-9_-]{40,}/g) ?? []).toEqual([]);
  });
});
