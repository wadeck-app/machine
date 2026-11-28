import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AllowedList, type AllowedPageData } from './AllowedList.js';

// The Allowed page: what every machine allows, read-only. One tab per machine, one DataTable per tab. The app-core shell is a stub on
// globalThis; the module backend is a fake that records the URL.

type MachineRow = AllowedPageData['machines'][number];
type EntryRow = MachineRow['entries'][number];

const LIST_DEFAULT = 'Default list (every trusted peer without a list of its own)';
const NOT_HERE = 'This machine does not hold the admin key (policy mode admin): only the admin machine signs this list.';
const NOT_KNOWN = 'The audit log that records the uses is on laptop: only that machine knows when this command last ran.';

const entry = (index: number, over: Partial<EntryRow> = {}): EntryRow => ({
  key: `default|sh|echo ${index}`, listLabel: 'default', listTitle: LIST_DEFAULT, peerName: '', peerUuid: '', maxCalls: null, expiresAt: null, index, shell: 'sh', text: `echo ${index}`, typed: false, lifetimeText: 'permanent', limited: false, limitNote: '',
  lastUsedAt: null, lastUsedSort: -1, lastUsedText: 'never', lastUsedNote: 'No accepted use in the audit log of this machine (10 lines read).', removeCommand: `machine admin allow desktop --remove --index ${index}`, ...over,
});

const installed: MachineRow = {
  uuid: 'u1', name: 'desktop', isSelf: true, source: 'installed', sourceText: 'In force on this machine (mode admin)', mode: 'admin', version: 4, signedText: 'signed 10 min ago', signedIso: '2026-11-22T10:00:00.000Z',
  entries: [
    entry(1, { text: 'echo old', lastUsedAt: 1_700_000_000, lastUsedSort: 1_700_000_000, lastUsedText: '5 days ago', lastUsedNote: '' }),
    entry(2, { shell: 'cmd', text: 'dir /b', lifetimeText: '3 of 5 calls left', limited: true }),
    entry(3, { text: 'echo recent', lastUsedAt: 1_700_500_000, lastUsedSort: 1_700_500_000, lastUsedText: '2 h ago', lastUsedNote: '' }),
  ],
  deliveryNote: '', problem: '', emptyText: '', fillCommand: 'machine admin allow desktop -- <command>', canEdit: false, editNote: NOT_HERE,
};
const signed: MachineRow = {
  uuid: 'u2', name: 'laptop', isSelf: false, source: 'signed-here', sourceText: 'Signed here, may differ from what laptop has installed until it is delivered', mode: 'admin', version: 2, signedText: 'signed 2 h ago', signedIso: '2026-11-22T08:00:00.000Z',
  entries: [
    entry(1, { text: '<img src=x onerror=alert(1)>', lifetimeText: '3 calls', limited: true, limitNote: 'calls left: not shown, the counter is kept on laptop', lastUsedText: 'not known here', lastUsedNote: NOT_KNOWN, removeCommand: 'machine admin allow laptop --remove --index 1' }),
    entry(1, { key: '1:0', listLabel: 'only for desktop', listTitle: 'Only for desktop (its own list, it replaces the default)', peerName: 'desktop', text: 'orch logs <j:name>', typed: true, lastUsedText: 'not known here', lastUsedNote: NOT_KNOWN, removeCommand: '' }),
  ],
  deliveryNote: 'as installed on laptop: ask there with machine policy allow --list (remote view: machine requests/policy views are not built yet)', problem: '', emptyText: '', fillCommand: 'machine admin allow laptop -- <command>', canEdit: false, editNote: NOT_HERE,
};
const empty: MachineRow = { uuid: 'u3', name: 'nas', isSelf: false, source: 'signed-here', sourceText: 'Signed here, may differ from what nas has installed until it is delivered', mode: 'admin', version: null, signedText: '', signedIso: '', entries: [], deliveryNote: '', problem: '', emptyText: 'No policy was signed on this machine for "nas": nothing is known here about what it allows (only policies signed on this machine are on record).', fillCommand: 'machine admin allow nas -- <command>', canEdit: false, editNote: '' };
const broken: MachineRow = { ...empty, uuid: 'u4', name: 'box', emptyText: '', problem: '/x/44.json is not a valid policy record (bad json): delete it, the next policy is then built from nothing', fillCommand: 'machine admin allow box -- <command>' };

function page(over: Partial<AllowedPageData> = {}): AllowedPageData {
  return { machine: { uuid: 'u1', name: 'desktop' }, entryCount: 5, machineCount: 2, machines: [installed, signed, empty, broken], warnings: [], ...over };
}

// The page (allowed.yaml) reads the route and passes the data: the component is given it as a prop.
let answer: () => AllowedPageData;

beforeEach(() => {
  answer = () => page();
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, '__APP_CORE_SHELL__');
});

const tab = (name: RegExp): HTMLElement => screen.getByRole('tab', { name });
const ready = async (): Promise<void> => {
  await screen.findByRole('tab', { name: /^desktop/ });
};
/** The command cells of the table shown, in row order. */
const commands = (): string[] => within(screen.getByRole('table')).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[1]?.textContent ?? '');

describe('the tabs', () => {
  it('shows one tab per machine, named with its entry count; no machine filter, no summary, no change note', async () => {
    render(<AllowedList data={answer()} />);
    await ready();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['desktop (3)', 'laptop (2)', 'nas (0)', 'box (0) - unreadable policy']);
    expect(screen.queryByRole('combobox', { name: 'Machine' })).toBeNull();
    expect(screen.queryByText(/entries on/)).toBeNull();
    expect(screen.queryByText(/Read-only\. To change a list today/)).toBeNull();
  });

  it('shows ONE table at a time, the one of the first machine that has entries; the tab is selected', async () => {
    render(<AllowedList data={answer()} />);
    await ready();
    expect(screen.getAllByRole('table')).toHaveLength(1);
    expect(tab(/^desktop/)).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('echo recent')).toBeInTheDocument();
  });

  it('arrow keys move between tabs and show the table of the focused one', async () => {
    const user = userEvent.setup();
    render(<AllowedList data={answer()} />);
    await ready();
    tab(/^desktop/).focus();
    await user.keyboard('{ArrowRight}');
    expect(tab(/^laptop/)).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('orch logs <j:name>')).toBeInTheDocument();
    expect(screen.queryByText('echo recent')).toBeNull();
  });

  it('keeps the chosen tab when the page is re-read (new data)', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<AllowedList data={answer()} />);
    await ready();
    await user.click(tab(/^laptop/));
    rerender(<AllowedList data={page()} />);
    expect(tab(/^laptop/)).toHaveAttribute('aria-selected', 'true');
  });
});

describe('the table of a machine', () => {
  it('has the primary columns only: command, shell, lifetime, last used', async () => {
    render(<AllowedList data={answer()} />);
    await ready();
    expect(within(screen.getByRole('table')).getAllByRole('columnheader').map((h) => h.textContent?.trim()).filter((t) => t !== '')).toEqual(['Command', 'Shell', 'Lifetime', 'Last used']);
  });

  it('is sorted by last use, most recent first, and an entry with no known use comes last', async () => {
    render(<AllowedList data={answer()} />);
    await ready();
    expect(commands()).toEqual(['echo recent', 'echo old', 'dir /b']);
  });

  it('the sort button of a column re-sorts the table (command: ascending)', async () => {
    const user = userEvent.setup();
    render(<AllowedList data={answer()} />);
    await ready();
    await user.click(screen.getByRole('button', { name: 'Sort by Command' }));
    expect(commands()).toEqual(['dir /b', 'echo old', 'echo recent']);
  });

  it('shows the last use as text, with the exact moment as tooltip; an unknown one says why in words and in its tooltip', async () => {
    render(<AllowedList data={answer()} />);
    await ready();
    const recent = screen.getByText('2 h ago');
    expect(recent.closest('td')?.getAttribute('title')).toBeTruthy();
    expect(screen.getByText('never').closest('td')).toHaveAttribute('title', 'No accepted use in the audit log of this machine (10 lines read).');
  });

  it('for a list signed here every last use is "not known here" with the reason: never a date', async () => {
    const user = userEvent.setup();
    render(<AllowedList data={answer()} />);
    await ready();
    await user.click(tab(/^laptop/));
    const cells = await screen.findAllByText('not known here');
    expect(cells).toHaveLength(2);
    expect(cells[0]?.closest('td')).toHaveAttribute('title', NOT_KNOWN);
  });

  it('shows the lifetime, with the reason of a missing "calls left" in the tooltip AND in the details', async () => {
    const user = userEvent.setup();
    render(<AllowedList data={answer()} />);
    await ready();
    expect(screen.getByText('3 of 5 calls left')).toBeInTheDocument();
    await user.click(tab(/^laptop/));
    expect(await screen.findByText('3 calls')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Show details' })[0] as HTMLElement);
    expect(screen.getByText('calls left: not shown, the counter is kept on laptop')).toBeInTheDocument();
  });

  it('one compact line per tab: where the list comes from, its version and when it was signed (exact date as tooltip)', async () => {
    const user = userEvent.setup();
    render(<AllowedList data={answer()} />);
    await ready();
    expect(screen.getByText('In force on this machine (mode admin)')).toBeInTheDocument();
    expect(screen.getByText('version 4')).toBeInTheDocument();
    expect(screen.getByText('signed 10 min ago')).toHaveAttribute('title', '2026-11-22T10:00:00.000Z');
    await user.click(tab(/^laptop/));
    expect(await screen.findByText(/Signed here, may differ from what laptop has installed until it is delivered/)).toBeInTheDocument();
  });

  it('shows a command as text: markup in it is never rendered, a typed entry is tagged', async () => {
    const user = userEvent.setup();
    const { container } = render(<AllowedList data={answer()} />);
    await ready();
    await user.click(tab(/^laptop/));
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('typed')).toBeInTheDocument();
  });
});

describe('the details of a row', () => {
  it('the toggle opens the list, the place, the reason of the last use and the terminal command that withdraws it', async () => {
    const user = userEvent.setup();
    render(<AllowedList data={answer()} />);
    await ready();
    const toggle = screen.getAllByRole('button', { name: 'Show details' })[0] as HTMLElement;
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    const details = screen.getByRole('group', { name: 'Details of echo recent' });
    expect(within(details).getByText(LIST_DEFAULT)).toBeInTheDocument();
    expect(within(details).getByText('#3')).toBeInTheDocument();
    expect(within(details).getByText('machine admin allow desktop --remove --index 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide details' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('a row without a known last use gives the reason in the details (not only in a tooltip)', async () => {
    const user = userEvent.setup();
    render(<AllowedList data={answer()} />);
    await ready();
    await user.click(screen.getAllByRole('button', { name: 'Show details' })[2] as HTMLElement);
    expect(within(screen.getByRole('group', { name: 'Details of dir /b' })).getByText(/Last used: No accepted use in the audit log of this machine \(10 lines read\)\./)).toBeInTheDocument();
  });

  it('a list signed here: the details carry the delivery note; an entry with no known command says so', async () => {
    const user = userEvent.setup();
    render(<AllowedList data={answer()} />);
    await ready();
    await user.click(tab(/^laptop/));
    const toggles = await screen.findAllByRole('button', { name: 'Show details' });
    await user.click(toggles[1] as HTMLElement);
    const details = screen.getByRole('group', { name: /Details of / });
    expect(within(details).getByText(/as installed on laptop: ask there with machine policy allow --list/)).toBeInTheDocument();
    expect(within(details).getByText(/no terminal command withdraws an entry of a per-peer list of an admin policy/i)).toBeInTheDocument();
  });
});

describe('where this machine cannot sign (the page is read-only there, and says why)', () => {
  it('has no edit, delete or batch control: no row checkbox, no batch bar, no button that changes a list', async () => {
    render(<AllowedList data={answer()} />);
    await ready();
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
    expect(screen.queryByRole('toolbar', { name: 'Batch actions' })).toBeNull();
    const names = screen.queryAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '');
    expect(names.filter((n) => /edit|delete|remove|revoke|allow|save|change/i.test(n))).toEqual([]);
  });

  it('says in ONE line why nothing can be changed here and how to add, with the exact command of the machine', async () => {
    render(<AllowedList data={answer()} />);
    await ready();
    const why = screen.getByText(NOT_HERE);
    expect(why.parentElement).toHaveTextContent('machine admin allow desktop -- <command>');
  });
});

describe('machines without a list', () => {
  it('an empty machine says why and shows the exact command that fills it, with no table', async () => {
    const user = userEvent.setup();
    render(<AllowedList data={answer()} />);
    await ready();
    await user.click(tab(/^nas/));
    expect(await screen.findByText(/No policy was signed on this machine for "nas"/)).toBeInTheDocument();
    expect(screen.getByText('machine admin allow nas -- <command>')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('an unreadable record is an alert with its fix', async () => {
    const user = userEvent.setup();
    render(<AllowedList data={answer()} />);
    await ready();
    await user.click(tab(/^box/));
    expect(await screen.findByRole('alert')).toHaveTextContent(/delete it, the next policy is then built from nothing/);
  });

  it('a policy with no entry says every command is refused', async () => {
    answer = () => page({ machines: [{ ...installed, entries: [] }] });
    render(<AllowedList data={answer()} />);
    expect(await screen.findByText(/this policy has no entry, so every command is refused/)).toBeInTheDocument();
  });
});

describe('search (the word comes from the search field of the page)', () => {
  it('a word filters the rows of the shown table (command, shell, peer, lifetime), updates the tab counts and says how many are shown', async () => {
    render(<AllowedList data={answer()} search="recent" />);
    await ready();
    expect(commands()).toEqual(['echo recent']);
    expect(tab(/^desktop/)).toHaveTextContent('desktop (1)');
    expect(tab(/^laptop/)).toHaveTextContent('laptop (0)');
    expect(screen.getByText('1 of 5 entries shown')).toBeInTheDocument();
  });

  it('a search that matches nothing says so and how to clear it', async () => {
    render(<AllowedList data={answer()} search="zzz-nothing" />);
    expect(await screen.findByText('No entry matches "zzz-nothing" on desktop. Clear the search to see all 3.')).toBeInTheDocument();
  });

  it('has no search field and no Refresh button of its own: the page owns them', async () => {
    render(<AllowedList data={answer()} />);
    await ready();
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
  });
});

describe('failures', () => {
  it('a failed read of the source is the notice of the page (what it is, Retry), never an empty list', async () => {
    const onRefresh = vi.fn(async () => undefined);
    render(<AllowedList sourceErrors={{ allowed: { message: 'the machine daemon is not running (no daemon.port.json): start it with the daemon command and reload the page', status: 503 } }} onRefresh={onRefresh} />);
    expect(screen.getByText('Could not reach the machine daemon, so the allow lists cannot be loaded.')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('an internal error of the route says so and offers Copy details', () => {
    render(<AllowedList sourceErrors={{ allowed: { message: 'boom', status: 500 } }} onRefresh={async () => undefined} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Internal error: the allow lists could not be loaded because of a bug in this page or in the module (HTTP 500).');
    expect(screen.getByRole('button', { name: 'Copy details' })).toBeInTheDocument();
  });

  it('a failed re-read keeps the lists shown before, with the notice above them', async () => {
    render(<AllowedList data={answer()} sourceErrors={{ allowed: { message: 'boom', status: 500 } }} onRefresh={async () => undefined} />);
    await ready();
    expect(screen.getByRole('alert')).toHaveTextContent('Internal error');
    expect(screen.getAllByRole('tab').length).toBeGreaterThan(0);
  });

  it('no data, no failure and not loading is a bug of the page: said as one, never an empty list', () => {
    render(<AllowedList />);
    expect(screen.getByRole('alert')).toHaveTextContent(/not available and the page reported no failure.*bug of the page/s);
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('shows the loading state before the first answer', () => {
    render(<AllowedList loading />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the warnings of the daemon', async () => {
    render(<AllowedList data={page({ warnings: ['usage.json is corrupt; the calls left are not shown'] })} />);
    expect(await screen.findByText('usage.json is corrupt; the calls left are not shown')).toBeInTheDocument();
  });
});
