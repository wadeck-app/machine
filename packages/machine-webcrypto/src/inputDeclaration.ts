// The declaration of an allow entry that accepts a payload on stdin (stdin-input.md, decision 114). Pure, no Node import: the browser copy
// (machine-webcrypto) is byte for byte this file, checked by a test.

export const INPUT_FORMATS = ['text', 'json'] as const;
export type InputFormat = (typeof INPUT_FORMATS)[number];

/** First release: 64 KiB when `--stdin-max` is not given. */
export const INPUT_DEFAULT_MAX_BYTES = 64 * 1024;
/**
 * The hard ceiling of one payload (decision 114, binding). It is checked against the transport frame of 1 MiB: the payload travels base64
 * encoded in the same frame as the signed request (4/3 of 512 KiB is 683 KiB), see `inputFrame.test.ts` of machine-cli.
 */
export const INPUT_MAX_BYTES_CEILING = 512 * 1024;

/**
 * The names a declaration may use, in the canonical order (a declaration lists them in this order, so that two spellings of one union are one
 * document). Characters outside the table are never allowed by name: they need `utf8-text`.
 */
export const INPUT_CHAR_NAMES = [
  'letters',
  'digits',
  'space',
  'punct',
  'slash',
  'backslash',
  'dquote',
  'squote',
  'backquote',
  'semicolon',
  'ampersand',
  'pipe',
  'dollar',
  'lt',
  'gt',
  'at',
  'hash',
  'percent',
  'star',
  'plus',
  'equal',
  'tilde',
  'caret',
  'brace-open',
  'brace-close',
  'bracket-open',
  'bracket-close',
  'json',
  'utf8-text',
] as const;
export type InputCharName = (typeof INPUT_CHAR_NAMES)[number];

export interface InputDeclaration {
  format: InputFormat;
  /** At most INPUT_MAX_BYTES_CEILING. */
  maxBytes: number;
  /** A whitelist, as a union of the names above, in canonical order. */
  chars: InputCharName[];
}

export class InputDeclarationError extends Error {}

const NAMES: readonly string[] = INPUT_CHAR_NAMES;
const FIX_SIZE = 'give --stdin-max as KiB with a k (64k, at most 512k) or as a number of bytes';

/** `64k` (KiB) or a plain number of bytes, 1 to the ceiling. */
export function parseInputSize(text: string): number {
  const m = /^([0-9]{1,7})(k?)$/.exec(text);
  if (m === null) {
    throw new InputDeclarationError(`--stdin-max "${text}" is not a size: ${FIX_SIZE}`);
  }
  const bytes = Number(m[1]) * (m[2] === 'k' ? 1024 : 1);
  if (bytes < 1) {
    throw new InputDeclarationError(`--stdin-max "${text}" must be at least 1 byte: ${FIX_SIZE}`);
  }
  if (bytes > INPUT_MAX_BYTES_CEILING) {
    throw new InputDeclarationError(`--stdin-max "${text}" is above the protocol ceiling of ${INPUT_MAX_BYTES_CEILING / 1024}k (${INPUT_MAX_BYTES_CEILING} bytes): ${FIX_SIZE}`);
  }
  return bytes;
}

/** The union typed with `+`, validated and put in canonical order. */
export function parseInputChars(text: string): InputCharName[] {
  const given = text.split('+').filter((p) => p.length > 0);
  if (given.length === 0) {
    throw new InputDeclarationError(`--stdin-chars is empty: write the families that may appear, for example letters+digits+space (the whole list: machine admin allow --help)`);
  }
  const seen = new Set<string>();
  for (const name of given) {
    if (!NAMES.includes(name)) {
      throw new InputDeclarationError(`--stdin-chars: "${name}" is not a family (letters, digits, space, punct, explicit characters such as slash or dquote, json, utf8-text; xml is not built): see \`machine admin allow --help\``);
    }
    if (seen.has(name)) {
      throw new InputDeclarationError(`--stdin-chars: "${name}" is written twice: write each family once`);
    }
    seen.add(name);
  }
  const chars = INPUT_CHAR_NAMES.filter((n) => seen.has(n));
  checkWholeText(chars, '--stdin-chars');
  return chars;
}

function checkWholeText(chars: readonly string[], what: string): void {
  if (chars.includes('utf8-text') && chars.some((c) => c !== 'utf8-text' && c !== 'json')) {
    throw new InputDeclarationError(`${what}: utf8-text allows every text character, so it cannot be combined with narrower families (it would read as a restriction it is not): it stands alone, or with json`);
  }
}

export interface InputFlags {
  format: string;
  max?: string;
  chars?: string;
}

/** What `--stdin <format> [--stdin-max <n>k] --stdin-chars <families>` mean. `added`: families added because the format needs them (said to the owner). */
export function parseInputDeclaration(flags: InputFlags): { declaration: InputDeclaration; added: InputCharName[] } {
  if (!(INPUT_FORMATS as readonly string[]).includes(flags.format)) {
    throw new InputDeclarationError(`--stdin "${flags.format}": the format is text or json (xml is not built)`);
  }
  const format = flags.format as InputFormat;
  if (flags.chars === undefined) {
    throw new InputDeclarationError('--stdin needs --stdin-chars <families>: the characters the payload may contain are a whitelist you choose, there is no implicit set (letters+digits+space is a start; utf8-text allows any text; the list: machine admin allow --help)');
  }
  const chars = parseInputChars(flags.chars);
  const added: InputCharName[] = [];
  if (format === 'text' && chars.includes('json')) {
    throw new InputDeclarationError('--stdin-chars: the json family belongs to --stdin json (it implies the structure characters and the payload must parse as JSON): use --stdin json, or name the characters you need (dquote, brace-open, ...)');
  }
  let list: InputCharName[] = chars;
  if (format === 'json' && !chars.includes('json')) {
    list = INPUT_CHAR_NAMES.filter((n) => n === 'json' || chars.includes(n));
    added.push('json');
  }
  return { declaration: { format, maxBytes: flags.max === undefined ? INPUT_DEFAULT_MAX_BYTES : parseInputSize(flags.max), chars: list }, added };
}

/** Validates the `input` field of a policy entry (the signed form): exact keys, bounds, canonical order. Throws with the list named. */
export function assertInputDeclaration(value: unknown, where: string): asserts value is InputDeclaration {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InputDeclarationError(`policy: input of an entry of ${where} must be an object`);
  }
  const r = value as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (key !== 'format' && key !== 'maxBytes' && key !== 'chars') {
      throw new InputDeclarationError(`policy: unknown field "${key}" in the input of an entry of ${where}`);
    }
  }
  if (!(INPUT_FORMATS as readonly unknown[]).includes(r.format)) {
    throw new InputDeclarationError(`policy: input.format of an entry of ${where} must be one of ${INPUT_FORMATS.join(', ')} (got ${String(r.format)})`);
  }
  if (typeof r.maxBytes !== 'number' || !Number.isSafeInteger(r.maxBytes) || r.maxBytes < 1 || r.maxBytes > INPUT_MAX_BYTES_CEILING) {
    throw new InputDeclarationError(`policy: input.maxBytes of an entry of ${where} must be a whole number of bytes from 1 to ${INPUT_MAX_BYTES_CEILING}`);
  }
  if (!Array.isArray(r.chars) || r.chars.length === 0) {
    throw new InputDeclarationError(`policy: input.chars of an entry of ${where} must list at least one family`);
  }
  for (const name of r.chars as unknown[]) {
    if (typeof name !== 'string' || !NAMES.includes(name)) {
      throw new InputDeclarationError(`policy: input.chars of an entry of ${where} holds "${String(name)}", which is not a family`);
    }
  }
  const chars = r.chars as string[];
  if (new Set(chars).size !== chars.length) {
    throw new InputDeclarationError(`policy: input.chars of an entry of ${where} names a family twice`);
  }
  if (INPUT_CHAR_NAMES.filter((n) => chars.includes(n)).join('+') !== chars.join('+')) {
    throw new InputDeclarationError(`policy: input.chars of an entry of ${where} is not in the canonical order (${INPUT_CHAR_NAMES.join(', ')})`);
  }
  if (r.format === 'json' && !chars.includes('json')) {
    throw new InputDeclarationError(`policy: input of an entry of ${where} has format json but no json family in chars`);
  }
  if (r.format === 'text' && chars.includes('json')) {
    throw new InputDeclarationError(`policy: input of an entry of ${where} has format text but the json family in chars (it belongs to format json)`);
  }
  checkWholeText(chars, `policy: input.chars of an entry of ${where}`);
}

/** True when two declarations (or none) authorize the same payloads. */
export function inputEqual(a: InputDeclaration | undefined, b: InputDeclaration | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.format === b.format && a.maxBytes === b.maxBytes && a.chars.join('+') === b.chars.join('+');
}

/** `stdin: json, letters+digits+space+json, up to 64 KiB`: what every surface shows next to the command (D2). */
export function describeInput(input: InputDeclaration): string {
  const size = input.maxBytes % 1024 === 0 ? `${input.maxBytes / 1024} KiB` : `${input.maxBytes} bytes`;
  return `stdin: ${input.format}, ${input.chars.join('+')}, up to ${size}`;
}
