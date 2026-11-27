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
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { adminKeyHolder } from '../lib/adminKeyHolder.js';
import type { AllowApi } from '../lib/allowFlow.js';
import type { ApproveContext, ApproveRow } from '../lib/approveFlow.js';
import type { ApprovalProgress } from '../lib/approvalTimeline.js';
import { ApproveCandidacyDialog } from './ApproveCandidacyDialog.js';

// The confirmation of ONE approval: loads the context (after the PIN), checks what needs no passphrase, shows who is enrolled and who is told, asks the passphrase
// (taken once, never kept), signs in the page, posts, then shows the security code computed here with what to do when it differs.

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
      return { ok: true, failed: false, report: {}, text: { out: '[ok] 2 document(s) stored by the relay for 1 machine(s)\n', err: '' }, retry: 'x' };
    },
  };
}

const setup = (api: AllowApi, props: { row?: ApproveRow; onProgress?: (p: ApprovalProgress | undefined) => void } = {}) => {
  const onClose = vi.fn();
  const onProgress = props.onProgress ?? vi.fn();
  render(<ApproveCandidacyDialog row={props.row ?? row()} api={api} onClose={onClose} onProgress={onProgress} />);
  return { onClose, onProgress };
};

const approve = async (passphrase = PASSPHRASE): Promise<void> => {
  await userEvent.type(await screen.findByLabelText('Admin passphrase'), passphrase);
  await userEvent.click(screen.getByRole('button', { name: 'Approve and sign' }));
};

describe('ApproveCandidacyDialog: before the passphrase', () => {
  it('shows who is enrolled (name, hostname, uuid, seen from), the admin machine, who is told, and that the candidacy code was checked here', async () => {
    setup(stubApi());
    expect(await screen.findByText('LAPTOP-HOST')).toBeInTheDocument();
    expect(screen.getByText(CANDIDATE.uuid)).toBeInTheDocument();
    expect(screen.getByText('203.0.113.7')).toBeInTheDocument();
    expect(screen.getByText(/server/)).toBeInTheDocument();
    expect(screen.getByText(/recomputed in this page/i)).toBeInTheDocument();
    // The candidacy code itself is not displayed (decision 55): only the security code, after the approval.
    expect(document.body.textContent).not.toContain(candidacyCode(CANDIDATE.identity.publicKey, RANDOM));
    expect(screen.getByLabelText('Admin passphrase')).toHaveValue('');
  });

  it('a code that does not match the key and random: the dialog refuses loudly, there is no passphrase field and nothing was signed', async () => {
    const api = stubApi();
    setup(api, { row: row({ identityPublicKey: generateSigningKeyPair().publicKey }) });
    expect(await screen.findByRole('alert')).toHaveTextContent(/does not match/);
    expect(screen.queryByLabelText('Admin passphrase')).toBeNull();
    expect(api.sent.filter((s) => s.method === 'POST')).toEqual([]);
  });

  it('a rebind of the relay binding and a machine revoked earlier are said before the passphrase', async () => {
    setup(stubApi({ context: context({ candidate: { trusted: true, name: 'laptop', identityPublicKey: CANDIDATE.identity.publicKey, revokedSerial: 9 } }) }), { row: row({ rebind: true, boundTokenLabel: 'old laptop' }) });
    await screen.findByLabelText('Admin passphrase');
    expect(screen.getByText(/REVOKED here earlier \(serial 9\)/)).toBeInTheDocument();
    expect(screen.getByText(/old laptop/)).toBeInTheDocument();
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
});

describe('ApproveCandidacyDialog: the approval', () => {
  it('signs in the page, posts the approval then the documents, shows the security code computed here and what to do when it differs; the passphrase is nowhere afterwards', async () => {
    const api = stubApi();
    const { onProgress } = setup(api);
    await approve();
    const code = coreFinalCode(CANDIDATE.identity.publicKey, admin.publicKey, RANDOM);
    expect(await screen.findByLabelText('Security code', {}, { timeout: 20_000 })).toHaveTextContent(code);
    expect(screen.getByText(/machine admin revoke laptop/)).toBeInTheDocument();
    expect(screen.getByText(/2 document\(s\) stored by the relay/)).toBeInTheDocument();
    expect(api.sent.map((s) => `${s.method} ${s.path}`)).toEqual([`GET /approve-context/${CANDIDATE.uuid}`, 'GET /admin-key', 'GET /admin-key', 'POST /candidacies/cand-1/approve', 'POST /approve-distribute']);
    expect(JSON.stringify(api.sent)).not.toContain(PASSPHRASE);
    expect(document.body.innerHTML).not.toContain(PASSPHRASE);
    expect(adminKeyHolder.current()).toBeNull();
    const seen = (onProgress as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as ApprovalProgress);
    expect(seen.map((p) => [p.signed, p.approved, p.delivery])).toEqual([[true, false, undefined], [true, true, undefined], [true, true, 'delivered']]);
  }, 60_000);

  it('a wrong passphrase: the error is shown with the dialog still open, the field is empty, nothing was posted, and the person can type again', async () => {
    const api = stubApi();
    const { onProgress } = setup(api);
    await approve('not the passphrase');
    expect(await screen.findByRole('alert', {}, { timeout: 20_000 })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Admin passphrase')).toHaveValue(''));
    expect(api.sent.filter((s) => s.method === 'POST')).toEqual([]);
    // The page proved nothing: the timeline goes back to what the module computed.
    expect((onProgress as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toBeUndefined();
  }, 60_000);

  it('the approval is refused by the backend: its message is shown with the cause, no code is shown (nothing was approved)', async () => {
    const api = stubApi({ post: { '/candidacies/cand-1/approve': new Error('the candidacy is no longer pending. Nothing was approved') } });
    setup(api);
    await approve();
    expect(await screen.findByRole('alert', {}, { timeout: 20_000 })).toHaveTextContent(/no longer pending/);
    expect(screen.queryByLabelText('Security code')).toBeNull();
  }, 60_000);

  it('a failed delivery is loud and names the exact retry command, and the code is still shown (the approval stands)', async () => {
    const api = stubApi({ post: { '/approve-distribute': new Error('the daemon is not running') } });
    setup(api);
    await approve();
    await screen.findByLabelText('Security code', {}, { timeout: 20_000 });
    expect(screen.getByRole('alert')).toHaveTextContent(`machine admin distribute ${CANDIDATE.uuid}`);
    expect(screen.getByRole('alert')).toHaveTextContent(/NOT told/);
  }, 60_000);

  it('"The codes differ" says what to run and reports it; "Codes match" is reported too', async () => {
    const api = stubApi();
    const { onProgress } = setup(api);
    await approve();
    await screen.findByLabelText('Security code', {}, { timeout: 20_000 });
    await userEvent.click(screen.getByRole('button', { name: 'The codes differ' }));
    expect(screen.getByRole('alert')).toHaveTextContent('machine admin revoke laptop');
    expect((onProgress as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toMatchObject({ codes: 'differ' });
  }, 60_000);

  it('Codes match is reported to the timeline', async () => {
    const api = stubApi();
    const { onProgress } = setup(api);
    await approve();
    await screen.findByLabelText('Security code', {}, { timeout: 20_000 });
    await userEvent.click(screen.getByRole('checkbox', { name: /same code/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Codes match, continue' }));
    expect((onProgress as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toMatchObject({ codes: 'match' });
  }, 60_000);
});
