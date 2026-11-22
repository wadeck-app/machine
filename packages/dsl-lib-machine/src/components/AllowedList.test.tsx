import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AllowedList, type AllowedPageData } from './AllowedList.js';

// The Allowed page: what every machine allows, read-only. The app-core shell is a stub on globalThis; the module backend is a fake that records the URL.

type MachineRow = AllowedPageData['machines'][number];
type EntryRow = MachineRow['lists'][number]['entries'][number];

const entry = (index: number, over: Partial<EntryRow> = {}): EntryRow => ({ key: `0:${index}`, index, shell: 'sh', text: `echo ${index}`, typed: false, lifetimeText: 'permanent', limited: false, limitNote: '', ...over });

const installed: MachineRow = {
  uuid: 'u1', name: 'desktop', isSelf: true, source: 'installed', sourceText: 'installed on this machine, in force now (mode admin)', mode: 'admin', version: 4, signedText: 'signed 10 min ago', signedIso: '2026-11-22T10:00:00.000Z',
  lists: [{ key: 'default', title: 'Default list (every trusted peer without a list of its own)', peerName: '', entries: [entry(1), entry(2, { shell: 'cmd', text: 'dir /b', lifetimeText: '3 of 5 calls left', limited: true }), entry(3, { text: 'uptime' })] }],
  deliveryNote: '', problem: '', emptyText: '', fillCommand: 'machine admin allow desktop -- <command>',
};
const signed: MachineRow = {
  uuid: 'u2', name: 'laptop', isSelf: false, source: 'signed-here', sourceText: 'signed here by the admin: may differ from what is installed on laptop until it is delivered', mode: 'admin', version: 2, signedText: 'signed 2 h ago', signedIso: '2026-11-22T08:00:00.000Z',
  lists: [
    { key: 'default', title: 'Default list (every trusted peer without a list of its own)', peerName: '', entries: [entry(1, { text: '<img src=x onerror=alert(1)>', lifetimeText: '3 calls', limited: true, limitNote: 'calls left: not shown, the counter is kept on laptop' })] },
    { key: 'peer:u1', title: 'Only for desktop (its own list, it replaces the default)', peerName: 'desktop', entries: [entry(1, { text: 'orch logs <j:name>', typed: true })] },
  ],
  deliveryNote: 'as installed on laptop: ask there with machine policy allow --list (remote view: machine requests/policy views are not built yet)', problem: '', emptyText: '', fillCommand: 'machine admin allow laptop -- <command>',
};
const empty: MachineRow = { uuid: 'u3', name: 'nas', isSelf: false, source: 'signed-here', sourceText: 'signed here by the admin: may differ from what is installed on nas until it is delivered', mode: 'admin', version: null, signedText: '', signedIso: '', lists: [], deliveryNote: '', problem: '', emptyText: 'No policy was signed on this machine for "nas": nothing is known here about what it allows (only policies signed on this machine are on record).', fillCommand: 'machine admin allow nas -- <command>' };
const broken: MachineRow = { ...empty, uuid: 'u4', name: 'box', emptyText: '', problem: '/x/44.json is not a valid policy record (bad json): delete it, the next policy is then built from nothing', fillCommand: 'machine admin allow box -- <command>' };

const CHANGE = 'Read-only. To change a list today: `machine admin allow <machine> -- <command>` on the admin machine.';

function page(over: Partial<AllowedPageData> = {}): AllowedPageData {
  return { machine: { uuid: 'u1', name: 'desktop' }, entryCount: 5, machineCount: 2, summary: '5 entries on 2 machines', machines: [installed, signed, empty, broken], warnings: [], changeNote: CHANGE, ...over };
}

let urls: string[];
let answer: () => unknown;

beforeEach(() => {
  urls = [];
  answer = () => page();
  const fetcher = async (url: string) => {
    urls.push(url);
    const result = answer();
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };
  Object.defineProperty(globalThis, '__APP_CORE_SHELL__', { value: { elevate: async () => undefined, fetcher }, configurable: true, writable: true });
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, '__APP_CORE_SHELL__');
});

const section = (name: string): HTMLElement => screen.getByRole('region', { name: `Allowed on ${name}` });

describe('the lists', () => {
  it('asks the allowed route once and shows the short line, the change note and a section per machine', async () => {
    render(<AllowedList />);
    expect(await screen.findByText('5 entries on 2 machines')).toBeInTheDocument();
    expect(urls).toEqual(['GET /api/modules/machine/allowed']);
    expect(screen.getByText(CHANGE)).toBeInTheDocument();
    for (const name of ['desktop', 'laptop', 'nas', 'box']) {
      expect(section(name)).toBeInTheDocument();
    }
  });

  it('shows per machine its name, version, mode, when it was signed and where the list comes from', async () => {
    render(<AllowedList />);
    await screen.findByText('5 entries on 2 machines');
    const desktop = within(section('desktop'));
    expect(desktop.getByText('version 4')).toBeInTheDocument();
    expect(desktop.getByText('mode admin')).toBeInTheDocument();
    expect(desktop.getByText('signed 10 min ago')).toHaveAttribute('title', '2026-11-22T10:00:00.000Z');
    expect(desktop.getByText(/installed on this machine, in force now/)).toBeInTheDocument();
    expect(within(section('laptop')).getByText(/signed here by the admin: may differ from what is installed on laptop/)).toBeInTheDocument();
  });

  it('groups the entries under their shell, in the order of the first entry, with their place in the list', async () => {
    render(<AllowedList />);
    await screen.findByText('5 entries on 2 machines');
    const desktop = within(section('desktop'));
    expect(desktop.getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['sh', 'cmd']);
    const rows = desktop.getAllByRole('row').map((r) => r.textContent);
    expect(rows.some((t) => t?.includes('#1') && t.includes('echo 1'))).toBe(true);
    expect(rows.some((t) => t?.includes('#3') && t.includes('uptime'))).toBe(true);
  });

  it('shows the lifetime of a limited entry, and for a list signed here why the calls left are not shown', async () => {
    render(<AllowedList />);
    await screen.findByText('5 entries on 2 machines');
    expect(within(section('desktop')).getByText('3 of 5 calls left')).toBeInTheDocument();
    const laptop = within(section('laptop'));
    expect(laptop.getByText('3 calls')).toBeInTheDocument();
    expect(laptop.getByText('calls left: not shown, the counter is kept on laptop')).toBeInTheDocument();
  });

  it('names the peer of a per-peer list and tags a typed entry', async () => {
    render(<AllowedList />);
    await screen.findByText('5 entries on 2 machines');
    const laptop = within(section('laptop'));
    expect(laptop.getByText('Only for desktop (its own list, it replaces the default)')).toBeInTheDocument();
    expect(laptop.getByText('orch logs <j:name>')).toBeInTheDocument();
    expect(laptop.getByText('typed')).toBeInTheDocument();
  });

  it('says that a list signed here may differ from the installed one, with the wording of `machine allowed`', async () => {
    render(<AllowedList />);
    await screen.findByText('5 entries on 2 machines');
    expect(within(section('laptop')).getByText(/as installed on laptop: ask there with machine policy allow --list/)).toBeInTheDocument();
  });

  it('shows a command as text: markup in it is never rendered', async () => {
    const { container } = render(<AllowedList />);
    await screen.findByText('5 entries on 2 machines');
    expect(within(section('laptop')).getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('an empty machine says why and shows the exact command that fills it; an unreadable record is an alert with its fix', async () => {
    render(<AllowedList />);
    await screen.findByText('5 entries on 2 machines');
    const nas = within(section('nas'));
    expect(nas.getByText(/No policy was signed on this machine for "nas"/)).toBeInTheDocument();
    expect(nas.getByText('machine admin allow nas -- <command>')).toBeInTheDocument();
    expect(within(section('box')).getByRole('alert')).toHaveTextContent(/delete it, the next policy is then built from nothing/);
  });

  it('has no button that edits or deletes: this page is read-only', async () => {
    render(<AllowedList />);
    await screen.findByText('5 entries on 2 machines');
    const names = screen.queryAllByRole('button').map((b) => b.textContent ?? '');
    expect(names.filter((n) => /edit|delete|remove|revoke|allow|save/i.test(n))).toEqual([]);
  });
});

describe('the filters', () => {
  it('a word filters the entries (command, shell, peer) and says how many are shown', async () => {
    const user = userEvent.setup();
    render(<AllowedList />);
    await screen.findByText('5 entries on 2 machines');
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'uptime');
    await waitFor(() => expect(screen.queryByText('dir /b')).toBeNull());
    expect(within(section('desktop')).getByText('uptime')).toBeInTheDocument();
    expect(within(section('laptop')).queryByText('orch logs <j:name>')).toBeNull();
    expect(screen.getByText('1 of 5 entries shown')).toBeInTheDocument();
  });

  it('a filter that matches nothing says so and how to clear it', async () => {
    const user = userEvent.setup();
    render(<AllowedList />);
    await screen.findByText('5 entries on 2 machines');
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'zzz-nothing');
    expect(await screen.findAllByText(/No entry matches/)).not.toHaveLength(0);
  });

  it('the machine filter keeps one machine', async () => {
    const user = userEvent.setup();
    render(<AllowedList />);
    await screen.findByText('5 entries on 2 machines');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Machine' }), 'laptop');
    expect(screen.queryByRole('region', { name: 'Allowed on desktop' })).toBeNull();
    expect(section('laptop')).toBeInTheDocument();
  });
});

describe('failures', () => {
  it('shows the error of the page with its fix and a retry, never an empty list', async () => {
    answer = () => new Error('the machine daemon is not running (no /x/daemon.port.json): start it with `machine daemon`');
    render(<AllowedList />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/start it with `machine daemon`/);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText(/entries on/)).toBeNull();
  });

  it('shows the warnings of the daemon', async () => {
    answer = () => page({ warnings: ['usage.json is corrupt; the calls left are not shown'] });
    render(<AllowedList />);
    expect(await screen.findByText('usage.json is corrupt; the calls left are not shown')).toBeInTheDocument();
  });
});

describe('the view settings', () => {
  it('a refreshSeconds outside 5 to 600 is said on the page, never silently replaced', async () => {
    render(<AllowedList refreshSeconds={1} />);
    expect(await screen.findByText(/refreshSeconds must be from 5 to 600, got 1/)).toBeInTheDocument();
  });
});
