import {
  parseInputDeclaration,
  describeInput,
  describeLimits,
  describeType,
  entryFromText,
  entryText,
  isTyped,
  parseLifetime,
  parseTemplate,
  TemplateError,
  templateExamples,
  type InputDeclaration,
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
  // The input an entry accepts is part of what it authorizes (decision 114): shown next to the command, wherever the entry is listed.
  const input = entry.input !== undefined ? `  [${describeInput(entry.input)}]` : '';
  return `${JSON.stringify(entryText(entry))}${isTyped(entry) ? '  [typed]' : ''}${input}${limited ? `  (${describeLimits(entry.limits, now, used)})` : ''}`;
}

export const entryLine = (entry: PolicyEntry, now: number, used?: number): string => `${entry.shell}  ${entryDescription(entry, now, used)}`;

/**
 * The entry of a signing request: an exact entry, or a typed one when the text holds a placeholder, with the lifetime of --times, --for or
 * --until. Every refusal names the cause, the fix, and that nothing was signed.
 */
export function buildAllowEntry(text: string, shell: Shell, flags: LifetimeInput, now: number, input?: InputDeclaration): PolicyEntry {
  try {
    const entry = entryFromText(text, shell, parseLifetime(flags, now));
    return input === undefined ? entry : { ...entry, input: { format: input.format, maxBytes: input.maxBytes, chars: [...input.chars] } };
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

/** "limits updated" for an entry that existed with other limits; "renews" for the Allow of a renewal (`--renew`, the generation went up: the counter starts again). */
export function renewalLines(renewed: Array<{ before: PolicyEntry; after: PolicyEntry }>, now: number): string[] {
  return renewed.map(({ before, after }) =>
    after.limits?.renewals !== undefined
      ? `  ~ renews ${JSON.stringify(entryText(after))}: ${describeLimits(before.limits, now)} -> ${describeLimits(after.limits, now)} (the counter starts again)`
      : `  ~ limits updated: ${JSON.stringify(entryText(after))} (${describeLimits(before.limits, now)} -> ${describeLimits(after.limits, now)})`,
  );
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

/**
 * What the owner reads before the passphrase for an entry that accepts an input (decision 114): what the payload may be, and what it can never be. `added`: the
 * families the format needed that were not typed (said, never silent).
 */
export function inputSummary(input: InputDeclaration, added: readonly string[]): string[] {
  const lines = [
    `Input on stdin: ${describeInput(input)}`,
    '  The payload is DATA: it is written to the stdin of the command and nowhere else (never its command line, its environment, a shell or a log); the audit log keeps its size and SHA-256 only.',
    `  Every character must be in the union above (a whitelist); NUL, the other control characters except the line feed, and bidirectional controls are always refused.${input.format === 'json' ? ' It must parse as strict JSON (nesting at most 32, no duplicate key, no __proto__, constructor or prototype key); the fields themselves are the command\'s to validate.' : ''}`,
  ];
  if (added.length > 0) {
    lines.push(`  [info] --stdin json implies the "${added.join('+')}" family (the structure characters of JSON): added to the union.`);
  }
  if (input.chars.includes('utf8-text')) {
    lines.push('  [warn] utf8-text allows ANY text (quotes, shell characters, accents, line feeds): it is safe only because the payload goes to stdin and nowhere else; the command must treat it as data and never build a command line from it.');
  }
  lines.push('  This policy is version 3: a target that is not up to date refuses it by name (machine cli update there).');
  return lines;
}

/** The input an entry declares from `--stdin text|json --stdin-max <n>k --stdin-chars <families>` (decision 114), or undefined. Throws InputDeclarationError with the fix. */
export function inputOf(args: { stdin?: string; stdinMax?: string; stdinChars?: string }): { declaration: InputDeclaration; added: string[] } | undefined {
  if (args.stdin === undefined) return undefined;
  return parseInputDeclaration({ format: args.stdin, ...(args.stdinMax !== undefined ? { max: args.stdinMax } : {}), ...(args.stdinChars !== undefined ? { chars: args.stdinChars } : {}) });
}
