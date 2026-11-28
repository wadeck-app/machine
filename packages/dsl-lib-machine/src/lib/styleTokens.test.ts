import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELD_COMMAND, MONO_FONT_STACK, MONO_STYLE } from './styleTokens.js';

describe('the monospace token', () => {
  it('is one stack applied as a style (for the large or spaced texts Text cannot draw), and the class token of a held command does not carry a second font', () => {
    expect(MONO_STYLE).toEqual({ fontFamily: MONO_FONT_STACK });
    expect(HELD_COMMAND).not.toMatch(/font-mono/);
  });

  it('no component names the Tailwind class font-mono: the Text atom of dsl-ui carries it', () => {
    const dir = path.resolve(__dirname, '..', 'components');
    const offenders = fs.readdirSync(dir).filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f) && /font-mono/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
