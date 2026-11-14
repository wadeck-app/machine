// @vitest-environment node
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateEntries } from '../scripts/generate-entries.js';
import { LIB_ENTRIES } from './paths.js';

describe('generated entries', () => {
  const generated = generateEntries();

  it('registers the three machine components', () => {
    for (const name of ['VerticalTimeline', 'PassphraseSigner', 'FinalCodeDisplay']) {
      expect(generated, `${name} is missing: run "npm run entries --workspace=packages/dsl-lib-machine"`).toContain(`${name}Entry`);
    }
  });

  it('src/generated/entries.tsx is not stale', () => {
    expect(fs.existsSync(LIB_ENTRIES), `${LIB_ENTRIES} is missing: run "npm run entries --workspace=packages/dsl-lib-machine"`).toBe(true);
    expect(fs.readFileSync(LIB_ENTRIES, 'utf8').replace(/\r\n/g, '\n'), 'stale: run "npm run entries --workspace=packages/dsl-lib-machine"').toBe(generated.replace(/\r\n/g, '\n'));
  });
});
