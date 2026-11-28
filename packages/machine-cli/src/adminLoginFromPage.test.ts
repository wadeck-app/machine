import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminLoginByConsole } from './adminDeviceLogin.js';
import { createAdminLoginService, type AdminLoginAnswer } from './adminLoginFromPage.js';
import type { Timing } from './cliTypes.js';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { makeCommands } from './commands.js';
import { readRelayAdminConfig, writeRelayAdminConfig, writeRelayConfig } from './relayStore.js';

// The relay login of `machine admin login` started FROM THE PAGE (the Candidacies page, "not configured" state): the daemon starts the console login, keeps its state in
// memory (the code to compare, the wait, the result) and the page reads it. The admin still confirms in the relay console, comparing the code; nothing is stored
// before the relay delivered the token; the answers never carry the token. Never replaces an existing token.

let root: string;
let dir: string;
let relay: FakeRelay;

const CLAIMED = '2026-11-28T10:00:00.000Z';
const joinRelay = (url: string = relay.url): void => writeRelayConfig(dir, { relayUrl: url, token: 'machine-token-1', label: 'desk', claimedAt: CLAIMED }, false);

/** A timing whose sleeps wait for the test: `step()` lets ONE poll happen. */
function gatedTiming(): Timing & { step: () => Promise<void>; sleeps: number[] } {
  let t = 1_000_000;
  const sleeps: number[] = [];
  const gates: Array<() => void> = [];
  return {
    sleeps,
    nowMs: () => t,
    pollIntervalMs: 3000,
    sleep: (ms, signal) =>
      new Promise<void>((resolve) => {
        sleeps.push(ms);
        t += ms;
        gates.push(resolve);
        signal?.addEventListener('abort', () => resolve(), { once: true });
      }),
    step: async () => {
      // The loop sleeps first: wait until it is asleep, then wake it.
      for (let i = 0; i < 200 && gates.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
      const gate = gates.shift();
      if (gate === undefined) throw new Error('the login loop never went to sleep');
      gate();
    },
  };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-adminloginpage-'));
  dir = join(root, 'a');
  mkdirSync(dir);
  relay = await startFakeRelay();
});
afterEach(async () => {
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

const waiting = (a: AdminLoginAnswer): Extract<AdminLoginAnswer, { state: 'waiting' }> => {
  if (!a.ok || a.state !== 'waiting') throw new Error(`expected a waiting login, got ${JSON.stringify(a)}`);
  return a;
};

describe('adminLoginByConsole: onStarted', () => {
  it('hands the code, the page and the label to the caller as soon as the relay started the request (before the wait)', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const timing = gatedTiming();
    const login = adminLoginByConsole(dir, { relayUrl: relay.url, force: false, name: 'desk', say: () => undefined, timing, onStarted: (info) => seen.push({ ...info }) });
    await timing.step();
    relay.deviceApprove();
    await login;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ userCode: 'ADMN-7K42', label: 'desk admin', relayUrl: relay.url });
    expect(typeof seen[0]?.['verificationUrl']).toBe('string');
    expect(typeof seen[0]?.['expiresInSeconds']).toBe('number');
  });
});

describe('the login service of the page', () => {
  it('start: the relay request is made, the code to compare is answered (no token, no device code), the wait goes on in the background', async () => {
    joinRelay();
    const timing = gatedTiming();
    const service = createAdminLoginService(dir, { timing, hostname: () => 'Desk.local', now: () => 1_800_000_000_000 });
    const answer = waiting(await service.start());
    expect(answer.userCode).toBe('ADMN-7K42');
    expect(answer.label).toBe('desk admin');
    expect(answer.relayUrl).toBe(relay.url);
    expect(answer.expiresAt).toBeGreaterThan(1_800_000_000);
    expect(answer.consoleHint).toMatch(/Tokens/);
    expect(JSON.stringify(answer)).not.toMatch(/machine-token-1|deviceCode/);
    // Still waiting: nothing stored.
    expect(readRelayAdminConfig(dir)).toBeUndefined();
    expect(service.status()).toMatchObject({ ok: true, state: 'waiting', userCode: 'ADMN-7K42' });
    service.cancel();
  });

  it('the admin approves in the relay console: the next status is approved, the token is stored, and no answer carries it', async () => {
    joinRelay();
    const timing = gatedTiming();
    const service = createAdminLoginService(dir, { timing, hostname: () => 'Desk.local' });
    waiting(await service.start());
    relay.deviceApprove();
    await timing.step();
    await service.settled();
    const status = service.status();
    expect(status).toMatchObject({ ok: true, state: 'approved', label: 'desk admin' });
    expect(readRelayAdminConfig(dir)?.token).toBe(relay.machineAdminToken);
    expect(JSON.stringify(status)).not.toContain(relay.machineAdminToken);
    // The token is in the 0600 file only, never in what the page can read.
    expect(readFileSync(join(dir, '_secrets_', 'relay-admin.json'), 'utf8')).toContain(relay.machineAdminToken);
  });

  it('start twice while waiting: the SAME request (one relay request), never a second code', async () => {
    joinRelay();
    const service = createAdminLoginService(dir, { timing: gatedTiming(), hostname: () => 'Desk.local' });
    const first = waiting(await service.start());
    const second = waiting(await service.start());
    expect(second.userCode).toBe(first.userCode);
    expect(relay.deviceLogins.size).toBe(1);
    service.cancel();
  });

  it('a denied request ends as failed with the cause and how to start over; nothing is stored; start can be asked again', async () => {
    joinRelay();
    const timing = gatedTiming();
    const service = createAdminLoginService(dir, { timing, hostname: () => 'Desk.local' });
    waiting(await service.start());
    relay.deviceClick(relay.deviceChoices().find((c) => c !== 'ADMN-7K42') as string);
    await timing.step();
    await service.settled();
    const status = service.status();
    expect(status.ok && status.state).toBe('failed');
    expect(status.ok && status.state === 'failed' ? status.message : '').toMatch(/denied in the relay console/);
    expect(readRelayAdminConfig(dir)).toBeUndefined();
    // Again: a new request.
    const again = waiting(await service.start());
    expect(again.userCode).toBe('ADMN-7K42');
    service.cancel();
  });

  it('cancel: the wait stops, nothing is stored, the state is idle', async () => {
    joinRelay();
    const service = createAdminLoginService(dir, { timing: gatedTiming(), hostname: () => 'Desk.local' });
    waiting(await service.start());
    service.cancel();
    await service.settled();
    expect(service.status()).toEqual({ ok: true, state: 'idle' });
    expect(readRelayAdminConfig(dir)).toBeUndefined();
  });

  it('refuses when an admin token is already held (never replaces it): the answer says so', async () => {
    joinRelay();
    writeRelayAdminConfig(dir, { relayUrl: relay.url, token: 'admin-token-1', label: 'desk admin', claimedAt: CLAIMED }, false);
    const service = createAdminLoginService(dir, { timing: gatedTiming() });
    const answer = await service.start();
    expect(answer).toMatchObject({ ok: false, reason: 'already-configured' });
    expect(answer.ok ? '' : answer.message).toMatch(/already holds an admin relay token/);
    expect(relay.deviceLogins.size).toBe(0);
    expect(readRelayAdminConfig(dir)?.token).toBe('admin-token-1');
  });

  it('refuses when the token file is damaged: the answer names the file and the CLI command that replaces it (the page cannot)', async () => {
    joinRelay();
    mkdirSync(join(dir, '_secrets_'), { recursive: true });
    writeFileSync(join(dir, '_secrets_', 'relay-admin.json'), '{not json');
    const answer = await createAdminLoginService(dir, { timing: gatedTiming() }).start();
    expect(answer).toMatchObject({ ok: false, reason: 'token-file-invalid' });
    expect(answer.ok ? '' : answer.message).toMatch(/relay-admin\.json is corrupt or invalid/);
    expect(answer.ok ? '' : answer.message).toMatch(/machine admin login --force/);
  });

  it('refuses when this machine has no relay yet: names the setup command', async () => {
    const answer = await createAdminLoginService(dir, { timing: gatedTiming() }).start();
    expect(answer).toMatchObject({ ok: false, reason: 'no-relay' });
    expect(answer.ok ? '' : answer.message).toMatch(/machine setup/);
  });

  it('an unreachable relay: the answer says the relay did not answer (no state is kept, start can be asked again)', async () => {
    joinRelay('http://127.0.0.1:1');
    const service = createAdminLoginService(dir, { timing: gatedTiming() });
    const answer = await service.start();
    expect(answer).toMatchObject({ ok: false, reason: 'relay-error' });
    expect(answer.ok ? '' : answer.message).toMatch(/relay/i);
    expect(service.status()).toEqual({ ok: true, state: 'idle' });
  });

  it('status of a service that never started is idle', () => {
    expect(createAdminLoginService(dir, { timing: gatedTiming() }).status()).toEqual({ ok: true, state: 'idle' });
  });
});

describe('the daemon commands', () => {
  it('adminLoginStart, adminLoginStatus and adminLoginCancel are daemon commands sharing ONE service per daemon', async () => {
    joinRelay();
    const commands = makeCommands(dir, '0.0.0-test') as unknown as Record<string, (payload?: unknown) => Promise<AdminLoginAnswer> | AdminLoginAnswer>;
    expect(typeof commands['adminLoginStart']).toBe('function');
    expect(typeof commands['adminLoginStatus']).toBe('function');
    expect(typeof commands['adminLoginCancel']).toBe('function');
    expect(await commands['adminLoginStatus']!()).toEqual({ ok: true, state: 'idle' });
  });
});
