import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMAND_TEXT, HELD_COMMAND, MONO_FONT_STACK, MONO_STYLE } from './styleTokens.js';

describe('the monospace token', () => {
  it('is one stack applied as a style, and the class tokens of commands do not carry a second font', () => {
    expect(MONO_STYLE).toEqual({ fontFamily: MONO_FONT_STACK });
    expect(HELD_COMMAND).not.toMatch(/font-mono/);
    expect(COMMAND_TEXT).not.toMatch(/font-mono/);
  });

  it('no component names the Tailwind class font-mono: the generic stack of the shell would differ from the one of the module', () => {
    const dir = path.resolve(__dirname, '..', 'components');
    const offenders = fs.readdirSync(dir).filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f) && /font-mono/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
