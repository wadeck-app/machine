import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readMachine } from './identity.js';
import { commitRecords, readPeerRecords } from './peerAddresses.js';
import { cli, provision } from './testing.js';

let root: string;
let a: string;
let b: string;
const yes = async () => 'y';
const no = async () => 'n';

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-forget-record-'));
  a = join(root, 'a');
  b = join(root, 'b');
  mkdirSync(a);
  mkdirSync(b);
  await provision(root, a, b, []);
  commitRecords(a, { [readMachine(b).uuid]: { seq: 9, signature: 's', addresses: [{ host: '192.168.1.20', port: 1 }], issuedAt: 1, seenAt: 1 } });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('machine peer forget-record <peer>', () => {
  it('after a y/N, forgets the highest seq seen of that ONE peer and says what it means', async () => {
    const r = await cli(a, ['peer', 'forget-record', 'laptop'], undefined, { ask: yes });
    expect(r.code, r.err).toBe(0);
    expect(readPeerRecords(a)[readMachine(b).uuid]).toBeUndefined();
    expect(r.out).toMatch(/forgot/);
    // The consequence is stated: the next record is accepted without a rollback check.
    expect(r.out).toMatch(/without any rollback check|no rollback check/);
  });

  it('warns BEFORE asking: use it only after confirming out of band that the peer was reinstalled', async () => {
    const r = await cli(a, ['peer', 'forget-record', 'laptop'], undefined, { ask: no });
    expect(r.out).toMatch(/out of band/);
    expect(r.out).toMatch(/reinstalled/);
    expect(r.out).toMatch(/seq 9/);
  });

  it('a "no" forgets nothing (exit 1)', async () => {
    const r = await cli(a, ['peer', 'forget-record', 'laptop'], undefined, { ask: no });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Nothing was forgotten/);
    expect(readPeerRecords(a)[readMachine(b).uuid]?.seq).toBe(9);
  });

  it('without a terminal it refuses and nothing is forgotten', async () => {
    const r = await cli(a, ['peer', 'forget-record', 'laptop'], undefined, {
      ask: async () => {
        throw new Error('no terminal');
      },
    });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/terminal/);
    expect(readPeerRecords(a)[readMachine(b).uuid]?.seq).toBe(9);
  });

  it('nothing remembered for that peer: said, exit 0, no question', async () => {
    const r = await cli(b, ['peer', 'forget-record', 'desktop'], undefined, {
      ask: async () => {
        throw new Error('must not be asked');
      },
    });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/no address record is remembered/);
  });

  it('an unknown machine is exit 3', async () => {
    const r = await cli(a, ['peer', 'forget-record', 'nobody'], undefined, { ask: yes });
    expect(r.code).toBe(3);
  });

  it('takes exactly one peer, and is in the help', async () => {
    expect((await cli(a, ['peer', 'forget-record'], undefined, { ask: yes })).code).toBe(2);
    expect((await cli(a, ['peer', 'forget-record', 'x', 'y'], undefined, { ask: yes })).code).toBe(2);
    expect((await cli(a, ['--help'])).out).toMatch(/peer forget-record <peer>/);
  });

  it('--json prints one JSON document', async () => {
    const r = await cli(a, ['peer', 'forget-record', 'laptop', '--json'], undefined, { ask: yes });
    expect(JSON.parse(r.out)).toEqual({ forgot: readMachine(b).uuid, name: 'laptop', hadRecord: true });
  });
});
