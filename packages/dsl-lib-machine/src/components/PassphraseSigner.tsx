import React, { useCallback, useEffect, useRef, useState } from 'react';
import { signRegistration, unlockAdminKey, type UnlockedAdminKey } from '@wadeck-app/machine-webcrypto';
import { ButtonAction } from '@wadeck-app/dsl-ui';
import { INPUT, TEXT_ERROR } from '../lib/styleTokens.js';

// Where the secrets live (decision D25): the passphrase only in the input element, read at submit and cleared at once; the
// unlocked key only in a ref, as a NON-EXTRACTABLE CryptoKey. Neither goes through $setVar, $publishOutput, a URL, a prop
// callback or an Error message. onUnlocked hands over the public key id and an isLocked probe, never the key.

type RegistrationBody = Parameters<typeof signRegistration>[0];
type SignedRegistration = Awaited<ReturnType<typeof signRegistration>>;

export interface PassphraseSignerProps {
  /** Where the encrypted admin key file is read (GET). The file is encrypted: it is not a secret by itself. */
  keyFileUrl: string;
  /** The registration to sign once unlocked. */
  registration: RegistrationBody;
  /** How long the key stays unlocked, in seconds (default 300). */
  unlockSeconds?: number;
  /** Called with the signed registration. Signing never leaves the page: posting the result is the caller's job. */
  onSigned?: (signed: SignedRegistration) => void;
  /** Called after an unlock, with the public identity of the key and a probe of its lock state. */
  onUnlocked?: (info: { keyId: string; publicKey: string; isLocked: () => boolean }) => void;
}

const DEFAULT_UNLOCK_SECONDS = 300;

async function readKeyFile(url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (e) {
    throw new Error(`Cannot read the admin key file at ${url}: ${(e as Error).message}. Check that the machine daemon and app-core are running.`);
  }
  if (!response.ok) {
    throw new Error(`Cannot read the admin key file at ${url}: the server answered ${response.status}. Check that this machine holds the admin key (machine admin init) and that the module is up to date.`);
  }
  return response.text();
}

/**
 * Unlocks the admin key with a passphrase typed in the page and signs a registration with it, in the browser.
 * The key is wiped on "Lock now", when the unlock time runs out and when the component unmounts.
 *
 * @registryCategory composite
 * @registryTags passphrase signing admin
 */
export function PassphraseSigner({ keyFileUrl, registration, unlockSeconds = DEFAULT_UNLOCK_SECONDS, onSigned, onUnlocked }: PassphraseSignerProps) {
  const passphraseInput = useRef<HTMLInputElement>(null);
  const keyRef = useRef<UnlockedAdminKey | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lock = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
    }
    timer.current = null;
    keyRef.current?.lock();
    keyRef.current = null;
    setUnlocked(false);
  }, []);

  // Tab close and page change: the key is dropped with the component.
  useEffect(() => lock, [lock]);

  const unlock = async () => {
    const passphrase = passphraseInput.current?.value ?? '';
    if (passphrase === '') {
      setError('Enter the admin passphrase to unlock the key.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const file = await readKeyFile(keyFileUrl);
      const key = await unlockAdminKey(file, passphrase, { extractable: false });
      keyRef.current = key;
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
      timer.current = setTimeout(lock, unlockSeconds * 1000);
      setUnlocked(true);
      onUnlocked?.({ keyId: key.keyId, publicKey: key.publicKey, isLocked: () => key.isLocked() });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (passphraseInput.current) {
        passphraseInput.current.value = '';
      }
      setBusy(false);
    }
  };

  const sign = async () => {
    const key = keyRef.current;
    if (key === null) {
      setError('The admin key is locked: unlock it with the passphrase first.');
      return;
    }
    setError(null);
    try {
      onSigned?.(await signRegistration(registration, key.privateKey));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {unlocked ? (
        <div className="flex gap-2">
          <ButtonAction label="Sign" variant="primary" onClick={sign} />
          <ButtonAction label="Lock now" variant="secondary" onClick={lock} />
        </div>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={e => {
            e.preventDefault();
            void unlock();
          }}
        >
          <label className="flex flex-col gap-1 text-sm">
            Admin passphrase
            {/* violations-suppress: react/no-raw-input the passphrase must live only in this uncontrolled element (read and emptied at submit); FieldText keeps its value in React state, which the passphrase rule forbids */}
            <input ref={passphraseInput} type="password" name="machine-admin-passphrase" id="machine-admin-passphrase" autoComplete="new-password" data-1p-ignore data-lpignore="true" data-bwignore="true" className={INPUT} />
          </label>
          <div>
            <ButtonAction type="submit" label={busy ? 'Unlocking...' : 'Unlock'} variant="primary" disabled={busy} />
          </div>
        </form>
      )}
      {error !== null && <div role="alert" className={TEXT_ERROR}>{error}</div>}
    </div>
  );
}
