import { encryptAdminKey, generateSigningKeyPair, keyId, signRegistration as coreSignRegistration, type RegistrationBody } from '@wadeck-app/machine-core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MachinesTable, type MachineTableRow } from './MachinesTable.js';

// The Machines page as a user drives it: the table with Revoke on each trusted peer, the dialog of the revocation (PIN, passphrase typed now, signed in the page), the
// result. The app-core shell is a stub on globalThis (the contract of @wadeck-app/app-core-sdk/shell); the module backend is a recording fake.

const PASSPHRASE = 'correct horse battery staple 7391';
const NOW = Math.floor(Date.now() / 1000);
const admin = generateSigningKeyPair();
const keyFile = JSON.stringify(encryptAdminKey(admin, PASSPHRASE, { hint: 'the street of my first school' }));
const uuid = (n: number): string => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const SELF = { uuid: uuid(1), name: 'desktop' };
const LAPTOP = { uuid: uuid(2), name: 'laptop', identity: generateSigningKeyPair() };
const SERVER = { uuid: uuid(3), name: 'server', identity: generateSigningKeyPair() };

const ROWS: MachineTableRow[] = [
  { uuid: SELF.uuid, name: SELF.name, self: true, role: 'this machine', aliasesText: '', reachable: 'this machine', receivesNotices: 'yes', listHeldText: '' },
  { uuid: LAPTOP.uuid, name: LAPTOP.name, self: false, role: 'peer', aliasesText: 'lap', reachable: 'direct', receivesNotices: 'no', listHeldText: '' },
  { uuid: SERVER.uuid, name: SERVER.name, self: false, role: 'peer', aliasesText: '', reachable: 'unknown', receivesNotices: 'no', listHeldText: '' },
];

const registration = (m: { uuid: string; name: string; identity: { publicKey: string } }) => {
  const body: RegistrationBody = { v: 1, uuid: m.uuid, name: m.name, identityPublicKey: m.identity.publicKey, serial: NOW - 100, validFrom: NOW - 100, validTo: NOW + 90 * 86_400, adminKeyId: keyId(admin.publicKey) };
  return coreSignRegistration(body, admin.privateKeyPkcs8);
};

const RETRY = `machine admin distribute ${LAPTOP.uuid}`;
const answers: { context: unknown; revoke: unknown; retry: unknown } = { context: undefined, revoke: undefined, retry: undefined };
const contextOk = () => ({
  ok: true,
  adminMachine: SELF,
  adminPublicKey: admin.publicKey,
  adminKeyId: keyId(admin.publicKey),
  revoked: { uuid: LAPTOP.uuid, name: 'laptop', serial: NOW - 100, keyId: keyId(LAPTOP.identity.publicKey) },
  held: { entries: [], version: 0 },
  recipients: [registration(SERVER)],
  noticeRecipients: null,
});
const revokeOk = (over: Record<string, unknown> = {}) => ({
  ok: true,
  revoked: { uuid: LAPTOP.uuid, name: 'laptop' },
  failed: false,
  report: {},
  text: { out: '[ok] 2 document(s) stored by the relay for 1 machine(s)\n', err: '' },
  machines: [{ uuid: SERVER.uuid, name: 'server', state: 'inbox', code: 'unreachable', reason: 'offline', next: 'installs by itself when it is back, nothing to do' }],
  retry: RETRY,
  ...over,
});

interface Call { url: string; body: unknown; headers: Record<string, string> | undefined }
let calls: Call[];
let elevate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  calls = [];
  answers.context = contextOk();
  answers.revoke = revokeOk();
  answers.retry = undefined;
  const fetcher = async (url: string, _params?: Record<string, string>, body?: unknown, headers?: Record<string, string>) => {
    calls.push({ url, body, headers });
    if (url === `GET /api/modules/machine/revoke-context/${LAPTOP.uuid}`) {
      if (answers.context instanceof Error) throw answers.context;
      return answers.context;
    }
    if (url === 'GET /api/modules/machine/admin-key') return { file: keyFile };
    if (url === 'POST /api/modules/machine/revoke') {
      if (answers.revoke instanceof Error) throw answers.revoke;
      return answers.revoke;
    }
    if (url === 'POST /api/modules/machine/delivery-retry') {
      if (answers.retry instanceof Error) throw answers.retry;
      if (answers.retry === undefined) throw new Error('unexpected call POST /delivery-retry');
      return answers.retry;
    }
    throw new Error(`unexpected call ${url}`);
  };
  elevate = vi.fn(async () => undefined);
  Object.defineProperty(globalThis, '__APP_CORE_SHELL__', { value: { elevate, fetcher }, configurable: true, writable: true });
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, '__APP_CORE_SHELL__');
});

const tableRow = (name: string): HTMLElement => within(screen.getByRole('table')).getByText(name).closest('tr') as HTMLElement;

describe('the table', () => {
  it('Revoke is offered on each trusted peer, never on this machine', () => {
    render(<MachinesTable rows={ROWS} />);
    expect(within(tableRow('laptop')).getByRole('button', { name: 'Revoke laptop' })).toBeInTheDocument();
    expect(within(tableRow('server')).getByRole('button', { name: 'Revoke server' })).toBeInTheDocument();
    expect(within(tableRow('desktop')).queryByRole('button', { name: /^Revoke/ })).toBeNull();
  });

  it('keeps five columns so the Revoke button is reachable at 1024 px without scrolling sideways (name, role, aliases, reachable, the action): the UUID, "Receives notices" and "Notice list held" are in the row details', async () => {
    render(<MachinesTable rows={ROWS} />);
    const headers = within(screen.getByRole('table')).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(expect.arrayContaining(['Name', 'Role', 'Aliases', 'Reachable']));
    expect(headers).not.toContain('UUID');
    expect(headers).not.toContain('Receives notices');
    expect(headers).not.toContain('Notice list held');
    expect(headers.filter((h) => h !== '')).toHaveLength(4);
    expect(within(tableRow('laptop')).queryByText(LAPTOP.uuid)).toBeNull();
    await userEvent.click(within(tableRow('laptop')).getByRole('button', { name: /expand row/i }));
    expect(screen.getByText(new RegExp(LAPTOP.uuid))).toBeInTheDocument();
    expect(within(tableRow('laptop')).getByRole('button', { name: 'Revoke laptop' }).closest('td')?.className).toMatch(/whitespace-nowrap/);
  });

  it('the columns moved out of the table are in the row details, with their value', async () => {
    render(<MachinesTable rows={[{ ...ROWS[0]!, receivesNotices: 'yes', listHeldText: 'holds the list' }]} />);
    await userEvent.click(screen.getByRole('button', { name: /expand row/i }));
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/receives notices: yes/);
    expect(text).toMatch(/notice list held: holds the list/);
  });

  it('a value that is empty is not listed in the row details (no "notice list held: " with nothing after it)', async () => {
    render(<MachinesTable rows={[ROWS[1]!]} />);
    await userEvent.click(screen.getByRole('button', { name: /expand row/i }));
    expect(document.body.textContent).not.toMatch(/notice list held/);
    expect(document.body.textContent).toMatch(/receives notices: no/);
  });

  it('says so when no machine is known', () => {
    render(<MachinesTable rows={[]} emptyMessage="No machine" />);
    expect(screen.getByText('No machine')).toBeInTheDocument();
  });
});

describe('Revoke', () => {
  it('opens the confirmation of that row (PIN first, module header on every call): one line of what it does, the facts folded, the passphrase field with the key hint as help text; Cancel signs nothing', async () => {
    render(<MachinesTable rows={ROWS} />);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke laptop' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Revoke laptop?');
    expect(elevate).toHaveBeenCalledTimes(1);
    const field = await screen.findByLabelText('Admin passphrase');
    expect(dialog).toHaveTextContent(/Revokes laptop: this machine stops trusting it now, and server will be told/);
    // Details are folded: the uuid is not on screen until opened.
    expect(within(dialog).queryByText(LAPTOP.uuid)).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Details' }));
    expect(within(dialog).getByText(LAPTOP.uuid)).toBeInTheDocument();
    expect(within(dialog).getByText(keyId(LAPTOP.identity.publicKey))).toBeInTheDocument();
    // The standard FieldReadOnly with `wrap: words` (dsl-ui 419): one `code` per row that breaks between words; no custom description list, no override of the break class.
    expect(dialog.querySelectorAll('code.break-words')).toHaveLength(6);
    expect(dialog.querySelector('dl')).toBeNull();
    expect(dialog.querySelector('.break-normal')).toBeNull();
    // The hint is the standard help text of the field (under it, described by it), never a custom box.
    expect(document.getElementById(field.getAttribute('aria-describedby') ?? 'none')).toHaveTextContent('Hint: the street of my first school');
    // Asked at every revocation: no "Keep unlocked for".
    expect(screen.queryByLabelText('Keep unlocked for')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.some((c) => c.url.startsWith('POST'))).toBe(false);
    expect(calls.every((c) => c.headers?.['x-machine-module'] === '1')).toBe(true);
  });

  it('signs in the page and posts exactly the list and the documents: no passphrase or key leaves it; the result is one headline, one line per machine, the raw report folded; the list is refreshed', async () => {
    const onRefresh = vi.fn(async () => undefined);
    render(<MachinesTable rows={ROWS} onRefresh={onRefresh} />);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke laptop' }));
    const field = await screen.findByLabelText('Admin passphrase');
    await userEvent.type(field, PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke and sign' }));
    const dialog = await screen.findByRole('dialog', { name: 'laptop revoked' }, { timeout: 20_000 });
    const post = calls.find((c) => c.url === 'POST /api/modules/machine/revoke');
    expect(Object.keys(post?.body as object).sort()).toEqual(['documents', 'noticeRecipients', 'signed', 'uuid']);
    expect(JSON.stringify(calls.map((c) => c.body))).not.toContain(PASSPHRASE);
    // The headline, then one line per machine with its state and its next action.
    expect(within(dialog).getByText('Documents wait in the relay inbox of 1 machine.')).toBeInTheDocument();
    const lines = within(dialog).getByRole('list', { name: 'Machines told' });
    expect(within(lines).getByText('Waiting in the relay inbox')).toBeInTheDocument();
    expect(within(lines).getByText('server')).toBeInTheDocument();
    // The raw report is folded.
    expect(within(dialog).queryByText(/stored by the relay for 1 machine/)).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Details' }));
    expect(within(dialog).getByText(/stored by the relay for 1 machine/)).toBeInTheDocument();
    // The list catches up with the daemon: the machine leaves the trusted ones.
    expect(onRefresh).toHaveBeenCalledWith('machines');
    expect(screen.queryByLabelText('Admin passphrase')).toBeNull();
  }, 60_000);

  const partial = () => revokeOk({
    failed: true,
    text: { out: '', err: `[error] server (x): revocation document not stored: relay down\n[warn] the revocation stands: nothing was undone. Run \`${RETRY}\`\n` },
    machines: [{ uuid: SERVER.uuid, name: 'server', state: 'failed', code: 'not-stored', reason: 'documents not stored', next: `run \`${RETRY}\`` }],
  });
  const revokeAndSign = async () => {
    render(<MachinesTable rows={ROWS} onRefresh={vi.fn(async () => undefined)} />);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke laptop' }));
    await userEvent.type(await screen.findByLabelText('Admin passphrase'), PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke and sign' }));
    return screen.findByRole('dialog', { name: 'laptop revoked' }, { timeout: 20_000 });
  };

  it('a partial delivery: the headline says how many were not told (no command), the report is folded (UX review 5), Retry delivery is offered, the command is folded and said once', async () => {
    answers.revoke = partial();
    const dialog = await revokeAndSign();
    expect(within(dialog).getByText('Documents NOT delivered to 1 machine.')).toBeInTheDocument();
    expect(within(dialog).getByText('Failed')).toBeInTheDocument();
    expect(within(dialog).queryByText(/relay down/)).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Details' }));
    expect(within(dialog).getByText(/relay down/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Retry delivery' })).toBeInTheDocument();
    // Said ONCE, and only when the person opens the folded section: not in the headline, the machine row or the open report.
    expect(dialog.textContent).not.toContain(RETRY);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run it in a terminal instead' }));
    expect(within(dialog).getAllByText(RETRY)).toHaveLength(1);
  }, 60_000);

  it('Retry delivery sends the uuid ONLY to the daemon route (no passphrase, no key read again) and shows the new report', async () => {
    answers.revoke = partial();
    answers.retry = revokeOk({ machines: [{ uuid: SERVER.uuid, name: 'server', state: 'delivered', code: 'direct', reason: 'took the documents directly', next: 'nothing to do' }] });
    const dialog = await revokeAndSign();
    const before = calls.length;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retry delivery' }));
    expect(await within(dialog).findByText('Documents delivered to 1 machine.')).toBeInTheDocument();
    expect(calls.slice(before)).toEqual([{ url: 'POST /api/modules/machine/delivery-retry', body: { uuid: LAPTOP.uuid }, headers: { 'x-machine-module': '1' } }]);
    expect(within(dialog).queryByRole('button', { name: 'Retry delivery' })).toBeNull();
  }, 60_000);

  it('a wrong passphrase is an alert in the dialog, nothing is posted, the dialog stays for another try and the list is not refreshed', async () => {
    const onRefresh = vi.fn(async () => undefined);
    render(<MachinesTable rows={ROWS} onRefresh={onRefresh} />);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke laptop' }));
    await userEvent.type(await screen.findByLabelText('Admin passphrase'), 'not the passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Revoke and sign' }));
    expect(await screen.findByRole('alert', {}, { timeout: 20_000 })).toBeInTheDocument();
    expect(screen.getByLabelText('Admin passphrase')).toHaveValue('');
    expect(calls.some((c) => c.url.startsWith('POST'))).toBe(false);
    expect(onRefresh).not.toHaveBeenCalled();
  }, 60_000);

  it('an empty passphrase is refused in the dialog before anything is signed', async () => {
    render(<MachinesTable rows={ROWS} />);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke laptop' }));
    await screen.findByLabelText('Admin passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Revoke and sign' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Enter the admin passphrase/);
    expect(calls.some((c) => c.url.startsWith('POST'))).toBe(false);
  });

  it('a refusal of the daemon is the alert, as it is worded; the dialog stays, the list is not refreshed', async () => {
    answers.revoke = new Error('another revocation was installed since the page read it: reload the page and revoke again. Nothing was installed');
    const onRefresh = vi.fn(async () => undefined);
    render(<MachinesTable rows={ROWS} onRefresh={onRefresh} />);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke laptop' }));
    await userEvent.type(await screen.findByLabelText('Admin passphrase'), PASSPHRASE);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke and sign' }));
    expect(await screen.findByRole('alert', {}, { timeout: 20_000 })).toHaveTextContent(/reload the page and revoke again/);
    expect(onRefresh).not.toHaveBeenCalled();
  }, 60_000);

  it('a machine that cannot be revoked here (no admin key on this machine) is said in the dialog with the fix, no passphrase is asked, only Close', async () => {
    answers.context = new Error('this machine has no admin key: run this page on the machine that holds it');
    render(<MachinesTable rows={ROWS} />);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke laptop' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no admin key/);
    expect(screen.queryByLabelText('Admin passphrase')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('with no other machine to tell the dialog says so and the result is one line', async () => {
    answers.context = { ...contextOk(), recipients: [] };
    answers.revoke = revokeOk({ machines: [], text: { out: '[ok] no other peer to inform\n', err: '' } });
    render(<MachinesTable rows={ROWS} onRefresh={vi.fn(async () => undefined)} />);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke laptop' }));
    await userEvent.type(await screen.findByLabelText('Admin passphrase'), PASSPHRASE);
    expect(screen.getByRole('dialog')).toHaveTextContent(/no other machine to tell/);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke and sign' }));
    const dialog = await screen.findByRole('dialog', { name: 'laptop revoked' }, { timeout: 20_000 });
    expect(within(dialog).getByText('No other machine to tell.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('list', { name: 'Machines told' })).toBeNull();
  }, 60_000);
});

describe('long names and aliases never hide Revoke (UX review 4, a)', () => {
  const LONG_NAME = 'thinkcentre-workstation-office-2nd-floor-building-B-with-a-very-long-hostname-example';
  const LONG_ALIASES = 'tc, think, office-workstation, second-floor-machine, tc-long-alias-example, another-long-alias';
  const ROW: MachineTableRow = { ...ROWS[2]!, name: LONG_NAME, aliasesText: LONG_ALIASES, reachable: 'directly reachable' };

  it('the name and the aliases are one line cut at a fixed width with the whole text as tooltip; the whole text is in the row details; Revoke stays in the row', async () => {
    render(<MachinesTable rows={[ROWS[0]!, ROW]} />);
    const row = tableRow(LONG_NAME);
    for (const text of [LONG_NAME, LONG_ALIASES]) {
      const cell = within(row).getByText(text);
      expect(cell.className).toMatch(/ truncate |^truncate | truncate$/);
      expect(cell.className).toMatch(/max-w-/);
      expect(cell).toHaveAttribute('title', text);
    }
    expect(within(row).getByRole('button', { name: `Revoke ${LONG_NAME}` }).closest('td')?.className).toMatch(/whitespace-nowrap/);
    await userEvent.click(within(row).getByRole('button', { name: /expand row/i }));
    expect(screen.getByText(new RegExp(`name: ${LONG_NAME}`))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`aliases: ${LONG_ALIASES}`))).toBeInTheDocument();
  });

  it('the Reachable headline wraps at its spaces only (it gives way before the action does) and never in the middle of a word', () => {
    render(<MachinesTable rows={[ROWS[0]!, ROW]} />);
    const text = within(tableRow(LONG_NAME)).getByText('directly reachable');
    // The column is `wrap: words` of the DataTable: the cell itself breaks between words, no wrapper element overrides it.
    expect(text.tagName).toBe('TD');
    expect(text.className).toMatch(/break-words/);
    expect(text.className).not.toMatch(/break-all|whitespace-nowrap/);
    expect(text.querySelector('span')).toBeNull();
  });

  it('a machine with no alias has no empty "aliases:" line in the row details', async () => {
    render(<MachinesTable rows={[ROWS[2]!]} />);
    await userEvent.click(screen.getByRole('button', { name: /expand row/i }));
    expect(document.body.textContent).not.toMatch(/aliases:/);
  });
});

describe('the Reachable column and the failed load (UX review)', () => {
  const ROW: MachineTableRow = { ...ROWS[2]!, reachable: 'not reachable now: documents go through the relay inbox' };

  it('the Reachable cell is a short headline that wraps at its spaces only; the whole sentence is in the row details', async () => {
    render(<MachinesTable rows={[ROWS[0]!, ROW]} />);
    const cell = within(tableRow('server')).getByText('not reachable now').closest('td') as HTMLElement;
    expect(cell.className).not.toMatch(/whitespace-nowrap/);
    expect(cell).not.toHaveTextContent('relay inbox');
    await userEvent.click(within(tableRow('server')).getByRole('button', { name: /expand row/i }));
    expect(screen.getByText(/documents go through the relay inbox/)).toBeInTheDocument();
  });

  it('a failed load is ONE alert above the table, and the empty text is NOT shown', () => {
    const onRefresh = vi.fn(async () => undefined);
    render(<MachinesTable rows={[]} emptyMessage="No machine" sourceErrors={{ machines: { message: 'the relay is unreachable at https://r.example (fetch failed): check the network', status: 502 } }} onRefresh={onRefresh} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the machines: the relay is unreachable at https://r.example. Check the network.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('No machine')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('the focus after a dialog closes (UX review 4, b)', () => {
  it('Escape on the Revoke dialog gives the focus back to the Revoke button of the row, not to the page body', async () => {
    const user = userEvent.setup();
    render(<MachinesTable rows={ROWS} />);
    await user.click(screen.getByRole('button', { name: 'Revoke laptop' }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Revoke laptop' })).toHaveFocus());
  });

  it('a revocation that removes the row leaves the focus on the list, never on the page body', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<MachinesTable rows={ROWS} />);
    await user.click(screen.getByRole('button', { name: 'Revoke laptop' }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    rerender(<MachinesTable rows={[ROWS[0]!, ROWS[2]!]} />);
    await waitFor(() => expect(screen.getByTestId('machines-root')).toContainElement(document.activeElement as HTMLElement));
  });
});
