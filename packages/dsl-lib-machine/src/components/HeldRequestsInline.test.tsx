import React from 'react';
import { generateSigningKeyPair, encryptAdminKey, keyId, type SignedPolicy } from '@wadeck-app/machine-core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unlockAdminKey } from '@wadeck-app/machine-webcrypto';
import { adminKeyHolder } from '../lib/adminKeyHolder.js';
import { signingsSettled } from '../lib/allowFlow.js';
import { HeldRequests, type HeldRequestRow } from './HeldRequests.js';

// The INLINE Allow of the held requests (no modal): a form in the card, and a batch bar that signs ONE policy per machine in ONE unlock. The app-core
// shell is a stub on globalThis; the module backend is a recording fake; the crypto is the real one (each unlock derives 600 000 PBKDF2 rounds).

const PASSPHRASE = 'correct horse battery staple 7391';
const SELF = '22222222-2222-4222-8222-222222222222';
const PEER = '11111111-1111-4111-8111-111111111111';
const LAPTOP = '33333333-3333-4333-8333-333333333333';

const admin = generateSigningKeyPair();
const ADMIN_KEY_ID = keyId(admin.publicKey);
const laptopKeys = generateSigningKeyPair();
const keyFile = JSON.stringify(encryptAdminKey(admin, PASSPHRASE));
const hintedKeyFile = JSON.stringify(encryptAdminKey(admin, PASSPHRASE, { hint: 'the street of my first school' }));
let keyFileText: string;

const row = (id: string, command: string, extra: Partial<HeldRequestRow> = {}): HeldRequestRow => ({ id, peerText: 'thinkcentre', peer: PEER, shell: 'sh', command, secondsLeft: 300, askedText: '5 s ago', countText: 'waiting now', nextCommand: `machine admin allow desktop --shell sh -- ${command}`, nextWhere: '', ...extra });
const LS = row('aaaa1111', 'ls');
const DF = row('bbbb2222', 'df -h');
const UP = row('cccc3333', 'uptime');
const LS_AGAIN = row('dddd4444', 'ls', { peerText: 'midgard2' });
const REMOTE = row('eeee5555-0000-4000-8000-000000000000', 'hostname', { shell: 'cmd', peerText: 'midgard2', machine: { uuid: LAPTOP, name: 'laptop' }, canAllow: true });
const REMOTE2 = row('ffff6666-0000-4000-8000-000000000000', 'whoami', { shell: 'cmd', peerText: 'midgard2', machine: { uuid: LAPTOP, name: 'laptop' }, canAllow: true });
const ALLOW = { available: true, machine: { uuid: SELF, name: 'desktop' }, note: '' };

const contextOf = (uuid: string) =>
  uuid === SELF
    ? { ok: true, target: { uuid: SELF, name: 'desktop' }, toSelf: true, policyMode: 'admin', adminKeyId: ADMIN_KEY_ID, adminPublicKey: admin.publicKey, current: null as SignedPolicy | null, source: 'installed on this machine', delivery: 'install' }
    : { ok: true, target: { uuid: LAPTOP, name: 'laptop', identityPublicKey: laptopKeys.publicKey }, toSelf: false, policyMode: 'admin', adminKeyId: ADMIN_KEY_ID, adminPublicKey: admin.publicKey, current: null as SignedPolicy | null, source: 'the last one signed here', delivery: 'inbox', noticeRecipients: { selfUuid: SELF, current: null } };

interface Call { url: string; body: unknown }
let calls: Call[];
let elevate: ReturnType<typeof vi.fn>;
/** Per target uuid: an Error to throw when its policy is posted. */
let postFailure: Record<string, Error>;

beforeEach(() => {
  calls = [];
  postFailure = {};
  keyFileText = keyFile;
  elevate = vi.fn(async () => undefined);
  const fetcher = async (url: string, _params?: Record<string, string>, body?: unknown) => {
    calls.push({ url, body });
    const context = /^GET \/api\/modules\/machine\/allow\/(.+)$/.exec(url);
    if (context !== null) {
      return contextOf(context[1] as string);
    }
    if (url === 'GET /api/modules/machine/admin-key') {
      return { file: keyFileText };
    }
    if (url === 'POST /api/modules/machine/allow') {
      const target = (body as { policy: SignedPolicy }).policy.body.target;
      const failure = postFailure[target];
      if (failure !== undefined) {
        throw failure;
      }
      return target === SELF ? { ok: true, target: { uuid: SELF, name: 'desktop' }, version: 1, delivery: 'installed' } : { ok: true, target: { uuid: LAPTOP, name: 'laptop' }, version: 1, delivery: 'inbox' };
    }
    if (url.startsWith('GET /api/modules/machine/hold-progress/')) {
      return { state: 'held' };
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

const itemOf = (command: string) => screen.getByRole('listitem', { name: `Held request ${command}` });
const allowBtn = (command: string) => within(itemOf(command)).getByRole('button', { name: 'Allow' });
const posts = () => calls.filter((c) => c.url === 'POST /api/modules/machine/allow').map((c) => (c.body as { policy: SignedPolicy; document?: unknown }));
const keyReads = () => calls.filter((c) => c.url === 'GET /api/modules/machine/admin-key').length;
const posted = async (count: number) => waitFor(() => expect(posts()).toHaveLength(count), { timeout: 20_000 });
const select = async (command: string, index = 0) => userEvent.click(screen.getAllByRole('checkbox', { name: `Select ${command}` })[index] as HTMLElement);
const render_ = (rows: HeldRequestRow[], onRefresh?: (s?: string) => Promise<void>) => render(<HeldRequests rows={rows} allow={ALLOW} allowStyle="inline" {...(onRefresh !== undefined ? { onRefresh } : {})} />);
/** The passphrase never rests anywhere the page keeps data: not in the storage, not in an attribute or text of the DOM, not in anything that was sent. */
const expectNoPassphrase = () => {
  expect(JSON.stringify(calls)).not.toContain(PASSPHRASE);
  expect(JSON.stringify({ ...window.localStorage })).not.toContain(PASSPHRASE);
  expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(PASSPHRASE);
  expect(document.body.innerHTML).not.toContain(PASSPHRASE);
  for (const input of Array.from(document.querySelectorAll('input'))) {
    expect(input.value).not.toContain(PASSPHRASE);
  }
};

describe('inline Allow of one request', () => {
  it('LOCKED: Allow expands a compact form INSIDE the card (no dialog): the key hint, Keep unlocked for, the passphrase, Allow and sign, Cancel; the lifetime stays the select of the row', async () => {
    keyFileText = hintedKeyFile;
    render_([LS, DF]);
    await userEvent.click(allowBtn('df -h'));
    const passphrase = await screen.findByLabelText('Admin passphrase');
    expect(screen.queryByRole('dialog')).toBeNull();
    const item = itemOf('df -h');
    expect(item).toContainElement(passphrase);
    expect(passphrase).toHaveAttribute('type', 'password');
    expect(passphrase).toHaveAttribute('autocomplete', 'current-password');
    expect(within(item).getByLabelText('Lifetime')).toHaveValue('once');
    expect(within(item).queryByLabelText('How long is it allowed?')).toBeNull();
    expect(within(item).getByLabelText('Keep unlocked for')).toBeInTheDocument();
    expect(within(item).getByTestId('passphrase-hint')).toHaveTextContent('Hint: the street of my first school');
    // The widening sentence is not in the way: it is in Details.
    expect(within(item).queryByText(/Widens rights/)).toBeNull();
    expect(within(item).getByRole('button', { name: 'Allow and sign' })).toBeEnabled();
    expect(within(item).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    // The other card is untouched.
    expect(within(itemOf('ls')).getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(elevate).toHaveBeenCalledTimes(1);
  });

  it('the inline form starts from what the CALLER asked (3 calls: custom, 3), nothing is signed or posted by it, and the card says it was the caller', async () => {
    render_([{ ...LS, ask: { times: 3, why: 'rerun' } }, DF]);
    await userEvent.click(allowBtn('ls'));
    await screen.findByLabelText('Admin passphrase');
    const item = itemOf('ls');
    expect(within(item).getByLabelText('Lifetime')).toHaveValue('custom');
    expect(within(item).getByLabelText('Number of calls (1 to 10000)')).toHaveValue('3');
    expect(within(item).getByTestId('held-status')).toHaveTextContent('Caller asked: 3 calls; reason given: rerun');
    expect(posts()).toEqual([]);
  });

  it('Cancel collapses the form and posts nothing; Escape does the same', async () => {
    render_([LS]);
    await userEvent.click(allowBtn('ls'));
    await screen.findByLabelText('Admin passphrase');
    await userEvent.click(within(itemOf('ls')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Admin passphrase')).toBeNull();
    expect(allowBtn('ls')).toBeInTheDocument();
    await userEvent.click(allowBtn('ls'));
    await userEvent.type(await screen.findByLabelText('Admin passphrase'), '{Escape}');
    expect(screen.queryByLabelText('Admin passphrase')).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it('a malformed key hint stops the form before any passphrase is asked, with the message of the key file reader', async () => {
    keyFileText = JSON.stringify({ ...JSON.parse(hintedKeyFile), hint: 'x'.repeat(81) });
    render_([LS]);
    await userEvent.click(allowBtn('ls'));
    expect(await within(itemOf('ls')).findByRole('alert')).toHaveTextContent(/the hint is malformed.*restore the file from another machine/);
    expect(screen.queryByLabelText('Admin passphrase')).toBeNull();
  });

  it('signs without any dialog, posts the signed policy only, and shows the progress on the card; the passphrase is nowhere afterwards', async () => {
    const onRefresh = vi.fn(async () => undefined);
    render_([LS, DF], onRefresh);
    await userEvent.click(allowBtn('ls'));
    await userEvent.type(await screen.findByLabelText('Admin passphrase'), PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Allow and sign' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await posted(1);
    const body = posts()[0] as { policy: SignedPolicy };
    expect(Object.keys(body)).toEqual(['policy']);
    expect(body.policy.body.defaults).toEqual([{ shell: 'sh', command: 'ls', limits: { maxCalls: 1 } }]);
    expect(await within(itemOf('ls')).findByRole('progressbar')).toBeInTheDocument();
    expect(screen.queryByLabelText('Admin passphrase')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onRefresh).toHaveBeenCalledWith('requests');
    expectNoPassphrase();
  }, 120_000);

  it('a wrong passphrase stays in the form with the cause, nothing is posted, and the form keeps working', async () => {
    render_([LS]);
    await userEvent.click(allowBtn('ls'));
    await userEvent.type(await screen.findByLabelText('Admin passphrase'), 'definitely not the passphrase 123');
    await userEvent.click(screen.getByRole('button', { name: 'Allow and sign' }));
    const alert = await within(itemOf('ls')).findByRole('alert', undefined, { timeout: 20_000 });
    expect(alert).toHaveTextContent(/wrong passphrase or damaged key file/);
    expect(alert).not.toHaveTextContent('definitely not');
    expect(posts()).toHaveLength(0);
    // Still the form (no progress card), the field emptied, the buttons usable: the right passphrase now signs.
    expect(screen.queryByRole('progressbar')).toBeNull();
    const field = screen.getByLabelText('Admin passphrase');
    expect(field).toHaveValue('');
    expect(field).toBeEnabled();
    await userEvent.type(field, PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Allow and sign' }));
    await posted(1);
    expectNoPassphrase();
  }, 120_000);

  it('an empty passphrase signs nothing and says so', async () => {
    render_([LS]);
    await userEvent.click(allowBtn('ls'));
    await screen.findByLabelText('Admin passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Allow and sign' }));
    expect(await within(itemOf('ls')).findByRole('alert')).toHaveTextContent('Enter the admin passphrase to sign. Nothing was signed.');
    expect(keyReads()).toBe(1);
  });

  it('a failure after the signature (the daemon refuses) goes to the card with its cause', async () => {
    postFailure[SELF] = new Error('the policy of "desktop" is at version 1: reload the page and allow it again');
    render_([LS]);
    await userEvent.click(allowBtn('ls'));
    await userEvent.type(await screen.findByLabelText('Admin passphrase'), PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Allow and sign' }));
    await posted(1);
    expect(await within(itemOf('ls')).findByText(/reload the page and allow it again/, undefined, { timeout: 20_000 })).toBeInTheDocument();
    expect(within(itemOf('ls')).getByRole('button', { name: 'Allow again' })).toBeInTheDocument();
  }, 120_000);
});

describe('selecting several requests (inline)', () => {
  it('each card has a checkbox named after its command; the bar appears with the first one and says how many', async () => {
    render_([LS, DF, UP]);
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    expect(screen.queryByRole('region', { name: 'Allow selected requests' })).toBeNull();
    await select('ls');
    await select('uptime');
    const bar = screen.getByRole('region', { name: 'Allow selected requests' });
    expect(within(bar).getByRole('button', { name: 'Allow 2 selected' })).toBeInTheDocument();
    expect(bar.className).toMatch(/\bsticky\b/);
    // Nothing is asked of the owner (no PIN, no passphrase) until the bar is opened.
    expect(elevate).not.toHaveBeenCalled();
    await userEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    expect(screen.queryByRole('region', { name: 'Allow selected requests' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Select ls' })).not.toBeChecked();
  });

  it('there is no checkbox in dialog style', () => {
    render(<HeldRequests rows={[LS]} allow={ALLOW} allowStyle="dialog" />);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('there is no checkbox where Allow is not available', () => {
    render(<HeldRequests rows={[LS]} allow={{ ...ALLOW, available: false, note: 'Only the admin machine can allow.' }} allowStyle="inline" />);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('three requests, ONE passphrase: ONE policy holding the three entries, the key file read once more (after the hint), a progress card per request', async () => {
    keyFileText = hintedKeyFile;
    render_([LS, DF, UP]);
    await select('ls');
    await select('df -h');
    await select('uptime');
    await userEvent.click(screen.getByRole('button', { name: 'Allow 3 selected' }));
    const bar = screen.getByRole('region', { name: 'Allow selected requests' });
    const field = await within(bar).findByLabelText('Admin passphrase');
    expect(within(bar).getByTestId('passphrase-hint')).toHaveTextContent('the street of my first school');
    expect(within(bar).getByLabelText('How long is it allowed?')).toHaveValue('once');
    expect(elevate).toHaveBeenCalledTimes(1);
    expect(keyReads()).toBe(1);
    await userEvent.type(field, PASSPHRASE);
    await userEvent.click(within(bar).getByRole('button', { name: 'Allow and sign' }));
    await posted(1);
    expect(posts()[0]?.policy.body.defaults).toEqual([
      { shell: 'sh', command: 'ls', limits: { maxCalls: 1 } },
      { shell: 'sh', command: 'df -h', limits: { maxCalls: 1 } },
      { shell: 'sh', command: 'uptime', limits: { maxCalls: 1 } },
    ]);
    // ONE unlock: the hint read at the opening, the key file of the signature once.
    expect(keyReads()).toBe(2);
    for (const command of ['ls', 'df -h', 'uptime']) {
      expect(await within(itemOf(command)).findByRole('progressbar')).toBeInTheDocument();
    }
    // The bar is gone and no dialog ever opened.
    expect(screen.queryByRole('region', { name: 'Allow selected requests' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expectNoPassphrase();
  }, 120_000);

  it('two machines: two policies (the laptop one with its sealed document) in ONE unlock', async () => {
    render_([LS, DF, REMOTE, REMOTE2]);
    await select('ls');
    await select('hostname');
    await select('whoami');
    expect(screen.getByRole('button', { name: 'Allow 3 selected' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Allow 3 selected' }));
    const bar = screen.getByRole('region', { name: 'Allow selected requests' });
    await userEvent.type(await within(bar).findByLabelText('Admin passphrase'), PASSPHRASE);
    // The selection spans two machines: the bar says what is signed.
    expect(bar).toHaveTextContent('2 machines, 2 policies, one passphrase');
    await userEvent.click(within(bar).getByRole('button', { name: 'Allow and sign' }));
    await posted(2);
    const byTarget = new Map(posts().map((p) => [p.policy.body.target, p]));
    expect(byTarget.get(SELF)?.policy.body.defaults.map((e) => e.command)).toEqual(['ls']);
    expect(byTarget.get(LAPTOP)?.policy.body.defaults.map((e) => e.command)).toEqual(['hostname', 'whoami']);
    expect(byTarget.get(LAPTOP)?.document).toBeDefined();
    expect(byTarget.get(SELF)?.document).toBeUndefined();
    expect(keyReads()).toBe(2);
    // The PIN was asked once for both machines.
    expect(elevate).toHaveBeenCalledTimes(1);
    for (const command of ['ls', 'hostname', 'whoami']) {
      expect(await within(itemOf(command)).findByRole('progressbar')).toBeInTheDocument();
    }
    expect(within(itemOf('df -h')).getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expectNoPassphrase();
  }, 120_000);

  it('the same text asked twice is ONE entry, and both requests show their progress', async () => {
    render_([LS, LS_AGAIN, DF]);
    await select('ls', 0);
    await select('ls', 1);
    await userEvent.click(screen.getByRole('button', { name: 'Allow 2 selected' }));
    await userEvent.type(await screen.findByLabelText('Admin passphrase'), PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Allow and sign' }));
    await posted(1);
    expect(posts()[0]?.policy.body.defaults).toEqual([{ shell: 'sh', command: 'ls', limits: { maxCalls: 1 } }]);
    expect(await screen.findAllByRole('progressbar')).toHaveLength(2);
  }, 120_000);

  it('an entry the policy cannot hold is refused in the bar with its machine and cause, BEFORE the passphrase is asked: nothing is signed for the others', async () => {
    const bad = row('9999aaaa', `echo caf${String.fromCharCode(233)}`);
    render_([LS, bad]);
    await select('ls');
    await select(bad.command);
    await userEvent.click(screen.getByRole('button', { name: 'Allow 2 selected' }));
    const bar = screen.getByRole('region', { name: 'Allow selected requests' });
    expect(await within(bar).findByRole('alert')).toHaveTextContent(/on "desktop".*printable ASCII/s);
    expect(within(bar).queryByLabelText('Admin passphrase')).toBeNull();
    expect(posts()).toHaveLength(0);
    expect(keyReads()).toBe(0);
    // The selection is kept: deselect the bad one and the rest can go on.
    expect(screen.getByRole('checkbox', { name: 'Select ls' })).toBeChecked();
  });

  it('a wrong passphrase keeps the selection and the form, with the cause; nothing is posted', async () => {
    render_([LS, DF]);
    await select('ls');
    await select('df -h');
    await userEvent.click(screen.getByRole('button', { name: 'Allow 2 selected' }));
    const bar = screen.getByRole('region', { name: 'Allow selected requests' });
    await userEvent.type(await within(bar).findByLabelText('Admin passphrase'), 'definitely not the passphrase 123');
    await userEvent.click(within(bar).getByRole('button', { name: 'Allow and sign' }));
    expect(await within(bar).findByRole('alert', undefined, { timeout: 20_000 })).toHaveTextContent(/wrong passphrase or damaged key file/);
    expect(posts()).toHaveLength(0);
    expect(screen.getByRole('checkbox', { name: 'Select ls' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select df -h' })).toBeChecked();
    const field = within(bar).getByLabelText('Admin passphrase');
    expect(field).toHaveValue('');
    expect(field).toBeEnabled();
    expect(screen.queryByRole('progressbar')).toBeNull();
  }, 120_000);

  it('one machine failing leaves the progress of the other: the laptop cards say why, the desktop card goes on', async () => {
    postFailure[LAPTOP] = new Error('the relay refused the inbox document: try again in a minute');
    render_([LS, REMOTE]);
    await select('ls');
    await select('hostname');
    await userEvent.click(screen.getByRole('button', { name: 'Allow 2 selected' }));
    await userEvent.type(await screen.findByLabelText('Admin passphrase'), PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Allow and sign' }));
    await posted(2);
    expect(await within(itemOf('hostname')).findByText(/the relay refused the inbox document/, undefined, { timeout: 20_000 })).toBeInTheDocument();
    expect(await within(itemOf('ls')).findByRole('progressbar')).toBeInTheDocument();
    expect(within(itemOf('ls')).queryByText(/relay refused/)).toBeNull();
    expect(posts()).toHaveLength(2);
    expectNoPassphrase();
  }, 120_000);

  it('changing the selection while the form is open closes the form (the signature is for the selection you read)', async () => {
    render_([LS, DF]);
    await select('ls');
    await userEvent.click(screen.getByRole('button', { name: 'Allow 1 selected' }));
    await screen.findByLabelText('Admin passphrase');
    await select('df -h');
    expect(screen.queryByLabelText('Admin passphrase')).toBeNull();
    expect(screen.getByRole('button', { name: 'Allow 2 selected' })).toBeInTheDocument();
  });
});

describe('dialog style is unchanged', () => {
  it('Allow opens the confirmation dialog, not a form in the card', async () => {
    render(<HeldRequests rows={[LS]} allow={ALLOW} allowStyle="dialog" />);
    await userEvent.click(allowBtn('ls'));
    const dialog = await screen.findByRole('dialog');
    expect(within(itemOf('ls')).queryByLabelText('Admin passphrase')).toBeNull();
    expect(within(dialog).getByLabelText('Admin passphrase')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// ONE-CLICK Allow (user feedback 2026-11-22): with the admin key unlocked in the page, Allow on a card signs at once with the lifetime of the select next to
// it; a flagged lifetime needs a second click; locked, Allow expands a compact passphrase field and Enter signs.

const unlock = async () => {
  adminKeyHolder.hold(await unlockAdminKey(keyFile, PASSPHRASE, { extractable: false }));
};
const lifetimeSelect = (command: string) => within(itemOf(command)).getByLabelText('Lifetime');
const detailsOf = (command: string) => within(itemOf(command)).getByRole('button', { name: 'Details' });
const asked = (extra: Partial<HeldRequestRow>): HeldRequestRow => ({ ...row('ab12cd34', 'orch deploy'), ...extra });

describe('ONE-CLICK Allow, admin key unlocked (inline style)', () => {
  it('the card shows the lifetime select next to Allow (default Once) and ONE click on Allow signs and posts at once: no second button, no passphrase, no key file read', async () => {
    await unlock();
    const onRefresh = vi.fn(async () => undefined);
    render_([LS, DF], onRefresh);
    expect(lifetimeSelect('ls')).toHaveValue('once');
    await userEvent.click(allowBtn('ls'));
    await posted(1);
    expect(posts()[0]?.policy.body.defaults).toEqual([{ shell: 'sh', command: 'ls', limits: { maxCalls: 1 } }]);
    expect(screen.queryByLabelText('Admin passphrase')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Allow and sign' })).toBeNull();
    expect(keyReads()).toBe(0);
    expect(await within(itemOf('ls')).findByRole('progressbar')).toBeInTheDocument();
    // What was signed stays visible: one line in the progress line, the full summary in Details.
    expect(within(itemOf('ls')).getByText('Signed: allowed once')).toBeInTheDocument();
    await userEvent.click(within(itemOf('ls')).getByRole('button', { name: 'Details' }));
    expect(within(itemOf('ls')).getByTestId('signed-summary')).toHaveTextContent('sh "ls" on desktop, allowed once');
    expect(onRefresh).toHaveBeenCalledWith('requests');
    // The other card is untouched.
    expect(within(itemOf('df -h')).getByRole('button', { name: 'Allow' })).toBeInTheDocument();
  }, 120_000);

  it('the lifetime of the select next to Allow is the one signed (1 hour: an expiry, no call limit), and it becomes the default of the next card, in memory only', async () => {
    await unlock();
    render_([LS, DF]);
    await userEvent.selectOptions(lifetimeSelect('ls'), '1h');
    await userEvent.click(allowBtn('ls'));
    await posted(1);
    const limits = posts()[0]?.policy.body.defaults[0]?.limits as { maxCalls?: number; expiresAt?: number };
    expect(limits.maxCalls).toBeUndefined();
    expect(limits.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 3000);
    expect(lifetimeSelect('df -h')).toHaveValue('1h');
    expect(JSON.stringify({ ...window.localStorage, ...window.sessionStorage })).not.toContain('1h');
  }, 120_000);

  it('a custom lifetime is typed next to the select (3 calls)', async () => {
    await unlock();
    render_([LS]);
    await userEvent.selectOptions(lifetimeSelect('ls'), 'custom');
    await userEvent.selectOptions(within(itemOf('ls')).getByLabelText('Limit by'), 'calls');
    await userEvent.type(within(itemOf('ls')).getByLabelText('Number of calls (1 to 10000)'), '3');
    await userEvent.click(allowBtn('ls'));
    await posted(1);
    expect(posts()[0]?.policy.body.defaults[0]?.limits).toEqual({ maxCalls: 3 });
  }, 120_000);

  it('an invalid custom lifetime signs nothing and says what to write', async () => {
    await unlock();
    render_([LS]);
    await userEvent.selectOptions(lifetimeSelect('ls'), 'custom');
    await userEvent.click(allowBtn('ls'));
    expect(await within(itemOf('ls')).findByRole('alert')).toHaveTextContent(/Enter a duration/);
    expect(posts()).toEqual([]);
  });

  it('a caller ask that is small pre-fills the select and still signs in one click (2 calls)', async () => {
    await unlock();
    render_([asked({ ask: { times: 2, why: 'rerun' } })]);
    expect(lifetimeSelect('orch deploy')).toHaveValue('custom');
    await userEvent.click(allowBtn('orch deploy'));
    await posted(1);
    expect(posts()[0]?.policy.body.defaults[0]?.limits).toEqual({ maxCalls: 2 });
  }, 120_000);

  it('a RENEWAL is flagged by a warning badge before the click and one click renews with the limits the entry had', async () => {
    await unlock();
    const renewal = { reason: 'exhausted' as const, entry: 'orch stop', typed: false, own: false, maxCalls: 3, used: 3, note: 'entry used 3 of 3 call(s)' };
    render_([asked({ id: 'rn000001', command: 'orch stop', renewal })]);
    const item = itemOf('orch stop');
    expect(within(item).getByTestId('renewal-badge').className).toMatch(/warning/);
    expect(within(item).getByLabelText('Lifetime')).toHaveValue('custom');
    await userEvent.click(allowBtn('orch stop'));
    await posted(1);
    expect(posts()[0]?.policy.body.defaults[0]?.limits).toEqual({ maxCalls: 3 });
  }, 120_000);

  it('after Lock now the same Allow asks the passphrase again', async () => {
    await unlock();
    render_([LS]);
    adminKeyHolder.lock();
    await userEvent.click(allowBtn('ls'));
    expect(await screen.findByLabelText('Admin passphrase')).toBeInTheDocument();
    expect(posts()).toEqual([]);
  });
});

describe('a FLAGGED lifetime never signs in one click (the safety exception)', () => {
  it.each([
    ['a permanent ask', { for: 'permanent' } as const, /permanent \(no limit\)/, undefined],
    ['a large ask (50 calls)', { times: 50 } as const, /a large number of calls \(50\)/, { maxCalls: 50 }],
    ['a long ask (8d)', { for: '8d' } as const, /a long duration \(8d\)/, 'expires'],
  ])('%s: the badge is there BEFORE the click, the first click signs nothing and asks to confirm, the second signs', async (_name, askOf, badge, limits) => {
    await unlock();
    render_([asked({ ask: askOf })]);
    const item = itemOf('orch deploy');
    expect(within(item).getByTestId('caller-ask-warning')).toHaveTextContent(badge);
    // The design-system button has no title: the tooltip is on the wrapper of the button.
    expect(within(item).getByRole('button', { name: 'Allow' }).closest('[title]')).toHaveAttribute('title', expect.stringMatching(/second click/));
    await userEvent.click(allowBtn('orch deploy'));
    const confirm = await within(item).findByRole('button', { name: 'Confirm allow' });
    expect(posts()).toEqual([]);
    expect(within(item).getByTestId('flagged-line')).toHaveTextContent(/second click/);
    await userEvent.click(confirm);
    await posted(1);
    const signed = posts()[0]?.policy.body.defaults[0]?.limits;
    if (limits === 'expires') {
      expect((signed as { expiresAt?: number }).expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 7 * 86400);
    } else {
      expect(signed).toEqual(limits);
    }
  }, 120_000);

  it('picking Permanent in the select flags it too, and Cancel after the first click goes back with nothing signed', async () => {
    await unlock();
    render_([LS]);
    await userEvent.selectOptions(lifetimeSelect('ls'), 'permanent');
    await userEvent.click(allowBtn('ls'));
    expect(await within(itemOf('ls')).findByRole('button', { name: 'Confirm allow' })).toBeInTheDocument();
    await userEvent.click(within(itemOf('ls')).getByRole('button', { name: 'Cancel' }));
    expect(allowBtn('ls')).toBeInTheDocument();
    expect(posts()).toEqual([]);
  });

  it('a flagged lifetime is not remembered for the next card', async () => {
    await unlock();
    render_([LS, DF]);
    await userEvent.selectOptions(lifetimeSelect('ls'), 'permanent');
    expect(lifetimeSelect('df -h')).toHaveValue('once');
  });

  it('LOCKED: the expanded passphrase form is itself the explicit step (no Confirm button), and nothing is posted before Enter', async () => {
    render_([asked({ ask: { for: 'permanent' } })]);
    await userEvent.click(allowBtn('orch deploy'));
    expect(await screen.findByLabelText('Admin passphrase')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm allow' })).toBeNull();
    expect(posts()).toEqual([]);
  });
});

describe('LOCKED: Allow expands a compact passphrase field, Enter signs', () => {
  it('Enter in the field signs with the lifetime of the row; the key is then kept and the NEXT Allow is one click', async () => {
    render_([LS, DF]);
    await userEvent.click(allowBtn('ls'));
    await userEvent.type(await screen.findByLabelText('Admin passphrase'), `${PASSPHRASE}{Enter}`);
    await posted(1);
    expect(posts()[0]?.policy.body.defaults).toEqual([{ shell: 'sh', command: 'ls', limits: { maxCalls: 1 } }]);
    expect(adminKeyHolder.current()).not.toBeNull();
    await userEvent.click(allowBtn('df -h'));
    await posted(2);
    expect(screen.queryByLabelText('Admin passphrase')).toBeNull();
    expect(keyReads()).toBe(2);
    expectNoPassphrase();
  }, 120_000);
});

describe('ONE-CLICK Allow in dialog style', () => {
  const dialogRender = (rows: HeldRequestRow[]) => render(<HeldRequests rows={rows} allow={ALLOW} allowStyle="dialog" />);

  it('unlocked: the select is on the card, ONE click signs straight from it and no dialog opens', async () => {
    await unlock();
    dialogRender([LS]);
    await userEvent.selectOptions(lifetimeSelect('ls'), '15m');
    await userEvent.click(allowBtn('ls'));
    await posted(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((posts()[0]?.policy.body.defaults[0]?.limits as { expiresAt?: number }).expiresAt).toBeGreaterThan(0);
  }, 120_000);

  it('locked: the dialog is kept (no select on the card)', async () => {
    dialogRender([LS]);
    expect(within(itemOf('ls')).queryByLabelText('Lifetime')).toBeNull();
    await userEvent.click(allowBtn('ls'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});

describe('the card is short', () => {
  const FULL = asked({
    id: 'ff000001',
    command: 'orch stop',
    ask: { times: 3, why: 'rerun' },
    renewal: { reason: 'exhausted', entry: 'orch stop', typed: false, own: false, maxCalls: 3, used: 3, note: 'entry used 3 of 3 call(s)' },
    machine: { uuid: LAPTOP, name: 'laptop' },
    canAllow: true,
  });

  it('a renewal with a caller ask fits one status line: header, command, ONE status line, ONE row of controls; the long sentences are in Details', async () => {
    await unlock();
    render_([FULL]);
    const item = itemOf('orch stop');
    expect(within(item).getAllByTestId('held-status')).toHaveLength(1);
    expect((item.textContent ?? '').length).toBeLessThan(330);
    for (const gone of [/Allow and sign/, /How long is it allowed/, /Renews /, /Admin key unlocked/, /Widens rights/, /nothing is applied until you sign/, /The command runs once/]) {
      expect(item.textContent).not.toMatch(gone);
    }
    // The controls are ONE row: the select, Allow and Deny share a parent.
    const controls = within(item).getByRole('group', { name: 'Answer orch stop' });
    expect(controls).toContainElement(within(item).getByLabelText('Lifetime'));
    expect(controls).toContainElement(within(item).getByRole('button', { name: 'Allow' }));
    expect(controls).toContainElement(within(item).getByRole('button', { name: 'Deny' }));
    // Every fact is still there, one click away.
    expect(within(item).queryByTestId('renewal-note')).toBeNull();
    await userEvent.click(detailsOf('orch stop'));
    expect(within(item).getByTestId('renewal-note')).toHaveTextContent('replaces sh "orch stop"');
    expect(within(item).getByTestId('caller-ask')).toHaveTextContent('Requested by the caller (not your decision): 3 calls; reason given: rerun');
    expect(within(item).getByTestId('held-widening')).toHaveTextContent(/Renews sh "orch stop" on laptop/);
  });

  it('the reachability chip is on the header line, with the countdown', () => {
    render(<HeldRequests rows={[FULL]} allow={ALLOW} allowStyle="inline" reachability={{ [LAPTOP]: { state: 'direct', text: 'direct' } }} />);
    const chip = within(itemOf('orch stop')).getByTestId('reachable-badge');
    expect(chip.closest('[data-testid="held-header"]')).not.toBeNull();
  });

  it('the unlocked-key bar is NOT repeated in a card or in the batch bar', async () => {
    await unlock();
    render_([LS, DF]);
    await select('ls');
    expect(screen.queryByTestId('unlocked-key-bar')).toBeNull();
    expect(screen.queryByText(/Admin key unlocked/)).toBeNull();
  });
});
