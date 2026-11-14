import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAliases, removeAlias, setAlias } from './state.js';

const A = '1b4e28ba-2fa1-4d3b-a3f4-0123456789ab';
const B = '9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'machine-state-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('aliases', () => {
  it('starts empty', () => {
    expect(readAliases(dir)).toEqual({});
  });

  it('stores and reads an alias', () => {
    setAlias(dir, 'wl', A);
    expect(readAliases(dir)).toEqual({ wl: A });
  });

  it('repoints an alias only when asked to, and says what it replaced', () => {
    setAlias(dir, 'wl', A);
    expect(() => setAlias(dir, 'wl', B)).toThrow(new RegExp(`alias "wl" already points to ${A}`));
    expect(setAlias(dir, 'wl', B, { replace: true })).toEqual({ previous: A });
    expect(readAliases(dir)).toEqual({ wl: B });
  });

  it('refuses an invalid alias or UUID with the reason', () => {
    expect(() => setAlias(dir, 'Bad Alias', A)).toThrow(/name/);
    expect(() => setAlias(dir, 'ok', 'not-a-uuid')).toThrow(/UUID/);
  });

  it('removes an alias and refuses to remove an unknown one', () => {
    setAlias(dir, 'wl', A);
    removeAlias(dir, 'wl');
    expect(readAliases(dir)).toEqual({});
    expect(() => removeAlias(dir, 'wl')).toThrow(/no alias "wl"/);
  });

  it('names the file when it is corrupt instead of starting empty', () => {
    writeFileSync(join(dir, 'state.json'), '{not json');
    expect(() => readAliases(dir)).toThrow(/state\.json.*(corrupt|invalid)/);
  });
});
