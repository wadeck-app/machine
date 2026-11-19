import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { readMachine } from './identity.js';
import { cli, fakeTiming, ok } from './testing.js';

// `machine admin allow` (decision 54): one command instead of a hand-written draft, `admin sign-policy --out` and `policy install`.

const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';
const MACHINE_CODE = '12345678';
const SECOND_CODE = '22223333';
const ADMIN_CODE = '87654321';
const yes = async () => 'y';
const forbidden = (what: string) => async (): Promise<string> => {
  throw new Error(`${what} must not be asked`);
};

let root: string;
let a: string;
let b: string;
let relay: FakeRelay;
let passphrase: string;

type PolicyDoc = { body: { kind: string; payload: { body: { version: number; baseVersion: number; target: string; defaults: { shell: string; command: string }[]; peers: Record<string, unknown> } } } };
const policyDocs = (uuid: string): PolicyDoc[] => relay.inbox(uuid).map((d) => d.document as unknown as PolicyDoc).filter((d) => d.body.kind === 'policy');
const allow = (args: string[], ask: (l: string) => Promise<string> = yes, pass: (l: string) => Promise<string> = async () => passphrase) => cli(a, ['admin', 'allow', ...args], pass, { ask });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-allow-'));
  a = join(root, 'a');
  b = join(root, 'b');
  mkdirSync(a);
  mkdirSync(b);
  relay = await startFakeRelay({ code: MACHINE_CODE, moreCodes: [SECOND_CODE], adminCode: ADMIN_CODE });
});
afterEach(async () => {
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

/** The admin machine "desktop" and a second machine "laptop", both enrolled through the fake relay. */
async function twoMachines(): Promise<void> {
  await ok(a, ['init', '--name', 'desktop']);
  const init = await ok(a, ['admin', 'init', '--generate']);
  passphrase = /passphrase[^\n]*\n\s*([A-Z0-9 -]{20,})/i.exec(init.err)?.[1]?.trim() ?? '';
  await ok(a, ['admin', 'login', ADMIN_CODE, '--full-access', '--relay', relay.url]);
  const first = await cli(a, ['join', MACHINE_CODE, '--relay', relay.url], async () => passphrase, { timing: fakeTiming(), ask: forbidden('a question') });
  expect(first.code, first.err).toBe(0);
  await ok(b, ['init', '--name', 'laptop']);
  await ok(b, ['join', SECOND_CODE, '--relay', relay.url, '--no-wait']);
  const approved = await cli(a, ['admin', 'approve', '--relay', relay.url], async () => passphrase, { ask: yes });
  expect(approved.code, approved.err).toBe(0);
  const joined = await cli(b, ['join', '--resume'], undefined, { timing: fakeTiming(), ask: yes });
  expect(joined.code, joined.err).toBe(0);
}

/** What the daemon of `laptop` does with a policy of its inbox: the signed document is installed with `policy install`. */
async function installOnLaptop(doc: PolicyDoc, name: string): Promise<{ code: number; err: string }> {
  const file = join(root, name);
  writeFileSync(file, JSON.stringify(doc.body.payload));
  return cli(b, ['policy', 'install', file]);
}

describe('machine admin allow <machine> <command>', () => {
  it('builds version 1 from nothing, shows what is added, asks y/N then the passphrase, signs, sends it through the relay inbox, and says what happens next', async () => {
    await twoMachines();
    const asked: string[] = [];
    const prompts: string[] = [];
    const r = await cli(a, ['admin', 'allow', 'laptop', '--shell', SHELL, '--', 'echo', 'hello'], async (l) => (prompts.push(l), passphrase), { ask: async (l) => (asked.push(l), 'y') });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/Policy for "laptop"/);
    expect(r.out).toMatch(/version 0 -> 1/);
    expect(r.out).toContain(`+ ${SHELL}  "echo hello"`);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/laptop/);
    expect(prompts).toHaveLength(1);
    const docs = policyDocs(readMachine(b).uuid);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.body.payload.body).toMatchObject({ version: 1, baseVersion: 0, target: readMachine(b).uuid, defaults: [{ shell: SHELL, command: 'echo hello' }] });
    expect(r.out).toMatch(/machine run laptop/);
    expect(r.out).toMatch(/inbox/i);
    // The target accepts it as it is: signature, target, base version.
    expect((await installOnLaptop(docs[0] as PolicyDoc, 'v1.json')).code).toBe(0);
    expect(JSON.parse((await ok(b, ['status', '--json'])).out)).toMatchObject({ policyVersion: 1 });
  });

  it('the next allow builds version 2 from the first (entries kept), a remove builds version 3, and --list shows what is allowed', async () => {
    await twoMachines();
    expect((await allow(['laptop', '--shell', SHELL, '--', 'echo', 'one'])).code).toBe(0);
    const second = await allow(['laptop', '--shell', SHELL, '--', 'echo', 'two']);
    expect(second.code, second.err).toBe(0);
    expect(second.out).toMatch(/version 1 -> 2/);
    const listed = await cli(a, ['admin', 'allow', 'laptop', '--list']);
    expect(listed.code, listed.err).toBe(0);
    expect(listed.out).toContain(`${SHELL}  "echo one"`);
    expect(listed.out).toContain(`${SHELL}  "echo two"`);
    expect(listed.out).toMatch(/version 2/);

    const removed = await allow(['laptop', '--remove', '--shell', SHELL, '--', 'echo', 'one']);
    expect(removed.code, removed.err).toBe(0);
    expect(removed.out).toMatch(/version 2 -> 3/);
    expect(removed.out).toContain(`- ${SHELL}  "echo one"`);
    const docs = policyDocs(readMachine(b).uuid);
    expect(docs.map((d) => d.body.payload.body.version)).toEqual([1, 2, 3]);
    expect(docs[2]?.body.payload.body.defaults).toEqual([{ shell: SHELL, command: 'echo two' }]);
    // The target applies them in order, each edited from the previous one.
    for (const [i, doc] of docs.entries()) expect((await installOnLaptop(doc, `v${i + 1}.json`)).code).toBe(0);
  });

  it('allowing what is already allowed, or removing what is not, signs nothing and asks nothing', async () => {
    await twoMachines();
    await allow(['laptop', '--shell', SHELL, '--', 'echo', 'one']);
    const again = await cli(a, ['admin', 'allow', 'laptop', '--shell', SHELL, '--', 'echo', 'one'], forbidden('a passphrase'), { ask: forbidden('a question') });
    expect(again.code, again.err).toBe(0);
    expect(again.out).toMatch(/already allowed/);
    const missing = await cli(a, ['admin', 'allow', 'laptop', '--remove', '--shell', SHELL, '--', 'echo', 'nope'], forbidden('a passphrase'), { ask: forbidden('a question') });
    expect(missing.code, missing.err).toBe(0);
    expect(missing.out).toMatch(/not allowed.*nothing to remove/);
    expect(policyDocs(readMachine(b).uuid)).toHaveLength(1);
  });

  it('says which shell it chose when --shell is absent, and why; with --shell it says nothing about it', async () => {
    await twoMachines();
    const implicit = await allow(['laptop', '--', 'echo', 'x']);
    expect(implicit.code, implicit.err).toBe(0);
    expect(implicit.err + implicit.out).toMatch(new RegExp(`\\[info\\] shell "${SHELL}" chosen from this machine's platform.*--shell`));
    const explicit = await allow(['laptop', '--shell', SHELL, '--', 'echo', 'y']);
    expect(explicit.err + explicit.out).not.toMatch(/chosen from this machine's platform/);
  });

  it('says that the machine has no policy on record: the first version assumes the target has none', async () => {
    await twoMachines();
    const r = await allow(['laptop', '--shell', SHELL, '--', 'echo', 'x']);
    expect(r.out + r.err).toMatch(/no policy signed here for "laptop" on record.*assumes.*none/s);
  });

  it('the human can decline: nothing is signed, nothing is sent, the passphrase is not asked', async () => {
    await twoMachines();
    const r = await cli(a, ['admin', 'allow', 'laptop', '--shell', SHELL, '--', 'echo', 'x'], forbidden('a passphrase'), { ask: async () => 'n' });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not confirmed.*Nothing was signed/);
    expect(policyDocs(readMachine(b).uuid)).toHaveLength(0);
    expect(existsSync(join(a, 'policies'))).toBe(false);
  });

  it('a wrong passphrase signs nothing and records nothing', async () => {
    await twoMachines();
    const r = await allow(['laptop', '--shell', SHELL, '--', 'echo', 'x'], yes, async () => 'definitely not the passphrase');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/wrong passphrase/);
    expect(policyDocs(readMachine(b).uuid)).toHaveLength(0);
    expect(existsSync(join(a, 'policies'))).toBe(false);
  });

  it('an unknown machine is a reference error (exit 3) before anything is asked', async () => {
    await twoMachines();
    const r = await cli(a, ['admin', 'allow', 'nothere', '--shell', SHELL, '--', 'echo', 'x'], forbidden('a passphrase'), { ask: forbidden('a question') });
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/unknown machine "nothere"/);
  });

  it('a friendly alias is accepted as the machine reference', async () => {
    await twoMachines();
    await ok(a, ['alias', 'set', 'Portable', 'laptop']);
    const r = await allow(['PORTABLE', '--shell', SHELL, '--', 'echo', 'x']);
    expect(r.code, r.err).toBe(0);
    expect(policyDocs(readMachine(b).uuid)).toHaveLength(1);
  });

  it('without the admin relay token it fails BEFORE asking anything, with the exact login command; --out writes the signed file instead', async () => {
    await twoMachines();
    rmSync(join(a, '_secrets_', 'relay-admin.json'));
    const r = await cli(a, ['admin', 'allow', 'laptop', '--shell', SHELL, '--', 'echo', 'x'], forbidden('a passphrase'), { ask: forbidden('a question') });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/machine admin login <code> --relay/);
    expect(r.err).toMatch(/--out <file>/);
    const out = join(root, 'signed.json');
    const written = await cli(a, ['admin', 'allow', 'laptop', '--shell', SHELL, '--out', out, '--', 'echo', 'x'], async () => passphrase, { ask: yes });
    expect(written.code, written.err).toBe(0);
    expect(written.out + written.err).toMatch(/machine policy install/);
    expect((await cli(b, ['policy', 'install', out])).code).toBe(0);
  });

  it('on the admin machine itself the policy is installed here, no relay involved', async () => {
    await twoMachines();
    const r = await allow(['desktop', '--shell', SHELL, '--', 'echo', 'mine']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/installed on this machine/);
    expect(JSON.parse((await ok(a, ['status', '--json'])).out)).toMatchObject({ policyVersion: 1 });
    expect(policyDocs(readMachine(a).uuid)).toHaveLength(0);
    const next = await allow(['desktop', '--shell', SHELL, '--', 'echo', 'again']);
    expect(next.out).toMatch(/version 1 -> 2/);
  });

  it('a peer with its own list is named: the change does not apply to it', async () => {
    await twoMachines();
    const target = readMachine(b).uuid;
    const draft = join(root, 'draft.json');
    writeFileSync(draft, JSON.stringify({ v: 1, target, version: 1, baseVersion: 0, defaults: [], peers: { [readMachine(a).uuid]: [{ shell: SHELL, command: 'echo own' }] } }));
    expect((await cli(a, ['admin', 'sign-policy', draft, '--out', join(root, 's.json')], async () => passphrase)).code).toBe(0);
    // sign-policy leaves a record, so the next allow is edited from it.
    const r = await allow(['laptop', '--shell', SHELL, '--', 'echo', 'x']);
    expect(r.code, r.err).toBe(0);
    expect(r.out + r.err).toMatch(/\[warn\].*own list.*desktop/);
    expect(r.out).toMatch(/version 1 -> 2/);
    expect(readFileSync(join(a, 'policies', `${target}.json`), 'utf8')).toContain('"version": 2');
  });

  it('usage: a command is needed (except --list), words with spaces must be quoted as one argument, --list and --remove are exclusive', async () => {
    await twoMachines();
    const none = await cli(a, ['admin', 'allow', 'laptop']);
    expect(none.code).toBe(2);
    expect(none.err).toMatch(/usage: machine admin allow/);
    const spaced = await cli(a, ['admin', 'allow', 'laptop', '--shell', SHELL, '--', 'echo', 'a b']);
    expect(spaced.code).toBe(2);
    expect(spaced.err).toMatch(/ONE quoted argument/);
    const both = await cli(a, ['admin', 'allow', 'laptop', '--list', '--remove', '--', 'x']);
    expect(both.code).toBe(2);
    const badShell = await cli(a, ['admin', 'allow', 'laptop', '--shell', 'zsh', '--', 'x']);
    expect(badShell.code).toBe(2);
    expect(badShell.err).toMatch(/unknown shell "zsh"/);
    const stray = await cli(a, ['status', '--list']);
    expect(stray.code).toBe(2);
    expect(stray.err).toMatch(/--list and --remove only apply to `machine admin allow`/);
  });
});
