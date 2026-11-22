import { describe, expect, it } from 'vitest';
import { checkConsistency, describeHoldLimit, parseHoldLimits, readHoldLimits, resolveHoldLimits } from './holdLimits.js';

describe('readHoldLimits (lenient: what the daemon does)', () => {
  it('keeps the valid fields', () => {
    expect(readHoldLimits({ v: 1, perPeer: 3, perMachine: 7 })).toEqual({ setting: { v: 1, perPeer: 3, perMachine: 7 }, problems: [] });
  });

  it('drops only the bad field and names it, with the range', () => {
    const r = readHoldLimits({ v: 1, perPeer: 99, perMachine: 7 });
    expect(r.setting).toEqual({ v: 1, perMachine: 7 });
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/"perPeer" must be a whole number from 1 to 20, got 99/);
  });

  it.each([
    ['a string', 'x'],
    ['zero', 0],
    ['a fraction', 2.5],
    ['negative', -1],
  ])('refuses perMachine as %s', (_n, value) => {
    expect(readHoldLimits({ v: 1, perMachine: value }).problems[0]).toMatch(/"perMachine" must be a whole number from 1 to 50/);
  });

  it('reports a structure it cannot read and keeps nothing', () => {
    expect(readHoldLimits([]).problems[0]).toMatch(/not an object/);
    expect(readHoldLimits({ v: 2, perPeer: 3 })).toMatchObject({ setting: { v: 1 }, problems: ['"v" must be 1'] });
  });

  it('reports an unknown field', () => {
    expect(readHoldLimits({ v: 1, perpeer: 3 }).problems[0]).toMatch(/unknown field "perpeer"/);
  });
});

describe('parseHoldLimits (strict: what the command that writes does)', () => {
  it('throws the first problem', () => {
    expect(() => parseHoldLimits({ v: 1, perPeer: 21 })).toThrow(/"perPeer" must be a whole number from 1 to 20/);
  });

  it('refuses a per-machine value below the per-peer one, naming both and the fix', () => {
    expect(() => parseHoldLimits({ v: 1, perPeer: 8, perMachine: 6 })).toThrow(/per machine \(6\) must be at least the limit per peer \(8\)/);
  });

  it('checks the EFFECTIVE values: a per-peer above the built-in per-machine default needs both', () => {
    expect(checkConsistency({ v: 1, perPeer: 15 })).toMatch(/10, the built-in default.*--per-machine 30/);
    expect(checkConsistency({ v: 1, perPeer: 15, perMachine: 15 })).toBeUndefined();
  });
});

describe('resolveHoldLimits', () => {
  it('defaults to 5 per peer and 10 per machine, built-in', () => {
    expect(resolveHoldLimits(undefined)).toEqual({ limits: { perPeer: 5, perMachine: 10, perPeerSource: 'built-in', perMachineSource: 'built-in' }, problems: [] });
  });

  it('uses the setting per value', () => {
    const { limits } = resolveHoldLimits({ v: 1, perPeer: 2 });
    expect(limits).toMatchObject({ perPeer: 2, perPeerSource: 'setting', perMachine: 10, perMachineSource: 'built-in' });
  });

  it('raises a per-machine value below the per-peer one and says so', () => {
    const { limits, problems } = resolveHoldLimits({ v: 1, perPeer: 12 });
    expect(limits.perMachine).toBe(12);
    expect(problems[0]).toMatch(/using 12 per machine/);
  });

  it('describes a value with its origin', () => {
    expect(describeHoldLimit(5, 'built-in')).toBe('5 (built-in default)');
    expect(describeHoldLimit(3, 'setting')).toBe('3 (setting hold-limits)');
  });
});
