import React, { useEffect, useRef, useState } from 'react';
import { adminKeyHint, signRegistration, unlockAdminKey } from '@wadeck-app/machine-webcrypto';
import { ButtonAction } from '@wadeck-app/dsl-ui';
import { INPUT, TEXT_ERROR } from '../lib/styleTokens.js';
import { adminKeyHolder } from '../lib/adminKeyHolder.js';
import { KeepUnlockedSelect } from './KeepUnlockedSelect.js';
import { PassphraseHint } from './PassphraseHint.js';
import { UnlockedKeyBar } from './UnlockedKeyBar.js';
import { useAdminKey } from './useAdminKey.js';

// Where the secrets live (decision D25): the passphrase only in the input element, read at submit and cleared at once; the
// unlocked key only in the module-level holder (adminKeyHolder, decision 92), as a NON-EXTRACTABLE CryptoKey, shared with the Allow flows. Neither goes
// through $setVar, $publishOutput, a URL, a prop callback or an Error message. onUnlocked hands over the public key id and an isLocked probe, never the key.

type RegistrationBody = Parameters<typeof signRegistration>[0];
type SignedRegistration = Awaited<ReturnType<typeof signRegistration>>;

export interface PassphraseSignerProps {
  /** Where the encrypted admin key file is read (GET). The file is encrypted: it is not a secret by itself. */
  keyFileUrl: string;
  /** The registration to sign once unlocked. */
  registration: RegistrationBody;
  /** How long the key stays unlocked, in seconds. Absent: the person's choice "Keep unlocked for" (default 5 minutes; with "Ask every time", the key is locked right after the signature). */
  unlockSeconds?: number;
  /** Called with the signed registration. Signing never leaves the page: posting the result is the caller's job. */
  onSigned?: (signed: SignedRegistration) => void;
  /** Called after an unlock, with the public identity of the key and a probe of its lock state. */
  onUnlocked?: (info: { keyId: string; publicKey: string; isLocked: () => boolean }) => void;
}

/** "Ask every time" still needs the key between the Unlock and the Sign click of this component: it is kept this long, and locked after the signature. */
const ASK_WINDOW_MS = 5 * 60_000;

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
 * The key is wiped on "Lock now", when the idle time runs out and when the page goes. Unmounting the component does NOT lock it (decision 92).
 *
 * @registryCategory composite
 * @registryTags passphrase signing admin
 */
export function PassphraseSigner({ keyFileUrl, registration, unlockSeconds, onSigned, onUnlocked }: PassphraseSignerProps) {
  const passphraseInput = useRef<HTMLInputElement>(null);
  const { unlocked } = useAdminKey();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | undefined>(undefined);

  // The hint is stored in clear in the key file: shown before the passphrase is typed. A file that cannot be read says so now, not at the unlock.
  useEffect(() => {
    let cancelled = false;
    readKeyFile(keyFileUrl).then(
      (file) => {
        try {
          if (!cancelled) {
            setHint(adminKeyHint(file));
          }
        } catch (e) {
          if (!cancelled) {
            setError((e as Error).message);
          }
        }
      },
      (e: unknown) => {
        if (!cancelled) {
          setError((e as Error).message);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [keyFileUrl]);

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
      const ms = unlockSeconds !== undefined ? unlockSeconds * 1000 : adminKeyHolder.keepChoice() === 'ask' ? ASK_WINDOW_MS : undefined;
      adminKeyHolder.hold(key, ms === undefined ? {} : { ms });
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
    const key = adminKeyHolder.current();
    if (key === null) {
      setError('The admin key is locked: unlock it with the passphrase first.');
      return;
    }
    setError(null);
    try {
      const signed = await signRegistration(registration, key.privateKey);
      // A signature is a use: the idle time restarts. "Ask every time": the key does not outlive this signature.
      if (adminKeyHolder.keepChoice() === 'ask') {
        adminKeyHolder.lock();
      } else {
        adminKeyHolder.touch();
      }
      onSigned?.(signed);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {unlocked ? (
        <div className="flex flex-col gap-2">
          <UnlockedKeyBar />
          <div>
            <ButtonAction label="Sign" variant="primary" onClick={sign} />
          </div>
        </div>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={e => {
            e.preventDefault();
            void unlock();
          }}
        >
          {/* The browser saves a password under site + username: a fixed username makes this a login of its own, apart from the app-core PIN. */}
          {/* violations-suppress: react/no-raw-input a fixed, read-only username for the browser's password manager, not a user input */}
          <input type="text" name="machine-admin-username" autoComplete="username" value="machine-admin" readOnly tabIndex={-1} aria-hidden="true" className="sr-only" />
          <PassphraseHint hint={hint} />
          <label className="flex flex-col gap-1 text-sm">
            Admin passphrase
            {/* violations-suppress: react/no-raw-input the passphrase must live only in this uncontrolled element (read and emptied at submit); FieldText keeps its value in React state, which the passphrase rule forbids */}
            <input ref={passphraseInput} type="password" name="machine-admin-passphrase" id="machine-admin-passphrase" autoComplete="current-password" className={INPUT} />
          </label>
          <KeepUnlockedSelect busy={busy} />
          <div>
            <ButtonAction type="submit" label={busy ? 'Unlocking...' : 'Unlock'} variant="primary" disabled={busy} />
          </div>
        </form>
      )}
      {error !== null && <div role="alert" className={TEXT_ERROR}>{error}</div>}
    </div>
  );
}
