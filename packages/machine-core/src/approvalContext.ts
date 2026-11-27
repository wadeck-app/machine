// Seal contexts of the enrollment by candidacy (decisions 22, 78). Pure strings, shared by the CLI, the daemon and (as a tested copy) machine-webcrypto,
// so the admin side that seals and the machine that opens never disagree on the purpose a sealed value is bound to.

export interface SealContextParts {
  adminUuid: string | null;
  candidateUuid: string;
  /** The random of the candidacy this approval answers. */
  random: string;
  /** `self`, or `peer:<uuid of the peer>`: a sealed value cannot be moved to another entry. */
  slot: string;
}

/** The purpose a pair secret is sealed for: one admin machine, one candidate, one candidacy, one entry of the approval. */
export function pairSecretContext(parts: SealContextParts): string {
  return `pair-secret:${parts.adminUuid ?? 'none'}:${parts.candidateUuid}:${parts.random}:${parts.slot}`;
}

/** The purpose an approval is sealed for: this candidate machine and this candidacy. A sealed approval opens nowhere else. */
export function approvalSealContext(candidateUuid: string, random: string): string {
  return `approval:v2:${candidateUuid}:${random}`;
}

/**
 * The purpose the pair secret of a candidate is sealed for when the admin page hands it to the admin machine (the daemon command that makes the admin
 * machine trust the candidate): this admin machine, this candidate, this candidacy. It opens nowhere else and is not a pair-secret context of an approval.
 */
export function importCandidateSealContext(adminUuid: string, candidateUuid: string, random: string): string {
  return `import-candidate:v1:${adminUuid}:${candidateUuid}:${random}`;
}
