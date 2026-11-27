import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// jsdom cannot measure layout: this pins the RULE chosen in the view. dsl-ui's DataTable gives a content column (no width, truncate, nowrap or muted) the
// class `break-all`, which breaks words in the middle ("v erification") when the neighbouring nowrap columns squeeze it; `nowrap: true` gives it
// `whitespace-nowrap` instead (the table scrolls horizontally when a long cause widens it).
const yaml = readFileSync(fileURLToPath(new URL('../dsl-views/candidacies.yaml', import.meta.url)), 'utf8');

describe('candidacies view', () => {
  it('every DataTable column is nowrap, so none falls back to the break-all content class of dsl-ui', () => {
    const columns = yaml.split('\n').filter(l => /^\s*- \{ key: /.test(l));
    expect(columns.length).toBeGreaterThanOrEqual(5);
    const wrapping = columns.filter(l => !/\bnowrap: true\b/.test(l));
    expect(wrapping, `columns without nowrap (they break words mid-word): ${wrapping.join(' | ')}`).toEqual([]);
  });

  it('the timeline steps come from the source (no hard-coded status), and the followed candidacy is shown', () => {
    expect(yaml).toContain('steps: $sources.candidacies.timeline');
    expect(yaml).not.toMatch(/^\s*status: (todo|done|current)\s*$/m);
    expect(yaml).not.toContain('static');
    expect(yaml).toContain('$sources.candidacies.timelineNote');
  });

  it('says the CLI steps are not observable on this page', () => {
    expect(yaml).toMatch(/subtitle:.*machine admin approve.*not observable/);
  });
});

describe('candidacies view: the Reject row action (a restricting action, no signature)', () => {
  it('posts to the reject route with the row id, asks a confirmation and reloads the list', () => {
    expect(yaml).toMatch(/\$actions:\s*\n\s+reject:/);
    expect(yaml).toContain('url: POST /api/modules/machine/candidacies/{id}/reject');
    expect(yaml).toMatch(/confirm:.*reject/i);
    expect(yaml).toContain('reloadSources: [candidacies]');
  });

  it('the actions column offers Reject only on a row that can still be decided, and uses no custom component or style', () => {
    expect(yaml).toMatch(/type: actions[\s\S]*label: Reject[\s\S]*action: reject[\s\S]*condition: canDecide/);
    expect(yaml).not.toMatch(/className|style:/);
  });

  it('never claims the page approves: approving, the code and the distribution stay in the CLI, said in the subtitle', () => {
    expect(yaml).toMatch(/subtitle:.*Reject.*machine admin approve/);
    expect(yaml).not.toMatch(/Read-only/);
  });
});
