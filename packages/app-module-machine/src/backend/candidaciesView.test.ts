import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The view of the Candidacies page. The table and the timeline are ONE component (machine:CandidaciesTable): the approval dialog lays what the page proves over
// the steps of the module, so both need the same state. The columns, their nowrap rule and the buttons live in the component (dsl-lib-machine tests).
const yaml = readFileSync(fileURLToPath(new URL('../dsl-views/candidacies.yaml', import.meta.url)), 'utf8');

describe('candidacies view', () => {
  it('the table and the timeline are ONE component, bound to the sources (no hard-coded status, no standard DataTable here)', () => {
    expect(yaml).toContain('$type: machine:CandidaciesTable');
    expect(yaml).toContain('rows: $sources.candidacies.candidacies');
    expect(yaml).toContain('timeline: $sources.candidacies.timeline');
    expect(yaml).not.toContain('$type: DataTable');
    expect(yaml).not.toMatch(/^\s*status: (todo|done|current)\s*$/m);
    expect(yaml).not.toContain('static');
  });

  it('shows the followed candidacy (the note of the timeline)', () => {
    expect(yaml).toContain('$sources.candidacies.timelineNote');
  });

  it('the subtitle is ONE sentence (UX review): what the page is for. The approval and the terminal command are said where they are used (dialog, row expansion)', () => {
    const subtitle = /^\s+subtitle:\s*(.*)$/m.exec(yaml)?.[1] ?? '';
    expect(subtitle).not.toBe('');
    // One sentence: no full stop followed by another sentence.
    expect(subtitle).not.toMatch(/\.\s+\S/);
    expect(subtitle.length).toBeLessThanOrEqual(120);
    expect(yaml).not.toMatch(/not observable|not built|Read-only/);
  });

  it('the empty state is the one of the component (it names the next step), not a bare "No pending candidacy" set here', () => {
    expect(yaml).not.toMatch(/emptyMessage:/);
  });
});

describe('candidacies view: the Reject action (a restricting action, no signature)', () => {
  it('posts to the reject route with the row id, asks a confirmation and reloads the list; the component calls it by name', () => {
    expect(yaml).toMatch(/\$actions:\s*\n\s+reject:/);
    expect(yaml).toContain('url: POST /api/modules/machine/candidacies/{id}/reject');
    expect(yaml).toMatch(/confirm:.*reject/i);
    expect(yaml).toContain('reloadSources: [candidacies]');
  });

  it('carries no style of its own', () => {
    expect(yaml).not.toMatch(/className|style:/);
  });
});
