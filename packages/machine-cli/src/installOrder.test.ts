import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signPolicyFile } from './admin.js';
import { readMachine } from './identity.js';
import { exportMachineInfo, importPeer, installPolicy, registerMachine } from './network.js';
import { makeAdmin, ok, type TestAdmin } from './testing.js';

let root: string;
let admin: TestAdmin;
const T = Math.floor(Date.now() / 1000);

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-install-order-'));
  mkdirSync(join(root, 'a'));
  mkdirSync(join(root, 'b'));
  await ok(join(root, 'a'), ['init', '--name', 'desktop']);
  await ok(join(root, 'b'), ['init', '--name', 'laptop']);
  admin = makeAdmin(join(root, 'a'));
  await ok(join(root, 'b'), ['admin', 'pin', join(root, 'a', 'admin.json')]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('installPolicy writes highestSeen first, then the policy, then the version', () => {
  it('a failing write of the policy file leaves highestSeen raised and the version unchanged, so the version can never be applied twice', async () => {
    const dir = join(root, 'a');
    const draft = join(dir, 'draft.json');
    writeFileSync(draft, JSON.stringify({ v: 1, target: readMachine(dir).uuid, version: 1, baseVersion: 0, defaults: [{ shell: 'sh', command: 'echo hi' }], peers: {} }));
    const { signed } = await signPolicyFile(dir, draft, { now: T, prompt: async () => admin.passphrase });
    // A directory where the policy file goes: the second write fails.
    mkdirSync(join(dir, 'policy.json'));
    expect(() => installPolicy(dir, signed, { now: T })).toThrow();
    const state = JSON.parse(readFileSync(join(dir, 'policy-state.json'), 'utf8')) as { version: number; highestSeen: number };
    expect(state).toMatchObject({ version: 0, highestSeen: 1 });
    // The same version is now refused as already seen: a half installation cannot be replayed into a different state.
    rmSync(join(dir, 'policy.json'), { recursive: true });
    expect(() => installPolicy(dir, signed, { now: T })).toThrow(/rollback|not newer/);
    expect(existsSync(join(dir, 'policy.json'))).toBe(false);
  });
});

describe('importPeer has the same clock tolerance as the documents (120 s on the not-yet-valid side)', () => {
  it('accepts a registration dated 100 s ahead, refuses one dated 140 s ahead', async () => {
    const info = exportMachineInfo(join(root, 'b'));
    const make = (ahead: number) => registerMachine(join(root, 'a'), info, { now: T + ahead, prompt: async () => admin.passphrase, validForDays: 1 });
    importPeer(join(root, 'b'), await make(100), { now: T });
    await expect(Promise.resolve().then(async () => importPeer(join(root, 'b'), await make(140), { now: T }))).rejects.toThrow(/not-yet-valid/);
  });
});

