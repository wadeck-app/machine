import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { STEP_SEPARATOR } from './steps.js';
import { cli, fakeTiming, ok } from './testing.js';

// Decision 67: the multi-step commands print "Step n/N: title" between their steps. Every command, the path it takes, the exact sequence.

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

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-steps-'));
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

const consoleApprovesAll = (): void => {
  for (;;) {
    try {
      relay.deviceApprove();
    } catch {
      return;
    }
  }
};

/** The header lines of a text, in order. */
const headers = (text: string): string[] => text.split('\n').filter((l) => /^Step \d+\/\d+: /.test(l));

/** Every header that is not an "already done" line is framed: [blank line], the 25-character separator, the header, a blank line. */
function expectFramed(text: string, tight = true): void {
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (!/^Step \d+\/\d+: /.test(line) || line.endsWith('(already done)')) return;
    expect(lines[i - 1], `before "${line}"`).toBe(STEP_SEPARATOR);
    expect(lines[i + 1], `after "${line}"`).toBe('');
    // Not the very first line of the output: a blank line comes before the separator.
    if (i - 2 >= 0) expect(lines[i - 2], `before the separator of "${line}"`).toBe('');
  });
  // Never two blank lines in a row (the helper adds only the blank line that is missing).
  if (tight) expect(text).not.toMatch(/\n\n\n/);
  // Plain ASCII only, in the whole output.
  expect(text).toMatch(/^[\x09\x0a\x0d\x20-\x7e]*$/);
}

async function adminMachineReady(): Promise<void> {
  await ok(a, ['init', '--name', 'desktop']);
  const init = await ok(a, ['admin', 'init', '--generate']);
  passphrase = /passphrase[^\n]*\n\s*([A-Z0-9 -]{20,})/i.exec(init.err)?.[1]?.trim() ?? '';
  expect(passphrase).not.toBe('');
  await ok(a, ['admin', 'login', ADMIN_CODE, '--full-access', '--relay', relay.url]);
}

/** The first machine is enrolled (self-approval), the second one has an identity. */
async function firstEnrolled(): Promise<void> {
  await adminMachineReady();
  const r = await cli(a, ['join', relay.url], async () => passphrase, { timing: fakeTiming((_ms, n) => n === 1 && relay.deviceApprove()), ask: forbidden('a question') });
  expect(r.code, r.err).toBe(0);
  await ok(b, ['init', '--name', 'laptop']);
}

describe('machine setup', () => {
  it('a first run: five steps, each framed, the prose of each step under its header', async () => {
    const r = await cli(a, ['setup', relay.url, '--generate'], forbidden('a hidden prompt'), { timing: fakeTiming(consoleApprovesAll), ask: forbidden('a question'), hostname: () => 'desktop' });
    expect(r.code, r.err).toBe(0);
    expect(headers(r.out)).toEqual([
      'Step 1/5: Identity',
      'Step 2/5: Admin passphrase',
      'Step 3/5: Relay login',
      'Step 4/5: Enrolment of this machine',
      'Step 5/5: Summary and next steps',
    ]);
    expectFramed(r.out);
    // The prose of a step follows its header; a created identity says so under step 1.
    expect(r.out).toMatch(/^={25}\nStep 1\/5: Identity\n\n\[ok\] identity created: "desktop" \([0-9a-f-]{36}\)\n/);
    expect(r.out.indexOf('Step 2/5')).toBeLessThan(r.out.indexOf('[ok] admin key created'));
    expect(r.out.indexOf('[ok] admin key created')).toBeLessThan(r.out.indexOf('Step 3/5'));
    expect(r.out.indexOf('Step 3/5')).toBeLessThan(r.out.indexOf('[ok] relay token'));
    expect(r.out.indexOf('Step 5/5')).toBeLessThan(r.out.indexOf('[ok] enrolled'));
    expect(r.out).not.toMatch(/\(already done\)/);
    expect(r.err).not.toMatch(/Step \d|={25}/);
  });

  it('a re-run after a denied login: what exists is shown as "(already done)" in one line, the total stays 5', async () => {
    const failed = await cli(a, ['setup', relay.url, '--generate'], forbidden('a hidden prompt'), { timing: fakeTiming((_ms, n) => n === 1 && relay.deviceDeny()), ask: forbidden('a question'), hostname: () => 'desktop' });
    expect(failed.code).toBe(1);
    // The failed run got as far as the login.
    expect(headers(failed.out)).toEqual(['Step 1/5: Identity', 'Step 2/5: Admin passphrase', 'Step 3/5: Relay login']);
    // The passphrase generated by the first run (shown once on stderr) signs the self-approval of the re-run.
    const generated = /passphrase[^\n]*\n\s*([A-Z0-9 -]{20,})/i.exec(failed.err)?.[1]?.trim() ?? '';
    expect(generated).not.toBe('');
    const again = await cli(a, ['setup', relay.url], async () => generated, { timing: fakeTiming(consoleApprovesAll), ask: forbidden('a question'), hostname: () => 'desktop' });
    expect(again.code, again.err).toBe(0);
    expect(headers(again.out)).toEqual([
      'Step 1/5: Identity (already done)',
      'Step 2/5: Admin passphrase (already done)',
      'Step 3/5: Relay login',
      'Step 4/5: Enrolment of this machine',
      'Step 5/5: Summary and next steps',
    ]);
    expectFramed(again.out);
  });

  it('--json: the headers go to stderr, stdout stays one JSON document', async () => {
    const r = await cli(a, ['setup', relay.url, '--generate', '--json'], forbidden('a hidden prompt'), { timing: fakeTiming(consoleApprovesAll), ask: forbidden('a question'), hostname: () => 'desktop' });
    expect(r.code, r.err).toBe(0);
    expect(() => JSON.parse(r.out)).not.toThrow();
    expect(r.out).not.toMatch(/Step \d|={25}/);
    expect(headers(r.err)).toHaveLength(5);
    // stderr also carries the warnings and notes written there directly, which the helper does not see: only the framing is checked.
    expectFramed(r.err, false);
  });

  it('a usage error prints no header', async () => {
    const r = await cli(a, ['setup'], forbidden('a hidden prompt'), { timing: fakeTiming(), ask: forbidden('a question') });
    expect(r.code).not.toBe(0);
    expect(r.out + r.err).not.toMatch(/Step \d|={25}/);
  });

  it('the headers are not status lines: the command log keeps none of them', async () => {
    const r = await cli(a, ['setup', relay.url, '--generate'], forbidden('a hidden prompt'), { timing: fakeTiming(consoleApprovesAll), ask: forbidden('a question'), hostname: () => 'desktop' });
    expect(r.code, r.err).toBe(0);
    const logs = join(a, 'logs');
    expect(existsSync(logs)).toBe(true);
    const text = readdirSync(logs).map((f) => readFileSync(join(logs, f), 'utf8')).join('');
    expect(text).toContain('[ok]');
    expect(text).not.toMatch(/Step \d|={25}/);
  });
});

describe('machine join', () => {
  it('the admin machine (self-approval): four steps, no security code step, an existing identity shown as done', async () => {
    await adminMachineReady();
    const r = await cli(a, ['join', relay.url], async () => passphrase, { timing: fakeTiming((_ms, n) => n === 1 && relay.deviceApprove()), ask: forbidden('a question') });
    expect(r.code, r.err).toBe(0);
    expect(headers(r.out)).toEqual(['Step 1/4: Identity (already done)', 'Step 2/4: Relay login', 'Step 3/4: Candidacy posted and approved by this machine', 'Step 4/4: Done']);
    expectFramed(r.out);
  });

  it('another machine: identity created, relay login, wait for the admin, security code comparison, done', async () => {
    await firstEnrolled();
    let approvedOnce = false;
    const timing = {
      ...fakeTiming(),
      sleep: async () => {
        if (relay.pendingIds().length > 0 && !approvedOnce) {
          approvedOnce = true;
          const approved = await cli(a, ['admin', 'approve', relay.pendingIds()[0] as string, '--relay', relay.url], async () => passphrase, { ask: yes });
          expect(approved.code, approved.err).toBe(0);
        } else if (relay.deviceLogins.size > 0 && !approvedOnce) {
          relay.deviceApprove();
        }
      },
    };
    const asked: string[] = [];
    const r = await cli(b, ['join', relay.url], forbidden('a prompt'), { timing, ask: async (l) => (asked.push(l), 'y'), hostname: () => 'Laptop' });
    expect(r.code, r.err).toBe(0);
    // The pin question says why the code is compared here (T-05), in its own first line.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^Why: the relay could have swapped the admin key; only the same code on both screens proves it did not\.\nDoes "[a-z0-9-]+" show exactly this security code\?/);
    expect(headers(r.out)).toEqual([
      'Step 1/5: Identity (already done)',
      'Step 2/5: Relay login',
      'Step 3/5: Candidacy posted, waiting for the admin',
      'Step 4/5: Security code comparison',
      'Step 5/5: Done',
    ]);
    expectFramed(r.out);
    // The code and the question are under the comparison step, the enrollment summary under the last one.
    expect(r.out.indexOf('Step 4/5')).toBeLessThan(r.out.indexOf('Security code of'));
    expect(r.out.indexOf('Step 5/5')).toBeLessThan(r.out.indexOf('[ok] enrolled'));
  });

  it('a brand new identity is a real step, not "(already done)"', async () => {
    await firstEnrolled();
    const fresh = join(root, 'c');
    mkdirSync(fresh);
    const r = await cli(fresh, ['join', SECOND_CODE, '--relay', relay.url, '--no-wait'], forbidden('a prompt'), { ask: forbidden('a question'), hostname: () => 'Third' });
    expect(r.code, r.err).toBe(0);
    expect(headers(r.out)[0]).toBe('Step 1/4: Identity');
  });

  it('--no-wait: no comparison step, the last one is "Next steps"; total 4', async () => {
    await firstEnrolled();
    const r = await cli(b, ['join', SECOND_CODE, '--relay', relay.url, '--no-wait'], forbidden('a prompt'), { ask: forbidden('a question') });
    expect(r.code, r.err).toBe(0);
    expect(headers(r.out)).toEqual(['Step 1/4: Identity (already done)', 'Step 2/4: Relay login', 'Step 3/4: Candidacy posted', 'Step 4/4: Next steps']);
    expectFramed(r.out);
  });

  it('--resume with the approval already received: login and candidacy are done, the comparison and the end remain', async () => {
    await firstEnrolled();
    await ok(b, ['join', SECOND_CODE, '--relay', relay.url, '--no-wait']);
    const approved = await cli(a, ['admin', 'approve', relay.pendingIds()[0] as string, '--relay', relay.url], async () => passphrase, { ask: yes });
    expect(approved.code, approved.err).toBe(0);
    // A first resume that cannot answer the question keeps the approval.
    const declined = await cli(b, ['join', '--resume'], undefined, { timing: fakeTiming(), ask: async () => 'n' });
    expect(declined.code).toBe(1);
    const r = await cli(b, ['join', '--resume'], undefined, { timing: fakeTiming(), ask: yes });
    expect(r.code, r.err).toBe(0);
    expect(headers(r.out)).toEqual([
      'Step 1/5: Identity (already done)',
      'Step 2/5: Relay login (already done)',
      'Step 3/5: Candidacy posted, waiting for the admin (already done)',
      'Step 4/5: Security code comparison',
      'Step 5/5: Done',
    ]);
    expectFramed(r.out);
  });

  it('--resume of a candidacy that still waits: the candidacy step is real', async () => {
    await firstEnrolled();
    await ok(b, ['join', SECOND_CODE, '--relay', relay.url, '--no-wait']);
    const r = await cli(b, ['join', '--resume', '--timeout', '1'], undefined, { timing: fakeTiming(), ask: forbidden('a question') });
    expect(r.code).toBe(1);
    expect(headers(r.out)).toEqual(['Step 1/5: Identity (already done)', 'Step 2/5: Relay login (already done)', 'Step 3/5: Candidacy posted, waiting for the admin']);
  });

  it('--json: the headers go to stderr', async () => {
    await firstEnrolled();
    const r = await cli(b, ['join', SECOND_CODE, '--relay', relay.url, '--no-wait', '--json'], forbidden('a prompt'), { ask: forbidden('a question') });
    expect(r.code, r.err).toBe(0);
    expect(() => JSON.parse(r.out)).not.toThrow();
    expect(r.out).not.toMatch(/Step \d|={25}/);
    expect(headers(r.err)).toHaveLength(4);
  });
});

describe('machine admin approve', () => {
  it('a candidate of another machine: pending candidacy, passphrase, security code, distribution (4 steps)', async () => {
    await firstEnrolled();
    await ok(b, ['join', SECOND_CODE, '--relay', relay.url, '--no-wait']);
    const r = await cli(a, ['admin', 'approve', '--relay', relay.url], async () => passphrase, { ask: yes });
    expect(r.code, r.err).toBe(0);
    expect(headers(r.out)).toEqual(['Step 1/4: Pending candidacy', 'Step 2/4: Passphrase and signature', 'Step 3/4: Security code', 'Step 4/4: Documents distributed']);
    expectFramed(r.out);
    expect(r.out.indexOf('Step 1/4')).toBeLessThan(r.out.indexOf('Candidacy '));
    expect(r.out.indexOf('Step 3/4')).toBeLessThan(r.out.indexOf('Security code of'));
  });

  it('the first machine approving its own candidacy by hand: nobody to tell, so no distribution step (3 steps)', async () => {
    await adminMachineReady();
    await ok(a, ['join', MACHINE_CODE, '--relay', relay.url, '--no-wait']);
    const r = await cli(a, ['admin', 'approve', '--relay', relay.url], async () => passphrase, { ask: yes });
    expect(r.code, r.err).toBe(0);
    expect(headers(r.out)).toEqual(['Step 1/3: Pending candidacy', 'Step 2/3: Passphrase and signature', 'Step 3/3: Security code']);
    expectFramed(r.out);
  });

  it('listing, "nothing pending" and --reject are one-step paths: no header', async () => {
    await firstEnrolled();
    const none = await cli(a, ['admin', 'approve', '--relay', relay.url], forbidden('a prompt'), { ask: forbidden('a question') });
    expect(none.out).toMatch(/no pending candidacy/);
    await ok(b, ['join', SECOND_CODE, '--relay', relay.url, '--no-wait']);
    const id = relay.pendingIds()[0] as string;
    const reject = await cli(a, ['admin', 'approve', id, '--reject', '--relay', relay.url], forbidden('a prompt'), { ask: forbidden('a question') });
    expect(reject.code, reject.err).toBe(0);
    for (const r of [none, reject]) expect(r.out + r.err).not.toMatch(/Step \d|={25}/);
  });

  it('--json: headers on stderr', async () => {
    await firstEnrolled();
    await ok(b, ['join', SECOND_CODE, '--relay', relay.url, '--no-wait']);
    const r = await cli(a, ['admin', 'approve', '--relay', relay.url, '--json'], async () => passphrase, { ask: yes });
    expect(r.code, r.err).toBe(0);
    expect(() => JSON.parse(r.out)).not.toThrow();
    expect(r.out).not.toMatch(/Step \d|={25}/);
    expect(headers(r.err)).toHaveLength(4);
  });
});

describe('machine admin init and machine admin login', () => {
  it('admin init: the passphrase, then done (2 steps)', async () => {
    const r = await cli(a, ['admin', 'init', '--generate']);
    expect(r.code, r.err).toBe(0);
    expect(headers(r.out + r.err)).toEqual(['Step 1/2: Admin passphrase', 'Step 2/2: Done']);
    expectFramed(r.out);
  });

  it('admin init --json: headers on stderr, stdout one JSON document', async () => {
    const r = await cli(a, ['admin', 'init', '--generate', '--json']);
    expect(r.code, r.err).toBe(0);
    expect(() => JSON.parse(r.out)).not.toThrow();
    expect(headers(r.err)).toEqual(['Step 1/2: Admin passphrase', 'Step 2/2: Done']);
  });

  it('admin init on a machine that already has the key: the error comes before any header', async () => {
    await ok(a, ['admin', 'init', '--generate']);
    const r = await cli(a, ['admin', 'init', '--generate']);
    expect(r.code).not.toBe(0);
    expect(r.out + r.err).not.toMatch(/Step \d|={25}/);
  });

  it('admin login confirmed in the relay console: the request, then done (2 steps)', async () => {
    await ok(a, ['init', '--name', 'desktop']);
    const r = await cli(a, ['admin', 'login', '--relay', relay.url], undefined, { timing: fakeTiming(consoleApprovesAll) });
    expect(r.code, r.err).toBe(0);
    expect(headers(r.out)).toEqual(['Step 1/2: Relay login', 'Step 2/2: Done']);
    expectFramed(r.out);
  });

  it('admin login with a pairing code is one action: no header', async () => {
    await ok(a, ['init', '--name', 'desktop']);
    const r = await cli(a, ['admin', 'login', ADMIN_CODE, '--full-access', '--relay', relay.url]);
    expect(r.code, r.err).toBe(0);
    expect(r.out + r.err).not.toMatch(/Step \d|={25}/);
  });
});
