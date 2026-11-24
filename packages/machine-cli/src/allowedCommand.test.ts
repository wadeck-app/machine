import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeCommands } from './commands.js';
import { policyRecordFile } from './adminAllow.js';
import { readMachine } from './identity.js';
import { provision } from './testing.js';
import { REMOTE_VIEW_LINE } from './allowedView.js';
import { editRights } from './allowedAnswer.js';

// The `allowed` command of the daemon (the Allowed page of the module): the data of `machine allowed <machine>` for every machine, read-only.

let root: string;
let a: string;
let b: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-allowed-cmd-'));
  a = join(root, 'a');
  b = join(root, 'b');
  mkdirSync(a);
  mkdirSync(b);
  await provision(root, a, b, [{ shell: 'sh', command: 'ls' }, { shell: 'sh', command: 'uptime', limits: { maxCalls: 3 } }]);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('daemon command allowed', () => {
  it('on the admin machine: the policy signed here for the peer (signed-here, admin) and nothing for itself, with the commands that fill them', async () => {
    const answer = (await makeCommands(a, 'test').allowed()) as any;
    expect(answer).toMatchObject({ initialized: true, ok: true, self: { name: 'desktop' } });
    const laptop = answer.machines.find((m: any) => m.name === 'laptop');
    expect(laptop).toMatchObject({ isSelf: false, source: 'signed-here', mode: 'admin', policy: { version: 1 } });
    expect(typeof laptop.policy.issuedAt).toBe('number');
    expect(laptop.policy.lists[0].entries).toMatchObject([{ index: 1, shell: 'sh', text: 'ls', lifetime: 'permanent' }, { index: 2, text: 'uptime', maxCalls: 3, lifetime: '3 calls' }]);
    // The counter of a call is only known on the target: no `used` for a policy signed here.
    expect(laptop.policy.lists[0].entries[1].used).toBeUndefined();
    expect(laptop.remoteViewLine).toBe(REMOTE_VIEW_LINE('laptop'));
    const desktop = answer.machines.find((m: any) => m.name === 'desktop');
    expect(desktop).toMatchObject({ isSelf: true, source: 'installed', policy: null });
    expect(desktop.fillCommand).toContain('machine ');
  });

  it('on the target: its installed policy with the calls left, and the admin machine has no record here', async () => {
    const answer = (await makeCommands(b, 'test').allowed()) as any;
    const laptop = answer.machines.find((m: any) => m.isSelf);
    expect(laptop).toMatchObject({ name: 'laptop', source: 'installed', mode: 'admin', policy: { version: 1 } });
    expect(laptop.policy.lists[0].entries[1]).toMatchObject({ used: 0, lifetime: '3 of 3 calls left' });
    const desktop = answer.machines.find((m: any) => !m.isSelf);
    expect(desktop).toMatchObject({ name: 'desktop', source: 'signed-here', policy: null });
    expect(desktop.fillCommand).toContain('machine admin allow desktop -- ');
  });

  it('a policy record that cannot be read is said on that machine with its file and fix, the others still show', async () => {
    const uuid = readMachine(b).uuid;
    writeFileSync(policyRecordFile(a, uuid), '{ not json');
    const answer = (await makeCommands(a, 'test').allowed()) as any;
    const laptop = answer.machines.find((m: any) => m.name === 'laptop');
    expect(laptop.policy).toBeNull();
    expect(laptop.problem).toMatch(/not a valid policy record/);
    expect(laptop.problem).toContain('delete it');
  });

  describe('last use, from the audit log of this machine', () => {
    const accepted = (ts: string, source: string, command: string): string => JSON.stringify({ seq: 0, prev: 'p', hash: 'h', entry: { ts, event: 'accepted', source, id: 'i', shell: 'sh', command } });

    it('the installed entries carry their last accepted use, the scan says it is complete, an unused entry has none', async () => {
      const admin = readMachine(a).uuid;
      writeFileSync(join(b, 'audit.log'), `${accepted('2026-11-10T10:00:00.000Z', admin, 'ls')}
${accepted('2026-11-20T10:00:00.000Z', admin, 'ls')}
`);
      const laptop = ((await makeCommands(b, 'test').allowed()) as any).machines.find((m: any) => m.isSelf);
      expect(laptop.policy.lists[0].entries[0].lastUsedAt).toBe(Date.parse('2026-11-20T10:00:00.000Z') / 1000);
      expect(laptop.policy.lists[0].entries[1].lastUsedAt).toBeUndefined();
      expect(laptop.lastUse).toMatchObject({ complete: true, damaged: 0, scanned: 2 });
    });

    it('no audit log yet: nothing was used, said as a fact of the scan', async () => {
      const laptop = ((await makeCommands(b, 'test').allowed()) as any).machines.find((m: any) => m.isSelf);
      expect(laptop.lastUse).toMatchObject({ complete: true, scanned: 0 });
    });

    it('a policy signed here for another machine has no last use: the audit of that machine is on that machine', async () => {
      const laptop = ((await makeCommands(a, 'test').allowed()) as any).machines.find((m: any) => m.name === 'laptop');
      expect(laptop.lastUse).toBeUndefined();
      expect(laptop.policy.lists[0].entries[0].lastUsedAt).toBeUndefined();
    });
  });

  it('not initialized: says so with the fix instead of an empty page', async () => {
    const empty = join(root, 'empty');
    mkdirSync(empty);
    expect(await makeCommands(empty, 'test').allowed()).toMatchObject({ initialized: false, message: expect.stringContaining('machine') });
  });

  it('never carries the signature of a policy record', async () => {
    const text = JSON.stringify(await makeCommands(a, 'test').allowed());
    expect(text).not.toMatch(/signature/i);
  });
});

describe('who can sign a change of a list (the Allowed page offers actions only where this machine can sign)', () => {
  it('the admin machine can sign the list it signed for another machine; the target that does not hold the admin key cannot change its own installed list', async () => {
    const onAdmin = (await makeCommands(a, 'test').allowed()) as any;
    expect(onAdmin.machines.find((m: any) => m.name === 'laptop')).toMatchObject({ canEdit: true, editNote: '' });
    const onTarget = (await makeCommands(b, 'test').allowed()) as any;
    const self = onTarget.machines.find((m: any) => m.isSelf);
    expect(self.canEdit).toBe(false);
    expect(self.editNote).toMatch(/does not hold the admin key/);
    expect(self.editNote).toMatch(/admin machine/);
  });

  it('editRights: mode local says who manages the list and the command; a mode admin machine without the key says to go to the admin machine; nothing to say when nothing is listed', () => {
    expect(editRights({ source: 'installed', mode: 'local', hasAdminKey: true, hasPolicy: true })).toEqual({ canEdit: false, editNote: expect.stringMatching(/policy mode local.*machine policy allow/s) });
    expect(editRights({ source: 'installed', mode: 'admin', hasAdminKey: false, hasPolicy: true })).toEqual({ canEdit: false, editNote: expect.stringMatching(/does not hold the admin key.*admin machine/s) });
    expect(editRights({ source: 'installed', mode: 'admin', hasAdminKey: true, hasPolicy: true })).toEqual({ canEdit: true, editNote: '' });
    expect(editRights({ source: 'signed-here', mode: 'admin', hasAdminKey: true, hasPolicy: true })).toEqual({ canEdit: true, editNote: '' });
    expect(editRights({ source: 'signed-here', mode: 'admin', hasAdminKey: false, hasPolicy: true }).canEdit).toBe(false);
    expect(editRights({ source: 'signed-here', mode: 'admin', hasAdminKey: true, hasPolicy: false })).toEqual({ canEdit: false, editNote: '' });
  });
});
