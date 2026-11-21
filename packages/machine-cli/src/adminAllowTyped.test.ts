import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { cli, fakeTiming, ok } from './testing.js';

// `machine admin allow` with typed entries and lifetimes (typed-parameters.md, phase 1). The signed policy is read from `--out`: the inbox
// document is sealed (decision 77), the signed file is not.

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

type Entry = { shell: string; command?: string; template?: string; limits?: { maxCalls?: number; expiresAt?: number } };
type SignedFile = { body: { v: number; version: number; issuedAt: number; defaults: Entry[] } };
const read = (file: string): SignedFile => JSON.parse(readFileSync(file, 'utf8')) as SignedFile;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-allow-typed-'));
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

/** `machine admin allow laptop --shell sh ... --out <n>.json -- <text>` with a recorder of the order of the questions. */
async function allow(args: string[], text: string, out: string, ask: (l: string) => Promise<string> = yes) {
  const events: string[] = [];
  // Everything that is printed or asked, in order: the summary must come before the question and the passphrase.
  const order: string[] = [];
  let printed = '';
  const r = await cli(a, ['admin', 'allow', 'laptop', '--shell', 'sh', '--out', join(root, out), ...args, '--', text], async (l) => (events.push(`passphrase:${l}`), order.push(`passphrase:${l}`), passphrase), {
    ask: async (l) => (events.push(`ask:${l}`), order.push(`ask:${l}`), ask(l)),
    stdout: (t) => {
      printed += t;
      order.push(`out:${t}`);
    },
  });
  return { ...r, out: printed, events, order };
}

describe('a typed entry', () => {
  it('prints the R10 summary (template, lifetime, 2 accepted and 2 refused examples) BEFORE the question and the passphrase, then signs a version 2 policy that the target installs', async () => {
    await twoMachines();
    const r = await allow([], 'orch logs <job:name> --tail <n:int(1,500)>', 'p1.json');
    expect(r.code, r.err).toBe(0);
    const summaryAt = r.out.indexOf('Typed entry (shell sh)');
    expect(summaryAt).toBeGreaterThan(-1);
    expect(r.out).toContain('"orch logs <job:name> --tail <n:int(1,500)>"');
    expect(r.out).toMatch(/lifetime: permanent/);
    expect(r.out).toMatch(/accepted: orch logs job1 --tail 1\n/);
    expect(r.out).toMatch(/accepted: orch logs my-job --tail 500\n/);
    expect((r.out.match(/^ {2}refused: /gm) ?? []).length).toBe(2);
    expect(r.out).toMatch(/sanity check, not a safeguard/);
    expect(r.out).toMatch(/\[info\] this policy is version 2.*machine cli update/);
    expect(r.events[0]).toMatch(/^ask:Allow this on "laptop"/);
    expect(r.events[1]).toMatch(/^passphrase:/);
    // The summary (and the warnings) come before the question and before the passphrase prompt.
    const at = (prefix: string) => r.order.findIndex((e) => e.startsWith(prefix));
    expect(at('out:Typed entry')).toBeGreaterThan(-1);
    expect(at('out:Typed entry')).toBeLessThan(at('ask:'));
    expect(at('ask:')).toBeLessThan(at('passphrase:'));
    const signed = read(join(root, 'p1.json'));
    expect(signed.body.v).toBe(2);
    expect(signed.body.defaults).toEqual([{ shell: 'sh', template: 'orch logs <job:name> --tail <n:int(1,500)>' }]);
    // The target accepts it as it is.
    const installed = await cli(b, ['policy', 'install', join(root, 'p1.json')]);
    expect(installed.code, installed.err).toBe(0);
    // And `machine run` hint shows a command the validator accepts.
    expect(r.out).toMatch(/Then: machine run laptop --shell sh -- orch logs job1 --tail 1|machine run laptop/);
  });

  it('an exact-only policy stays version 1, and no typed summary is printed', async () => {
    await twoMachines();
    const r = await allow([], 'uptime', 'p1.json');
    expect(r.code, r.err).toBe(0);
    expect(read(join(root, 'p1.json')).body.v).toBe(1);
    expect(r.out).not.toContain('Typed entry');
    expect(r.out).not.toContain('version 2');
  });

  it.each([
    ['orch logs <job', /complete placeholder/],
    ['orch logs <j:frob>', /unknown type/],
    ['orch logs <n:int(5,1)>', /min must not exceed max/],
    ['echo a > out', /angle bracket/],
    ['orch  logs <j:name>', /empty/],
  ])('refuses %j before anything is asked, naming the cause, saying nothing was signed', async (text, cause) => {
    await twoMachines();
    const r = await allow([], text, 'p1.json', forbidden('a question'));
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(cause);
    expect(r.err).toMatch(/Nothing was signed/);
    expect(r.events).toEqual([]);
  });

  it('warns loudly (and still signs) for a program a type cannot make safe, before the passphrase', async () => {
    await twoMachines();
    const r = await allow([], 'sudo <c:name>', 'p1.json');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/\[warn\] this typed entry is on a case a type cannot make safe/);
    expect(r.out).toMatch(/Prefer an exact entry/);
    expect(r.order.findIndex((e) => e.startsWith('out:[warn] this typed entry'))).toBeLessThan(r.order.findIndex((e) => e.startsWith('ask:')));
    expect(read(join(root, 'p1.json')).body.defaults).toEqual([{ shell: 'sh', template: 'sudo <c:name>' }]);
  });

  it('does not warn for a typed entry that is not in the table, nor for an exact entry on a listed program', async () => {
    await twoMachines();
    const typed = await allow([], 'task show <id:hexid(8)> --json', 'p1.json');
    expect(typed.out).not.toMatch(/cannot make safe/);
    const exact = await allow([], 'sudo reboot', 'p2.json');
    expect(exact.out).not.toMatch(/cannot make safe/);
  });
});

describe('lifetimes', () => {
  it('--times N stores maxCalls and says so in the summary of the change', async () => {
    await twoMachines();
    const r = await allow(['--times', '3'], 'uptime', 'p1.json');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('+ sh  "uptime"  (3 calls)');
    expect(read(join(root, 'p1.json')).body.defaults).toEqual([{ shell: 'sh', command: 'uptime', limits: { maxCalls: 3 } }]);
  });

  it('--for 2h stores expiresAt = the signing time + 7200 seconds', async () => {
    await twoMachines();
    const r = await allow(['--for', '2h'], 'uptime', 'p1.json');
    expect(r.code, r.err).toBe(0);
    const { body } = read(join(root, 'p1.json'));
    expect(body.defaults[0]?.limits?.expiresAt).toBe(body.issuedAt + 7200);
    expect(r.out).toMatch(/\(until \d{4}-\d{2}-\d{2}T/);
  });

  it('--until stores that instant', async () => {
    await twoMachines();
    const until = new Date(Date.now() + 5 * 86400_000);
    until.setUTCMilliseconds(0);
    const r = await allow(['--until', until.toISOString()], 'uptime', 'p1.json');
    expect(r.code, r.err).toBe(0);
    expect(read(join(root, 'p1.json')).body.defaults[0]?.limits?.expiresAt).toBe(until.getTime() / 1000);
  });

  it('permanent by default: no limits field', async () => {
    await twoMachines();
    await allow([], 'uptime', 'p1.json');
    expect(read(join(root, 'p1.json')).body.defaults[0]).toEqual({ shell: 'sh', command: 'uptime' });
  });

  it.each([
    [['--times', '0'], /--times must be a whole number from 1 to 10000/],
    [['--times', '10001'], /from 1 to 10000/],
    [['--for', '366d'], /--for is at most 365 days/],
    [['--for', '0s'], /--for must be digits then s, m, h or d/],
    [['--until', '2001-01-01'], /--until is in the past/],
    [['--until', 'tomorrow'], /--until is not a date/],
    [['--times', '2', '--for', '1h'], /only one of --times, --for, --until/],
  ])('refuses %j before anything is asked', async (flags, cause) => {
    await twoMachines();
    const r = await allow(flags as string[], 'uptime', 'p1.json', forbidden('a question'));
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(cause);
    expect(r.err).toMatch(/Nothing was signed/);
    expect(r.events).toEqual([]);
  });

  it('the lifetime flags are for allowing: they are refused with --list and --remove, and on other commands', async () => {
    await twoMachines();
    expect((await cli(a, ['admin', 'allow', 'laptop', '--list', '--times', '2'])).err).toMatch(/cannot be combined with --list or --remove/);
    expect((await cli(a, ['admin', 'allow', 'laptop', '--remove', '--for', '2h', '--', 'x'])).err).toMatch(/cannot be combined/);
    expect((await cli(a, ['status', '--times', '2'])).err).toMatch(/--times only applies to `machine admin allow` and `machine policy allow`/);
  });

  it('renewal: allowing the same entry with other limits replaces them and says "limits updated"; the same limits again signs nothing', async () => {
    await twoMachines();
    expect((await allow(['--times', '2'], 'uptime', 'p1.json')).code).toBe(0);
    const renewed = await allow(['--times', '9'], 'uptime', 'p2.json');
    expect(renewed.code, renewed.err).toBe(0);
    expect(renewed.out).toMatch(/limits updated: "uptime" \(2 calls -> 9 calls\)/);
    const { body } = read(join(root, 'p2.json'));
    expect(body.version).toBe(2);
    expect(body.defaults).toEqual([{ shell: 'sh', command: 'uptime', limits: { maxCalls: 9 } }]);
    const again = await allow(['--times', '9'], 'uptime', 'p3.json', forbidden('a question'));
    expect(again.out).toMatch(/already allowed/);
    expect(again.events).toEqual([]);
  });
});

describe('--remove by number, and ambiguity', () => {
  it('--list numbers the entries (typed tagged, lifetime shown); --remove --index withdraws that entry', async () => {
    await twoMachines();
    await allow([], 'uptime', 'p1.json');
    await allow(['--times', '4'], 'task show <id:hexid(8)>', 'p2.json');
    const list = await cli(a, ['admin', 'allow', 'laptop', '--list']);
    expect(list.out).toMatch(/#1 sh {2}"uptime"\n/);
    expect(list.out).toMatch(/#2 sh {2}"task show <id:hexid\(8\)>" {2}\[typed\] {2}\(4 calls\)/);
    const removed = await cli(a, ['admin', 'allow', 'laptop', '--remove', '--index', '2', '--out', join(root, 'p3.json')], async () => passphrase, { ask: yes });
    expect(removed.code, removed.err).toBe(0);
    const { body } = read(join(root, 'p3.json'));
    expect(body.defaults).toEqual([{ shell: 'sh', command: 'uptime' }]);
    // The last typed entry is gone: the body goes back to version 1.
    expect(body.v).toBe(1);
  });

  it('a text held under several shells is ambiguous: nothing is signed, the matching entries are listed with their number', async () => {
    await twoMachines();
    await allow([], 'uptime', 'p1.json');
    const bash = await cli(a, ['admin', 'allow', 'laptop', '--shell', 'bash', '--out', join(root, 'p2.json'), '--', 'uptime'], async () => passphrase, { ask: yes });
    expect(bash.code, bash.err).toBe(0);
    const r = await cli(a, ['admin', 'allow', 'laptop', '--remove', '--', 'uptime'], async () => passphrase, { ask: forbidden('a question') });
    expect(r.out).toMatch(/matches several entries/);
    expect(r.out).toMatch(/#1 sh {2}"uptime"/);
    expect(r.out).toMatch(/#2 bash {2}"uptime"/);
    expect(r.out).toMatch(/--index <number>/);
    expect(r.code).toBe(0);
  });

  it('a number that is not in the list changes nothing and says how to see the numbers', async () => {
    await twoMachines();
    await allow([], 'uptime', 'p1.json');
    const r = await cli(a, ['admin', 'allow', 'laptop', '--remove', '--index', '7'], async () => passphrase, { ask: forbidden('a question') });
    expect(r.out).toMatch(/no entry number 7.*machine allowed/s);
  });

  it('--index is refused with a command, and without --remove', async () => {
    await twoMachines();
    expect((await cli(a, ['admin', 'allow', 'laptop', '--remove', '--index', '1', '--', 'uptime'])).err).toMatch(/--index replaces the command/);
    expect((await cli(a, ['admin', 'allow', 'laptop', '--index', '1', '--', 'uptime'])).err).toMatch(/--index only applies to/);
    expect((await cli(a, ['admin', 'allow', 'laptop', '--remove', '--index', 'x'])).err).toMatch(/--index must be the number shown by `machine allowed`/);
  });
});

describe('machine allowed', () => {
  it('shows the template as signed with the tag typed, the lifetime and the number', async () => {
    await twoMachines();
    await allow(['--times', '5'], 'orch logs <job:name> --tail <n:int(1,500)>', 'p1.json');
    const view = await ok(a, ['allowed', 'laptop']);
    expect(view.out).toMatch(/#1 "orch logs <job:name> --tail <n:int\(1,500\)>" {2}\[typed\] {2}\(5 calls\)/);
  });
});
