import { describe, expect, it } from 'vitest';
import { aliasListText, conflictWarning, type AliasOverview } from './aliasView.js';

const SERVER = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const LAPTOP = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';

const overview = (over: Partial<AliasOverview> = {}): AliasOverview => ({
  local: [],
  network: [],
  conflicts: [],
  ...over,
});

describe('aliasListText', () => {
  it('says there is no alias at all', () => {
    expect(aliasListText(overview())).toBe('no alias\n');
  });

  it('shows the origin of every alias and the serial of the network list', () => {
    const text = aliasListText(
      overview({
        local: [{ alias: 'home', uuid: LAPTOP, name: 'laptop' }],
        network: [{ alias: 'box', uuid: SERVER, name: 'server', shadowed: false }],
        networkSerial: 7,
      }),
    );
    expect(text).toContain(`home -> laptop (${LAPTOP}) (local)`);
    expect(text).toContain(`box -> server (${SERVER}) (network, list serial 7)`);
  });

  it('marks a network alias shadowed by a local one', () => {
    const text = aliasListText(overview({ network: [{ alias: 'box', uuid: SERVER, name: 'server', shadowed: true }], networkSerial: 7 }));
    expect(text).toMatch(/box -> server .*\(network, list serial 7; shadowed by a local alias\)/);
  });

  it('shows a machine this one does not know by its uuid only', () => {
    expect(aliasListText(overview({ network: [{ alias: 'box', uuid: SERVER, shadowed: false }], networkSerial: 1 }))).toContain(`box -> ${SERVER} (network`);
  });
});

describe('conflictWarning', () => {
  it('names both machines, both origins and the way out', () => {
    const text = conflictWarning({ alias: 'box', local: LAPTOP, network: SERVER }, (uuid) => (uuid === LAPTOP ? 'laptop' : 'server'));
    expect(text).toMatch(/^\[warn\] "box" is a network alias of server \(6f1c2d3e\) and a local alias of laptop \(0a1b2c3d\): the local alias wins on this machine/);
    expect(text).toContain('machine alias rm box');
  });
});
