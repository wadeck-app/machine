import { INPUT_CHAR_NAMES } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliRaw } from './testing.js';

// A folder that never exists: these commands stop before any configuration is read.
const NOWHERE = join(tmpdir(), 'machine-stdin-help-nowhere');

// Feature detection and the pointer of the refusals (decision 114): task-owner reads `machine run --help` for `--stdin`, and the refusal of a character points to
// `machine admin allow --help`, which must name every family, `utf8-text` included.

describe('help', () => {
  it('the `run <machine>` entry of `machine run --help` lists --stdin (feature detection reads that text)', async () => {
    const r = await cliRaw(NOWHERE, ['run', '--help']);
    expect(r.code).toBe(0);
    const entry = r.out.split('\n').find((l) => l.trimStart().startsWith('run <machine>'));
    expect(entry, r.out).toBeDefined();
    expect(entry).toContain('--stdin <file|->');
    expect(r.out).toMatch(/stdin of the command/i);
  });

  it('`machine admin allow --help` names every family and the whole-text family, the size and the format', async () => {
    const r = await cliRaw(NOWHERE, ['admin', 'allow', '--help']);
    expect(r.code).toBe(0);
    for (const name of INPUT_CHAR_NAMES) expect(r.out, name).toContain(name);
    expect(r.out).toMatch(/utf8-text[^\n]*any/i);
    expect(r.out).toContain('--stdin-max');
    expect(r.out).toContain('--stdin-chars');
    expect(r.out).toMatch(/512k|512 KiB/);
  });

  it('`machine policy allow --help` has the same flags', async () => {
    const r = await cliRaw(NOWHERE, ['policy', 'allow', '--help']);
    expect(r.out).toContain('--stdin-chars');
    expect(r.out).toContain('utf8-text');
  });

  it('the global help describes --json: one document for every outcome, and the codes', async () => {
    const r = await cliRaw(NOWHERE, ['--help']);
    expect(r.out).toMatch(/one document|ONE document/);
    for (const code of ['refused:not-allowed', 'refused:input-not-allowed', 'refused:input-too-large', 'refused:input-chars', 'refused:input-format', 'unreachable', 'timeout', 'denied', 'target-too-old', 'unknown-machine', 'usage']) expect(r.out, code).toContain(code);
  });
});

describe('the flags of the declaration are refused where they mean nothing', () => {
  it('--stdin-chars without --stdin, and --stdin on another command', async () => {
    const a = await cliRaw(NOWHERE, ['admin', 'allow', 'laptop', '--stdin-chars', 'letters', '--', 'x']);
    expect(a.code).toBe(2);
    expect(a.err).toMatch(/--stdin-chars/);
    const b = await cliRaw(NOWHERE, ['status', '--stdin', 'json']);
    expect(b.code).toBe(2);
    expect(b.err).toMatch(/--stdin only applies/);
  });
  it('--stdin json without --stdin-chars is refused with the fix, before anything is signed', async () => {
    const r = await cliRaw(NOWHERE, ['admin', 'allow', 'laptop', '--stdin', 'json', '--', 'x']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--stdin-chars/);
    expect(r.err).toMatch(/Nothing was signed/);
  });
  it('an unknown family and xml are refused naming the fix', async () => {
    const a = await cliRaw(NOWHERE, ['admin', 'allow', 'laptop', '--stdin', 'json', '--stdin-chars', 'letters+nope', '--', 'x']);
    expect(a.code).toBe(2);
    expect(a.err).toMatch(/nope/);
    const b = await cliRaw(NOWHERE, ['admin', 'allow', 'laptop', '--stdin', 'xml', '--stdin-chars', 'letters', '--', 'x']);
    expect(b.code).toBe(2);
    expect(b.err).toMatch(/text or json/);
  });
});
