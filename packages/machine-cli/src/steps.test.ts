import { describe, expect, it } from 'vitest';
import { createSteps, STEP_SEPARATOR, trackedSay } from './steps.js';

// Step headers of the multi-step commands: one helper, one style (decision 67).

function collect() {
  let text = '';
  return { say: (t: string) => (text += t), text: () => text };
}

describe('step headers', () => {
  it('the separator is 25 plain "=" characters', () => {
    expect(STEP_SEPARATOR).toBe('='.repeat(25));
    expect(STEP_SEPARATOR).toHaveLength(25);
  });

  it('prints a blank line, the separator, "Step n/N: title" and a blank line, numbered over the whole plan', () => {
    const out = collect();
    const steps = createSteps(out.say, [
      { key: 'a', title: 'First' },
      { key: 'b', title: 'Second' },
      { key: 'c', title: 'Third' },
    ]);
    steps.begin('a');
    steps.begin('b');
    steps.begin('c');
    // The very first header has no blank line before it (nothing was printed by the helper yet).
    expect(out.text()).toBe(
      `${STEP_SEPARATOR}\nStep 1/3: First\n\n` + `\n${STEP_SEPARATOR}\nStep 2/3: Second\n\n` + `\n${STEP_SEPARATOR}\nStep 3/3: Third\n\n`,
    );
  });

  it('a step already done is counted and shown as one line, printed when the next real step begins', () => {
    const out = collect();
    const steps = createSteps(out.say, [
      { key: 'identity', title: 'Identity', skipped: true },
      { key: 'login', title: 'Relay login', skipped: true },
      { key: 'candidacy', title: 'Candidacy' },
      { key: 'done', title: 'Done' },
    ]);
    expect(steps.total).toBe(4);
    steps.begin('candidacy');
    steps.begin('done');
    expect(out.text()).toBe(
      'Step 1/4: Identity (already done)\nStep 2/4: Relay login (already done)\n' + `\n${STEP_SEPARATOR}\nStep 3/4: Candidacy\n\n` + `\n${STEP_SEPARATOR}\nStep 4/4: Done\n\n`,
    );
  });

  it('a skipped step can say why in its own words', () => {
    const out = collect();
    const steps = createSteps(out.say, [
      { key: 'a', title: 'Admin key', skipped: 'kept: this machine already holds it' },
      { key: 'b', title: 'Next' },
    ]);
    steps.begin('b');
    expect(out.text()).toContain('Step 1/2: Admin key (kept: this machine already holds it)\n');
  });

  it('with a tracked output there is exactly one blank line before the separator, whatever the prose before ended with', () => {
    for (const before of ['prose\n\n', 'prose\n', 'prose']) {
      const out = collect();
      const say = trackedSay(out.say);
      const steps = createSteps(say, [
        { key: 'a', title: 'A' },
        { key: 'b', title: 'B' },
      ]);
      steps.begin('a');
      say(before);
      steps.begin('b');
      // What the helper adds: the blank line that is still missing.
      const missing = before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
      expect(out.text()).toBe(`${STEP_SEPARATOR}\nStep 1/2: A\n\n${before}${missing}${STEP_SEPARATOR}\nStep 2/2: B\n\n`);
    }
  });

  it('with a tracked output nothing printed yet means no blank line before the first header', () => {
    const out = collect();
    const say = trackedSay(out.say);
    createSteps(say, [
      { key: 'a', title: 'A' },
      { key: 'b', title: 'B' },
    ]).begin('a');
    expect(out.text()).toBe(`${STEP_SEPARATOR}\nStep 1/2: A\n\n`);
  });

  it('a header followed by prose that ends with a blank line, then a skipped line, then the next header: still one blank line each time', () => {
    const out = collect();
    const say = trackedSay(out.say);
    const steps = createSteps(say, [
      { key: 'a', title: 'A' },
      { key: 'b', title: 'B', skipped: true },
      { key: 'c', title: 'C' },
    ]);
    steps.begin('a');
    say('body\n\n');
    steps.begin('c');
    expect(out.text()).toBe(`${STEP_SEPARATOR}\nStep 1/3: A\n\nbody\n\nStep 2/3: B (already done)\n\n${STEP_SEPARATOR}\nStep 3/3: C\n\n`);
  });

  it('a path of one step prints nothing (a header would announce steps that do not exist)', () => {
    const out = collect();
    const steps = createSteps(out.say, [{ key: 'only', title: 'Only' }]);
    steps.begin('only');
    expect(out.text()).toBe('');
    expect(steps.total).toBe(1);
  });

  it('has() tells whether a step is on the path', () => {
    const steps = createSteps(() => undefined, [
      { key: 'a', title: 'A' },
      { key: 'b', title: 'B' },
    ]);
    expect(steps.has('a')).toBe(true);
    expect(steps.has('zzz')).toBe(false);
  });

  it('is plain ASCII', () => {
    const out = collect();
    const steps = createSteps(out.say, [
      { key: 'a', title: 'A', skipped: true },
      { key: 'b', title: 'B' },
    ]);
    steps.begin('b');
    expect(out.text()).toMatch(/^[\x0a\x20-\x7e]*$/);
  });

  it('fails loudly on a mistake of the caller: unknown step, going back, skipping a step that is not marked skipped, beginning a skipped step, duplicate keys', () => {
    const plan = () => [
      { key: 'a', title: 'A' },
      { key: 'b', title: 'B', skipped: true as const },
      { key: 'c', title: 'C' },
    ];
    const s1 = createSteps(() => undefined, plan());
    expect(() => s1.begin('zzz')).toThrow(/unknown step "zzz"/);
    const s2 = createSteps(() => undefined, plan());
    s2.begin('a');
    s2.begin('c');
    expect(() => s2.begin('a')).toThrow(/already passed|went back|order/i);
    const s3 = createSteps(() => undefined, plan());
    expect(() => s3.begin('c')).toThrow(/step "a" was never begun/);
    const s4 = createSteps(() => undefined, plan());
    s4.begin('a');
    expect(() => s4.begin('b')).toThrow(/marked as already done/);
    expect(() => createSteps(() => undefined, [{ key: 'x', title: 'X' }, { key: 'x', title: 'Y' }])).toThrow(/duplicate/i);
  });

  it('beginning the same step twice is refused', () => {
    const steps = createSteps(() => undefined, [
      { key: 'a', title: 'A' },
      { key: 'b', title: 'B' },
    ]);
    steps.begin('a');
    expect(() => steps.begin('a')).toThrow(/already passed|went back|order/i);
  });
});
