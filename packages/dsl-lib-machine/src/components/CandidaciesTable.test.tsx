import {
  candidacyCode,
  encryptAdminKey,
  generateSigningKeyPair,
  keyId,
  newCandidacyRandom,
  signRegistration as coreSignRegistration,
  type RegistrationBody,
} from '@wadeck-app/machine-core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimelineStep } from './VerticalTimeline.js';
import { CandidaciesTable, type CandidacyTableRow } from './CandidaciesTable.js';

// The Candidacies page as a user drives it: the table with Approve and Reject on each pending row, the dialog of the approval, the timeline that advances only on what
// the page proves. The app-core shell is a stub on globalThis (the contract of @wadeck-app/app-core-sdk/shell); the module backend is a recording fake.

const PASSPHRASE = 'correct horse battery staple 7391';
const NOW = Math.floor(Date.now() / 1000);
const admin = generateSigningKeyPair();
const keyFile = JSON.stringify(encryptAdminKey(admin, PASSPHRASE));
const uuid = (n: number): string => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const ADMIN_MACHINE = { uuid: uuid(1), name: 'desktop', identity: generateSigningKeyPair() };
const A = { uuid: uuid(2), name: 'laptop', identity: generateSigningKeyPair(), random: newCandidacyRandom() };
const B = { uuid: uuid(4), name: 'phone', identity: generateSigningKeyPair(), random: newCandidacyRandom() };

const rowOf = (id: string, m: typeof A, over: Partial<CandidacyTableRow> = {}): CandidacyTableRow => ({
  id,
  name: m.name,
  hostname: `${m.name.toUpperCase()}-HOST`,
  uuid: m.uuid,
  observedIp: '203.0.113.7',
  identityPublicKey: m.identity.publicKey,
  random: m.random,
  code: candidacyCode(m.identity.publicKey, m.random),
  rebind: false,
  problems: [],
  ageText: '30 s',
  statusText: 'Pending',
  bindingText: `- name: ${m.name}\n- uuid: ${m.uuid}`,
  canDecide: true,
  canApprove: true,
  ...over,
});

const TIMELINE: TimelineStep[] = [
  { id: 'received', title: 'Candidacy received', status: 'done', info: 'a' },
  { id: 'checked', title: 'Details checked', status: 'current', info: 'b' },
  { id: 'signed', title: 'Passphrase and signature', status: 'todo', info: 'c' },
  { id: 'distributed', title: 'Documents distributed', status: 'todo', info: 'e' },
  { id: 'final-code', title: 'Security code compared', status: 'todo', info: 'd' },
];

interface Call { url: string; body: unknown; headers: Record<string, string> | undefined }
let calls: Call[];

beforeEach(() => {
  calls = [];
  const fetcher = async (url: string, _params?: Record<string, string>, body?: unknown, headers?: Record<string, string>) => {
    calls.push({ url, body, headers });
    if (url === `GET /api/modules/machine/approve-context/${A.uuid}`) {
      const body: RegistrationBody = { v: 1, uuid: uuid(3), name: 'server', identityPublicKey: generateSigningKeyPair().publicKey, serial: NOW - 100, validFrom: NOW - 100, validTo: NOW + 90 * 86_400, adminKeyId: keyId(admin.publicKey) };
      return { ok: true, adminMachine: { uuid: ADMIN_MACHINE.uuid, name: ADMIN_MACHINE.name, identityPublicKey: ADMIN_MACHINE.identity.publicKey }, adminPublicKey: admin.publicKey, adminKeyId: keyId(admin.publicKey), candidate: { trusted: false }, others: [coreSignRegistration(body, admin.privateKeyPkcs8)], noticeRecipients: null };
    }
    if (url === 'GET /api/modules/machine/admin-key') return { file: keyFile };
    if (url === 'POST /api/modules/machine/candidacies/c1/approve') return { ok: true, id: 'c1', message: 'Candidacy c1 approved' };
    if (url === 'POST /api/modules/machine/approve-distribute') return { ok: true, failed: false, report: {}, text: { out: '[ok] 2 document(s) stored by the relay for 1 machine(s)\n', err: '' }, machines: [{ uuid: uuid(3), name: 'server', state: 'delivered', code: 'direct', reason: 'took the documents directly', next: 'nothing to do' }, { uuid: A.uuid, name: 'laptop', state: 'inbox', code: 'unreachable', reason: 'offline', next: 'installs by itself when it is back, nothing to do' }], retry: 'x' };
    if (url === 'POST /api/modules/machine/approval-codes') return { ok: true };
    throw new Error(`unexpected call ${url}`);
  };
  Object.defineProperty(globalThis, '__APP_CORE_SHELL__', { value: { elevate: vi.fn(async () => undefined), fetcher }, configurable: true, writable: true });
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, '__APP_CORE_SHELL__');
});

const tableRow = (name: string): HTMLElement => within(screen.getByRole('table')).getByText(name).closest('tr') as HTMLElement;
// The timeline of the PAGE (the one behind the dialog, when it is open).
const statusOf = (title: string): string | null => screen.getAllByText(title)[0]?.closest('li')?.getAttribute('data-status') ?? null;
// The timeline INSIDE the open dialog.
const statusInDialog = (title: string): string | null => within(screen.getByRole('dialog')).getByText(title).closest('li')?.getAttribute('data-status') ?? null;

describe('the table', () => {
  it('lists the candidacies; Approve is offered where the candidacy can be approved, Reject where the relay can take a decision', () => {
    render(<CandidaciesTable rows={[rowOf('c1', A), rowOf('c2', B, { canApprove: false, problems: ['x'] })]} timeline={TIMELINE} onAction={vi.fn()} />);
    expect(within(tableRow('laptop')).getByRole('button', { name: 'Approve laptop' })).toBeInTheDocument();
    expect(within(tableRow('laptop')).getByRole('button', { name: 'Reject laptop' })).toBeInTheDocument();
    expect(within(tableRow('phone')).queryByRole('button', { name: /^Approve/ })).toBeNull();
    expect(within(tableRow('phone')).getByRole('button', { name: 'Reject phone' })).toBeInTheDocument();
  });

  it('keeps only the columns that fit without breaking a word (name, age, status, actions): hostname and address are in the row expansion', async () => {
    render(<CandidaciesTable rows={[rowOf('c1', A, { name: 'macbook-pro-de-wadeck', bindingText: '- hostname: MACBOOK-PRO-DE-WADECK\n- seen from: 203.0.113.7' })]} onAction={vi.fn()} />);
    const headers = within(screen.getByRole('table')).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(expect.arrayContaining(['Name', 'Age', 'Status']));
    expect(headers).not.toContain('Hostname');
    expect(headers).not.toContain('Seen from');
    // The name and the age never wrap (a word is never cut): no break class on the cell.
    expect(within(tableRow('macbook-pro-de-wadeck')).getByText('macbook-pro-de-wadeck').closest('td')?.className).toMatch(/whitespace-nowrap/);
    await userEvent.click(screen.getByRole('button', { name: 'Expand row' }));
    expect(screen.getByText(/MACBOOK-PRO-DE-WADECK/)).toBeInTheDocument();
  });

  it('Reject asks first, in a dialog that names the machine ("Reject laptop?", buttons Cancel and Reject), then goes through the page action of the view with the row (its reload stays the page\'s)', async () => {
    const onAction = vi.fn();
    render(<CandidaciesTable rows={[rowOf('c1', A)]} onAction={onAction} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reject laptop' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Reject laptop?');
    expect(dialog).toHaveTextContent('laptop is refused and must post a new candidacy to ask again');
    expect(within(dialog).getByText('machine join --resume')).toBeInTheDocument();
    expect(dialog.textContent).not.toContain('`');
    // Nothing is sent until the person confirms; Cancel is the default focus.
    expect(onAction).not.toHaveBeenCalled();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    // The name goes with the request, so the route can answer "laptop rejected" instead of the id of the candidacy.
    expect(onAction).toHaveBeenCalledWith('reject', expect.objectContaining({ id: 'c1' }), { body: { name: 'laptop' } });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Cancel in the Reject dialog sends nothing', async () => {
    const onAction = vi.fn();
    render(<CandidaciesTable rows={[rowOf('c1', A)]} onAction={onAction} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reject laptop' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
  });

  it('Reject without the action wired says so with the fix and opens no dialog', async () => {
    render(<CandidaciesTable rows={[rowOf('c1', A)]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reject laptop' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reject' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Reject is not wired to this page');
  });

  it('the row expansion shows the details (never empty)', async () => {
    render(<CandidaciesTable rows={[rowOf('c1', A)]} onAction={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Expand row' }));
    expect(screen.getByText(new RegExp(A.uuid))).toBeInTheDocument();
  });

  it('says so when nothing is pending', () => {
    render(<CandidaciesTable rows={[]} emptyMessage="No pending candidacy" onAction={vi.fn()} />);
    expect(screen.getByText('No pending candidacy')).toBeInTheDocument();
  });
});

describe('the security codes kept after an approval', () => {
  const KEPT = [{ uuid: A.uuid, name: 'laptop', code: '12345 67890 12345 67890 12345', ageText: '10 min' }];

  it('are readable again, closed by default: one "Show security code" per recently approved machine, with the code and where it must read the same', async () => {
    render(<CandidaciesTable rows={[]} approvals={KEPT} onAction={vi.fn()} />);
    expect(screen.queryByLabelText('Security code')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show security code: laptop (approved 10 min ago)' }));
    expect(screen.getByLabelText('Security code')).toHaveTextContent('12345 67890 12345 67890 12345');
    expect(document.body.textContent).toMatch(/must read exactly the same on laptop/);
    expect(document.body.textContent).toMatch(/decisive confirmation is made on laptop/);
    // Read again later: nothing to press, nothing recorded from here.
    expect(screen.queryByRole('button', { name: 'Codes match' })).toBeNull();
  });

  it('none kept: nothing is shown', () => {
    render(<CandidaciesTable rows={[]} approvals={[]} onAction={vi.fn()} />);
    expect(screen.queryByText(/Security codes/)).toBeNull();
  });

  it('a file of codes the module could not read is said, with the fix, instead of silently showing none', () => {
    render(<CandidaciesTable rows={[]} approvalsProblem="approval-codes.json is damaged (x): delete it" onAction={vi.fn()} />);
    expect(screen.getByText(/approval-codes\.json is damaged.*delete it/)).toBeInTheDocument();
  });
});

describe('Approve', () => {
  it('opens the confirmation of that row (PIN first), Cancel closes it and signs nothing', async () => {
    render(<CandidaciesTable rows={[rowOf('c1', A)]} timeline={TIMELINE} onAction={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve laptop' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Approve laptop?');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.some((c) => c.url.startsWith('POST'))).toBe(false);
    // Every call of the page carries the module header (the sensitive routes refuse without it).
    expect(calls.every((c) => c.headers?.['x-machine-module'] === '1')).toBe(true);
  });

  it('the timeline advances only on what the page proves: untouched until the passphrase is used, then signed, then the code waits for the person; it follows the approval after the dialog closes', async () => {
    const onRefresh = vi.fn(async () => undefined);
    render(<CandidaciesTable rows={[rowOf('c1', A)]} timeline={TIMELINE} onAction={vi.fn()} onRefresh={onRefresh} />);
    expect([statusOf('Details checked'), statusOf('Passphrase and signature')]).toEqual(['current', 'todo']);
    await userEvent.click(screen.getByRole('button', { name: 'Approve laptop' }));
    await userEvent.type(await screen.findByLabelText('Admin passphrase'), PASSPHRASE);
    expect([statusOf('Details checked'), statusOf('Passphrase and signature')]).toEqual(['current', 'todo']);
    await userEvent.click(screen.getByRole('button', { name: 'Approve and sign' }));
    await screen.findByLabelText('Security code', {}, { timeout: 20_000 });
    expect([statusOf('Details checked'), statusOf('Passphrase and signature'), statusOf('Documents distributed'), statusOf('Security code compared')]).toEqual(['done', 'done', 'done', 'current']);
    // The same timeline is INSIDE the dialog (the page behind it is hidden by the backdrop), in the same state; the document step says who waits in the inbox.
    expect([statusInDialog('Details checked'), statusInDialog('Passphrase and signature'), statusInDialog('Documents distributed'), statusInDialog('Security code compared')]).toEqual(['done', 'done', 'done', 'current']);
    expect(within(screen.getByRole('dialog')).getByText(/1 waiting in the relay inbox/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // The list catches up with the relay: the approved candidacy leaves the pending ones.
    expect(onRefresh).toHaveBeenCalledWith('candidacies');
    expect(statusOf('Passphrase and signature')).toBe('done');
  }, 60_000);

  it('a refused approval leaves the timeline as the module computed it', async () => {
    render(<CandidaciesTable rows={[rowOf('c1', A)]} timeline={TIMELINE} onAction={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve laptop' }));
    await userEvent.type(await screen.findByLabelText('Admin passphrase'), 'not the passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Approve and sign' }));
    await screen.findByRole('alert', {}, { timeout: 20_000 });
    expect([statusOf('Details checked'), statusOf('Passphrase and signature')]).toEqual(['current', 'todo']);
  }, 60_000);
});

describe('the status column and the empty and failed states (UX review)', () => {
  const LONG = 'Cannot be approved: the candidacy carries no uuid (posted by an older `machine join`, or the relay dropped it): reject it, and ask the candidate to run `machine join --resume`';

  it('the status cell is a short headline that WRAPS (it takes the width left, so the actions are never pushed out of view at 1024 px); the whole sentence is in the row expansion', async () => {
    render(<CandidaciesTable rows={[rowOf('c1', A, { statusText: LONG, canApprove: false })]} onAction={vi.fn()} />);
    const cell = within(tableRow('laptop')).getByText('Cannot be approved').closest('td') as HTMLElement;
    expect(cell.className).not.toMatch(/whitespace-nowrap/);
    // Name, age and the buttons never wrap: they keep their width.
    const row = tableRow('laptop');
    expect(within(row).getByText('laptop').closest('td')?.className).toMatch(/whitespace-nowrap/);
    expect(within(row).getByText('30 s').closest('td')?.className).toMatch(/whitespace-nowrap/);
    expect(within(row).getByRole('button', { name: 'Reject laptop' }).closest('td')?.className).toMatch(/whitespace-nowrap/);
    expect(cell).not.toHaveTextContent('carries no uuid');
    await userEvent.click(screen.getByRole('button', { name: 'Expand row' }));
    expect(screen.getByText(/the candidacy carries no uuid/)).toBeInTheDocument();
  });

  it('a short status is shown as it is', () => {
    render(<CandidaciesTable rows={[rowOf('c1', A)]} onAction={vi.fn()} />);
    expect(within(tableRow('laptop')).getByText('Pending')).toBeInTheDocument();
  });

  it('nothing pending: the empty state says it and names the next step, with the command in monospace (no backtick), padded and in one line; no timeline of five "To do" steps is drawn', () => {
    render(<CandidaciesTable rows={[]} timeline={TIMELINE} onAction={vi.fn()} />);
    expect(screen.getByText('machine join')).toBeInTheDocument();
    const empty = screen.getByTestId('empty-candidacies');
    expect(empty).toHaveTextContent('No pending candidacy. Run machine join on the new machine to enroll it.');
    expect(empty.textContent).not.toContain('`');
    expect(empty.className).toMatch(/\bpy-\d+/);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('Candidacy received')).toBeNull();
    expect(screen.queryByText('To do')).toBeNull();
  });

  it('a failed load is ONE alert above the table (cause and exact command), the whole message folded, and the empty text is NOT shown', async () => {
    const message = 'this machine holds no admin relay token (no relay-admin.json): approving needs it. Run `machine admin login` and confirm the request';
    render(<CandidaciesTable rows={[]} timeline={TIMELINE} sourceErrors={{ candidacies: { message, status: 503 } }} onAction={vi.fn()} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Could not load the candidacies: this machine holds no admin relay token.');
    // The command is monospace text next to the alert, never between literal backticks.
    expect(screen.getByText('machine admin login')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Run `machine admin login`/);
    expect(screen.queryByTestId('empty-candidacies')).toBeNull();
    expect(screen.queryByText('No pending candidacy')).toBeNull();
    expect(screen.queryByText('Candidacy received')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    await userEvent.click(screen.getByText('Details'));
    expect(screen.getByText(/HTTP 503/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp('approving needs it'))).toBeInTheDocument();
  });

  it('a failed poll that keeps the rows shown before: the alert is above them, the rows stay', () => {
    render(<CandidaciesTable rows={[rowOf('c1', A)]} sourceErrors={{ candidacies: { message: 'the relay is unreachable at https://r.example (fetch failed): check the network' } }} onAction={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the candidacies');
    expect(within(tableRow('laptop')).getByText('Pending')).toBeInTheDocument();
  });

  it('the failure of ANOTHER source is not this table\'s alert', () => {
    render(<CandidaciesTable rows={[]} sourceErrors={{ machines: { message: 'boom' } }} onAction={vi.fn()} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
