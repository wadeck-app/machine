import { describe, expect, it } from 'vitest';
import { machineNameProblem, resolveMachineRef, type MachineEntry } from './reference.js';

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
