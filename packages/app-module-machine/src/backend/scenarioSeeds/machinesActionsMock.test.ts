import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyAliases, NETWORK_ALIASES_SUBJECT_UUID } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { machinesRoutes } from '../../commons/machinesMock.js';
import { machinesSeed, type MachinesSeedName } from '../../commons/machinesSeeds.js';
import { ALIASES_SUBJECT_UUID, type AliasesApplyAnswer, type AliasesContextAnswer, type RenameApplyAnswer, type RenameContextAnswer } from '../../commons/machinesActionsState.js';
import type { MachinesAnswer } from '../../commons/machinesState.js';
import { MODULE_PREFIX, type MockResponse, type MockRoutes } from '../../commons/mockRoutes.js';
import type { ErrorBody } from '../../commons/routeContracts.js';
import { expectNoRealData } from './privacyScan.testUtil.js';
import { ALLOWED_SCENARIO_KEY_STRINGS, KEYS, buildMachinesAliases } from './seedBuilders.testUtil.js';

// Rename and network aliases on the Machines page, on mock data: the routes of the pure state machine (src/commons/machinesState.ts), the refusals of the daemon in its
// words, the delivery each scenario plans and the retry. The page's own signing code runs on these routes in scenarioSigning.test.ts.

const ADMIN = '00000000-0000-4000-8000-000000000001';
const THINK = '00000000-0000-4000-8000-000000000002';
const MAC = '00000000-0000-4000-8000-000000000003';
const full = (key: string): string => `${key.split(' ')[0]} ${MODULE_PREFIX}${key.slice(key.indexOf(' ') + 1)}`;
const make = (name: MachinesSeedName): MockRoutes => machinesRoutes(machinesSeed(name));
const call = (routes: MockRoutes, key: string, params: Record<string, string> = {}, body?: unknown): MockResponse => {
  const handler = routes[full(key)];
  expect(handler, `the scenario answers no route ${key}`).toBeDefined();
  return (handler as NonNullable<typeof handler>)({ params, body });
};
const renameContext = (routes: MockRoutes, uuid: string): RenameContextAnswer => call(routes, 'GET /rename-context/:uuid', { uuid }).body as RenameContextAnswer;
const aliasesContext = (routes: MockRoutes): AliasesContextAnswer => call(routes, 'GET /aliases-context').body as AliasesContextAnswer;
const kind = (out: MockResponse): [number, string] => [out.status ?? 200, (out.body as ErrorBody).kind];

/** The body the page posts for a rename of `uuid` to `name`, with the registration the mock expects (the signature is not checked by a mock). */
function renameBody(routes: MockRoutes, uuid: string, name: string, over: { serial?: number } = {}) {
  const current = renameContext(routes, uuid).current;
  return { uuid, signed: { body: { ...current.body, name, serial: over.serial ?? current.body.serial + 1 }, signature: 'MOCK-UNSIGNED-NOT-A-SIGNATURE' }, documents: [], noticeRecipients: null };
}

describe('GET /rename-context/:uuid', () => {
  it('serves what the page needs: the registration held, the names and aliases that must not collide, the registrations of the others', () => {
    const body = renameContext(make('rename-delivered'), MAC);
    expect(body).toMatchObject({ ok: true, adminMachine: { uuid: ADMIN, name: 'midgard2' }, machine: { uuid: MAC, name: 'mac-m2', serial: 1 }, revokedUpTo: null, noticeRecipients: null });
    expect(body.current.body.uuid).toBe(MAC);
    expect(body.machines.map((m) => m.name)).toEqual(['midgard2', 'thinkcentre', 'mac-m2']);
    expect(body.others.map((r) => r.body.name)).toEqual(['thinkcentre']);
    expect(body.aliases).toEqual({ tc: THINK });
    expect(body.networkAliases).toEqual({});
  });

  it('refuses with the fix: a bad uuid (400), this machine (409 self), an unknown machine (409 not-trusted)', () => {
    const routes = make('rename-delivered');
    expect(kind(call(routes, 'GET /rename-context/:uuid', { uuid: 'nope' }))).toEqual([400, 'bad_request']);
    const self = call(routes, 'GET /rename-context/:uuid', { uuid: ADMIN });
    expect(kind(self)).toEqual([409, 'self']);
    expect((self.body as ErrorBody).error).toContain('admin machine itself');
    const unknown = call(routes, 'GET /rename-context/:uuid', { uuid: '00000000-0000-4000-8000-0000000000ff' });
    expect(kind(unknown)).toEqual([409, 'not-trusted']);
    expect((unknown.body as ErrorBody).error).toContain('only a machine this one trusts can be renamed');
  });
});

describe('POST /rename', () => {
  it('installs the new name: the next list and the next context say it; renaming again with the old context is refused (the serial moved)', () => {
    const routes = make('rename-delivered');
    const stale = renameBody(routes, MAC, 'box');
    const out = call(routes, 'POST /rename', {}, stale);
    expect(out.status).toBe(200);
    const answer = out.body as RenameApplyAnswer;
    expect([answer.ok, answer.failed, answer.subject, answer.retry]).toEqual([true, false, { uuid: MAC, name: 'box' }, 'machine admin rename box box']);
    expect(((call(routes, 'GET /machines').body as MachinesAnswer).machines).map((m) => m.name)).toEqual(['midgard2', 'thinkcentre', 'box']);
    expect(renameContext(routes, MAC).machine).toMatchObject({ name: 'box', serial: 2 });
    expect(kind(call(routes, 'POST /rename', {}, stale))).toEqual([422, 'bad-registration']);
  });

  it('refuses in the words of the daemon: a body that is not exactly the four fields, an unknown machine, a name used by another machine, a wrong serial; nothing changes', () => {
    const routes = make('rename-delivered');
    const body = renameBody(routes, MAC, 'box');
    const extra = call(routes, 'POST /rename', {}, { ...body, passphrase: 'x' });
    expect(kind(extra)).toEqual([400, 'bad_request']);
    expect((extra.body as ErrorBody).error).toContain('expected exactly');
    expect(kind(call(routes, 'POST /rename', {}, { ...body, uuid: '00000000-0000-4000-8000-0000000000ff' }))).toEqual([409, 'not-trusted']);
    const taken = call(routes, 'POST /rename', {}, renameBody(routes, MAC, 'thinkcentre'));
    expect(kind(taken)).toEqual([422, 'bad-registration']);
    expect((taken.body as ErrorBody).error).toMatch(/already used.*Nothing was installed/);
    expect(kind(call(routes, 'POST /rename', {}, renameBody(routes, MAC, 'box', { serial: 9 })))).toEqual([422, 'bad-registration']);
    expect(renameContext(routes, MAC).machine.name).toBe('mac-m2');
  });

  it('rename-delivered: every machine told took its documents directly, the renamed one included', () => {
    const routes = make('rename-delivered');
    const out = call(routes, 'POST /rename', {}, renameBody(routes, MAC, 'box')).body as RenameApplyAnswer;
    expect(out.machines.map((m) => [m.name, m.state])).toEqual([['thinkcentre', 'delivered'], ['box', 'delivered']]);
    expect(out.text.err).toBe('');
  });

  it('rename-partial: thinkcentre took it, the renamed machine did not (failed): the retry command is in the report, and one retry delivers it to the relay inbox, then nothing is retained', () => {
    const routes = make('rename-partial');
    const out = call(routes, 'POST /rename', {}, renameBody(routes, MAC, 'box')).body as RenameApplyAnswer;
    expect([out.failed, out.machines.map((m) => [m.name, m.state])]).toEqual([true, [['thinkcentre', 'delivered'], ['box', 'failed']]]);
    expect(out.text.err).toContain('machine admin rename box box');
    expect(out.text.err).toContain('the rename stands');
    const retry = call(routes, 'POST /delivery-retry', {}, { uuid: MAC });
    const again = retry.body as { failed: boolean; machines: Array<{ name: string; state: string }> };
    expect([retry.status, again.failed, again.machines.map((m) => [m.name, m.state])]).toEqual([200, false, [['thinkcentre', 'delivered'], ['box', 'inbox']]]);
    expect(kind(call(routes, 'POST /delivery-retry', {}, { uuid: MAC }))).toEqual([409, 'nothing-retained']);
  });

  it('rename-failed: the relay refuses everything, both machines failed', () => {
    const routes = make('rename-failed');
    const out = call(routes, 'POST /rename', {}, renameBody(routes, MAC, 'box')).body as RenameApplyAnswer;
    expect(out.machines.map((m) => m.state)).toEqual(['failed', 'failed']);
    expect(out.text.err).toContain('the relay refused');
  });
});

describe('GET /aliases-context', () => {
  it('alias-set: the signed list held (verifiable with the scenario key), the machines, the local aliases that win, the recipients', () => {
    const body = aliasesContext(make('alias-set'));
    expect(body.ok).toBe(true);
    expect(body.current).not.toBeNull();
    expect(verifyAliases(body.current as never, { adminPublicKey: KEYS.admin.publicKey })).toMatchObject({ ok: true });
    expect(body.current?.body.entries).toEqual([{ alias: 'tc', uuid: MAC }, { alias: 'work', uuid: THINK }]);
    expect(body.machines.map((m) => m.name)).toEqual(['midgard2', 'thinkcentre', 'mac-m2']);
    expect(body.localAliases).toEqual({ tc: THINK });
    expect(body.revoked).toEqual([]);
    expect(body.recipients.map((r) => r.body.name)).toEqual(['thinkcentre', 'mac-m2']);
  });

  it('alias-conflict has no network alias yet (current is null) and the same local alias', () => {
    const body = aliasesContext(make('alias-conflict'));
    expect([body.current, body.localAliases]).toEqual([null, { tc: THINK }]);
  });

  it('peer-revoked-earlier: the revoked machine is listed as revoked', () => {
    expect(aliasesContext(make('peer-revoked-earlier')).revoked).toEqual([MAC]);
  });
});

describe('the Aliases column of GET /machines (UX review 5)', () => {
  const cell = (routes: MockRoutes, name: string): string | undefined => (call(routes, 'GET /machines').body as MachinesAnswer).machines.find((m) => m.name === name)?.aliasesText;

  it('shows the network aliases next to the local ones, each with its origin (a label a local alias shadows is the local one)', () => {
    const routes = make('alias-set');
    // The network list holds tc for mac-m2 and work for thinkcentre; the local alias tc for thinkcentre wins on this machine.
    expect(cell(routes, 'thinkcentre')).toBe('tc (local), work (network)');
    expect(cell(routes, 'mac-m2')).toBe('');
  });

  it('a row with only local aliases stays plain; a machine without alias is empty', () => {
    const routes = make('alias-conflict');
    expect(cell(routes, 'thinkcentre')).toBe('tc');
    expect(cell(routes, 'mac-m2')).toBe('');
  });

  it('after an alias is added the machine row shows it at once (network, signed by the page)', () => {
    const routes = make('alias-conflict');
    const entries = [{ alias: 'box', uuid: MAC }];
    const current = aliasesContext(routes).current;
    const body = { signed: { body: { v: 1, adminKeyId: KEYS.admin.publicKey.slice(0, 32), serial: (current?.body.serial ?? 0) + 1, issuedAt: 1, entries }, signature: 'MOCK-UNSIGNED-NOT-A-SIGNATURE' }, documents: [] };
    expect(call(routes, 'POST /aliases', {}, body).status).toBe(200);
    expect(cell(routes, 'mac-m2')).toBe('box (network)');
    expect(cell(routes, 'thinkcentre')).toBe('tc');
  });

  it('this machine row shows the aliases that point to it', () => {
    const routes = make('alias-conflict');
    const body = { signed: { body: { v: 1, adminKeyId: KEYS.admin.publicKey.slice(0, 32), serial: 1, issuedAt: 1, entries: [{ alias: 'home', uuid: ADMIN }] }, signature: 'MOCK-UNSIGNED-NOT-A-SIGNATURE' }, documents: [] };
    expect(call(routes, 'POST /aliases', {}, body).status).toBe(200);
    expect(cell(routes, 'midgard2')).toBe('home (network)');
  });
});

describe('POST /aliases', () => {
  const listWith = (routes: MockRoutes, entries: Array<{ alias: string; uuid: string }>, serial?: number) => {
    const current = aliasesContext(routes).current;
    return { signed: { body: { v: 1, adminKeyId: KEYS.admin.publicKey.slice(0, 32), serial: serial ?? (current?.body.serial ?? 0) + 1, issuedAt: 1, entries }, signature: 'MOCK-UNSIGNED-NOT-A-SIGNATURE' }, documents: [] };
  };

  it('keeps the new list: the next context holds it; the same list again is refused as stale (the serial must grow)', () => {
    const routes = make('alias-set');
    const entries = [{ alias: 'box', uuid: MAC }, { alias: 'tc', uuid: MAC }, { alias: 'work', uuid: THINK }];
    const body = listWith(routes, entries);
    const out = call(routes, 'POST /aliases', {}, body);
    expect(out.status).toBe(200);
    const answer = out.body as AliasesApplyAnswer;
    expect([answer.ok, answer.changed, answer.retry, answer.entries.map((e) => [e.alias, e.name])]).toEqual([true, true, 'machine admin alias send', [['box', 'mac-m2'], ['tc', 'mac-m2'], ['work', 'thinkcentre']]]);
    expect(aliasesContext(routes).current?.body.entries).toEqual(entries);
    expect(kind(call(routes, 'POST /aliases', {}, body))).toEqual([409, 'stale-aliases']);
  });

  it('refuses in the words of the daemon: a body that is not exactly { signed, documents }, a list that is more than one change away from the held one; nothing changes', () => {
    const routes = make('alias-set');
    const extra = call(routes, 'POST /aliases', {}, { ...listWith(routes, []), passphrase: 'x' });
    expect(kind(extra)).toEqual([400, 'bad_request']);
    expect((extra.body as ErrorBody).error).toContain('expected exactly');
    const two = call(routes, 'POST /aliases', {}, listWith(routes, [{ alias: 'a', uuid: MAC }, { alias: 'b', uuid: MAC }, { alias: 'tc', uuid: MAC }, { alias: 'work', uuid: THINK }]));
    expect(kind(two)).toEqual([422, 'bad-aliases']);
    expect((two.body as ErrorBody).error).toMatch(/exactly one alias.*Nothing was installed/);
    expect(aliasesContext(routes).current?.body.entries).toHaveLength(2);
  });

  it('alias-remove: removing the last alias leaves an empty list that is still a list; the plan delivers directly to both machines', () => {
    const routes = make('alias-remove');
    const held = aliasesContext(routes).current?.body.entries ?? [];
    expect(held.length).toBeGreaterThan(0);
    let out: AliasesApplyAnswer | undefined;
    for (const e of held) {
      const rest = (aliasesContext(routes).current?.body.entries ?? []).filter((x) => x.alias !== e.alias);
      out = call(routes, 'POST /aliases', {}, listWith(routes, rest)).body as AliasesApplyAnswer;
    }
    expect((out as AliasesApplyAnswer).machines.map((m) => [m.name, m.state])).toEqual([['thinkcentre', 'delivered'], ['mac-m2', 'delivered']]);
    expect(aliasesContext(routes).current?.body.entries).toEqual([]);
  });

  it('alias-partial: thinkcentre took the list, mac-m2 failed; the retry (under the reserved subject uuid) delivers it, once', () => {
    const routes = make('alias-partial');
    const out = call(routes, 'POST /aliases', {}, listWith(routes, [{ alias: 'box', uuid: MAC }])).body as AliasesApplyAnswer;
    expect([out.failed, out.machines.map((m) => [m.name, m.state])]).toEqual([true, [['thinkcentre', 'delivered'], ['mac-m2', 'failed']]]);
    expect(out.text.err).toContain('machine admin alias send');
    const retry = call(routes, 'POST /delivery-retry', {}, { uuid: NETWORK_ALIASES_SUBJECT_UUID });
    expect([retry.status, (retry.body as { failed: boolean }).failed]).toEqual([200, false]);
    expect(kind(call(routes, 'POST /delivery-retry', {}, { uuid: NETWORK_ALIASES_SUBJECT_UUID }))).toEqual([409, 'nothing-retained']);
  });
});

describe('the seeded aliases lists', () => {
  it('hold no real data, and no key-like string but the signatures of the scenario key', () => {
    const text = readFileSync(fileURLToPath(new URL('../../commons/scenarioSeeds/machines-aliases.json', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
    expectNoRealData(text);
    const signatures = Object.values(JSON.parse(text) as Record<string, { signature: string }>).map((l) => l.signature);
    const allowed = new Set<string>([...signatures, ...ALLOWED_SCENARIO_KEY_STRINGS]);
    for (const token of text.match(/[A-Za-z0-9_-]{40,}/g) ?? []) expect(allowed.has(token), `unexpected key-like string ${token.slice(0, 12)}...`).toBe(true);
  });
});

describe('machines-aliases.json', () => {
  it('is what the builder signs (rewrite it with WRITE_SEEDS=1 npm test --workspace=packages/app-module-machine -- machinesActionsMock)', () => {
    const path = fileURLToPath(new URL('../../commons/scenarioSeeds/machines-aliases.json', import.meta.url));
    const built = `${JSON.stringify(buildMachinesAliases(), null, 2)}\n`;
    if (process.env['WRITE_SEEDS'] === '1') writeFileSync(path, built);
    expect(readFileSync(path, 'utf8').replace(/\r\n/g, '\n')).toBe(built);
  });
});

describe('the reserved subject uuid of the aliases', () => {
  it('is the one of machine-core: the mock keeps the retry of the aliases under the key the page uses', () => {
    expect(ALIASES_SUBJECT_UUID).toBe(NETWORK_ALIASES_SUBJECT_UUID);
  });
});
