import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkValue as webCheck, parseTypeSpec as webParse } from './typedParams.js';
import { parseLifetime as webLifetime } from './lifetime.js';
import { classifyReadOnly as webReadOnly } from './readOnly.js';
import { matchTemplate as webMatch, parseTemplate as webTemplate } from './template.js';
import { classifyReadOnly as coreReadOnly, checkValue as coreCheck, matchTemplate as coreMatch, parseLifetime as coreLifetime, parseTemplate as coreTemplate, parseTypeSpec as coreParse } from '@wadeck-app/machine-core';

// The browser builds the next policy itself, so the pure typed-parameter modules of machine-core are COPIED here (typed-parameters.md). The
// copies must be byte for byte the originals (no import, no dependency): one source of truth, checked by this test.

const here = dirname(fileURLToPath(import.meta.url));
const core = join(here, '..', '..', 'machine-core', 'src');
const normalize = (text: string): string => text.replace(/\r\n/g, '\n');
const FILES = ['typedParams.ts', 'template.ts', 'lifetime.ts', 'readOnly.ts', 'inputDeclaration.ts'];

describe('the typed-parameter modules are byte for byte the ones of machine-core', () => {
  it.each(FILES)('%s', (file) => {
    const original = normalize(readFileSync(join(core, file), 'utf8'));
    expect(original.length).toBeGreaterThan(500);
    expect(normalize(readFileSync(join(here, file), 'utf8'))).toBe(original);
  });

  it('answer the same on a sample (the copy is the one that is linked)', () => {
    const type = 'int(1,500)';
    for (const value of ['1', '500', '0', '501', '-1', '01', 'x;id']) expect(webCheck(webParse(type), value, 'posix')).toEqual(coreCheck(coreParse(type), value, 'posix'));
    const text = 'orch logs <j:name> --tail=<n:int(1,5)>';
    for (const line of ['orch logs a --tail=3', 'orch logs a --tail=9', 'orch logs a;b --tail=3']) expect(webMatch(webTemplate(text, 'sh'), line, 'posix')).toEqual(coreMatch(coreTemplate(text, 'sh'), line, 'posix'));
    expect(webLifetime({ times: '3' }, 1_800_000_000)).toEqual(coreLifetime({ times: '3' }, 1_800_000_000));
    for (const line of ['ls', 'ls; id', 'systemctl show x -p y --no-pager', 'ethtool enp0s31f6', 'ethtool -s enp0s31f6 advertise 0x008']) expect(webReadOnly('sh', line)).toEqual(coreReadOnly('sh', line));
  });
});
