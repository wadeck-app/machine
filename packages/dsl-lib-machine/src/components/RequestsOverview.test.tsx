import { encryptAdminKey, generateSigningKeyPair, verifyRequestsList } from '@wadeck-app/machine-core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoticeData } from '../lib/noticeRows.js';
import { HeaderActionsHost } from '../testHeaderActions.js';
import { RequestsOverview, type RequestsOverviewProps } from './RequestsOverview.js';

// The Requests page for ALL trusted machines: this machine's own requests come from the page, the others are loaded by the admin machine with a request
// signed in the browser. The app-core shell is a stub on globalThis; the module backend is a recording fake.

const PASSPHRASE = 'correct horse battery staple 7391';
const SELF = '22222222-2222-4222-8222-222222222222';
const LAPTOP = '33333333-3333-4333-8333-333333333333';
const THINK = '11111111-1111-4111-8111-111111111111';
const admin = generateSigningKeyPair();
const keyFile = JSON.stringify(encryptAdminKey(admin, PASSPHRASE));
const hintedKeyFile = JSON.stringify(encryptAdminKey(admin, PASSPHRASE, { hint: 'the street of my first school' }));
let keyFileText: string;

const MACHINES = [
  { uuid: SELF, name: 'midgard2', self: true },
  { uuid: THINK, name: 'thinkcentre' },
  { uuid: LAPTOP, name: 'laptop' },
];
const ALLOW = { available: true, machine: { uuid: SELF, name: 'midgard2' }, note: '' };
const OWN_HELD = [{ id: 'aaaa1111-0000-4000-8000-000000000000', peerText: 'laptop', peer: LAPTOP, shell: 'sh', command: 'ls', secondsLeft: 100, askedText: '5 s ago', countText: 'waiting now', nextCommand: 'machine admin allow midgard2 --shell sh -- ls', nextWhere: '' }];
const OWN_PENDING = [{ peerText: 'laptop', peer: LAPTOP, shell: 'sh', command: 'df -h', countText: '2 times', firstSeenText: '1 h ago', lastSeenText: '5 min ago', nextCommand: 'machine admin allow midgard2 --shell sh -- "df -h"', nextWhere: '' }];

const thinkPage = {
  machine: { uuid: THINK, name: 'thinkcentre' },
  policyMode: 'admin',
  allow: { available: true, machine: { uuid: THINK, name: 'thinkcentre' }, note: '' },
  count: 2,
  waiting: [{ id: 'bbbb2222-0000-4000-8000-000000000000', peerText: 'midgard2', peer: SELF, shell: 'cmd', command: 'hostname', secondsLeft: 540, askedText: '10 s ago', countText: 'waiting now', nextCommand: 'machine admin allow thinkcentre --shell cmd -- hostname', nextWhere: '' }],
  denyNote: 'x',
  pending: [{ peerText: 'midgard2', peer: SELF, shell: 'cmd', command: 'ver', countText: '1 time', firstSeenText: '1 h ago', lastSeenText: '1 h ago', nextCommand: 'machine admin allow thinkcentre --shell cmd -- ver', nextWhere: '' }],
  pendingTotal: 1,
  chainOk: true,
  chainText: '',
  notes: [],
};
const laptopPage = { ...thinkPage, machine: { uuid: LAPTOP, name: 'laptop' }, allow: { available: true, machine: { uuid: LAPTOP, name: 'laptop' }, note: '' }, count: 0, waiting: [], pending: [], pendingTotal: 0 };

interface Call { url: string; body: unknown }
let calls: Call[];
let elevate: ReturnType<typeof vi.fn>;
let remoteAnswer: (machine: string) => unknown;
let dismissError: string | undefined;

beforeEach(() => {
  calls = [];
  dismissError = undefined;
  keyFileText = keyFile;
  elevate = vi.fn(async () => undefined);
  remoteAnswer = (machine) => (machine === THINK ? thinkPage : laptopPage);
  const fetcher = async (url: string, _params?: Record<string, string>, body?: unknown) => {
    calls.push({ url, body });
    if (url === 'GET /api/modules/machine/admin-key') {
      return { file: keyFileText };
    }
    if (url === 'POST /api/modules/machine/requests/remote') {
      const answer = remoteAnswer((body as { machine: string }).machine);
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    }
    if (url === 'POST /api/modules/machine/dismiss-notice') {
      if (dismissError !== undefined) {
        throw new Error(dismissError);
      }
      return { ok: true, removed: 1 };
    }
    if (url.startsWith('GET /api/modules/machine/allow/')) {
      throw new Error('stop here: only the machine asked is under test');
    }
    throw new Error(`unexpected call ${url}`);
  };
  Object.defineProperty(globalThis, '__APP_CORE_SHELL__', { value: { elevate, fetcher }, configurable: true, writable: true });
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, '__APP_CORE_SHELL__');
});

const props = (over: Partial<RequestsOverviewProps> = {}): RequestsOverviewProps => ({ self: { uuid: SELF, name: 'midgard2' }, machines: MACHINES, held: OWN_HELD, pending: OWN_PENDING, allow: ALLOW, remote: { available: true, note: '' }, ...over });

async function load() {
  await userEvent.click(screen.getByRole('button', { name: 'Load the other machines' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('Admin passphrase'), PASSPHRASE);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Sign and load' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 20_000 });
}

describe('the passphrase hint of the load dialog', () => {
  it('is shown before the passphrase is typed, and absent when the key has none', async () => {
    keyFileText = hintedKeyFile;
    const { unmount } = render(<RequestsOverview {...props()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Load the other machines' }));
    expect(await screen.findByText('Hint: the street of my first school')).toBeInTheDocument();
    unmount();
    keyFileText = keyFile;
    render(<RequestsOverview {...props()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Load the other machines' }));
    await screen.findByLabelText('Admin passphrase');
    expect(screen.queryByText(/Hint:/)).toBeNull();
  });

  it('a malformed hint is reported next to the button, no passphrase is asked', async () => {
    keyFileText = JSON.stringify({ ...JSON.parse(hintedKeyFile), hint: 'x'.repeat(81) });
    render(<RequestsOverview {...props()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Load the other machines' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/the hint is malformed/);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('the admin key kept in the page (decision 92)', () => {
  it('after the first load the page shows the chip "Key unlocked 4:59" with Lock, once, and the NEXT load asks no passphrase and signs with the held key', async () => {
    render(<RequestsOverview {...props()} />, { wrapper: HeaderActionsHost });
    expect(screen.queryByTestId('unlocked-key-chip')).toBeNull();
    await load();
    const bar = await screen.findByTestId('unlocked-key-chip');
    expect(bar).toHaveTextContent(/Key unlocked [45]:[0-9]{2}/);
    expect(within(bar).getByRole('button', { name: 'Lock' })).toBeInTheDocument();
    expect(screen.getAllByTestId('unlocked-key-chip')).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Reload the other machines' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText('Admin passphrase')).toBeNull();
    // The key indicator exists ONCE for the page, even with a dialog open: not repeated in the dialog, and no block of the old bar kind.
    expect(screen.getAllByText(/key unlocked/i)).toHaveLength(1);
    expect(screen.queryByTestId('unlocked-key-bar')).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sign and load' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 5000 });
    const posts = calls.filter((c) => c.url === 'POST /api/modules/machine/requests/remote');
    expect(posts).toHaveLength(4);
    for (const p of posts) {
      const { machine, request } = p.body as { machine: string; request: unknown };
      expect(verifyRequestsList(request, { adminPublicKey: admin.publicKey, selfUuid: machine, peerUuid: SELF, now: Math.floor(Date.now() / 1000) })).toMatchObject({ ok: true });
    }

    // Lock now brings the passphrase prompt back.
    await userEvent.click(within(screen.getByTestId('unlocked-key-chip')).getByRole('button', { name: 'Lock' }));
    expect(screen.queryByTestId('unlocked-key-chip')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Reload the other machines' }));
    expect(await within(await screen.findByRole('dialog')).findByLabelText('Admin passphrase')).toBeInTheDocument();
  }, 120_000);
});

describe('this machine only (before anything is loaded)', () => {
  it('shows its own held and refused requests, and the machine filter lists every trusted machine', () => {
    render(<RequestsOverview {...props()} />);
    expect(screen.getByRole('listitem', { name: 'Held request ls' })).toBeInTheDocument();
    expect(screen.getByText('df -h')).toBeInTheDocument();
    const select = screen.getByLabelText('Machine');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['All machines', 'midgard2 (this machine)', 'thinkcentre', 'laptop']);
  });

  it('a machine that is not the admin one says where to go and offers no load button', () => {
    render(<RequestsOverview {...props({ remote: { available: false, note: 'Only the admin machine can ask the other machines. Run `machine requests <machine>` there.' } })} />);
    expect(screen.getByText(/Only the admin machine can ask/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /other machines/ })).toBeNull();
  });

  it('does not claim the page shows only this machine: nothing in it says the page cannot ask a peer', () => {
    const { container } = render(<RequestsOverview {...props()} />);
    expect(container.textContent).not.toMatch(/cannot ask a peer|THIS machine/);
  });
});

describe('loading the other machines', () => {
  it('asks the PIN, then the admin passphrase in the existing dialog, and posts one signed read-only request per peer (never the passphrase)', async () => {
    render(<RequestsOverview {...props()} />);
    await load();
    expect(elevate).toHaveBeenCalledTimes(1);
    const posts = calls.filter((c) => c.url === 'POST /api/modules/machine/requests/remote');
    expect(posts.map((p) => (p.body as { machine: string }).machine)).toEqual([THINK, LAPTOP]);
    for (const p of posts) {
      const { machine, request } = p.body as { machine: string; request: unknown };
      expect(verifyRequestsList(request, { adminPublicKey: admin.publicKey, selfUuid: machine, peerUuid: SELF, now: Math.floor(Date.now() / 1000) })).toMatchObject({ ok: true });
    }
    expect(JSON.stringify(calls)).not.toContain(PASSPHRASE);
  }, 120_000);

  it('shows the held requests of the other machines next to this machine\'s own, with the machine named, Allow for that machine and Deny (sent to that machine)', async () => {
    render(<RequestsOverview {...props()} />);
    await load();
    const item = screen.getByRole('listitem', { name: 'Held request hostname' });
    expect(within(item).getByText('thinkcentre')).toBeInTheDocument();
    expect(within(item).getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(within(item).getByRole('button', { name: 'Deny' })).toBeInTheDocument();
    expect(within(item).queryByText(/machine requests --deny/)).toBeNull();
    // This machine's own row keeps its Deny button.
    expect(within(screen.getByRole('listitem', { name: 'Held request ls' })).getByRole('button', { name: 'Deny' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Waiting for approval on thinkcentre' })).toBeInTheDocument();
    expect(screen.getByText('ver')).toBeInTheDocument();
  }, 120_000);

  it('the machine filter narrows every section to one machine, and back to all', async () => {
    render(<RequestsOverview {...props()} />);
    await load();
    const select = screen.getByLabelText('Machine');
    await userEvent.selectOptions(select, THINK);
    expect(screen.queryByRole('listitem', { name: 'Held request ls' })).toBeNull();
    expect(screen.getByRole('listitem', { name: 'Held request hostname' })).toBeInTheDocument();
    expect(screen.queryByText('df -h')).toBeNull();
    await userEvent.selectOptions(select, SELF);
    expect(screen.getByRole('listitem', { name: 'Held request ls' })).toBeInTheDocument();
    expect(screen.queryByRole('listitem', { name: 'Held request hostname' })).toBeNull();
    await userEvent.selectOptions(select, 'all');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  }, 120_000);

  it('a peer that cannot answer is named with its own message; the other peers are still shown', async () => {
    remoteAnswer = (machine) => (machine === LAPTOP ? new Error('cannot reach laptop: no address known; run `machine peer connect laptop --address <host:port>`') : thinkPage);
    render(<RequestsOverview {...props()} />);
    await load();
    expect(screen.getByRole('alert')).toHaveTextContent(/laptop: cannot reach laptop.*peer connect/);
    expect(screen.getByRole('listitem', { name: 'Held request hostname' })).toBeInTheDocument();
    expect(screen.getByText(/1 of 2 answered/)).toBeInTheDocument();
  }, 120_000);

  it('a wrong passphrase keeps the dialog open with the message, and posts nothing', async () => {
    render(<RequestsOverview {...props()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Load the other machines' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Admin passphrase'), 'not the passphrase');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sign and load' }));
    expect(await within(dialog).findByRole('alert', {}, { timeout: 20_000 })).toHaveTextContent(/passphrase/i);
    expect(calls.filter((c) => c.url.startsWith('POST'))).toEqual([]);
  }, 120_000);

  it('a cancelled PIN is reported and no dialog opens', async () => {
    elevate.mockRejectedValueOnce(new Error('Sensitive action cancelled: PIN not entered'));
    render(<RequestsOverview {...props()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Load the other machines' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/PIN not entered/);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('request notices (reported by other machines, no passphrase)', () => {
  const NOTICE_ID = 'cccc3333-0000-4000-8000-000000000000';
  const RECEIVED = Math.floor(new Date(2026, 10, 21, 14, 2, 30).getTime() / 1000);
  const notice = (over: Partial<NoticeData> = {}): NoticeData => ({ id: NOTICE_ID, machine: LAPTOP, machineName: 'laptop', peerText: 'thinkcentre', peer: THINK, shell: 'sh', command: 'uptime', commandTruncated: false, state: 'held', secondsLeft: 300, receivedAt: RECEIVED, ...over });
  const NOTE = 'reported by laptop at 14:02; not verified live: use Load the other machines to confirm';

  it('shows a held notice next to the own rows, labelled with the machine that reported it, with the short status line (the full note in Details), Allow and Deny', async () => {
    render(<RequestsOverview {...props({ notices: [notice()] })} />);
    const item = screen.getByRole('listitem', { name: 'Held request uptime' });
    expect(item).toHaveAttribute('data-testid', 'notice-row');
    expect(within(item).getByText('laptop')).toBeInTheDocument();
    expect(within(item).getByTestId('held-status')).toHaveTextContent('Reported, not verified live.');
    await userEvent.click(within(item).getByRole('button', { name: 'Details' }));
    expect(within(item).getByTestId('notice-note')).toHaveTextContent(NOTE);
    expect(within(item).getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(within(item).getByRole('button', { name: 'Deny' })).toBeInTheDocument();
    expect(within(item).queryByText(/machine requests --deny/)).toBeNull();
    expect(within(item).getByText(/5 min 0 s left|4 min 5\d s left/)).toBeInTheDocument();
    // The own row is untouched.
    expect(within(screen.getByRole('listitem', { name: 'Held request ls' })).getByRole('button', { name: 'Deny' })).toBeInTheDocument();
  });

  it('Allow of a notice row goes through the existing allow flow for the machine of the row', async () => {
    render(<RequestsOverview {...props({ notices: [notice()] })} />);
    await userEvent.click(within(screen.getByRole('listitem', { name: 'Held request uptime' })).getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(calls.some((c) => c.url === `GET /api/modules/machine/allow/${LAPTOP}`)).toBe(true));
  });

  it('shows the command as plain text: markup in it is never interpreted', () => {
    const nasty = '<b id="x">bold</b><img src=x onerror=alert(1)>';
    const { container } = render(<RequestsOverview {...props({ held: [], notices: [notice({ command: nasty })] })} />);
    expect(container.querySelector('b#x')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain(nasty);
  });

  it('a truncated command is flagged and has no Allow button', () => {
    render(<RequestsOverview {...props({ notices: [notice({ commandTruncated: true })] })} />);
    const item = screen.getByRole('listitem', { name: 'Held request uptime' });
    expect(within(item).queryByRole('button', { name: 'Allow' })).toBeNull();
    expect(within(item).getByText(/command is truncated/i)).toBeInTheDocument();
  });

  it('a refused notice is a row of the machine, in its own section, with the note and Allow', () => {
    render(<RequestsOverview {...props({ notices: [notice({ state: 'refused', secondsLeft: null, command: 'whoami' })] })} />);
    expect(screen.getByRole('heading', { name: 'Waiting for approval on laptop' })).toBeInTheDocument();
    const row = screen.getByTestId('notice-note').closest('tr') as HTMLElement;
    expect(row).toHaveTextContent('whoami');
    expect(within(row).getByTestId('notice-note')).toHaveTextContent(NOTE);
    expect(within(row).getByRole('button', { name: 'Allow whoami' })).toBeInTheDocument();
  });

  it('shows the machine name of a section heading in the machine font', () => {
    render(<RequestsOverview {...props({ notices: [notice({ state: 'refused', secondsLeft: null, command: 'whoami' })] })} />);
    const heading = screen.getByRole('heading', { name: 'Waiting for approval on laptop' });
    expect(within(heading).getByText('laptop')).toHaveClass('font-mono');
  });

  it('a damaged store is a visible warning with the message', () => {
    render(<RequestsOverview {...props({ noticesError: 'notices.json is damaged: delete it' })} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/notices.*notices.json is damaged: delete it/i);
  });

  it('no notice and no error: nothing is added', () => {
    render(<RequestsOverview {...props({ notices: [], noticesError: '' })} />);
    expect(screen.queryByTestId('notice-row')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('after loading, the live rows of a machine replace its notices (same request id once, a request that is gone disappears), the others stay', async () => {
    const live = { ...thinkPage, waiting: [{ ...thinkPage.waiting[0], id: NOTICE_ID, command: 'hostname' }] };
    remoteAnswer = (machine) => (machine === THINK ? live : laptopPage);
    const list = [notice({ machine: THINK, machineName: 'thinkcentre', command: 'hostname' }), notice({ id: 'dddd4444-0000-4000-8000-000000000000', command: 'gone' })];
    render(<RequestsOverview {...props({ notices: list })} />);
    expect(screen.getAllByTestId('notice-row')).toHaveLength(2);
    await load();
    expect(screen.queryByTestId('notice-row')).toBeNull();
    expect(screen.getAllByRole('listitem', { name: 'Held request hostname' })).toHaveLength(1);
    expect(screen.queryByRole('listitem', { name: 'Held request gone' })).toBeNull();
  }, 120_000);

  it('a machine that could not answer keeps its notices on screen', async () => {
    remoteAnswer = (machine) => (machine === LAPTOP ? new Error('cannot reach laptop') : thinkPage);
    render(<RequestsOverview {...props({ notices: [notice()] })} />);
    await load();
    expect(screen.getByRole('listitem', { name: 'Held request uptime' })).toHaveAttribute('data-testid', 'notice-row');
  }, 120_000);

  it('the machine filter applies to notices', async () => {
    render(<RequestsOverview {...props({ notices: [notice()] })} />);
    await userEvent.selectOptions(screen.getByLabelText('Machine'), THINK);
    expect(screen.queryByRole('listitem', { name: 'Held request uptime' })).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Machine'), LAPTOP);
    expect(screen.getByRole('listitem', { name: 'Held request uptime' })).toBeInTheDocument();
  });
});

describe('Safer mode (confirm risky lifetimes), kept in this browser', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it('is OFF by default, sits next to the Allow style switch, and writes nothing until chosen', () => {
    render(<RequestsOverview {...props()} />);
    expect(screen.getByRole('switch', { name: 'Safer mode: confirm risky lifetimes' })).toHaveAttribute('aria-checked', 'false');
    expect(window.localStorage.getItem('machine:requests:saferMode')).toBeNull();
  });

  it('turning it on is stored and remembered by the next page', async () => {
    const { unmount } = render(<RequestsOverview {...props()} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Safer mode: confirm risky lifetimes' }));
    expect(window.localStorage.getItem('machine:requests:saferMode')).toBe('on');
    unmount();
    render(<RequestsOverview {...props()} />);
    expect(screen.getByRole('switch', { name: 'Safer mode: confirm risky lifetimes' })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('the Allow style (Dialog | Inline), kept in this browser', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('is INLINE by default: the switch says so, every held card has a checkbox, nothing is written until a choice is made', () => {
    render(<RequestsOverview {...props()} />);
    const group = screen.getByRole('radiogroup', { name: 'Allow style' });
    expect(within(group).getByRole('radio', { name: 'Inline' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('checkbox', { name: 'Select ls' })).toBeInTheDocument();
    expect(window.localStorage.getItem('machine:requests:allowStyle')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('choosing Dialog stores the choice, removes the checkboxes, and is remembered by the next page', async () => {
    const { unmount } = render(<RequestsOverview {...props()} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Dialog' }));
    expect(window.localStorage.getItem('machine:requests:allowStyle')).toBe('dialog');
    expect(screen.queryByRole('checkbox')).toBeNull();
    unmount();
    render(<RequestsOverview {...props()} />);
    expect(screen.getByRole('radio', { name: 'Dialog' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('in Dialog style Allow opens the confirmation dialog', async () => {
    window.localStorage.setItem('machine:requests:allowStyle', 'dialog');
    render(<RequestsOverview {...props()} />);
    await userEvent.click(within(screen.getByRole('listitem', { name: 'Held request ls' })).getByRole('button', { name: 'Allow' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('a stored value that is not Dialog or Inline is reported in one line, Inline is used, and picking replaces it', async () => {
    window.localStorage.setItem('machine:requests:allowStyle', 'sideways');
    render(<RequestsOverview {...props()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/"sideways" is not Dialog or Inline/);
    expect(screen.getByRole('radio', { name: 'Inline' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(screen.getByRole('radio', { name: 'Dialog' }));
    expect(window.localStorage.getItem('machine:requests:allowStyle')).toBe('dialog');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a storage that refuses the choice is reported, and the choice still applies to this page', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    render(<RequestsOverview {...props()} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Dialog' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/storage refused the choice \(quota exceeded\)/);
    expect(screen.getByRole('radio', { name: 'Dialog' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('a storage that cannot be read is reported', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    render(<RequestsOverview {...props()} />);
    // The Safer mode switch reports the same unreadable storage on its own line.
    const alerts = screen.getAllByRole('alert').map((a) => a.textContent ?? '');
    expect(alerts).toHaveLength(2);
    expect(alerts.some((t) => /Allow style is inline/.test(t))).toBe(true);
    expect(alerts.every((t) => /cannot be read \(denied\)/.test(t))).toBe(true);
  });
});

describe('expired notices and Dismiss (decision 100)', () => {
  const RECEIVED = Math.floor(new Date(2026, 10, 21, 14, 2, 30).getTime() / 1000);
  const idOf = (n: number): string => `eeee000${n}-0000-4000-8000-000000000000`;
  const notice = (n: number, over: Partial<NoticeData> = {}): NoticeData => ({ id: idOf(n), machine: THINK, machineName: 'thinkcentre', peerText: 'midgard2', peer: SELF, shell: 'sh', command: `echo ${n}`, commandTruncated: false, state: 'held', secondsLeft: 0, receivedAt: RECEIVED, ...over });
  const dismissCalls = () => calls.filter((c) => c.url === 'POST /api/modules/machine/dismiss-notice');

  it('shows a held request past its deadline as Expired, apart from the live ones, with Dismiss and without Allow or Deny', () => {
    render(<RequestsOverview {...props({ held: [], expired: [notice(1)] } as Partial<RequestsOverviewProps>)} />);
    expect(screen.getByRole('heading', { name: 'Expired (no end notice received)' })).toBeInTheDocument();
    const row = screen.getByRole('listitem', { name: 'Expired request echo 1' });
    expect(within(row).getByText('thinkcentre')).toBeInTheDocument();
    expect(row).toHaveTextContent(/no end notice/i);
    expect(within(row).getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /Allow|Deny/ })).toBeNull();
    // Not a live card: no "Held request" item and no live heading.
    expect(screen.queryByRole('listitem', { name: 'Held request echo 1' })).toBeNull();
    expect(screen.queryByRole('heading', { name: /Held requests/ })).toBeNull();
  });

  it('a live row is unaffected: no Dismiss on it, and it stays next to the expired ones', () => {
    render(<RequestsOverview {...props({ expired: [notice(1)] } as Partial<RequestsOverviewProps>)} />);
    const live = screen.getByRole('listitem', { name: 'Held request ls' });
    expect(within(live).getByRole('button', { name: 'Deny' })).toBeInTheDocument();
    expect(within(live).queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('Dismiss posts {machine, id} without the PIN dialog, removes the row at once and refreshes the page data', async () => {
    const onRefresh = vi.fn(async () => undefined);
    render(<RequestsOverview {...props({ held: [], expired: [notice(1), notice(2)], onRefresh } as Partial<RequestsOverviewProps>)} />);
    await userEvent.click(within(screen.getByRole('listitem', { name: 'Expired request echo 1' })).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Expired request echo 1' })).toBeNull());
    expect(dismissCalls()).toEqual([{ url: 'POST /api/modules/machine/dismiss-notice', body: { machine: THINK, id: idOf(1) } }]);
    expect(elevate).not.toHaveBeenCalled();
    expect(screen.getByRole('listitem', { name: 'Expired request echo 2' })).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalledWith('requests');
  });

  it('a dismissed row stays gone when the page reloads its data (the daemon no longer lists it)', async () => {
    const { rerender } = render(<RequestsOverview {...props({ held: [], expired: [notice(1), notice(2)] } as Partial<RequestsOverviewProps>)} />);
    await userEvent.click(within(screen.getByRole('listitem', { name: 'Expired request echo 1' })).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Expired request echo 1' })).toBeNull());
    rerender(<RequestsOverview {...props({ held: [], expired: [notice(2)] } as Partial<RequestsOverviewProps>)} />);
    expect(screen.queryByRole('listitem', { name: 'Expired request echo 1' })).toBeNull();
    expect(screen.getByRole('listitem', { name: 'Expired request echo 2' })).toBeInTheDocument();
  });

  it('Clear expired is offered only above two rows, posts {expired: true} and clears them all', async () => {
    const { unmount } = render(<RequestsOverview {...props({ held: [], expired: [notice(1), notice(2)] } as Partial<RequestsOverviewProps>)} />);
    expect(screen.queryByRole('button', { name: 'Clear expired' })).toBeNull();
    unmount();
    render(<RequestsOverview {...props({ held: [], expired: [notice(1), notice(2), notice(3)] } as Partial<RequestsOverviewProps>)} />);
    await userEvent.click(screen.getByRole('button', { name: 'Clear expired' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Expired (no end notice received)' })).toBeNull());
    expect(dismissCalls()).toEqual([{ url: 'POST /api/modules/machine/dismiss-notice', body: { expired: true } }]);
    expect(screen.queryByRole('listitem', { name: /Expired request/ })).toBeNull();
  });

  it('a refused dismiss keeps the row and shows the daemon sentence', async () => {
    dismissError = 'no request notice with the id x from that machine: it is already gone; reload the Requests page';
    render(<RequestsOverview {...props({ held: [], expired: [notice(1)] } as Partial<RequestsOverviewProps>)} />);
    await userEvent.click(within(screen.getByRole('listitem', { name: 'Expired request echo 1' })).getByRole('button', { name: 'Dismiss' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already gone; reload the Requests page/);
    expect(screen.getByRole('listitem', { name: 'Expired request echo 1' })).toBeInTheDocument();
  });

  it('a refused request (no end by design) has a Dismiss too, which posts {machine, id} and removes the row', async () => {
    render(<RequestsOverview {...props({ notices: [notice(4, { state: 'refused', secondsLeft: null, command: 'whoami' })] })} />);
    const row = screen.getByTestId('notice-note').closest('tr') as HTMLElement;
    expect(within(row).getByRole('button', { name: 'Allow whoami' })).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByTestId('notice-note')).toBeNull());
    expect(dismissCalls()).toEqual([{ url: 'POST /api/modules/machine/dismiss-notice', body: { machine: THINK, id: idOf(4) } }]);
  });

  it('the own pending rows of this machine have no Dismiss (they come from its audit log, not from a notice)', () => {
    render(<RequestsOverview {...props()} />);
    expect(screen.queryByRole('button', { name: /Dismiss/ })).toBeNull();
  });
});
