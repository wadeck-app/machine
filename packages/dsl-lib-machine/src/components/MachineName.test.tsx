import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MONO_FONT_STACK } from '../lib/styleTokens.js';
import { MachineName } from './MachineName.js';

// Machine names in ONE monospace font: the theme of the app defines no mono family (dsl-ui's preset only defines sans: Inter), so the stack is the one named token.

describe('MachineName', () => {
  it('renders the name as text, in the shared monospace stack (a real family first, a generic one last)', () => {
    render(<MachineName name="thinkcentre" />);
    const el = screen.getByText('thinkcentre');
    expect(el.style.fontFamily).toContain('JetBrains Mono');
    expect(MONO_FONT_STACK).toMatch(/^'JetBrains Mono', .*monospace$/);
    // jsdom drops the quotes of the family names: compare without them.
    expect(el.style.fontFamily.replace(/"/g, '')).toBe(MONO_FONT_STACK.replace(/'/g, ''));
  });

  it('is text only: markup in a name is never interpreted', () => {
    const { container } = render(<MachineName name="<b>x</b>" />);
    expect(container.querySelector('b')).toBeNull();
    expect(container).toHaveTextContent('<b>x</b>');
  });
});
