import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readMachine } from '../identity.js';
import { relayFile } from '../relayStore.js';
import { setupFirst, relayGet } from './flows.js';
import { startWorld, type World } from './world.js';

// The per-token machine limit of the REAL relay (`npm run test:relay`): the relay is started with `maxMachinesPerToken: 2` (its
// `machines-config.json`; the default without it is 10, pinned against the fake relay in fakeRelay.test.ts, not here: eleven enrollments
// would cost more than they prove). A limit counts machines of ONE token, so the machines of this story share the token of the first one
// (its relay.json is copied, then `join --resume` posts a candidacy with it). One story, in order.

const LIMIT = 2;
let w: World;
let a: string;
let b: string;
let c: string;

/** A new machine folder with its identity (`init`) and the relay token of the first machine: `join --resume` then posts its candidacy with that token. */
async function machineWithSharedToken(name: string): Promise<string> {
  const dir = w.machineDir(name);
  const init = await w.run(name, dir, ['init', '--name', name]);
  expect(init.code, init.err).toBe(0);
  const target = relayFile(dir);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(relayFile(a), target);
  return dir;
}

beforeAll(async () => {
  w = await startWorld('relayLimit', { maxMachinesPerToken: LIMIT });
  a = w.machineDir('desktop');
});
afterAll(async () => {
  await w.stop();
});

describe(`a relay limited to ${LIMIT} machines per token`, () => {
  it('the admin machine and one other machine of the same token enroll (2 machines)', async () => {
    await setupFirst(w, a);
    b = await machineWithSharedToken('laptop');
    let approved: { code: number; out: string; err: string } | undefined;
    const joined = await w.run('laptop', b, ['join', '--resume'], {
      visible: ['y'],
      onWait: async (_n, out) => {
        if (approved === undefined && /Candidacy \S+ posted/.test(out)) approved = await w.run('desktop', a, ['admin', 'approve'], { visible: ['y'] });
      },
    });
    expect(approved?.code, approved?.err).toBe(0);
    expect(joined.code, joined.err).toBe(0);
    // Both machines are bound to the token now (no daemon runs here, so no address record: the next test proves the count by the refusal).
  });

  it('the third machine is refused at `admin approve`: the message quotes the limit, names the exact command, says the candidacy stays pending', async () => {
    c = await machineWithSharedToken('nas');
    const posted = await w.run('nas', c, ['join', '--resume', '--no-wait']);
    expect(posted.code, posted.err).toBe(0);
    const refused = await w.run('desktop', a, ['admin', 'approve'], { visible: ['y'] });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(`this token already owns the maximum (${LIMIT}) machines`);
    expect(refused.err).toContain('machine admin forget-relay-record <machine|uuid>');
    expect(refused.err).toMatch(/still pending/);
    expect(refused.err).not.toMatch(/\b50\b/);
    const pending = await relayGet(w, '/api/machines/candidacies', w.relay.adminToken);
    expect((pending.body.candidacies as unknown[]).length).toBe(1);
  });

  it('the candidate that waits is told nothing was decided and that `join --resume` continues (the refusal is on the admin side)', async () => {
    const waiting = await w.run('nas', c, ['join', '--resume', '--timeout', '1'], { visible: ['y'] });
    expect(waiting.code).toBe(1);
    expect(waiting.err).toMatch(/join --resume/);
  });

  it('`admin forget-relay-record <uuid>` of one machine frees a place; the third machine is then approved and enrolls', async () => {
    const forgotten = await w.run('desktop', a, ['admin', 'forget-relay-record', readMachine(b).uuid], { visible: ['y'] });
    expect(forgotten.code, forgotten.err).toBe(0);
    const approved = await w.run('desktop', a, ['admin', 'approve'], { visible: ['y'] });
    expect(approved.code, approved.err).toBe(0);
    const done = await w.run('nas', c, ['join', '--resume'], { visible: ['y'] });
    expect(done.code, done.err).toBe(0);
    expect(done.out).toContain('[ok] enrolled "nas"');
    const pending = await relayGet(w, '/api/machines/candidacies', w.relay.adminToken);
    expect(pending.body.candidacies).toEqual([]);
  });
});
