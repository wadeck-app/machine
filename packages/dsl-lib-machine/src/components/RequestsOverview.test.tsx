import { encryptAdminKey, generateSigningKeyPair, verifyRequestsList } from '@wadeck-app/machine-core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestsOverview, type RequestsOverviewProps } from './RequestsOverview.js';

// The Requests page for ALL trusted machines: this machine's own requests come from the page, the others are loaded by the admin machine with a request
// signed in the browser. The app-core shell is a stub on globalThis; the module backend is a recording fake.

const PASSPHRASE = 'correct horse battery staple 7391';
const SELF = '22222222-2222-4222-8222-222222222222';
const LAPTOP = '33333333-3333-4333-8333-333333333333';
const THINK = '11111111-1111-4111-8111-111111111111';
const admin = generateSigningKeyPair();
const keyFile = JSON.stringify(encryptAdminKey(admin, PASSPHRASE));

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

beforeEach(() => {
  calls = [];
  elevate = vi.fn(async () => undefined);
  remoteAnswer = (machine) => (machine === THINK ? thinkPage : laptopPage);
  const fetcher = async (url: string, _params?: Record<string, string>, body?: unknown) => {
    calls.push({ url, body });
    if (url === 'GET /api/modules/machine/admin-key') {
      return { file: keyFile };
    }
    if (url === 'POST /api/modules/machine/requests/remote') {
      const answer = remoteAnswer((body as { machine: string }).machine);
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
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

  it('shows the held requests of the other machines next to this machine\'s own, with the machine named, Allow for that machine and no Deny button', async () => {
    render(<RequestsOverview {...props()} />);
    await load();
    const item = screen.getByRole('listitem', { name: 'Held request hostname' });
    expect(within(item).getByText('thinkcentre')).toBeInTheDocument();
    expect(within(item).getByRole('button', { name: 'Allow hostname' })).toBeInTheDocument();
    expect(within(item).queryByRole('button', { name: /^Deny/ })).toBeNull();
    expect(within(item).getByText(/machine requests --deny bbbb2222.*ON thinkcentre/)).toBeInTheDocument();
    // This machine's own row keeps its Deny button.
    expect(within(screen.getByRole('listitem', { name: 'Held request ls' })).getByRole('button', { name: 'Deny ls' })).toBeInTheDocument();
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
