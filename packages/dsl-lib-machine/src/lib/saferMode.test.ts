import { describe, expect, it } from 'vitest';
import { DEFAULT_SAFER_MODE, readSaferMode, SAFER_MODE_KEY, writeSaferMode } from './saferMode.js';
import type { StyleStorage } from './allowStyle.js';

const memory = (initial: Record<string, string> = {}): StyleStorage & { data: Record<string, string> } => {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
};

describe('safer mode preference (confirm risky lifetimes), scoped to the module', () => {
  it('the key is scoped to the machine module and the default is OFF', () => {
    expect(SAFER_MODE_KEY).toBe('machine:requests:saferMode');
    expect(DEFAULT_SAFER_MODE).toBe(false);
  });

  it('reads off when nothing is stored', () => {
    expect(readSaferMode(memory())).toEqual({ on: false });
  });

  it('round-trips both values', () => {
    const s = memory();
    expect(writeSaferMode(s, true)).toBeUndefined();
    expect(s.data[SAFER_MODE_KEY]).toBe('on');
    expect(readSaferMode(s)).toEqual({ on: true });
    writeSaferMode(s, false);
    expect(readSaferMode(s)).toEqual({ on: false });
  });

  it('a foreign stored value is reported and off is used', () => {
    const r = readSaferMode(memory({ [SAFER_MODE_KEY]: 'maybe' }));
    expect(r.on).toBe(false);
    expect(r.problem).toMatch(/"maybe" is not on or off/);
  });

  it('a storage that cannot be read or written is reported', () => {
    const broken: StyleStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(readSaferMode(broken).problem).toMatch(/blocked/);
    expect(writeSaferMode(broken, true)).toMatch(/quota/);
  });
});
