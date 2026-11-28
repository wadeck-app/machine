import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SOURCE_ROUTES, SOURCE_SUBJECTS } from '../../../dsl-lib-machine/src/lib/loadFailure.js';

// A failed `$sources` load raises a generic shell toast ("The action failed (HTTP 503): Could not load the data: ...", whole message, never dismissed by itself), unless
// the page reads `$ctx.$sourceErrors.<source>` (app-core: the shell then leaves the failure to the page). So EVERY source of EVERY view must be read through
// `$ctx.$sourceErrors` in the YAML AND handled by the component that shows the notice (machine:SourceFailureNotice: what the failure is, Retry, the login button of a
// missing token, Copy details): a new source or a new view added without its notice fails here.

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

// The YAML without its comments (a comment that names `$sourceErrors` proves nothing).
const code = (yaml: string): string => yaml.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

// The sources of the first `$sources:` block: key and url (the two-space indented keys and their four-space `url:`). No block: none.
function sourcesOf(yaml: string): Array<{ key: string; url: string }> {
  const lines = code(yaml).split('\n');
  const start = lines.findIndex((l) => l.startsWith('$sources:'));
  if (start < 0) return [];
  const found: Array<{ key: string; url: string }> = [];
  for (const line of lines.slice(start + 1)) {
    if (line !== '' && !line.startsWith(' ')) break;
    const key = /^ {2}([A-Za-z][\w-]*):/.exec(line)?.[1];
    if (key !== undefined) found.push({ key, url: '' });
    const url = /^ {4}url:\s*(.+?)\s*$/.exec(line)?.[1];
    if (url !== undefined && found.length > 0) found[found.length - 1]!.url = url;
  }
  return found;
}

const COMPONENTS = '../../../dsl-lib-machine/src/components/';

// Every view of the module. A view that is not listed here fails the "every view is covered" test below.
const PAGES = [
  { page: 'candidacies', yaml: 'candidacies.yaml', component: 'CandidaciesTable.tsx' },
  { page: 'machines', yaml: 'machines.yaml', component: 'MachinesTable.tsx' },
  { page: 'requests', yaml: 'requests.yaml', component: 'RequestsOverview.tsx' },
  { page: 'allowed', yaml: 'allowed.yaml', component: 'AllowedList.tsx' },
];

describe('every view of the module is covered by this test', () => {
  it('the views folder holds exactly the views listed here and the Activity view (which reads its route itself)', () => {
    const files = readdirSync(fileURLToPath(new URL('../dsl-views/', import.meta.url))).filter((f) => f.endsWith('.yaml')).sort();
    expect(files).toEqual([...PAGES.map((p) => p.yaml), 'activity.yaml'].sort());
  });
});

describe.each(PAGES)('$page page: every source has its own notice, so the shell raises no generic toast for it', ({ yaml, component }) => {
  const text = read(`../dsl-views/${yaml}`);
  const sources = sourcesOf(text);

  it('has at least one source (the test is not vacuous)', () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it('the YAML gives the component the failed sources: `sourceErrors: $ctx.$sourceErrors`', () => {
    expect(code(text)).toMatch(/^\s+sourceErrors: \$ctx\.\$sourceErrors\s*$/m);
  });

  it.each(sources.map((s) => s.key))('the component reads the failure of the source "%s"', (key) => {
    expect(read(`${COMPONENTS}${component}`)).toContain(`sourceErrors?.['${key}']`);
  });

  it.each(sources.map((s) => [s.key, s.url]))('the source "%s" is a route the notice names in Copy details, with a sentence for what it holds', (key, url) => {
    expect(SOURCE_ROUTES[key as string]).toBe(url);
    expect(SOURCE_SUBJECTS[key as string]).toBeDefined();
  });

  it('the component hands the failure to the notice of the page (what it is, Retry), not to a text of its own', () => {
    expect(read(`${COMPONENTS}${component}`)).toContain('<SourceFailureNotice');
  });
});

describe('activity page: no $sources, the component reads its own route and tells its failure with the same notice', () => {
  const view = read('../dsl-views/activity.yaml');

  it('declares no source (a source added here must join PAGES above, with its notice)', () => {
    expect(sourcesOf(view)).toEqual([]);
  });

  it('the component names its route and its source in the notice', () => {
    const component = read(`${COMPONENTS}ActivityLog.tsx`);
    expect(component).toContain('<SourceFailureNotice source="activity"');
    expect(component).toContain(SOURCE_ROUTES['activity']!.replace('GET ', '').replace('/api/modules/machine', ''));
  });
});
