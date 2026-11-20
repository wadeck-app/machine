import { describe, expect, it } from 'vitest';
import type { PolicyEntry } from '@wadeck-app/machine-core';
import { allowedByShell, refusalAllowedLine, REMOTE_VIEW_LINE } from './allowedView.js';

const entries = (n: number): PolicyEntry[] => Array.from({ length: n }, (_, i) => ({ shell: 'sh' as const, command: `cmd${i + 1}` }));

describe('refusalAllowedLine', () => {
  it('names the version, every entry as `shell "command"`, and the command that lists them all', () => {
    const e: PolicyEntry[] = [{ shell: 'sh', command: 'ls' }, { shell: 'cmd', command: 'dir /b' }];
    expect(refusalAllowedLine('thinkcentre', 3, e)).toBe('commands allowed on thinkcentre per the policy signed here (v 3): sh "ls", cmd "dir /b" (machine allowed thinkcentre)');
  });

  it('caps the list at 10 entries and says how many are left out', () => {
    const line = refusalAllowedLine('thinkcentre', 2, entries(13));
    expect(line).toContain('sh "cmd10"');
    expect(line).not.toContain('sh "cmd11"');
    expect(line).toBe(`commands allowed on thinkcentre per the policy signed here (v 2): ${entries(10).map((x) => `sh "${x.command}"`).join(', ')}, and 3 more (machine allowed thinkcentre)`);
  });

  it('exactly 10 entries: no "and more"', () => {
    expect(refusalAllowedLine('t', 1, entries(10))).not.toContain('more');
  });

  it('an empty list says that nothing is allowed for this machine', () => {
    expect(refusalAllowedLine('thinkcentre', 1, [])).toBe('commands allowed on thinkcentre per the policy signed here (v 1): nothing for this machine (machine allowed thinkcentre)');
  });
});

describe('allowedByShell', () => {
  it('groups the entries per shell, shells in the order of their first entry, limits kept', () => {
    const e: PolicyEntry[] = [{ shell: 'sh', command: 'ls' }, { shell: 'cmd', command: 'dir' }, { shell: 'sh', command: 'pwd', limits: { maxCalls: 2 } }];
    expect(allowedByShell(e, '  ')).toEqual(['  sh', '    "ls"', '    "pwd"  limits {"maxCalls":2}', '  cmd', '    "dir"']);
  });
  it('nothing: one line that says so', () => {
    expect(allowedByShell([], '  ')).toEqual(['  (nothing)']);
  });
});

describe('REMOTE_VIEW_LINE', () => {
  it('is the exact sentence of the spec', () => {
    expect(REMOTE_VIEW_LINE('thinkcentre')).toBe('as installed on thinkcentre: ask there with machine policy allow --list (remote view: machine requests/policy views are not built yet)');
  });
});
