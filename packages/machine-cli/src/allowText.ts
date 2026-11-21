import {
  describeLimits,
  describeType,
  entryFromText,
  entryText,
  isTyped,
  parseLifetime,
  parseTemplate,
  TemplateError,
  templateExamples,
  type LifetimeInput,
  type Platform,
  type PolicyEntry,
  type Shell,
} from '@wadeck-app/machine-core';

// How an allow-list entry is built from what the owner typed and shown back to the owner: one place for `machine admin allow`,
// `machine policy allow`, `machine allowed` and `machine policy allow --list`.

/** The platform a shell implies, for the examples shown before signing (the target checks with its own platform when it runs). */
export const platformOfShell = (shell: Shell): Platform => (shell === 'cmd' || shell === 'ps' ? 'windows' : 'posix');

/** The entry text as shown: JSON-escaped (nothing hides in it), the tag `typed`, the lifetime when limited, the calls left when the counter is known. */
export function entryDescription(entry: PolicyEntry, now: number, used?: number): string {
  const limited = entry.limits !== undefined && (entry.limits.maxCalls !== undefined || entry.limits.expiresAt !== undefined);
  return `${JSON.stringify(entryText(entry))}${isTyped(entry) ? '  [typed]' : ''}${limited ? `  (${describeLimits(entry.limits, now, used)})` : ''}`;
}

export const entryLine = (entry: PolicyEntry, now: number, used?: number): string => `${entry.shell}  ${entryDescription(entry, now, used)}`;

/**
 * The entry of a signing request: an exact entry, or a typed one when the text holds a placeholder, with the lifetime of --times, --for or
 * --until. Every refusal names the cause, the fix, and that nothing was signed.
 */
export function buildAllowEntry(text: string, shell: Shell, flags: LifetimeInput, now: number): PolicyEntry {
  try {
    return entryFromText(text, shell, parseLifetime(flags, now));
  } catch (e) {
    if (e instanceof TemplateError) {
      throw new Error(`${e.detail}. Nothing was signed`);
    }
    if (e instanceof Error) {
      // The lifetime flags (parseLifetime) throw plain errors that already name the flag: they are wrapped with the same closing sentence.
      // violations-suppress: ts/no-err-message-direct the message of a plain Error is the text to wrap, there is no typed field for it
      throw new Error(`${e.message}. Nothing was signed`);
    }
    throw e;
  }
}

/** What the owner reads before the passphrase for a typed entry (R10): the template, each placeholder, the lifetime, the examples. Empty for an exact entry. */
export function typedSummary(entry: PolicyEntry, now: number): string[] {
  if (!isTyped(entry)) {
    return [];
  }
  const template = parseTemplate(entry.template, entry.shell);
  const platform = platformOfShell(entry.shell);
  const examples = templateExamples(template, platform);
  const lifetime = describeLimits(entry.limits, now);
  return [
    `Typed entry (shell ${entry.shell}): ${JSON.stringify(entry.template)}`,
    ...template.tokens.flatMap((t) => (t.kind === 'placeholder' ? [`  ${t.label}: ${describeType(t.spec)}`] : [])),
    `  lifetime: ${lifetime}`,
    ...examples.accepted.map((l) => `  accepted: ${l}`),
    ...examples.refused.map((l) => `  refused: ${l}`),
    '  These examples come from the same validator as the one that runs on the target. They are a sanity check, not a safeguard: read the template and its bounds.',
  ];
}

/** "limits updated" for an entry that existed with other limits. */
export function renewalLines(renewed: Array<{ before: PolicyEntry; after: PolicyEntry }>, now: number): string[] {
  return renewed.map(({ before, after }) => `  ~ limits updated: ${JSON.stringify(entryText(after))} (${describeLimits(before.limits, now)} -> ${describeLimits(after.limits, now)})`);
}

/** The default entries with limits that a new per-peer list did not copy: the peer loses them. */
export function leftOutLines(leftOut: PolicyEntry[], peerName: string, now: number): string[] {
  if (leftOut.length === 0) {
    return [];
  }
  return [
    `[warn] "${peerName}" had no list of its own and ${leftOut.length} default entr${leftOut.length === 1 ? 'y' : 'ies'} with limits ${leftOut.length === 1 ? 'was' : 'were'} NOT copied (a call counter belongs to the default list): "${peerName}" loses ${leftOut.length === 1 ? 'it' : 'them'}. Allow ${leftOut.length === 1 ? 'it' : 'each'} for this peer again if it must keep ${leftOut.length === 1 ? 'it' : 'them'}:`,
    ...leftOut.map((e) => `    ${entryLine(e, now)}`),
  ];
}
