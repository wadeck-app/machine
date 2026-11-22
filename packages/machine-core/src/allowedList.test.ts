import { describe, expect, it } from 'vitest';
import { entryKey, type PolicyBody } from './policy.js';
import { allowedLists } from './allowedList.js';

// The allow list of a policy as data (what `machine allowed` prints and the Allowed page shows): pure, no I/O.

const NOW = 1_800_000_000;
const PEER = '22222222-2222-4222-8222-222222222222';
const body = (over: Partial<PolicyBody>): PolicyBody => ({ defaults: [], peers: {}, ...over }) as PolicyBody;
const nameOf = (uuid: string): string => (uuid === PEER ? 'laptop' : uuid);

describe('allowedLists', () => {
  it('a default list and a per-peer list, entries numbered by their place in their list, text as signed', () => {
    const lists = allowedLists(body({ defaults: [{ shell: 'sh', command: 'ls' }, { shell: 'cmd', command: 'dir' }], peers: { [PEER]: [{ shell: 'sh', template: 'orch logs <j:name>' }] } }), nameOf, NOW);
    expect(lists).toEqual([
      { scope: 'default', entries: [
        { index: 1, shell: 'sh', text: 'ls', typed: false, lifetime: 'permanent' },
        { index: 2, shell: 'cmd', text: 'dir', typed: false, lifetime: 'permanent' },
      ] },
      { scope: 'peer', peer: { uuid: PEER, name: 'laptop' }, entries: [{ index: 1, shell: 'sh', text: 'orch logs <j:name>', typed: true, lifetime: 'permanent' }] },
    ]);
  });

  it('exposes the limits as numbers and in words; without a counter the calls are the maximum, never invented as left', () => {
    const e = { shell: 'sh' as const, command: 'ls', limits: { maxCalls: 5, expiresAt: NOW + 3600 } };
    const [list] = allowedLists(body({ defaults: [e] }), nameOf, NOW);
    expect(list?.entries[0]).toMatchObject({ maxCalls: 5, expiresAt: NOW + 3600 });
    expect(list?.entries[0]?.used).toBeUndefined();
    expect(list?.entries[0]?.lifetime).toMatch(/^5 calls, until /);
  });

  it('with the counter of the target: the calls used and left', () => {
    const e = { shell: 'sh' as const, command: 'ls', limits: { maxCalls: 5 } };
    const [list] = allowedLists(body({ defaults: [e] }), nameOf, NOW, { count: (key) => (key === entryKey('default', e) ? 2 : 0) });
    expect(list?.entries[0]).toMatchObject({ maxCalls: 5, used: 2, lifetime: '3 of 5 calls left' });
  });

  it('a per-peer entry is counted under the peer scope', () => {
    const e = { shell: 'sh' as const, command: 'ls', limits: { maxCalls: 1 } };
    const lists = allowedLists(body({ peers: { [PEER]: [e] } }), nameOf, NOW, { count: (key) => (key === entryKey(PEER, e) ? 1 : 0) });
    expect(lists[1]?.entries[0]).toMatchObject({ used: 1, lifetime: '0 of 1 calls left (exhausted)' });
  });

  it('an empty default list is still a list (the page says nothing is allowed)', () => {
    expect(allowedLists(body({}), nameOf, NOW)).toEqual([{ scope: 'default', entries: [] }]);
  });
});
