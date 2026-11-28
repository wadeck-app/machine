import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The view of the Machines page. What the daemon list cannot show (presence, addresses) is a discreet help line under the title, not a notice with the weight of
// the facts of the page (UX review).
// Windows checks the file out with CRLF line endings (CI run 46144128934 failed there): the patterns below match LF.
const yaml = readFileSync(fileURLToPath(new URL('../dsl-views/machines.yaml', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

describe('machines view', () => {
  it('the presence note is a muted small Text, not a Card', () => {
    const block = /- \$type: Text\n(?:\s+.*\n){0,6}/.exec(yaml)?.[0] ?? '';
    expect(block).toContain('text: $sources.machines.presenceNote');
    expect(block).toContain('tone: muted');
    expect(block).toContain('size: sm');
    expect(yaml).not.toMatch(/\$if: \$sources\.machines\.presenceNote\n\s+padding/);
  });

  it('the note holds no markup (Text is plain): the command is named in words', () => {
    const src = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
    expect(/presenceNote: '([^']*)'/.exec(src)?.[1] ?? '').not.toContain('`');
  });
});
