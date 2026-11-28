import {
  ALIASES_DOMAIN as CORE_DOMAIN,
  MAX_ALIASES as CORE_MAX,
  aliasConflicts as coreConflicts,
  assertAliasesBody as coreAssert,
  planAliasChange as corePlan,
  signAliases as coreSign,
  verifyAliases,
  type AliasChangeInput,
  type AliasEntry,
  type AliasesBody,
} from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { newPair, uuid, webKeyFrom } from '../test-support/kit.js';
import { ALIASES_DOMAIN, MAX_ALIASES, aliasConflicts, assertAliasesBody, planAliasChange, signAliases } from './aliases.js';
import { keyId } from './keys.js';

// Network aliases (decision 116) as the page signs them: copies of machine-core aliases.ts, tested equal.

const NOW = 1_800_000_000;
const A = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const B = '7a1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const C = '8b1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const messageOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return 'NO ERROR';
};

describe('constants', () => {
  it('are the ones of machine-core', () => {
    expect(ALIASES_DOMAIN).toBe(CORE_DOMAIN);
    expect(MAX_ALIASES).toBe(CORE_MAX);
  });
});

describe('assertAliasesBody', () => {
  const ok: AliasesBody = { v: 1, adminKeyId: 'a'.repeat(32), serial: 5, issuedAt: 5, entries: [{ alias: 'box', uuid: A }] };
  const bodies: unknown[] = [
    ok,
    { ...ok, entries: [] },
    null, [], 'x', { ...ok, v: 2 }, { ...ok, extra: 1 }, { ...ok, adminKeyId: 'zz' }, { ...ok, serial: 0 }, { ...ok, issuedAt: 0 }, { ...ok, entries: 'x' },
    { ...ok, entries: [{ alias: 'Box', uuid: A }] }, { ...ok, entries: [{ alias: 'box', uuid: 'nope' }] }, { ...ok, entries: [{ alias: 'box', uuid: A, x: 1 }] },
    { ...ok, entries: [{ alias: 'box', uuid: A }, { alias: 'box', uuid: B }] }, { ...ok, entries: [{ alias: 'zed', uuid: A }, { alias: 'box', uuid: B }] },
    { ...ok, entries: [null] }, { ...ok, entries: [{ alias: 3, uuid: A }] },
    { ...ok, entries: Array.from({ length: 65 }, (_, i) => ({ alias: `a${String(i).padStart(2, '0')}x`, uuid: A })) },
  ];
  it.each(bodies.map((b, i) => [i, b] as const))('accepts and refuses like machine-core, message for message (case %i)', (_i, body) => {
    expect(messageOf(() => assertAliasesBody(body))).toBe(messageOf(() => coreAssert(body)));
  });
});

describe('planAliasChange', () => {
  const machines = [{ uuid: A, name: 'thinkcentre' }, { uuid: B, name: 'mac-m2' }, { uuid: C, name: 'desk' }];
  const current: AliasEntry[] = [{ alias: 'laptop', uuid: B }];
  const many = Array.from({ length: 64 }, (_, i) => ({ alias: `x${i.toString(36)}-a${i}`, uuid: A }));
  const inputs: AliasChangeInput[] = [
    { change: { action: 'set', alias: 'box', uuid: A }, current, machines, revoked: [] },
    { change: { action: 'set', alias: 'Box!', uuid: A }, current, machines, revoked: [] },
    { change: { action: 'set', alias: '!!!', uuid: A }, current, machines, revoked: [] },
    { change: { action: 'set', alias: 'box', uuid: A }, current, machines, revoked: [A] },
    { change: { action: 'set', alias: 'box', uuid: uuid() }, current, machines, revoked: [] },
    { change: { action: 'set', alias: 'desk', uuid: A }, current, machines, revoked: [] },
    { change: { action: 'set', alias: 'mac-m-2', uuid: A }, current, machines: [...machines, { uuid: uuid(), name: 'macm2' }], revoked: [] },
    { change: { action: 'set', alias: 'laptop', uuid: B }, current, machines, revoked: [] },
    { change: { action: 'set', alias: 'laptop', uuid: A }, current, machines, revoked: [] },
    { change: { action: 'set', alias: 'lap-top', uuid: A }, current, machines, revoked: [] },
    { change: { action: 'set', alias: 'one-more', uuid: A }, current: many, machines, revoked: [] },
    { change: { action: 'rm', alias: 'Laptop' }, current, machines, revoked: [] },
    { change: { action: 'rm', alias: 'nope' }, current, machines, revoked: [] },
    { change: { action: 'rm', alias: 'nope' }, current: [], machines, revoked: [] },
  ];
  it.each(inputs.map((input, i) => [i, input] as const))('gives the answer of machine-core (case %i)', (_i, input) => {
    expect(planAliasChange(input)).toEqual(corePlan(input));
  });
});

describe('aliasConflicts', () => {
  it('gives the answer of machine-core', () => {
    const cases: Array<[Record<string, string>, Record<string, string>]> = [
      [{ box: A }, { box: B }],
      [{ box: A }, { box: A.toUpperCase() }],
      [{ box: A }, {}],
      [{ toString: A }, {}],
      [{ box: A, desk: B }, { box: B, desk: B }],
    ];
    for (const [local, network] of cases) expect(aliasConflicts(local, network)).toEqual(coreConflicts(local, network));
  });
});

describe('signAliases', () => {
  it('signs a list that machine-core verifies against the admin key, and refuses a body no machine would read', async () => {
    const pair = newPair();
    const key = await webKeyFrom(pair);
    const body: AliasesBody = { v: 1, adminKeyId: await keyId(pair.publicKey), serial: NOW, issuedAt: NOW, entries: [{ alias: 'box', uuid: A }] };
    const signed = await signAliases(body, key);
    expect(verifyAliases(signed, { adminPublicKey: pair.publicKey })).toMatchObject({ ok: true });
    // Same bytes as the machine-core signature of the same body (Ed25519 is deterministic).
    expect(signed.signature).toBe(coreSign(body, pair.privateKeyPkcs8).signature);
    await expect(signAliases({ ...body, serial: 0 }, key)).rejects.toThrow(/aliases: serial must be a positive integer/);
  });
});
