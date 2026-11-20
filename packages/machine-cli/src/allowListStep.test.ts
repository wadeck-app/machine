import { describe, expect, it } from 'vitest';
import { allowListQuestion, chooseAllowList, parseAllowListAnswer } from './allowListStep.js';
import { PromptTimeoutError } from './prompt.js';

function io(answers: Array<string | Error>) {
  const said: string[] = [];
  const warned: string[] = [];
  const asked: string[] = [];
  return {
    said,
    warned,
    asked,
    ask: async (label: string) => {
      asked.push(label);
      const next = answers.shift();
      if (next === undefined) throw new Error('no more answers');
      if (next instanceof Error) throw next;
      return next;
    },
    say: (t: string) => void said.push(t),
    warn: (t: string) => void warned.push(t),
  };
}

describe('parseAllowListAnswer', () => {
  it.each([['', 'admin'], ['1', 'admin'], [' Admin ', 'admin'], ['2', 'local'], ['LOCAL', 'local']])('%j -> %s', (answer, mode) => {
    expect(parseAllowListAnswer(answer)).toBe(mode);
  });
  it('anything else is undefined', () => {
    expect(parseAllowListAnswer('3')).toBeUndefined();
    expect(parseAllowListAnswer('yes')).toBeUndefined();
  });
});

describe('the question', () => {
  it('offers both, names the admin command with this machine, marks the default', () => {
    const q = allowListQuestion('laptop');
    expect(q).toContain('[1] the admin (default)');
    expect(q).toContain('`machine admin allow laptop -- <command>`');
    expect(q).toContain('[2] this machine itself');
    expect(q).toContain('`machine policy local enable`');
    expect(q).toMatch(/^[\x0a\x20-\x7e]*$/);
  });
});

describe('chooseAllowList', () => {
  it('Enter: the admin (default)', async () => {
    const t = io(['']);
    expect(await chooseAllowList({ selfName: 'laptop', ...t })).toEqual({ mode: 'admin', how: 'answer' });
    expect(t.said.join('')).toContain('[1] the admin (default)');
  });

  it('2: this machine', async () => {
    const t = io(['2']);
    expect(await chooseAllowList({ selfName: 'laptop', ...t })).toEqual({ mode: 'local', how: 'answer' });
  });

  it('the flag skips the question and says what was chosen', async () => {
    const t = io([]);
    expect(await chooseAllowList({ selfName: 'laptop', flag: 'local', ...t })).toEqual({ mode: 'local', how: 'flag' });
    expect(t.asked).toEqual([]);
    expect(t.said.join('')).toContain('Allow list: managed by this machine (--policy local).');
  });

  it('no terminal: the default is admin and it is said (a warning with the way to local)', async () => {
    const t = io([new Error('no terminal')]);
    expect(await chooseAllowList({ selfName: 'laptop', ...t })).toEqual({ mode: 'admin', how: 'default-no-terminal' });
    expect(t.warned.join('')).toContain('no terminal to ask who manages the allow list');
    expect(t.warned.join('')).toContain('--policy local');
  });

  it('an unclear answer is asked again; three in a row fall back to admin with a warning', async () => {
    const again = io(['x', '2']);
    expect(await chooseAllowList({ selfName: 'laptop', ...again })).toEqual({ mode: 'local', how: 'answer' });
    expect(again.warned.join('')).toContain('"x" is not a choice');
    const never = io(['x', 'y', 'z']);
    expect(await chooseAllowList({ selfName: 'laptop', ...never })).toEqual({ mode: 'admin', how: 'default-unclear' });
    expect(never.warned.join('')).toContain('no valid choice after 3 attempts');
  });

  it('a prompt timeout is never turned into an answer', async () => {
    const t = io([new PromptTimeoutError('Choice [1]: ', 120)]);
    await expect(chooseAllowList({ selfName: 'laptop', ...t })).rejects.toBeInstanceOf(PromptTimeoutError);
  });
});
