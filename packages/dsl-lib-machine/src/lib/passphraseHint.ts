// The hint the admin wrote when the key was created (decision 57). Stored in clear in the key file, so it is shown BEFORE the passphrase is typed;
// it is not a secret. It is the `helpText` of the standard passphrase field (small muted text under it, in aria-describedby): text only, never markup.
// No hint: no prop at all, so no empty element.

export function hintHelpText(hint: string | null | undefined): { helpText: string } | Record<string, never> {
  if (hint === undefined || hint === null || hint === '') {
    return {};
  }
  return { helpText: `Hint: ${hint}` };
}
