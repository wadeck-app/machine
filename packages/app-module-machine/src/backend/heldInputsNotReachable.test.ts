import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// `heldInputs` (daemon command of machine-cli) returns the payloads of held requests, which may hold secrets (stdin-input.md, T-70). It is for the terminal of the owner
// only (`machine requests`): no route of this module may call it, and no generic route may forward a command name it did not fix itself.

const DIR = fileURLToPath(new URL('.', import.meta.url));
const sources = readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.testUtil.ts'));

describe('the payloads of held requests are not reachable from the page', () => {
  it('there are backend sources to read', () => {
    expect(sources.length).toBeGreaterThan(5);
  });
  it.each(sources)('%s names no heldInputs command', (file) => {
    expect(readFileSync(DIR + file, 'utf8')).not.toMatch(/heldInputs/);
  });
  it('every command name passed to the daemon by a route is a literal fixed in the source, never read from a request', () => {
    const text = readFileSync(DIR + 'index.ts', 'utf8');
    const calls = [...text.matchAll(/viaDaemon\(req, reply, ([^,]+),/g)].map((m) => (m[1] ?? '').trim());
    expect(calls.length).toBeGreaterThan(3);
    for (const name of calls) expect(name, name).toMatch(/^'[A-Za-z]+'$/);
  });
});
