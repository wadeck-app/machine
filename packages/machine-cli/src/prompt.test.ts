import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { promptHidden } from './prompt.js';

function fakeTerminal(isTTY: boolean) {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (mode: boolean) => void; rawModes: boolean[] };
  input.isTTY = isTTY;
  input.rawModes = [];
  input.setRawMode = (mode: boolean) => {
    input.rawModes.push(mode);
  };
  let shown = '';
  const output = new PassThrough();
  output.on('data', (c: Buffer) => (shown += c.toString()));
  return { input, output, shown: () => shown };
}

describe('promptHidden', () => {
  it('reads a line without echoing it and restores the terminal mode', async () => {
    const t = fakeTerminal(true);
    const result = promptHidden('Passphrase: ', { input: t.input, output: t.output });
    t.input.write('s3cret');
    t.input.write('\r');
    expect(await result).toBe('s3cret');
    expect(t.shown()).toContain('Passphrase: ');
    expect(t.shown()).not.toContain('s3cret');
    expect(t.input.rawModes).toEqual([true, false]);
  });

  it('handles backspace', async () => {
    const t = fakeTerminal(true);
    const result = promptHidden('P: ', { input: t.input, output: t.output });
    t.input.write('abcx\u007fd\n');
    expect(await result).toBe('abcd');
  });

  it('rejects on Ctrl-C and still restores the terminal mode', async () => {
    const t = fakeTerminal(true);
    const result = promptHidden('P: ', { input: t.input, output: t.output });
    t.input.write('ab\u0003');
    await expect(result).rejects.toThrow(/cancelled/);
    expect(t.input.rawModes).toEqual([true, false]);
  });

  it('refuses a non-interactive input and says passphrases are never read from pipes, arguments or the environment', async () => {
    const t = fakeTerminal(false);
    await expect(promptHidden('P: ', { input: t.input, output: t.output })).rejects.toThrow(/interactive terminal.*never/s);
  });

  it('rejects when the input ends before Enter', async () => {
    const t = fakeTerminal(true);
    const result = promptHidden('P: ', { input: t.input, output: t.output });
    t.input.end();
    await expect(result).rejects.toThrow(/ended/);
  });
});

describe('promptHidden (encoding)', () => {
  it('keeps a multibyte character split across two chunks', async () => {
    const t = fakeTerminal(true);
    const result = promptHidden('P: ', { input: t.input, output: t.output });
    const bytes = Buffer.from('café\n', 'utf8');
    t.input.write(bytes.subarray(0, 4));
    t.input.write(bytes.subarray(4));
    expect(await result).toBe('café');
  });
});
