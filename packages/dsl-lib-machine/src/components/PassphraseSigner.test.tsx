import { encryptAdminKey, generateSigningKeyPair, keyId, verifyRegistration, type RegistrationBody } from '@wadeck-app/machine-core';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassphraseSigner } from './PassphraseSigner.js';

const PASSPHRASE = 'correct horse battery staple 7391';
const KEY_FILE_URL = '/api/modules/machine/admin-key';

// Every unlock derives 600 000 PBKDF2 iterations: a handful of real ones in this file, not more (the machine is a working desktop).
const admin = generateSigningKeyPair();
const keyFile = JSON.stringify(encryptAdminKey(admin, PASSPHRASE));

const NOW = Math.floor(Date.now() / 1000);
const body = (): RegistrationBody => ({
  v: 1,
  uuid: '11111111-1111-4111-8111-111111111111',
  name: 'laptop',
  identityPublicKey: generateSigningKeyPair().publicKey,
  serial: 1,
  validFrom: NOW - 10,
  validTo: NOW + 3600,
  adminKeyId: keyId(admin.publicKey),
});

function stubFetch(answer: Response | Error) {
  const fetchMock = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return answer.clone();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  stubFetch(new Response(keyFile, { status: 200 }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function unlock(passphrase = PASSPHRASE) {
  await userEvent.type(screen.getByLabelText('Admin passphrase'), passphrase);
  await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));
}

describe('PassphraseSigner', () => {
  it('starts locked: asks for the passphrase and offers no signing', () => {
    render(<PassphraseSigner keyFileUrl={KEY_FILE_URL} registration={body()} />);
    expect(screen.getByLabelText('Admin passphrase')).toHaveAttribute('type', 'password');
    expect(screen.queryByRole('button', { name: 'Sign' })).toBeNull();
  });

  it('unlocks, signs the registration in the page and hands over a signature machine-core verifies', async () => {
    const onSigned = vi.fn();
    const registration = body();
    render(<PassphraseSigner keyFileUrl={KEY_FILE_URL} registration={registration} onSigned={onSigned} unlockSeconds={300} />);
    await unlock();
    const sign = await screen.findByRole('button', { name: 'Sign' });
    expect(screen.queryByLabelText('Admin passphrase')).toBeNull();
    await userEvent.click(sign);
    await waitFor(() => expect(onSigned).toHaveBeenCalledTimes(1));
    const signed = onSigned.mock.calls[0]![0];
    expect(signed.body).toEqual(registration);
    expect(verifyRegistration(signed, { adminPublicKey: admin.publicKey, now: NOW }).ok).toBe(true);
    expect(document.body.innerHTML).not.toContain(PASSPHRASE);
  }, 120_000);

  it('a wrong passphrase gives the actionable message, keeps the field, and never echoes the passphrase', async () => {
    render(<PassphraseSigner keyFileUrl={KEY_FILE_URL} registration={body()} />);
    await unlock('definitely not the passphrase 123');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('wrong passphrase or damaged key file');
    expect(alert.textContent).not.toContain('definitely not the passphrase 123');
    expect(screen.getByLabelText('Admin passphrase')).toBeInTheDocument();
  }, 120_000);

  it('a key file the backend cannot serve is reported with the status and the address', async () => {
    stubFetch(new Response('nope', { status: 404 }));
    render(<PassphraseSigner keyFileUrl={KEY_FILE_URL} registration={body()} />);
    await unlock();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('404');
    expect(alert).toHaveTextContent(KEY_FILE_URL);
  });

  it('a network failure is reported with the cause', async () => {
    stubFetch(new Error('connect ECONNREFUSED'));
    render(<PassphraseSigner keyFileUrl={KEY_FILE_URL} registration={body()} />);
    await unlock();
    expect(await screen.findByRole('alert')).toHaveTextContent('ECONNREFUSED');
  });

  it('refuses an empty passphrase before reading the key file', async () => {
    const fetchMock = stubFetch(new Response(keyFile, { status: 200 }));
    render(<PassphraseSigner keyFileUrl={KEY_FILE_URL} registration={body()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter the admin passphrase');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('"Lock now" locks: the signing button goes away and the passphrase is asked again', async () => {
    render(<PassphraseSigner keyFileUrl={KEY_FILE_URL} registration={body()} unlockSeconds={300} />);
    await unlock();
    await screen.findByRole('button', { name: 'Sign' });
    await userEvent.click(screen.getByRole('button', { name: 'Lock now' }));
    expect(screen.queryByRole('button', { name: 'Sign' })).toBeNull();
    expect(screen.getByLabelText('Admin passphrase')).toBeInTheDocument();
  }, 120_000);

  it('locks itself when the unlock time runs out', async () => {
    render(<PassphraseSigner keyFileUrl={KEY_FILE_URL} registration={body()} unlockSeconds={0.3} />);
    await unlock();
    await waitFor(() => expect(screen.getByLabelText('Admin passphrase')).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.queryByRole('button', { name: 'Sign' })).toBeNull();
  }, 120_000);

  it('locks on unmount (page change)', async () => {
    const onUnlocked = vi.fn();
    const { unmount } = render(<PassphraseSigner keyFileUrl={KEY_FILE_URL} registration={body()} onUnlocked={onUnlocked} unlockSeconds={300} />);
    await unlock();
    await screen.findByRole('button', { name: 'Sign' });
    const { isLocked } = onUnlocked.mock.calls[0]![0] as { isLocked: () => boolean };
    expect(isLocked()).toBe(false);
    unmount();
    expect(isLocked()).toBe(true);
  }, 120_000);

  it('rejects a body machine-webcrypto refuses, naming the field, and calls nothing', async () => {
    const onSigned = vi.fn();
    render(<PassphraseSigner keyFileUrl={KEY_FILE_URL} registration={{ ...body(), name: '!!' }} onSigned={onSigned} unlockSeconds={300} />);
    await unlock();
    await userEvent.click(await screen.findByRole('button', { name: 'Sign' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('registration: name');
    expect(onSigned).not.toHaveBeenCalled();
  }, 120_000);
});
