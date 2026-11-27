import { candidacyCode, finalCode } from '@wadeck-app/machine-webcrypto';

// Approve from the page, lot 1 (admin-ui.md): the codes are recomputed HERE from the key and random as received (T-05, hard rule 5), never taken from relay text.
// The backend also recomputes the candidacy code; a difference between the two means the answer was altered on its way to the page.

export interface CandidacyProofInput {
  /** Candidate key and random as the list route carries them; absent when the backend could not compute a code from them. */
  identityPublicKey: string | undefined;
  random: string | undefined;
  /** The candidacy code the backend recomputed. */
  listedCode: string | undefined;
  /** Public key of the admin key that signs (read from the encrypted key file, which carries it in clear). */
  adminPublicKey: string;
}

export interface CandidacyProof {
  candidacyCode: string;
  finalCode: string;
}

const normalize = (code: string): string => code.toUpperCase().replace(/[\s-]/g, '');

export async function proveCandidacy(input: CandidacyProofInput): Promise<CandidacyProof> {
  const { identityPublicKey, random, listedCode, adminPublicKey } = input;
  if (identityPublicKey === undefined || random === undefined) {
    throw new Error('this candidacy carries no usable key or random (the list says why): it cannot be approved. Reject it, and ask the candidate to run `machine join --resume`');
  }
  if (listedCode === undefined) {
    throw new Error('the list carries no code to cross-check the key and random against: nothing is signed. Reload the page; if it persists, reject this candidacy');
  }
  let recomputed: string;
  try {
    recomputed = await candidacyCode(identityPublicKey, random);
  } catch (e) {
    throw new Error(`the candidacy code cannot be computed from its key and random (${(e as Error).message}): nothing is signed. Reject this candidacy`);
  }
  if (normalize(recomputed) !== normalize(listedCode)) {
    throw new Error('the code computed in this page does not match the one of the list: the answer was altered or the relay swapped the key. Nothing is signed. Reload the page; if it persists, Reject this candidacy');
  }
  let final: string;
  try {
    final = await finalCode(identityPublicKey, adminPublicKey, random);
  } catch (e) {
    throw new Error(`the security code cannot be computed (admin public key: ${(e as Error).message}): the admin key file is not usable. Restore the key file of \`machine admin init\`, or run \`machine admin approve\` instead`);
  }
  return { candidacyCode: recomputed, finalCode: final };
}
