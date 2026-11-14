import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli } from './testing.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'machine-advertise-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('machine daemon --advertise', () => {
  it('a bad value is a usage error naming the option and the expected form, before anything starts', async () => {
    const r = await cli(dir, ['daemon', '--advertise', 'http://evil.example']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--advertise "http:\/\/evil\.example"/);
    expect(r.err).toMatch(/<host\[:port\]>/);
  });

  it('refuses the same address twice and more than 8 addresses', async () => {
    const twice = await cli(dir, ['daemon', '--advertise', 'a.example:1', '--advertise', 'a.example:1']);
    expect(twice.code).toBe(2);
    expect(twice.err).toMatch(/twice/);
    const many = await cli(dir, ['daemon', ...Array.from({ length: 9 }, (_, i) => ['--advertise', `h${i}.example`]).flat()]);
    expect(many.code).toBe(2);
    expect(many.err).toMatch(/at most 8/);
  });

  it('is refused on every other command instead of being ignored', async () => {
    const r = await cli(dir, ['status', '--advertise', 'a.example']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--advertise only applies to `machine daemon`/);
  });

  it('needs a value', async () => {
    const r = await cli(dir, ['daemon', '--advertise']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--advertise needs a value/);
  });

  it('is documented in the help', async () => {
    const r = await cli(dir, ['--help']);
    expect(r.out).toMatch(/daemon .*--advertise <host\[:port\]>/);
  });
});
