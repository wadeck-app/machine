import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// jsdom cannot measure layout: this pins the RULE chosen in the view. dsl-ui's DataTable gives a content column (no width, truncate, nowrap or muted) the
// class `break-all`, which breaks words in the middle ("v erification") when the neighbouring nowrap columns squeeze it; `nowrap: true` gives it
// `whitespace-nowrap` instead (the table scrolls horizontally when a long cause widens it).
const yaml = readFileSync(fileURLToPath(new URL('./candidacies.yaml', import.meta.url)), 'utf8');

describe('candidacies view', () => {
  it('every DataTable column is nowrap, so none falls back to the break-all content class of dsl-ui', () => {
    const columns = yaml.split('\n').filter(l => /^\s*- \{ key: /.test(l));
    expect(columns.length).toBeGreaterThanOrEqual(5);
    const wrapping = columns.filter(l => !/\bnowrap: true\b/.test(l));
    expect(wrapping, `columns without nowrap (they break words mid-word): ${wrapping.join(' | ')}`).toEqual([]);
  });
});
