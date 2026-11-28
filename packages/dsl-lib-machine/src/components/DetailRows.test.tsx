import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DetailRows } from './DetailRows.js';

// The rows of a folded "Details" in a dialog: a label and its value, in monospace. FieldReadOnly breaks a long value at ANY character (`break-all`: "they f/ollow"); here a
// value wraps at its spaces and a long token stays whole (UX review 5).

describe('DetailRows', () => {
  const rows = [
    { label: 'Name', value: 'mac-m2 -> box' },
    { label: 'Keeps working', value: 'policies, local aliases, connection settings and notice recipients: they follow the machine by its uuid' },
  ];

  it('is a description list: each label names its value', () => {
    render(<DetailRows rows={rows} />);
    expect(screen.getByText('Name').tagName).toBe('DT');
    expect(screen.getByText('mac-m2 -> box').closest('dd')).not.toBeNull();
    expect(screen.getByText(/they follow the machine by its uuid/).closest('dd')).not.toBeNull();
  });

  it('never breaks a word in the middle: no break-all on a value, wrapping at spaces', () => {
    const { container } = render(<DetailRows rows={rows} />);
    expect(container.innerHTML).not.toMatch(/break-all/);
    const value = screen.getByText(/they follow the machine by its uuid/);
    // The description wraps at spaces (normal breaking); the text in it is the monospace Text atom.
    expect(value.closest('dd')?.className).toMatch(/break-normal/);
    expect(value.className).toMatch(/font-mono/);
  });

  it('nothing to list: nothing is drawn', () => {
    const { container } = render(<DetailRows rows={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
