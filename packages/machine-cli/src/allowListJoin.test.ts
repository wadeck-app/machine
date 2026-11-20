import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { readPolicyMode } from './policyMode.js';
import { cliRaw, fakeTiming } from './testing.js';

// Decision 70: the "Allow list" step of `machine setup` / `machine join`. These tests call cliRaw: nothing adds --policy for them.

const MACHINE_CODE = '12345678';
const ADMIN_CODE = '87654321';
const LOCAL_PASSPHRASE = 'a long local passphrase 42';

let root: string;
let a: string;
let relay: FakeRelay;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-allowlist-'));
  a = join(root, 'a');
  mkdirSync(a);
  relay = await startFakeRelay({ code: MACHINE_CODE, adminCode: ADMIN_CODE });
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
const headers = (text: string): string[] => text.split('\n').filter((l) => /^Step \d+\/\d+: /.test(l));
const refuseHidden = async (): Promise<string> => {
  throw new Error('a hidden prompt must not be asked');
};

/** Answers the allow-list question, and "no hint" to the hint question of the local passphrase. */
function human(choice: string) {
  const asked: string[] = [];
  const hidden: string[] = [];
  return {
    asked,
    hidden,
    ask: async (label: string) => {
      asked.push(label);
      return label.startsWith('Choice') ? choice : '';
    },
    // Used only by the local passphrase (setup --generate asks no admin passphrase).
    prompt: async (label: string) => {
      hidden.push(label);
      return LOCAL_PASSPHRASE;
    },
  };
}

const setup = (extra: string[], h: { ask: (l: string) => Promise<string>; prompt?: (l: string) => Promise<string> }) =>
  cliRaw(a, ['setup', relay.url, '--generate', ...extra], h.prompt ?? refuseHidden, { timing: fakeTiming(consoleApprovesAll), ask: h.ask, hostname: () => 'desktop' });

describe('Allow list step: the question', () => {
  it('Enter keeps the admin: the question is shown with both choices, nothing is set up here', async () => {
    const h = human('');
    const r = await setup([], h);
    expect(r.code, r.err).toBe(0);
    expect(h.asked.filter((l) => l.startsWith('Choice'))).toEqual(['Choice [1]: ']);
    expect(headers(r.out).at(-2)).toBe('Step 5/6: Allow list');
    expect(r.out).toContain('[1] the admin (default): delegated, nothing to set up here; on the admin machine run `machine admin allow desktop -- <command>`');
    expect(r.out).toContain('[2] this machine itself: independent of any other machine');
    expect(r.out).toContain('[ok] the admin manages the allow list of this machine');
    expect(r.out).toContain('allow list: managed by the admin (policy mode admin)');
    expect(readPolicyMode(a).mode).toBe('admin');
    expect(h.hidden).toEqual([]);
  });

  it('2 takes the allow list over: passphrase typed twice, summary and mode say local', async () => {
    const h = human('2');
    const r = await setup([], h);
    expect(r.code, r.err).toBe(0);
    expect(h.hidden).toHaveLength(2);
    expect(r.out).toContain('Policy mode local for "desktop"');
    expect(r.out).toMatch(/\[ok\] this machine manages its own allow list \(policy key [0-9a-f]+\)/);
    expect(r.out).toMatch(/allow list: managed by this machine \(policy mode local, key [0-9a-f]+\)/);
    expect(r.out).toContain('`machine policy allow -- <command>`');
    expect(readPolicyMode(a).mode).toBe('local');
  });

  it('an unclear answer is asked again', async () => {
    const answers = ['maybe', '1'];
    const asked: string[] = [];
    const r = await setup([], { ask: async (l) => (asked.push(l), answers.shift() ?? '') });
    expect(r.code, r.err).toBe(0);
    expect(asked.filter((l) => l.startsWith('Choice'))).toHaveLength(2);
    expect(r.err).toContain('"maybe" is not a choice');
  });
});

describe('Allow list step: --policy', () => {
  it('--policy admin skips the question and says so', async () => {
    const r = await setup(['--policy', 'admin'], { ask: async () => { throw new Error('nothing must be asked'); } });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('Allow list: managed by the admin (--policy admin).');
    expect(r.out).not.toContain('Who manages the allow list');
    expect(headers(r.out).at(-2)).toBe('Step 5/6: Allow list');
  });

  it('--policy local skips the question and goes straight to the local passphrase', async () => {
    const h = human('never asked');
    const r = await setup(['--policy', 'local'], h);
    expect(r.code, r.err).toBe(0);
    expect(h.asked.filter((l) => l.startsWith('Choice'))).toEqual([]);
    expect(r.out).toContain('Allow list: managed by this machine (--policy local).');
    expect(readPolicyMode(a).mode).toBe('local');
  });

  it('a value other than admin|local is a usage error before anything is done', async () => {
    const r = await setup(['--policy', 'both'], human(''));
    expect(r.code).toBe(2);
    expect(r.err).toContain('--policy must be "admin"');
    expect(r.out).not.toMatch(/Step \d/);
  });

  it('refused on other commands, with the commands it applies to', async () => {
    const r = await cliRaw(a, ['status', '--policy', 'admin']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--policy only applies to `machine join` and `machine setup`');
  });

  it('refused with --no-wait: the choice needs the enrolment', async () => {
    const r = await cliRaw(a, ['join', MACHINE_CODE, '--relay', relay.url, '--no-wait', '--policy', 'local'], refuseHidden, { ask: async () => '' });
    expect(r.code).toBe(2);
    expect(r.err).toContain('--policy cannot be combined with --no-wait');
  });

  it('--policy admin on a machine already in mode local says how to give the list back', async () => {
    expect((await setup(['--policy', 'local'], human(''))).code).toBe(0);
    const again = await cliRaw(a, ['join', relay.url, '--policy', 'admin'], refuseHidden, { timing: fakeTiming(), ask: async () => '' });
    expect(again.code).toBe(2);
    expect(again.err).toContain('`machine policy delegate`');
  });
});

describe('Allow list step: no terminal and --json', () => {
  it('without a terminal and without the flag: the default is admin and the output says so', async () => {
    const r = await setup([], { ask: async () => { throw new Error('no terminal'); } });
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain('[warn] no terminal to ask who manages the allow list: the default applies, the admin manages it');
    expect(r.err).toContain('--policy local');
    expect(r.out).toContain('allow list: managed by the admin (policy mode admin)');
    expect(readPolicyMode(a).mode).toBe('admin');
  });

  it('--json: stdout stays one JSON document (with the mode), the question and the step go to stderr', async () => {
    const h = human('');
    const r = await setup(['--json'], h);
    expect(r.code, r.err).toBe(0);
    const doc = JSON.parse(r.out) as { policyMode: string; self: { name: string } };
    expect(doc.policyMode).toBe('admin');
    expect(r.out).not.toMatch(/Step \d|Who manages/);
    expect(r.err).toContain('Who manages the allow list');
    expect(headers(r.err)).toHaveLength(6);
  });
});
