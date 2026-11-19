import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminPinFile, readAdminPin } from './admin.js';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { APPROVAL_MAX_AGE_SECONDS, MAX_DEVICE_LOGIN_SECONDS } from './join.js';
import { loadNetwork } from './network.js';
import { DEFAULT_PROMPT_TIMEOUT_SECONDS, promptHidden, promptLine, PromptTimeoutError, withPromptTimeout } from './prompt.js';
import { candidacyFile, readCandidacy, writeCandidacy } from './relayStore.js';
import { buildApproval, cli, fakePromptTimer, fakeTiming, makeAdmin, ok, provision, type TestAdmin } from './testing.js';

// Security: every step that waits for a human has a limit, so a stale prompt, a stale approval or a replayed document
// cannot be completed later. Nothing here waits for real: the timers and the clock are injected.

const hang = () => new Promise<string>(() => undefined);
const yes = async () => 'y';
const noTty = async (): Promise<string> => {
  throw new Error('no tty');
};
const lastCodeLine = (out: string): string => [...out.matchAll(/^ {2}(\d{5}(?: \d{5}){4})$/gm)].at(-1)?.[1] as string;

function fakeTerminal() {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (mode: boolean) => void; rawModes: boolean[] };
  input.isTTY = true;
  input.rawModes = [];
  input.setRawMode = (mode: boolean) => void input.rawModes.push(mode);
  const output = new PassThrough();
  return { input, output };
}

describe('prompt limits (terminal prompts)', () => {
  it('promptHidden: the default limit is 120 s; on expiry it rejects, drops what was typed, gives the terminal back', async () => {
    expect(DEFAULT_PROMPT_TIMEOUT_SECONDS).toBe(120);
    const t = fakeTerminal();
    const timer = fakePromptTimer();
    const result = promptHidden('Admin passphrase: ', t, { timeoutSeconds: DEFAULT_PROMPT_TIMEOUT_SECONDS, timer: timer.timer });
    expect(timer.delays).toEqual([120_000]);
    t.input.write('half-typed-secret');
    timer.fire();
    await expect(result).rejects.toBeInstanceOf(PromptTimeoutError);
    await expect(result).rejects.toThrow(/Admin passphrase.*120 s.*no answer was assumed/);
    expect(t.input.rawModes).toEqual([true, false]);
    // Nothing listens any more: what is typed afterwards goes nowhere, and no timer is left.
    expect(t.input.listenerCount('data')).toBe(0);
    expect(timer.pending()).toBe(0);
  });

  it('promptHidden: an answer in time clears the timer', async () => {
    const t = fakeTerminal();
    const timer = fakePromptTimer();
    const result = promptHidden('P: ', t, { timeoutSeconds: 5, timer: timer.timer });
    t.input.write('abc\n');
    expect(await result).toBe('abc');
    expect(timer.pending()).toBe(0);
  });

  it('promptLine: on expiry it rejects, it never answers n or y by itself', async () => {
    const t = fakeTerminal();
    const timer = fakePromptTimer();
    const result = promptLine('Revoke? [y/N] ', t, { timeoutSeconds: 120, timer: timer.timer });
    t.input.write('y');
    timer.fire();
    await expect(result).rejects.toBeInstanceOf(PromptTimeoutError);
    expect(t.input.listenerCount('data')).toBe(0);
    expect(timer.pending()).toBe(0);
  });

  it('withPromptTimeout (injected prompts): a value that arrives after the limit is dropped, an answer in time passes', async () => {
    const timer = fakePromptTimer();
    let late: (v: string) => void = () => undefined;
    const slow = withPromptTimeout(() => new Promise<string>((r) => (late = r)), { timeoutSeconds: 30, timer: timer.timer });
    const pending = slow('Admin passphrase: ');
    timer.fire();
    await expect(pending).rejects.toThrow(/within 30 s/);
    late('too-late');
    await Promise.resolve();
    const fast = withPromptTimeout(async () => 'y', { timeoutSeconds: 30, timer: timer.timer });
    expect(await fast('q')).toBe('y');
    expect(timer.pending()).toBe(0);
  });
});

describe('--prompt-timeout', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'machine-ptimeout-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('must be a whole number of seconds from 1 to 3600, and only on the commands that ask a question', async () => {
    await ok(dir, ['init', '--name', 'laptop']);
    for (const bad of ['0', '3601', 'abc', '1.5', '-1']) {
      const r = await cli(dir, ['join', 'relay.example.test', '--prompt-timeout', bad]);
      expect(r.code, bad).toBe(2);
      expect(r.err).toMatch(/--prompt-timeout must be a whole number of seconds from 1 to 3600/);
    }
    const status = await cli(dir, ['status', '--prompt-timeout', '30']);
    expect(status.code).toBe(2);
    expect(status.err).toMatch(/only applies to the commands that ask a question/);
    expect((await cli(dir, ['admin', 'pin', 'x.json', '--prompt-timeout', '30'])).code).toBe(2);
  });

  it('the value reaches the prompts (30 s = 30000 ms), the default is 120000 ms', async () => {
    const a = join(dir, 'a2');
    mkdirSync(a);
    await ok(a, ['init', '--name', 'desktop']);
    const generated = await ok(a, ['admin', 'init', '--generate']);
    expect(generated.code).toBe(0);
    const peer = await ok(a, ['peer', 'info', '--out', join(dir, 'info.json')]);
    expect(peer.code).toBe(0);

    const custom = fakePromptTimer();
    const withFlag = await cli(a, ['admin', 'register', join(dir, 'info.json'), '--out', join(dir, 'x.json'), '--prompt-timeout', '30'], async () => 'wrong passphrase', { promptTimer: custom.timer });
    expect(withFlag.code).toBe(1);
    expect(custom.delays).toEqual([30_000]);

    const byDefault = fakePromptTimer();
    await cli(a, ['admin', 'register', join(dir, 'info.json'), '--out', join(dir, 'y.json')], async () => 'wrong passphrase', { promptTimer: byDefault.timer });
    expect(byDefault.delays).toEqual([120_000]);
  });
});

describe('admin commands: nothing is done when the person does not answer', () => {
  let root: string;
  let a: string;
  let b: string;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'machine-humant-'));
    a = join(root, 'a');
    b = join(root, 'b');
    mkdirSync(a);
    mkdirSync(b);
    await provision(root, a, b, [{ shell: 'cmd', command: 'echo ok' }]);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('admin revoke, question open: after the limit nothing is signed and the machine is still trusted', async () => {
    const t = fakePromptTimer();
    const run = cli(a, ['admin', 'revoke', 'laptop'], async () => 'never asked', { ask: hang, promptTimer: t.timer });
    await vi.waitFor(() => expect(t.pending()).toBe(1));
    t.fire();
    const r = await run;
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no answer to the prompt "Revoke "laptop".*within 120 s/s);
    expect(r.err).toMatch(/Nothing was signed or revoked/);
    expect(r.err).toMatch(/machine admin revoke laptop/);
    expect(r.err).toMatch(/--prompt-timeout/);
    expect(loadNetwork(a, Math.floor(Date.now() / 1000)).directory.machines().map((m) => m.name)).toContain('laptop');
  });

  it('admin revoke, passphrase prompt open: a passphrase typed after the limit revokes nothing', async () => {
    const t = fakePromptTimer();
    let late: (v: string) => void = () => undefined;
    const run = cli(a, ['admin', 'revoke', 'laptop'], () => new Promise<string>((r) => (late = r)), { ask: yes, promptTimer: t.timer });
    await vi.waitFor(() => expect(t.delays.length).toBe(2));
    t.fire();
    const r = await run;
    late('the real passphrase, too late');
    await Promise.resolve();
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Admin passphrase.*within 120 s/);
    expect(loadNetwork(a, Math.floor(Date.now() / 1000)).directory.machines().map((m) => m.name)).toContain('laptop');
  });

  it('admin sign-policy, passphrase prompt open: nothing is signed, no file is written', async () => {
    const t = fakePromptTimer();
    const out = join(root, 'never.json');
    const run = cli(a, ['admin', 'sign-policy', join(root, 'draft.json'), '--out', out, '--prompt-timeout', '45'], hang, { promptTimer: t.timer });
    await vi.waitFor(() => expect(t.pending()).toBe(1));
    expect(t.delays).toEqual([45_000]);
    t.fire();
    const r = await run;
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/within 45 s/);
    expect(r.err).toMatch(/Nothing was signed and no file was written/);
    expect(existsSync(out)).toBe(false);
  });

  it('admin register, passphrase prompt open: nothing is signed, no bundle is written', async () => {
    const t = fakePromptTimer();
    const out = join(root, 'bundle-never.json');
    const run = cli(a, ['admin', 'register', join(root, 'b-info.json'), '--out', out], hang, { promptTimer: t.timer });
    await vi.waitFor(() => expect(t.pending()).toBe(1));
    t.fire();
    const r = await run;
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Nothing was signed and no file was written/);
    expect(existsSync(out)).toBe(false);
  });

  it('admin login --full-access on a relay that predates the full-access login, pairing prompt open: nothing is claimed or stored', async () => {
    const old = await startFakeRelay({ fullLogin: 'rejects' });
    try {
      const t = fakePromptTimer();
      const run = cli(a, ['admin', 'login', '--full-access', '--relay', old.url], hang, { promptTimer: t.timer });
      await vi.waitFor(() => expect(t.pending()).toBe(1));
      t.fire();
      const r = await run;
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/Nothing was claimed or stored/);
      expect(old.requests.some((q) => q.path === '/api/pairings/claim')).toBe(false);
    } finally {
      await old.close();
    }
  });
});

describe('admin approve and join: the relay flow', () => {
  let root: string;
  let cand: string;
  let adminDir: string;
  let relay: FakeRelay;
  let admin: TestAdmin;

  const approvalFor = () => buildApproval(admin, cand);
  const runJoinCli = (args: string[] = [], io: Parameters<typeof cli>[3] = {}) => cli(cand, ['join', '12345678', '--relay', relay.url, ...args], undefined, io);
  const resume = (args: string[] = [], io: Parameters<typeof cli>[3] = {}) => cli(cand, ['join', '--resume', ...args], undefined, io);
  const approveOnFirstSleep = (approval: unknown, options?: { bind?: boolean }) =>
    fakeTiming((_ms, n) => {
      if (n === 1) relay.approve(relay.pendingIds()[0] as string, approval, options);
    });
  const decisions = () => relay.requests.filter((q) => q.method === 'PUT' && q.path.endsWith('/decision'));

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'machine-humanr-'));
    cand = join(root, 'cand');
    adminDir = join(root, 'admin');
    mkdirSync(cand);
    mkdirSync(adminDir);
    relay = await startFakeRelay();
    await ok(cand, ['init', '--name', 'laptop']);
    await ok(adminDir, ['init', '--name', 'desktop']);
    admin = makeAdmin(adminDir);
  });
  afterEach(async () => {
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function adminReady(): Promise<string> {
    await ok(adminDir, ['admin', 'login', '87654321', '--full-access', '--relay', relay.url]);
    await ok(cand, ['join', '12345678', '--relay', relay.url, '--no-wait']);
    return [...relay.candidacies.keys()].at(-1) as string;
  }
  const approveArgs = (id: string) => ['admin', 'approve', id, '--relay', relay.url];

  it('admin approve, question open: after the limit nothing is signed or sent, the candidacy stays pending', async () => {
    const id = await adminReady();
    const t = fakePromptTimer();
    const run = cli(adminDir, approveArgs(id), async () => admin.passphrase, { ask: hang, promptTimer: t.timer });
    await vi.waitFor(() => expect(t.pending()).toBe(1));
    t.fire();
    const r = await run;
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Approve this machine.*within 120 s/s);
    expect(r.err).toMatch(/Nothing was signed or sent to the relay/);
    expect(decisions()).toHaveLength(0);
    expect(relay.candidacies.get(id)?.status).toBe('pending');
    expect(loadNetwork(adminDir, Math.floor(Date.now() / 1000)).directory.machines()).toHaveLength(0);
  });

  it('admin approve, passphrase prompt open: after the limit nothing is sent, and a late passphrase is not used', async () => {
    const id = await adminReady();
    const t = fakePromptTimer();
    let late: (v: string) => void = () => undefined;
    const run = cli(adminDir, approveArgs(id), () => new Promise<string>((r) => (late = r)), { ask: yes, promptTimer: t.timer });
    await vi.waitFor(() => expect(t.delays.length).toBe(2));
    t.fire();
    const r = await run;
    late(admin.passphrase);
    await Promise.resolve();
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Admin passphrase.*within 120 s/);
    expect(decisions()).toHaveLength(0);
    expect(relay.candidacies.get(id)?.status).toBe('pending');
    expect(loadNetwork(adminDir, Math.floor(Date.now() / 1000)).directory.machines()).toHaveLength(0);
  });

  it('admin approve: a candidacy that expired while the questions were open is not signed for', async () => {
    const id = await adminReady();
    let offsetSeconds = 0;
    const now = () => new Date(Date.now() + offsetSeconds * 1000);
    // The admin takes 16 minutes to answer: the candidacy lives 15.
    const slowYes = async () => {
      offsetSeconds = 16 * 60;
      return 'y';
    };
    const r = await cli(adminDir, approveArgs(id), async () => admin.passphrase, { ask: slowYes, now });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/expired .*ago \(\d\d:\d\d\), while the question was open: nothing was signed or sent/);
    expect(r.err).toMatch(/machine join --resume/);
    expect(decisions()).toHaveLength(0);
  });

  it('admin approve: the approval carries the random of the candidacy it answers', async () => {
    const id = await adminReady();
    const r = await cli(adminDir, approveArgs(id), async () => admin.passphrase, { ask: yes });
    expect(r.code, r.err).toBe(0);
    const approval = (decisions()[0]?.body as { approval: { random?: string } }).approval;
    expect(approval.random).toBe(relay.candidacies.get(id)?.random);
  });

  it('join, final code question open: after the limit nothing is pinned, the approval stays for a --resume', async () => {
    const t = fakePromptTimer();
    const run = runJoinCli([], { timing: approveOnFirstSleep(await approvalFor()), ask: hang, promptTimer: t.timer });
    await vi.waitFor(() => expect(t.pending()).toBe(1));
    t.fire();
    const r = await run;
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/show exactly this security code.*within 120 s/s);
    expect(r.err).toMatch(/NOT pinned/);
    expect(r.err).toMatch(/machine join --resume/);
    expect(existsSync(adminPinFile(cand))).toBe(false);
    expect(loadNetwork(cand, Math.floor(Date.now() / 1000)).directory.machines()).toHaveLength(0);
    expect(readCandidacy(cand)?.approval).toBeDefined();
  });

  it('join, final code question answered after the approval got too old: nothing is pinned, the file is dropped', async () => {
    let offsetSeconds = 0;
    const now = () => new Date(Date.now() + offsetSeconds * 1000);
    const slowYes = async () => {
      offsetSeconds = (APPROVAL_MAX_AGE_SECONDS + 60);
      return 'y';
    };
    const r = await runJoinCli(['--prompt-timeout', '3600'], { timing: approveOnFirstSleep(await approvalFor()), ask: slowYes, now });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/the approval is too old/);
    expect(r.err).toMatch(/machine join --resume/);
    expect(existsSync(adminPinFile(cand))).toBe(false);
    expect(existsSync(candidacyFile(cand))).toBe(false);
  });

  describe('a stored approval has a maximum age', () => {
    async function storedApproval(): Promise<string> {
      const first = await runJoinCli([], { timing: approveOnFirstSleep(await approvalFor()), ask: noTty });
      expect(first.code).toBe(1);
      expect(readCandidacy(cand)?.approvalReceivedAt).toBeTypeOf('number');
      return lastCodeLine(first.out);
    }

    it('re-run within 15 minutes: it still enrolls', async () => {
      const code = await storedApproval();
      const second = await resume(['--yes-final-code', code], { ask: noTty, timing: fakeTiming() });
      expect(second.code, second.err).toBe(0);
      expect(readAdminPin(cand).adminKeyId).toBe(admin.adminKeyId);
    });

    it('re-run after 15 minutes: discarded with the instruction, nothing pinned, the next --resume posts a new candidacy', async () => {
      const code = await storedApproval();
      const old = readCandidacy(cand);
      writeCandidacy(cand, { ...(old as NonNullable<typeof old>), approvalReceivedAt: (old?.approvalReceivedAt as number) - (APPROVAL_MAX_AGE_SECONDS + 60) });
      const before = relay.requests.length;

      const second = await resume(['--yes-final-code', code], { ask: noTty, timing: fakeTiming() });
      expect(second.code).toBe(1);
      expect(second.err).toMatch(/the approval is too old/);
      expect(second.err).toMatch(/ask the admin to approve again: run `machine join --resume`/);
      expect(existsSync(adminPinFile(cand))).toBe(false);
      expect(loadNetwork(cand, Math.floor(Date.now() / 1000)).directory.machines()).toHaveLength(0);
      // The old candidacy (and so its random) is gone: a replayed old approval cannot match the next one.
      expect(existsSync(candidacyFile(cand))).toBe(false);
      expect(relay.requests.slice(before).filter((q) => q.method === 'POST')).toHaveLength(0);

      const third = await resume(['--no-wait'], { timing: fakeTiming() });
      expect(third.code, third.err).toBe(0);
      const randoms = [...relay.candidacies.values()].map((c) => c.random);
      expect(new Set(randoms).size).toBe(2);
    });

    it('a candidacy file with an approval but no date of receipt (older version) is treated as too old', async () => {
      const code = await storedApproval();
      const old = readCandidacy(cand) as NonNullable<ReturnType<typeof readCandidacy>>;
      const { approvalReceivedAt: _dropped, ...withoutDate } = old;
      writeCandidacy(cand, withoutDate);
      const second = await resume(['--yes-final-code', code], { ask: noTty, timing: fakeTiming() });
      expect(second.code).toBe(1);
      expect(second.err).toMatch(/too old.*date of receipt is unknown/);
      expect(existsSync(adminPinFile(cand))).toBe(false);
    });
  });

  describe('the approval is bound to the candidacy (random)', () => {
    const refused = async (approval: unknown, bind: boolean, pattern: RegExp) => {
      const r = await runJoinCli([], { timing: approveOnFirstSleep(approval, { bind }), ask: yes });
      expect(r.code).toBe(1);
      expect(r.err).toMatch(pattern);
      expect(r.err).toMatch(/Nothing was pinned or imported/);
      expect(existsSync(adminPinFile(cand))).toBe(false);
      expect(loadNetwork(cand, Math.floor(Date.now() / 1000)).directory.machines()).toHaveLength(0);
    };

    it('an approval of another candidacy (old replay, other random) is refused before anything else', async () => {
      const approval = { ...(await approvalFor()), random: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
      await refused(approval, false, /answers another candidacy.*replay/s);
    });

    it('the mismatch is checked first: a document that is otherwise broken still gets the replay message', async () => {
      await refused({ v: 1, random: 'BBBB' }, false, /answers another candidacy/);
    });

    it('an approval without random is refused (older admin, or a replay)', async () => {
      await refused(await approvalFor(), false, /no "random" binding it to this candidacy/);
    });

    it('an approval with the right random passes', async () => {
      const r = await runJoinCli([], { timing: approveOnFirstSleep(await approvalFor()), ask: yes });
      expect(r.code, r.err).toBe(0);
    });
  });

  describe('waiting for the admin never outlasts the candidacy', () => {
    it('--timeout 86400 with a relay that never answers: stops with the candidacy (about 15 minutes), says it expired', async () => {
      const timing = fakeTiming();
      const r = await runJoinCli(['--timeout', '86400'], { timing, ask: yes });
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/expired before the admin decided/);
      const waited = timing.sleeps.reduce((s, n) => s + n, 0);
      // 900 s of candidacy + 5 s of margin, not a day.
      expect(waited).toBeLessThanOrEqual(905_000 + 3_000);
      expect(waited).toBeGreaterThanOrEqual(895_000);
    });

    it('the default --timeout is 900 s', async () => {
      const timing = fakeTiming();
      const r = await runJoinCli([], { timing, ask: yes });
      expect(r.code).toBe(1);
      expect(timing.sleeps.reduce((s, n) => s + n, 0)).toBeLessThanOrEqual(905_000 + 3_000);
    });
  });
});

describe('device login lifetime', () => {
  let root: string;
  let dir: string;
  let relay: FakeRelay;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'machine-devlife-'));
    dir = join(root, 'cand');
    mkdirSync(dir);
    relay = await startFakeRelay({ deviceExpiresIn: 86_400 });
    await ok(dir, ['init', '--name', 'laptop']);
  });
  afterEach(async () => {
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('a relay announcing a day does not make the client wait a day: capped at 15 minutes, nothing stored', async () => {
    const timing = fakeTiming();
    const r = await cli(dir, ['join', relay.url, '--no-wait'], undefined, { ask: async () => 'n', timing });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/expired before it was approved \(it lives 15 min\)/);
    const waited = timing.sleeps.reduce((s, n) => s + n, 0);
    expect(MAX_DEVICE_LOGIN_SECONDS).toBe(900);
    expect(waited).toBeLessThanOrEqual(900_000 + 5_000 + 3_000);
    expect(waited).toBeGreaterThanOrEqual(900_000);
    expect(existsSync(join(dir, '_secrets_', 'relay.json'))).toBe(false);
  });
});
