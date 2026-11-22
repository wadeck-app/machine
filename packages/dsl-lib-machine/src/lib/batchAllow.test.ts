import { describe, expect, it } from 'vitest';
import { groupSelection, selectionSummary, type BatchRow } from './batchAllow.js';

const A = { uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'thinkcentre' };
const B = { uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'laptop' };
const row = (id: string, machine: BatchRow['machine'], command: string, shell = 'sh'): BatchRow => ({ id, machine, shell, command });

describe('groupSelection: one policy per target machine', () => {
  it('groups the selected requests by the machine they are held on, in the order they were selected', () => {
    const groups = groupSelection([row('1', A, 'ls'), row('2', B, 'pwd'), row('3', A, 'id')]);
    expect(groups.map((g) => g.machine.name)).toEqual(['thinkcentre', 'laptop']);
    expect(groups[0]?.entries).toEqual([{ shell: 'sh', command: 'ls' }, { shell: 'sh', command: 'id' }]);
    expect(groups[0]?.rows.map((r) => r.id)).toEqual(['1', '3']);
  });

  it('two requests with the same shell and text are ONE entry of the policy but both rows stay in the group', () => {
    const groups = groupSelection([row('1', A, 'ls'), row('2', A, 'ls'), row('3', A, 'ls', 'bash')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.entries).toEqual([{ shell: 'sh', command: 'ls' }, { shell: 'bash', command: 'ls' }]);
    expect(groups[0]?.rows.map((r) => r.id)).toEqual(['1', '2', '3']);
  });

  it('the same text on two machines is two entries of two policies', () => {
    expect(groupSelection([row('1', A, 'ls'), row('2', B, 'ls')]).map((g) => g.entries.length)).toEqual([1, 1]);
  });

  it('an empty selection gives no group', () => {
    expect(groupSelection([])).toEqual([]);
  });
});

describe('selectionSummary: the one-line label of the sticky bar', () => {
  it('counts requests and says how many policies are signed', () => {
    expect(selectionSummary(groupSelection([row('1', A, 'ls'), row('2', A, 'id')]))).toBe('Allow 2 selected');
    expect(selectionSummary(groupSelection([row('1', A, 'ls'), row('2', B, 'id')]))).toBe('Allow 2 selected');
  });
  it('is explicit about the machines when several', () => {
    expect(selectionSummary(groupSelection([row('1', A, 'ls'), row('2', B, 'id')]), true)).toBe('Allow 2 selected (2 machines, 2 policies, one passphrase)');
  });
});
