import React from 'react';
import { generateSigningKeyPair, encryptAdminKey, keyId, type SignedPolicy } from '@wadeck-app/machine-core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
afterEach(() => {
  vi.useRealTimers();
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
  it('Allow expands a compact form INSIDE the card (no dialog): lifetime (Once), the key hint, one warning line, the passphrase, Allow and sign, Cancel', async () => {
    keyFileText = hintedKeyFile;
    render_([LS, DF]);
    await userEvent.click(allowBtn('df -h'));
    const passphrase = await screen.findByLabelText('Admin passphrase');
    expect(screen.queryByRole('dialog')).toBeNull();
    const item = itemOf('df -h');
    expect(item).toContainElement(passphrase);
    expect(passphrase).toHaveAttribute('type', 'password');
    expect(passphrase).toHaveAttribute('autocomplete', 'current-password');
    expect(within(item).getByLabelText('How long is it allowed?')).toHaveValue('once');
    expect(within(item).getByTestId('passphrase-hint')).toHaveTextContent('Hint: the street of my first school');
    // The widening warning is ONE short line, with the lifetime in words.
    const warning = within(item).getByText(/Widens rights/);
    expect(warning).toHaveTextContent(/every trusted peer.*allowed once/);
    expect(warning.textContent?.length).toBeLessThan(160);
    expect(within(item).getByRole('button', { name: 'Allow and sign' })).toBeEnabled();
    expect(within(item).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    // The other card is untouched.
    expect(within(itemOf('ls')).getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(elevate).toHaveBeenCalledTimes(1);
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
