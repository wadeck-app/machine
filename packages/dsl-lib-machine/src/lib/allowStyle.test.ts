import { describe, expect, it } from 'vitest';
import { ALLOW_STYLE_KEY, DEFAULT_ALLOW_STYLE, readAllowStyle, writeAllowStyle, type StyleStorage } from './allowStyle.js';

const memory = (initial: Record<string, string> = {}): StyleStorage & { data: Record<string, string> } => {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
};

describe('allow style preference (Dialog | Inline), scoped to the module', () => {
  it('the key is scoped to the machine module and the default is inline', () => {
    expect(ALLOW_STYLE_KEY).toBe('machine:requests:allowStyle');
    expect(DEFAULT_ALLOW_STYLE).toBe('inline');
  });

  it('reads the default when nothing is stored', () => {
    expect(readAllowStyle(memory())).toEqual({ style: 'inline' });
  });

  it('round-trips both choices', () => {
    const s = memory();
    expect(writeAllowStyle(s, 'dialog')).toBeUndefined();
    expect(s.data[ALLOW_STYLE_KEY]).toBe('dialog');
    expect(readAllowStyle(s)).toEqual({ style: 'dialog' });
    writeAllowStyle(s, 'inline');
    expect(readAllowStyle(s)).toEqual({ style: 'inline' });
  });

  it('a stored value that is not a style is reported, not silently used, and the default applies', () => {
    const r = readAllowStyle(memory({ [ALLOW_STYLE_KEY]: 'popup' }));
    expect(r.style).toBe('inline');
    expect(r.problem).toMatch(/"popup".*Dialog or Inline/);
  });

  it('unreadable storage is reported with the consequence', () => {
    const broken: StyleStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => undefined };
    expect(readAllowStyle(broken)).toMatchObject({ style: 'inline', problem: expect.stringMatching(/denied.*not remembered/) });
  });

  it('a write that fails says the choice is kept for this page only', () => {
    const broken: StyleStorage = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    expect(writeAllowStyle(broken, 'dialog')).toMatch(/quota.*this page only/);
  });
});
