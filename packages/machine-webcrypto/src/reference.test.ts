import { machineNameProblem as coreProblem, normalizeMachineName as coreNormalize } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { machineNameProblem, normalizeMachineName } from './reference.js';

// The page checks the names it signs with copies of machine-core `machineNameProblem` and `normalizeMachineName`: same answers, same messages.

const NAMES = [
  '', 'a', 'box', 'Box', 'thinkcentre', 'mac-m2', '-box', 'box-', 'a'.repeat(32), 'a'.repeat(33), 'dead-beef', 'cafe', 'abc', 'has space', 'café', 'UP', 'x_y', 'host-1234', '1234', 'my-laptop2',
  'Midgard2', 'My Laptop', 'École  Primaire', '!!!', '---', '   ', 'deadbeef-box', 'a'.repeat(40), 'ab', 'f00d', '\u{1f600}x',
];

describe('machine names (copies of machine-core reference.ts)', () => {
  it.each(NAMES)('machineNameProblem agrees with machine-core for %j', (name) => {
    expect(machineNameProblem(name)).toBe(coreProblem(name));
  });

  it.each(NAMES)('normalizeMachineName agrees with machine-core for %j', (name) => {
    expect(normalizeMachineName(name)).toEqual(coreNormalize(name));
  });
});
