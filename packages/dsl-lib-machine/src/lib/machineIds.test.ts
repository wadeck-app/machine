import { describe, expect, it } from 'vitest';
import { nameShortIds } from './machineIds.js';

// A message of the core says "(33333333)" or "machine 33333333": eight hexadecimal characters nobody can use. The page names the machine instead (UX review 5: a conflict
// message never ends with a truncated uuid). It never guesses: a prefix that two machines share stays as it is unless the message or the caller says which one.

const uuid = (n: number): string => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const MACHINES = [
  { uuid: uuid(1), name: 'desktop' },
  { uuid: uuid(2), name: 'laptop' },
  { uuid: uuid(3), name: 'server' },
];
const CLASH = [
  { uuid: '00000000-0000-4000-8000-000000000002', name: 'one' },
  { uuid: '00000000-0000-4000-8000-000000000003', name: 'two' },
];

describe('nameShortIds', () => {
  it('drops the prefix that follows the quoted name of the machine it identifies', () => {
    expect(nameShortIds('the name "box" is already used by machine "server" (33333333): pick another name', MACHINES)).toBe('the name "box" is already used by machine "server": pick another name');
  });

  it('names the machine behind a bare prefix between parentheses, whatever ends the message', () => {
    expect(nameShortIds('"box" is a local alias of another machine (33333333)', MACHINES)).toBe('"box" is a local alias of another machine "server"');
    expect(nameShortIds('the alias "box" already points to machine 22222222', MACHINES)).toBe('the alias "box" already points to machine "laptop"');
  });

  it('keeps what it cannot resolve: an unknown prefix, a prefix of two machines without a name or a hint', () => {
    expect(nameShortIds('points to machine 99999999', MACHINES)).toBe('points to machine 99999999');
    expect(nameShortIds('of another machine (00000000)', CLASH)).toBe('of another machine (00000000)');
  });

  it('a quoted name settles a prefix two machines share; a caller hint (the uuid the context knows) settles it too', () => {
    expect(nameShortIds('used by machine "two" (00000000): pick another name', CLASH)).toBe('used by machine "two": pick another name');
    expect(nameShortIds('of another machine (00000000)', CLASH, ['00000000-0000-4000-8000-000000000003'])).toBe('of another machine "two"');
  });

  it('leaves a message with no prefix alone, and a word that merely looks hexadecimal (a name) is not a prefix', () => {
    expect(nameShortIds('invalid new name "---": use letters', MACHINES)).toBe('invalid new name "---": use letters');
    expect(nameShortIds('the alias "deadbeef" differs', [{ uuid: 'deadbeef-0000-4000-8000-000000000001', name: 'x' }])).toBe('the alias "deadbeef" differs');
  });
});
