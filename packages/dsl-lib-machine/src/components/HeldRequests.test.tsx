import { generateSigningKeyPair, encryptAdminKey, keyId, type SignedPolicy } from '@wadeck-app/machine-core';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeldRequests, type HeldRequestRow } from './HeldRequests.js';

// The held requests of the Requests page (`machine run --wait`): a caller waits, the owner reads the command and allows (signed, passphrase) or denies
// (restricting: no signature, no passphrase). The app-core shell is a stub on globalThis; the module backend is a recording fake.

const PASSPHRASE = 'correct horse battery staple 7391';
const SELF = '22222222-2222-4222-8222-222222222222';
const PEER = '11111111-1111-4111-8111-111111111111';

const admin = generateSigningKeyPair();
const ADMIN_KEY_ID = keyId(admin.publicKey);
const keyFile = JSON.stringify(encryptAdminKey(admin, PASSPHRASE));

const ROWS: HeldRequestRow[] = [
  { id: 'aaaa1111', peerText: 'thinkcentre', peer: PEER, shell: 'sh', command: 'ls', secondsLeft: 95, askedText: '5 s ago', countText: 'waiting now', nextCommand: 'machine admin allow desktop --shell sh -- ls', nextWhere: '' },
  { id: 'bbbb2222', peerText: 'thinkcentre', peer: PEER, shell: 'sh', command: 'df -h', secondsLeft: 540, askedText: '20 s ago', countText: 'waiting now', nextCommand: 'machine admin allow desktop --shell sh -- "df -h"', nextWhere: '' },
];
const ALLOW = { available: true, machine: { uuid: SELF, name: 'desktop' }, note: '' };

const context = () => ({ ok: true, target: { uuid: SELF, name: 'desktop' }, toSelf: true, policyMode: 'admin', adminKeyId: ADMIN_KEY_ID, adminPublicKey: admin.publicKey, current: null as SignedPolicy | null, source: 'installed on this machine', delivery: 'install' });

interface Call { url: string; body: unknown; headers: Record<string, string> | undefined }
let calls: Call[];
let elevate: ReturnType<typeof vi.fn>;
let denyAnswer: unknown;

beforeEach(() => {
  calls = [];
  denyAnswer = { ok: true, id: 'aaaa1111', peer: PEER, shell: 'sh', command: 'ls' };
  elevate = vi.fn(async () => undefined);
  const fetcher = async (url: string, _params?: Record<string, string>, body?: unknown, headers?: Record<string, string>) => {
    calls.push({ url, body, headers });
    if (url === `GET /api/modules/machine/allow/${SELF}`) {
      return context();
    }
    if (url === 'GET /api/modules/machine/admin-key') {
      return { file: keyFile };
    }
    if (url === 'POST /api/modules/machine/allow') {
      return { ok: true, target: { uuid: SELF, name: 'desktop' }, version: 1, delivery: 'installed' };
    }
    if (url === 'POST /api/modules/machine/deny') {
      if (denyAnswer instanceof Error) {
        throw denyAnswer;
      }
      return denyAnswer;
    }
    throw new Error(`unexpected call ${url}`);
  };
  Object.defineProperty(globalThis, '__APP_CORE_SHELL__', { value: { elevate, fetcher }, configurable: true, writable: true });
});
afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, '__APP_CORE_SHELL__');
  window.localStorage.clear();
  window.sessionStorage.clear();
});

const itemOf = (command: string) => screen.getByRole('listitem', { name: `Held request ${command}` });

describe('the list', () => {
  it('renders nothing when no request is held (no empty heading)', () => {
    const { container } = render(<HeldRequests rows={[]} allow={ALLOW} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows each held request with the command prominent, the peer, the shell and Allow and Deny buttons that name the command', () => {
    render(<HeldRequests rows={ROWS} allow={ALLOW} />);
    expect(screen.getByRole('heading', { name: /waiting for your answer/i })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    const item = itemOf('df -h');
    const command = within(item).getByText('df -h');
    expect(command.className).toMatch(/font-mono/);
    expect(command.className).toMatch(/text-lg/);
    expect(within(item).getByText('thinkcentre')).toBeInTheDocument();
    expect(within(item).getByText('sh')).toBeInTheDocument();
    expect(within(item).getByRole('button', { name: 'Allow df -h' })).toBeInTheDocument();
    expect(within(item).getByRole('button', { name: 'Deny df -h' })).toBeInTheDocument();
  });

  it('where Allow is not available: no Allow button, the note and the CLI command are shown, Deny stays', () => {
    render(<HeldRequests rows={ROWS} allow={{ ...ALLOW, available: false, note: 'Only the admin machine can allow a command.' }} />);
    expect(screen.queryByRole('button', { name: /^Allow/ })).toBeNull();
    expect(screen.getByText(/Only the admin machine can allow/)).toBeInTheDocument();
    expect(screen.getByText('machine admin allow desktop --shell sh -- ls')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny ls' })).toBeInTheDocument();
  });
});

describe('the countdown', () => {
  it('counts down every second from the seconds left of the fetch, and says expired at 0', () => {
    vi.useFakeTimers();
    render(<HeldRequests rows={[ROWS[0] as HeldRequestRow]} allow={ALLOW} />);
    expect(within(itemOf('ls')).getByText('1 min 35 s left')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(within(itemOf('ls')).getByText('1 min 32 s left')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(within(itemOf('ls')).getByText('32 s left')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(40_000); });
    expect(within(itemOf('ls')).getByText('expired')).toBeInTheDocument();
    expect(within(itemOf('ls')).queryByRole('button', { name: /^Allow/ })).toBeNull();
    expect(within(itemOf('ls')).queryByRole('button', { name: /^Deny/ })).toBeNull();
  });

  it('a refreshed list starts again from its own seconds left', () => {
    vi.useFakeTimers();
    const { rerender } = render(<HeldRequests rows={[ROWS[0] as HeldRequestRow]} allow={ALLOW} />);
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(within(itemOf('ls')).getByText('1 min 15 s left')).toBeInTheDocument();
    rerender(<HeldRequests rows={[{ ...(ROWS[0] as HeldRequestRow), secondsLeft: 300 }]} allow={ALLOW} />);
    expect(within(itemOf('ls')).getByText('5 min 0 s left')).toBeInTheDocument();
  });

  it('stops its timer when the page goes away', () => {
    vi.useFakeTimers();
    const { unmount } = render(<HeldRequests rows={ROWS} allow={ALLOW} />);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Deny', () => {
  it('opens a small form with an optional reason, Confirm deny and Cancel, and asks no passphrase and no PIN yet', async () => {
    render(<HeldRequests rows={ROWS} allow={ALLOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Deny df -h' }));
    const item = itemOf('df -h');
    const reason = within(item).getByLabelText(/reason/i);
    expect(reason).toHaveAttribute('maxlength', '200');
    expect(within(item).getByRole('button', { name: 'Confirm deny' })).toBeInTheDocument();
    expect(within(item).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(within(item).queryByLabelText(/passphrase/i)).toBeNull();
    expect(item.querySelector('input[type="password"]')).toBeNull();
    // The PIN is asked when the owner confirms, not when the form opens.
    expect(elevate).not.toHaveBeenCalled();
  });

  it('Cancel closes the form and posts nothing', async () => {
    render(<HeldRequests rows={ROWS} allow={ALLOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Deny ls' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Confirm deny' })).toBeNull();
    expect(calls).toEqual([]);
  });

  it('asks the PIN first (the route is sensitive), then posts only {id, reason} with the module header, no passphrase; the row leaves and the page refreshes', async () => {
    const onRefresh = vi.fn(async () => undefined);
    render(<HeldRequests rows={ROWS} allow={ALLOW} onRefresh={onRefresh} />);
    await userEvent.click(screen.getByRole('button', { name: 'Deny ls' }));
    await userEvent.type(screen.getByLabelText(/reason/i), 'not now, ask again later');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm deny' }));
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Held request ls' })).toBeNull());
    expect(calls).toEqual([{ url: 'POST /api/modules/machine/deny', body: { id: 'aaaa1111', reason: 'not now, ask again later' }, headers: { 'x-machine-module': '1' } }]);
    expect(elevate).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledWith('requests');
    expect(await screen.findByRole('status')).toHaveTextContent(/denied/i);
    expect(itemOf('df -h')).toBeInTheDocument();
  });

  it('posts no reason key when the field is empty', async () => {
    render(<HeldRequests rows={ROWS} allow={ALLOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Deny ls' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm deny' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ id: 'aaaa1111' });
  });

  it.each([
    ['a reason with an accent', String.fromCharCode(99, 97, 102, 233), /printable ASCII/],
    ['a reason over 200 characters', 'x'.repeat(201), /at most 200/],
  ])('%s is refused in the form with the fix, and nothing is posted', async (_name, text, message) => {
    render(<HeldRequests rows={ROWS} allow={ALLOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Deny ls' }));
    const field = screen.getByLabelText(/reason/i);
    field.removeAttribute('maxlength');
    await userEvent.click(field);
    await userEvent.paste(text);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm deny' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(calls).toEqual([]);
  });

  it('a cancelled PIN is reported with the fix, nothing is posted, the form stays', async () => {
    elevate.mockRejectedValueOnce(new Error('Sensitive action cancelled: PIN not entered'));
    render(<HeldRequests rows={ROWS} allow={ALLOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Deny ls' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm deny' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/PIN not entered/);
    expect(alert).toHaveTextContent(/Deny needs the app-core PIN/);
    expect(alert).toHaveTextContent(/Confirm deny again/);
    expect(calls).toEqual([]);
    expect(screen.getByRole('button', { name: 'Confirm deny' })).toBeEnabled();
  });

  it.each([
    ['401 elevation-required', 'elevation-required: the PIN session is missing or expired (401)', /enter the app-core PIN/],
    ['403 pin-not-set', 'pin-not-set: no PIN has been chosen yet (403)', /app-core-cli pin set/],
  ])('%s on the post is answered with an actionable sentence', async (_name, raw, fix) => {
    denyAnswer = new Error(raw);
    render(<HeldRequests rows={ROWS} allow={ALLOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Deny ls' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm deny' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(raw);
    expect(alert).toHaveTextContent(fix);
    expect(itemOf('ls')).toBeInTheDocument();
  });

  it('shows the message of the daemon when the Deny fails, and the row and the form stay for another try', async () => {
    denyAnswer = new Error('"aaaa1111" does not name a waiting request: it may have been answered or may have expired; reload the page');
    render(<HeldRequests rows={ROWS} allow={ALLOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Deny ls' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm deny' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/does not name a waiting request/);
    expect(itemOf('ls')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm deny' })).toBeEnabled();
  });
});

describe('Allow', () => {
  it('opens the existing confirmation with the exact command and the admin passphrase field (same attributes as the table)', async () => {
    render(<HeldRequests rows={ROWS} allow={ALLOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow df -h' }));
    const dialog = await screen.findByRole('dialog');
    const input = await within(dialog).findByLabelText('Admin passphrase');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('name', 'machine-admin-passphrase');
    expect(input).toHaveAttribute('autocomplete', 'current-password');
    expect(within(dialog).getByText('df -h')).toBeInTheDocument();
    expect(elevate).toHaveBeenCalledTimes(1);
  });

  it('signs in the page, posts only the signed policy, the row leaves and the page refreshes', async () => {
    const onRefresh = vi.fn(async () => undefined);
    render(<HeldRequests rows={ROWS} allow={ALLOW} onRefresh={onRefresh} />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow ls' }));
    await userEvent.type(await screen.findByLabelText('Admin passphrase'), PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Allow and sign' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 20_000 });
    const post = calls.find((c) => c.url === 'POST /api/modules/machine/allow');
    expect(Object.keys(post?.body as object)).toEqual(['policy']);
    expect(JSON.stringify(calls)).not.toContain(PASSPHRASE);
    expect(screen.queryByRole('listitem', { name: 'Held request ls' })).toBeNull();
    expect(onRefresh).toHaveBeenCalledWith('requests');
    expect(await screen.findByRole('status')).toHaveTextContent(/policy version 1 is installed on desktop/i);
  }, 120_000);
});

describe('a request held on ANOTHER machine (listed by the admin machine)', () => {
  const LAPTOP = '33333333-3333-4333-8333-333333333333';
  const remote: HeldRequestRow = {
    id: 'cccc3333-0000-4000-8000-000000000000',
    peerText: 'midgard2',
    peer: PEER,
    shell: 'cmd',
    command: 'hostname',
    secondsLeft: 300,
    askedText: '10 s ago',
    countText: 'waiting now',
    nextCommand: 'machine admin allow laptop --shell cmd -- hostname',
    nextWhere: '',
    machine: { uuid: LAPTOP, name: 'laptop' },
    canAllow: true,
  };

  it('names the machine that holds it and offers Allow and Deny (no "run it ON the machine" workaround text)', () => {
    render(<HeldRequests rows={[remote]} allow={ALLOW} />);
    const item = itemOf('hostname');
    expect(within(item).getByText('laptop')).toBeInTheDocument();
    expect(within(item).getByRole('button', { name: 'Allow hostname' })).toBeInTheDocument();
    expect(within(item).getByRole('button', { name: 'Deny hostname' })).toBeInTheDocument();
    expect(within(item).queryByText(/machine requests --deny/)).toBeNull();
  });

  it('Deny of a request held elsewhere posts the id, the machine and the reason after the PIN, and says which machine was told (decision 85)', async () => {
    denyAnswer = { ok: true, id: remote.id, peer: { uuid: LAPTOP, name: 'laptop' } };
    render(<HeldRequests rows={[remote]} allow={ALLOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Deny hostname' }));
    await userEvent.type(screen.getByLabelText(/reason/i), 'not now');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm deny' }));
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Held request hostname' })).toBeNull());
    expect(calls).toEqual([{ url: 'POST /api/modules/machine/deny', body: { id: remote.id, machine: LAPTOP, reason: 'not now' }, headers: { 'x-machine-module': '1' } }]);
    expect(elevate).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('status')).toHaveTextContent(/laptop/);
  });

  it('when the target refuses because this machine is not a notice recipient, the form shows its cause and the fix, and the row stays', async () => {
    denyAnswer = new Error('laptop does not list you as a recipient of its request notices: add this machine with `machine admin notify-to <machines>` on the admin machine, or run `machine requests --deny <id>` ON laptop');
    render(<HeldRequests rows={[remote]} allow={ALLOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Deny hostname' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm deny' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/does not list you/);
    expect(alert).toHaveTextContent(/machine admin notify-to/);
    expect(alert).toHaveTextContent(/machine requests --deny <id>.*ON laptop/);
    expect(itemOf('hostname')).toBeInTheDocument();
  });

  it('an older target (peer-too-old) is told to update: the message of the backend is shown as it is', async () => {
    denyAnswer = new Error('laptop is too old to accept a remote deny: run `machine cli update` on laptop');
    render(<HeldRequests rows={[remote]} allow={ALLOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Deny hostname' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm deny' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/machine cli update/);
  });

  it('Allow asks the policy of THAT machine (its uuid), not of this one', async () => {
    render(<HeldRequests rows={[remote]} allow={ALLOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow hostname' }));
    await screen.findByRole('dialog');
    await waitFor(() => expect(calls.some((c) => c.url === `GET /api/modules/machine/allow/${LAPTOP}`)).toBe(true));
    expect(calls.some((c) => c.url === `GET /api/modules/machine/allow/${SELF}`)).toBe(false);
  });

  it('with canAllow false (the peer is in mode local) the command is shown, not a button, even when this machine can allow its own', () => {
    render(<HeldRequests rows={[{ ...remote, canAllow: false }]} allow={ALLOW} />);
    const item = itemOf('hostname');
    expect(within(item).queryByRole('button', { name: /^Allow/ })).toBeNull();
    expect(within(item).getByText('machine admin allow laptop --shell cmd -- hostname')).toBeInTheDocument();
  });

  it('counts down from the time its own list was read, not from the arrival of the other rows', () => {
    vi.useFakeTimers();
    const start = Date.now();
    render(<HeldRequests rows={[{ ...remote, fetchedAtMs: start - 20_000 }]} allow={ALLOW} />);
    expect(within(itemOf('hostname')).getByText('4 min 40 s left')).toBeInTheDocument();
  });
});
