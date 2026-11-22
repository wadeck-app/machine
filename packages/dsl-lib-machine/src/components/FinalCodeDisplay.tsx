import React, { useEffect, useState } from 'react';
import { finalCode } from '@wadeck-app/machine-webcrypto';
import { MONO_STYLE } from '../lib/styleTokens.js';

export interface FinalCodeDisplayProps {
  /** Candidate identity public key, unpadded base64url. */
  candidatePublicKey: string;
  /** Public key of the admin key that signs the registration, unpadded base64url. */
  adminPublicKey: string;
  /** The candidacy random, unpadded base64url (16 bytes). */
  random: string;
  /** Called once the admin has ticked that both machines show the same code and pressed the button. */
  onConfirm?: () => void;
}

type Computed = { state: 'pending' } | { state: 'ready'; code: string } | { state: 'error'; message: string };

/**
 * The security code (decision 55: the final code, 25 digits in five groups), recomputed in the page, to compare with the code shown on the candidate machine before
 * the candidate pins the admin key. Only public values are involved.
 *
 * @registryCategory atomic
 * @registryTags verification code enrollment
 */
export function FinalCodeDisplay({ candidatePublicKey, adminPublicKey, random, onConfirm }: FinalCodeDisplayProps) {
  const [computed, setComputed] = useState<Computed>({ state: 'pending' });
  const [same, setSame] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setComputed({ state: 'pending' });
    setSame(false);
    finalCode(candidatePublicKey, adminPublicKey, random).then(
      code => {
        if (!cancelled) setComputed({ state: 'ready', code });
      },
      (e: unknown) => {
        if (!cancelled) {
          setComputed({
            state: 'error',
            message: `Cannot compute the security code: ${(e as Error).message}. Reload the candidacy list; if it persists the relay sent a malformed candidacy, reject it.`,
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [candidatePublicKey, adminPublicKey, random]);

  if (computed.state === 'error') {
    return <div role="alert" className="text-sm text-red-700">{computed.message}</div>;
  }
  if (computed.state === 'pending') {
    return <div className="text-sm text-gray-500">Computing the security code...</div>;
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">Compare this security code with the one shown on the candidate machine: it must read exactly the same.</p>
      <div aria-label="Security code" role="group" style={MONO_STYLE} className="text-2xl tracking-widest">
        {computed.code}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={same} onChange={e => setSame(e.target.checked)} />
        Both machines show the same code
      </label>
      <button
        type="button"
        disabled={!same}
        onClick={() => onConfirm?.()}
        className="self-start rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50"
      >
        Codes match, continue
      </button>
    </div>
  );
}
