import React from 'react';
import { generateSigningKeyPair, encryptAdminKey, keyId, type SignedPolicy } from '@wadeck-app/machine-core';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signingsSettled } from '../lib/allowFlow.js';
import { HeldRequests, type HeldRequestRow } from './HeldRequests.js';

// The held requests of the Requests page (`machine run --wait`): a caller waits, the owner reads the command and allows (signed, passphrase) or denies
// (restricting: no signature, no passphrase). The app-core shell is a stub on globalThis; the module backend is a recording fake.

const PASSPHRASE = 'correct horse battery staple 7391';
const SELF = '22222222-2222-4222-8222-222222222222';
const PEER = '11111111-1111-4111-8111-111111111111';

const admin = generateSigningKeyPair();
const ADMIN_KEY_ID = keyId(admin.publicKey);
const keyFile = JSON.stringify(encryptAdminKey(admin, PASSPHRASE));
const hintedKeyFile = JSON.stringify(encryptAdminKey(admin, PASSPHRASE, { hint: 'the street of my first school' }));
let keyFileText: string;

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
let holdAnswer: unknown;
let allowAnswer: unknown;
/** When set, the post of the policy waits for it: the page can be looked at while the daemon has not answered. */
let postGate: Promise<void> | null;

beforeEach(() => {
  // Each test records into its OWN array: a signing of an earlier test that finishes late (real PBKDF2, slower on a CI runner) must not land in the calls of the next one.
  const mine: Call[] = [];
  calls = mine;
  keyFileText = keyFile;
  holdAnswer = { state: 'held' };
  allowAnswer = { ok: true, target: { uuid: SELF, name: 'desktop' }, version: 1, delivery: 'installed' };
  postGate = null;
  denyAnswer = { ok: true, id: 'aaaa1111', peer: PEER, shell: 'sh', command: 'ls' };
  elevate = vi.fn(async () => undefined);
  const fetcher = async (url: string, _params?: Record<string, string>, body?: unknown, headers?: Record<string, string>) => {
    mine.push({ url, body, headers });
    if (url === `GET /api/modules/machine/allow/${SELF}`) {
      return context();
    }
    if (url === 'GET /api/modules/machine/admin-key') {
      return { file: keyFileText };
    }
    if (url === 'POST /api/modules/machine/allow') {
      await postGate;
      if (allowAnswer instanceof Error) {
        throw allowAnswer;
      }
      return allowAnswer;
    }
    if (url.startsWith('GET /api/modules/machine/hold-progress/')) {
      return holdAnswer;
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
afterEach(async () => {
  vi.useRealTimers();
  // The signing of this test may still be running (the dialog closes at the SUBMIT, the unlock takes about a second): its post must land in THIS test's fetcher.
  await signingsSettled();
  Reflect.deleteProperty(globalThis, '__APP_CORE_SHELL__');
  window.localStorage.clear();
  window.sessionStorage.clear();
});

// The dialog is only the confirmation: it closes itself as soon as the signing is submitted, the progress is on the card.
const closeDone = async () => {
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 20_000 });
};
// The dialog is gone at once; the post of the signed policy follows.
const posted = async () => {
  await closeDone();
  await waitFor(() => expect(calls.some((c) => c.url === 'POST /api/modules/machine/allow')).toBe(true), { timeout: 20_000 });
};
const itemOf = (command: string) => screen.getByRole('listitem', { name: `Held request ${command}` });
// Allow and Deny are the buttons of the design system, whose name is the visible label: the card (a labelled list item) tells which request they answer.
const allowBtn = (command: string) => within(itemOf(command)).getByRole('button', { name: 'Allow' });
const denyBtn = (command: string) => within(itemOf(command)).getByRole('button', { name: 'Deny' });

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
    expect(command.style.fontFamily).toContain('JetBrains Mono');
    expect(command.className).toMatch(/text-lg/);
    // Machine names are in the machine font, and so is the shell.
    expect(within(item).getByText('thinkcentre').style.fontFamily).toContain('JetBrains Mono');
    expect(within(item).getByText('sh').style.fontFamily).toContain('JetBrains Mono');
    expect(within(item).getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(within(item).getByRole('button', { name: 'Deny' })).toBeInTheDocument();
  });

  it('Allow and Deny are the design-system buttons (size sm), grouped under a name that tells which request they answer', () => {
    render(<HeldRequests rows={ROWS} allow={ALLOW} />);
    const group = within(itemOf('df -h')).getByRole('group', { name: 'Answer df -h' });
    const allow = within(group).getByRole('button', { name: 'Allow' });
    const deny = within(group).getByRole('button', { name: 'Deny' });
    // ButtonAction size sm: the same geometry for both (one height), never the raw classes of the old buttons.
    expect(allow.className).toContain('px-3 py-1 text-xs');
    expect(deny.className).toContain('px-3 py-1 text-xs');
  });

  it('keeps the vertical rhythm of two slim cards: no page-level padding stack, the list gap is gap-2', () => {
    render(<HeldRequests rows={ROWS} allow={ALLOW} />);
    expect(screen.getAllByRole('listitem')[0]?.parentElement?.className).toMatch(/\bgap-2\b/);
  });

  it('where Allow is not available: no Allow button, the note and the CLI command are shown, Deny stays', () => {
    render(<HeldRequests rows={ROWS} allow={{ ...ALLOW, available: false, note: 'Only the admin machine can allow a command.' }} />);
    expect(screen.queryByRole('button', { name: /^Allow/ })).toBeNull();
    expect(screen.getByText(/Only the admin machine can allow/)).toBeInTheDocument();
    expect(screen.getByText('machine admin allow desktop --shell sh -- ls')).toBeInTheDocument();
    expect(denyBtn('ls')).toBeInTheDocument();
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

  it('"asked X ago" ticks with the same timer as the countdown, from the age of the fetch', () => {
    vi.useFakeTimers();
    render(<HeldRequests rows={[{ ...(ROWS[0] as HeldRequestRow), askedText: '5 s ago', askedSecondsAgo: 5 }]} allow={ALLOW} />);
    expect(within(itemOf('ls')).getByText(/asked 5 s ago/)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(within(itemOf('ls')).getByText(/asked 15 s ago/)).toBeInTheDocument();
    expect(within(itemOf('ls')).getByText('1 min 25 s left')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(110_000); });
    expect(within(itemOf('ls')).getByText(/asked 2 min ago/)).toBeInTheDocument();
  });

  it('a row without the age keeps the text of the backend (an older backend)', () => {
    vi.useFakeTimers();
    render(<HeldRequests rows={[ROWS[0] as HeldRequestRow]} allow={ALLOW} />);
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(within(itemOf('ls')).getByText(/asked 5 s ago/)).toBeInTheDocument();
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
    await userEvent.click(denyBtn('df -h'));
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
    await userEvent.click(denyBtn('ls'));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Confirm deny' })).toBeNull();
    expect(calls).toEqual([]);
  });

  it('asks the PIN first (the route is sensitive), then posts only {id, reason} with the module header, no passphrase; the row leaves and the page refreshes', async () => {
    const onRefresh = vi.fn(async () => undefined);
    render(<HeldRequests rows={ROWS} allow={ALLOW} onRefresh={onRefresh} />);
    await userEvent.click(denyBtn('ls'));
    await userEvent.type(screen.getByLabelText(/reason/i), 'not now, ask again later');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm deny' }));
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Held request ls' })).toBeNull());
    expect(calls).toEqual([{ url: 'POST /api/modules/machine/deny', body: { id: 'aaaa1111', reason: 'not now, ask again later' }, headers: { 'x-machine-module': '1' } }]);
    expect(elevate).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledWith('requests');
    // The one short line of a Deny (nothing else shows it): the sentence, then what the caller was told, no wall of text.
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Denied ls from thinkcentre: nothing was signed. The caller was told: not now, ask again later');
    expect(status.textContent?.length).toBeLessThan(120);
    expect(itemOf('df -h')).toBeInTheDocument();
  });

  it('the line of the finished Deny repeats the reason the caller was given, as plain text (never as markup); without a reason it says none was sent', async () => {
    render(<HeldRequests rows={ROWS} allow={ALLOW} />);
    await userEvent.click(denyBtn('ls'));
    await userEvent.type(screen.getByLabelText(/reason/i), 'not now <b>bold</b>');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm deny' }));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Denied ls from thinkcentre: nothing was signed. The caller was told: not now <b>bold</b>');
    expect(status.querySelector('b')).toBeNull();
  });

  it('the line of a Deny without a reason says the caller was told none', async () => {
    render(<HeldRequests rows={ROWS} allow={ALLOW} />);
    await userEvent.click(denyBtn('ls'));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm deny' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Denied ls from thinkcentre: nothing was signed. The caller was told: denied by the owner, no reason given');
  });

  it('posts no reason key when the field is empty', async () => {
    render(<HeldRequests rows={ROWS} allow={ALLOW} />);
    await userEvent.click(denyBtn('ls'));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm deny' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ id: 'aaaa1111' });
  });

  it.each([
    ['a reason with an accent', String.fromCharCode(99, 97, 102, 233), /printable ASCII/],
    ['a reason over 200 characters', 'x'.repeat(201), /at most 200/],
  ])('%s is refused in the form with the fix, and nothing is posted', async (_name, text, message) => {
    render(<HeldRequests rows={ROWS} allow={ALLOW} />);
    await userEvent.click(denyBtn('ls'));
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
    await userEvent.click(denyBtn('ls'));
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
    await userEvent.click(denyBtn('ls'));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm deny' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(raw);
    expect(alert).toHaveTextContent(fix);
    expect(itemOf('ls')).toBeInTheDocument();
  });

  it('shows the message of the daemon when the Deny fails, and the row and the form stay for another try', async () => {
    denyAnswer = new Error('"aaaa1111" does not name a waiting request: it may have been answered or may have expired; reload the page');
    render(<HeldRequests rows={ROWS} allow={ALLOW} />);
    await userEvent.click(denyBtn('ls'));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm deny' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/does not name a waiting request/);
    expect(itemOf('ls')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm deny' })).toBeEnabled();
  });
});

describe('Allow', () => {
  it('opens the existing confirmation with the exact command and the admin passphrase field (same attributes as the table)', async () => {
    render(<HeldRequests rows={ROWS} allow={ALLOW} />);
    await userEvent.click(allowBtn('df -h'));
    const dialog = await screen.findByRole('dialog');
    const input = await within(dialog).findByLabelText('Admin passphrase');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('name', 'machine-admin-passphrase');
    expect(input).toHaveAttribute('autocomplete', 'current-password');
    expect(within(dialog).getByText('df -h')).toBeInTheDocument();
    expect(elevate).toHaveBeenCalledTimes(1);
  });

  it('shows the passphrase hint above the field BEFORE anything is typed, and no element when the key has none', async () => {
    keyFileText = hintedKeyFile;
    const { unmount } = render(<HeldRequests rows={ROWS} allow={ALLOW} />);
    await userEvent.click(allowBtn('ls'));
    const hint = await screen.findByText('Hint: the street of my first school');
    expect(hint).toBeInTheDocument();
    expect(screen.getByLabelText('Admin passphrase')).toHaveValue('');
    unmount();
    keyFileText = keyFile;
    render(<HeldRequests rows={ROWS} allow={ALLOW} />);
    await userEvent.click(allowBtn('ls'));
    await screen.findByLabelText('Admin passphrase');
    expect(screen.queryByText(/Hint:/)).toBeNull();
  });

  it('a malformed hint stops the dialog before any passphrase is asked, with the message of the key file reader', async () => {
    keyFileText = JSON.stringify({ ...JSON.parse(hintedKeyFile), hint: 'x'.repeat(81) });
    render(<HeldRequests rows={ROWS} allow={ALLOW} />);
    await userEvent.click(allowBtn('ls'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/the hint is malformed.*restore the file from another machine/);
    expect(screen.queryByLabelText('Admin passphrase')).toBeNull();
  });

  it('a HELD request defaults to Once (a command that is not recognised as read-only): the summary says so before the passphrase and the signed entry has maxCalls 1', async () => {
    render(<HeldRequests rows={[{ ...(ROWS[0] as HeldRequestRow), command: "make ls" }]} allow={ALLOW} />);
    await userEvent.click(allowBtn("make ls"));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByLabelText('Admin passphrase');
    expect(within(dialog).getByLabelText('How long is it allowed?')).toHaveValue('once');
    expect(within(dialog).getByText('Lifetime')).toBeInTheDocument();
    expect(within(dialog).getByText('allowed once')).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/for ONE call/);
    await userEvent.type(within(dialog).getByLabelText('Admin passphrase'), PASSPHRASE);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Allow and sign' }));
    await posted();
    const post = calls.find((c) => c.url === 'POST /api/modules/machine/allow');
    const policy = (post?.body as { policy: SignedPolicy }).policy;
    expect(policy.body.defaults).toEqual([{ shell: 'sh', command: "make ls", limits: { maxCalls: 1 } }]);
  }, 120_000);

  it('a preset duration is worded with its end time before the passphrase and signed as expiresAt', async () => {
    render(<HeldRequests rows={ROWS} allow={ALLOW} />);
    await userEvent.click(allowBtn('ls'));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByLabelText('Admin passphrase');
    await userEvent.selectOptions(within(dialog).getByLabelText('How long is it allowed?'), '15m');
    expect(within(dialog).getByText(/^until [0-9]{2}:[0-9]{2} \(in 1[45] min\)$/)).toBeInTheDocument();
    await userEvent.selectOptions(within(dialog).getByLabelText('How long is it allowed?'), 'permanent');
    expect(within(dialog).getByText('permanent, until you remove it')).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/until you remove it/);
  });

  it('Custom: an invalid value shows what to write, signs nothing and keeps the typed passphrase; a valid one is signed', async () => {
    render(<HeldRequests rows={ROWS} allow={ALLOW} />);
    await userEvent.click(allowBtn('ls'));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByLabelText('Admin passphrase');
    await userEvent.selectOptions(within(dialog).getByLabelText('How long is it allowed?'), 'custom');
    await userEvent.selectOptions(within(dialog).getByLabelText('Limit by'), 'calls');
    await userEvent.type(within(dialog).getByLabelText(/Number of calls/), '0');
    expect(await within(dialog).findByText(/whole number from 1 to 10000/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Admin passphrase'), PASSPHRASE);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Allow and sign' }));
    expect((await within(dialog).findAllByRole('alert')).map((a) => a.textContent).join(' ')).toMatch(/Nothing was signed/);
    expect(calls.some((c) => c.url === 'POST /api/modules/machine/allow')).toBe(false);
    expect(within(dialog).getByLabelText('Admin passphrase')).toHaveValue(PASSPHRASE);
    await userEvent.clear(within(dialog).getByLabelText(/Number of calls/));
    await userEvent.type(within(dialog).getByLabelText(/Number of calls/), '3');
    expect(within(dialog).getByText('allowed 3 times')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Allow and sign' }));
    await posted();
    const policy = (calls.find((c) => c.url === 'POST /api/modules/machine/allow')?.body as { policy: SignedPolicy }).policy;
    expect(policy.body.defaults).toEqual([{ shell: 'sh', command: 'ls', limits: { maxCalls: 3 } }]);
  }, 120_000);

  it('signs in the page, posts only the signed policy, the row leaves and the page refreshes', async () => {
    const onRefresh = vi.fn(async () => undefined);
    render(<HeldRequests rows={ROWS} allow={ALLOW} onRefresh={onRefresh} />);
    await userEvent.click(allowBtn('ls'));
    await userEvent.type(await screen.findByLabelText('Admin passphrase'), PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Allow and sign' }));
    await posted();
    const post = calls.find((c) => c.url === 'POST /api/modules/machine/allow');
    expect(Object.keys(post?.body as object)).toEqual(['policy']);
    expect(JSON.stringify(calls)).not.toContain(PASSPHRASE);
    // The card stays, with its progress, until the end of the hold is known (decision 86).
    expect(within(itemOf('ls')).getByRole('progressbar')).toBeInTheDocument();
    expect(within(itemOf('ls')).queryByRole('button', { name: 'Allow' })).toBeNull();
    expect(onRefresh).toHaveBeenCalledWith('requests');
    // No page banner for an Allow: the card says it (and Details has the policy version).
    expect(screen.queryByRole('status')).toBeNull();
    await userEvent.click(within(itemOf('ls')).getByRole('button', { name: 'Details' }));
    expect(within(itemOf('ls')).getByText(/Policy version 1/)).toHaveTextContent('`machine allowed desktop` lists it');
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
    expect(within(item).getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(within(item).getByRole('button', { name: 'Deny' })).toBeInTheDocument();
    expect(within(item).queryByText(/machine requests --deny/)).toBeNull();
  });

  it('Deny of a request held elsewhere posts the id, the machine and the reason after the PIN, and says which machine was told (decision 85)', async () => {
    denyAnswer = { ok: true, id: remote.id, peer: { uuid: LAPTOP, name: 'laptop' } };
    render(<HeldRequests rows={[remote]} allow={ALLOW} />);
    await userEvent.click(denyBtn('hostname'));
    await userEvent.type(screen.getByLabelText(/reason/i), 'not now');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm deny' }));
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Held request hostname' })).toBeNull());
    expect(calls).toEqual([{ url: 'POST /api/modules/machine/deny', body: { id: remote.id, machine: LAPTOP, reason: 'not now' }, headers: { 'x-machine-module': '1' } }]);
    expect(elevate).toHaveBeenCalledTimes(1);
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Denied hostname on laptop (laptop was told): nothing was signed');
  });

  it('when the target refuses because this machine is not a notice recipient, the form shows its cause and the fix, and the row stays', async () => {
    denyAnswer = new Error('laptop does not list you as a recipient of its request notices: add this machine with `machine admin notify-to <machines>` on the admin machine, or run `machine requests --deny <id>` ON laptop');
    render(<HeldRequests rows={[remote]} allow={ALLOW} />);
    await userEvent.click(denyBtn('hostname'));
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
    await userEvent.click(denyBtn('hostname'));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm deny' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/machine cli update/);
  });

  it('Allow asks the policy of THAT machine (its uuid), not of this one', async () => {
    render(<HeldRequests rows={[remote]} allow={ALLOW} />);
    await userEvent.click(allowBtn('hostname'));
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

describe('the progress after Allow (decision 86)', () => {
  async function allowLs(rows: HeldRequestRow[] = ROWS, extra: Partial<React.ComponentProps<typeof HeldRequests>> = {}) {
    render(<HeldRequests rows={rows} allow={ALLOW} {...extra} />);
    await userEvent.click(allowBtn('ls'));
    await userEvent.type(await screen.findByLabelText('Admin passphrase'), PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Allow and sign' }));
  }

  it('the dialog closes itself as soon as the signing is submitted and never shows the progress; the card does, from the first second', async () => {
    let release!: () => void;
    postGate = new Promise<void>((resolve) => { release = resolve; });
    await allowLs();
    // The daemon has not answered yet: the confirmation is gone, the card shows the stepper.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 20_000 });
    const card = itemOf('ls');
    expect(within(card).getByRole('progressbar')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Allow' })).toBeNull();
    expect(screen.queryByText(/progress stays on the request/)).toBeNull();
    release();
    expect(await within(card).findByText('Waiting for the release', undefined, { timeout: 20_000 })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  }, 120_000);

  it('no big banner and no sentence twice: the card says the outcome once, the page has no status for an Allow', async () => {
    await allowLs();
    await closeDone();
    const card = itemOf('ls');
    await within(card).findByText('Waiting for the release', undefined, { timeout: 20_000 });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(/The progress is shown on the request/)).toBeNull();
    const leaves = Array.from(card.querySelectorAll('*')).filter((e) => e.children.length === 0).map((e) => e.textContent ?? '').filter((t) => t.length > 12);
    expect(leaves.filter((t, i) => leaves.indexOf(t) !== i)).toEqual([]);
  }, 120_000);

  it('a refusal for the clock is ONE short line on the card (clock 3 min behind); the long explanation with the fix is only behind Details, once', async () => {
    const cause = "desktop's clock is 3 min behind this machine (its time 10:00:00, this machine 10:03:00): fix its time sync (Linux: timedatectl status, Windows: w32tm /query /status)";
    allowAnswer = { ok: true, target: { uuid: SELF, name: 'desktop' }, version: 1, delivery: 'inbox', fallback: { code: 'refused', cause }, deliveryText: { tone: 'warning', text: 'desktop did not take the document directly: stored in the relay inbox, it installs it when it comes back (next poll within 60 s). Cause: ' + cause } };
    await allowLs();
    await closeDone();
    const card = itemOf('ls');
    expect(await within(card).findByText('Stored on the relay (direct delivery refused: clock 3 min behind)', undefined, { timeout: 20_000 })).toBeInTheDocument();
    expect(card).not.toHaveTextContent(/fix its time sync/);
    await userEvent.click(within(card).getByRole('button', { name: 'Details' }));
    expect(within(card).getAllByText(/fix its time sync/)).toHaveLength(1);
    expect(within(card).getAllByText(/direct delivery refused/)).toHaveLength(1);
  }, 120_000);

  it('a wrong passphrase after the dialog closed shows the failure ON THE CARD (danger token, the cause) with Allow again; Allow again opens the confirmation again and a good passphrase goes through', async () => {
    render(<HeldRequests rows={ROWS} allow={ALLOW} />);
    await userEvent.click(allowBtn('ls'));
    await userEvent.type(await screen.findByLabelText('Admin passphrase'), 'not the passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Allow and sign' }));
    await closeDone();
    const card = itemOf('ls');
    expect(await within(card).findByText('Signing failed', undefined, { timeout: 20_000 })).toBeInTheDocument();
    expect(card.querySelector('.text-danger-text')).not.toBeNull();
    expect(calls.some((c) => c.url === 'POST /api/modules/machine/allow')).toBe(false);
    await userEvent.click(within(card).getByRole('button', { name: 'Allow again' }));
    await userEvent.type(await screen.findByLabelText('Admin passphrase'), PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Allow and sign' }));
    await closeDone();
    expect(await within(itemOf('ls')).findByText('Waiting for the release', undefined, { timeout: 20_000 })).toBeInTheDocument();
    expect(within(itemOf('ls')).queryByText('Signing failed')).toBeNull();
  }, 120_000);

  it('a refusal of the daemon after the signature is a failed delivery on the card with its message and Allow again; Dismiss gives the normal Allow and Deny card back (the request is still held)', async () => {
    allowAnswer = new Error('the policy of "desktop" is at version 1, and this one was edited from version 0: reload the page and allow it again');
    await allowLs();
    await closeDone();
    const card = itemOf('ls');
    expect(await within(card).findByText('Delivery failed', undefined, { timeout: 20_000 })).toBeInTheDocument();
    expect(within(card).getByText(/reload the page and allow it again/)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Allow again' })).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: 'Dismiss' }));
    expect(within(itemOf('ls')).getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(within(itemOf('ls')).getByRole('button', { name: 'Deny' })).toBeInTheDocument();
    expect(within(itemOf('ls')).queryByRole('progressbar')).toBeNull();
  }, 120_000);

  it('a warning about the notice recipients is one line on the card, not a banner', async () => {
    allowAnswer = { ok: true, target: { uuid: SELF, name: 'desktop' }, version: 1, delivery: 'installed', noticeRecipients: 'failed', noticeRecipientsMessage: 'the list of notice recipients was NOT sent: run machine admin notify-to' };
    await allowLs();
    await closeDone();
    expect(await within(itemOf('ls')).findByText(/the list of notice recipients was NOT sent/, undefined, { timeout: 20_000 })).toBeInTheDocument();
    // A Notice of the design system on the card itself (a status inside the item), never a banner of the page above the list.
    expect(screen.getAllByRole('status').every((el) => itemOf('ls').contains(el))).toBe(true);
  }, 120_000);

  it('the card keeps the progress when the dialog is closed, polls the daemon, and shows the release only when the end is reported', async () => {
    await allowLs();
    await closeDone();
    const card = itemOf('ls');
    expect(within(card).getByRole('progressbar')).not.toHaveAttribute('aria-valuenow', '100');
    expect(await within(card).findByText('Waiting for the release', undefined, { timeout: 20_000 })).toBeInTheDocument();
    // The daemon is asked for this machine ("self") and this request.
    await waitFor(() => expect(calls.some((c) => c.url === 'GET /api/modules/machine/hold-progress/self/aaaa1111')).toBe(true));
    holdAnswer = { state: 'ended', outcome: 'allowed' };
    await waitFor(() => expect(within(card).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100'), { timeout: 8000 });
    // The outcome of the line, and the last word of the stepper.
    expect(within(card).getAllByText('Released')).toHaveLength(2);
    await userEvent.click(within(card).getByRole('button', { name: /Dismiss/ }));
    expect(screen.queryByRole('listitem', { name: 'Held request ls' })).toBeNull();
  }, 120_000);

  it('an end that is not allowed is a failure with its cause, never a success', async () => {
    holdAnswer = { state: 'ended', outcome: 'deadline' };
    await allowLs();
    await closeDone();
    const card = itemOf('ls');
    await waitFor(() => expect(card).toHaveTextContent(/deadline of the caller passed/), { timeout: 8000 });
    expect(within(card).getByText('Not released')).toBeInTheDocument();
    expect(within(card).getAllByText('Released')).toHaveLength(1);
    expect(within(card).getByRole('progressbar')).not.toHaveAttribute('aria-valuenow', '100');
  }, 120_000);

  it('the card stays from its snapshot when the request leaves the list (the page refreshed)', async () => {
    const view = render(<HeldRequests rows={ROWS} allow={ALLOW} />);
    await userEvent.click(allowBtn('ls'));
    await userEvent.type(await screen.findByLabelText('Admin passphrase'), PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Allow and sign' }));
    await closeDone();
    view.rerender(<HeldRequests rows={[ROWS[1] as HeldRequestRow]} allow={ALLOW} />);
    expect(within(itemOf('ls')).getByRole('progressbar')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem', { name: /^Held request/ })).toHaveLength(2);
  }, 120_000);
});

describe('the reachability badge of a request held on another machine', () => {
  const LAPTOP = '33333333-3333-4333-8333-333333333333';
  const remote: HeldRequestRow = { id: 'cccc3333-0000-4000-8000-000000000000', peerText: 'midgard2', peer: SELF, shell: 'cmd', command: 'hostname', secondsLeft: 300, askedText: 'reported', countText: 'waiting now', nextCommand: 'machine admin allow laptop -- hostname', nextWhere: '', machine: { uuid: LAPTOP, name: 'laptop' } };

  it.each([
    ['direct', 'direct now (12 ms, checked 8 s ago)', /direct now/],
    ['not-direct', 'not reachable directly (last seen 2 h ago; relay inbox only)', /relay inbox only/],
    ['unknown', 'unknown', /^Reachability: unknown$/],
  ])('shows the state %s in words', (state, text, expected) => {
    render(<HeldRequests rows={[remote]} allow={ALLOW} reachability={{ [LAPTOP]: { state, text } }} />);
    expect(within(itemOf('hostname')).getByTestId('reachable-badge')).toHaveTextContent(expected);
  });

  it('shows nothing for a request held on this machine, or when the state is not given', () => {
    render(<HeldRequests rows={[ROWS[0] as HeldRequestRow, remote]} allow={ALLOW} reachability={{ [SELF]: { state: 'self', text: 'this machine' } }} />);
    expect(within(itemOf('ls')).queryByTestId('reachable-badge')).toBeNull();
    expect(within(itemOf('hostname')).queryByTestId('reachable-badge')).toBeNull();
  });
});

describe('a held request that waits for the RENEWAL of an exhausted or expired entry', () => {
  const RENEW_ROW: HeldRequestRow = {
    id: 'cccc3333',
    peerText: 'thinkcentre',
    peer: PEER,
    shell: 'sh',
    command: 'orch stop',
    secondsLeft: 300,
    askedText: '5 s ago',
    countText: 'waiting now',
    nextCommand: 'machine admin allow desktop --renew --shell sh --times 3 -- "orch stop"',
    nextWhere: '',
    renewal: { reason: 'exhausted', entry: 'orch stop', typed: false, own: false, maxCalls: 3, used: 3, note: 'entry used 3 of 3 call(s)' },
  };

  it('the card says in ONE line that it is a renewal and why, with a warning badge; the entry the Allow replaces is in Details', async () => {
    render(<HeldRequests rows={[RENEW_ROW]} allow={ALLOW} />);
    const item = itemOf('orch stop');
    expect(within(item).getByTestId('renewal-badge')).toHaveTextContent('Renewal');
    expect(within(item).getByTestId('renewal-badge').firstElementChild?.className).toMatch(/warning/);
    expect(within(item).getByTestId('held-status')).toHaveTextContent('Renewal: entry used 3 of 3 call(s)');
    expect(within(item).queryByTestId('renewal-note')).toBeNull();
    await userEvent.click(within(item).getByRole('button', { name: 'Details' }));
    const note = within(item).getByTestId('renewal-note');
    expect(note).toHaveTextContent('Renewal: entry used 3 of 3 call(s)');
    expect(note).toHaveTextContent('replaces sh "orch stop"');
  });

  it('a plain held request has no renewal line', () => {
    render(<HeldRequests rows={ROWS} allow={ALLOW} />);
    expect(screen.queryByTestId('renewal-note')).toBeNull();
  });

  it('the Allow dialog names the entry it renews, says "renews" with the old and the new limits (default: the previous limits), and does not talk about widening by a new command', async () => {
    const user = userEvent.setup();
    render(<HeldRequests rows={[RENEW_ROW]} allow={ALLOW} />);
    await user.click(allowBtn('orch stop'));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByText('Renews')).toBeInTheDocument());
    expect(dialog).toHaveTextContent('sh "orch stop"');
    expect(dialog).toHaveTextContent('renews "orch stop": 3 calls -> 3 calls (the counter starts again)');
    expect(dialog).toHaveTextContent('allowed 3 times');
    expect(dialog).not.toHaveTextContent('This widens what peers may run');
  });
});

describe('what the caller asked for (decision 96)', () => {
  const ASKED = (ask: NonNullable<HeldRequestRow['ask']>, command = 'orch deploy'): HeldRequestRow => ({
    id: 'dddd4444',
    peerText: 'thinkcentre',
    peer: PEER,
    shell: 'sh',
    command,
    secondsLeft: 300,
    askedText: '5 s ago',
    countText: 'waiting now',
    nextCommand: 'machine admin allow desktop --shell sh --times 3 -- "orch deploy"',
    nextWhere: '',
    ask,
  });

  it('the card says what the CALLER requested, apart from the owner, as plain text (never markup); Details says nothing is applied', async () => {
    render(<HeldRequests rows={[ASKED({ times: 3, why: 'rerun <b>after</b> the fix' })]} allow={ALLOW} />);
    const item = itemOf('orch deploy');
    const status = within(item).getByTestId('held-status');
    expect(status).toHaveTextContent('Caller asked: 3 calls; reason given: rerun <b>after</b> the fix');
    expect(status.querySelector('b')).toBeNull();
    expect(within(item).queryByTestId('caller-ask-warning')).toBeNull();
    await userEvent.click(within(item).getByRole('button', { name: 'Details' }));
    const note = within(item).getByTestId('caller-ask');
    expect(note).toHaveTextContent('Requested by the caller (not your decision): 3 calls; reason given: rerun <b>after</b> the fix');
    expect(note.querySelector('b')).toBeNull();
    expect(note).toHaveTextContent('Allow starts from it and you can change it');
  });

  it.each([
    ['permanent', { for: 'permanent' } as const, /permanent \(no limit\)/],
    ['a large number of calls', { times: 500 } as const, /a large number of calls \(500\)/],
    ['a long duration', { for: '90d' } as const, /a long duration \(90d\)/],
  ])('%s is flagged BEFORE the click with a short warning badge saying the caller asked', (_name, ask, text) => {
    render(<HeldRequests rows={[ASKED(ask)]} allow={ALLOW} />);
    const warning = within(itemOf('orch deploy')).getByTestId('caller-ask-warning');
    expect(warning).toHaveTextContent(text);
    expect(warning).toHaveTextContent('Caller asks');
    expect(warning.firstElementChild?.className).toMatch(/warning/);
    expect((warning.textContent ?? '').length).toBeLessThan(60);
  });

  it('a request that asked nothing shows no such block', () => {
    render(<HeldRequests rows={ROWS} allow={ALLOW} />);
    expect(screen.queryByTestId('caller-ask')).toBeNull();
  });

  it('the Allow dialog PRE-FILLS the lifetime with the ask, shows it again, and signs nothing until the owner confirms', async () => {
    const user = userEvent.setup();
    render(<HeldRequests rows={[ASKED({ times: 3, why: 'rerun' })]} allow={ALLOW} />);
    await user.click(allowBtn('orch deploy'));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByLabelText('Number of calls (1 to 10000)')).toHaveValue('3'));
    expect(within(dialog).getByText(/Requested by the caller/)).toBeInTheDocument();
    expect(dialog).toHaveTextContent('allowed 3 times');
    expect(dialog).toHaveTextContent('3 calls; reason given: rerun');
    // On failure the message lists EVERY call this test received (url and the first 120 characters of the body), which names what posted before the owner confirmed.
    const received = calls.map((c) => `${c.url} ${(JSON.stringify(c.body) ?? '').slice(0, 120)}`);
    expect(
      received.filter((line) => line.startsWith('POST /api/modules/machine/allow')),
      `the owner never confirmed, but the page received these calls:\n${received.join('\n')}`,
    ).toEqual([]);
  });

  it('a permanent ask pre-fills Permanent and the dialog flags it', async () => {
    const user = userEvent.setup();
    render(<HeldRequests rows={[ASKED({ for: 'permanent' })]} allow={ALLOW} />);
    await user.click(allowBtn('orch deploy'));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByText(/Requested by the caller/)).toBeInTheDocument());
    expect(dialog).toHaveTextContent('permanent, until you remove it');
    expect(within(dialog).getByTestId('caller-ask-warning')).toHaveTextContent('asked by the caller, not decided by you');
  });

  it('a request without an ask keeps the default lifetime of the page', async () => {
    const user = userEvent.setup();
    render(<HeldRequests rows={[{ ...(ROWS[0] as HeldRequestRow), command: "make ls" }]} allow={ALLOW} />);
    await user.click(allowBtn("make ls"));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByText('Lifetime')).toBeInTheDocument());
    expect(within(dialog).queryByText(/Requested by the caller/)).toBeNull();
    expect(dialog).toHaveTextContent('allowed once');
  });
});
