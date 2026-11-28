import { describe, expect, it, vi } from 'vitest';
import type { AllowApi } from './allowFlow.js';
import { cancelAdminLogin, parseAdminLogin, readAdminLogin, startAdminLogin } from './adminLoginFlow.js';

// The relay login started from the page: the calls to the module routes and the strict reading of their answers. An answer that is not what the daemon promises is an
// internal error that names the answer, never an empty state (a button that silently does nothing is worse than none).

const WAITING = { ok: true, state: 'waiting', userCode: 'ADMN-7K42', verificationUrl: 'https://relay.example.net/console', label: 'desk admin', relayUrl: 'https://relay.example.net', expiresAt: 1_800_000_300, consoleHint: 'Compare.' };

describe('parseAdminLogin', () => {
  it('reads each state of the daemon', () => {
    expect(parseAdminLogin({ ok: true, state: 'idle' })).toEqual({ ok: true, state: 'idle' });
    expect(parseAdminLogin(WAITING)).toEqual(WAITING);
    expect(parseAdminLogin({ ok: true, state: 'approved', label: 'desk admin', scopes: ['machine-admin'] })).toEqual({ ok: true, state: 'approved', label: 'desk admin', scopes: ['machine-admin'] });
    expect(parseAdminLogin({ ok: true, state: 'failed', message: 'denied' })).toEqual({ ok: true, state: 'failed', message: 'denied' });
  });

  it.each([
    ['not an object', 'idle'],
    ['no state', { ok: true }],
    ['an unknown state', { ok: true, state: 'dancing' }],
    ['a waiting login without a code', { ...WAITING, userCode: undefined }],
    ['a waiting login whose expiry is not a number', { ...WAITING, expiresAt: 'soon' }],
    ['a failed login without its cause', { ok: true, state: 'failed' }],
  ])('refuses %s, naming the answer', (_name, answer) => {
    expect(() => parseAdminLogin(answer)).toThrow(/the daemon answered the relay login with something this page does not understand/);
  });
});

function fakeApi(answers: { get?: unknown; post?: Record<string, unknown> }): AllowApi & { calls: string[]; elevate: ReturnType<typeof vi.fn> } {
  const calls: string[] = [];
  return {
    calls,
    elevate: vi.fn(async () => undefined),
    get: async (path: string) => {
      calls.push(`GET ${path}`);
      return answers.get;
    },
    post: async (path: string) => {
      calls.push(`POST ${path}`);
      return answers.post?.[path];
    },
  } as never;
}

describe('the calls', () => {
  it('start: the PIN first (the route is sensitive), then POST /admin-login with no body, and the waiting state', async () => {
    const api = fakeApi({ post: { '/admin-login': WAITING } });
    const answer = await startAdminLogin(api);
    expect(api.elevate).toHaveBeenCalledTimes(1);
    expect(api.calls).toEqual(['POST /admin-login']);
    expect(answer).toEqual(WAITING);
  });

  it('read: GET /admin-login, no PIN', async () => {
    const api = fakeApi({ get: { ok: true, state: 'idle' } });
    expect(await readAdminLogin(api)).toEqual({ ok: true, state: 'idle' });
    expect(api.elevate).not.toHaveBeenCalled();
  });

  it('cancel: the PIN, then POST /admin-login/cancel', async () => {
    const api = fakeApi({ post: { '/admin-login/cancel': { ok: true, state: 'idle' } } });
    expect(await cancelAdminLogin(api)).toEqual({ ok: true, state: 'idle' });
    expect(api.calls).toEqual(['POST /admin-login/cancel']);
    expect(api.elevate).toHaveBeenCalledTimes(1);
  });

  it('a malformed answer is an error, not a state', async () => {
    await expect(readAdminLogin(fakeApi({ get: { nope: 1 } }))).rejects.toThrow(/does not understand/);
  });
});
