import { createHash } from 'node:crypto';
import { INPUT_CHAR_NAMES, type InputCharName, type InputDeclaration } from './inputDeclaration.js';

// The payload a caller sends on stdin and what the target accepts of it (stdin-input.md, decision 114). Pure functions on bytes: no I/O.
// The payload is DATA: it is validated here and then written to the pipe of the spawned process, nowhere else (R1).

/** Nesting of a JSON payload: the root container is depth 1. */
export const INPUT_MAX_JSON_DEPTH = 32;
/** What `machine requests` and the Allow dialog show of a held payload (T-42): the first 4 KiB, then the size and the hash. */
export const INPUT_DISPLAY_BYTES = 4096;

export type InputRefusal = 'input-too-large' | 'input-chars' | 'input-format';
export type InputCheck = { ok: true } | { ok: false; reason: InputRefusal; message: string };

/** The size and the SHA-256 of the payload (lowercase hex): what the signed request carries (R3) and what the audit log keeps (R4). */
export function inputDigest(payload: Uint8Array): { bytes: number; sha256: string } {
  return { bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') };
}

const PUNCT = new Set('.,:!?-_()');
const JSON_STRUCTURE = new Set('{}[]":,\\/');
const EXPLICIT: Record<string, string> = {
  slash: '/',
  backslash: '\\',
  dquote: '"',
  squote: "'",
  backquote: '`',
  semicolon: ';',
  ampersand: '&',
  pipe: '|',
  dollar: '$',
  lt: '<',
  gt: '>',
  at: '@',
  hash: '#',
  percent: '%',
  star: '*',
  plus: '+',
  equal: '=',
  tilde: '~',
  caret: '^',
  'brace-open': '{',
  'brace-close': '}',
  'bracket-open': '[',
  'bracket-close': ']',
};
const NAME_OF_CHAR = new Map(Object.entries(EXPLICIT).map(([name, ch]) => [ch, name]));
const LETTER = /^[\p{L}\p{M}]$/u;
const CONTROL = /^\p{Cc}$/u;

/** Bidirectional controls: they make text read in another order than it is stored (T-42). */
function isBidi(cp: number): boolean {
  return cp === 0x061c || cp === 0x200e || cp === 0x200f || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
}

/** Refused whatever the union: NUL and every other control character except the line feed, and the bidi controls. */
const alwaysRefused = (ch: string): boolean => (CONTROL.test(ch) && ch !== '\n') || isBidi(ch.codePointAt(0) as number);

function allowedBy(ch: string, union: ReadonlySet<InputCharName>): boolean {
  if (union.has('utf8-text')) {
    return true;
  }
  if (union.has('letters') && LETTER.test(ch)) {
    return true;
  }
  if (union.has('digits') && ch >= '0' && ch <= '9') {
    return true;
  }
  if (union.has('space') && (ch === ' ' || ch === '\n')) {
    return true;
  }
  if (union.has('punct') && PUNCT.has(ch)) {
    return true;
  }
  if (union.has('json') && JSON_STRUCTURE.has(ch)) {
    return true;
  }
  const name = NAME_OF_CHAR.get(ch);
  return name !== undefined && union.has(name as InputCharName);
}

/** The family that would allow a character, written for the fix of a refusal. */
function familyFor(ch: string): string {
  if (LETTER.test(ch)) return 'letters';
  if (ch >= '0' && ch <= '9') return 'digits';
  if (ch === ' ' || ch === '\n') return 'space';
  if (PUNCT.has(ch)) return 'punct';
  return NAME_OF_CHAR.get(ch) ?? 'utf8-text';
}

const hex4 = (cp: number): string => cp.toString(16).toUpperCase().padStart(4, '0');

/** Nesting, duplicate keys and prototype-pollution keys of a JSON text, found WITHOUT building the value (a bomb never reaches the parser). Lenient on grammar: JSON.parse judges that. */
function scanJson(text: string): string | undefined {
  const stack: Array<{ object: boolean; keys: Set<string>; expectKey: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        j += text[j] === '\\' ? 2 : 1;
      }
      if (j >= text.length) {
        return undefined;
      }
      const top = stack[stack.length - 1];
      if (top !== undefined && top.object && top.expectKey) {
        let key: unknown;
        try {
          key = JSON.parse(text.slice(i, j + 1));
        } catch {
          return undefined;
        }
        if (typeof key === 'string') {
          if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
            return `the key ${JSON.stringify(key)} is refused at any depth (prototype pollution of a receiving JavaScript command)`;
          }
          if (top.keys.has(key)) {
            return `the key ${JSON.stringify(key.length > 40 ? `${key.slice(0, 40)}...` : key)} appears twice in one object (parsers disagree on which one counts)`;
          }
          top.keys.add(key);
        }
        top.expectKey = false;
      }
      i = j + 1;
      continue;
    }
    if (c === '{' || c === '[') {
      stack.push({ object: c === '{', keys: new Set(), expectKey: c === '{' });
      if (stack.length > INPUT_MAX_JSON_DEPTH) {
        return `the nesting is deeper than ${INPUT_MAX_JSON_DEPTH} levels`;
      }
    } else if (c === '}' || c === ']') {
      stack.pop();
    } else if (c === ',') {
      const top = stack[stack.length - 1];
      if (top !== undefined && top.object) {
        top.expectKey = true;
      }
    }
    i += 1;
  }
  return undefined;
}

/**
 * What an entry that declares an input accepts (target check 2 and 3 of the spec): the size, UTF-8, the whitelist union, then the format. The
 * hash is the caller's of this function (it compares it with the signed one before). Messages never print the payload: a character is named by
 * its code point and its place.
 */
export function checkInputPayload(payload: Uint8Array, declaration: InputDeclaration): InputCheck {
  if (payload.length > declaration.maxBytes) {
    return { ok: false, reason: 'input-too-large', message: `the input is ${payload.length} bytes and this command accepts at most ${declaration.maxBytes} bytes: send less, or ask the owner of the machine to raise it (machine admin allow ... --stdin-max)` };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload);
  } catch {
    return { ok: false, reason: 'input-format', message: 'the input is not valid UTF-8: send text encoded as UTF-8' };
  }
  const union = new Set<InputCharName>(declaration.chars);
  let position = 0;
  for (const ch of text) {
    position += 1;
    const cp = ch.codePointAt(0) as number;
    if (alwaysRefused(ch)) {
      return { ok: false, reason: 'input-chars', message: `the input holds the character U+${hex4(cp)} at position ${position}, which is never accepted (NUL and other control characters except the line feed, and bidirectional controls): remove it` };
    }
    if (!allowedBy(ch, union)) {
      return {
        ok: false,
        reason: 'input-chars',
        message: `the input holds the character U+${hex4(cp)} at position ${position}, which this command does not accept: remove it, or ask the owner of the machine to allow the family "${familyFor(ch)}" (machine admin allow ... --stdin-chars; the families, and utf8-text for any text, are listed by \`machine admin allow --help\`)`,
      };
    }
  }
  if (declaration.format === 'json') {
    const problem = scanJson(text);
    if (problem !== undefined) {
      return { ok: false, reason: 'input-format', message: `the input is refused as JSON: ${problem}` };
    }
    try {
      JSON.parse(text);
    } catch (e) {
      return { ok: false, reason: 'input-format', message: `the input is not valid JSON: ${(e as Error).message.slice(0, 120)}` };
    }
  }
  return { ok: true };
}

export interface DisplayedInput {
  /** Escaped, at most `limit` bytes of the payload. */
  text: string;
  bytes: number;
  sha256: string;
  /** More bytes follow what is shown. */
  cut: boolean;
}

/**
 * A payload shown to a person (T-42): control characters and bidi marks become escapes, a backslash is doubled, bytes that are not UTF-8 are
 * `\xNN`. Never interpreted, never decoded lossily.
 */
export function displayInput(payload: Uint8Array, limit: number = INPUT_DISPLAY_BYTES): DisplayedInput {
  const digest = inputDigest(payload);
  let out = '';
  let used = 0;
  let cut = false;
  let text: string | undefined;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload);
  } catch {
    text = undefined;
  }
  const esc = (ch: string): string => {
    const cp = ch.codePointAt(0) as number;
    if (ch === '\\') return '\\\\';
    if (ch === '\n') return '\\n';
    if (CONTROL.test(ch) || isBidi(cp) || cp === 0xfeff) return `\\u${cp.toString(16).padStart(4, '0')}`;
    return ch;
  };
  if (text !== undefined) {
    for (const ch of text) {
      const size = Buffer.byteLength(ch, 'utf8');
      if (used + size > limit) {
        cut = true;
        break;
      }
      used += size;
      out += esc(ch);
    }
  } else {
    for (const byte of payload) {
      if (used + 1 > limit) {
        cut = true;
        break;
      }
      used += 1;
      out += byte >= 0x20 && byte < 0x7f ? esc(String.fromCharCode(byte)) : `\\x${byte.toString(16).padStart(2, '0')}`;
    }
  }
  return { text: out, ...digest, cut };
}

/**
 * The smallest declaration that covers an example payload (D1: the held payload is the example the owner builds the entry from): the format
 * (json when it passes the JSON checks, else text) and the families it uses, each character named. A character with no name needs
 * `utf8-text`. Undefined when the bytes are not text this feature would ever accept. A proposal for the owner to edit, never applied by itself.
 */
export function suggestInput(payload: Uint8Array): { format: 'text' | 'json'; chars: InputCharName[] } | undefined {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload);
  } catch {
    return undefined;
  }
  let isJson = false;
  if (text.length > 0 && scanJson(text) === undefined) {
    try {
      JSON.parse(text);
      isJson = true;
    } catch {
      isJson = false;
    }
  }
  const used = new Set<string>();
  for (const ch of text) {
    if (alwaysRefused(ch)) {
      return undefined;
    }
    used.add(isJson && JSON_STRUCTURE.has(ch) ? 'json' : familyFor(ch));
  }
  if (isJson) {
    used.add('json');
  }
  const wholeText = used.has('utf8-text');
  const chars = INPUT_CHAR_NAMES.filter((n) => (wholeText ? n === 'utf8-text' || n === 'json' : used.has(n)) && (n !== 'json' || isJson));
  return { format: isJson ? 'json' : 'text', chars: chars.length === 0 ? ['space'] : chars };
}
