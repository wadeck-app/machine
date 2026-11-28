import { encryptAdminKey, generateSigningKeyPair, keyId, signAliases, signRegistration as coreSignRegistration, type RegistrationBody, type SignedAliases } from '@wadeck-app/machine-core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MachinesTable, type MachineTableRow } from './MachinesTable.js';

// Rename and Aliases from the Machines page, as a user drives them: the row actions, the dialog of each (PIN, the plan said before the passphrase, the passphrase typed now,
// signed in the page), the result with Retry delivery. The app-core shell is a stub on globalThis; the module backend is a recording fake. Real crypto.

const PASSPHRASE = 'correct horse battery staple 7391';
const NOW = Math.floor(Date.now() / 1000);
const admin = generateSigningKeyPair();
const keyFile = JSON.stringify(encryptAdminKey(admin, PASSPHRASE, { hint: 'the street of my first school' }));
const uuid = (n: number): string => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const SELF = { uuid: uuid(1), name: 'desktop' };
const LAPTOP = { uuid: uuid(2), name: 'laptop', identity: generateSigningKeyPair() };
const SERVER = { uuid: uuid(3), name: 'server', identity: generateSigningKeyPair() };

const ROWS: MachineTableRow[] = [
  { uuid: SELF.uuid, name: SELF.name, self: true, role: 'this machine', aliasesText: '', reachable: 'this machine' },
  { uuid: LAPTOP.uuid, name: LAPTOP.name, self: false, role: 'peer', aliasesText: '', reachable: 'direct' },
  { uuid: SERVER.uuid, name: SERVER.name, self: false, role: 'peer', aliasesText: '', reachable: 'unknown' },
];

const registration = (m: { uuid: string; name: string; identity: { publicKey: string } }) => {
  const body: RegistrationBody = { v: 1, uuid: m.uuid, name: m.name, identityPublicKey: m.identity.publicKey, serial: NOW - 100, validFrom: NOW - 100, validTo: NOW + 90 * 86_400, adminKeyId: keyId(admin.publicKey) };
  return coreSignRegistration(body, admin.privateKeyPkcs8);
};
const listOf = (entries: Array<{ alias: string; uuid: string }>): SignedAliases =>
  signAliases({ v: 1, adminKeyId: keyId(admin.publicKey), serial: NOW - 50, issuedAt: NOW - 50, entries }, admin.privateKeyPkcs8);

const RENAME_RETRY = 'machine admin rename box box';
const ALIASES_RETRY = 'machine admin alias send';
const INBOX = { uuid: SERVER.uuid, name: 'server', state: 'inbox', code: 'unreachable', reason: 'offline', next: 'installs by itself when it is back, nothing to do' };
const FAILED = { uuid: SERVER.uuid, name: 'server', state: 'failed', code: 'not-stored', reason: 'documents not stored', next: 'run it' };
const DELIVERED = { uuid: SERVER.uuid, name: 'server', state: 'delivered', code: 'direct', reason: 'took the documents directly', next: 'nothing to do' };
const delivery = (over: Record<string, unknown>) => ({ failed: false, report: {}, text: { out: '[ok] stored by the relay\n', err: '' }, machines: [INBOX], ...over });

const state: { renameContext: unknown; renameAnswer: unknown; aliasesContext: unknown; aliasesAnswer: unknown; retry: unknown } = {
  renameContext: undefined,
  renameAnswer: undefined,
  aliasesContext: undefined,
  aliasesAnswer: undefined,
  retry: undefined,
};
const renameContext = () => ({
  ok: true,
  adminMachine: SELF,
  adminPublicKey: admin.publicKey,
  adminKeyId: keyId(admin.publicKey),
  machine: { uuid: LAPTOP.uuid, name: 'laptop', serial: NOW - 100, keyId: keyId(LAPTOP.identity.publicKey) },
  current: registration(LAPTOP),
  machines: [SELF, { uuid: LAPTOP.uuid, name: 'laptop' }, { uuid: SERVER.uuid, name: 'server' }],
  aliases: {},
  networkAliases: {},
  revokedUpTo: null,
  others: [registration(SERVER)],
  noticeRecipients: null,
});
const aliasesContext = (over: Record<string, unknown> = {}) => ({
  ok: true,
  adminMachine: SELF,
  adminPublicKey: admin.publicKey,
  adminKeyId: keyId(admin.publicKey),
  current: listOf([{ alias: 'srv', uuid: SERVER.uuid }]),
  machines: [SELF, { uuid: LAPTOP.uuid, name: 'laptop' }, { uuid: SERVER.uuid, name: 'server' }],
  revoked: [],
  localAliases: {},
  recipients: [registration(LAPTOP), registration(SERVER)],
  ...over,
});

interface Call { url: string; body: unknown; headers: Record<string, string> | undefined }
let calls: Call[];
let elevate: ReturnType<typeof vi.fn>;
const answer = (value: unknown): unknown => {
  if (value instanceof Error) throw value;
  if (value === undefined) throw new Error('unexpected call');
  return value;
};

beforeEach(() => {
  calls = [];
  state.renameContext = renameContext();
  state.renameAnswer = { ok: true, subject: { uuid: LAPTOP.uuid, name: 'box' }, retry: RENAME_RETRY, ...delivery({}) };
  state.aliasesContext = aliasesContext();
  state.aliasesAnswer = { ok: true, serial: NOW, entries: [], changed: true, retry: ALIASES_RETRY, ...delivery({}) };
  state.retry = undefined;
  const fetcher = async (url: string, _params?: Record<string, string>, body?: unknown, headers?: Record<string, string>) => {
    calls.push({ url, body, headers });
    if (url === `GET /api/modules/machine/rename-context/${LAPTOP.uuid}`) return answer(state.renameContext);
    if (url === 'GET /api/modules/machine/admin-key') return { file: keyFile };
    if (url === 'POST /api/modules/machine/rename') return answer(state.renameAnswer);
    if (url === 'GET /api/modules/machine/aliases-context') return answer(state.aliasesContext);
    if (url === 'POST /api/modules/machine/aliases') return answer(state.aliasesAnswer);
    if (url === 'POST /api/modules/machine/delivery-retry') return answer(state.retry);
    throw new Error(`unexpected call ${url}`);
  };
  elevate = vi.fn(async () => undefined);
  Object.defineProperty(globalThis, '__APP_CORE_SHELL__', { value: { elevate, fetcher }, configurable: true, writable: true });
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, '__APP_CORE_SHELL__');
});

const tableRow = (name: string): HTMLElement => within(screen.getByRole('table')).getByText(name).closest('tr') as HTMLElement;

describe('the row actions', () => {
  it('Rename is offered on each trusted peer and never on this machine; Aliases on every row; each next to Revoke in the narrow action column', () => {
    render(<MachinesTable rows={ROWS} />);
    expect(within(tableRow('laptop')).getByRole('button', { name: 'Rename laptop' })).toBeInTheDocument();
    expect(within(tableRow('laptop')).getByRole('button', { name: 'Aliases laptop' })).toBeInTheDocument();
    expect(within(tableRow('laptop')).getByRole('button', { name: 'Revoke laptop' })).toBeInTheDocument();
    expect(within(tableRow('desktop')).queryByRole('button', { name: /^Rename/ })).toBeNull();
    expect(within(tableRow('desktop')).getByRole('button', { name: 'Aliases desktop' })).toBeInTheDocument();
    expect(within(tableRow('laptop')).getByRole('button', { name: 'Rename laptop' }).closest('td')?.className).toMatch(/whitespace-nowrap/);
  });

  it('with a name of 70 characters the actions are still in the row (the name is cut with its whole text as the tooltip)', () => {
    const long = 'a-very-long-machine-name-'.repeat(3).slice(0, 70);
    render(<MachinesTable rows={[{ ...ROWS[1]!, name: long }]} />);
    const row = tableRow(long);
    for (const label of [`Rename ${long}`, `Aliases ${long}`, `Revoke ${long}`]) {
      expect(within(row).getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(within(row).getByText(long)).toHaveAttribute('title', long);
  });
});

describe('Rename', () => {
  it('opens that machine (PIN first, module header): a name the CLI would refuse is said under the field before the passphrase; Cancel signs nothing and gives the focus back to the button', async () => {
    render(<MachinesTable rows={ROWS} />);
    await userEvent.click(screen.getByRole('button', { name: 'Rename laptop' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Rename laptop?');
    expect(elevate).toHaveBeenCalledTimes(1);
    const field = await screen.findByLabelText('New name');
    await userEvent.type(field, 'server');
    expect(dialog).toHaveTextContent(/already used by machine "server".*pick another name/);
    await userEvent.clear(field);
    await userEvent.type(field, 'My Box');
    expect(dialog).toHaveTextContent('Will be renamed: laptop -> my-box (typed "My Box", made valid).');
    expect(screen.queryByLabelText('Keep unlocked for')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.some((c) => c.url.startsWith('POST'))).toBe(false);
    expect(calls.every((c) => c.headers?.['x-machine-module'] === '1')).toBe(true);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rename laptop' })).toHaveFocus());
  });

  it('confirming with a refused name signs nothing and says so; the details say what keeps and what stops working', async () => {
    render(<MachinesTable rows={ROWS} />);
    await userEvent.click(screen.getByRole('button', { name: 'Rename laptop' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(await screen.findByLabelText('New name'), 'server');
    await userEvent.type(screen.getByLabelText('Admin passphrase'), PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Sign and rename' }));
    expect(await within(dialog).findByText(/Nothing was signed\./)).toBeInTheDocument();
    expect(calls.some((c) => c.url.startsWith('POST'))).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Details' }));
    expect(dialog).toHaveTextContent(/Keeps working/);
    expect(dialog).toHaveTextContent(/Stops working/);
  });

  it('signs in the page and posts exactly the registration and the documents: no passphrase leaves it; the result is one headline and one line per machine; the list is refreshed', async () => {
    const onRefresh = vi.fn(async () => undefined);
    render(<MachinesTable rows={ROWS} onRefresh={onRefresh} />);
    await userEvent.click(screen.getByRole('button', { name: 'Rename laptop' }));
    await userEvent.type(await screen.findByLabelText('New name'), 'box');
    await userEvent.type(screen.getByLabelText('Admin passphrase'), PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Sign and rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'laptop renamed to box' }, { timeout: 20_000 });
    const post = calls.find((c) => c.url === 'POST /api/modules/machine/rename');
    expect(Object.keys(post?.body as object).sort()).toEqual(['documents', 'noticeRecipients', 'signed', 'uuid']);
    expect(JSON.stringify(calls.map((c) => c.body))).not.toContain(PASSPHRASE);
    expect(within(dialog).getByText(/"laptop" is now "box"\. Documents wait in the relay inbox of 1 machine\./)).toBeInTheDocument();
    expect(within(within(dialog).getByRole('list', { name: 'Machines told' })).getByText('server')).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalledWith('machines');
    expect(screen.queryByLabelText('Admin passphrase')).toBeNull();
  }, 60_000);

  it('a partial delivery: Retry delivery is offered (no passphrase, the uuid only), the command is folded and said once; after the retry the headline is the delivered one', async () => {
    state.renameAnswer = { ok: true, subject: { uuid: LAPTOP.uuid, name: 'box' }, retry: RENAME_RETRY, ...delivery({ failed: true, text: { out: '', err: '[error] server (x): peer document not stored: relay down\n' }, machines: [FAILED] }) };
    state.retry = { ok: true, retry: RENAME_RETRY, ...delivery({ machines: [DELIVERED] }) };
    render(<MachinesTable rows={ROWS} onRefresh={vi.fn(async () => undefined)} />);
    await userEvent.click(screen.getByRole('button', { name: 'Rename laptop' }));
    await userEvent.type(await screen.findByLabelText('New name'), 'box');
    await userEvent.type(screen.getByLabelText('Admin passphrase'), PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Sign and rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'laptop renamed to box' }, { timeout: 20_000 });
    // The raw report is folded (UX review 5): the machine line and the buttons come first.
    expect(within(dialog).queryByText(/relay down/)).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Details' }));
    expect(within(dialog).getByText(/relay down/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retry delivery' }));
    await waitFor(() => expect(within(dialog).getByText(/Documents delivered to 1 machine\./)).toBeInTheDocument());
    const retry = calls.find((c) => c.url === 'POST /api/modules/machine/delivery-retry');
    expect(retry?.body).toEqual({ uuid: LAPTOP.uuid });
    expect(within(dialog).queryByRole('button', { name: 'Retry delivery' })).toBeNull();
  }, 60_000);

  it('the daemon refuses at the context: the dialog says why and what to do, with Close only', async () => {
    state.renameContext = new Error('machine 2222 is revoked here: enroll it again with `machine join`');
    render(<MachinesTable rows={ROWS} />);
    await userEvent.click(screen.getByRole('button', { name: 'Rename laptop' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/revoked here: enroll it again/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Admin passphrase')).toBeNull();
  });
});

describe('Aliases', () => {
  const openAliases = async (row = 'laptop') => {
    await userEvent.click(screen.getByRole('button', { name: `Aliases ${row}` }));
    return screen.findByRole('dialog', { name: 'Network aliases' });
  };

  it('lists the current network aliases with the machine each points to, shows a local alias that wins, and prefills the target with the row machine', async () => {
    state.aliasesContext = aliasesContext({ localAliases: { srv: LAPTOP.uuid } });
    render(<MachinesTable rows={ROWS} />);
    const dialog = await openAliases('laptop');
    expect(elevate).toHaveBeenCalledTimes(1);
    const list = await within(dialog).findByRole('list', { name: 'Network aliases' });
    expect(within(list).getByText('srv')).toBeInTheDocument();
    expect(within(list).getByText('server')).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/"srv" is a network alias of server.*local alias of laptop.*the local alias wins on this machine/);
    expect(within(dialog).getByLabelText('Points to')).toHaveValue(LAPTOP.uuid);
    expect(dialog).toHaveTextContent('1 of the 64 aliases the network can hold');
  });

  it('an alias the CLI would refuse is said under the field before the passphrase; nothing is posted', async () => {
    render(<MachinesTable rows={ROWS} />);
    const dialog = await openAliases('laptop');
    await userEvent.type(await within(dialog).findByLabelText('Alias'), 'server');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add alias' }));
    expect(dialog).toHaveTextContent(/already the name of machine "server"/);
    expect(screen.queryByLabelText('Admin passphrase')).toBeNull();
    expect(calls.some((c) => c.url.startsWith('POST'))).toBe(false);
  });

  it('adds an alias: the confirmation names the change, the passphrase is typed now, the whole list and the documents are posted, the result has the headline and the lines; Back shows the reloaded list', async () => {
    render(<MachinesTable rows={ROWS} />);
    const dialog = await openAliases('laptop');
    await userEvent.type(await within(dialog).findByLabelText('Alias'), 'box');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add alias' }));
    const confirm = await screen.findByRole('dialog', { name: 'Set alias box?' });
    expect(confirm).toHaveTextContent(/box.*laptop/);
    expect(screen.queryByLabelText('Keep unlocked for')).toBeNull();
    await userEvent.type(screen.getByLabelText('Admin passphrase'), PASSPHRASE);
    state.aliasesContext = aliasesContext({ current: listOf([{ alias: 'box', uuid: LAPTOP.uuid }, { alias: 'srv', uuid: SERVER.uuid }]) });
    await userEvent.click(screen.getByRole('button', { name: 'Sign and add' }));
    const result = await screen.findByRole('dialog', { name: 'Network alias box set' }, { timeout: 20_000 });
    const post = calls.find((c) => c.url === 'POST /api/modules/machine/aliases');
    expect(Object.keys(post?.body as object).sort()).toEqual(['documents', 'signed']);
    expect(JSON.stringify(calls.map((c) => c.body))).not.toContain(PASSPHRASE);
    expect(within(result).getByText(/Network alias "box" now points to "laptop"\. Documents wait in the relay inbox of 1 machine\./)).toBeInTheDocument();
    await userEvent.click(within(result).getByRole('button', { name: 'Back to the aliases' }));
    const back = await screen.findByRole('dialog', { name: 'Network aliases' });
    const list = await within(back).findByRole('list', { name: 'Network aliases' });
    expect(within(list).getByText('box')).toBeInTheDocument();
    // The alias that was added is not typed again by mistake: the field is empty.
    expect(within(back).getByLabelText('Alias')).toHaveValue('');
  }, 60_000);

  it('removes an alias: its own confirmation and its own passphrase', async () => {
    render(<MachinesTable rows={ROWS} />);
    const dialog = await openAliases('laptop');
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Remove alias srv' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove alias srv?' });
    await userEvent.type(within(confirm).getByLabelText('Admin passphrase'), PASSPHRASE);
    await userEvent.click(within(confirm).getByRole('button', { name: 'Sign and remove' }));
    await screen.findByRole('dialog', { name: 'Network alias srv removed' }, { timeout: 20_000 });
    const post = calls.find((c) => c.url === 'POST /api/modules/machine/aliases');
    expect((post?.body as { signed: { body: { entries: unknown[] } } }).signed.body.entries).toEqual([]);
  }, 60_000);

  it('Cancel on the confirmation goes back to the list without signing', async () => {
    render(<MachinesTable rows={ROWS} />);
    const dialog = await openAliases('laptop');
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Remove alias srv' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Remove alias srv?' })).getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('dialog', { name: 'Network aliases' })).toBeInTheDocument();
    expect(calls.some((c) => c.url.startsWith('POST'))).toBe(false);
  });

  it('a daemon that refuses the context says why, with Close only; the focus goes back to the Aliases button', async () => {
    state.aliasesContext = new Error('this machine has no admin key: run this page on the admin machine');
    render(<MachinesTable rows={ROWS} />);
    const dialog = await openAliases('laptop');
    expect(await within(dialog).findByText(/no admin key/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Aliases laptop' })).toHaveFocus());
  });
});

// UX review 5 ------------------------------------------------------------------------------------------------------------------------------------------------------------

const openRename = async (name = 'laptop') => {
  await userEvent.click(screen.getByRole('button', { name: `Rename ${name}` }));
  return screen.findByRole('dialog');
};
const noShowMore = (dialog: HTMLElement): void => {
  // The Notice of dsl-ui offers "Show more" above 140 characters whether or not three lines hide anything: a text of the dialogs stays under it.
  expect(within(dialog).queryByRole('button', { name: /Show more/ })).toBeNull();
};

describe('Rename (UX review 5)', () => {
  it('the focus is in the New name field when the dialog opens (not on Cancel, not on the page)', async () => {
    render(<MachinesTable rows={ROWS} />);
    await openRename();
    await waitFor(() => expect(screen.getByLabelText('New name')).toHaveFocus());
  });

  it('shows the normalized new name before the signature, with the old one: "laptop -> box"; a typed name made valid says what it was', async () => {
    render(<MachinesTable rows={ROWS} />);
    const dialog = await openRename();
    const field = await screen.findByLabelText('New name');
    await userEvent.type(field, 'box');
    expect(dialog).toHaveTextContent('Will be renamed: laptop -> box');
    expect(dialog).not.toHaveTextContent('made valid).');
    await userEvent.clear(field);
    await userEvent.type(field, 'My Box');
    expect(dialog).toHaveTextContent('Will be renamed: laptop -> my-box (typed "My Box", made valid).');
  });

  it('says the 32 characters cap instead of cutting silently', async () => {
    render(<MachinesTable rows={ROWS} />);
    const dialog = await openRename();
    await userEvent.type(await screen.findByLabelText('New name'), 'a-machine-name-that-is-far-longer-than-thirty-two-characters');
    expect(dialog).toHaveTextContent('Will be renamed: laptop -> a-machine-name-that-is-far-longe');
    expect(dialog).toHaveTextContent('A name has at most 32 characters: the end of what you typed was cut.');
  });

  it('an empty name and an empty passphrase are both said at once, nothing is posted, and the focus goes to the name', async () => {
    render(<MachinesTable rows={ROWS} />);
    const dialog = await openRename();
    await screen.findByLabelText('New name');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sign and rename' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Type the new name first.');
    expect(alert).toHaveTextContent('Enter the admin passphrase to sign.');
    expect(alert).toHaveTextContent('Nothing was signed.');
    expect(calls.some((c) => c.url.startsWith('POST'))).toBe(false);
    await waitFor(() => expect(screen.getByLabelText('New name')).toHaveFocus());
  });

  it('a valid name and an empty passphrase: the passphrase is the only problem and has the focus (as before)', async () => {
    render(<MachinesTable rows={ROWS} />);
    const dialog = await openRename();
    await userEvent.type(await screen.findByLabelText('New name'), 'box');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sign and rename' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Enter the admin passphrase to sign. Nothing was signed.');
    expect(alert).not.toHaveTextContent(/Type the new name/);
    await waitFor(() => expect(screen.getByLabelText('Admin passphrase')).toHaveFocus());
  });

  it('a conflict names the machine and never ends with a truncated uuid', async () => {
    render(<MachinesTable rows={ROWS} />);
    const dialog = await openRename();
    await userEvent.type(await screen.findByLabelText('New name'), 'server');
    expect(dialog.textContent).toMatch(/already used by machine "server": pick another name/);
    expect(dialog.textContent).not.toMatch(/\([0-9a-f]{8}\)/);
  });

  it('the Details are folded, wrap at spaces (never "f/ollow"), and say what keeps and stops working', async () => {
    render(<MachinesTable rows={ROWS} />);
    const dialog = await openRename();
    await screen.findByLabelText('New name');
    const toggle = within(dialog).getByRole('button', { name: 'Details' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(dialog).toHaveTextContent(/Keeps working/);
    expect(dialog.innerHTML).not.toMatch(/break-all/);
    noShowMore(dialog);
  });

  it('the page says why the same name twice is the terminal command: the documents are sent again, nothing is renamed; Retry delivery comes first and Details are folded', async () => {
    state.renameAnswer = { ok: true, subject: { uuid: LAPTOP.uuid, name: 'box' }, retry: RENAME_RETRY, ...delivery({ failed: true, text: { out: '', err: '[error] server (x): peer document not stored: relay down\n' }, machines: [FAILED] }) };
    render(<MachinesTable rows={ROWS} onRefresh={vi.fn(async () => undefined)} />);
    await openRename();
    await userEvent.type(await screen.findByLabelText('New name'), 'box');
    await userEvent.type(screen.getByLabelText('Admin passphrase'), PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Sign and rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'laptop renamed to box' }, { timeout: 20_000 });
    expect(within(dialog).getByRole('button', { name: 'Details' })).toHaveAttribute('aria-expanded', 'false');
    expect(within(dialog).getByRole('button', { name: 'Retry delivery' })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run it in a terminal instead' }));
    expect(within(dialog).getByText(RENAME_RETRY)).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/the same name twice is how .*machine admin rename.* sends the documents again; nothing is renamed/);
    expect(dialog).toHaveTextContent(/Only when Retry delivery says/);
  }, 60_000);


  const renamed = (name: string) => [ROWS[0]!, { ...ROWS[1]!, name }, ROWS[2]!];
  const renameLaptopToBox = async () => {
    await openRename();
    await userEvent.type(await screen.findByLabelText('New name'), 'box');
    await userEvent.type(screen.getByLabelText('Admin passphrase'), PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Sign and rename' }));
    return screen.findByRole('dialog', { name: 'laptop renamed to box' }, { timeout: 20_000 });
  };

  it('after a successful rename the list has already reloaded when Close is pressed: the focus goes to the button of the renamed row, not to the page', async () => {
    let rerenderTable: (name: string) => void = () => undefined;
    // The page reloads its list as soon as the daemon answered, behind the dialog.
    const onRefresh = vi.fn(async () => rerenderTable('box'));
    const { rerender } = render(<MachinesTable rows={ROWS} onRefresh={onRefresh} />);
    rerenderTable = (name) => rerender(<MachinesTable rows={renamed(name)} onRefresh={onRefresh} />);
    const dialog = await renameLaptopToBox();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rename box' })).toHaveFocus());
  }, 60_000);

  it('after a successful rename the list reloads only after Close: the focus rests on the row button and follows the new name, never falls to the page', async () => {
    const onRefresh = vi.fn(async () => undefined);
    const { rerender } = render(<MachinesTable rows={ROWS} onRefresh={onRefresh} />);
    const dialog = await renameLaptopToBox();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rename laptop' })).toHaveFocus());
    rerender(<MachinesTable rows={renamed('box')} onRefresh={onRefresh} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rename box' })).toHaveFocus());
  }, 60_000);

  it('the Rename dialog texts fit a Notice without "Show more"', async () => {
    render(<MachinesTable rows={ROWS} />);
    const dialog = await openRename();
    await screen.findByLabelText('New name');
    noShowMore(dialog);
  });
});

describe('Aliases (UX review 5)', () => {
  const openAliases = async (row = 'laptop') => {
    await userEvent.click(screen.getByRole('button', { name: `Aliases ${row}` }));
    return screen.findByRole('dialog', { name: 'Network aliases' });
  };

  it('explains the count: "of the 64 aliases the network can hold"', async () => {
    render(<MachinesTable rows={ROWS} />);
    const dialog = await openAliases();
    await within(dialog).findByRole('list', { name: 'Network aliases' });
    expect(dialog).toHaveTextContent('1 of the 64 aliases the network can hold');
  });

  it('the list texts never offer a "Show more" that shows nothing (the intro is plain text, a conflict is one sentence and the command under it)', async () => {
    state.aliasesContext = aliasesContext({ localAliases: { srv: LAPTOP.uuid } });
    render(<MachinesTable rows={ROWS} />);
    const dialog = await openAliases();
    await within(dialog).findByRole('list', { name: 'Network aliases' });
    noShowMore(dialog);
    // The command is monospace, without backticks.
    expect(dialog.textContent).not.toContain('`');
    expect(within(dialog).getByText('machine alias rm srv')).toBeInTheDocument();
  });

  it('the confirmation of "box" tells no conflict about another alias (tc): only the conflicts of the alias being set', async () => {
    state.aliasesContext = aliasesContext({ current: listOf([{ alias: 'tc', uuid: SERVER.uuid }]), localAliases: { tc: LAPTOP.uuid } });
    render(<MachinesTable rows={ROWS} />);
    const dialog = await openAliases();
    await userEvent.type(await within(dialog).findByLabelText('Alias'), 'box');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add alias' }));
    const confirm = await screen.findByRole('dialog', { name: 'Set alias box?' });
    expect(confirm.textContent).not.toMatch(/"tc"/);
    expect(confirm.textContent).not.toMatch(/local alias wins/);
    noShowMore(confirm);
  });

  it('the confirmation of an alias that a local alias shadows tells that conflict, with the command in monospace', async () => {
    state.aliasesContext = aliasesContext({ localAliases: { box: SERVER.uuid } });
    render(<MachinesTable rows={ROWS} />);
    const dialog = await openAliases();
    await userEvent.type(await within(dialog).findByLabelText('Alias'), 'box');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add alias' }));
    const confirm = await screen.findByRole('dialog', { name: 'Set alias box?' });
    expect(confirm).toHaveTextContent('"box" is also a local alias of server: the local alias wins on this machine.');
    expect(within(confirm).getByText('machine alias rm box')).toBeInTheDocument();
    expect(confirm.textContent).not.toContain('`');
  });

  it('Add and Remove follow one pattern: "Sign and add" and "Sign and remove", like "Sign and rename"', async () => {
    render(<MachinesTable rows={ROWS} />);
    const dialog = await openAliases();
    await userEvent.type(await within(dialog).findByLabelText('Alias'), 'box');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add alias' }));
    const add = await screen.findByRole('dialog', { name: 'Set alias box?' });
    expect(within(add).getByRole('button', { name: 'Sign and add' })).toBeInTheDocument();
    await userEvent.click(within(add).getByRole('button', { name: 'Cancel' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Remove alias srv' }));
    const remove = await screen.findByRole('dialog', { name: 'Remove alias srv?' });
    expect(within(remove).getByRole('button', { name: 'Sign and remove' })).toBeInTheDocument();
  });

  it('the Details of the confirmation are folded and never break a word', async () => {
    render(<MachinesTable rows={ROWS} />);
    const dialog = await openAliases();
    await userEvent.type(await within(dialog).findByLabelText('Alias'), 'box');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add alias' }));
    const confirm = await screen.findByRole('dialog', { name: 'Set alias box?' });
    const toggle = within(confirm).getByRole('button', { name: 'Details' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(confirm.innerHTML).not.toMatch(/break-all/);
  });

  it('a refusal names the machine (no truncated uuid), under the field', async () => {
    state.aliasesContext = aliasesContext({ current: listOf([{ alias: 'box', uuid: SERVER.uuid }]) });
    render(<MachinesTable rows={ROWS} />);
    const dialog = await openAliases();
    await userEvent.type(await within(dialog).findByLabelText('Alias'), 'box');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add alias' }));
    const refusal = within(dialog).getByText(/already points to machine/).textContent ?? '';
    expect(refusal).toContain('already points to machine "server"');
    expect(refusal).not.toMatch(/\([0-9a-f]{8}\)/);
  });
});
