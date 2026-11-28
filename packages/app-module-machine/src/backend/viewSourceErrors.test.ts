import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// A failed `$sources` load raises a generic shell toast ("The action failed (HTTP 503): Could not load the data: ...", whole message, never dismissed by itself), unless
// the page reads `$ctx.$sourceErrors.<source>` (app-core: the shell then leaves the failure to the page). So every source of the Candidacies and Machines pages must be read
// through `$ctx.$sourceErrors` in the YAML AND handled by the component that shows the alert: a new source added without its alert fails here.

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

// The YAML without its comments (a comment that names `$sourceErrors` proves nothing).
const code = (yaml: string): string => yaml.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

// The keys of `$sources:` (two-space indented keys of the first block).
function sourceKeys(yaml: string): string[] {
  const lines = code(yaml).split('\n');
  const start = lines.findIndex((l) => l.startsWith('$sources:'));
  if (start < 0) throw new Error('the view has no $sources block: this test would prove nothing');
  const keys: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line !== '' && !line.startsWith(' ')) break;
    const key = /^ {2}([A-Za-z][\w-]*):/.exec(line)?.[1];
    if (key !== undefined) keys.push(key);
  }
  return keys;
}

const PAGES = [
  { page: 'candidacies', yaml: '../dsl-views/candidacies.yaml', component: '../../../dsl-lib-machine/src/components/CandidaciesTable.tsx' },
  { page: 'machines', yaml: '../dsl-views/machines.yaml', component: '../../../dsl-lib-machine/src/components/MachinesTable.tsx' },
];

describe.each(PAGES)('$page page: every source has its own alert, so the shell raises no generic toast for it', ({ yaml, component }) => {
  const text = read(yaml);
  const keys = sourceKeys(text);

  it('has at least one source (the test is not vacuous)', () => {
    expect(keys.length).toBeGreaterThan(0);
  });

  it('the YAML gives the component the failed sources: `sourceErrors: $ctx.$sourceErrors`', () => {
    expect(code(text)).toMatch(/^\s+sourceErrors: \$ctx\.\$sourceErrors\s*$/m);
  });

  it.each(keys)('the component reads the failure of the source "%s"', (key) => {
    expect(read(component)).toContain(`sourceErrors?.['${key}']`);
  });
});
