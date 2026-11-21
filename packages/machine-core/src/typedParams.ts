// Typed parameters of an allow-list entry (typed-parameters.md, phase 1). Pure, no I/O, no import: this file is copied byte for byte into
// machine-webcrypto (the browser builds the next policy itself) and a test keeps the two identical.
//
// RULE (user decision 2026-11-21): every check below is a WHITELIST. A type states the exact characters it accepts and refuses anything
// else. This file holds no list of forbidden characters, and typedParams.hygiene.test.ts fails if one is added.

export type Platform = 'windows' | 'posix';

export type TypeSpec =
  | { kind: 'enum'; members: string[] }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'duration'; min: number; max: number }
  | { kind: 'name'; max: number; dot: boolean }
  | { kind: 'hexid'; n: number }
  | { kind: 'uuid' };

/** A template or type that cannot be signed or loaded; the message names the cause and the fix. */
export class TemplateError extends Error {
  /** The same text as `message`: callers that wrap a TemplateError read this field. */
  readonly detail: string;

  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
    this.detail = message;
  }
}

const DIGITS = '0123456789';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const HEX = '0123456789abcdef';
/** Whitelist of an enum member (V3: it never starts with the hyphen, checked apart). */
const ENUM_MEMBER_CHARS = `${LOWER}${UPPER}${DIGITS}._:@+-`;
const NAME_FIRST = `${LOWER}${UPPER}${DIGITS}_`;
const NAME_NEXT = `${NAME_FIRST}-`;
const DURATION_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
const RESERVED_DEVICES = new Set(['CON', 'PRN', 'AUX', 'NUL', ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)]);

export const INT_LIMIT = 2147483647;
export const INT_MAX_DIGITS = 10;
/** A name is 64 characters long unless `max=` raises it, to 128 at most. */
export const NAME_MAX = 64;
export const NAME_MAX_LIMIT = 128;
/** A typed duration is at most 365 days. */
export const DURATION_MAX_SECONDS = 365 * 86400;
export const ENUM_MAX_MEMBERS = 64;
export const ENUM_MEMBER_MAX_LENGTH = 64;
const HEXID_MAX = 64;
const PHASE_2 = ['path', 'host', 'ref'];

/** True when every character of `value` is in `allowed` and `value` is not empty. */
function only(value: string, allowed: string): boolean {
  if (value.length === 0) {
    return false;
  }
  for (const c of value) if (!allowed.includes(c)) return false;
  return true;
}

/** A canonical decimal number: `0` or digits without a leading zero. */
function isNumber(text: string): boolean {
  return only(text, DIGITS) && (text === '0' || text[0] !== '0');
}

function bound(text: string, what: string, type: string, limit: number, limitText: string): number {
  if (!isNumber(text)) {
    throw new TemplateError(`${type}: ${what} must be written with the digits 0-9 only, no sign and no leading zero`);
  }
  const n = Number(text);
  if (n > limit) {
    throw new TemplateError(`${type}: ${what} must be at most ${limitText}`);
  }
  return n;
}

function bounds(args: string | undefined, type: string, limit: number, limitText: string): [number, number] {
  const parts = args === undefined ? [] : args.split(',');
  if (parts.length !== 2) {
    throw new TemplateError(`${type} needs its two bounds: ${type}(min,max)`);
  }
  const min = bound(parts[0] as string, 'min', type, limit, limitText);
  const max = bound(parts[1] as string, 'max', type, limit, limitText);
  if (min > max) {
    throw new TemplateError(`${type}: min must not exceed max`);
  }
  return [min, max];
}

/** Parses the type text of a placeholder (`int(1,500)`, `name(dot)`, ...). Throws a TemplateError naming the fix. */
export function parseTypeSpec(text: string): TypeSpec {
  if (text.length === 0) {
    throw new TemplateError('empty type: write one of enum(...), int(min,max), duration(min,max), name, port, hexid(n), uuid');
  }
  const open = text.indexOf('(');
  const head = open < 0 ? text : text.slice(0, open);
  let args: string | undefined;
  if (open >= 0) {
    const close = text.indexOf(')');
    if (close < 0) {
      throw new TemplateError(`type "${text}" is missing the closing parenthesis`);
    }
    if (close !== text.length - 1) {
      throw new TemplateError(`unknown type "${text}": text after the closing parenthesis`);
    }
    args = text.slice(open + 1, close);
  }
  if (PHASE_2.includes(head)) {
    throw new TemplateError(`type "${head}" is planned for phase 2 and is not available in this build`);
  }
  switch (head) {
    case 'int': {
      const [min, max] = bounds(args, 'int', INT_LIMIT, String(INT_LIMIT));
      return { kind: 'int', min, max };
    }
    case 'duration': {
      const [min, max] = bounds(args, 'duration', DURATION_MAX_SECONDS, `${DURATION_MAX_SECONDS} seconds (365 days)`);
      if (min < 1) {
        throw new TemplateError('duration: min must be at least 1 second (0s can mean forever)');
      }
      return { kind: 'duration', min, max };
    }
    case 'port':
      if (args !== undefined) {
        throw new TemplateError('port takes no argument (it is int(1,65535))');
      }
      return { kind: 'int', min: 1, max: 65535 };
    case 'uuid':
      if (args !== undefined) {
        throw new TemplateError('uuid takes no argument');
      }
      return { kind: 'uuid' };
    case 'hexid': {
      if (args === undefined || !isNumber(args) || Number(args) < 1 || Number(args) > HEXID_MAX) {
        throw new TemplateError(`hexid needs its length, 1 to ${HEXID_MAX}: hexid(8)`);
      }
      return { kind: 'hexid', n: Number(args) };
    }
    case 'name': {
      let max = NAME_MAX;
      let dot = false;
      let maxSeen = false;
      if (args !== undefined) {
        for (const option of args.split(',')) {
          if (option === 'dot') {
            if (dot) {
              throw new TemplateError('name: option "dot" written twice');
            }
            dot = true;
          } else if (option.startsWith('max=')) {
            if (maxSeen) {
              throw new TemplateError('name: option "max" written twice');
            }
            maxSeen = true;
            const n = option.slice(4);
            if (!isNumber(n) || Number(n) < 1 || Number(n) > NAME_MAX_LIMIT) {
              throw new TemplateError(`name: max must be a number from 1 to ${NAME_MAX_LIMIT}`);
            }
            max = Number(n);
          } else {
            throw new TemplateError('name: unknown option, use name, name(max=N), name(dot) or name(max=N,dot)');
          }
        }
      }
      return { kind: 'name', max, dot };
    }
    case 'enum': {
      if (args === undefined) {
        throw new TemplateError('enum needs its members: enum(a|b|c)');
      }
      const members = args.split('|');
      if (members.length > ENUM_MAX_MEMBERS) {
        throw new TemplateError(`enum: at most ${ENUM_MAX_MEMBERS} members`);
      }
      for (const member of members) {
        if (member.length === 0) {
          throw new TemplateError('enum: empty member (check for a leading, trailing or double "|")');
        }
        if (member.length > ENUM_MEMBER_MAX_LENGTH) {
          throw new TemplateError(`enum: a member is longer than ${ENUM_MEMBER_MAX_LENGTH} characters`);
        }
        if (!only(member, ENUM_MEMBER_CHARS)) {
          throw new TemplateError(`enum: member "${member}" must use only letters, digits and . _ : @ + -`);
        }
        if (member.startsWith('-')) {
          throw new TemplateError(`enum: member "${member}" must not start with a hyphen (it would be read as an option)`);
        }
      }
      if (new Set(members).size !== members.length) {
        throw new TemplateError('enum: a member is written twice');
      }
      return { kind: 'enum', members };
    }
    default:
      throw new TemplateError(`unknown type "${head}": use enum(...), int(min,max), duration(min,max), name, port, hexid(n) or uuid`);
  }
}

/** The text that identifies a type regardless of how it was written (port is int(1,65535), enum members are sorted). */
export function canonicalType(spec: TypeSpec): string {
  switch (spec.kind) {
    case 'int':
      return `int(${spec.min},${spec.max})`;
    case 'duration':
      return `duration(${spec.min},${spec.max})`;
    case 'name':
      return `name(max=${spec.max}${spec.dot ? ',dot' : ''})`;
    case 'hexid':
      return `hexid(${spec.n})`;
    case 'uuid':
      return 'uuid';
    case 'enum':
      return `enum(${[...spec.members].sort().join('|')})`;
  }
}

/** What a type accepts, in words (shown to the admin before signing and in `machine allowed`). */
export function describeType(spec: TypeSpec): string {
  switch (spec.kind) {
    case 'int':
      return `a whole number from ${spec.min} to ${spec.max}, digits 0-9 only`;
    case 'duration':
      return `a duration from ${spec.min} to ${spec.max} seconds written as digits then s, m, h or d`;
    case 'name':
      return `a name of at most ${spec.max} characters: letters, digits, _ and inner -${spec.dot ? ', inner single dots' : ''}`;
    case 'hexid':
      return `${spec.n} lower-case hexadecimal digits`;
    case 'uuid':
      return 'a lower-case canonical UUID';
    case 'enum':
      return `one of: ${spec.members.join(', ')}`;
  }
}

export type ValueCheck = { ok: true } | { ok: false; rule: string };

const refuse = (rule: string): ValueCheck => ({ ok: false, rule });

function checkName(spec: Extract<TypeSpec, { kind: 'name' }>, value: string, platform: Platform): ValueCheck {
  if (value.length > spec.max) {
    return refuse(`name: longer than ${spec.max} characters`);
  }
  const parts = spec.dot ? value.split('.') : [value];
  for (const part of parts) {
    if (part.length === 0) {
      return refuse('name: empty part (a leading, trailing or double dot)');
    }
    if (!NAME_FIRST.includes(part[0] as string)) {
      return refuse('name: each part starts with a letter, digit or _');
    }
    if (!only(part, NAME_NEXT)) {
      return refuse(`name: letters, digits, _ and -${spec.dot ? ' and inner single dots' : ''} only`);
    }
  }
  if (platform === 'windows' && RESERVED_DEVICES.has((parts[0] as string).toUpperCase())) {
    return refuse('name: reserved device name on a Windows target');
  }
  return { ok: true };
}

/**
 * The seconds of a duration written as digits then one of s m h d (`90s`, `2h`), or a reason. At most 10 digits, no leading zero.
 * The range is the caller's business (a type bound, or the lifetime limit of a signing).
 */
export function durationSeconds(text: string): { ok: true; seconds: number } | { ok: false; rule: string } {
  const unit = text.slice(-1);
  const number = text.slice(0, -1);
  if (!(unit in DURATION_UNITS) || !only(number, DIGITS) || number[0] === '0') {
    return { ok: false, rule: 'digits without a leading zero then one of s m h d' };
  }
  if (number.length > INT_MAX_DIGITS) {
    return { ok: false, rule: `more than ${INT_MAX_DIGITS} digits` };
  }
  return { ok: true, seconds: Number(number) * (DURATION_UNITS[unit] as number) };
}

function checkDuration(spec: Extract<TypeSpec, { kind: 'duration' }>, value: string): ValueCheck {
  const parsed = durationSeconds(value);
  if (!parsed.ok) {
    return refuse(`duration: ${parsed.rule}`);
  }
  if (parsed.seconds < spec.min || parsed.seconds > spec.max) {
    return refuse('duration: outside the allowed range');
  }
  return { ok: true };
}

/**
 * Checks a value against a type, on the exact string that would be handed to the shell. The refusal names the rule, never the value.
 * `platform` is the platform of the machine that runs the command (reserved device names).
 */
export function checkValue(spec: TypeSpec, value: string, platform: Platform): ValueCheck {
  if (typeof value !== 'string') {
    return refuse('the value is not text');
  }
  if (value.length === 0) {
    return refuse(`${spec.kind}: empty value`);
  }
  switch (spec.kind) {
    case 'int': {
      if (only(value, DIGITS) && value.length > INT_MAX_DIGITS) {
        return refuse(`int: more than ${INT_MAX_DIGITS} digits`);
      }
      if (!isNumber(value)) {
        return refuse('int: digits 0-9 only, no sign, no leading zero');
      }
      const n = Number(value);
      return n >= spec.min && n <= spec.max ? { ok: true } : refuse('int: outside the allowed range');
    }
    case 'duration':
      return checkDuration(spec, value);
    case 'name':
      return checkName(spec, value, platform);
    case 'hexid':
      return value.length === spec.n && only(value, HEX) ? { ok: true } : refuse(`hexid: exactly ${spec.n} characters of 0-9 a-f`);
    case 'uuid': {
      const groups = value.split('-');
      const sizes = [8, 4, 4, 4, 12];
      return groups.length === 5 && groups.every((g, i) => g.length === sizes[i] && only(g, HEX)) ? { ok: true } : refuse('uuid: exactly 36 characters, canonical lower-case form (0-9 a-f and hyphens)');
    }
    case 'enum':
      return spec.members.includes(value) ? { ok: true } : refuse('enum: not one of the listed members');
  }
}

/** Values shown as examples before signing: built from the type, then confirmed by `checkValue` (same validator as at run time). */
export function sampleValues(spec: TypeSpec, platform: Platform): { accepted: string[]; refused: string[] } {
  let accepted: string[];
  let refused: string[];
  switch (spec.kind) {
    case 'int':
      accepted = [String(spec.min), String(spec.max), String(Math.floor((spec.min + spec.max) / 2))];
      refused = [String(spec.max + 1), `${spec.min}x`, spec.min === 0 ? '00' : `0${spec.min}`];
      break;
    case 'duration':
      accepted = [`${spec.min}s`, `${spec.max}s`, '1m', '1h'];
      refused = [String(spec.min), `${spec.max + 1}s`, '0s', `${spec.min}x`];
      break;
    case 'name':
      accepted = ['job1', 'my-job', 'a', 'b', ...(spec.dot ? ['v1.2'] : [])];
      refused = ['x'.repeat(spec.max + 1), '-a', spec.dot ? 'a..b' : 'a.b', 'con'];
      break;
    case 'hexid':
      accepted = ['0'.repeat(spec.n), 'a'.repeat(spec.n), '1'.repeat(spec.n)];
      refused = ['g'.repeat(spec.n), '0'.repeat(spec.n + 1), 'A'.repeat(spec.n)];
      break;
    case 'uuid':
      accepted = ['00000000-0000-0000-0000-000000000000', '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f'];
      refused = ['6F1C2D3E-4A5B-4C6D-8E7F-0A1B2C3D4E5F', '6f1c2d3e4a5b4c6d8e7f0a1b2c3d4e5f'];
      break;
    case 'enum':
      accepted = spec.members.slice(0, 2);
      refused = [`${spec.members[0] as string}x`, `x${spec.members[0] as string}`];
      break;
  }
  return {
    accepted: [...new Set(accepted)].filter((v) => checkValue(spec, v, platform).ok).slice(0, 2),
    refused: [...new Set(refused)].filter((v) => !checkValue(spec, v, platform).ok).slice(0, 2),
  };
}
