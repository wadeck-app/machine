import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MachineName } from './MachineName.js';

// Machine names are the Text atom of dsl-ui in monospace (dsl-ui 413): the font family is the one of the design system, not a stack of this module.

describe('MachineName', () => {
  it('renders the name as monospace text of the design system, with no inline style', () => {
    render(<MachineName name="thinkcentre" />);
    const el = screen.getByText('thinkcentre');
    expect(el).toHaveClass('font-mono');
    expect(el.getAttribute('style')).toBeNull();
  });

  it('is text only: markup in a name is never interpreted', () => {
    const { container } = render(<MachineName name="<b>x</b>" />);
    expect(container.querySelector('b')).toBeNull();
    expect(container).toHaveTextContent('<b>x</b>');
  });
});
