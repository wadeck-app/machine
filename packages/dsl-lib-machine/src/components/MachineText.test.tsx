import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MachineText } from './MachineText.js';

describe('MachineText', () => {
  it('puts every occurrence of the given names of a sentence in the machine font, the rest stays plain', () => {
    render(<p data-testid="p"><MachineText text="Stored on thinkcentre; laptop was told about thinkcentre" names={['thinkcentre', 'laptop']} /></p>);
    const p = screen.getByTestId('p');
    expect(p).toHaveTextContent('Stored on thinkcentre; laptop was told about thinkcentre');
    expect(Array.from(p.querySelectorAll('span')).map((s) => s.textContent)).toEqual(['thinkcentre', 'laptop', 'thinkcentre']);
  });

  it('a name with regex characters is matched literally, an empty list changes nothing', () => {
    render(<p data-testid="p"><MachineText text="a.b and axb" names={['a.b']} /></p>);
    expect(Array.from(screen.getByTestId('p').querySelectorAll('span')).map((s) => s.textContent)).toEqual(['a.b']);
    render(<p data-testid="q"><MachineText text="plain" names={[]} /></p>);
    expect(screen.getByTestId('q').querySelector('span')).toBeNull();
  });
});
