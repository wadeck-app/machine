import {
  candidacyCode,
  encryptAdminKey,
  finalCode as coreFinalCode,
  generateSigningKeyPair,
  keyId,
  newCandidacyRandom,
  signRegistration as coreSignRegistration,
  type RegistrationBody,
  type SignedRegistration,
} from '@wadeck-app/machine-core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { adminKeyHolder } from '../lib/adminKeyHolder.js';
import type { AllowApi } from '../lib/allowFlow.js';
import type { ApproveContext, ApproveRow } from '../lib/approveFlow.js';
import type { ApprovalProgress } from '../lib/approvalTimeline.js';
import { ApproveCandidacyDialog } from './ApproveCandidacyDialog.js';
import type { TimelineStep } from './VerticalTimeline.js';

// The confirmation of ONE approval: loads the context (after the PIN), checks what needs no passphrase, shows who is enrolled and who is told, asks the passphrase
// (taken once, never kept), signs in the page, posts, then shows the result: one headline, the security code first, one line per machine, the raw report folded.

const PASSPHRASE = 'correct horse battery staple 7391';
const NOW = Math.floor(Date.now() / 1000);
const admin = generateSigningKeyPair();
const keyFile = JSON.stringify(encryptAdminKey(admin, PASSPHRASE));
const uuid = (n: number): string => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const ADMIN_MACHINE = { uuid: uuid(1), name: 'desktop', identity: generateSigningKeyPair() };
const CANDIDATE = { uuid: uuid(2), name: 'laptop', identity: generateSigningKeyPair() };
const PEER = { uuid: uuid(3), name: 'server', identity: generateSigningKeyPair() };
const RANDOM = newCandidacyRandom();

const registrationOf = (m: { uuid: string; name: string; identity: { publicKey: string } }): SignedRegistration => {
  const body: RegistrationBody = { v: 1, uuid: m.uuid, name: m.name, identityPublicKey: m.identity.publicKey, serial: NOW - 100, validFrom: NOW - 100, validTo: NOW + 90 * 86_400, adminKeyId: keyId(admin.publicKey) };
  return coreSignRegistration(body, admin.privateKeyPkcs8);
};

const row = (over: Partial<ApproveRow> = {}): ApproveRow => ({
  id: 'cand-1',
  name: CANDIDATE.name,
  hostname: 'LAPTOP-HOST',
  uuid: CANDIDATE.uuid,
  observedIp: '203.0.113.7',
  identityPublicKey: CANDIDATE.identity.publicKey,
  random: RANDOM,
  code: candidacyCode(CANDIDATE.identity.publicKey, RANDOM),
  rebind: false,
  problems: [],
  ...over,
});

const context = (over: Partial<ApproveContext> = {}): ApproveContext => ({
  ok: true,
  adminMachine: { uuid: ADMIN_MACHINE.uuid, name: ADMIN_MACHINE.name, identityPublicKey: ADMIN_MACHINE.identity.publicKey },
  adminPublicKey: admin.publicKey,
  adminKeyId: keyId(admin.publicKey),
  candidate: { trusted: false },
  others: [registrationOf(PEER)],
  noticeRecipients: null,
  ...over,
});

// What the daemon answers per machine: one delivered directly, one waiting in the relay inbox (offline).
const DELIVERED_SERVER = { uuid: PEER.uuid, name: 'server', state: 'delivered', code: 'direct', reason: 'took the documents directly', next: 'nothing to do' };
const INBOX_LAPTOP = { uuid: CANDIDATE.uuid, name: 'laptop', state: 'inbox', code: 'unreachable', reason: 'offline', next: 'installs by itself when it is back, nothing to do' };
const RETRY = `machine admin distribute ${CANDIDATE.uuid}`;
const REPORT = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ok: true,
  subject: { uuid: CANDIDATE.uuid, name: 'laptop' },
  failed: false,
  report: {},
  text: { out: '[ok] 2 document(s) stored by the relay for 1 machine(s)\n[info] the documents are sealed to each machine (the relay cannot read them).\n', err: '' },
  machines: [DELIVERED_SERVER, INBOX_LAPTOP],
  retry: RETRY,
  ...over,
});

interface Sent { method: string; path: string; body?: unknown }
function stubApi(answers: { context?: unknown; post?: Record<string, unknown> } = {}): AllowApi & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    async elevate() {},
    async get(path: string) {
      sent.push({ method: 'GET', path });
      if (path === '/admin-key') return { ok: true, file: keyFile };
      if (path === `/approve-context/${CANDIDATE.uuid}`) return answers.context ?? context();
      throw new Error(`no stub for GET ${path}`);
    },
    async post(path: string, body: unknown) {
      sent.push({ method: 'POST', path, body });
      const answer = answers.post?.[path];
      if (answer instanceof Error) throw answer;
      if (answer !== undefined) return answer;
      if (path.endsWith('/approve')) return { ok: true, id: 'cand-1', message: 'Candidacy cand-1 approved' };
      if (path === '/approval-codes') return { ok: true };
      return REPORT();
    },
  };
}

const STEPS: TimelineStep[] = [
  { id: 'received', title: 'Candidacy received', status: 'done' },
  { id: 'checked', title: 'Details checked', status: 'done' },
  { id: 'signed', title: 'Passphrase and signature', status: 'current' },
  { id: 'distributed', title: 'Documents distributed', status: 'todo' },
  { id: 'final-code', title: 'Security code compared', status: 'todo' },
];

const setup = (api: AllowApi, props: { row?: ApproveRow; steps?: TimelineStep[]; onProgress?: (p: ApprovalProgress | undefined) => void } = {}) => {
  const onClose = vi.fn();
  const onProgress = props.onProgress ?? vi.fn();
  render(<ApproveCandidacyDialog row={props.row ?? row()} api={api} onClose={onClose} onProgress={onProgress} {...(props.steps === undefined ? {} : { steps: props.steps })} />);
  return { onClose, onProgress };
};

const approve = async (passphrase = PASSPHRASE): Promise<void> => {
  await userEvent.type(await screen.findByLabelText('Admin passphrase'), passphrase);
  await userEvent.click(screen.getByRole('button', { name: 'Approve and sign' }));
};

// The elements whose whole text is `text`, not inside the raw report (the "Details" of the result is a <pre>).
const outsideDetails = (text: string): HTMLElement[] => screen.queryAllByText(text).filter((e) => e.closest('pre') === null);

// The text of the dialog without the raw report of the CLI (the "Details" is a <pre>, shown as the daemon wrote it).
const withoutReport = (): string => {
  const copy = screen.getByRole('dialog').cloneNode(true) as HTMLElement;
  copy.querySelectorAll('pre').forEach((p) => p.remove());
  return copy.textContent ?? '';
};

const CODE = coreFinalCode(CANDIDATE.identity.publicKey, admin.publicKey, RANDOM);
const resultShown = async () => screen.findByLabelText('Security code', {}, { timeout: 20_000 });

describe('ApproveCandidacyDialog: before the passphrase', () => {
  it('is short: ONE intro line, the passphrase field right after it, no orange box and no stack of paragraphs; the facts are folded in "Details"', async () => {
    setup(stubApi());
    await screen.findByLabelText('Admin passphrase');
    const dialog = screen.getByRole('dialog');
    expect(screen.getByText(/Enrolls laptop: this machine and server will trust it/)).toBeInTheDocument();
    expect(dialog.querySelector('p.border-warning')).toBeNull();
    expect(dialog.querySelectorAll('p')).toHaveLength(1);
    // The facts are folded: not on screen until opened.
    expect(screen.queryByText('LAPTOP-HOST')).toBeNull();
    expect(screen.queryByText(/recomputed in this page/i)).toBeNull();
    // The field comes before the buttons and after the intro.
    const intro = screen.getByText(/Enrolls laptop/);
    const field = screen.getByLabelText('Admin passphrase');
    expect(intro.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the key hint is the description of the passphrase field', async () => {
    const api = stubApi();
    api.get = async (path: string) => (path === '/admin-key' ? { ok: true, file: JSON.stringify({ ...JSON.parse(keyFile), hint: 'the street of my first school' }) } : context());
    setup(api);
    expect(await screen.findByText('Hint: the street of my first school')).toBeInTheDocument();
    expect(screen.queryByTestId('passphrase-hint')).toBeNull();
  });

  it('shows who is enrolled (name, hostname, uuid, seen from), who is told, and that the candidacy code was checked here, in the Details, without repeating itself', async () => {
    setup(stubApi());
    await screen.findByLabelText('Admin passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(await screen.findByText('LAPTOP-HOST')).toBeInTheDocument();
    expect(screen.getByText(CANDIDATE.uuid)).toBeInTheDocument();
    expect(screen.getByText('203.0.113.7')).toBeInTheDocument();
    expect(screen.getByText('server')).toBeInTheDocument();
    expect(screen.getByText(/recomputed in this page/i)).toBeInTheDocument();
    // The candidacy code itself is not displayed (decision 55): only the security code, after the approval.
    expect(document.body.textContent).not.toContain(candidacyCode(CANDIDATE.identity.publicKey, RANDOM));
    expect(screen.getByLabelText('Admin passphrase')).toHaveValue('');
    // One sentence for who is told (the row "Others told"), not a note that says it again.
    expect(screen.queryByText(/No other machine is told/)).toBeNull();
    expect(screen.queryByText(/The documents that tell the others/)).toBeNull();
  });

  it('a code that does not match the key and random: the dialog refuses loudly, there is no passphrase field and nothing was signed', async () => {
    const api = stubApi();
    setup(api, { row: row({ identityPublicKey: generateSigningKeyPair().publicKey }) });
    expect(await screen.findByRole('alert')).toHaveTextContent(/does not match/);
    expect(screen.queryByLabelText('Admin passphrase')).toBeNull();
    expect(api.sent.filter((s) => s.method === 'POST')).toEqual([]);
  });

  it('a rebind of the relay binding and a machine revoked earlier are said before the passphrase, as warnings', async () => {
    setup(stubApi({ context: context({ candidate: { trusted: true, name: 'laptop', identityPublicKey: CANDIDATE.identity.publicKey, revokedSerial: 9 } }) }), { row: row({ rebind: true, boundTokenLabel: 'old laptop' }) });
    await screen.findByLabelText('Admin passphrase');
    expect(screen.getByText(/REVOKED here earlier \(serial 9\)/)).toBeInTheDocument();
    expect(screen.getByText(/old laptop/)).toBeInTheDocument();
    expect(screen.getAllByRole('status').length).toBeGreaterThanOrEqual(2);
  });

  it('asks the passphrase even while a key is held in this page (no unlock window), with no "Keep unlocked for"', async () => {
    adminKeyHolder.hold({ privateKey: {} as CryptoKey, publicKeyRaw: new Uint8Array(32), publicKey: 'p', keyId: 'k'.repeat(32), lock: () => undefined, isLocked: () => false });
    setup(stubApi());
    expect(await screen.findByLabelText('Admin passphrase')).toBeInTheDocument();
    expect(screen.queryByLabelText('Keep unlocked for')).toBeNull();
  });

  it('Cancel closes without signing', async () => {
    const api = stubApi();
    const { onClose } = setup(api);
    await screen.findByLabelText('Admin passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(api.sent.filter((s) => s.method === 'POST')).toEqual([]);
  });

  it('the timeline is shown INSIDE the dialog in every phase (loading, ready), never only on the page behind the backdrop', async () => {
    setup(stubApi(), { steps: STEPS });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Documents distributed')).toBeInTheDocument();
    await screen.findByLabelText('Admin passphrase');
    expect(within(screen.getByRole('dialog')).getByText('Passphrase and signature')).toBeInTheDocument();
  });

  it('a refusal (the code does not match) shows the timeline too, with the error', async () => {
    setup(stubApi(), { steps: STEPS, row: row({ identityPublicKey: generateSigningKeyPair().publicKey }) });
    await screen.findByRole('alert');
    expect(within(screen.getByRole('dialog')).getByText('Details checked')).toBeInTheDocument();
  });
});

describe('ApproveCandidacyDialog: the approval', () => {
  it('signs in the page, posts the approval then the documents, shows the result; the passphrase is nowhere afterwards', async () => {
    const api = stubApi();
    const { onProgress } = setup(api);
    await approve();
    expect(await resultShown()).toHaveTextContent(CODE);
    // The security code is handed to the module right after the approval, before the delivery (the relay purges the random of an approved candidacy).
    expect(api.sent.map((s) => `${s.method} ${s.path}`)).toEqual([`GET /approve-context/${CANDIDATE.uuid}`, 'GET /admin-key', 'GET /admin-key', 'POST /candidacies/cand-1/approve', 'POST /approval-codes', 'POST /approve-distribute']);
    expect(api.sent.find((s) => s.path === '/approval-codes')?.body).toEqual({ uuid: CANDIDATE.uuid, name: 'laptop', code: CODE });
    expect(JSON.stringify(api.sent)).not.toContain(PASSPHRASE);
    expect(document.body.innerHTML).not.toContain(PASSPHRASE);
    expect(adminKeyHolder.current()).toBeNull();
    const seen = (onProgress as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as ApprovalProgress);
    expect(seen.map((p) => [p.signed, p.approved, p.delivery])).toEqual([[true, false, undefined], [true, true, undefined], [true, true, 'delivered']]);
    expect(seen.at(-1)?.waiting).toBe(1);
  }, 60_000);

  it('the result is short: the outcome in one line, THEN the security code with its sentence and both buttons, THEN one line per machine, the raw report folded', async () => {
    setup(stubApi());
    await approve();
    await resultShown();
    const dialog = screen.getByRole('dialog');
    const text = dialog.textContent ?? '';
    // Order on screen: headline, code, buttons, machines, details.
    const at = (s: string): number => text.indexOf(s);
    expect(at('Documents delivered to 1 machine, 1 waits in the relay inbox.')).toBeGreaterThan(-1);
    expect(at('Documents delivered to 1 machine')).toBeLessThan(at(CODE));
    expect(at(CODE)).toBeLessThan(at('Codes match'));
    expect(at('Codes match')).toBeLessThan(at('server'));
    expect(at('server')).toBeLessThan(at('Details'));
    expect(screen.getByRole('button', { name: 'Codes match' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Codes differ' })).toBeInTheDocument();
    // The sentence that says what the button does NOT do, next to the code.
    expect(text).toMatch(/must read exactly the same on laptop/);
    expect(text).toMatch(/only records your comparison on this page/);
    expect(text).toMatch(/decisive confirmation is made on laptop/);
    // One line per machine: state, one short reason, one next action.
    const list = screen.getByRole('list', { name: 'Machines told' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('server');
    expect(items[0]).toHaveTextContent('Delivered');
    // Nothing to do is not a line of its own: a delivered machine says its state and its reason, no more.
    expect(items[0]).not.toHaveTextContent('nothing to do');
    expect(items[1]).toHaveTextContent('laptop');
    expect(items[1]).toHaveTextContent('Waiting in the relay inbox');
    expect(items[1]).toHaveTextContent('offline');
    expect(items[1]).toHaveTextContent('installs by itself when it is back, nothing to do');
  }, 60_000);

  it('the result view takes the focus (Close), the page body never has it', async () => {
    setup(stubApi());
    await approve();
    await resultShown();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus());
    expect(document.body).not.toHaveFocus();
  }, 60_000);

  it('the raw report is folded in "Details": hidden until opened, then the text of the CLI, each line once', async () => {
    setup(stubApi());
    await approve();
    await resultShown();
    expect(screen.queryByText(/documents are sealed to each machine/)).toBeNull();
    expect(screen.queryByText(/2 document\(s\) stored by the relay/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText(/2 document\(s\) stored by the relay/)).toBeInTheDocument();
    expect(screen.getAllByText(/documents are sealed to each machine/)).toHaveLength(1);
  }, 60_000);

  it('the first machine of the network: one line, no machine list, the code is still shown', async () => {
    const self = row({ name: ADMIN_MACHINE.name, uuid: ADMIN_MACHINE.uuid, identityPublicKey: ADMIN_MACHINE.identity.publicKey, code: candidacyCode(ADMIN_MACHINE.identity.publicKey, RANDOM) });
    const api = stubApi({ context: context({ others: [] }) });
    api.get = async (path: string) => (path === '/admin-key' ? { ok: true, file: keyFile } : context({ others: [] }));
    setup(api, { row: self });
    await approve();
    await resultShown();
    expect(screen.getByText('No other machine to tell: this is the first machine of the network.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Machines told' })).toBeNull();
  }, 60_000);

  it('a machine enrolled before (revoked here earlier): no code to compare, said plainly; no code, no buttons, nothing kept; the timeline learns it', async () => {
    const api = stubApi({ context: context({ candidate: { trusted: false, revokedSerial: 3 } }) });
    const { onProgress } = setup(api);
    await approve();
    expect(await screen.findByText('No code to compare: this machine already trusts your admin key.', {}, { timeout: 20_000 })).toBeInTheDocument();
    expect(screen.queryByLabelText('Security code')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Codes match' })).toBeNull();
    expect(api.sent.some((s) => s.path === '/approval-codes')).toBe(false);
    // The delivery is still reported (headline, machines).
    expect(screen.getByText('Documents delivered to 1 machine, 1 waits in the relay inbox.')).toBeInTheDocument();
    expect((onProgress as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toMatchObject({ noCode: true, delivery: 'delivered' });
  }, 60_000);

  it('while the documents are delivered the button says so, and the timeline is still in the dialog', async () => {
    const api = stubApi();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const post = api.post.bind(api);
    api.post = async (path: string, body: unknown) => {
      if (path === '/approve-distribute') {
        await gate;
      }
      return post(path, body);
    };
    setup(api, { steps: STEPS });
    await approve();
    expect(await screen.findByRole('button', { name: 'Telling the other machines...' }, { timeout: 20_000 })).toBeDisabled();
    expect(within(screen.getByRole('dialog')).getByText('Documents distributed')).toBeInTheDocument();
    release();
    await resultShown();
    expect(within(screen.getByRole('dialog')).getByText('Documents distributed')).toBeInTheDocument();
  }, 60_000);

  it('a wrong passphrase: the error is shown with the dialog still open, the field is empty, nothing was posted, and the person can type again', async () => {
    const api = stubApi();
    const { onProgress } = setup(api);
    await approve('not the passphrase');
    const alert = await screen.findByRole('alert', {}, { timeout: 20_000 });
    // What to do first, the message of the core as the detail, and the focus is back in the field.
    expect(alert).toHaveTextContent('Nothing was signed. Retype the passphrase.');
    expect(alert).toHaveTextContent('wrong passphrase or damaged key file');
    await waitFor(() => expect(screen.getByLabelText('Admin passphrase')).toHaveFocus());
    await waitFor(() => expect(screen.getByLabelText('Admin passphrase')).toHaveValue(''));
    expect(api.sent.filter((s) => s.method === 'POST')).toEqual([]);
    // The page proved nothing: the timeline goes back to what the module computed.
    expect((onProgress as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toBeUndefined();
  }, 60_000);

  it('the approval is refused by the backend: its message is shown with the cause, no code is shown (nothing was approved), nothing is kept', async () => {
    const api = stubApi({ post: { '/candidacies/cand-1/approve': new Error('the candidacy is no longer pending. Nothing was approved') } });
    setup(api);
    await approve();
    expect(await screen.findByRole('alert', {}, { timeout: 20_000 })).toHaveTextContent(/no longer pending/);
    expect(screen.queryByLabelText('Security code')).toBeNull();
    expect(api.sent.some((s) => s.path === '/approval-codes')).toBe(false);
  }, 60_000);

  it('a failed delivery: ONE alert with what happened (no command in it), Retry delivery, the cause in the folded Details; the code is still shown (the approval stands)', async () => {
    const api = stubApi({ post: { '/approve-distribute': new Error('the daemon is not running') } });
    setup(api);
    await approve();
    await resultShown();
    expect(screen.getByRole('alert')).toHaveTextContent(/NOT told/);
    expect(screen.getByRole('alert')).not.toHaveTextContent('machine admin distribute');
    expect(screen.getByRole('button', { name: 'Retry delivery' })).toBeInTheDocument();
    // The command is folded as the last resort: on screen nowhere (headline, machine rows, open Details) until the person opens it, then ONCE; no literal backtick.
    expect(screen.queryAllByText(RETRY)).toHaveLength(0);
    expect(withoutReport()).not.toContain(RETRY);
    expect(document.body.textContent).not.toContain(RETRY);
    await userEvent.click(screen.getByRole('button', { name: 'Run it in a terminal instead' }));
    expect(screen.getAllByText(RETRY)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
    expect(withoutReport()).not.toContain('`');
    // The documents are not delivered: the comparison is not offered, one line says why, the code is still readable.
    expect(screen.queryByRole('button', { name: 'Codes match' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Codes differ' })).toBeNull();
    expect(screen.getByText(/Comparing the codes waits until every machine has its documents/)).toBeInTheDocument();
    expect(screen.getByLabelText('Security code')).toHaveTextContent(CODE);
    // The report is folded even on a failure (UX review 5): the lines and the buttons come first; opened, it holds the cause.
    expect(screen.queryByText(/the daemon is not running/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText(/the daemon is not running/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Machines told' })).toBeNull();
  }, 60_000);

  it('a delivery that partly failed: no command in the headline or the rows, the comparison is held back; Retry delivery sends it again WITHOUT the passphrase, the dialog shows the new report and the comparison is offered', async () => {
    const failed = { uuid: PEER.uuid, name: 'server', state: 'failed', code: 'not-stored', reason: 'documents not stored', next: `run \`${RETRY}\`` };
    const partial = REPORT({ failed: true, machines: [failed, INBOX_LAPTOP], text: { out: '', err: `[error] server (x): peer document not stored: relay down\n[warn] the approval stands. Run \`${RETRY}\` to send what is missing\n` } });
    const api = stubApi({ post: { '/approve-distribute': partial, '/delivery-retry': REPORT() } });
    const { onProgress } = setup(api);
    await approve();
    await resultShown();
    const items = within(screen.getByRole('list', { name: 'Machines told' })).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Failed');
    expect(items[0]).toHaveTextContent('documents not stored');
    expect(items[0]).not.toHaveTextContent(RETRY);
    expect(items[1]).toHaveTextContent('installs by itself when it is back');
    expect(document.body.textContent).not.toContain(RETRY);
    expect(screen.queryByRole('button', { name: 'Codes match' })).toBeNull();
    expect(screen.queryByText(/relay down/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText(/relay down/)).toBeInTheDocument();
    const before = api.sent.length;
    await userEvent.click(screen.getByRole('button', { name: 'Retry delivery' }));
    expect(await screen.findByText('Documents delivered to 1 machine, 1 waits in the relay inbox.')).toBeInTheDocument();
    // Only the uuid went to the daemon, no key file was read and no passphrase asked again.
    expect(api.sent.slice(before)).toEqual([{ method: 'POST', path: '/delivery-retry', body: { uuid: CANDIDATE.uuid } }]);
    expect(screen.queryByRole('button', { name: 'Retry delivery' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Codes match' })).toBeInTheDocument();
    expect((onProgress as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toMatchObject({ delivery: 'delivered' });
  }, 60_000);

  it('a retry the daemon refuses (it restarted: nothing is held) is an alert with its words; the button stays and the command is still folded', async () => {
    const failed = { uuid: PEER.uuid, name: 'server', state: 'failed', code: 'not-stored', reason: 'documents not stored', next: 'nothing to do' };
    const api = stubApi({ post: { '/approve-distribute': REPORT({ failed: true, machines: [failed] }), '/delivery-retry': new Error('the daemon holds nothing to retry for this machine (it restarted)') } });
    setup(api);
    await approve();
    await resultShown();
    await userEvent.click(screen.getByRole('button', { name: 'Retry delivery' }));
    expect(await screen.findByText(/the daemon holds nothing to retry for this machine/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry delivery' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Run it in a terminal instead' })).toBeInTheDocument();
  }, 60_000);

  it('the code could not be kept for later: said next to the code, with why, and the code stays on screen', async () => {
    const api = stubApi({ post: { '/approval-codes': new Error('approval-codes.json is damaged: delete it') } });
    setup(api);
    await approve();
    expect(await resultShown()).toHaveTextContent(CODE);
    expect(await screen.findByText(/could not be kept for later.*damaged.*note it now/s)).toBeInTheDocument();
  }, 60_000);

  it('"Codes differ" says what to run, in ONE alert, and reports it; the buttons are gone', async () => {
    const api = stubApi();
    const { onProgress } = setup(api);
    await approve();
    await resultShown();
    await userEvent.click(screen.getByRole('button', { name: 'Codes differ' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Codes differ: do NOT use "laptop".');
    expect(screen.getByText('machine admin revoke laptop')).toBeInTheDocument();
    expect(withoutReport()).not.toContain('`');
    expect(screen.queryByRole('button', { name: 'Codes match' })).toBeNull();
    expect((onProgress as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toMatchObject({ codes: 'differ' });
  }, 60_000);

  it('"Codes match" is reported to the timeline and says again that the decisive confirmation is on the candidate machine', async () => {
    const api = stubApi();
    const { onProgress } = setup(api);
    await approve();
    await resultShown();
    await userEvent.click(screen.getByRole('button', { name: 'Codes match' }));
    expect((onProgress as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toMatchObject({ codes: 'match' });
    expect(screen.getAllByRole('status').map((n) => n.textContent)).toContain('Comparison recorded on this page.');
    expect(document.body.textContent).toMatch(/decisive confirmation is still to be made on laptop: machine join there asks you to confirm its code/);
    expect(screen.queryByRole('button', { name: 'Codes match' })).toBeNull();
  }, 60_000);
});
