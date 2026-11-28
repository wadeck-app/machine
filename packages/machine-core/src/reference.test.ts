import { describe, expect, it } from 'vitest';
import { isUuid, machineNameProblem, normalizeMachineName, resolveMachineRef, type MachineEntry } from './reference.js';

const DESKTOP = '1b4e28ba-2fa1-4d3b-a3f4-0123456789ab';
const LAPTOP = '9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345';
const BOX = '1b4e99aa-0000-4000-8000-000000000000';

const machines: MachineEntry[] = [
  { uuid: DESKTOP, name: 'desktop' },
  { uuid: LAPTOP, name: 'work-laptop' },
  { uuid: BOX, name: 'box' },
];

describe('resolveMachineRef', () => {
  it('resolves a full UUID, whatever its case', () => {
    expect(resolveMachineRef(DESKTOP.toUpperCase(), machines, {})).toEqual({ ok: true, uuid: DESKTOP, via: 'uuid' });
  });

  it('resolves a name, case-insensitively', () => {
    expect(resolveMachineRef('Work-Laptop', machines, {})).toEqual({ ok: true, uuid: LAPTOP, via: 'name' });
  });

  it('resolves a local alias, and the alias wins over a machine name', () => {
    const aliases = { box: DESKTOP, wl: LAPTOP };
    expect(resolveMachineRef('wl', machines, aliases)).toEqual({ ok: true, uuid: LAPTOP, via: 'alias' });
    expect(resolveMachineRef('BOX', machines, aliases)).toEqual({ ok: true, uuid: DESKTOP, via: 'alias' });
  });

  it('resolves a unique UUID prefix of at least 4 hex characters', () => {
    expect(resolveMachineRef('9c5d', machines, {})).toEqual({ ok: true, uuid: LAPTOP, via: 'prefix' });
    expect(resolveMachineRef('9c5d1e2f-3a', machines, {})).toEqual({ ok: true, uuid: LAPTOP, via: 'prefix' });
  });

  it('refuses an ambiguous prefix and lists the candidates', () => {
    const r = resolveMachineRef('1b4e', machines, {});
    expect(r).toMatchObject({ ok: false, reason: 'ambiguous' });
    if (!r.ok) {
      expect(r.candidates.map((c) => c.name).sort()).toEqual(['box', 'desktop']);
      expect(r.message).toMatch(/desktop.*box|box.*desktop/);
      expect(r.message).toMatch(/longer prefix/);
    }
  });

  it('refuses two machines with the same name and tells how to disambiguate', () => {
    const twins: MachineEntry[] = [
      { uuid: DESKTOP, name: 'pc' },
      { uuid: LAPTOP, name: 'PC' },
    ];
    const r = resolveMachineRef('pc', twins, {});
    expect(r).toMatchObject({ ok: false, reason: 'ambiguous' });
    if (!r.ok) expect(r.message).toMatch(/UUID|alias/);
  });

  it('does not treat a prefix shorter than 4 characters as a prefix', () => {
    expect(resolveMachineRef('9c5', machines, {})).toMatchObject({ ok: false, reason: 'unknown' });
  });

  it('lists the known machines when the reference is unknown', () => {
    const r = resolveMachineRef('nas', machines, {});
    expect(r).toMatchObject({ ok: false, reason: 'unknown' });
    if (!r.ok) expect(r.message).toMatch(/"nas".*desktop.*work-laptop.*box/);
  });

  it('says so when no machine is registered at all', () => {
    const r = resolveMachineRef('nas', [], {});
    if (!r.ok) expect(r.message).toMatch(/no machine is registered/);
  });

  it('names a dangling alias instead of calling it unknown', () => {
    const r = resolveMachineRef('old', machines, { old: '00000000-0000-4000-8000-000000000000' });
    expect(r).toMatchObject({ ok: false, reason: 'unknown' });
    if (!r.ok) expect(r.message).toMatch(/alias "old".*not registered/);
  });

  it.each(['', ' ', 'a'.repeat(65), 'two words', '../etc', 'C:\\x', 'caf\u00e9'])('refuses the invalid reference %j', (ref) => {
    expect(resolveMachineRef(ref, machines, {})).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('resolveMachineRef with network aliases (decision 116)', () => {
  it('resolves a network alias, case-insensitively, and says it came from the network', () => {
    expect(resolveMachineRef('Nas', machines, {}, { nas: LAPTOP })).toEqual({ ok: true, uuid: LAPTOP, via: 'network-alias' });
  });

  it('a local alias wins over a network alias of the same label', () => {
    expect(resolveMachineRef('nas', machines, { nas: DESKTOP }, { nas: LAPTOP })).toEqual({ ok: true, uuid: DESKTOP, via: 'alias' });
  });

  it('a network alias that equals the name of ANOTHER machine is ambiguous and names both candidates', () => {
    const r = resolveMachineRef('box', machines, {}, { box: LAPTOP });
    expect(r).toMatchObject({ ok: false, reason: 'ambiguous' });
    if (!r.ok) {
      expect(r.candidates.map((c) => c.name).sort()).toEqual(['box', 'work-laptop']);
      expect(r.message).toMatch(/network alias of work-laptop.*machine named "box"/s);
      expect(r.message).toMatch(/UUID|prefix/);
    }
  });

  it('a network alias that equals the name of the SAME machine resolves by name', () => {
    expect(resolveMachineRef('box', machines, {}, { box: BOX })).toEqual({ ok: true, uuid: BOX, via: 'name' });
  });

  it('names a dangling network alias instead of calling it unknown', () => {
    const r = resolveMachineRef('old', machines, {}, { old: '00000000-0000-4000-8000-000000000000' });
    expect(r).toMatchObject({ ok: false, reason: 'unknown' });
    if (!r.ok) expect(r.message).toMatch(/network alias "old".*not trusted here/);
  });

  it('still resolves names, prefixes and uuids when network aliases exist', () => {
    const network = { nas: LAPTOP };
    expect(resolveMachineRef('desktop', machines, {}, network)).toMatchObject({ ok: true, uuid: DESKTOP, via: 'name' });
    expect(resolveMachineRef('9c5d', machines, {}, network)).toMatchObject({ ok: true, uuid: LAPTOP, via: 'prefix' });
    expect(resolveMachineRef(DESKTOP, machines, {}, network)).toMatchObject({ ok: true, via: 'uuid' });
  });
});

describe('machineNameProblem', () => {
  it.each(['desktop', 'work-laptop', 'pc2', 'a'])('accepts %j', (name) => {
    expect(machineNameProblem(name)).toBeUndefined();
  });

  it.each([
    ['', /empty|1 to 32/],
    ['-start', /start/],
    ['has space', /letters, digits/],
    ['UPPER', /lowercase/],
    ['a'.repeat(33), /1 to 32/],
    ['beef', /hexadecimal/],
    ['1b4e28ba', /hexadecimal/],
    ['caf\u00e9', /letters, digits/],
  ])('refuses %j', (name, message) => {
    expect(machineNameProblem(name)).toMatch(message);
  });
});

describe('normalizeMachineName (decision 52: a typed or derived name is made valid, never refused for its case)', () => {
  it.each([
    ['desktop', 'desktop', false],
    ['Midgard2', 'midgard2', true],
    ['DESKTOP-ABC123', 'desktop-abc123', true],
    ['My Laptop', 'my-laptop', true],
    ['  Work_PC  ', 'work-pc', true],
    [`caf${String.fromCharCode(0xe9)} box`, 'cafe-box', true],
    ['--a--b--', 'a-b', true],
    ['LAPTOP.local', 'laptop-local', true],
  ])('%j becomes %j (changed: %s)', (input, name, changed) => {
    expect(normalizeMachineName(input)).toEqual({ ok: true, name, changed });
  });

  it('cuts to 32 characters without a trailing hyphen', () => {
    const r = normalizeMachineName(`${'a'.repeat(31)} ${'b'.repeat(10)}`);
    expect(r).toMatchObject({ ok: true, changed: true });
    if (r.ok) {
      expect(r.name.length).toBeLessThanOrEqual(32);
      expect(r.name.endsWith('-')).toBe(false);
    }
  });

  it('never returns a hexadecimal-only name (it would look like a UUID prefix): it is prefixed', () => {
    expect(normalizeMachineName('BEEF')).toEqual({ ok: true, name: 'host-beef', changed: true });
    expect(normalizeMachineName('1b4e28ba')).toEqual({ ok: true, name: 'host-1b4e28ba', changed: true });
    const long = normalizeMachineName('f'.repeat(40));
    expect(long).toMatchObject({ ok: true });
    if (long.ok) expect(machineNameProblem(long.name)).toBeUndefined();
  });

  it.each(['', '   ', '---', String.fromCharCode(0x65e5, 0x672c), '...'])('fails on %j with the way out', (input) => {
    const r = normalizeMachineName(input);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.message).toMatch(/letters or digits.*--name/s);
  });

  it('whatever it returns passes machineNameProblem', () => {
    for (const input of ['Midgard2', 'Zz', 'A', '9', 'ab', 'abc', 'DEAD', 'a-b-c-d', 'X'.repeat(80)]) {
      const r = normalizeMachineName(input);
      expect(r.ok && machineNameProblem(r.name), input).toBeFalsy();
    }
  });
});

describe('isUuid', () => {
  it('accepts a UUID of any version, in either case, and nothing else', () => {
    expect(isUuid('1b4e28ba-2fa1-4d3b-a3f4-0123456789ab')).toBe(true);
    expect(isUuid('1B4E28BA-2FA1-1D3B-A3F4-0123456789AB')).toBe(true);
    expect(isUuid('1b4e28ba2fa14d3ba3f40123456789ab')).toBe(false);
    expect(isUuid('nope')).toBe(false);
  });
});
