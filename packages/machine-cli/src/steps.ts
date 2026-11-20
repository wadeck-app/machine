// Step headers of the multi-step commands (decision 67): one helper, one style.
//
// Numbering rule: the plan lists every step of the path the command takes, N is the length of the plan. A step that is already done
// (identity exists, token saved) stays in the plan and is shown as ONE line, "Step 1/5: Identity (already done)". A step that does not
// exist on this path (no security code to compare when this machine approves itself, no wait with --no-wait) is not in the plan, so it
// is not counted. A path of a single step prints no header at all.
//
// The headers go through the `say` the caller already uses for the prose of the command (stdout, or stderr with --json), so they never
// end in the JSON document. They match no status-line pattern ("[ok]", "[warn]"...), so the command log ignores them.

/** 25 plain ASCII "=" characters. */
export const STEP_SEPARATOR = '='.repeat(25);

/** An output that remembers how its text ended, so that a header adds exactly the blank line that is missing (never two). */
export type TrackedSay = ((text: string) => void) & { tail: () => string };

/** Wraps `say`: everything said through the result (the prose of the command AND the headers) is tracked. */
export function trackedSay(say: (text: string) => void): TrackedSay {
  let tail = '';
  const tracked = ((text: string): void => {
    if (text.length === 0) return;
    tail = (tail + text).slice(-2);
    say(text);
  }) as TrackedSay;
  tracked.tail = () => tail;
  return tracked;
}

export interface StepDef {
  /** Identifier used by `begin`; unique in the plan. */
  key: string;
  title: string;
  /** Already done: shown as one line. `true` prints "(already done)", a text replaces it. */
  skipped?: true | string;
}

export interface Steps {
  /** Number of steps of the plan (skipped ones included). */
  total: number;
  /** True when the step is on this path (a caller shared by several paths asks before it begins a step). */
  has: (key: string) => boolean;
  /**
   * Prints the one-line summaries of the skipped steps that precede `key`, then the header of `key`. Steps go forward only; a step that
   * is not marked skipped cannot be passed over, a step marked skipped cannot be begun: both are mistakes of the caller and throw.
   */
  begin: (key: string) => void;
}

export function createSteps(say: (text: string) => void, plan: StepDef[]): Steps {
  const keys = new Set<string>();
  for (const def of plan) {
    if (keys.has(def.key)) throw new Error(`internal: duplicate step key "${def.key}" in the plan`);
    keys.add(def.key);
  }
  const total = plan.length;
  let next = 0;
  let printed = false;
  const write = (text: string): void => {
    printed = true;
    say(text);
  };
  // The blank line before a separator: with a tracked output, what is missing after the text said so far; else one line, except at the very start.
  const blankBefore = (): string => {
    const tail = (say as Partial<TrackedSay>).tail?.();
    if (tail === undefined) return printed ? '\n' : '';
    if (tail === '' || tail.endsWith('\n\n')) return '';
    return tail.endsWith('\n') ? '\n' : '\n\n';
  };
  return {
    total,
    has: (key) => keys.has(key),
    begin: (key) => {
      const index = plan.findIndex((d) => d.key === key);
      if (index === -1) throw new Error(`internal: unknown step "${key}" (the plan has ${plan.map((d) => d.key).join(', ')})`);
      if (index < next) throw new Error(`internal: step "${key}" is already passed (steps go forward, in the order of the plan)`);
      const def = plan[index] as StepDef;
      if (def.skipped !== undefined) throw new Error(`internal: step "${key}" is marked as already done, it cannot begin`);
      for (let i = next; i < index; i++) {
        const before = plan[i] as StepDef;
        if (before.skipped === undefined) throw new Error(`internal: step "${before.key}" was never begun before step "${key}"`);
        // A path of a single step has nothing to number.
        if (total > 1) write(`Step ${i + 1}/${total}: ${before.title} (${before.skipped === true ? 'already done' : before.skipped})\n`);
      }
      next = index + 1;
      if (total > 1) write(`${blankBefore()}${STEP_SEPARATOR}\nStep ${index + 1}/${total}: ${def.title}\n\n`);
    },
  };
}
