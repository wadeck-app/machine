import { describe, expect, it } from 'vitest';
import { splitCommandText } from './commandText.js';

// A sentence of the module that holds a command writes it between backticks. A boxed message (Notice) is plain text, so its prose stays in the box and the sentences with a
// command are shown beside it, with the command in monospace: no literal backtick is ever on screen.

describe('splitCommandText', () => {
  it('a text without a command is all prose', () => {
    expect(splitCommandText('Documents delivered to 1 machine.')).toEqual({ prose: 'Documents delivered to 1 machine.', withCommands: [] });
  });

  it('the sentence that holds a command leaves the prose, in order, and the others stay', () => {
    expect(splitCommandText('Documents NOT delivered to 2 machines. Run `machine admin distribute 123`. It is safe to run again.')).toEqual({
      prose: 'Documents NOT delivered to 2 machines. It is safe to run again.',
      withCommands: ['Run `machine admin distribute 123`.'],
    });
  });

  it('a full stop inside a command does not end the sentence', () => {
    expect(splitCommandText('Cannot reach the relay. Run `machine join --relay https://r.example/x. y` now.')).toEqual({
      prose: 'Cannot reach the relay.',
      withCommands: ['Run `machine join --relay https://r.example/x. y` now.'],
    });
  });

  it('a text that is only a command has no prose', () => {
    expect(splitCommandText('Run `machine join`.')).toEqual({ prose: '', withCommands: ['Run `machine join`.'] });
  });

  it('an unpaired backtick is not a command: the text stays whole', () => {
    expect(splitCommandText('A stray ` backtick.')).toEqual({ prose: 'A stray ` backtick.', withCommands: [] });
  });
});
