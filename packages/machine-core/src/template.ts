import { canonicalType, checkValue, parseTypeSpec, sampleValues, TemplateError, type Platform, type TypeSpec } from './typedParams.js';

// The entry grammar of typed-parameters.md. Pure, no I/O; copied byte for byte into machine-webcrypto (a test keeps the copies identical).
//
// An entry text is exact (any printable ASCII, compared byte for byte, written by the admin) or typed: space-separated tokens, each one of
//   fixed word          orch, --tail, -n                     (whitelist of characters below)
//   placeholder         <n:int(1,500)>                       (the whole token)
//   prefix placeholder  --tail=<n:int(1,500)>                (a fixed word, `=`, then one placeholder)
// Every angle bracket must belong to a complete placeholder: otherwise the entry is refused, never read as an exact one.

export const MAX_TEXT = 2048;
export const MAX_PLACEHOLDERS = 8;

type EntryShell = 'cmd' | 'ps' | 'bash' | 'sh';

const ALPHANUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
/** Whitelist of a fixed word. */
const FIXED_CHARS = `${ALPHANUM}._/:@+-`;
/** Whitelist of the inside of a placeholder (label, colon, type text). */
const PLACEHOLDER_CHARS = `${ALPHANUM}_:(),|.@+=/-`;
const LABEL_FIRST = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LABEL_CHARS = `${ALPHANUM}_`;
const LABEL_MAX = 32;

export type Token = { kind: 'word'; text: string } | { kind: 'placeholder'; label: string; spec: TypeSpec; prefix?: string };

export interface Template {
  /** The text exactly as written and signed. */
  text: string;
  tokens: Token[];
  placeholders: number;
}

export type EntryText = { kind: 'exact'; command: string } | { kind: 'typed'; template: Template };

export type TemplateMatch = { ok: true } | { ok: false; tokenIndex?: number; rule: string };

const allIn = (text: string, allowed: string): boolean => {
  if (text.length === 0) {
    return false;
  }
  for (const c of text) if (!allowed.includes(c)) return false;
  return true;
};

/** True when the text holds an angle bracket: then it must parse as a typed entry. */
export const hasAngleBracket = (text: string): boolean => text.includes('<') || text.includes('>');

/**
 * True when the text holds the shape `<...:...>` of a placeholder. A version 1 policy (exact entries only) must not hold one: a reader that
 * knows typed entries would otherwise read as exact what its signer may have meant as typed.
 */
export function looksLikePlaceholder(text: string): boolean {
  let from = 0;
  for (;;) {
    const open = text.indexOf('<', from);
    if (open < 0) {
      return false;
    }
    const close = text.indexOf('>', open + 1);
    if (close < 0) {
      return false;
    }
    if (text.slice(open + 1, close).includes(':')) {
      return true;
    }
    from = open + 1;
  }
}

function parsePlaceholder(text: string, at: number, shell: EntryShell, prefix?: string): Token {
  const where = `token ${at + 1}`;
  const notComplete = `${where} is not a complete placeholder <label:type> (a placeholder is a whole token, holds no space, and uses only letters, digits and _ : ( ) , | . @ + = / -)`;
  if (!text.startsWith('<') || !text.endsWith('>') || text.length < 2) {
    throw new TemplateError(notComplete);
  }
  const inner = text.slice(1, -1);
  if (inner.length === 0) {
    throw new TemplateError(`${where}: a placeholder needs a label and a type: <label:type>`);
  }
  if (!allIn(inner, PLACEHOLDER_CHARS)) {
    throw new TemplateError(notComplete);
  }
  const colon = inner.indexOf(':');
  if (colon < 0) {
    throw new TemplateError(`${where}: a placeholder needs a label and a type: <label:type>`);
  }
  const label = inner.slice(0, colon);
  if (label.length === 0 || label.length > LABEL_MAX || !LABEL_FIRST.includes(label[0] as string) || !allIn(label, LABEL_CHARS)) {
    throw new TemplateError(`${where}: the label must be 1 to ${LABEL_MAX} characters, start with a letter and use letters, digits and _ only`);
  }
  let spec: TypeSpec;
  try {
    spec = parseTypeSpec(inner.slice(colon + 1));
  } catch (e) {
    if (e instanceof TemplateError) {
      throw new TemplateError(`${where}: ${e.detail}`);
    }
    throw e;
  }
  if (shell === 'ps' && spec.kind === 'enum' && spec.members.some((m) => m.includes('@'))) {
    throw new TemplateError(`${where}: an entry for the ps shell cannot hold an enum member with @ (PowerShell reads it as a splat)`);
  }
  return { kind: 'placeholder', label, spec, ...(prefix === undefined ? {} : { prefix }) };
}

function maxValueLength(spec: TypeSpec): number {
  switch (spec.kind) {
    case 'int':
      return String(spec.max).length;
    case 'duration':
      return 11;
    case 'name':
      return spec.max;
    case 'hexid':
      return spec.n;
    case 'uuid':
      return 36;
    case 'enum':
      return Math.max(...spec.members.map((m) => m.length));
  }
}

/** Parses a typed entry. Throws a TemplateError naming the token and the fix. Use `parseEntryText` when the text may be exact. */
export function parseTemplate(text: string, shell: EntryShell): Template {
  if (text.length === 0) {
    throw new TemplateError('the entry is empty');
  }
  if (text.length > MAX_TEXT) {
    throw new TemplateError(`the entry is longer than ${MAX_TEXT} characters`);
  }
  const parts = text.split(' ');
  const tokens: Token[] = [];
  let finalLength = parts.length - 1;
  parts.forEach((part, i) => {
    const where = `token ${i + 1}`;
    if (part.length === 0) {
      throw new TemplateError(`${where} is empty: remove the double, leading or trailing space`);
    }
    if (!hasAngleBracket(part)) {
      if (!allIn(part, FIXED_CHARS)) {
        throw new TemplateError(`${where} is not a valid fixed word: use only letters, digits and . _ / : @ + - (a typed entry is made of fixed words and <label:type> placeholders)`);
      }
      if (shell === 'ps' && part.includes('@')) {
        throw new TemplateError(`${where}: an entry for the ps shell cannot hold @ (PowerShell reads it as a splat)`);
      }
      tokens.push({ kind: 'word', text: part });
      finalLength += part.length;
      return;
    }
    if (i === 0) {
      throw new TemplateError('the program (first word) must be a fixed word: a placeholder cannot stand for it');
    }
    let token: Token;
    if (part.startsWith('<')) {
      token = parsePlaceholder(part, i, shell);
    } else {
      const eq = part.indexOf('=<');
      const prefix = eq < 0 ? '' : part.slice(0, eq);
      if (eq < 0 || !allIn(prefix, FIXED_CHARS) || (shell === 'ps' && prefix.includes('@'))) {
        throw new TemplateError(`${where} is not a complete placeholder: a flag prefix is a fixed word, then =, then one complete placeholder (--lines=<n:int(1,500)>)`);
      }
      token = parsePlaceholder(part.slice(eq + 1), i, shell, `${prefix}=`);
    }
    tokens.push(token);
    finalLength += (token.kind === 'placeholder' ? (token.prefix?.length ?? 0) + maxValueLength(token.spec) : 0);
  });
  const placeholders = tokens.filter((t) => t.kind === 'placeholder').length;
  if (placeholders === 0) {
    throw new TemplateError('the entry holds no placeholder: write it as an exact entry (no angle bracket)');
  }
  if (placeholders > MAX_PLACEHOLDERS) {
    throw new TemplateError(`an entry holds at most ${MAX_PLACEHOLDERS} placeholders (found ${placeholders})`);
  }
  if (finalLength > MAX_TEXT) {
    throw new TemplateError(`the final command line could reach ${finalLength} characters, above ${MAX_TEXT}: shorten the fixed words or the bounds`);
  }
  return { text, tokens, placeholders };
}

/**
 * The entry text of a signing request: exact when it holds no angle bracket, else it must parse completely as a typed entry
 * (an angle bracket that is not part of a complete placeholder is refused, it is never kept as an exact entry).
 */
export function parseEntryText(text: string, shell: EntryShell): EntryText {
  if (!hasAngleBracket(text)) {
    return { kind: 'exact', command: text };
  }
  try {
    return { kind: 'typed', template: parseTemplate(text, shell) };
  } catch (e) {
    if (e instanceof TemplateError) {
      throw new TemplateError(`${e.detail}. An angle bracket must belong to a complete placeholder <label:type>; to allow a command that needs one, there is no exact form (it would be read as a placeholder)`);
    }
    throw e;
  }
}

/** The text that identifies an entry whatever its labels: used for duplicate detection and renewal. */
export function canonicalEntry(shell: EntryShell, entry: EntryText): string {
  if (entry.kind === 'exact') {
    return `${shell}\u0000exact\u0000${entry.command}`;
  }
  const body = entry.template.tokens.map((t) => (t.kind === 'word' ? t.text : `${t.prefix ?? ''}<:${canonicalType(t.spec)}>`)).join(' ');
  return `${shell}\u0000typed\u0000${body}`;
}

/** Matches a command line against a template: same token count, fixed words equal, each value valid for its type. The refusal names the token and the rule only. */
export function matchTemplate(template: Template, command: string, platform: Platform): TemplateMatch {
  const parts = command.split(' ');
  if (parts.length !== template.tokens.length) {
    return { ok: false, rule: `the command has ${parts.length} word(s), the entry has ${template.tokens.length}` };
  }
  for (let i = 0; i < parts.length; i++) {
    const token = template.tokens[i] as Token;
    const part = parts[i] as string;
    if (token.kind === 'word') {
      if (part !== token.text) {
        return { ok: false, tokenIndex: i + 1, rule: 'fixed word differs' };
      }
      continue;
    }
    let value = part;
    if (token.prefix !== undefined) {
      if (!part.startsWith(token.prefix)) {
        return { ok: false, tokenIndex: i + 1, rule: 'flag prefix differs' };
      }
      value = part.slice(token.prefix.length);
    }
    const check = checkValue(token.spec, value, platform);
    if (!check.ok) {
      return { ok: false, tokenIndex: i + 1, rule: check.rule };
    }
  }
  return { ok: true };
}

/** Two accepted and two refused command lines, built from the samples of each type and confirmed by `matchTemplate` (the validator of the target). */
export function templateExamples(template: Template, platform: Platform): { accepted: string[]; refused: string[] } {
  const samples = template.tokens.map((t) => (t.kind === 'placeholder' ? sampleValues(t.spec, platform) : undefined));
  const slots = samples.flatMap((s, i) => (s === undefined ? [] : [i]));
  // `valueAt(i)` is the value written at placeholder `i`, or undefined when the type has no such sample.
  const build = (valueAt: (i: number) => string | undefined): string | undefined => {
    const out: string[] = [];
    for (let i = 0; i < template.tokens.length; i++) {
      const token = template.tokens[i] as Token;
      if (token.kind === 'word') {
        out.push(token.text);
        continue;
      }
      const value = valueAt(i);
      if (value === undefined) {
        return undefined;
      }
      out.push(`${token.prefix ?? ''}${value}`);
    }
    return out.join(' ');
  };
  const sample = (i: number) => samples[i] as { accepted: string[]; refused: string[] };
  const accepted = [0, 1].map((k) => build((i) => sample(i).accepted[k] ?? sample(i).accepted[0]));
  const first = slots[0] as number;
  const last = slots[slots.length - 1] as number;
  // One refused value at a time, every other placeholder keeps an accepted value: the line fails for exactly one reason.
  const refusedAt = (at: number, k: number) => build((i) => (i === at ? sample(i).refused[k] : sample(i).accepted[0]));
  const refused = [refusedAt(first, 0), first === last ? refusedAt(first, 1) : refusedAt(last, 0)];
  const keep = (lines: Array<string | undefined>, wanted: boolean): string[] => [...new Set(lines.filter((l): l is string => l !== undefined))].filter((l) => matchTemplate(template, l, platform).ok === wanted).slice(0, 2);
  return { accepted: keep(accepted, true), refused: keep(refused, false) };
}
